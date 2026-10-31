import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { patchTouchesReviewData, type VcsAdapter } from './vcs.js';
import { reviewersPath } from './reviewers.js';
import { runAgent, wrapAgentPrompt } from './runner.js';
import { ReviewStore } from './store.js';
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
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = (targetPath || 'repo')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'repo';
  return `.ai-review/audits/${stamp}-${slug}.md`;
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

async function existingCandidateLines(store: ReviewStore, baseRevision: string): Promise<string> {
  try {
    const { items } = await store.list({}, baseRevision);
    const active = items.filter((item) => item.status === 'pending' || item.status === 'changes_requested');
    if (active.length === 0) return '- 无待处理候选。';
    return active
      .slice(0, 40)
      .map((item) => `- ${item.id}：${item.title}（${item.status}，owner ${item.owner}）`)
      .join('\n');
  } catch {
    return '- （无法读取现有候选；请自行检查 .ai-review/）';
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
  now?: Date;
}

/** Build the user prompt for one repository audit. Pure apart from reading repo context. */
export async function buildAuditPrompt(input: BuildAuditPromptInput): Promise<string> {
  const target = await resolveAuditTarget(input.repoRoot, input.targetPath);
  const now = input.now ?? new Date();
  const reviewersText = await readReviewersText(input.repoRoot, input.owner);
  const outline = await collectOutline(input.repoRoot, target.absolutePath);
  const existing = await existingCandidateLines(new ReviewStore(input.repoRoot), input.baseRevision);
  const month = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}`;
  const scope = target.targetPath ? `\`${target.targetPath}\`` : '全仓库';
  const sessionMode = input.mode === 'session';
  const auditCommit = input.vcsType === 'svn'
    ? '`svn add --force --parents .ai-review` + `svn commit -m "audit(<scope>): 仓库审查生成 N 个候选 [skip ci]" .ai-review`'
    : '`git add -A -- .ai-review` + `git commit -m "audit(<scope>): 仓库审查生成 N 个候选 [skip ci]"`';
  const commitRule = sessionMode
    ? `5. 本会话由用户直接驱动：完成全部候选后，只提交 \`.ai-review\`（${auditCommit}），绝不能提交业务代码；提交前用 \`${input.vcsType === 'svn' ? 'svn status' : 'git status'}\` 确认业务工作区干净。`
    : '5. 严禁执行 `git commit` / `svn commit`。结束前 `git status` / `svn status` 除 `.ai-review/` 外必须干净，不得在业务工作区留下未导出的改动或临时文件。';
  const completionRule = sessionMode
    ? '10. 完成时用简体中文输出最终摘要：新增候选、B/Deferred、报告路径、`.ai-review` 提交号（如有）。'
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
      '- 在关键节点输出简短进度：建立地图、候选 N 已生成、验证结果、收尾提交；不要只埋头执行。',
      '- 不要中途等待用户确认；遇到 B 类或需要人工拍板的事项，写入审查报告后继续。',
      '- 完成全部候选后，按下方规则只提交 `.ai-review`，不要提交业务代码。',
      '',
    ] : []),
    '## 硬性执行规则',
    '1. 所有候选必须**完全独立地基于当前基线**，严禁生成需要按顺序打补丁的依赖链。每导出一个候选的 `001.patch` 后，必须立即把业务工作区还原到基线，再处理下一个问题。',
    '2. 一个问题一个候选目录，目录名为 `YYYYMMDD-<module>-<short-slug>`，放在 `.ai-review/' + month + '/` 下；`<module>` 与 `<short-slug>` 只能使用 ASCII 字母、数字、`.`、`_`、`-`（禁止中文、空格、斜杠），中文语义写入 review.md 的 title。同一函数/结构体内强耦合的清理可合并进同一个本质修复。',
    '3. A 类必须：真正修改代码 → 实际运行 `gate_checks` 中的全部命令 → 导出 UTF-8/LF 全量 unified diff 到 `001.patch`（不得包含 `.ai-review/` 自身）→ 生成 review.md → 还原业务工作区。验证无法收敛时回滚，并降级为 B 类。',
    '4. B 类：不修改代码，只写入审查报告；不要为 B 类创建候选目录。若改动 B 强依赖某个大改动 A 先合入主干，把 B 写入“待前置合入后处理（Deferred）”。',
    commitRule,
    '6. 审查报告必须最后写入上述报告文件，结构见下节。报告是插件解析 B 类与 Deferred 清单的唯一来源，请严格使用指定标题和列表格式。',
    '7. 如果没有 A 类问题，报告 A 类写“无”，不要为了凑数生成候选；如果所有候选都验证失败，也不要留下半成品目录。',
    '8. review.md 的 `gate_checks` 每条都必须实际运行并通过；`# 需人工判断项` 即使无风险也要写一条“无：...”说明。',
    '9. 补丁生成方式：Git 使用 `git diff <base_revision> --binary`（新增业务文件先 `git add -N <文件>`，绝不能把 `.ai-review/` 加入索引）；SVN 在工作区为对应 revision 时使用 `svn diff`。',
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

async function ensureReviewScaffold(store: ReviewStore, owner: string): Promise<void> {
  const aiRoot = path.join(store.repoRoot, '.ai-review');
  await mkdir(path.join(aiRoot, 'audits'), { recursive: true });
  const file = reviewersPath(store.repoRoot);
  if (!existsSync(file)) {
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
  }
}

function relativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll('\\', '/');
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

async function findRecentReport(repoRoot: string, since: number): Promise<string | null> {
  const dir = path.join(repoRoot, '.ai-review', 'audits');
  let entries: string[] = [];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of entries) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < since) continue;
    if (!best || info.mtimeMs > best.mtime) best = { file, mtime: info.mtimeMs };
  }
  return best?.file ?? null;
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
    const reportPath = auditReportPath(target.targetPath, now);
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
    });
    const warnings: string[] = [];

    if (settings.runner === 'manual') {
      this.log('手动模式：已生成仓库审查提示词，未修改仓库。');
      return {
        manual: true,
        prompt: wrapAgentPrompt(await loadAuditSystemPrompt(), userPrompt),
        created: [],
        deferred: [],
        report: null,
        commitRevision: null,
        baseRevision: base,
        targetPath: target.targetPath,
        warnings,
        message: '已生成仓库审查提示词。请在任意外部 Agent 中执行，完成后刷新队列。',
      };
    }

    await ensureReviewScaffold(store, owner);
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

    const created = await this.verifyCandidates(before, base, warnings);
    this.log(`新增候选 ${String(created.length)} 个，校验问题 ${String(created.filter((item) => item.errors.length > 0).length)} 个`);

    const report = await this.writeReport({
      requestedPath: reportPath,
      startedAt,
      baseRevision: base,
      targetPath: target.targetPath,
      created,
      warnings,
      runError,
      now: new Date(),
    });

    let commitRevision: string | null = null;
    if (created.length > 0 || runError === null) {
      const commit = await vcs.atomicCommit({
        message: `audit(${target.targetPath || 'repo'}): 仓库审查生成 ${String(created.length)} 个候选${created.length === 0 ? '（仅报告）' : ''} [skip ci]`,
        paths: ['.ai-review'],
      });
      if (commit.success) {
        commitRevision = commit.commitRevision;
        this.log(`已提交 .ai-review 审查结果：${commitRevision?.slice(0, 12) ?? '(无版本号)'}`);
      } else {
        const warning = `提交 .ai-review 失败：${commit.errorOutput}`;
        warnings.push(warning);
        this.log(warning);
      }
    } else {
      this.log('执行失败且没有新增候选，未提交 .ai-review');
    }

    if (runError && created.length === 0) {
      throw new Error(`${runError}${report ? `；审查报告：${report.path}` : ''}`);
    }

    const message = created.length > 0
      ? `仓库审查完成：新增 ${String(created.length)} 个候选${created.filter((item) => item.errors.length > 0).length > 0 ? '（部分需修复）' : ''}${commitRevision ? '，已提交 .ai-review' : '，但 .ai-review 提交失败'}；B/Deferred ${String(report?.deferred.length ?? 0)} 项见报告`
      : `仓库审查完成：未生成 A 类候选${report ? `，审查报告：${report.path}` : ''}`;
    this.log(message);
    return {
      manual: false,
      created,
      deferred: report?.deferred ?? [],
      report,
      commitRevision,
      baseRevision: base,
      targetPath: target.targetPath,
      warnings,
      message,
      ...(run.outputTail ? { outputTail: run.outputTail } : {}),
    };
  }

  private async verifyCandidates(
    before: Set<string>,
    baseRevision: string,
    warnings: string[],
  ): Promise<AuditCandidateResult[]> {
    const { store, vcs } = this.deps;
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
        if (current.baseRevision !== baseRevision) {
          result.errors.push(`候选基线 ${current.baseRevision || '(空)'} 与当前基线 ${baseRevision} 不一致`);
        }
        result.errors.push(...await store.validateCandidate(detail.candidate));
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

  private async writeReport(input: {
    requestedPath: string;
    startedAt: number;
    baseRevision: string;
    targetPath: string;
    created: AuditCandidateResult[];
    warnings: string[];
    runError: string | null;
    now: Date;
  }): Promise<AuditReportInfo | null> {
    const root = this.deps.store.repoRoot;
    let reportPath = input.requestedPath;
    let absolute = path.join(root, reportPath);
    let text = await readFile(absolute, 'utf8').catch(() => null);
    if (text === null) {
      const found = await findRecentReport(root, input.startedAt - 2000);
      if (found) {
        absolute = found;
        reportPath = relativePath(root, found);
        text = await readFile(absolute, 'utf8').catch(() => null);
      }
    }
    if (text === null) {
      text = fallbackReport({
        baseRevision: input.baseRevision,
        targetPath: input.targetPath,
        created: input.created,
        runError: input.runError,
        now: input.now,
      });
      input.warnings.push('AI 未写入审查报告，已生成插件回退报告');
      this.log(`AI 未写入审查报告，已生成插件回退报告：${reportPath}`);
    }
    const deferred = parseAuditReport(text).deferred;
    const block = renderVerificationBlock({
      created: input.created,
      warnings: input.warnings,
      runError: input.runError,
      now: input.now,
      baseRevision: input.baseRevision,
      targetPath: input.targetPath,
    });
    const finalText = upsertVerificationBlock(text, block);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, finalText, 'utf8');
    this.log(`审查报告：${reportPath}（B/Deferred ${String(deferred.length)} 项）`);
    return { path: reportPath, text: finalText, deferred };
  }
}
