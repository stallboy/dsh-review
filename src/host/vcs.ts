import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildHunkFallbackDiff, isAiReviewPath, parsePatch } from './patch.js';
import { runProcess, tailLines, type ProcessResult } from './shell.js';
import type { ApplyPatchResult, InterRevisionDiff, VcsType } from './types.js';

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

export interface CommitInput {
  message: string;
  /** Absolute or repo-relative paths that must be part of the commit. */
  paths: string[];
  /** Paths that must be deleted (and staged as deletions) in this commit. */
  deletePaths?: string[];
}

export interface CommitResult {
  success: boolean;
  commitRevision: string | null;
  outOfDate: boolean;
  errorOutput: string;
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
}

export interface VcsAdapter {
  readonly type: VcsType;
  readonly root: string;
  ensureCleanWorkspace(): Promise<CleanResult>;
  syncAndGetLatestBase(): Promise<SyncResult>;
  getCurrentBase(): Promise<string | null>;
  applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult>;
  revertBusinessWorkspace(): Promise<void>;
  computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff>;
  atomicCommit(input: CommitInput): Promise<CommitResult>;
}

function acceptedDirtyPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return !IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
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

export class GitAdapter implements VcsAdapter {
  readonly type = 'git' as const;

  constructor(readonly root: string) {}

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

  async syncAndGetLatestBase(): Promise<SyncResult> {
    const before = await this.getCurrentBase();
    const remotes = await git(this.root, ['remote']);
    if (remotes.code !== 0 || remotes.stdout.trim().length === 0) {
      return { base: before, synced: false, message: '本地仓库没有远端，跳过同步（使用当前 HEAD 作为基线）' };
    }
    const upstream = await git(this.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.code !== 0) {
      return { base: before, synced: false, message: '当前分支没有 upstream，跳过同步（使用当前 HEAD 作为基线）' };
    }
    const pull = await git(this.root, ['pull', '--ff-only']);
    if (pull.code !== 0) {
      return { base: before, synced: false, message: `同步失败：${describe(pull)}` };
    }
    const base = await this.getCurrentBase();
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

  async revertBusinessWorkspace(): Promise<void> {
    // Restore only business files: `.ai-review` may contain the freshly generated
    // review.md/patch that the AI fixer is about to commit. Reset the whole index
    // first because `git checkout -- .` restores from the index: staged changes (a
    // failed commit, a gate check that ran `git add`, an intent-to-add from `git add -N`)
    // would otherwise survive. Resetting `.ai-review` as well drops index entries left
    // by a failed atomic commit, while its files stay on disk because checkout and
    // clean still exclude that path.
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
    for (const deletion of deletions) {
      const absolute = path.isAbsolute(deletion) ? deletion : path.join(this.root, deletion);
      await rm(absolute, { force: true }).catch(() => undefined);
    }
    const stagingPaths = [...new Set(paths)].map((item) =>
      path.isAbsolute(item) ? path.relative(this.root, item) : item,
    );
    const add = await git(this.root, ['add', '-A', '--', ...(stagingPaths.length > 0 ? stagingPaths : ['.'])]);
    if (add.code !== 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: describe(add) };
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
        outOfDate: /index\.lock|unable to create|EACCES|EBUSY/i.test(output),
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

  async syncAndGetLatestBase(): Promise<SyncResult> {
    const before = await this.getCurrentBase();
    const update = await svn(this.root, ['update']);
    if (update.code !== 0) {
      return { base: before, synced: false, message: `svn update 失败：${describe(update)}` };
    }
    const base = await this.getCurrentBase();
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
          // `svn revert` of a scheduled add only unschedules it: the file stays on
          // disk as unversioned, so remove it to really return to the baseline.
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
    const paths = input.paths.filter((item) => item.trim().length > 0);
    if (paths.length === 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: '没有指定要提交的路径' };
    }
    for (const deletion of input.deletePaths ?? []) {
      const absolute = path.isAbsolute(deletion) ? deletion : path.join(this.root, deletion);
      // A versioned but missing file still needs a scheduled deletion for `svn commit`.
      await svn(this.root, ['delete', '--force', absolute]).catch(() => undefined);
      await rm(absolute, { force: true }).catch(() => undefined);
    }
    for (const target of paths) {
      // `--parents` versions unversioned ancestors such as a brand-new .ai-review tree.
      await svn(this.root, ['add', '--force', '--parents', target]).catch(() => undefined);
    }
    const commitPaths = new Set(paths);
    for (const target of paths) {
      let current = path.resolve(this.root, target);
      const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
      while (current !== this.root && current.startsWith(rootWithSep)) {
        const status = await svn(this.root, ['status', '--depth', 'empty', current]);
        const line = status.stdout.trim();
        if (line.length === 0) break;
        const state = line.slice(0, 1);
        if (state !== 'A' && state !== '?') break;
        commitPaths.add(path.relative(this.root, current).replaceAll('\\', '/'));
        current = path.dirname(current);
      }
    }
    const commit = await svn(this.root, ['commit', '-m', input.message, ...commitPaths]);
    if (commit.code !== 0) {
      const output = describe(commit);
      return {
        success: false,
        commitRevision: null,
        outOfDate: /out of date|E160028|E155011|remains in conflict/i.test(output),
        errorOutput: output,
      };
    }
    const match = /Committed revision\s+(\d+)/i.exec(commit.stdout);
    return { success: true, commitRevision: match?.[1] ?? null, outOfDate: false, errorOutput: '' };
  }
}

export function createVcs(type: VcsType, root: string): VcsAdapter {
  return type === 'git' ? new GitAdapter(root) : new SvnAdapter(root);
}

/** Make sure an incremental patch never carries review data (it must stay out of the candidate patch). */
export function patchTouchesReviewData(text: string): boolean {
  return parsePatch(text).paths.some(isAiReviewPath);
}
