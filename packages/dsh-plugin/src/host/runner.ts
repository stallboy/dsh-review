/**
 * Agent 执行通道与三模式提示词构建器（SPEC §5.4 / §7.3）：
 * 严格隔离 Mode A/B（提案修订，软引导 + Host 强还原）与 Mode C（人审后获批辅助应用，完整权限但禁改 .ai-review）。
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { killProcessTree, runProcess, tailLines } from './shell.js';
import { formatPatchFilename } from './issue-review.js';
import type { AppSettings, PatchEntry, RepairOption, ReviewCandidate, ReviewComment, VcsType } from './types.js';

export interface RunAgentInput {
  kind: 'dsh' | 'external';
  settings: AppSettings;
  cwd: string;
  prompt: string;
  log: (line: string) => void;
  timeoutMs?: number;
  label?: string;
  signal?: AbortSignal;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
}

export interface RunAgentResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  outputTail: string;
  /** 从 DSH headless JSON 事件流或 stdout 中提取的最终助手文本，不受事件流大小截断。 */
  assistantText: string;
  errorMessage?: string;
}

export interface ModeCVerdict {
  verdict: 'equivalent' | 'material_change';
  summary: string;
  gitActions?: Array<'working_tree' | 'commit' | 'merge' | 'push'>;
}

const VALID_GIT_ACTIONS = new Set(['working_tree', 'commit', 'merge', 'push']);

function packageRoot(): string {
  return path.resolve(import.meta.dirname, '../..');
}

export function wrapAgentPrompt(systemPrompt: string, userPrompt: string): string {
  return [
    systemPrompt.trim(),
    '',
    '---',
    '',
    userPrompt.trim(),
    '',
  ].join('\n');
}

export async function loadProposalSystemPrompt(): Promise<string> {
  const fallback = [
    '你是问题修复提案 Agent（Mode A/B），运行于项目真实工作目录的完整 Harness Loop。',
    '遵循「软引导 + Host 强还原」策略：优先在 .ai-review/ 与 .tmp/ 工作，结束前归档取证到 evidence/ 并还原所有非 .ai-review/ 改动、清空 .tmp/。',
    '严禁应用待审补丁验证修复效果，严禁执行 git/svn commit、push 或切换分支。',
    '所有问题均采用 schema_version: 1，record_revision 与不可变 patches[] 账本严格独立，严禁覆盖或删除历史补丁。',
  ].join('\n');
  try {
    return (await readFile(path.join(packageRoot(), 'assets', 'ai-proposal-system.md'), 'utf8')).trim();
  } catch {
    return fallback;
  }
}

export async function loadModeCSystemPrompt(): Promise<string> {
  const fallback = [
    '你是人审后获批辅助应用与分支合并 Agent（Mode C）。',
    '你拥有完整 Harness 业务权限（可编辑业务源码、分支合并及必要 push），但严禁修改 .ai-review/ 下任何文件，严禁改写历史或强推。',
    '完成后保留已适配业务改动，并输出结构化 JSON：{ "verdict": "equivalent" | "material_change", "summary": "...", "gitActions": [...] }。',
  ].join('\n');
  try {
    return (await readFile(path.join(packageRoot(), 'assets', 'ai-mode-c-system.md'), 'utf8')).trim();
  } catch {
    return fallback;
  }
}

/** 过滤出适用于指定方案的未解决评论：所有总体评论 + 归属该方案的行内评论。 */
export function unresolvedCommentsForOption(comments: readonly ReviewComment[], optionId?: string): ReviewComment[] {
  return comments.filter((comment) => {
    if (comment.status === 'resolved') return false;
    const isGeneral = comment.file === '' && comment.line === 0;
    if (isGeneral) return true;
    return optionId !== undefined && comment.optionId === optionId;
  });
}

export interface BuildModeBPromptInput {
  candidate: ReviewCandidate;
  option: RepairOption;
  patchEntry: PatchEntry;
  patchText: string;
  targetBase: string;
  vcsType: VcsType;
  intent: 'revise' | 'rebase';
  mode: 'headless' | 'session';
}

export function buildModeBPrompt(input: BuildModeBPromptInput): string {
  const { candidate, option, patchEntry, patchText, targetBase, vcsType, intent, mode } = input;
  const meta = candidate.meta;
  const nextPatchId = meta.patches.length + 1;
  const nextPatchFile = formatPatchFilename(nextPatchId);
  const unresolved = unresolvedCommentsForOption(meta.comments, option.id);

  const commentLines = unresolved.length === 0
    ? ['- （无未解决评论）']
    : unresolved.map((c) => {
      const loc = c.file ? `${c.file}:${String(c.line)} (${c.side ?? 'RIGHT'}, patch #${String(c.patchId ?? '')})` : '总体意见';
      const anchorNote = c.anchor?.snippet ? `\n  原锚点行：\`${c.anchor.snippet}\`` : '';
      return `- [${c.id}]（${c.author}，记录版本 ${String(c.revision)}，${loc}，当前状态 ${c.status}）：${c.content}${anchorNote}`;
    });

  const taskGoal = intent === 'rebase'
    ? `当前任务为 **Mode B · 基于最新业务基线 Rebase 提案**。请在目标基线 \`${targetBase}\` 上重新生成方案 \`${option.id}\` 的完整补丁 \`${nextPatchFile}\`，保留原有方案目标并保持另一方案与所有历史补丁完整不动。`
    : `当前任务为 **Mode B · 审核意见提案修订**。请逐条回应下列未解决评论，在目标基线 \`${targetBase}\` 上为方案 \`${option.id}\` 生成新的完整补丁 \`${nextPatchFile}\`，保持另一方案与所有历史补丁完整不动。`;

  return [
    `# 任务模式：Mode B（人审前提案${intent === 'rebase' ? '基线更新' : '修订'}，${mode === 'session' ? '交互式 DSH 会话' : 'Headless'}）`,
    '',
    taskGoal,
    '',
    '## 绑定上下文（不得更改）',
    `- 问题目录 ID：\`${candidate.id}\`（绝对目录：\`${candidate.dirPath}\`）`,
    `- 稳定 finding_id：\`${meta.findingId}\``,
    `- 当前共享 record_revision：\`${String(meta.recordRevision)}\`（本次更新后推进为 \`${String(meta.recordRevision + 1)}\`）`,
    `- 目标方案 option_id：\`${option.id}\`（当前补丁 #${String(patchEntry.id)} \`${patchEntry.patch}\`，基线 \`${patchEntry.baseRevision}\`）`,
    `- 新补丁编号与文件名：\`#${String(nextPatchId)}\` → \`${nextPatchFile}\`（追加到 \`patches[]\`，绝不覆盖或删除旧补丁）`,
    `- 目标业务基线 base_revision：\`${targetBase}\`（VCS：\`${vcsType}\`）`,
    '',
    '## 必须处理的未解决评论（仅总体评论与本方案行内评论）',
    ...commentLines,
    '',
    '## 软引导与硬约束',
    '- 优先在 `.ai-review/` 与 `.tmp/` 目录工作；如需临时取证可读取或短时修改项目文件，但退出前必须将有效证据归档至 `.ai-review/.../evidence/` 并彻底还原所有非 `.ai-review/` 改动、清空 `.tmp/`。',
    '- **严禁**应用待审补丁验证修复效果或宣称门禁已通过（修复门禁留待人工批准后由 Host 在仓库根目录实际执行）。',
    '- **严禁**执行 `git commit / svn commit / git push / 切换分支`。',
    '- 更新 `review.md`（`schema_version: 1`）时：保持固定顶层键序，计算并写入新补丁原字节 64 位小写 `sha256`，更新所选方案 `current_patch` 为新补丁编号，合并新补丁触及路径至 `target_files`，将 `status` 设为 `pending`，严格递增 `record_revision` 与 `updated_at`，保留原人类评论原文并更新处理后的评论状态，在 `# 审核记录` 末尾追加新版本说明。',
    '',
    `## 当前方案既有补丁（${patchEntry.patch}，仅供参考）`,
    '```diff',
    patchText.slice(0, 60_000),
    '```',
  ].join('\n');
}

export interface BuildModeCPromptInput {
  candidate: ReviewCandidate;
  option: RepairOption;
  patchEntry: PatchEntry;
  patchText: string;
  approvedPatchPaths: readonly string[];
  targetBase: string;
  conflictMessage: string;
  vcsType: VcsType;
  repoRoot: string;
}

export function buildModeCPrompt(input: BuildModeCPromptInput): string {
  const { candidate, option, patchEntry, patchText, approvedPatchPaths, targetBase, conflictMessage, vcsType, repoRoot } = input;
  return [
    '# 任务模式：Mode C（人审后获批辅助应用与分支合并）',
    '',
    '人类已正式批准下列问题与方案，但程序自动应用补丁遇到冲突。请你在当前仓库工作目录中完成冲突适配。',
    '',
    '## 已批准上下文',
    `- 仓库根目录：\`${repoRoot}\`（VCS：\`${vcsType}\`）`,
    `- 问题目录 ID：\`${candidate.id}\`（finding_id：\`${candidate.meta.findingId}\`）`,
    `- 获批方案：\`${option.id}\` — ${option.title}`,
    `- 获批源补丁：\`#${String(patchEntry.id)} ${patchEntry.patch}\`（sha256: \`${patchEntry.sha256}\`，原基线 \`${patchEntry.baseRevision}\`）`,
    `- 当前目标基线：\`${targetBase}\``,
    `- 获批源补丁允许触及的业务文件集合：${approvedPatchPaths.map((p) => `\`${p}\``).join('、')}`,
    `- 稍后由 Host 执行的门禁命令：${option.gateChecks.map((c) => `\`${c}\``).join('；')}`,
    '',
    '## 程序应用冲突诊断',
    '```text',
    conflictMessage.slice(0, 8000),
    '```',
    '',
    '## 获批源补丁全文',
    '```diff',
    patchText.slice(0, 80_000),
    '```',
    '',
    '## 要求与输出格式',
    '1. 严禁修改 `.ai-review/` 目录下的任何文件。',
    '2. 若仅解决上下文/冲突或分支合并适配、且未改变获批语义与范围，保留业务改动并输出 `verdict: "equivalent"`。',
    '3. 若发现必须改变业务逻辑、影响范围或验收条件，输出 `verdict: "material_change"`（保持当前适配后的业务改动以便 Host 导出新补丁并还原）。',
    '4. 最终回复末尾必须输出且仅输出一个合法 JSON 对象：`{"verdict": "equivalent" | "material_change", "summary": "...", "gitActions": ["working_tree" | "commit" | "merge" | "push"]}`。',
  ].join('\n');
}

/** 解析 Mode C Agent 输出的结构化 JSON 裁决。 */
export function parseModeCOutput(text: string): ModeCVerdict | null {
  const tryParse = (candidate: string): ModeCVerdict | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const obj = parsed as Record<string, unknown>;
      if (obj['verdict'] !== 'equivalent' && obj['verdict'] !== 'material_change') return null;
      if (typeof obj['summary'] !== 'string' || !obj['summary'].trim()) return null;
      let gitActions: ModeCVerdict['gitActions'];
      if (obj['gitActions'] !== undefined) {
        if (!Array.isArray(obj['gitActions'])) return null;
        if (obj['gitActions'].some((a) => typeof a !== 'string' || !VALID_GIT_ACTIONS.has(a))) return null;
        gitActions = [...new Set(obj['gitActions'] as Array<'working_tree' | 'commit' | 'merge' | 'push'>)];
      }
      return {
        verdict: obj['verdict'],
        summary: obj['summary'].trim(),
        ...(gitActions ? { gitActions } : {}),
      };
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. 优先解析最后一个 ```json ... ``` 或 ``` ... ``` 代码块
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/gi)];
  for (let i = fencedMatches.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse((fencedMatches[i]?.[1] ?? '').trim());
    if (parsed) return parsed;
  }

  // 2. 尝试整体解析
  const direct = tryParse(trimmed);
  if (direct) return direct;

  // 3. 从末尾提取最后一个顶层 JSON 对象
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace >= 0) {
    for (let pos = trimmed.lastIndexOf('{', lastBrace); pos >= 0; pos = trimmed.lastIndexOf('{', pos - 1)) {
      const parsed = tryParse(trimmed.slice(pos, lastBrace + 1));
      if (parsed) return parsed;
    }
  }
  return null;
}

function splitCommandLine(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);
  return args;
}

/** 从 DSH headless --json 事件流中抽取助手文本，避免大工具事件流撑爆或截断最终结果。 */
function extractDshJsonEventText(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed['text'] === 'string') return parsed['text'];
    if (typeof parsed['delta'] === 'string') return parsed['delta'];
    if (typeof parsed['content'] === 'string') return parsed['content'];
    if (typeof parsed['message'] === 'string') return parsed['message'];
    const msg = parsed['message'];
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      const content = (msg as Record<string, unknown>)['content'];
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((item): item is { type?: string; text?: string } => typeof item === 'object' && item !== null)
          .map((item) => item.text ?? '')
          .filter(Boolean);
        if (texts.length > 0) return texts.join('\n');
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const label = input.label ?? 'AI Runner';

  let executable: string;
  let args: string[];
  let isDshJson = false;

  if (input.kind === 'dsh') {
    const tokens = input.settings.dshCommand.trim() ? splitCommandLine(input.settings.dshCommand.trim()) : ['dsh'];
    executable = tokens[0] ?? 'dsh';
    args = [...tokens.slice(1), '--profile', 'headless', '--json', '-'];
    isDshJson = true;
  } else {
    const raw = input.settings.externalCommand.trim();
    if (!raw) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        aborted: false,
        outputTail: '',
        assistantText: '',
        errorMessage: '未配置外部执行器命令（externalCommand）',
      };
    }
    const tokens = splitCommandLine(raw);
    executable = tokens[0] ?? '';
    args = tokens.slice(1);
  }

  // 解析外部命令中的凭据引用（如有需要仅经 Host credentials 服务）
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (input.resolveCredential) {
    const token = await input.resolveCredential('dsh-code-review-runner').catch(() => undefined);
    if (token) env['DSH_REVIEW_RUNNER_TOKEN'] = token;
  }

  input.log(`[${label}] 启动执行器：${executable} ${args.join(' ')}`);

  return new Promise<RunAgentResult>((resolve) => {
    let stdoutTail = '';
    let stderrTail = '';
    let lineBuffer = '';
    const assistantParts: string[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    // Node.js 24+ 在 Windows 上直接 spawn .cmd/.bat 会抛出 EINVAL，需经 cmd.exe /d /s /c 执行。
    const isWindowsBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    const quoteCmd = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const spawnCommand = isWindowsBatch ? (process.env['ComSpec'] || 'cmd.exe') : executable;
    const spawnArgs = isWindowsBatch
      ? ['/d', '/s', '/c', `"${[executable, ...args].map(quoteCmd).join(' ')}"`]
      : args;

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: input.cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(isWindowsBatch ? { windowsVerbatimArguments: true } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const appendTail = (current: string, chunk: string, limit = 128 * 1024): string => {
      const next = current + chunk;
      return next.length > limit ? next.slice(next.length - limit) : next;
    };

    const stopTree = async (): Promise<void> => {
      if (child.pid) await killProcessTree(child.pid, input.cwd).catch(() => undefined);
    };

    const onAbort = (): void => {
      aborted = true;
      void stopTree();
    };
    if (input.signal?.aborted) {
      aborted = true;
      void stopTree();
    } else {
      input.signal?.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree();
    }, timeoutMs);

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (isDshJson) {
        const extracted = extractDshJsonEventText(trimmed);
        if (extracted !== null) {
          assistantParts.push(extracted);
          return;
        }
      }
      input.log(`[${label}] ${trimmed.slice(0, 500)}`);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutTail = appendTail(stdoutTail, text);
      lineBuffer += text;
      let newlineIndex = lineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        processLine(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = appendTail(stderrTail, text);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) input.log(`[${label}:stderr] ${trimmed.slice(0, 500)}`);
      }
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(input.prompt, 'utf8');

    const finish = async (code: number | null, errorMessage?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (lineBuffer.trim()) processLine(lineBuffer);
      // I18 / §5.3：确认进程及全部后代进程树已完全退出后再交还控制权。
      await stopTree();
      const combinedTail = tailLines([stdoutTail, stderrTail].filter(Boolean).join('\n'), 120);
      const assistantText = assistantParts.length > 0 ? assistantParts.join('\n') : stdoutTail;
      const ok = !timedOut && !aborted && !errorMessage && code === 0;
      resolve({
        ok,
        exitCode: code,
        timedOut,
        aborted,
        outputTail: combinedTail,
        assistantText,
        ...(!ok
          ? {
            errorMessage: errorMessage
              ?? (aborted ? '执行已取消' : timedOut ? `执行超时（${String(timeoutMs)}ms）` : `执行器退出码 ${String(code ?? 'null')}`),
          }
          : {}),
      });
    };

    child.once('error', (error) => {
      void finish(null, error.message);
    });
    child.once('close', (code) => {
      void finish(code);
    });
  });
}

export async function probeCommandAvailable(command: string, cwd: string): Promise<boolean> {
  const probeArgs = ['--version'];
  const result = await runProcess(command, probeArgs, { cwd, timeoutMs: 8000, maxBytes: 16 * 1024 }).catch(() => null);
  return Boolean(result && !result.error && result.code === 0);
}
