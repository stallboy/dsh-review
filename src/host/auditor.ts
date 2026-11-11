import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { patchTouchesReviewData, collectCommitEntries, type VcsAdapter } from './vcs.js';
import { reviewersPath } from './reviewers.js';
import { runAgent, wrapAgentPrompt } from './runner.js';
import { ReviewStore } from './store.js';
import type { CandidateSource } from './store.js';
import { AuditArchive, type AuditItem } from './audit-archive.js';
import type {
  AppSettings,
  AuditCandidateResult,
  AuditDeferredItem,
  AuditOutcome,
  AuditReportInfo,
  PatchStats,
  VcsType,
} from './types.js';
import { ApiError } from './types.js';

export const AUDIT_TIMEOUT_MS = 60 * 60 * 1000;
const OUTLINE_LIMIT = 220;
const REPORT_MARKER_START = '<!-- ai-review:audit-verification -->';
const REPORT_MARKER_END = '<!-- /ai-review:audit-verification -->';
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.ai-review',
  '.tmp',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.idea',
  '.vscode',
  'target',
  'vendor',
]);
const EMPTY_STATS: PatchStats = { files: 0, additions: 0, deletions: 0, entries: [] };

function packageRoot(): string {
  return path.resolve(import.meta.dirname, '..');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Resolve and validate an audit target; rejects absolute paths and traversal. */
export function normalizeAuditTarget(
  repoRoot: string,
  raw: string,
): { targetPath: string; absolutePath: string } {
  const root = path.resolve(repoRoot);
  const trimmed = raw.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (trimmed === '.' || trimmed === '') {
    return { targetPath: '', absolutePath: root };
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) {
    throw new ApiError(400, 'bad_request', '审查目标必须是仓库内的相对路径');
  }
  const absolute = path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ApiError(400, 'bad_request', '审查目标越界：必须位于当前仓库内');
  }
  const targetPath = relative.replaceAll('\\', '/');
  if (targetPath === '.ai-review' || targetPath.startsWith('.ai-review/')) {
    throw new ApiError(400, 'bad_request', '不能审查 .ai-review 数据目录本身');
  }
  return { targetPath, absolutePath: absolute };
}

/** Normalize the target and require that it exists in the working tree. */
export async function resolveAuditTarget(
  repoRoot: string,
  raw: string,
): Promise<{ targetPath: string; absolutePath: string }> {
  const target = normalizeAuditTarget(repoRoot, raw);
  try {
    await stat(target.absolutePath);
  } catch {
    throw new ApiError(400, 'bad_request', `审查目标不存在：${target.targetPath || '.'}`);
  }
  return target;
}

function bulletItem(line: string, category: AuditDeferredItem['category']): AuditDeferredItem | null {
  const raw = line.replace(/^[-*]\s+/, '').trim();
  if (!raw) return null;
  const separator = raw.search(/[：:]/);
  let label = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const text = separator === -1 ? '' : raw.slice(separator + 1).trim();
  label = label.replace(/^\*\*(.*)\*\*$/, '$1').replace(/^__(.*)__$/, '$1').trim();
  if (!label) return null;
  return { label, text, category };
}

function isEmptyMarker(item: AuditDeferredItem): boolean {
  if (item.text && !/^(无|none|n\/?a)$/i.test(item.text.trim())) return false;
  const label = item.label.replace(/[（(].*?[）)]/g, '').trim();
  return /^(无|none|n\/?a)$/i.test(label);
}

/**
 * Parse the auditor's Markdown report. The report is the only source of B-class
 * and deferred items, so the contract is deliberately forgiving: any B-class /
 * "needs human confirmation" section yields `confirm` items, and any Deferred /
 * "wait for prerequisite" section yields `deferred` items.
 */
export function parseAuditReport(text: string): { deferred: AuditDeferredItem[] } {
  const deferred: AuditDeferredItem[] = [];
  let category: AuditDeferredItem['category'] | null = null;
  let inFence = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s*(.*?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1] ?? '';
      if (/B\s*类|需人工确认|B[\s-]*class|human\s+(?:confirmation|decision)/i.test(title)) category = 'confirm';
      else if (/Deferred|待前置合入|延迟处理/i.test(title)) category = 'deferred';
      else category = null;
      continue;
    }
    if (category === null) continue;
    if (!/^[-*]\s+/.test(line)) continue;
    const item = bulletItem(line, category);
    if (item && !isEmptyMarker(item)) deferred.push(item);
  }
  return { deferred };
}

export async function loadAuditSystemPrompt(): Promise<string> {
  const fallback = [
    '你是仓库审查与重构优化专家。请按正确性、安全性、负载稳定性、可测试性、性能、精简的优先级审查仓库。',
    '只把无疑问的本质修复或明显精简生成为 .ai-review 候选；存疑或跨模块重大改动只写入审查报告。',
    '所有候选必须独立基于同一基线，生成补丁后立即还原业务工作区，不得提交代码。',
  ].join('\n');
  try {
    return (await readFile(path.join(packageRoot(), 'assets', 'repo-audit-system.md'), 'utf8')).trim();
  } catch {
    return fallback;
  }
}

export function auditReportPath(targetPath: string, now: Date): string {
  const stamp = `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const slug = (targetPath || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'repo';
  return `.ai-review/audits/${stamp}-${slug}/audit.md`;
}

async function readReviewersText(repoRoot: string, owner: string): Promise<string> {
  try {
    const text = await readFile(reviewersPath(repoRoot), 'utf8');
    return text.trim().slice(0, 6000);
  } catch {
    return [
      '# reviewers.yml 尚不存在；直接执行审查时插件会创建它。',
      `default_owner: ${JSON.stringify(owner || '')}`,
      'rules: []',
    ].join('\n');
  }
}

async function collectOutline(repoRoot: string, targetAbsolute: string, limit = OUTLINE_LIMIT): Promise<string> {
  const root = path.resolve(repoRoot);
  const lines: string[] = [];
  try {
    const rootEntries = await readdir(root, { withFileTypes: true });
    const top = rootEntries
      .filter((entry) =>
        !entry.name.startsWith('.git')
        && entry.name !== '.svn'
        && entry.name !== '.ai-review'
        && !SKIP_DIRS.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 40)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (top.length > 0) lines.push(`根目录条目：${top.join('  ')}`);
  } catch {
    // A readable repository was already validated by the VCS adapter.
  }
  const targetInfo = await stat(targetAbsolute).catch(() => null);
  if (targetInfo === null) return lines.join('\n');
  if (!targetInfo.isDirectory()) {
    lines.push(`目标文件：${path.relative(root, targetAbsolute).replaceAll('\\', '/')}`);
    return lines.join('\n');
  }
  const relativeTarget = path.relative(root, targetAbsolute).replaceAll('\\', '/');
  if (relativeTarget) lines.push(`目标目录：${relativeTarget}/`);
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: targetAbsolute, relative: relativeTarget, depth: 0 },
  ];
  let count = 0;
  while (queue.length > 0 && count < limit) {
    const current = queue.shift();
    if (!current) break;
    const entries = await readdir(current.absolute, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (count >= limit) break;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
        lines.push(`${relative}/`);
        count += 1;
        if (current.depth < 5) {
          queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        }
      } else {
        lines.push(relative);
        count += 1;
      }
    }
  }
  if (count >= limit) lines.push(`…（文件清单已截断，仅展示前 ${String(limit)} 项；请自行读取更多文件）`);
  return lines.join('\n');
}

async function existingCandidateLines(
  store: ReviewStore,
  baseRevision: string,
  source?: CandidateSource,
): Promise<string> {
  try {
    // §7.1/G10：共享读取绑定同一 VCS 快照；未提供 source 时退回工作区视图（写路径）。
    const { items } = await store.list({}, baseRevision, undefined, undefined, source);
    // §7.1：提示词注入同样只能使用共享事实——本地草稿（local）不得当作已存在候选。
    const active = items.filter((item) => !item.local && (item.status === 'pending' || item.status === 'changes_requested'));
    if (active.length === 0) return '- 无待处理候选。';
    return active
      .slice(0, 40)
      .map((item) => `- ${item.id}：${item.title}（${item.status}，owner ${item.owner}）`)
      .join('\n');
  } catch {
    return '- （无法读取现有候选；请自行检查 .ai-review/）';
  }
}

/** §7.5/§7.6：负向记忆注入——窗口内 rejected 摘要（每模块上限 max_anti_patterns，按 rejected_at 倒序）。 */
async function negativeMemoryLines(repoRoot: string, source?: CandidateSource): Promise<string> {
  try {
    const store = new ReviewStore(repoRoot);
    const { loadReviewers } = await import('./reviewers.js');
    const { entryFromCandidate, topPerModule, formatMemorySummary, withinWindow } = await import('./memory.js');
    const config = await loadReviewers(repoRoot);
    // §7.1/G10：负向记忆同样只能来自同一共享快照，避免本地未提交内容被当作共享事实。
    const { items } = await store.list({}, null, undefined, undefined, source);
    const full = [];
    for (const item of items) {
      // §7.1：本地草稿不是共享事实，不得进入负向记忆。
      if (item.local || item.status !== 'rejected') continue;
      try {
        const record = await store.get(item.id, null, source);
        const entry = entryFromCandidate({ candidateId: item.id, meta: record.candidate.meta });
        if (entry && withinWindow(entry, config.rejectionMemoryDays, Date.now())) full.push(entry);
      } catch {
        // 跳过无法读取的 rejected 候选
      }
    }
    if (full.length === 0) return '- 无（近期没有被拒绝的方案）。';
    return formatMemorySummary(topPerModule(full, config.maxAntiPatterns));
  } catch {
    return '- （无法读取负向记忆；请自行检查 .ai-review/ 下已拒绝候选。）';
  }
}

export interface BuildAuditPromptInput {
  repoRoot: string;
  vcsType: VcsType;
  owner: string;
  targetPath: string;
  note: string;
  baseRevision: string;
  reportPath: string;
  /** `session` lets the agent commit `.ai-review` itself; `headless` forbids commits. */
  mode?: 'headless' | 'session';
  /** §7.1/G10：提示词中的已存在候选与负向记忆必须读取同一 VCS 共享快照。 */
  source?: CandidateSource;
  now?: Date;
}

/** Build the user prompt for one repository audit. Pure apart from reading repo context. */
export async function buildAuditPrompt(input: BuildAuditPromptInput): Promise<string> {
  const target = await resolveAuditTarget(input.repoRoot, input.targetPath);
  const now = input.now ?? new Date();
  const reviewersText = await readReviewersText(input.repoRoot, input.owner);
  const outline = await collectOutline(input.repoRoot, target.absolutePath);
  const existing = await existingCandidateLines(new ReviewStore(input.repoRoot), input.baseRevision, input.source);
  const negativeMemory = await negativeMemoryLines(input.repoRoot, input.source);
  const month = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}`;
  const scope = target.targetPath ? `\`${target.targetPath}\`` : '全仓库';
  const sessionMode = input.mode === 'session';
  // §11.4（2026-11-10 修订）：任何模式都严禁 Agent 自行 commit——审查产物由 Host 在收尾统一提交。
  const commitRule = '5. 严禁执行 `git commit` / `svn commit` / `git push` / `svn add`。审查产物由插件在收尾统一提交；结束前 `git status` / `svn status` 除 `.ai-review/` 外必须干净，不得在业务工作区留下未导出的改动或临时文件。';
  const completionRule = sessionMode
    ? '10. 完成时用简体中文输出最终摘要：新增候选、B/Deferred、报告路径。随后等待用户在审核面板执行「收尾」（finalize），不要自行提交。'
    : '10. 完成时输出一行 `DONE` 和本次新增候选/报告的简短摘要。';
  const lines: string[] = [
    '# 任务',
    '请你作为本轮仓库审查的执行者，先按审查准则扫描目标范围，再把「A 类：无疑问的本质缺陷 / 低风险明显精简重构」直接转化为 `.ai-review` 候选修复包；B 类只写入审查报告，不修改代码。',
    '',
    '## 环境与范围',
    `- 仓库根目录（同时是工作目录）：${path.resolve(input.repoRoot)}`,
    `- VCS 类型：${input.vcsType}`,
    `- 当前基线 base_revision：${input.baseRevision}`,
    `- 审查目标：${scope}`,
    `- 候选目录月份：.ai-review/${month}/`,
    `- 本轮审查报告文件（相对仓库根目录）：${input.reportPath}`,
    `- reviewers.yml：.ai-review/reviewers.yml`,
    `- 当前时间：${now.toISOString()}`,
    `- 当前操作者 owner：${input.owner}`,
    '',
    '## reviewers.yml 当前内容',
    '```yaml',
    reviewersText,
    '```',
    `owner 解析顺序：按 rules 的 paths/tags 匹配 → default_owner → ${input.owner || '当前操作者'}。`,
    '',
    '## 已存在的候选（不要重复生成同一问题）',
    existing,
    '',
    '## 负向记忆：近期被拒绝的方案（禁止重复；标题/文件/原因见下）',
    negativeMemory,
    '',
    '## 仓库结构摘要（仅用于建立地图，完整内容请自行读取）',
    '```text',
    outline,
    '```',
    '',
    '## 用户关注点（可选）',
    input.note.trim() || '无特别关注点，按审查准则自主选择收益最高的问题。',
    '',
    ...(sessionMode ? [
      '## 会话执行方式（本次由用户直接从 DSH 发起）',
      '你正在一个独立的 DSH 会话中执行本任务，用户可以在侧边栏看到完整过程，也可以随时切换到其他会话。',
      '- 在关键节点输出简短进度：建立地图、候选 N 已生成、验证结果；不要只埋头执行。',
      '- 不要中途等待用户确认；遇到 B 类或需要人工拍板的事项，写入审查报告后继续。',
      '- 完成全部候选后按规则输出摘要并停止；插件（Host）会在用户执行收尾时统一校验并提交 `.ai-review/`。',
      '',
    ] : []),
    '## 硬性执行规则',
    '1. 所有候选必须**完全独立地基于当前基线**，严禁生成需要按顺序打补丁的依赖链。每导出一个候选的 `001.patch` 后，必须立即把业务工作区还原到基线，再处理下一个问题。',
    '2. 一个问题一个候选目录，目录名为 `YYYYMMDD-<module>-<short-slug>`，放在 `.ai-review/' + month + '/` 下；`<module>` 与 `<short-slug>` 只能使用 ASCII 字母、数字、`.`、`_`、`-`（禁止中文、空格、斜杠），中文语义写入 review.md 的 title。同一函数/结构体内强耦合的清理可合并进同一个本质修复。',
    '3. A 类必须：真正修改代码 → 实际运行 `gate_checks` 中的全部命令 → 导出 UTF-8/LF 全量 unified diff 到 `001.patch`（不得包含 `.ai-review/` 自身）→ 生成 review.md → 还原业务工作区。验证无法收敛时回滚，并降级为 B 类。',
    '4. B 类：不修改代码，只写入审查报告；不要为 B 类创建候选目录。若改动 B 强依赖某个大改动 A 先合入主干，把 B 写入“待前置合入后处理（Deferred）”。',
    commitRule,
    '6. 审查报告必须最后写入上述报告文件（只写 Markdown 正文，**不要写 YAML Frontmatter**——插件收尾时会统一补全档案头）。结构见下节。报告是插件解析 B 类与 Deferred 清单的唯一来源，请严格使用指定标题和列表格式。',
    '7. 如果没有 A 类问题，报告 A 类写“无”，不要为了凑数生成候选；如果所有候选都验证失败，也不要留下半成品目录。',
    '8. review.md 的 `gate_checks` 每条都必须实际运行并通过；`# 需人工判断项` 只写真正需要人类拍板的点，没有就只写一行 `- 无`，不要为“业务逻辑 / 架构 / 性能 / 边界”逐个凑“无”。',
    '9. 正文必须便于人快速扫读：每个章节先用 1 句结论，再列 2–5 条短要点；每条不超过 2 句或 120 字；禁止连续超过 3 行的长段落。优先使用列表和 `###` 小标题，命令与日志只放 `# 验证证据`。',
    '10. 补丁生成方式：Git 使用 `git diff <base_revision> --binary`（新增业务文件先 `git add -N <文件>`，绝不能把 `.ai-review/` 加入索引）；SVN 在工作区为对应 revision 时使用 `svn diff`。',
    completionRule,
    '',
    '## review.md 最小字段（必须严格满足）',
    '```markdown',
    '---',
    'schema_version: 1',
    'title: "<小写模块标志>: <中文标题>"',
    'module: <模块标志>',
    'audit_type: bugfix # bugfix | delete | shrink | reuse | merge | split',
    'created_at: "<ISO-8601>"',
    'owner: "<按 reviewers.yml 解析后的负责人>"',
    'tags: [<标签>]',
    'status: pending',
    'ticket: null',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "' + input.baseRevision + '"',
    '    patch: "001.patch"',
    'gate_checks:',
    '  - "<实际执行且通过的命令>"',
    'comments: []',
    'approval: null',
    '---',
    '```',
    '正文按审查准则的章节结构生成：`# 问题与影响`、`# 根因`、`# 当前修复方案`、`# 需人工判断项`、`# 验证证据`、`# 审核记录`。',
    '',
    '## 审查报告模板',
    '```markdown',
    '# 仓库审查报告',
    '- 基线：' + input.baseRevision,
    '- 范围：' + (target.targetPath || '全仓库'),
    '- 执行时间：<ISO-8601>',
    '',
    '## A 类：已生成候选',
    '- `.ai-review/<YYYY-MM>/<候选目录>/`：<title>（<audit_type>）',
    '',
    '## B 类：需人工确认（未改代码）',
    '- **<标题>**：<为什么需要人工确认 / 影响面 / 建议>',
    '',
    '## 待前置合入后处理（Deferred）',
    '- **<标题>**：<依赖哪个候选或前置条件>',
    '',
    '## 验证与说明',
    '- 实际执行的命令与结果摘要；未覆盖风险。',
    '```',
  ];
  return lines.join('\n');
}

async function ensureReviewScaffold(store: ReviewStore, owner: string): Promise<boolean> {
  const aiRoot = path.join(store.repoRoot, '.ai-review');
  await mkdir(path.join(aiRoot, 'audits'), { recursive: true });
  const file = reviewersPath(store.repoRoot);
  if (existsSync(file)) return false;
  await writeFile(
    file,
    [
      '# dsh-code-review: 目录 / tag 与负责人路由。直接执行仓库审查时由插件初始化。',
      `default_owner: ${JSON.stringify(owner || '')}`,
      'rules: []',
      '',
    ].join('\n'),
    'utf8',
  );
  return true;
}

function renderVerificationBlock(input: {
  created: AuditCandidateResult[];
  warnings: string[];
  runError: string | null;
  now: Date;
  baseRevision: string;
  targetPath: string;
}): string {
  const lines: string[] = [
    '## 插件复核',
    `- 复核时间：${input.now.toISOString()}`,
    `- 基线：\`${input.baseRevision}\``,
    `- 审查目标：${input.targetPath ? `\`${input.targetPath}\`` : '全仓库'}`,
    `- 新增候选：${String(input.created.length)}`,
    `- AI 执行：${input.runError ?? '成功'}`,
    '- 业务工作区：已尝试还原到基线（仅保留 .ai-review/）',
    '',
    '### 候选校验',
  ];
  if (input.created.length === 0) {
    lines.push('- 无新增候选。');
  } else {
    for (const candidate of input.created) {
      const state = candidate.errors.length === 0
        ? `通过（+${String(candidate.patchStats.additions)}/-${String(candidate.patchStats.deletions)}，${String(candidate.gateChecks)} 项门禁）`
        : `存在问题：${candidate.errors.join('；').replaceAll('\n', ' ')}`;
      lines.push(`- \`${candidate.id}\`：${state}`);
    }
  }
  if (input.warnings.length > 0) {
    lines.push('', '### 复核提示');
    for (const warning of input.warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

function upsertVerificationBlock(text: string, block: string): string {
  const marker = new RegExp(`${REPORT_MARKER_START}[\\s\\S]*?${REPORT_MARKER_END}`);
  const wrapped = `${REPORT_MARKER_START}\n${block}\n${REPORT_MARKER_END}`;
  if (marker.test(text)) return text.replace(marker, wrapped);
  return `${text.replace(/\s+$/, '')}\n\n${wrapped}\n`;
}

function fallbackReport(input: {
  baseRevision: string;
  targetPath: string;
  created: AuditCandidateResult[];
  runError: string | null;
  now: Date;
}): string {
  const createdLines = input.created.length === 0
    ? ['- 无']
    : input.created.map((candidate) => `- \`${candidate.id}\`：${candidate.title}`);
  return [
    '# 仓库审查报告',
    '',
    `- 基线：${input.baseRevision}`,
    `- 范围：${input.targetPath || '全仓库'}`,
    `- 执行时间：${input.now.toISOString()}`,
    '',
    '## A 类：已生成候选',
    ...createdLines,
    '',
    '## B 类：需人工确认（未改代码）',
    '- 无（AI 未生成审查报告；请查看任务日志或重新执行仓库审查）。',
    '',
    '## 待前置合入后处理（Deferred）',
    '- 无',
    '',
    '## 验证与说明',
    input.runError ? `- 执行器未正常结束：${input.runError}` : '- AI 执行结束，但未写入审查报告。',
    '',
  ].join('\n');
}


export interface AuditFinalizeInput {
  auditId: string;
  beforeIds: Set<string>;
  baseRevision: string;
  targetPath: string;
  trigger: 'manual' | 'scheduled';
  runError: string | null;
  startedAt: number;
  /** 本次运行首次创建了 reviewers.yml（须随收尾提交）。 */
  reviewersCreated?: boolean;
  extraWarnings?: string[];
  now: Date;
}

export interface AuditFinalizeResult {
  created: AuditCandidateResult[];
  deferred: AuditDeferredItem[];
  reportPath: string;
  body: string;
  commitRevision: string | null;
  status: 'COMMITTED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';
  /** §7.7：RECOVERY_REQUIRED 必含 reason 与 detail（COMMIT_OUTCOME_UNKNOWN / SYNC_STATE_UNKNOWN）。 */
  reason?: 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN';
  detail?: string;
  warnings: string[];
  message: string;
}

/** 从 audit_id 的 UTC 时间戳还原 created_at（I13：两者必须精确到秒一致）。 */
export function auditIdToCreatedAt(auditId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(auditId);
  if (!match) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/** 由 kind+标题派生稳定 finding_id（跨轮一致：同标题同 id）。 */
function findingIdOf(kind: 'confirm' | 'deferred', title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const hash = createHash('sha1').update(`${kind}:${normalized}`).digest('hex').slice(0, 10);
  return `f-${hash}`;
}

/**
 * §4.7/§4.8：从 B/Deferred 文本尽力提取业务文件路径，作为 finding 覆盖判定的
 * target_files。只承认形如 `dir/file.ext` 的仓库相对路径；行号后缀（`:12`、`:12-20`）
 * 不会进入匹配（扩展名之后只认路径字符），URL、绝对路径、盘符、含 `..` 的遍历路径
 * 与 `.ai-review/` 数据目录一律排除。去重后最多保留 20 条，按首次出现顺序。
 */
const MAX_TARGET_FILES = 20;
const RAW_TARGET_FILE_PATTERN =
  /(?<![\w/.-])(?:\.\/)?(?:[A-Za-z0-9._@+~-]+\/)+[A-Za-z0-9._@+~-]+\.[A-Za-z][A-Za-z0-9]{0,9}/g;

function extractTargetFiles(texts: string[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    // 统一为正斜杠，兼容 Windows 风格报告；URL/盘符/绝对路径仍会在校验中排除。
    const normalized = text.replaceAll('\\', '/');
    for (const match of normalized.matchAll(RAW_TARGET_FILE_PATTERN)) {
      const token = match[0].replace(/^\.\/+/, '');
      if (token.includes('..')) continue;
      if (token.startsWith('/') || /^[A-Za-z]:/.test(token)) continue;
      if (token === '.ai-review' || token.startsWith('.ai-review/')) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      files.push(token);
      if (files.length >= MAX_TARGET_FILES) return files;
    }
  }
  return files;
}

/** 空 target_files 在非全仓 scope 下会被覆盖判定排除，必须显式告警（否则 items 全部失效）。 */
function warnEmptyTargetFiles(
  warnings: string[],
  item: AuditDeferredItem,
  findingId: string,
  scope: string,
): void {
  if (scope === '.') return;
  warnings.push(
    `审查项「${item.label}」（${findingId}）未从文本提取到 target_files：非全仓 scope「${scope}」下空 target_files 不满足覆盖判定，该项会被排除出 finding 投影，导致本轮 items 全部失效；请在报告中用反引号写明涉及的业务文件路径。`,
  );
}

/**
 * §4.7 items[]：B 类 → confirm（depends_on null）；Deferred → deferred（depends_on
 * 尽力从文本匹配本轮 confirm 标题，未命中时使用占位依赖并告警——该 finding 在依赖出现前不可转换）。
 * §4.8：target_files 从 item.text / item.label 中提取；非全仓 scope 下提取失败必须告警。
 */
export function buildAuditItems(deferred: AuditDeferredItem[], warnings: string[], scope: string): AuditItem[] {
  const items: AuditItem[] = [];
  const confirmIds = new Map<string, string>();
  for (const item of deferred) {
    if (item.category !== 'confirm') continue;
    const id = findingIdOf('confirm', item.label);
    confirmIds.set(item.label, id);
    const targetFiles = extractTargetFiles([item.text, item.label]);
    if (targetFiles.length === 0) warnEmptyTargetFiles(warnings, item, id, scope);
    items.push({
      findingId: id,
      kind: 'confirm',
      title: item.label,
      summary: item.text || '需要人工确认。',
      targetFiles,
      dependsOn: null,
      status: 'pending',
      candidate: null,
    });
  }
  for (const item of deferred) {
    if (item.category !== 'deferred') continue;
    let dependsOn: string | null = null;
    for (const [title, id] of confirmIds) {
      if (item.text && item.text.includes(title)) {
        dependsOn = id;
        break;
      }
    }
    if (!dependsOn) {
      dependsOn = 'pending-external-prerequisite';
      warnings.push(`Deferred 项「${item.label}」未能从文本解析出依赖 finding，已用占位依赖（转换前需先出现对应 finding）`);
    }
    const id = findingIdOf('deferred', item.label);
    const targetFiles = extractTargetFiles([item.text, item.label]);
    if (targetFiles.length === 0) warnEmptyTargetFiles(warnings, item, id, scope);
    items.push({
      findingId: id,
      kind: 'deferred',
      title: item.label,
      summary: item.text || '等待前置合入。',
      targetFiles,
      dependsOn,
      status: 'pending',
      candidate: null,
    });
  }
  return items;
}

/**
 * §7.6：A 类正文列表同步过滤——移除引用未通过校验候选的列表行，
 * 并追加一行说明（校验失败候选不进入共享提交，也不得保留在共享正文引用中）。
 */
function filterAClassSection(body: string, validIds: string[], createdIds: string[]): string {
  const invalid = createdIds.filter((id) => !validIds.includes(id));
  if (invalid.length === 0) return body;
  const lines = body.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s*A\s*类/.test(line);
      out.push(line);
      continue;
    }
    if (inSection && /^\s*[-*]\s/.test(line) && invalid.some((id) => line.includes(id))) continue;
    out.push(line);
  }
  return `${out.join('\n').replace(/\s+$/, '')}\n-（${String(invalid.length)} 个候选未通过收尾校验，未纳入共享提交；详见插件复核块。）\n`;
}

export interface AuditDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  owner: string;
  targetPath: string;
  note: string;
  log: (line: string) => void;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  /** §7.1/G10：审查提示词中的共享事实读取源（绑定同一 VCS 快照）；缺省为工作区视图。 */
  candidateSource?: CandidateSource;
  /** §7.7：Job 取消信号，用于终止 headless Runner。 */
  signal?: AbortSignal;
}

/**
 * Repository audit: an executor scans the current repository, writes orthogonal
 * `.ai-review` candidates plus a report, and the plugin verifies and commits the
 * resulting data. This is the candidate producer that closes the review loop.
 */
export class Auditor {
  constructor(private readonly deps: AuditDeps) {}

  private log(line: string): void {
    this.deps.log(line);
  }

  async run(): Promise<AuditOutcome> {
    const { store, vcs, settings, owner } = this.deps;
    const root = store.repoRoot;
    const base = await vcs.getCurrentBase();
    if (!base) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision）；请先提交一次再执行仓库审查。');
    }
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const target = await resolveAuditTarget(root, this.deps.targetPath);
    const now = new Date();
    // §4.7：audit_id 由 Host 生成（UTC 时间戳），报告正文路径即档案 audit.md。
    const archive = new AuditArchive(root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
    const userPrompt = await buildAuditPrompt({
      repoRoot: root,
      vcsType: vcs.type,
      owner,
      targetPath: target.targetPath,
      note: this.deps.note,
      baseRevision: base,
      reportPath,
      mode: 'headless',
      now,
      ...(this.deps.candidateSource ? { source: this.deps.candidateSource } : {}),
    });
    const warnings: string[] = [];

    if (settings.runner === 'manual') {
      this.log('手动模式：已生成仓库审查提示词，未修改仓库。');
      return {
        manual: true,
        status: 'MANUAL_REQUIRED',
        auditId,
        prompt: wrapAgentPrompt(await loadAuditSystemPrompt(), userPrompt),
        created: [],
        deferred: [],
        report: null,
        commitRevision: null,
        baseRevision: base,
        targetPath: target.targetPath,
        warnings,
        message: '已生成仓库审查提示词。请在任意外部 Agent 中执行，完成后调用 /audit/finalize 收尾。',
      };
    }

    const reviewersCreated = await ensureReviewScaffold(store, owner);
    const before = new Set(await store.listCandidateIds());
    const startedAt = Date.now();
    this.log(`开始仓库审查：目标 ${target.targetPath || '全仓库'}，基线 ${base.slice(0, 12)}`);
    const run = await runAgent({
      kind: settings.runner === 'dsh' ? 'dsh' : 'external',
      settings,
      cwd: root,
      prompt: wrapAgentPrompt(await loadAuditSystemPrompt(), userPrompt),
      log: (line) => this.log(line),
      timeoutMs: AUDIT_TIMEOUT_MS,
      label: '仓库审查',
      ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
    });
    const runError = run.ok ? null : run.errorMessage ?? '执行器失败';
    const postRunClean = await vcs.ensureCleanWorkspace().catch(() => null);
    if (postRunClean && !postRunClean.clean) {
      const dirty = postRunClean.dirtyPaths.slice(0, 10).join(', ');
      warnings.push(`AI 结束时业务工作区仍有未还原改动，已强制还原${dirty ? `：${dirty}` : ''}`);
    }
    try {
      await vcs.revertBusinessWorkspace();
    } catch (error) {
      warnings.push(`还原业务工作区失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (runError) {
      this.log(`AI 执行失败：${runError}`);
      warnings.push(`执行器失败：${runError}`);
    } else {
      this.log('AI 执行结束（成功）');
    }
    const afterBase = await vcs.getCurrentBase();
    if (afterBase !== null && afterBase !== base) {
      warnings.push(`执行期间基线从 ${base.slice(0, 12)} 变为 ${afterBase.slice(0, 12)}，审查结果可能已过期`);
    }

    // §7.7：取消只停止执行，不执行收尾提交；返回 ABORTED 供 Job 记录。
    if (this.deps.signal?.aborted || run.aborted) {
      const message = '仓库审查已取消（未执行收尾提交）';
      warnings.push(message);
      this.log(message);
      return {
        manual: false,
        status: 'ABORTED',
        auditId,
        created: [],
        deferred: [],
        report: null,
        commitRevision: null,
        baseRevision: base,
        targetPath: target.targetPath,
        warnings,
        message,
      };
    }

    const created = await this.verifyCandidates(before, base, warnings);
    this.log(`新增候选 ${String(created.length)} 个，校验问题 ${String(created.filter((item) => item.errors.length > 0).length)} 个`);

    const result = await this.finalize({
      auditId,
      beforeIds: before,
      baseRevision: base,
      targetPath: target.targetPath,
      trigger: 'manual',
      runError,
      startedAt,
      reviewersCreated,
      extraWarnings: warnings,
      now: new Date(),
    });

    if (runError && created.length === 0) {
      throw new Error(`${runError}${result.reportPath ? `；审查报告：${result.reportPath}` : ''}`);
    }

    const message = created.length > 0
      ? `仓库审查完成：新增 ${String(created.length)} 个候选${created.filter((item) => item.errors.length > 0).length > 0 ? '（部分需修复）' : ''}${result.commitRevision ? '，已提交 .ai-review' : '，但 .ai-review 提交失败'}；B/Deferred ${String(result.deferred.length)} 项见报告`
      : `仓库审查完成：未生成 A 类候选${result.reportPath ? `，审查报告：${result.reportPath}` : ''}`;
    this.log(message);
    return {
      manual: false,
      status: result.status,
      auditId,
      created,
      deferred: result.deferred,
      report: { path: result.reportPath, text: result.body, deferred: result.deferred },
      commitRevision: result.commitRevision,
      baseRevision: base,
      targetPath: target.targetPath,
      warnings: result.warnings,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      message,
      ...(run.outputTail ? { outputTail: run.outputTail } : {}),
    };
  }

  /**
   * §7.6 Host 收尾：校验新候选（含 owner 路由复核）→ 生成/覆写目录式审查档案
   * （frontmatter + items + 插件复核块）→ 只提交本轮档案目录与合法新候选目录。
   * 校验失败的候选不进入提交，错误写入复核块。供 headless run 与手动 finalize 共用。
   */
  async finalize(input: AuditFinalizeInput): Promise<AuditFinalizeResult> {
    const { store, vcs } = this.deps;
    const warnings = [...(input.extraWarnings ?? [])];
    const created = await this.verifyCandidates(input.beforeIds, input.baseRevision, warnings);
    this.log(`收尾：新增候选 ${String(created.length)} 个，校验问题 ${String(created.filter((item) => item.errors.length > 0).length)} 个`);

    // 读取 Agent 写入的报告正文（audit.md 仅正文；剥离可能误写的 frontmatter）。
    const reportPath = `.ai-review/audits/${input.auditId}/audit.md`;
    const absolute = path.join(store.repoRoot, reportPath);
    let body = await readFile(absolute, 'utf8').catch(() => null);
    if (body === null) {
      body = fallbackReport({
        baseRevision: input.baseRevision,
        targetPath: input.targetPath,
        created,
        runError: input.runError,
        now: input.now,
      });
      warnings.push('AI 未写入审查报告，已生成插件回退报告');
      this.log('AI 未写入审查报告，已生成插件回退报告');
    }
    body = body.replace(/^\uFEFF/, '').replace(/^---\n[\s\S]*?\n---\n?/, '');
    const deferredItems = parseAuditReport(body).deferred;

    // §4.2/G42：verify_gate_on_audit_finalize 为 smoke/declared 时，对合法候选
    // 在补丁应用后的工作区复算门禁（smoke=audit_smoke_commands，declared=候选 gate_checks）；
    // 失败则该候选不提交；无论成败都还原业务工作区。
    // 注意：复核块必须在门禁复算之后渲染，否则失败错误不会出现在块内。
    const { loadReviewers } = await import('./reviewers.js');
    const { runGateChecks } = await import('./validator.js');
    const reviewersConfig = await loadReviewers(store.repoRoot);
    let gateMode: 'none' | 'smoke' | 'declared' = reviewersConfig.verifyGateOnAuditFinalize;
    if (gateMode === 'smoke' && reviewersConfig.auditSmokeCommands.length === 0) {
      warnings.push('verify_gate_on_audit_finalize=smoke 但 audit_smoke_commands 为空，跳过收尾门禁复算');
      gateMode = 'none';
    }
    const gateRechecked: string[] = [];
    if (gateMode !== 'none') {
      for (const candidate of created) {
        if (candidate.errors.length > 0) continue;
        this.log(`收尾门禁复算：候选 ${candidate.id}（${gateMode}）`);
        try {
          const detail = await store.get(candidate.id, null);
          const current = detail.candidate.meta.revisions.find((revision) => revision.id === detail.candidate.meta.currentRevision);
          if (!current) continue;
          const applied = await vcs.applyPatch(path.join(detail.candidate.dirPath, current.patch), false);
          if (!applied.ok) {
            candidate.errors.push(`收尾门禁：补丁无法应用——${applied.message}`);
            continue;
          }
          const commands = gateMode === 'smoke' ? reviewersConfig.auditSmokeCommands : detail.candidate.meta.gateChecks;
          const report = await runGateChecks(commands, {
            cwd: store.repoRoot,
            baseRevision: input.baseRevision,
            timeoutMs: this.deps.settings.gateTimeoutMs,
            onLine: (line: string, _stream: 'stdout' | 'stderr', command: string) => {
              if (line.trim()) this.log(`  [${candidate.id}] ${command.slice(0, 80)}: ${line.slice(0, 300)}`);
            },
          });
          if (!report.allPassed) {
            candidate.errors.push(`收尾门禁（${gateMode}）未通过：\n${report.formattedEvidenceMarkdown}`);
          } else {
            gateRechecked.push(candidate.id);
          }
        } catch (error) {
          candidate.errors.push(`收尾门禁执行异常：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
        }
      }
    }
    const validAfterGates = created.filter((item) => item.errors.length === 0).map((item) => item.id);
    // §7.6：复核块在门禁复算之后渲染，失败候选及其错误会进入块内；正文 A 类列表同步过滤。
    const block = renderVerificationBlock({
      created,
      warnings,
      runError: input.runError,
      now: input.now,
      baseRevision: input.baseRevision,
      targetPath: input.targetPath,
    });
    const finalBody = upsertVerificationBlock(body, block);
    const filteredBody = filterAClassSection(finalBody, validAfterGates, created.map((item) => item.id));
    const gateFailed = created.filter((item) => item.errors.some((error) => error.startsWith('收尾门禁'))).length;
    const gateNote = gateMode === 'none'
      ? '门禁未由 Host 复算（audit 期门禁为 AI 报告；批准时 Host 仍会重新执行全部门禁）'
      : `门禁已由 Host 复算（${gateMode}）：${String(gateRechecked.length)} 通过，${String(gateFailed)} 失败（失败候选已从 candidates 与 A 类列表剔除）`;
    const bodyWithGateNote = `${filteredBody.replace(/\s+$/, '')}\n\n> 收尾说明：${gateNote}\n`;
    const archive = new AuditArchive(store.repoRoot);
    const items = buildAuditItems(deferredItems, warnings, input.targetPath || '.');
    // I13：created_at 必须与 audit_id 的 UTC 时间戳一致（audit_id 生成时刻）。
    const createdAt = auditIdToCreatedAt(input.auditId);
    const previous = (await archive.list())
      .filter((record) => !record.parseError && record.meta.auditId !== input.auditId)
      .map((record) => record.meta.auditId)
      .sort()
      .pop() ?? null;
    await archive.writeExisting({
      schemaVersion: 1,
      auditId: input.auditId,
      createdAt,
      baseRevision: input.baseRevision,
      scope: input.targetPath || '.',
      trigger: input.trigger,
      previousAudit: previous,
      candidates: validAfterGates,
      items,
    }, bodyWithGateNote);
    this.log(`审查档案：${reportPath}（B/Deferred ${String(items.length)} 项；${gateNote}）`);

    // §7.6：收尾提交只包含本轮 audit 目录、合法新候选目录与（首次创建的）reviewers.yml。
    const commitPaths = [
      `.ai-review/audits/${input.auditId}`,
      ...validAfterGates.map((id) => `.ai-review/${id}`),
      ...(input.reviewersCreated ? ['.ai-review/reviewers.yml'] : []),
    ];
    let commitRevision: string | null = null;
    let status: AuditFinalizeResult['status'];
    let recoveryReason: AuditFinalizeResult['reason'];
    let recoveryDetail: string | undefined;
    if (validAfterGates.length > 0 || input.runError === null) {
      const scopeLabel = input.targetPath || 'repo';
      // §5.6 三分支：按路径级提交探针判定（Git=HEAD；SVN=相关路径 last-changed-revision），
      // 提交报错时用提交版本中的 audit.md 内容核对，避免把并发提交误当成本次收尾。
      const writtenAudit = await readFile(path.join(store.repoRoot, reportPath), 'utf8').catch(() => null);
      // SVN 下目录 revision 不随子文件修改前进：探针至少覆盖 audit.md 本身。
      const probePaths = [reportPath, ...validAfterGates.map((id) => `.ai-review/${id}`)];
      const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
      // §7.5 步骤 9（B1）：先展开完整提交集合（目录 → 文件），再核对，防止另存文件夹带。
      const { entries: commitEntries } = await collectCommitEntries(store.repoRoot, commitPaths);
      const commit = await vcs.atomicCommit({
        message: `audit(${scopeLabel}): 仓库审查生成 ${String(created.length)} 个候选${created.length === 0 ? '（仅报告）' : ''} [skip ci]`,
        paths: commitPaths,
        verifyEntries: commitEntries,
      });
      void writtenAudit;
      if (commit.success) {
        commitRevision = commit.commitRevision;
        this.log(`已提交审查收尾：${commitRevision?.slice(0, 12) ?? '(无版本号)'}`);
        status = created.some((item) => item.errors.length > 0) ? 'VALIDATION_FAILED' : 'COMMITTED';
      } else {
        const probeAfter = await vcs.getCommitProbe(probePaths).catch(() => null);
        let landed = false;
        if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
          const atCommit = writtenAudit === null ? null : await vcs.readFileAt(probeAfter, reportPath).catch(() => null);
          landed = atCommit !== null && atCommit === writtenAudit;
        }
        if (landed && probeAfter !== null) {
          commitRevision = probeAfter;
          this.log(`提交命令报错但收尾已落地且内容匹配（${probeAfter.slice(0, 12)}），按成功继续`);
          status = created.some((item) => item.errors.length > 0) ? 'VALIDATION_FAILED' : 'COMMITTED';
        } else if (probeBefore === null || probeAfter === null || probeAfter !== probeBefore) {
          status = 'RECOVERY_REQUIRED';
          recoveryReason = 'COMMIT_OUTCOME_UNKNOWN';
          recoveryDetail = commit.errorOutput;
          const warning = `提交结果无法确定（提交探针不可读或提交内容不匹配），现场保留待人工核对：${commit.errorOutput}`;
          warnings.push(warning);
          this.log(warning);
        } else {
          status = 'ABORTED';
          // §5.6(2)：已证明提交不存在 → 恢复操作前状态（删除本轮新写的 audit 目录与新候选目录）。
          await this.removeFinalizeArtifacts(input.auditId, created.map((item) => item.id)).catch(() => undefined);
          const warning = `提交 .ai-review 失败，已清理本轮本地写入：${commit.errorOutput}`;
          warnings.push(warning);
          this.log(warning);
        }
      }
    } else {
      status = 'ABORTED';
      this.log('执行失败且没有合法候选，未提交 .ai-review');
    }
    const message = created.length > 0
      ? `收尾完成：新增 ${String(created.length)} 个候选（合法 ${String(validAfterGates.length)} 个）${commitRevision ? '，已提交' : '，提交失败'}`
      : `收尾完成：未生成 A 类候选，档案 ${reportPath}`;
    return {
      created,
      deferred: deferredItems,
      reportPath,
      body: filteredBody,
      commitRevision,
      status,
      ...(recoveryReason ? { reason: recoveryReason } : {}),
      ...(recoveryDetail ? { detail: recoveryDetail } : {}),
      warnings,
      message,
    };
  }

  /** §5.6(2)：已证明收尾提交不存在时，删除本轮新生成本地写入。 */
  private async removeFinalizeArtifacts(auditId: string, candidateIds: string[]): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(path.join(this.deps.store.repoRoot, '.ai-review', 'audits', auditId), { recursive: true, force: true }).catch(() => undefined);
    for (const id of candidateIds) {
      await rm(path.join(this.deps.store.repoRoot, '.ai-review', id), { recursive: true, force: true }).catch(() => undefined);
    }
    // 清空首次失败提交留在索引中的暂存（Git）并还原工作区，避免下一次收尾被“额外暂存条目”拒绝。
    await this.deps.vcs.revertBusinessWorkspace().catch(() => undefined);
  }

  private async verifyCandidates(
    before: Set<string>,
    baseRevision: string,
    warnings: string[],
  ): Promise<AuditCandidateResult[]> {
    const { store, vcs } = this.deps;
    // §4.2/G3：owner 路由是 Host 强制规则——Agent 填错 owner 的候选不得进入共享提交。
    const { loadReviewers, resolveOwner } = await import('./reviewers.js');
    const reviewers = await loadReviewers(store.repoRoot);
    const after = await store.listCandidateIds();
    const removed = [...before].filter((id) => !after.includes(id));
    for (const id of removed) {
      warnings.push(`审查期间已有候选目录消失或被移除：${id}`);
      this.log(`警告：候选目录消失 ${id}`);
    }
    const newIds = after.filter((id) => !before.has(id)).sort((left, right) => left.localeCompare(right));
    const created: AuditCandidateResult[] = [];
    for (const id of newIds) {
      const result: AuditCandidateResult = {
        id,
        title: id,
        owner: '',
        status: 'pending',
        patch: '',
        baseRevision: '',
        patchStats: EMPTY_STATS,
        gateChecks: 0,
        errors: [],
      };
      try {
        const detail = await store.get(id, baseRevision);
        const meta = detail.candidate.meta;
        const current = meta.revisions.find((revision) => revision.id === meta.currentRevision);
        if (!current) throw new Error('current_revision 对应的版本缺失');
        result.title = meta.title;
        result.owner = meta.owner;
        result.status = meta.status;
        result.patch = current.patch;
        result.baseRevision = current.baseRevision;
        result.patchStats = detail.patchStats;
        result.gateChecks = meta.gateChecks.length;
        if (meta.status !== 'pending') result.errors.push(`新候选状态必须是 pending，当前为 ${meta.status}`);
        if (meta.currentRevision !== 1) result.errors.push(`新候选 current_revision 必须为 1，当前为 ${String(meta.currentRevision)}`);
        if (meta.approval !== null) result.errors.push('新候选的 approval 必须为 null');
        // §4.2/G3：owner 必须等于 Host 按 reviewers.yml 计算的路由结果。
        const routing = resolveOwner(reviewers, { paths: meta.targetFiles, tags: meta.tags });
        if (!routing.owner) {
          result.errors.push('reviewers.yml 未配置 default_owner，无法完成 owner 路由复核');
        } else if (meta.owner !== routing.owner) {
          result.errors.push(`owner 应为 ${routing.owner}（${routing.reason}），实际为 ${meta.owner || '(空)'}`);
        }
        if (current.baseRevision !== baseRevision) {
          result.errors.push(`候选基线 ${current.baseRevision || '(空)'} 与当前基线 ${baseRevision} 不一致`);
        }
        result.errors.push(...await store.validateFullCandidate(detail.candidate));
        if (patchTouchesReviewData(detail.patchText)) {
          result.errors.push('补丁包含 .ai-review/ 自身改动');
        }
        const patchPath = path.join(detail.candidate.dirPath, current.patch);
        const applied = await vcs.applyPatch(patchPath, false);
        if (!applied.ok) result.errors.push(`补丁无法应用到当前基线：${applied.message}`);
        else this.log(`候选 ${id} 补丁可干净应用`);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        try {
          await vcs.revertBusinessWorkspace();
        } catch (error) {
          warnings.push(`校验候选 ${id} 后还原工作区失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (result.errors.length > 0) {
        this.log(`候选 ${id} 校验问题：${result.errors.join('；')}`);
      } else {
        this.log(`候选 ${id} 校验通过（${String(result.patchStats.files)} 个文件，+${String(result.patchStats.additions)}/-${String(result.patchStats.deletions)}）`);
      }
      created.push(result);
    }
    return created;
  }
}