import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { commandExists, runShell, tailLines } from './shell.js';
import type { ReviewStore } from './store.js';
import type {
  AppSettings,
  ReviewCandidate,
  ReviewComment,
  RunnerExecutionResult,
  RunnerKind,
  RunnerMode,
} from './types.js';
import { patchTouchesReviewData } from './vcs.js';

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunnerRequest {
  kind: RunnerKind;
  settings: AppSettings;
  store: ReviewStore;
  candidate: ReviewCandidate;
  mode: RunnerMode;
  comments: ReviewComment[];
  failureDetail?: string;
  /** What the caller left in the business working tree before invoking the fixer. */
  workingTree?: 'current_patch_applied' | 'clean_base';
  log: (line: string) => void;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
}

export interface AgentRunOptions {
  kind: 'dsh' | 'external';
  settings: AppSettings;
  cwd: string;
  /** Already wrapped by `wrapAgentPrompt` (system + user). */
  prompt: string;
  log: (line: string) => void;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  timeoutMs?: number;
  /** Human-readable task name used in timeout/exit messages. */
  label?: string;
}

export interface AgentRunOutcome {
  ok: boolean;
  errorMessage?: string;
  outputTail: string;
  code: number | null;
  timedOut: boolean;
}

/** Compose the system/user prompt envelope shared by every headless executor. */
export function wrapAgentPrompt(system: string, user: string): string {
  return [
    '<system>',
    system,
    '</system>',
    '',
    '<user>',
    user,
    '</user>',
    '',
    '请直接开始执行任务，不要复述指令。',
  ].join('\n');
}

function packageRoot(): string {
  return path.resolve(import.meta.dirname, '..');
}

async function loadSystemPrompt(): Promise<string> {
  const fallback = [
    '你是 AI Fixer。你在一个产品仓库中修复代码，并更新 .ai-review 候选目录中的 review.md 与 NNN.patch。',
    '不要提交代码；完成后把业务代码工作区还原干净，仅保留 .ai-review 下的文件。',
  ].join('\n');
  try {
    return (await readFile(path.join(packageRoot(), 'assets', 'ai-fixer-system.md'), 'utf8')).trim();
  } catch {
    return fallback;
  }
}

function commentLines(comments: ReviewComment[]): string {
  if (comments.length === 0) return '- 无结构化意见，请阅读 review.md 中的历史反馈。';
  return comments
    .map((comment) => {
      const location = comment.file ? `${comment.file}${comment.line > 0 ? `:${String(comment.line)}` : ''}` : '总体';
      return `- [rev ${String(comment.revision)}] ${location} · ${comment.author} · (${comment.status})\n  ${comment.content.replaceAll('\n', '\n  ')}`;
    })
    .join('\n');
}

export async function buildFixPrompt(request: RunnerRequest): Promise<string> {
  const { candidate } = request;
  const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
  const nextRevision = candidate.meta.currentRevision + 1;
  const month = candidate.month;
  const slug = candidate.slug;
  const lines = [
    '# 任务',
    `请以 ${request.mode} 模式执行修复，并把候选目录更新到版本 ${String(nextRevision)}。`,
    '',
    '## 环境与仓库',
    `- VCS 类型: ${request.settings.vcsType === 'auto' ? 'auto（读取仓库）' : request.settings.vcsType}`,
    `- 仓库根目录: ${request.store.repoRoot}`,
    `- 当前最新基线 base_revision: ${current?.baseRevision ?? '未知'}`,
    `- 目标候选目录: .ai-review/${month}/${slug}/ （绝对路径: ${candidate.dirPath}）`,
    `- review.md: ${candidate.reviewPath}`,
    `- 当前版本: ${String(candidate.meta.currentRevision)}，当前补丁: ${current?.patch ?? '无'}`,
    `- reviewers.yml: .ai-review/reviewers.yml`,
    `- 工单: ${candidate.meta.ticket ?? '（无）'}`,
    '',
    '## 审核意见（需要逐条处理）',
    commentLines(request.comments),
  ];
  if (request.failureDetail) {
    lines.push('', '## 批准前失败详情（冲突 / 门禁 / 环境）', '```text', request.failureDetail.trim(), '```');
  }
  lines.push(
    '',
    '## 工作区状态',
    request.workingTree === 'current_patch_applied'
      ? `当前版本补丁 ${current?.patch ?? ''} 已经应用到业务工作区。请在这个已有改动的基础上继续修改，最终生成的补丁必须相对基线 ${current?.baseRevision ?? '<base>'} 包含已有改动和本次新增改动。`
      : '业务工作区是干净的基线状态，当前版本补丁尚未应用。请阅读现有补丁并在基线之上重建/修复，最终生成相对基线的全量补丁。',
    '',
    '## 硬性要求',
    `1. 生成 ${String(nextRevision).padStart(3, '0')}.patch，内容必须是相对当前基线 ${current?.baseRevision ?? '<base>'} 的全量 diff，不得包含 .ai-review/ 自身。若新增了未跟踪文件，先执行 \`git add -N <新文件>\` 再生成 \`git diff <base_revision> --binary\`，否则新文件不会进入补丁。`,
    `2. 更新 review.md：current_revision 改为 ${String(nextRevision)}，revisions 追加对应条目，status 改为 pending，approval 置空；补充审核记录、验证证据、需人工判断项。`,
    '3. gate_checks 里的每条命令必须实际运行并在验证证据中如实记录结果；不要把失败写成通过。',
    '4. 不得执行 git commit / svn commit；完成后业务代码工作区必须还原干净，只允许 .ai-review/ 下有改动。',
    '5. 完成时输出一行 DONE 和本次修改的简短摘要。',
  );
  return lines.join('\n');
}

function resolveDshCommand(settings: AppSettings): string | null {
  const explicit = settings.dshCommand.trim();
  if (explicit) return explicit;
  const exeName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(path.join(resources, 'runtime', 'cli', 'bin', exeName));
  candidates.push(path.join(path.dirname(process.execPath), 'resources', 'runtime', 'cli', 'bin', exeName));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  if (commandExists('dsh')) return 'dsh';
  return null;
}

async function resolveApiKey(options: AgentRunOptions): Promise<string | undefined> {
  if (process.env['DEEPSEEK_API_KEY']) return process.env['DEEPSEEK_API_KEY'];
  try {
    return await options.resolveCredential?.('DEEPSEEK_API_KEY');
  } catch {
    return undefined;
  }
}

function logDshEvent(line: string, log: (line: string) => void): void {
  if (!line.startsWith('{')) return;
  try {
    const event = JSON.parse(line) as { type?: string; text?: string; phase?: string };
    if (event.type === 'text' && event.text) log(`AI: ${event.text.slice(0, 500)}`);
    else if (event.type === 'thinking') log('AI 思考中…');
    else if (event.type === 'status' && event.phase) log(`状态: ${event.phase}`);
    else if (event.type === 'final' && event.text) log(`最终结果: ${event.text.slice(0, 500)}`);
  } catch {
    // Non-JSON progress line is kept in the tail, not parsed.
  }
}

async function runDshAgent(options: AgentRunOptions, timeoutMs: number): Promise<AgentRunOutcome> {
  const command = resolveDshCommand(options.settings);
  if (!command) {
    return {
      ok: false,
      errorMessage: '未找到 DSH CLI。请在设置中填写 dsh 可执行文件路径（例如 <DSH 安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd）。',
      outputTail: '',
      code: null,
      timedOut: false,
    };
  }
  const key = await resolveApiKey(options);
  const env: Record<string, string> = {};
  if (key) env['DEEPSEEK_API_KEY'] = key;
  options.log(`调用 ${command} --profile headless --json -（cwd=${options.cwd}）`);
  const commandLine = process.platform === 'win32'
    ? `"${command}" --profile headless --json -`
    : `'${command.replaceAll("'", "'\\''")}' --profile headless --json -`;
  const result = await runShell(commandLine, {
    cwd: options.cwd,
    timeoutMs,
    env,
    input: options.prompt,
    maxBytes: 8 * 1024 * 1024,
    onLine: (line, stream) => {
      if (stream === 'stderr' && line.trim().length > 0) options.log(`stderr: ${line.slice(0, 500)}`);
      logDshEvent(line, options.log);
    },
  });
  const tail = tailLines([result.stdout, result.stderr].filter(Boolean).join('\n'), 200);
  const label = options.label ?? 'AI 修复';
  if (result.error) {
    return { ok: false, errorMessage: `启动 DSH 失败：${result.error}`, outputTail: tail, code: result.code, timedOut: false };
  }
  if (result.timedOut) {
    return {
      ok: false,
      errorMessage: `${label}超时（${String(Math.round(timeoutMs / 60_000))} 分钟）`,
      outputTail: tail,
      code: result.code,
      timedOut: true,
    };
  }
  if (result.code !== 0) {
    return { ok: false, errorMessage: `DSH 退出码 ${String(result.code ?? 'null')}`, outputTail: tail, code: result.code, timedOut: false };
  }
  return { ok: true, outputTail: tail, code: 0, timedOut: false };
}

async function runExternalAgent(options: AgentRunOptions, timeoutMs: number): Promise<AgentRunOutcome> {
  const command = options.settings.externalCommand.trim();
  if (!command) {
    return { ok: false, errorMessage: '未配置外部执行命令', outputTail: '', code: null, timedOut: false };
  }
  options.log(`调用外部命令：${command}`);
  const result = await runShell(command, {
    cwd: options.cwd,
    timeoutMs,
    input: options.prompt,
    maxBytes: 8 * 1024 * 1024,
    onLine: (line) => options.log(line.slice(0, 500)),
  });
  const tail = tailLines([result.stdout, result.stderr].filter(Boolean).join('\n'), 200);
  const label = options.label ?? '外部修复命令';
  if (result.error) {
    return { ok: false, errorMessage: `外部命令启动失败：${result.error}`, outputTail: tail, code: result.code, timedOut: false };
  }
  if (result.timedOut) {
    return {
      ok: false,
      errorMessage: `${label}超时（${String(Math.round(timeoutMs / 60_000))} 分钟）`,
      outputTail: tail,
      code: result.code,
      timedOut: true,
    };
  }
  if (result.code !== 0) {
    return { ok: false, errorMessage: `外部命令退出码 ${String(result.code ?? 'null')}`, outputTail: tail, code: result.code, timedOut: false };
  }
  return { ok: true, outputTail: tail, code: 0, timedOut: false };
}

/** Shared headless executor used by the fixer and the repository auditor. */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunOutcome> {
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  return options.kind === 'dsh' ? runDshAgent(options, timeoutMs) : runExternalAgent(options, timeoutMs);
}

export class Runner {
  constructor(private readonly request: RunnerRequest) {}

  private log(line: string): void {
    this.request.log(line);
  }

  async run(): Promise<RunnerExecutionResult> {
    const { kind } = this.request;
    if (kind === 'manual') {
      const prompt = await buildFixPrompt(this.request);
      this.log('Manual runner: 已生成修复提示，未调用任何 AI。');
      return { success: false, manual: true, prompt, errorMessage: '已生成修复提示，请手动执行后重新提交' };
    }
    const user = await buildFixPrompt(this.request);
    const system = await loadSystemPrompt();
    const outcome = await runAgent({
      kind,
      settings: this.request.settings,
      cwd: this.request.store.repoRoot,
      prompt: wrapAgentPrompt(system, user),
      log: (line) => this.log(line),
      ...(this.request.resolveCredential ? { resolveCredential: this.request.resolveCredential } : {}),
    });
    if (!outcome.ok) {
      return { success: false, errorMessage: outcome.errorMessage ?? '执行器失败', outputTail: outcome.outputTail };
    }
    return this.verifyOutcome(outcome.outputTail);
  }

  private async verifyOutcome(outputTail: string): Promise<RunnerExecutionResult> {
    const { store } = this.request;
    const previous = this.request.candidate.meta.currentRevision;
    const previousSolution = this.request.candidate.sections.solution;
    let candidate: ReviewCandidate;
    try {
      const detail = await store.get(this.request.candidate.id, null);
      candidate = detail.candidate;
    } catch (error) {
      return {
        success: false,
        errorMessage: `AI 执行后无法读取 review.md：${error instanceof Error ? error.message : String(error)}`,
        outputTail,
      };
    }
    if (candidate.meta.currentRevision <= previous) {
      return {
        success: false,
        errorMessage: `AI 没有生成新版本（current_revision 仍为 ${String(candidate.meta.currentRevision)}）。请查看执行日志，或改用手动修复提示。`,
        outputTail,
      };
    }
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) {
      return { success: false, errorMessage: 'AI 更新了 current_revision，但 revisions 中缺少对应条目', outputTail };
    }
    const patchPath = path.join(candidate.dirPath, current.patch);
    if (!existsSync(patchPath)) {
      return { success: false, errorMessage: `AI 未生成补丁文件 ${current.patch}`, outputTail };
    }
    let patchText = '';
    try {
      patchText = await readFile(patchPath, 'utf8');
    } catch (error) {
      return { success: false, errorMessage: `无法读取新补丁：${error instanceof Error ? error.message : String(error)}`, outputTail };
    }
    if (patchTouchesReviewData(patchText)) {
      return {
        success: false,
        errorMessage: 'AI 生成的补丁包含 .ai-review/ 自身改动，已拒绝。请让 AI 只提交业务代码 diff。',
        outputTail,
      };
    }
    this.log(`已生成版本 ${String(candidate.meta.currentRevision)}（${current.patch}，基线 ${current.baseRevision}）`);
    return {
      success: true,
      newRevisionId: candidate.meta.currentRevision,
      newPatchPath: patchPath,
      schemeChanged: candidate.sections.solution.trim() !== previousSolution.trim(),
      outputTail,
    };
  }
}
