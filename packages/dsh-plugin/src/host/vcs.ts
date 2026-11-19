import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildHunkFallbackDiff, isAiReviewPath, parsePatch } from './patch.js';
import { parseReviewMarkdown } from './frontmatter.js';
import { runProcess, tailLines, type ProcessResult } from './shell.js';
import type { ApplyPatchResult, ApprovalCommitLookup, AuthorStatBucket, AuthorStats, InterRevisionDiff, VcsType } from './types.js';

const VCS_TIMEOUT_MS = 180_000;
const IGNORED_PREFIXES = ['.ai-review/', '.tmp/', 'node_modules/'];

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
}

export interface CommitResult {
  success: boolean;
  commitRevision: string | null;
  outOfDate: boolean;
  errorOutput: string;
    verificationFailed?: boolean;
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
}

export interface VcsAdapter {
  readonly type: VcsType;
  readonly root: string;
  ensureCleanWorkspace(): Promise<CleanResult>;
  syncAndGetLatestBase(): Promise<SyncResult>;
  getCurrentBase(): Promise<string | null>;
  /** 相关提交落地时探针必须变化。返回 null 时，调用方无法据此确定提交结果。 */
  getCommitProbe(paths: string[]): Promise<string | null>;
  readFileAt(revision: string, relPath: string): Promise<string | null>;
  listCommitPaths?(revision: string): Promise<string[] | null>;
  applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult>;
  exportWorkingTreeDiff(base: string, paths: string[]): Promise<string>;
  revertBusinessWorkspace(): Promise<void>;
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

function acceptedDirtyPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return !IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function isApprovedReview(text: string): boolean {
  try {
    const parsed = parseReviewMarkdown(text);
    return parsed.meta.status === 'approved' && parsed.meta.approval !== null;
  } catch {
    return false;
  }
}

function toRepoRelative(value: string): string {
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

function normalizeCommitPath(root: string, value: string): string {
  const relativePath = path.isAbsolute(value) ? path.relative(root, value) : value;
  return toRepoRelative(relativePath);
}

/** 展开目录以形成逐文件核对清单，防止目录范围内的额外文件混入提交。 */
export async function collectCommitEntries(
  root: string,
  paths: string[],
): Promise<{ entries: ExpectedCommitEntry[]; missing: string[] }> {
  const { readdir, stat } = await import('node:fs/promises');
  const entries: ExpectedCommitEntry[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stats = await stat(absolute).catch(() => null);
    if (!stats) {
      missing.push(relative);
      return;
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

function parseStagedIndex(output: string): Map<string, { mode: string; hash: string }> {
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

function decodeSvnPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** prefix 使用 `svn info` 返回的相对 URL 形式，例如 ^/trunk。 */
function svnRepoPath(prefix: string, relPath: string): string {
  const base = decodeSvnPath(prefix.trim().replace(/^\^/, '')).replace(/\/+$/, '');
  const rel = toRepoRelative(relPath);
  const joined = `${base}/${rel}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

/** 其他分支或标签的仓库绝对路径返回 null。 */
function svnRepoPathToRelative(prefix: string, repoPath: string): string | null {
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

async function git(root: string, args: string[], timeoutMs = VCS_TIMEOUT_MS): Promise<ProcessResult> {
  return runProcess(
    'git',
    ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
    { cwd: root, timeoutMs, maxBytes: 8 * 1024 * 1024 },
  );
}

function describe(result: ProcessResult): string {
  const output = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
  if (result.error) return [result.error, output].filter(Boolean).join('\n');
  if (result.timedOut) return `命令超时（${String(VCS_TIMEOUT_MS)}ms）\n${output}`;
  return output || `退出码 ${String(result.code ?? 'null')}`;
}

/** 姓名和邮箱大小写不影响聚合，展示采用日志中首次出现的写法。 */
function tallyAuthors(output: string): AuthorStatBucket[] {
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

export class GitAdapter implements VcsAdapter {
  readonly type = 'git' as const;

  constructor(
    readonly root: string,
    private readonly baseBranch = '',
  ) {}

  async ensureCleanWorkspace(): Promise<CleanResult> {
    const result = await git(this.root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (result.code !== 0) {
      return { clean: false, dirtyPaths: [], message: `无法读取 git 状态：${describe(result)}` };
    }
    const dirtyPaths = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim())
      .filter(acceptedDirtyPath);
    if (dirtyPaths.length === 0) return { clean: true, dirtyPaths, message: '工作区干净（忽略 .ai-review 数据）' };
    return {
      clean: false,
      dirtyPaths: dirtyPaths.slice(0, 50),
      message: `工作区存在未提交改动：\n${dirtyPaths.slice(0, 20).join('\n')}`,
    };
  }

  async getCurrentBase(): Promise<string | null> {
    const result = await git(this.root, ['rev-parse', 'HEAD']);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async getCommitProbe(_paths: string[]): Promise<string | null> {
    return this.getCurrentBase();
  }

  async readFileAt(revision: string, relPath: string): Promise<string | null> {
    const rev = revision.trim();
    if (!/^[0-9a-fA-F]+$/.test(rev)) return null;
    const target = toRepoRelative(relPath);
    if (target.length === 0) return null;
    const result = await git(this.root, ['show', `${rev}:${target}`]);
    return result.code === 0 ? result.stdout : null;
  }

  async listCommitPaths(revision: string): Promise<string[] | null> {
    const rev = revision.trim();
    if (!/^[0-9a-fA-F]+$/.test(rev)) return null;
    const result = await git(this.root, ['diff-tree', '-m', '-r', '--root', '--no-commit-id', '--name-only', '-z', rev]);
    if (result.code !== 0) return null;
    return result.stdout.split('\0').map((item) => item.trim()).filter((item) => item.length > 0).map(toRepoRelative);
  }

  async businessChangesBetween(fromRevision: string, toRevision: string): Promise<string[] | null> {
    const from = fromRevision.trim();
    const to = toRevision.trim();
    if (!/^[0-9a-fA-F]+$/.test(from) || !/^[0-9a-fA-F]+$/.test(to)) return null;
    if (from === to) return [];
    const result = await git(this.root, [
      'diff', '--name-only', '-z', from, to, '--', '.', ':(exclude).ai-review',
    ]);
    if (result.code !== 0) return null;
    return result.stdout.split('\0').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async authorStats(paths: string[], limit = 500): Promise<AuthorStats> {
    // Git 即使在 -- 后仍解析 pathspec，补丁提供的路径必须按字面匹配。
    const scoped = [...new Set(paths.map(toRepoRelative).filter((item) => item.length > 0 && !isAiReviewPath(item)))];
    const scope: AuthorStats['scope'] = scoped.length > 0 ? 'tracked' : 'repo';
    const cap = `-${String(Math.max(1, Math.trunc(limit)))}`;
    const logArgs = ['log', '--no-merges', cap, '--format=%aN%x1f%aE'];
    if (scope === 'tracked') logArgs.push('--', ...scoped.map((item) => `:(literal)${item}`));
    const logResult = await git(this.root, logArgs);
    const statusResult = await git(this.root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const pendingFiles = statusResult.code === 0
      ? statusResult.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3).trim()).filter(acceptedDirtyPath).length
      : 0;
    if (logResult.code !== 0) {
      return { buckets: [], historyCommits: 0, pendingFiles, diagnostic: describe(logResult).slice(0, 200), scope };
    }
    const buckets = tallyAuthors(logResult.stdout);
    return {
      buckets,
      historyCommits: buckets.reduce((sum, bucket) => sum + bucket.commits, 0),
      pendingFiles,
      scope,
    };
  }

  /** 合并提交可能包含批准操作，不能只检查首父，也不能把已批准内容的合入误作新批准。 */
  async deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup> {
    if (input.patchPaths.length === 0) {
      return { revision: null, lookup: 'unknown', diagnostic: '候选没有补丁文件，无法派生' };
    }
    // Git 默认不为合并提交列出逐文件差异，用 -m 才能发现相对任一父提交删除的补丁。
    const deleters = await git(this.root, [
      'log', '-m', '--diff-filter=D', '--format=%H', '--', ...input.patchPaths,
    ]);
    if (deleters.code !== 0) {
      return { revision: null, lookup: 'unknown', diagnostic: `历史不可读：${describe(deleters)}` };
    }
    const commits = [...new Set(deleters.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
    const matches: string[] = [];
    for (const commit of commits) {
      const current = await this.readFileAt(commit, input.reviewPath);
      if (current === null || !isApprovedReview(current)) continue;
      const parentList = await git(this.root, ['show', '-s', '--format=%P', commit]);
      if (parentList.code !== 0) continue;
      const parents = [...new Set(parentList.stdout.split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0))];
      let parentApproved = false;
      for (const parent of parents) {
        const parentReview = await this.readFileAt(parent, input.reviewPath);
        if (parentReview !== null && isApprovedReview(parentReview)) {
          parentApproved = true;
          break;
        }
      }
      if (parentApproved) continue;
      let patchesDeleted = true;
      for (const patchPath of input.patchPaths) {
        const stillThere = await git(this.root, ['cat-file', '-e', `${commit}:${toRepoRelative(patchPath)}`]);
        if (stillThere.code === 0) {
          patchesDeleted = false;
          break;
        }
      }
      if (!patchesDeleted) continue;
      const tree = await git(this.root, ['diff-tree', '-m', '-r', '--no-commit-id', '--name-only', commit]);
      if (tree.code !== 0) continue;
      const changed = new Set(tree.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
      if (!input.targetFiles.some((file) => changed.has(toRepoRelative(file)))) continue;
      matches.push(commit);
    }
    if (matches.length === 1 && matches[0] !== undefined) return { revision: matches[0], lookup: 'found' };
    if (matches.length > 1) {
      return { revision: null, lookup: 'ambiguous', diagnostic: `${String(matches.length)} 个提交同时满足派生条件，需人工确认` };
    }
    return { revision: null, lookup: 'unknown', diagnostic: '历史中未找到满足条件的批准提交' };
  }

  async syncAndGetLatestBase(): Promise<SyncResult> {
    const before = await this.getCurrentBase();
    const remotes = await git(this.root, ['remote']);
    if (remotes.code !== 0 || remotes.stdout.trim().length === 0) {
      return { base: before, synced: false, message: '本地仓库没有远端，跳过同步（使用当前 HEAD 作为基线）' };
    }
    if (this.baseBranch.trim().length > 0) {
      const fetch = await git(this.root, ['fetch', 'origin', this.baseBranch]);
      if (fetch.code !== 0) {
        return { base: before, synced: false, failed: true, message: `同步失败：${describe(fetch)}` };
      }
      const current = await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const onBranch = current.code === 0 && current.stdout.trim() === this.baseBranch;
      if (onBranch) {
        const pull = await git(this.root, ['pull', '--ff-only']);
        if (pull.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describe(pull)}` };
      } else {
        const advance = await git(this.root, ['fetch', 'origin', `${this.baseBranch}:${this.baseBranch}`]);
        if (advance.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describe(advance)}` };
      }
      const head = await git(this.root, ['rev-parse', this.baseBranch]);
      if (head.code !== 0) {
        return { base: null, synced: false, uncertain: true, message: `同步后无法读取 ${this.baseBranch} 基线：${describe(head)}` };
      }
      const base = head.stdout.trim();
      return { base, synced: base !== before, message: base === before ? '已是最新基线' : `已同步 ${this.baseBranch} 到 ${String(base).slice(0, 12)}` };
    }
    const upstream = await git(this.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.code !== 0) {
      return { base: before, synced: false, message: '当前分支没有 upstream，跳过同步（使用当前 HEAD 作为基线）' };
    }
    const pull = await git(this.root, ['pull', '--ff-only']);
    if (pull.code !== 0) {
      return { base: before, synced: false, failed: true, message: `同步失败：${describe(pull)}` };
    }
    const base = await this.getCurrentBase();
    if (base === null) {
      return { base: null, synced: false, uncertain: true, message: '同步后无法读取当前 HEAD，基线状态不明' };
    }
    return {
      base,
      synced: base !== before,
      message: base === before ? '已是最新基线' : `已同步到最新基线 ${String(base).slice(0, 12)}`,
    };
  }

  async applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const args = threeWay
      ? ['apply', '--3way', '--binary', patchPath]
      : ['apply', '--check', '--binary', patchPath];
    if (!threeWay) {
      const check = await git(this.root, args);
      if (check.code !== 0) {
        return { ok: false, conflict: true, message: tailLines(describe(check), 80) };
      }
      const apply = await git(this.root, ['apply', '--binary', patchPath]);
      return apply.code === 0
        ? { ok: true, conflict: false, message: '补丁已应用到工作区' }
        : { ok: false, conflict: true, message: tailLines(describe(apply), 80) };
    }
    const apply = await git(this.root, args);
    return apply.code === 0
      ? { ok: true, conflict: false, message: '补丁已三方应用' }
      : { ok: false, conflict: true, message: tailLines(describe(apply), 80) };
  }

  async checkPatch(patchPath: string): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const check = await git(this.root, ['apply', '--check', '--binary', patchPath]);
    return check.code === 0
      ? { ok: true, conflict: false, message: '补丁可应用到当前基线' }
      : { ok: false, conflict: true, message: tailLines(describe(check), 40) };
  }

  async exportWorkingTreeDiff(base: string, paths: string[]): Promise<string> {
    const rel = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)).filter((item) => item.length > 0))];
    if (rel.length === 0) return '';
    await git(this.root, ['add', '-N', '--', ...rel]).catch(() => undefined);
    const diff = await git(this.root, ['diff', '--binary', '--no-ext-diff', base, '--', ...rel]);
    await git(this.root, ['reset', '-q', '--', ...rel]).catch(() => undefined);
    if (diff.code !== 0) throw new Error(`导出工作区 diff 失败：${describe(diff)}`);
    return diff.stdout;
  }

  async revertBusinessWorkspace(): Promise<void> {
    // checkout 从索引恢复文件，先重置索引以清除门禁或失败提交留下的暂存项。
    // 恢复和清理时保留 .ai-review/ 文件，修复 Agent 生成的新评审数据还要由 Host 提交。
    await git(this.root, ['reset', '-q', '--', '.']);
    await git(this.root, ['checkout', '--', '.', ':(exclude).ai-review']);
    await git(this.root, ['clean', '-fdq', '-e', '.ai-review']);
  }

  private async withWorktree<T>(base: string, run: (dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(tmpdir(), 'dsh-code-review-diff', randomUUID());
    await mkdir(path.dirname(dir), { recursive: true });
    const add = await git(this.root, ['worktree', 'add', '--detach', dir, base]);
    if (add.code !== 0) throw new Error(`无法创建临时 worktree：${describe(add)}`);
    try {
      return await run(dir);
    } finally {
      await git(this.root, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async materialize(dir: string, patchPath: string, label: string): Promise<string> {
    const apply = await git(dir, ['apply', '--binary', patchPath]);
    if (apply.code !== 0) throw new Error(`${label}补丁应用失败：${describe(apply)}`);
    await git(dir, ['add', '-A']);
    const commit = await git(dir, [
      '-c', 'user.name=AI Review Diff',
      '-c', 'user.email=ai-review@local',
      'commit', '-q', '--no-verify', '-m', label,
    ]);
    if (commit.code !== 0) throw new Error(`${label}临时提交失败：${describe(commit)}`);
    const head = await git(dir, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }

  async computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff> {
    const sameBase = input.fromBase === input.toBase;
    if (sameBase) {
      try {
        const unifiedDiff = await this.withWorktree(input.fromBase, async (dir) => {
          const left = await this.materialize(dir, input.fromPatchPath, `rev ${String(input.fromRevision)}`);
          await git(dir, ['reset', '--hard', input.fromBase]);
          await git(dir, ['clean', '-fdq', '-e', '.ai-review']);
          const right = await this.materialize(dir, input.toPatchPath, `rev ${String(input.toRevision)}`);
          const diff = await git(dir, ['diff', '--no-ext-diff', '--binary', left, right]);
          if (diff.code !== 0) throw new Error(describe(diff));
          return diff.stdout;
        });
        return {
          resolutionMode: 'same_base_direct',
          unifiedDiff,
          fromRevision: input.fromRevision,
          toRevision: input.toRevision,
          fromBase: input.fromBase,
          toBase: input.toBase,
          notes: ['两版基线相同，已直接比较两个版本的最终代码树。'],
        };
      } catch (error) {
        return buildHunkFallbackDiff(
          input.fromRevision,
          input.toRevision,
          input.fromBase,
          input.toBase,
          input.fromPatchText,
          input.toPatchText,
          [`同基线直接比较失败：${error instanceof Error ? error.message : String(error)}`],
        );
      }
    }

    try {
      const unifiedDiff = await this.withWorktree(input.toBase, async (dir) => {
        const appliable = await git(dir, ['apply', '--3way', '--binary', input.fromPatchPath]);
        if (appliable.code !== 0) {
          throw new Error(`旧补丁无法三方应用：${describe(appliable)}`);
        }
        await git(dir, ['add', '-A']);
        const commit = await git(dir, [
          '-c', 'user.name=AI Review Diff',
          '-c', 'user.email=ai-review@local',
          'commit', '-q', '--no-verify', '-m', `rev ${String(input.fromRevision)} on ${input.toBase}`,
        ]);
        if (commit.code !== 0) throw new Error(`旧版本临时提交失败：${describe(commit)}`);
        const left = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
        await git(dir, ['reset', '--hard', input.toBase]);
        await git(dir, ['clean', '-fdq', '-e', '.ai-review']);
        const right = await this.materialize(dir, input.toPatchPath, `rev ${String(input.toRevision)}`);
        const diff = await git(dir, ['diff', '--no-ext-diff', '--binary', left, right]);
        if (diff.code !== 0) throw new Error(describe(diff));
        return diff.stdout;
      });
      return {
        resolutionMode: 'cross_base_3way_clean',
        unifiedDiff,
        fromRevision: input.fromRevision,
        toRevision: input.toRevision,
        fromBase: input.fromBase,
        toBase: input.toBase,
        notes: [`旧补丁已三方应用到新基线 ${input.toBase}，增量对比基于新基线的代码树。`],
      };
    } catch (error) {
      return buildHunkFallbackDiff(
        input.fromRevision,
        input.toRevision,
        input.fromBase,
        input.toBase,
        input.fromPatchText,
        input.toPatchText,
        [`基线已迁移（${input.fromBase} → ${input.toBase}）且旧补丁无法干净三方应用。`, error instanceof Error ? error.message : String(error)],
      );
    }
  }

  async atomicCommit(input: CommitInput): Promise<CommitResult> {
    const paths = input.paths.filter((item) => item.trim().length > 0);
    const deletions = (input.deletePaths ?? []).filter((item) => item.trim().length > 0);
    const stagingPaths = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)))];
    const deletionPaths = [...new Set(deletions.map((item) => normalizeCommitPath(this.root, item)))];
    if (stagingPaths.length === 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: '没有指定要提交的路径' };
    }
    for (const deletion of deletions) {
      const absolute = path.isAbsolute(deletion) ? deletion : path.join(this.root, deletion);
      await rm(absolute, { force: true }).catch(() => undefined);
    }
    const fail = async (errorOutput: string): Promise<CommitResult> => {
      // 回退本次暂存范围，保留范围外原先存在的索引条目。
      const resetPaths = [...new Set([...stagingPaths, ...deletionPaths])];
      await git(this.root, ['reset', '-q', '--', ...resetPaths]).catch(() => undefined);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput };
    };
    const add = await git(this.root, ['add', '-A', '--', ...stagingPaths]);
    if (add.code !== 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: describe(add) };
    }
    const stagedList = await git(this.root, ['diff', '--cached', '--name-only', '-z']);
    if (stagedList.code !== 0) {
      return fail(`无法读取暂存区，拒绝提交：${describe(stagedList)}`);
    }
    const allowed = [...stagingPaths, ...deletionPaths];
    const stagedFiles = stagedList.stdout.split('\0').map((line) => line.trim()).filter((line) => line.length > 0);
    const unexpected = stagedFiles.filter((line) => !allowed.some((item) => line === item || line.startsWith(`${item}/`)));
    if (unexpected.length > 0) {
      return fail(`暂存区包含指定路径之外的条目，已拒绝提交：\n${unexpected.slice(0, 20).join('\n')}`);
    }
    const indexResult = await git(this.root, ['ls-files', '-s', '-z', '--', ...allowed]);
    if (indexResult.code !== 0) {
      return fail(`无法读取索引，拒绝提交：${describe(indexResult)}`);
    }
    const index = parseStagedIndex(indexResult.stdout);
    const fileMode = process.platform !== 'win32'
      ? true
      : (await git(this.root, ['config', '--get', 'core.filemode'])).stdout.trim() === 'true';
    const problems: string[] = [];
    for (const expected of input.verifyEntries ?? []) {
      const rel = normalizeCommitPath(this.root, expected.path);
      const entry = index.get(rel);
      if (!entry) {
        problems.push(`缺少暂存条目：${rel}`);
        continue;
      }
      if (entry.hash !== expected.blobHash) {
        problems.push(`暂存内容与已审核内容不一致：${rel}`);
      }
      if (fileMode && expected.mode && entry.mode !== expected.mode) {
        problems.push(`暂存模式与已审核模式不一致：${rel}（${entry.mode} ≠ ${expected.mode}）`);
      }
    }
    for (const deleted of input.verifyDeletions ?? []) {
      const rel = normalizeCommitPath(this.root, deleted);
      if (index.has(rel)) problems.push(`删除未在暂存区生效：${rel}`);
    }
    if ((input.verifyEntries?.length ?? 0) > 0 || (input.verifyDeletions?.length ?? 0) > 0) {
      const verified = new Set([
        ...(input.verifyEntries ?? []).map((entry) => normalizeCommitPath(this.root, entry.path)),
      ]);
      const deletedSet = new Set((input.verifyDeletions ?? []).map((entry) => normalizeCommitPath(this.root, entry)));
      // 重命名和复制记录有两个路径字段，必须按状态读取，避免下一个记录错位。
      const changed = await git(this.root, ['diff', '--cached', '--name-status', '-z']);
      if (changed.code !== 0) {
        return fail(`无法读取暂存变更，拒绝提交：${describe(changed)}`);
      }
      const tokens = changed.stdout.split('\0');
      for (let index = 0; index < tokens.length;) {
        const status = tokens[index] ?? '';
        index += 1;
        if (!status) continue;
        const takesTwoPaths = status.startsWith('R') || status.startsWith('C');
        const first = tokens[index] ?? '';
        index += 1;
        const second = takesTwoPaths ? (tokens[index] ?? '') : '';
        if (takesTwoPaths) index += 1;
        if (status.startsWith('D')) {
          if (first && !deletedSet.has(first)) problems.push(`暂存删除未列入核对集合：${first}`);
          continue;
        }
        if (takesTwoPaths) {
          if (first && !deletedSet.has(first)) problems.push(`重命名旧路径未列入删除核对集合：${first}`);
          if (second && !verified.has(second)) problems.push(`暂存条目未列入核对集合（疑似夹带）：${second}`);
          continue;
        }
        if (first && !verified.has(first)) problems.push(`暂存条目未列入核对集合（疑似夹带）：${first}`);
      }
    }
    if (problems.length > 0) {
      return fail(`已审核内容与暂存区不一致，已拒绝提交：\n${problems.slice(0, 20).join('\n')}`);
    }
    const staged = await git(this.root, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: '没有可提交的改动' };
    }
    const commit = await git(this.root, ['commit', '-m', input.message]);
    if (commit.code !== 0) {
      const output = describe(commit);
      return {
        success: false,
        commitRevision: null,
        outOfDate: /index\.lock|cannot lock ref|unable to create.*lock|Another git process/i.test(output),
        errorOutput: output,
      };
    }
    const head = await git(this.root, ['rev-parse', 'HEAD']);
    return { success: true, commitRevision: head.code === 0 ? head.stdout.trim() : null, outOfDate: false, errorOutput: '' };
  }
}

async function svn(root: string, args: string[], timeoutMs = VCS_TIMEOUT_MS): Promise<ProcessResult> {
  return runProcess('svn', ['--non-interactive', ...args], { cwd: root, timeoutMs, maxBytes: 8 * 1024 * 1024 });
}

function parseSvnStatusEntries(output: string): { state: string; path: string }[] {
  return output
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0 && line.length > 8)
    .map((line) => ({ state: line.slice(0, 1), path: line.slice(8).trim() }))
    .filter((entry) => entry.path.length > 0);
}

function parseSvnStatus(output: string): string[] {
  return parseSvnStatusEntries(output).map((entry) => entry.path);
}

function svnXmlText(value: string): string {
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '');
}

function svnXmlAttribute(value: string, name: string): string {
    return svnXmlText(new RegExp(`\\b${name}="([^"]*)"`).exec(value)?.[1] ?? '');
}

function svnProperties(output: string): Map<string, string> {
    return new Map([...output.matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)].map((match) => [svnXmlAttribute(match[1] ?? '', 'name'), svnXmlText(match[2] ?? '')]));
}

function svnCommitStates(root: string, output: string): Map<string, { state: string; properties: string; copied: boolean }> {
    const states = new Map<string, { state: string; properties: string; copied: boolean }>();
    for (const match of output.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
        const attributes = /<wc-status\b([^>]*)>/.exec(match[2] ?? '')?.[1] ?? '';
        states.set(normalizeCommitPath(root, svnXmlAttribute(match[1] ?? '', 'path')), {
            state: svnXmlAttribute(attributes, 'item'),
            properties: svnXmlAttribute(attributes, 'props'),
            copied: svnXmlAttribute(attributes, 'copied') === 'true',
        });
    }
    return states;
}

async function svnContentHash(root: string, revision: string, target: string, size: number): Promise<string | null> {
    return new Promise((resolve) => {
        const hash = createHash('sha1').update(`blob ${String(size)}\0`);
        let bytes = 0;
        let timedOut = false;
        let termination = Promise.resolve();
        const child = spawn('svn', ['--non-interactive', 'cat', '--ignore-keywords', '-r', revision, '--', `${target}@${revision}`], {
            cwd: root,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            if (!child.pid) return;
            if (process.platform === 'win32') {
                termination = runProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], { cwd: root, timeoutMs: 10_000, maxBytes: 4096 }).then(() => undefined);
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }
        }, VCS_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            hash.update(chunk);
        });
        child.once('error', () => {
            clearTimeout(timeout);
            resolve(null);
        });
        child.once('close', async (code) => {
            clearTimeout(timeout);
            await termination;
            resolve(!timedOut && code === 0 && bytes === size ? hash.digest('hex') : null);
        });
    });
}

export class SvnAdapter implements VcsAdapter {
  readonly type = 'svn' as const;

  constructor(readonly root: string) {}

  async ensureCleanWorkspace(): Promise<CleanResult> {
    const result = await svn(this.root, ['status']);
    if (result.code !== 0) {
      return { clean: false, dirtyPaths: [], message: `无法读取 svn 状态：${describe(result)}` };
    }
    const dirtyPaths = parseSvnStatus(result.stdout).filter(acceptedDirtyPath);
    if (dirtyPaths.length === 0) return { clean: true, dirtyPaths, message: '工作区干净（忽略 .ai-review 数据）' };
    return {
      clean: false,
      dirtyPaths: dirtyPaths.slice(0, 50),
      message: `工作区存在未提交改动：\n${dirtyPaths.slice(0, 20).join('\n')}`,
    };
  }

  async getCurrentBase(): Promise<string | null> {
    const result = await svn(this.root, ['info', '--show-item', 'revision']);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  /**
   * SVN 工作副本根 revision 不随子路径提交前进。未进入版本管理的路径用最近已版本化祖先定位。
   */
  async getCommitProbe(paths: string[]): Promise<string | null> {
    let best = 0;
    const visited = new Set<string>();
    for (const raw of paths) {
      let current = toRepoRelative(raw);
      for (;;) {
        const target = current.length > 0 ? current : '.';
        if (visited.has(target)) break;
        visited.add(target);
        const revision = await this.lastChangedRevision(target);
        if (revision !== null) {
          best = Math.max(best, revision);
          break;
        }
        if (current.length === 0) break;
        const slash = current.lastIndexOf('/');
        current = slash >= 0 ? current.slice(0, slash) : '';
      }
    }
    return best > 0 ? String(best) : null;
  }

  async readFileAt(revision: string, relPath: string): Promise<string | null> {
    const rev = revision.trim();
    if (!/^\d+$/.test(rev)) return null;
    const target = toRepoRelative(relPath);
    if (target.length === 0) return null;
    const result = await svn(this.root, ['cat', '-r', rev, '--', target]);
    return result.code === 0 ? result.stdout : null;
  }

  async authorStats(paths: string[], limit = 500): Promise<AuthorStats> {
    const scoped = [...new Set(paths.map(toRepoRelative).filter((item) => item.length > 0 && !isAiReviewPath(item)))];
    const scope: AuthorStats['scope'] = scoped.length > 0 ? 'tracked' : 'repo';
    const statusResult = await svn(this.root, ['status']);
    const pendingFiles = statusResult.code === 0 ? parseSvnStatus(statusResult.stdout).filter(acceptedDirtyPath).length : 0;
    const args = ['log', '--xml', '-l', String(Math.max(1, Math.trunc(limit)))];
    // 跳过形如选项的路径，避免将仓库内容解释为 SVN 命令选项。
    const usable = scoped.filter((item) => !item.startsWith('-'));
    if (usable.length > 0) args.push(...usable);
    const logResult = await svn(this.root, args);
    if (logResult.code !== 0) {
      return { buckets: [], historyCommits: 0, pendingFiles, diagnostic: describe(logResult).slice(0, 200), scope };
    }
    const counts = new Map<string, number>();
    for (const match of logResult.stdout.matchAll(/<logentry\b[\s\S]*?<\/logentry>/g)) {
      const author = /<author>([\s\S]*?)<\/author>/.exec(match[0])?.[1]?.trim() ?? '';
      const key = author || '(未署名)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const buckets: AuthorStatBucket[] = [...counts.entries()]
      .map(([name, commits]) => ({ name, email: '', commits }))
      .sort((left, right) => right.commits - left.commits || left.name.localeCompare(right.name));
    return {
      buckets,
      historyCommits: buckets.reduce((sum, bucket) => sum + bucket.commits, 0),
      pendingFiles,
      scope,
    };
  }

  /** 日志区间排除起始版本，避免把原基线提交本身的变化计入结果。 */
  async businessChangesBetween(fromRevision: string, toRevision: string): Promise<string[] | null> {
    const from = fromRevision.trim();
    const to = toRevision.trim();
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return null;
    const fromNumber = Number(from);
    const toNumber = Number(to);
    if (!Number.isSafeInteger(fromNumber) || !Number.isSafeInteger(toNumber)) return null;
    if (fromNumber === toNumber) return [];
    if (toNumber < fromNumber) return null;
    const result = await svn(this.root, ['log', '-v', '--xml', '-r', `${String(fromNumber + 1)}:${String(toNumber)}`]);
    if (result.code !== 0) return null;
    const prefix = await svn(this.root, ['info', '--show-item', 'relative-url', '--', '.']);
    if (prefix.code !== 0) return null;
    const changes = new Set<string>();
    for (const match of result.stdout.matchAll(/<path\b[^>]*\baction="([^"]+)"[^>]*>([^<]+)<\/path>/g)) {
      const action = (match[1] ?? '').toUpperCase();
      const repoPath = (match[2] ?? '').trim();
      if (action === 'M' && repoPath.startsWith('svn:')) continue;
      const relative = svnRepoPathToRelative(prefix.stdout, repoPath);
      if (relative === null || relative === '.') continue;
      changes.add(relative);
    }
    return [...changes].filter((relative) => !relative.startsWith('.ai-review/') && relative !== '.ai-review');
  }

  private async lastChangedRevision(target: string): Promise<number | null> {
    const result = await svn(this.root, ['info', '--show-item', 'last-changed-revision', '--', target]);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    if (!/^\d+$/.test(value)) return null;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  /** 日志路径相对于仓库根。转换为工作副本相对路径后精确比较，避免命中其他分支的同名文件。 */
  async deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup> {
    if (input.patchPaths.length === 0) {
      return { revision: null, lookup: 'unknown', diagnostic: '候选没有补丁文件，无法派生' };
    }
    const relativeUrl = await svn(this.root, ['info', '--show-item', 'relative-url', '--', '.']);
    const prefix = relativeUrl.code === 0 ? relativeUrl.stdout.trim() : '';
    if (!prefix.startsWith('^/')) {
      return { revision: null, lookup: 'unknown', diagnostic: `无法读取 SVN 仓库相对 URL，不能精确匹配路径：${describe(relativeUrl)}` };
    }
    const reviewRepoPath = svnRepoPath(prefix, input.reviewPath);
    const patchRepoPaths = input.patchPaths.map((patch) => svnRepoPath(prefix, patch));
    const targetRepoPaths = input.targetFiles.map((target) => svnRepoPath(prefix, target));
    const normalizedReview = toRepoRelative(input.reviewPath);
    const dir = normalizedReview.includes('/') ? normalizedReview.slice(0, normalizedReview.lastIndexOf('/')) : normalizedReview;
    const log = await svn(this.root, ['log', '-v', '--xml', '-r', 'HEAD:1', '--', dir]);
    if (log.code !== 0) return { revision: null, lookup: 'unknown', diagnostic: `svn log 不可读：${describe(log)}` };
    const entries = [...log.stdout.matchAll(/<logentry\s+revision="(\d+)"[\s\S]*?<\/logentry>/g)];
    const matches: string[] = [];
    for (const entry of entries) {
      const revision = entry[1] ?? '';
      const body = entry[0] ?? '';
      const paths = [...body.matchAll(/<path\b[^>]*\baction="([AMDR])"[^>]*>([^<]+)<\/path>/g)]
        .map((match) => ({ action: match[1] ?? '', path: decodeSvnPath((match[2] ?? '').trim()) }));
      const reviewModified = paths.some((item) => item.action === 'M' && item.path === reviewRepoPath);
      const patchesDeleted = patchRepoPaths.every((patch) => paths.some((item) => item.action === 'D' && item.path === patch));
      const touchesTarget = targetRepoPaths.some((target) => paths.some((item) => item.path === target));
      if (reviewModified && patchesDeleted && touchesTarget) matches.push(revision);
    }
    const verified: string[] = [];
    for (const revision of matches) {
      const current = await this.readFileAt(revision, input.reviewPath);
      if (current === null || !isApprovedReview(current)) continue;
      const parent = await this.readFileAt(String(Number(revision) - 1), input.reviewPath);
      if (parent !== null && isApprovedReview(parent)) continue;
      verified.push(revision);
    }
    if (verified.length === 1) return { revision: verified[0] ?? null, lookup: 'found' };
    if (verified.length > 1) return { revision: null, lookup: 'ambiguous', diagnostic: `${String(verified.length)} 个提交同时满足派生条件，需人工确认` };
    return { revision: null, lookup: 'unknown', diagnostic: '路径历史中未找到满足条件的批准提交' };
  }

  async syncAndGetLatestBase(): Promise<SyncResult> {
    const before = await this.getCurrentBase();
    const update = await svn(this.root, ['update']);
    if (update.code !== 0) {
      return { base: before, synced: false, failed: true, message: `同步失败：svn update 失败：${describe(update)}` };
    }
    const base = await this.getCurrentBase();
    if (base === null) {
      return { base: null, synced: false, uncertain: true, message: '同步后无法读取工作副本 revision，基线状态不明' };
    }
    return {
      base,
      synced: base !== before,
      message: base === before ? '已是最新基线' : `已同步到 r${String(base)}`,
    };
  }

  async applyPatch(patchPath: string, _threeWay = false): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const result = await svn(this.root, ['patch', patchPath]);
    if (result.code === 0) return { ok: true, conflict: false, message: '补丁已应用（svn patch）' };
    return { ok: false, conflict: true, message: tailLines(describe(result), 80) };
  }

  /** SVN 缺少等价的 dry-run 检查，只能返回未知。 */
  async checkPatch(_patchPath: string): Promise<ApplyPatchResult> {
    return { ok: false, conflict: false, message: 'SVN 暂不支持补丁预检（仅诊断）' };
  }

  async exportWorkingTreeDiff(_base: string, paths: string[]): Promise<string> {
    const rel = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)).filter((item) => item.length > 0))];
    if (rel.length === 0) return '';
    const diff = await svn(this.root, ['diff', '--', ...rel]);
    if (diff.code !== 0) throw new Error(`导出工作区 diff 失败：${describe(diff)}`);
    return diff.stdout;
  }

  async revertBusinessWorkspace(): Promise<void> {
    const status = await svn(this.root, ['status']);
    if (status.code === 0) {
      for (const entry of parseSvnStatusEntries(status.stdout)) {
        if (!acceptedDirtyPath(entry.path)) continue;
        const absolute = path.isAbsolute(entry.path) ? entry.path : path.join(this.root, entry.path);
        if (entry.state === '?') {
          await rm(absolute, { force: true, recursive: true }).catch(() => undefined);
        } else {
          await svn(this.root, ['revert', '-R', '--', entry.path]);
          // SVN 撤销新增只撤销调度，磁盘仍保留未跟踪文件。
          if (entry.state === 'A') {
            await rm(absolute, { force: true, recursive: true }).catch(() => undefined);
          }
        }
      }
    }
    await svn(this.root, ['cleanup']);
  }

  async computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff> {
    return buildHunkFallbackDiff(
      input.fromRevision,
      input.toRevision,
      input.fromBase,
      input.toBase,
      input.fromPatchText,
      input.toPatchText,
      ['SVN 无三方合并能力，跨基线增量对比按 hunk 级回退展示。'],
    );
  }

  async atomicCommit(input: CommitInput): Promise<CommitResult> {
    let commitStarted = false;
    let preparing = false;
    let beforeStates: ReturnType<typeof svnCommitStates> | undefined;
    let preparationScopes: string[] = [];
    const failure = async (errorOutput: string, commitRevision: string | null = null, verificationFailed = false): Promise<CommitResult> => {
        if (preparing && !commitStarted && beforeStates) {
            const current = await svn(this.root, ['status', '--xml', '--verbose', '--ignore-externals', '--', ...preparationScopes]);
            if (current.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(current.stdout)) {
                errorOutput += `\n无法核对本次 SVN 调度以执行恢复：${describe(current)}`;
            } else {
                const states = svnCommitStates(this.root, current.stdout);
                const affected = [...states].filter(([target]) => allowed.some((item) => target === item || target.startsWith(`${item}/`) || item.startsWith(`${target}/`)));
                const additions = affected.filter(([target, entry]) => entry.state === 'added' && beforeStates?.get(target)?.state !== 'added').map(([target]) => target).sort((left, right) => right.split('/').length - left.split('/').length);
                const removals = affected.filter(([target, entry]) => entry.state === 'deleted' && beforeStates?.get(target)?.state !== 'deleted').map(([target]) => target).sort((left, right) => left.split('/').length - right.split('/').length);
                const missing: string[] = [];
                for (const target of [...removals, ...additions]) {
                    const reverted = await svn(this.root, ['revert', '--depth', 'empty', '--', target]);
                    if (reverted.code !== 0) {
                        errorOutput += `\n无法撤销本次 SVN 调度 ${target}：${describe(reverted)}`;
                    } else if (beforeStates.get(target)?.state === 'missing') {
                        missing.push(target);
                    }
                }
                for (const target of missing) await rm(path.join(this.root, target), { recursive: true, force: true });
            }
        }
        return { success: false, commitRevision, outOfDate: false, errorOutput, ...(verificationFailed ? { verificationFailed: true } : {}) };
    };
    const paths = [...new Set(input.paths.filter((item) => item.trim()).map((item) => normalizeCommitPath(this.root, item)))];
    const deletions = [...new Set((input.deletePaths ?? []).map((item) => normalizeCommitPath(this.root, item)))];
    const allowed = [...paths, ...deletions];
    if (paths.length === 0) return failure('没有指定要提交的路径');
    if (allowed.some((item) => !item || item === '..' || item.startsWith('../'))) return failure('提交路径必须位于工作副本内');
    preparationScopes = [...new Set(allowed.map((item) => item.split('/')[0] ?? item))];
    const before = await svn(this.root, ['status', '--xml', '--verbose', '--no-ignore', '--ignore-externals', '--', ...preparationScopes]);
    if (before.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(before.stdout)) return failure(`无法保存完整提交前 SVN 调度：${describe(before)}`);
    beforeStates = svnCommitStates(this.root, before.stdout);
    for (const deletion of deletions) {
        if (beforeStates.get(deletion)?.state === 'deleted') continue;
        const dirty = [...beforeStates].find(([target, entry]) => (target === deletion || target.startsWith(`${deletion}/`)) && (!['normal', 'missing'].includes(entry.state) || entry.properties === 'modified' || entry.copied));
        if (dirty) return failure(`删除路径包含调用前的本地改动，已拒绝提交：${dirty[0]}`);
    }
    preparing = true;
    for (const deletion of deletions) {
        if (beforeStates.get(deletion)?.state === 'deleted') continue;
        const result = await svn(this.root, ['delete', '--force', '--', deletion]);
        if (result.code !== 0) {
            const status = await svn(this.root, ['status', '--xml', '--depth', 'empty', '--', deletion]);
            if (status.code !== 0 || !/item="deleted"/.test(status.stdout)) return failure(`无法安排删除 ${deletion}：${describe(result)}`);
        }
    }
    for (const target of paths) {
        if (!existsSync(path.join(this.root, target))) continue;
        const added = await svn(this.root, ['add', '--force', '--parents', '--', target]);
        if (added.code !== 0) return failure(`无法准备提交路径 ${target}：${describe(added)}`);
    }
    const status = await svn(this.root, ['status', '--xml', '--verbose', '--ignore-externals', '--', ...allowed]);
    if (status.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(status.stdout)) return failure(`无法核对完整提交集合：${describe(status)}`);
    const states = svnCommitStates(this.root, status.stdout);
    const verified = new Map((input.verifyEntries ?? []).map((entry) => [normalizeCommitPath(this.root, entry.path), entry]));
    const verifiedDeletions = new Set((input.verifyDeletions ?? []).map((item) => normalizeCommitPath(this.root, item)));
    const strict = input.verifyEntries !== undefined || input.verifyDeletions !== undefined;
    const commitPaths = new Set<string>();
    const verifiedSizes = new Map<string, number>();
    const propertiesBefore = new Map<string, Map<string, string>>();
    const problems: string[] = [];
    for (const [target, entry] of states) {
        if (!allowed.some((item) => target === item || target.startsWith(`${item}/`))) {
            problems.push(`提交集合包含指定路径之外的条目：${target}`);
            continue;
        }
        if (!['normal', 'added', 'modified', 'replaced', 'deleted'].includes(entry.state)) {
            problems.push(`无法证明提交路径状态：${target}（${entry.state}）`);
            continue;
        }
        const changed = entry.state !== 'normal' || entry.properties === 'modified';
        if (changed) commitPaths.add(target);
        if (entry.state === 'deleted') {
            if (strict && !verifiedDeletions.has(target)) problems.push(`删除未列入核对集合：${target}`);
            continue;
        }
        const stats = await lstat(path.join(this.root, target)).catch(() => null);
        if (!stats || stats.isSymbolicLink()) {
            problems.push(`无法核对普通文件或目录：${target}`);
            continue;
        }
        if (stats.isDirectory()) {
            if (entry.copied) problems.push(`不能证明复制目录的完整提交集合：${target}`);
            if (strict && changed && ![...verified.keys(), ...verifiedDeletions].some((item) => item.startsWith(`${target}/`))) problems.push(`目录未列入核对集合：${target}`);
        } else if (strict && changed && !verified.has(target)) {
            problems.push(`提交条目未列入核对集合：${target}`);
        }
        if (!changed && !verified.has(target)) continue;
        const props = await svn(this.root, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', target]);
        if (props.code !== 0) {
            problems.push(`无法读取提交属性：${target}`);
            continue;
        }
        const currentProperties = svnProperties(props.stdout);
        propertiesBefore.set(target, currentProperties);
        const baseProperties = entry.state === 'added' ? null : await svn(this.root, ['proplist', '--xml', '--verbose', '-r', 'BASE', '--depth', 'empty', '--', target]);
        if (baseProperties && baseProperties.code !== 0) problems.push(`无法读取基线属性：${target}`);
        const originalProperties = baseProperties ? svnProperties(baseProperties.stdout) : new Map<string, string>();
        for (const name of new Set([...currentProperties.keys(), ...originalProperties.keys()])) {
            if (name === 'svn:executable' && verified.get(target)?.mode && process.platform !== 'win32') continue;
            if (currentProperties.get(name) !== originalProperties.get(name)) problems.push(`属性变更未核对：${target}（${name}）`);
        }
    }
    for (const [target, expected] of verified) {
        const entry = states.get(target);
        if (!entry || entry.state === 'deleted') {
            problems.push(`缺少核对条目：${target}`);
            continue;
        }
        const content = await readFile(path.join(this.root, target)).catch(() => null);
        if (content) verifiedSizes.set(target, content.length);
        const props = propertiesBefore.get(target);
        if (!content || gitBlobHash(content) !== expected.blobHash) problems.push(`提交内容与已审核内容不一致：${target}`);
        const mode = props?.has('svn:executable') ? '100755' : '100644';
        if (process.platform !== 'win32' && expected.mode && mode !== expected.mode) problems.push(`提交模式与已审核模式不一致：${target}`);
        if (props?.has('svn:special')) problems.push(`无法核对 SVN 特殊文件：${target}`);
        if (content && props?.has('svn:eol-style') && content.includes(13)) problems.push(`SVN 换行转换会改变已审核内容：${target}`);
        if (content && props?.has('svn:keywords') && /\$[^$\r\n]+:[^$\r\n]*\$/.test(content.toString('utf8'))) problems.push(`SVN 关键词收缩会改变已审核内容：${target}`);
    }
    for (const target of verifiedDeletions) {
        if (states.get(target)?.state !== 'deleted') problems.push(`删除未生效：${target}`);
    }
    if (problems.length > 0) return failure(`已审核内容与 SVN 提交不一致，已拒绝提交：\n${problems.slice(0, 20).join('\n')}`);
    if (commitPaths.size === 0) return failure('没有可提交的改动');
    for (const target of [...commitPaths]) {
        let ancestor = path.posix.dirname(target);
        while (ancestor !== '.') {
            const state = await svn(this.root, ['status', '--xml', '--depth', 'empty', '--', ancestor]);
            if (state.code !== 0) return failure(`无法核对提交祖先：${ancestor}`);
            if (!/item="added"/.test(state.stdout)) break;
            const props = await svn(this.root, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', ancestor]);
            if (props.code !== 0 || svnProperties(props.stdout).size > 0 || /copied="true"/.test(state.stdout)) return failure(`无法核对新增祖先目录：${ancestor}`);
            commitPaths.add(ancestor);
            propertiesBefore.set(ancestor, new Map());
            ancestor = path.posix.dirname(ancestor);
        }
    }
    const rootUrl = await svn(this.root, ['info', '--show-item', 'url', '--', '.']);
    const prefix = await svn(this.root, ['info', '--show-item', 'relative-url', '--', '.']);
    if (rootUrl.code !== 0 || prefix.code !== 0) return failure('无法证明 SVN 提交仓库范围');
    commitStarted = true;
    const commit = await svn(this.root, ['commit', '--depth', 'empty', '-m', input.message, '--', ...commitPaths]);
    if (commit.code !== 0) {
        const output = describe(commit);
        return { success: false, commitRevision: null, outOfDate: /out of date|E160028|E155011|remains in conflict/i.test(output), errorOutput: output };
    }
    const revision = /Committed revision\s+(\d+)/i.exec(commit.stdout)?.[1] ?? null;
    if (!revision) return failure('SVN 返回成功但无法取得提交版本，必须核验提交结果', null, true);
    const log = await svn(this.root, ['log', '--xml', '--verbose', '-r', revision, '--', `${rootUrl.stdout.trim()}@${revision}`]);
    const actual = new Map<string, string>();
    for (const match of log.stdout.matchAll(/<path\b([^>]*)>([^<]*)<\/path>/g)) {
        const relative = svnRepoPathToRelative(prefix.stdout, svnXmlText(match[2] ?? ''));
        if (relative) actual.set(relative, svnXmlAttribute(match[1] ?? '', 'action'));
    }
    if (log.code !== 0 || actual.size !== commitPaths.size || [...commitPaths].some((target) => !actual.has(target))) return failure('SVN 实际提交路径与已核对集合不一致，必须人工恢复', revision, true);
    for (const [target, entry] of verified) {
        const url = `${rootUrl.stdout.trim()}/${target.split('/').map(encodeURIComponent).join('/')}`;
        if (await svnContentHash(this.root, revision, url, verifiedSizes.get(target) ?? 0) !== entry.blobHash) return failure(`SVN 实际提交内容与已审核内容不一致：${target}`, revision, true);
    }
    for (const target of verifiedDeletions) {
        if (actual.get(target) !== 'D') return failure(`SVN 实际提交未删除核对路径：${target}`, revision, true);
    }
    for (const [target, props] of propertiesBefore) {
        if (!commitPaths.has(target)) continue;
        const url = `${rootUrl.stdout.trim()}/${target.split('/').map(encodeURIComponent).join('/')}`;
        const result = await svn(this.root, ['proplist', '--xml', '--verbose', '-r', revision, '--depth', 'empty', '--', `${url}@${revision}`]);
        const actualProps = svnProperties(result.stdout);
        if (result.code !== 0 || props.size !== actualProps.size || [...props].some(([name, value]) => actualProps.get(name) !== value)) return failure(`SVN 实际提交属性与核对属性不一致：${target}`, revision, true);
    }
    return { success: true, commitRevision: revision, outOfDate: false, errorOutput: '' };
  }
}

export function createVcs(type: VcsType, root: string, baseBranch = ''): VcsAdapter {
  return type === 'git' ? new GitAdapter(root, baseBranch) : new SvnAdapter(root);
}

export function patchTouchesReviewData(text: string): boolean {
  return parsePatch(text).paths.some(isAiReviewPath);
}
