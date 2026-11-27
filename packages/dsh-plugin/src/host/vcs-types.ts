/**
 * VCS 适配层公共类型与底层原语：
 * 定义 VcsAdapter 契约、Git/SVN 共享工具（受控进程执行、逐文件 lstat 核对、路径归一化与审批快照识别）。
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseReviewMarkdown } from './frontmatter.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import { runProcess, type ProcessResult } from './shell.js';
import type {
  ApplyPatchResult,
  ApprovalCommitLookup,
  ApprovalInfo,
  AuthorStatBucket,
  AuthorStats,
  InterRevisionDiff,
  VcsType,
} from './types.js';

export const VCS_TIMEOUT_MS = 180_000;
const IGNORED_PREFIXES = ['.ai-review/'];

export interface DiffInput {
  fromRevision: number;
  toRevision: number;
  fromBase: string;
  toBase: string;
  fromPatchPath: string;
  toPatchPath: string;
  fromPatchText: string;
  toPatchText: string;
}

export interface ExpectedCommitEntry {
  /** 仓库相对路径，使用正斜杠。 */
  path: string;
  /** 以已审核的原始字节计算，Git clean filter 的变换不计入。 */
  blobHash: string;
  /** 平台不跟踪文件模式时忽略。 */
  mode?: string;
}

export interface CommitInput {
  message: string;
  /** 接受绝对路径或仓库相对路径。 */
  paths: string[];
  deletePaths?: string[];
  /** 提供核对条目时，授权路径下未列入清单的额外文件也会导致提交被拒绝。 */
  verifyEntries?: ExpectedCommitEntry[];
  verifyDeletions?: string[];
  gitTarget?: GitApprovalTarget;
}

export interface GitApprovalTarget {
  ref: string;
  base: string;
}

export interface CommitResult {
  success: boolean;
  commitRevision: string | null;
  outOfDate: boolean;
  errorOutput: string;
  verificationFailed?: boolean;
  targetChanged?: boolean;
  /** 只有调用方证实提交未落地后，才可撤销本次准备状态。 */
  restorePreparation?: () => Promise<void>;
}

export interface CleanResult {
  clean: boolean;
  dirtyPaths: string[];
  message: string;
}

export interface SyncResult {
  base: string | null;
  synced: boolean;
  message: string;
  /** 可安全恢复的同步失败。无上游而主动跳过时不会置位。 */
  failed?: boolean;
  /** 基线状态无法证明，调用方应保留现场等待人工核对。 */
  uncertain?: boolean;
}

export interface ApprovalDeriveInput {
  reviewPath: string;
  patchPaths: string[];
  targetFiles: string[];
  /** 已批准方案补丁实际修改的业务路径；若提供则优先作为业务触达核验集合。 */
  approvedPatchPaths?: string[];
  approval?: ApprovalInfo;
}

export interface ModeCTopologyCheck {
  ok: boolean;
  preHead: string;
  postHead: string;
  netChangedPaths: string[];
  mergedParents: string[];
  commitCount: number;
  aiReviewTouched: boolean;
  diagnostic?: string;
}

export type ApprovalPatchAttempt = ApplyPatchResult & {
  workspace: 'untouched' | 'applied' | 'unknown';
  canMerge?: boolean;
  restore?: () => Promise<void>;
};

export type RemoteTipResult =
  | { ok: true; remote: { remoteRef: string; tip: string } | null }
  | { ok: false; error: string };

export type RemoteRefTipsResult =
  | { ok: true; tips: Map<string, string>; hasRemotes: boolean }
  | { ok: false; error: string };

export interface VcsAdapter {
  readonly type: VcsType;
  readonly root: string;
  ensureCleanWorkspace(): Promise<CleanResult>;
  syncAndGetLatestBase(): Promise<SyncResult>;
  getCurrentBase(): Promise<string | null>;
  getApprovalTarget?(): Promise<GitApprovalTarget | null>;
  getCurrentBranch?(): Promise<string | null>;
  getRemoteTip?(branch?: string): Promise<RemoteTipResult>;
  listAllRefTips?(): Promise<Map<string, string>>;
  listRemoteRefTips?(): Promise<RemoteRefTipsResult>;
  commitExists?(revision: string): Promise<boolean>;
  checkoutBranch?(branch: string): Promise<void>;
  hasActiveGitOperation?(): Promise<boolean>;
  getTreeHash?(revision?: string): Promise<string | null>;
  isAncestor?(ancestor: string, descendant: string): Promise<boolean>;
  computeModeCNetChangedPaths?(preHead: string, postHead: string, trustedUpstreamTips?: readonly string[]): Promise<ModeCTopologyCheck>;
  resetHard?(revision: string, options?: { includeAiReview?: boolean }): Promise<void>;
  amendCommitWithReview?(input: { reviewPath: string; expectedReviewBlob: string; message: string }): Promise<CommitResult>;
  collapseLocalCommitsWithReview?(input: {
    preHead: string;
    mergedParents: string[];
    reviewPath: string;
    expectedReviewBlob: string;
    message: string;
  }): Promise<CommitResult>;
  /** 相关提交落地时探针必须变化。返回 null 时，调用方无法据此确定提交结果。 */
  getCommitProbe(paths: string[]): Promise<string | null>;
  getRemoteCommitProbe?(path: string): Promise<string | null>;
  readFileAt(revision: string, relPath: string): Promise<string | null>;
  listCommitPaths?(revision: string): Promise<string[] | null>;
  applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult>;
  applyPatchForApproval?(patchPath: string, signal?: AbortSignal): Promise<ApprovalPatchAttempt>;
  exportWorkingTreeDiff(base: string, paths: string[]): Promise<string>;
  revertBusinessWorkspace(): Promise<void>;
  /** 在 Mode C 篡改 .ai-review/ 时同步还原整个工作区（含 .ai-review/）至 preHead。 */
  revertAllToPreHead?(preHead: string, includeAiReview: boolean): Promise<void>;
  computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff>;
  atomicCommit(input: CommitInput): Promise<CommitResult>;
  checkPatch(patchPath: string): Promise<ApplyPatchResult>;
  /**
   * 排除 .ai-review/，避免评论和状态变更推进 VCS 版本时误判业务基线已变化。
   * 返回 null 表示无法判断，空数组才表示业务内容没有变化。
   */
  businessChangesBetween(fromRevision: string, toRevision: string): Promise<string[] | null>;
  deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup>;
  /**
   * paths 为空时统计整个仓库。历史不可读时返回诊断，供提交正文标明统计不可用。
   */
  authorStats(paths: string[], limit?: number): Promise<AuthorStats>;
}

export function acceptedDirtyPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return !IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

export function approvalIdentityKey(approval: ApprovalInfo): string {
  return JSON.stringify([
    approval.optionId,
    approval.patchId,
    approval.recordRevision,
    approval.patchSha256,
    approval.repairAttemptId,
    approval.approvedAt,
    approval.baseRevision,
  ]);
}

export function extractReviewApproval(text: string | null): ApprovalInfo | null {
  if (!text) return null;
  try {
    const parsed = parseReviewMarkdown(text);
    return parsed.meta.status === 'approved' ? parsed.meta.approval : null;
  } catch {
    return null;
  }
}

export function toRepoRelative(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function gitBlobHash(content: Buffer | string): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${String(buffer.length)}\0`).update(buffer).digest('hex');
}

export function normalizeCommitPath(root: string, value: string): string {
  const relativePath = path.isAbsolute(value) ? path.relative(root, value) : value;
  return toRepoRelative(relativePath);
}

/** 检测仓库根 .tmp/ 是否存在（即使 .tmp/ 被 .gitignore 或 svn:ignore 忽略）。 */
export async function hasTmpDir(root: string): Promise<boolean> {
  const info = await lstat(path.join(root, '.tmp')).catch(() => null);
  return info !== null;
}

/** 展开目录以形成逐文件核对清单；使用 lstat 拒绝符号链接，防止目录内夹带或逃逸。 */
export async function collectCommitEntries(
  root: string,
  paths: string[],
): Promise<{ entries: ExpectedCommitEntry[]; missing: string[] }> {
  const entries: ExpectedCommitEntry[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stats = await lstat(absolute).catch(() => null);
    if (!stats) {
      missing.push(relative);
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`提交核对集合禁止包含符号链接：${relative}`);
    }
    if (stats.isDirectory()) {
      const names = (await readdir(absolute).catch(() => [] as string[])).sort();
      for (const name of names) {
        await visit(path.join(absolute, name), `${relative}/${name}`);
      }
      return;
    }
    if (!stats.isFile()) return;
    if (seen.has(relative)) return;
    seen.add(relative);
    const buffer = await readFile(absolute);
    entries.push({
      path: relative,
      blobHash: gitBlobHash(buffer),
      mode: (stats.mode & 0o111) !== 0 ? '100755' : '100644',
    });
  };
  for (const input of paths) {
    const relative = normalizeCommitPath(root, input).replace(/\/+$/, '');
    if (!relative) continue;
    await visit(path.join(root, relative), relative);
  }
  return { entries, missing };
}

export function parseStagedIndex(output: string): Map<string, { mode: string; hash: string }> {
  const entries = new Map<string, { mode: string; hash: string }>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t(.+)$/s.exec(record);
    if (!match || match[3] !== '0') continue;
    const [, mode = '', hash = '', , file = ''] = match;
    if (file) entries.set(file, { mode, hash });
  }
  return entries;
}

export function decodeSvnPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** prefix 使用 `svn info` 返回的相对 URL 形式，例如 ^/trunk。 */
export function svnRepoPath(prefix: string, relPath: string): string {
  const base = decodeSvnPath(prefix.trim().replace(/^\^/, '')).replace(/\/+$/, '');
  const rel = toRepoRelative(relPath);
  const joined = `${base}/${rel}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

/** 其他分支或标签的仓库绝对路径返回 null。 */
export function svnRepoPathToRelative(prefix: string, repoPath: string): string | null {
  const base = decodeSvnPath(prefix.trim().replace(/^\^/, '')).replace(/\/+$/, '');
  const target = repoPath.trim();
  if (base === '' || base === '/') {
    const trimmedRoot = target.replace(/^\/+/, '');
    return trimmedRoot.length > 0 ? trimmedRoot : null;
  }
  if (target === base) return '.';
  if (!target.startsWith(`${base}/`)) return null;
  return target.slice(base.length + 1);
}

export async function git(root: string, args: string[], timeoutMs = VCS_TIMEOUT_MS): Promise<ProcessResult> {
  return runProcess(
    'git',
    ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
    { cwd: root, timeoutMs, maxBytes: 8 * 1024 * 1024 },
  );
}

export async function svn(root: string, args: string[], timeoutMs = VCS_TIMEOUT_MS): Promise<ProcessResult> {
  return runProcess('svn', ['--non-interactive', ...args], { cwd: root, timeoutMs, maxBytes: 8 * 1024 * 1024 });
}

export function describeProcess(result: ProcessResult): string {
  const output = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
  if (result.error) return [result.error, output].filter(Boolean).join('\n');
  if (result.timedOut) return `命令超时（${String(VCS_TIMEOUT_MS)}ms）\n${output}`;
  return output || `退出码 ${String(result.code ?? 'null')}`;
}

/** 解析 git status --porcelain=v1 -z 输出（正确拆解 R/C 重命名与复制的双路径记录）。 */
export function parseGitPorcelainZ(stdout: string): string[] {
  const paths: string[] = [];
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length;) {
    const entry = tokens[i] ?? '';
    i += 1;
    if (entry.length < 4) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const filePath = toRepoRelative(entry.slice(3));
    if (filePath) paths.push(filePath);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origPath = toRepoRelative(tokens[i] ?? '');
      i += 1;
      if (origPath) paths.push(origPath);
    }
  }
  return [...new Set(paths)];
}

/** 姓名和邮箱大小写不影响聚合，展示采用日志中首次出现的写法。 */
export function tallyAuthors(output: string): AuthorStatBucket[] {
  const buckets = new Map<string, AuthorStatBucket>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const separator = line.indexOf('\x1f');
    const name = (separator >= 0 ? line.slice(0, separator) : line).trim();
    const email = (separator >= 0 ? line.slice(separator + 1) : '').trim();
    const key = `${name.toLowerCase()}\u0000${email.toLowerCase()}`;
    const existing = buckets.get(key);
    if (existing) existing.commits += 1;
    else buckets.set(key, { name, email, commits: 1 });
  }
  return [...buckets.values()].sort((left, right) => right.commits - left.commits
    || left.name.localeCompare(right.name));
}

export function patchTouchesReviewData(text: string): boolean {
  return parsePatch(text).paths.some(isAiReviewPath);
}
