import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { patchTouchesReviewData, gitBlobHash, type VcsAdapter } from './vcs.js';
import { auditFiles } from './audit-files.js';
import { reviewersPath } from './reviewers.js';
import { runAgent, wrapAgentPrompt } from './runner.js';
import { AuditStopUnknown } from './audit-stage-runner.js';
import { compatibleAuditBase, type StageSeal } from './audit-stage-artifacts.js';
import { captureReviewWorktree, reviewWorktreeFingerprint, scheduledGateState, scheduledPatch, undoScheduledGatePatch,
  type ReviewWorktreeState } from './scheduled-audit-vcs.js';
import { ReviewStore } from './store.js';
import type { CandidateSource } from './store.js';
import { AuditArchive, parseAuditItem, scopeCovers, serializeAuditMarkdown, type AuditFrontmatter, type AuditItem } from './audit-archive.js';
import { currentTrustedActor } from './api-context.js';
import { renderDirectAuditPrompt } from './audit-prompts.js';
import { auditRecheckPrompt, auditRecheckSection, loadAuditHistory, verifyAuditRecheck, verifyPublishedRecheck, type AuditRecheck } from './audit-history.js';
import { validateReviewData } from './review-data-validation.js';
import type { AuditLeaseRecord } from './audit-lifecycle.js';
import type {
  AppSettings,
  AuditCandidateResult,
  AuditDeferredItem,
  AuditOutcome,
  AuditReportInfo,
  PatchStats,
  ReviewDataFileValidation,
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
  return path.resolve(import.meta.dirname, '../..');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

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

/** B 类和延后项只来自报告正文，因此允许用中英文的等价标题标明这两类审查项。 */
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
    '可独立验证的修复生成候选。问题本身证据不足时仅记入覆盖说明。问题已确认但无法安全修复或无法验证修复时，交付 B 类文字方案。',
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

async function readReviewersText(
  repoRoot: string,
  owner: string,
  source?: import('./shared-facts.js').SharedCandidateSource,
): Promise<string> {
  let text: string | null = null;
  if (source) {
    text = await source.readReviewersText();
  } else {
    try {
      text = await readFile(reviewersPath(repoRoot), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (text !== null) return text.trim().slice(0, 6000);
  return [
    '# reviewers.yml 尚不存在；直接执行审查时插件会创建它。',
    `default_owner: ${JSON.stringify(owner || '')}`,
    'rules: []',
  ].join('\n');
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

export async function existingCandidateLines(
  store: ReviewStore,
  baseRevision: string,
  source?: CandidateSource,
): Promise<string> {
  try {
    const { items } = await store.list({}, baseRevision, undefined, undefined, source);
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

export async function negativeMemoryLines(
  repoRoot: string,
  source?: import('./shared-facts.js').SharedCandidateSource,
): Promise<string> {
  try {
    const store = new ReviewStore(repoRoot);
    const { loadReviewers } = await import('./reviewers.js');
    const { entryFromCandidate, topPerModule, formatMemorySummary, withinWindow } = await import('./memory.js');
    const config = await loadReviewers(repoRoot, source);
    const { items } = await store.list({}, null, undefined, undefined, source);
    const full = [];
    for (const item of items) {
      if (item.local || item.status !== 'rejected') continue;
      try {
        const record = await store.get(item.id, null, source);
        const entry = entryFromCandidate({ candidateId: item.id, meta: record.candidate.meta });
        if (entry && withinWindow(entry, config.rejectionMemoryDays, Date.now())) full.push(entry);
      } catch {
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
  mode?: 'headless' | 'session';
  /** 同一提示词里的活跃候选与负向记忆须共用此共享快照，避免引入本地草稿。 */
  source?: import('./shared-facts.js').SharedCandidateSource;
  now?: Date;
}

function readAuditDataBlock(body: string, title: '历史复查数据' | '修复方案数据'): unknown[] | undefined {
    const expression = new RegExp('^## ' + title + '[ \\t]*\\r?\\n\\s*```json[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'm');
    const raw = expression.exec(body)?.[1];
    if (raw === undefined) return undefined;
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error(title + '必须为数组');
    return data;
}

export async function buildAuditPrompt(input: BuildAuditPromptInput): Promise<string> {
  const target = await resolveAuditTarget(input.repoRoot, input.targetPath);
  const now = input.now ?? new Date();
  const reviewersText = await readReviewersText(input.repoRoot, input.owner, input.source);
  const outline = await collectOutline(input.repoRoot, target.absolutePath);
  const existing = await existingCandidateLines(new ReviewStore(input.repoRoot), input.baseRevision, input.source);
  const negativeMemory = await negativeMemoryLines(input.repoRoot, input.source);
  const findingWorkflow = currentTrustedActor()?.findingWorkflow !== false;
  const priorFindings = input.source && findingWorkflow
    ? (await loadAuditHistory(new ReviewStore(input.repoRoot), input.source, target.targetPath || '.')).protectedFindings.filter(item => item.repairPlan)
    : [];
  const month = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}`;
  const scope = target.targetPath ? `\`${target.targetPath}\`` : '全仓库';
  return renderDirectAuditPrompt({
    findingWorkflow,
    mode: input.mode ?? 'headless',
    priorFindingsJson: priorFindings.length ? JSON.stringify(priorFindings) : undefined,
    repoRoot: path.resolve(input.repoRoot),
    vcsType: input.vcsType,
    owner: input.owner,
    ownerFallback: input.owner || '当前操作者',
    scope,
    reportScope: target.targetPath || '全仓库',
    baseRevision: input.baseRevision,
    month,
    reportPath: input.reportPath,
    now: now.toISOString(),
    reviewersText,
    existing,
    negativeMemory,
    outline,
    note: input.note.trim() || '无特别关注点，按审查准则自主选择收益最高的问题。',
  });
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
  phasedItems?: AuditItem[];
  phasedSeal?: StageSeal;
  phasedGate?: (patch: string, commands: string[]) => ReturnType<typeof import('./validator.js').runGateChecks>;
  beforeCommit?: () => Promise<unknown>;
  baseRevision: string;
  targetPath: string;
  trigger: 'manual' | 'scheduled';
  runError: string | null;
  startedAt: number;
  /** 仅在本轮新建配置文件时随收尾纳入提交。 */
  reviewersCreated?: boolean;
  extraWarnings?: string[];
  now: Date;
  recheck?: AuditRecheck;
  scheduledScan?: ReviewWorktreeState;
}

export interface AuditFinalizeResult {
  dataValidation: ReviewDataFileValidation[];
  created: AuditCandidateResult[];
  deferred: AuditDeferredItem[];
  reportPath: string;
  body: string;
  commitRevision: string | null;
  status: 'COMMITTED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';
  reason?: AuditOutcome['reason'];
  detail?: string;
  warnings: string[];
  message: string;
}

function permittedScanOutputs(
    before: ReviewWorktreeState, after: ReviewWorktreeState, auditId: string, candidates: readonly string[],
): boolean {
    if (before.versionControl !== after.versionControl
        || [...before.paths].some(([entry, fingerprint]) => after.paths.get(entry) !== fingerprint)) return false;
    const reportDir = `.ai-review/audits/${auditId}`;
    const directories = new Set(['.ai-review', '.ai-review/audits', reportDir]);
    const files = new Set([`${reportDir}/audit.md`]);
    for (const id of candidates) {
        const dir = `.ai-review/${id}`;
        directories.add(dir.slice(0, dir.lastIndexOf('/')));
        directories.add(dir);
        files.add(`${dir}/review.md`);
        files.add(`${dir}/001.patch`);
    }
    return [...after.paths].every(([entry, fingerprint]) =>
        before.paths.has(entry) || (fingerprint === 'directory' ? directories.has(entry)
            : fingerprint.startsWith('["file",') && files.has(entry)));
}

function sameReviewWorktree(before: ReviewWorktreeState, after: ReviewWorktreeState): boolean {
    return before.versionControl === after.versionControl && before.paths.size === after.paths.size
        && [...before.paths].every(([entry, fingerprint]) => after.paths.get(entry) === fingerprint);
}

/** I13：使用编号中的 UTC 时刻，避免用收尾时间或机器时区生成不一致的 created_at。 */
export function auditIdToCreatedAt(auditId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(auditId);
  if (!match) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/** 跨轮相同类别和标题必须得到同一个编号，投影才能合并它们的观察。 */
export function findingIdOf(kind: 'confirm' | 'deferred', title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const hash = createHash('sha1').update(`${kind}:${normalized}`).digest('hex').slice(0, 10);
  return `f-${hash}`;
}

const MAX_TARGET_FILES = 20;
const RAW_TARGET_FILE_PATTERN =
  /(?<![\w/.-])(?:\.\/)?(?:[A-Za-z0-9._@+~-]+\/)+[A-Za-z0-9._@+~-]+\.[A-Za-z][A-Za-z0-9]{0,9}/g;

/** 提取的业务路径用于审查覆盖判定，不能把行号、链接或评审元数据当作路径。 */
function extractTargetFiles(texts: string[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    // 审查报告也可能包含 Windows 路径分隔符。
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

/** 局部审查没有目标路径时，投影无法确认覆盖，须向操作者说明漏报原因。 */
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

/** 依赖名称没有匹配时保留占位并告警，避免该延后项被提前转为候选。 */
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
    const explicit = /depends_on\s*[:：]?\s*`?([a-z0-9][a-z0-9-]{0,63})`?/i.exec(item.text);
    if (explicit?.[1]) dependsOn = explicit[1];
    for (const [title, id] of confirmIds) {
      if (!dependsOn && item.text && item.text.includes(title)) dependsOn = id;
    }
    if (!dependsOn) {
      dependsOn = findingIdOf('deferred', item.text || item.label);
      warnings.push(`Deferred 项「${item.label}」的依赖 ${dependsOn} 尚无对应 finding 观察；转换前必须证明该前置已闭合`);
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

/** 收尾不会提交无效候选，报告也不能留下指向这些未共享候选的引用。 */
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
    const resolution = /^(\|.*\|) A · ([^ |]+) \|$/.exec(line);
    if (resolution && invalid.includes(resolution[2] ?? '')) {
      out.push(resolution[1] + ' 候选未通过收尾 |');
      continue;
    }
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
  candidateSource?: import('./shared-facts.js').SharedCandidateSource;
  signal?: AbortSignal;
  lease?: AuditLeaseRecord;
  scheduledBaseMatches?: () => Promise<boolean>;
}

/** 连接审查执行器和 Host 收尾事务。执行器只产出本地审查结果，由 Host 验证后写入共享历史。 */
export class Auditor {
  constructor(private readonly deps: AuditDeps) {}

  private log(line: string): void {
    this.deps.log(line);
  }

    private async scheduledBaseSafe(base: string): Promise<boolean> {
        if (!this.deps.scheduledBaseMatches) return true;
        try {
            return await this.deps.vcs.getCurrentBase() === base && await this.deps.scheduledBaseMatches();
        } catch {
            return false;
        }
    }

  async run(): Promise<AuditOutcome> {
    const { store, vcs, settings, owner } = this.deps;
    const root = store.repoRoot;
    const lease = this.deps.lease;
    const base = lease?.trigger === 'scheduled' ? lease.baseRevision : await vcs.getCurrentBase();
    if (!base) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision）；请先提交一次再执行仓库审查。');
    }
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const target = await resolveAuditTarget(root, this.deps.targetPath);
    const now = lease ? new Date(lease.createdAt) : new Date();
    const archive = new AuditArchive(root);
    const auditId = lease?.auditId ?? await archive.nextAuditId(target.targetPath, now);
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

    const stopped = (status: 'ABORTED' | 'RECOVERY_REQUIRED', message: string, reason: AuditOutcome['reason'] = 'SYNC_STATE_UNKNOWN'): AuditOutcome => ({
        manual: false, status, auditId, created: [], deferred: [], report: null, commitRevision: null,
        baseRevision: base, targetPath: target.targetPath, warnings, message,
        ...(status === 'RECOVERY_REQUIRED' ? { reason, detail: message } : {}),
    });
    const before = new Set(lease?.candidateIdsBefore ?? await store.listCandidateIds());
    const startedAt = Date.now();
    this.log(`开始仓库审查：目标 ${target.targetPath || '全仓库'}，基线 ${base.slice(0, 12)}`);
    const systemPrompt = await loadAuditSystemPrompt();
    const runPhase = (prompt: string, label: string) => runAgent({
        kind: settings.runner === 'dsh' ? 'dsh' : 'external',
        settings,
        cwd: root,
        prompt,
        log: line => this.log(line),
        timeoutMs: Math.max(1, AUDIT_TIMEOUT_MS - (Date.now() - startedAt)),
        label,
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
    });
    let recheck: AuditRecheck | undefined;
    const history = this.deps.candidateSource
      ? await loadAuditHistory(store, this.deps.candidateSource, target.targetPath || '.', currentTrustedActor()?.findingWorkflow !== false)
      : undefined;
    if (history && (lease?.trigger === 'scheduled' || [...history.findings.values()].some(item => item.disposition !== undefined))) {
        if (!await this.scheduledBaseSafe(base)) return stopped('RECOVERY_REQUIRED', '定时审查基线或绑定已变化，需要核验现场');
        if (this.deps.signal?.aborted) return stopped('ABORTED', '定时审查在历史复查前已取消');
        const prompt = auditRecheckPrompt(history, base);
        let output = '';
        if (prompt) {
            const beforeRecheck = await reviewWorktreeFingerprint(root, vcs.type).catch(() => null);
            if (!beforeRecheck) return stopped('RECOVERY_REQUIRED', '无法核验历史复查前的评审数据状态');
            this.log('第一阶段：复查已批准候选和未闭合的 finding');
            const phase = await runPhase(prompt, '定时审查历史复查');
            if (!await this.scheduledBaseSafe(base)) return stopped('RECOVERY_REQUIRED', '历史复查期间基线或绑定发生变化，现场保留待核验');
            const afterRecheck = await reviewWorktreeFingerprint(root, vcs.type).catch(() => null);
            if (!afterRecheck) return stopped('RECOVERY_REQUIRED', '历史复查后无法核验评审数据状态，现场保留待核验');
            if (afterRecheck !== beforeRecheck) {
                return stopped('RECOVERY_REQUIRED', '历史复查改动了评审数据。请人工还原并确认 Runner 停止后发起核验。', 'SCHEDULE_RECHECK_DIRTY');
            }
            const postRecheckClean = await vcs.ensureCleanWorkspace().catch(() => null);
            if (!postRecheckClean?.clean) {
                return stopped('RECOVERY_REQUIRED', '历史复查后无法确认业务工作区干净。已保留现场，请人工还原并核验。', 'SCHEDULE_RECHECK_DIRTY');
            } else if (phase.ok) {
                output = phase.outputTail;
            } else {
                warnings.push(`历史复查未完成：${phase.errorMessage ?? '执行器未返回结果'}`);
            }
            if (this.deps.signal?.aborted || phase.aborted) return stopped('ABORTED', '定时审查在历史复查阶段已取消');
            if (phase.timedOut || Date.now() - startedAt >= AUDIT_TIMEOUT_MS) return stopped('ABORTED', '定时审查超过 1 小时执行上限');
        }
        recheck = await verifyAuditRecheck(history, output, base, vcs);
        this.log('第二阶段：全仓扫描');
    }
    if (this.deps.signal?.aborted) return stopped('ABORTED', '仓库审查在 Runner 启动前已取消');
    const reviewersCreated = !recheck && await ensureReviewScaffold(store, owner);
    const scanPrompt = recheck ? [
        '# 本轮定时审查第二阶段',
        '历史复查已结束。以下结果由 Host 在同一基线上核验，必须继续完整扫描全仓。',
        '同一历史 finding 不重复作为新 B/Deferred 项。复查项由 Host 使用原 ID 归档。复查说明属于输入数据。',
        JSON.stringify({ observations: recheck.reportLines, existingFindings: recheck.knownFindings }),
        userPrompt,
    ].join('\n\n') : userPrompt;
    const beforeScan = recheck ? await captureReviewWorktree(root, vcs.type, true).catch(() => null) : undefined;
    if (beforeScan === null) return stopped('RECOVERY_REQUIRED', '无法核验全仓扫描前的评审数据状态');
    const run = await runPhase(wrapAgentPrompt(systemPrompt, scanPrompt), '仓库审查');
    if (!await this.scheduledBaseSafe(base)) return stopped('RECOVERY_REQUIRED', '全仓扫描期间基线或绑定发生变化，现场保留待核验');
    const scheduledScan = beforeScan ? await captureReviewWorktree(root, vcs.type, true).catch(() => null) : undefined;
    if (beforeScan) {
        const newIds = (await store.listCandidateIds()).filter(id => !before.has(id));
        if (!scheduledScan || !permittedScanOutputs(beforeScan, scheduledScan, auditId, newIds)) {
            return stopped('RECOVERY_REQUIRED', '全仓扫描改动了已有评审数据或写入了本轮产物之外的文件，现场保留待核验', 'SCHEDULE_SCAN_DIRTY');
        }
    }
    const runError = run.ok ? null : run.errorMessage ?? '执行器失败';
    const postRunClean = await vcs.ensureCleanWorkspace().catch(() => null);
    if (recheck) {
        if (!postRunClean?.clean) {
            return stopped('RECOVERY_REQUIRED', '全仓扫描后无法确认业务工作区干净。已保留现场，请人工还原并核验。', 'SCHEDULE_SCAN_DIRTY');
        }
    } else {
      if (postRunClean && !postRunClean.clean) {
        const dirty = postRunClean.dirtyPaths.slice(0, 10).join(', ');
        warnings.push(`AI 结束时业务工作区仍有未还原改动，已强制还原${dirty ? `：${dirty}` : ''}`);
      }
      try {
        await vcs.revertBusinessWorkspace();
      } catch (error) {
        warnings.push(`还原业务工作区失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (runError) {
      this.log(`AI 执行失败：${runError}`);
      warnings.push(`执行器失败：${runError}`);
    } else {
      this.log('AI 执行结束（成功）');
    }
    if (beforeScan && scheduledScan && (runError || run.aborted || this.deps.signal?.aborted)) {
        const message = runError ?? '定时审查已取消';
        if (sameReviewWorktree(beforeScan, scheduledScan)) return stopped('ABORTED', message);
        return stopped('RECOVERY_REQUIRED', `${message}。全仓扫描留下评审产物，现场保留待核验`, 'SCHEDULE_SCAN_DIRTY');
    }
    const afterBase = await vcs.getCurrentBase();
    if (afterBase !== null && afterBase !== base) {
      warnings.push(`执行期间基线从 ${base.slice(0, 12)} 变为 ${afterBase.slice(0, 12)}，审查结果可能已过期`);
    }

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

    const prechecked = recheck ? undefined : await this.verifyCandidates(before, base, warnings, reviewersCreated);
    if (prechecked) this.log(`新增候选 ${String(prechecked.length)} 个，校验问题 ${String(prechecked.filter((item) => item.errors.length > 0).length)} 个`);

    const result = await this.finalize({
      auditId,
      beforeIds: before,
      baseRevision: base,
      targetPath: target.targetPath,
      trigger: lease?.trigger ?? 'manual',
      runError,
      startedAt,
      reviewersCreated,
      extraWarnings: warnings,
      now: new Date(),
      ...(recheck ? { recheck } : {}),
      ...(scheduledScan ? { scheduledScan } : {}),
    });

    const created = result.created.length ? result.created : (prechecked ?? result.created);
    if (runError && created.length === 0 && !recheck) {
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
      dataValidation: result.dataValidation,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      message: recheck && result.status !== 'COMMITTED' ? runError ?? result.message : message,
      ...(run.outputTail ? { outputTail: run.outputTail } : {}),
    };
  }

  /** 自动运行与人工收尾共用此事务。无效候选不进入共享提交，复核块须保留剔除原因。 */
  async finalize(input: AuditFinalizeInput): Promise<AuditFinalizeResult> {
    const { store, vcs } = this.deps;
    const warnings = [...(input.extraWarnings ?? [])];
    const reportPath = `.ai-review/audits/${input.auditId}/audit.md`;
    const dataValidation: ReviewDataFileValidation[] = [];
    const checkedHashes = new Map<string, string>();
    const checkFile = async (file: string): Promise<string[]> => {
      let errors: string[];
      try {
        const { bytes } = await auditFiles(store.repoRoot, { op: 'read', paths: [file] });
        if (bytes == null) throw new Error('文件不存在');
        errors = validateReviewData(file, bytes);
        if (!errors.length) checkedHashes.set(file, gitBlobHash(bytes));
      } catch (error) {
        errors = [`无法读取评审文件：${error instanceof Error ? error.message : String(error)}`];
      }
      dataValidation.push({ path: file, errors });
      return errors;
    };
    const aborted = (): AuditFinalizeResult => ({
      dataValidation,
      created: [],
      deferred: [],
      reportPath,
      body: '',
      commitRevision: null,
      status: 'ABORTED',
      warnings: [...warnings, '审查收尾已取消，未产生共享提交'],
      message: '审查收尾已取消，未产生共享提交',
    });
    const recovery = (reason: AuditFinalizeResult['reason'] = 'SYNC_STATE_UNKNOWN',
        detail = '审查收尾期间无法确认绑定、基线或工作区状态'): AuditFinalizeResult => ({
        created: [], deferred: [], reportPath, body: '', commitRevision: null, status: 'RECOVERY_REQUIRED', warnings, dataValidation,
        reason, detail, message: '审查收尾需要核验现场',
    });
    const cancelled = () => input.scheduledScan ? recovery('SCHEDULE_SCAN_DIRTY', '全仓扫描收尾已取消，现场保留待核验') : aborted();
    const gateRecovery = (detail: string) => recovery(input.scheduledScan ? 'SCHEDULE_SCAN_DIRTY' : 'SYNC_STATE_UNKNOWN', detail);
    const baseSafe = async () => await this.scheduledBaseSafe(input.baseRevision)
      && (input.scheduledScan !== undefined || await compatibleAuditBase(vcs, input.baseRevision).catch(() => false));
    const businessClean = async () => (await vcs.ensureCleanWorkspace().catch(() => null))?.clean === true;
    if (this.deps.signal?.aborted) return cancelled();
    if (!await baseSafe() || !await businessClean()) {
      return recovery('SYNC_STATE_UNKNOWN', '审查收尾前基线或业务工作区发生变化，现场保留待核验');
    }
    const archive = new AuditArchive(store.repoRoot);
    let body: string | null;
    try {
      body = await archive.readDraft(input.auditId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dataValidation.push({ path: reportPath, errors: [detail] });
      return recovery('SYNC_STATE_UNKNOWN', '无法安全读取审查报告，现场保留待核验');
    }
    const created = await this.verifyCandidates(input.beforeIds, input.baseRevision, warnings, input.reviewersCreated === true, checkFile);
    this.log(`收尾：新增候选 ${String(created.length)} 个，校验问题 ${String(created.filter((item) => item.errors.length > 0).length)} 个`);

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

    // G42：配置启用时，先在临时应用补丁的工作区复算门禁。
    const { loadReviewers } = await import('./reviewers.js');
    const { runGateChecks } = await import('./validator.js');
    const reviewersConfig = await loadReviewers(store.repoRoot, this.deps.candidateSource);
    const gateMode: 'none' | 'smoke' | 'declared' = reviewersConfig.verifyGateOnAuditFinalize;
    if (gateMode === 'smoke' && reviewersConfig.auditSmokeCommands.length === 0) {
      warnings.push('verify_gate_on_audit_finalize=smoke 但 audit_smoke_commands 为空；相关候选不得提交');
      for (const candidate of created) {
        if (candidate.errors.length === 0) candidate.errors.push('smoke 模式必须配置非空 audit_smoke_commands');
      }
    }
    const gateRechecked: string[] = [];
    if (gateMode !== 'none') {
      for (const candidate of created) {
        if (candidate.errors.length > 0) continue;
        this.log(`收尾门禁复算：候选 ${candidate.id}（${gateMode}）`);
        let gatePatch: { path: string; targetFiles: string[]; appliedState: string; base: string; hash: string } | undefined;
        let applying = false;
        try {
          const detail = await store.get(candidate.id, null);
          const current = detail.candidate.meta.revisions.find((revision) => revision.id === detail.candidate.meta.currentRevision);
          if (!current) continue;
          const patchPath = path.join(detail.candidate.dirPath, current.patch);
          const targetFiles = detail.candidate.meta.targetFiles;
          const commands = gateMode === 'smoke' ? reviewersConfig.auditSmokeCommands : detail.candidate.meta.gateChecks;
          if (input.phasedItems) {
            if (!input.phasedGate) throw new Error('缺少受限门禁环境');
            const report = await input.phasedGate(patchPath, commands);
            if (report.allPassed) gateRechecked.push(candidate.id);
            else candidate.errors.push('收尾门禁（' + gateMode + '）未通过：\n' + report.formattedEvidenceMarkdown);
            continue;
          }
          if (input.scheduledScan) {
            const review = await captureReviewWorktree(store.repoRoot, vcs.type, true);
            if (!sameReviewWorktree(input.scheduledScan, review)) {
              return recovery('SCHEDULE_SCAN_DIRTY', '门禁应用补丁前工作区状态发生变化，现场保留待核验');
            }
          }
          if (!await baseSafe() || !await businessClean()) {
            return gateRecovery('门禁应用补丁前基线或业务工作区发生变化，现场保留待核验');
          }
          const cleanBase = await vcs.getCurrentBase();
          if (!cleanBase) return recovery();
          const relativePatch = `.ai-review/${candidate.id}/${current.patch}`;
          const { entries } = await auditFiles(store.repoRoot, { op: 'snapshot', paths: [relativePatch] });
          const patchHash = entries?.[0]?.blobHash;
          if (!patchHash) return recovery();
          applying = true;
          const applied = await scheduledPatch(vcs, patchPath, false);
          if (!applied.ok) {
            if (input.scheduledScan || !await businessClean()) return gateRecovery('无法确认门禁补丁已完整应用，现场保留待核验');
            candidate.errors.push(`收尾门禁：补丁无法应用——${applied.message}`);
            continue;
          }
          if (await vcs.getCurrentBase() !== cleanBase) return recovery();
          gatePatch = { path: patchPath, targetFiles, appliedState: await scheduledGateState(vcs, targetFiles), base: cleanBase, hash: patchHash };
          const report = await runGateChecks(commands, {
            cwd: store.repoRoot,
            baseRevision: input.baseRevision,
            timeoutMs: this.deps.settings.gateTimeoutMs,
            onLine: (line: string, _stream: 'stdout' | 'stderr', command: string) => {
              if (line.trim()) this.log(`  [${candidate.id}] ${command.slice(0, 80)}: ${line.slice(0, 300)}`);
            },
            ...(this.deps.signal ? { signal: this.deps.signal } : {}),
          });
          if (!report.allPassed) {
            candidate.errors.push(`收尾门禁（${gateMode}）未通过：\n${report.formattedEvidenceMarkdown}`);
          } else {
            gateRechecked.push(candidate.id);
          }
        } catch (error) {
          if (input.phasedItems && (error instanceof AuditStopUnknown || this.deps.signal?.aborted)) return recovery();
          if (applying && !gatePatch) return gateRecovery('无法核验门禁应用的补丁，现场保留待核验');
          candidate.errors.push(`收尾门禁执行异常：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!await baseSafe()) return recovery();
        if (gatePatch) {
          const worktree = await scheduledGateState(vcs, gatePatch.targetFiles).catch(() => null);
          const relativePatch = path.relative(store.repoRoot, gatePatch.path).split(path.sep).join('/');
          const patch = await auditFiles(store.repoRoot, { op: 'snapshot', paths: [relativePatch] }).catch(() => null);
          if (worktree !== gatePatch.appliedState || await vcs.getCurrentBase() !== gatePatch.base
            || patch?.entries?.[0]?.blobHash !== gatePatch.hash) {
            return gateRecovery('门禁期间出现本轮补丁以外的工作区改动，现场保留待核验');
          }
          if (input.scheduledScan) {
            const review = await captureReviewWorktree(store.repoRoot, vcs.type, true).catch(() => null);
            if (!review || !sameReviewWorktree(input.scheduledScan, review)) {
              return recovery('SCHEDULE_SCAN_DIRTY', '门禁期间评审数据发生变化，现场保留待核验');
            }
          }
          const undone = await undoScheduledGatePatch(vcs, gatePatch.path, gatePatch.targetFiles).catch(() => false);
          if (!undone || !await businessClean()) {
            return gateRecovery('无法完整还原门禁的补丁，现场保留待核验');
          }
        }
      }
    }
    if (!await baseSafe() || !await businessClean()) return recovery();
    if (input.scheduledScan) {
        const afterChecks = await captureReviewWorktree(store.repoRoot, vcs.type, true).catch(() => null);
        if (!afterChecks || !sameReviewWorktree(input.scheduledScan, afterChecks)) {
            return recovery('SCHEDULE_SCAN_DIRTY', '候选核验期间评审数据发生变化，现场保留待核验');
        }
    }
    if (this.deps.signal?.aborted) return cancelled();
    if (!input.recheck && this.deps.candidateSource && currentTrustedActor()?.findingWorkflow !== false) {
      try {
        const results = readAuditDataBlock(body, '历史复查数据');
        if (results) {
          const history = await loadAuditHistory(store, this.deps.candidateSource, input.targetPath || '.');
          input.recheck = await verifyPublishedRecheck(history, results, input.baseRevision, vcs);
        }
      } catch (error) {
        warnings.push(`历史复查数据无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (input.recheck) {
        const sections = body.split(/(?=^##[ \t])/m).filter(section => !/^##[^\r\n]*历史[^\r\n]*复查/.test(section));
        body = `${sections.join('').trimEnd()}\n\n${auditRecheckSection(input.recheck)}\n`;
    }
    let reportedItems = input.phasedItems;
    if (!reportedItems && currentTrustedActor()?.findingWorkflow !== false) {
      try {
        const parsed = readAuditDataBlock(body, '修复方案数据');
        if (parsed) {
          const proposed = parsed.map((item, index) => parseAuditItem(item, index, 2));
          if (proposed.some(item => item.status !== 'pending' || !item.repairPlan || (item.kind === 'repair') !== Boolean(item.options))) {
            throw new Error('审查产物只能发布含修复方案的待审核发现');
          }
          reportedItems = proposed;
        }
      } catch (error) {
        warnings.push(`修复方案数据无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (reportedItems?.some(item => item.options) && this.deps.candidateSource) {
      const history = await loadAuditHistory(store, this.deps.candidateSource);
      const pendingDependencies = new Map(history.protectedFindings.filter(item =>
        item.kind === 'deferred' && item.dependsOn && !history.closedFindingIds.has(item.dependsOn))
        .map(item => [item.findingId, item.dependsOn]));
      reportedItems = reportedItems.map(item => {
        const dependency = pendingDependencies.get(item.findingId);
        if (!item.options || !dependency) return item;
        const { options: _options, ...plan } = item;
        warnings.push(`发现 ${item.findingId} 的前置依赖尚未关闭，保留为文字方案`);
        return { ...plan, kind: 'deferred', dependsOn: dependency };
      });
    }
    const scope = input.targetPath || '.';
    reportedItems = reportedItems?.filter(item => {
      if ((item.repairPlan === undefined && item.kind !== 'repair') || scopeCovers(scope, item.targetFiles)) return true;
      warnings.push(`发现 ${item.findingId} 超出本轮审查范围，未发布`);
      return false;
    });
    const declaredOptions = new Map(reportedItems?.flatMap(item => (item.options ?? []).map(option => [option.candidateId, item.findingId] as const)));
    for (const result of created) {
      if (result.errors.length) continue;
      const candidate = (await store.get(result.id, null)).candidate;
      if (candidate.meta.findingId !== declaredOptions.get(result.id)) result.errors.push('候选与发现归属不匹配');
      if (candidate.meta.findingId && !scopeCovers(scope, candidate.meta.targetFiles)) result.errors.push('新版候选补丁超出本轮审查范围');
    }
    const validAfterGates = created.filter((item) => item.errors.length === 0).map((item) => item.id);
    // 须等复算结束再生成复核块，以记录被门禁淘汰的候选。
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
    let items = (reportedItems ?? buildAuditItems(deferredItems, warnings, input.targetPath || '.')).map(item => {
      if (!item.options) return item;
      const options = item.options.filter(option => validAfterGates.includes(option.candidateId));
      if (options.length > 0) return { ...item, options };
      const { options: _removed, ...textPlan } = item;
      return { ...textPlan, kind: 'confirm' as const };
    });
    if (input.recheck) {
        const historicalIds = new Set(input.recheck.knownFindings.flatMap(item =>
            item.kind === 'repair' ? [item.findingId] : [item.findingId, findingIdOf(item.kind, item.title)]));
        const published = [...new Map(items.filter(item => item.repairPlan !== undefined || !historicalIds.has(item.findingId))
          .map(item => [item.findingId, item])).values()];
        const ids = new Set(published.map(item => item.findingId));
        items = [...published, ...input.recheck.observations.filter(item => !ids.has(item.findingId))];
    }
    const createdAt = auditIdToCreatedAt(input.auditId);
    const previous = input.recheck ? input.recheck.previousAudit : (await archive.list())
      .filter((record) => !record.parseError && record.meta.auditId !== input.auditId)
      .map((record) => record.meta.auditId)
      .sort()
      .pop() ?? null;
    const reviewersCreated = input.scheduledScan ? await ensureReviewScaffold(store, this.deps.owner) : input.reviewersCreated;
    const rejected = (message: string): AuditFinalizeResult => ({
      created,
      deferred: deferredItems,
      reportPath,
      body: bodyWithGateNote,
      commitRevision: null,
      status: 'ABORTED',
      dataValidation,
      warnings,
      message,
    });
    const auditMeta: AuditFrontmatter = {
      schemaVersion: input.recheck?.versioned || items.some(item => item.kind === 'repair' || item.repairPlan !== undefined || item.repairRevisions !== undefined) ? 2 : 1,
      auditId: input.auditId,
      createdAt,
      baseRevision: input.baseRevision,
      scope: input.targetPath || '.',
      trigger: input.trigger,
      previousAudit: previous,
      candidates: validAfterGates,
      items,
    };
    try {
      await archive.writeExisting(auditMeta, bodyWithGateNote);
    } catch (error) {
      dataValidation.push({ path: reportPath, errors: [error instanceof Error ? error.message : String(error)] });
      return rejected('无法生成正式审查档案，未提交本轮产物');
    }
    if ((await checkFile(reportPath)).length > 0) {
      return rejected('正式审查档案校验失败，未提交本轮产物');
    }
    this.log(`审查档案：${reportPath}（B/Deferred ${String(items.length)} 项；${gateNote}）`);

    const commitPaths = [
      ...(input.phasedItems ? [reportPath, ...validAfterGates.flatMap(id => [
        '.ai-review/' + id + '/review.md', '.ai-review/' + id + '/001.patch',
      ])] : [`.ai-review/audits/${input.auditId}`, ...validAfterGates.map(id => `.ai-review/${id}`)]),
      ...(reviewersCreated ? ['.ai-review/reviewers.yml'] : []),
    ];
    let commitRevision: string | null = null;
    let status: AuditFinalizeResult['status'];
    let recoveryReason: AuditFinalizeResult['reason'];
    let recoveryDetail: string | undefined;
    if (validAfterGates.length > 0 || input.runError === null) {
      if (this.deps.signal?.aborted) return cancelled();
      const scopeLabel = input.targetPath || 'repo';
      // SVN 档案目录的修订号不随子文件更新，探针须包含 audit.md。
      const probePaths = [reportPath, ...validAfterGates.map((id) => `.ai-review/${id}`)];
      const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
      // 提交目录前校验展开后的完整文件集合，防止夹带未验证内容。
      const snapshot = await auditFiles(store.repoRoot, { op: 'snapshot', paths: commitPaths }).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        dataValidation.push({ path: reportPath, errors: [detail] });
        return null;
      });
      if (!snapshot?.entries) return rejected('无法安全读取收尾提交范围，未提交本轮产物');
      const { entries: commitEntries } = snapshot;
      if (input.phasedItems) {
        const expectedReport = gitBlobHash(serializeAuditMarkdown(auditMeta, bodyWithGateNote));
        if (!input.phasedSeal || commitEntries.length !== commitPaths.length || commitEntries.some(entry =>
          entry.blobHash !== (entry.path === reportPath ? expectedReport : input.phasedSeal![entry.path]))) {
          return recovery('SYNC_STATE_UNKNOWN', '收尾提交快照与本轮封存内容不符');
        }
      }
      const entriesByPath = new Map(commitEntries.map((entry) => [entry.path, entry.blobHash]));
      const checkedFiles = [reportPath, ...validAfterGates.map((id) => `.ai-review/${id}/review.md`)];
      const changedFiles = checkedFiles.filter((file) => !checkedHashes.has(file) || checkedHashes.get(file) !== entriesByPath.get(file));
      if (changedFiles.length > 0) {
        for (const file of changedFiles) {
          dataValidation.find((entry) => entry.path === file)?.errors.push('校验后文件内容发生变化或文件已移除');
        }
        return rejected('收尾文件在校验后发生变化，未提交本轮产物');
      }
      if (!await baseSafe() || !await businessClean()) return recovery();
      if (this.deps.signal?.aborted) return cancelled();
      await input.beforeCommit?.();
      if (this.deps.signal?.aborted) return cancelled();
      const commit = await vcs.atomicCommit({
        message: `audit(${scopeLabel}): 仓库审查生成 ${String(created.length)} 个候选${created.length === 0 ? '（仅报告）' : ''} [skip ci]`,
        paths: commitPaths,
        verifyEntries: commitEntries,
      });
      if (commit.verificationFailed) {
          commitRevision = commit.commitRevision;
          status = 'RECOVERY_REQUIRED';
          recoveryReason = 'COMMIT_OUTCOME_UNKNOWN';
          recoveryDetail = commit.errorOutput;
          warnings.push(`收尾提交已执行但完整核验失败，现场保留待人工核对：${commit.errorOutput}`);
      } else if (commit.success) {
        commitRevision = commit.commitRevision;
        this.log(`已提交审查收尾：${commitRevision?.slice(0, 12) ?? '(无版本号)'}`);
        status = created.some((item) => item.errors.length > 0) ? 'VALIDATION_FAILED' : 'COMMITTED';
      } else {
        const probeAfter = await vcs.getCommitProbe(probePaths).catch(() => null);
        let landed = false;
        if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
          let complete = true;
          const actualPaths = await vcs.listCommitPaths?.(probeAfter);
          const expectedSet = new Set(commitEntries.map((entry) => entry.path));
          if (!actualPaths || actualPaths.length !== expectedSet.size || actualPaths.some((item) => !expectedSet.has(item))) {
            complete = false;
          }
          for (const entry of commitEntries) {
            const actual = await vcs.readFileAt(probeAfter, entry.path).catch(() => null);
            if (actual === null || gitBlobHash(actual) !== entry.blobHash) complete = false;
          }
          landed = complete;
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
          const after = await auditFiles(store.repoRoot, { op: 'snapshot', paths: commitPaths }).catch(() => null);
          if (!after || JSON.stringify(after.entries) !== JSON.stringify(commitEntries)) {
            return recovery('SYNC_STATE_UNKNOWN', '提交失败后本轮产物发生变化，现场保留待核验');
          }
          try {
            await commit.restorePreparation?.();
            const removePaths = reviewersCreated && !input.scheduledScan
              ? commitPaths.filter(file => file !== '.ai-review/reviewers.yml') : commitPaths;
            const removeEntries = commitEntries.filter(entry => removePaths.some(file => entry.path === file || entry.path.startsWith(`${file}/`)));
            await auditFiles(store.repoRoot, { op: 'remove', paths: removePaths, entries: removeEntries });
          } catch {
            return recovery('SYNC_STATE_UNKNOWN', '提交失败后无法完整清理本轮产物，现场保留待核验');
          }
          status = 'ABORTED';
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
      dataValidation,
      commitRevision,
      status,
      ...(recoveryReason ? { reason: recoveryReason } : {}),
      ...(recoveryDetail ? { detail: recoveryDetail } : {}),
      warnings,
      message,
    };
  }

  private async verifyCandidates(
    before: Set<string>,
    baseRevision: string,
    warnings: string[],
    allowNewReviewers = false,
    checkFile?: (file: string) => Promise<string[]>,
  ): Promise<AuditCandidateResult[]> {
    const { store, vcs } = this.deps;
    const scheduled = this.deps.lease?.trigger === 'scheduled';
    const { loadReviewers, resolveOwner } = await import('./reviewers.js');
    let reviewers = await loadReviewers(store.repoRoot, this.deps.candidateSource);
    if (allowNewReviewers && this.deps.candidateSource && await this.deps.candidateSource.readReviewersText() === null) {
      reviewers = await loadReviewers(store.repoRoot);
    }
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
        if (checkFile) {
          const errors = await checkFile(`.ai-review/${id}/review.md`);
          if (errors.length) throw new Error(errors.join('；'));
        }
        await auditFiles(store.repoRoot, { op: 'snapshot', paths: [`.ai-review/${id}`] });
        const detail = await store.get(id, baseRevision);
        if (detail.candidate.parseError) throw new Error(detail.candidate.parseError);
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
        const routing = resolveOwner(reviewers, { paths: meta.targetFiles, tags: meta.tags });
        const expectedOwner = routing.owner || (scheduled ? this.deps.owner : '');
        if (!expectedOwner) {
          result.errors.push('reviewers.yml 未配置 default_owner，无法完成 owner 路由复核');
        } else if (meta.owner !== expectedOwner) {
          result.errors.push(`owner 应为 ${expectedOwner}（${routing.reason}），实际为 ${meta.owner || '(空)'}`);
        }
        if (current.baseRevision !== baseRevision) {
          result.errors.push(`候选基线 ${current.baseRevision || '(空)'} 与当前基线 ${baseRevision} 不一致`);
        }
        result.errors.push(...await store.validateFullCandidate(detail.candidate));
        if (patchTouchesReviewData(detail.patchText)) {
          result.errors.push('补丁包含 .ai-review/ 自身改动');
        }
        const patchPath = path.join(detail.candidate.dirPath, current.patch);
        const applied = await scheduledPatch(vcs, patchPath, true);
        if (!applied.ok) result.errors.push(`补丁无法应用到当前基线：${applied.message}`);
        else this.log(`候选 ${id} 补丁可干净应用`);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
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
