import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildHunkFallbackDiff, isAiReviewPath, parsePatch } from './patch.js';
import { parseReviewMarkdown } from './frontmatter.js';
import { runProcess, tailLines, type ProcessResult } from './shell.js';
import type { ApplyPatchResult, ApprovalCommitLookup, InterRevisionDiff, VcsType } from './types.js';

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

export interface ApprovalDeriveInput {
  /** 仓库相对 review.md 路径（正斜杠）。 */
  reviewPath: string;
  /** 仓库相对补丁路径（正斜杠）。 */
  patchPaths: string[];
  /** 候选 target_files（仓库相对、正斜杠）。 */
  targetFiles: string[];
}

export interface VcsAdapter {
  readonly type: VcsType;
  readonly root: string;
  ensureCleanWorkspace(): Promise<CleanResult>;
  syncAndGetLatestBase(): Promise<SyncResult>;
  getCurrentBase(): Promise<string | null>;
  /**
   * §5.6 三分支：返回一个「只要触及这些仓库相对路径的提交落地就必然变化」的版本标识。
   * Git 为 HEAD；SVN 为各路径（含最近已版本化祖先）的 last-changed-revision 最大值。
   * 无法读取探针时返回 null——调用方不得据此猜测提交结果。
   */
  getCommitProbe(paths: string[]): Promise<string | null>;
  /** §5.6 分支 1：读取指定 VCS 版本下的仓库相对文件内容；不存在或不可读时返回 null。 */
  readFileAt(revision: string, relPath: string): Promise<string | null>;
  applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult>;
  revertBusinessWorkspace(): Promise<void>;
  computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff>;
  atomicCommit(input: CommitInput): Promise<CommitResult>;
  /** §8.2 patchCheck 派生预检：只 dry-run 检查补丁能否应用到当前工作区/基线，不实际应用。 */
  checkPatch(patchPath: string): Promise<ApplyPatchResult>;
  /** §5.5：从 VCS 历史派生批准业务提交版本；三态 found/ambiguous/unknown。 */
  deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup>;
}

function acceptedDirtyPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return !IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

/** §5.5 派生验证用：review.md 文本是否处于 approved 且 approval 非空。 */
function isApprovedReview(text: string): boolean {
  try {
    const parsed = parseReviewMarkdown(text);
    return parsed.meta.status === 'approved' && parsed.meta.approval !== null;
  } catch {
    return false;
  }
}

/** 归一化仓库相对路径：反斜杠转正斜杠、去 `./` 前缀与首尾斜杠、合并重复斜杠。 */
function toRepoRelative(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** SVN 输出中的 URL/XML 路径可能是百分号编码；解码失败时保留原文。 */
function decodeSvnPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * §7.2：把 WC 相对路径转成仓库绝对路径（`svn log -v` 的 `<path>` 文本形态）。
 * `prefix` 形如 `^/trunk` 或 `^/`（`svn info --show-item relative-url`）。
 */
function svnRepoPath(prefix: string, relPath: string): string {
  const base = decodeSvnPath(prefix.trim().replace(/^\^/, '')).replace(/\/+$/, '');
  const rel = toRepoRelative(relPath);
  const joined = `${base}/${rel}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
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

  constructor(
    readonly root: string,
    /** §7.2/G28：baseBranch 非空时同步该分支；否则使用当前分支 upstream。 */
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

  /** §5.6：Git 的提交探针就是 HEAD（任何提交落地都会推进）。 */
  async getCommitProbe(_paths: string[]): Promise<string | null> {
    return this.getCurrentBase();
  }

  /** §5.6：`git show <rev>:<path>` 读取指定提交中的仓库相对文件；revision 仅接受十六进制，防选项注入。 */
  async readFileAt(revision: string, relPath: string): Promise<string | null> {
    const rev = revision.trim();
    if (!/^[0-9a-fA-F]+$/.test(rev)) return null;
    const target = toRepoRelative(relPath);
    if (target.length === 0) return null;
    const result = await git(this.root, ['show', `${rev}:${target}`]);
    return result.code === 0 ? result.stdout : null;
  }

  /**
   * §5.5 派生规则（Git）：在触及补丁路径的提交历史中查找删除全部补丁的提交，
   * 再用 `git show <c>:<path>` 与各父提交的 `git show <p>:<path>` 验证 review.md 的状态迁移
   * （本提交 approved 且所有父提交都不是 approved），且提交改动包含 target_files 中至少一个业务路径。
   *
   * 不限定 first-parent：Merge 提交必须用 `-m` 展开其相对每个父的改动列表，
   * 否则默认 diff 对 Merge 不列文件会漏检；条件 2 对 Merge 的所有父提交逐一验证。
   */
  async deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup> {
    if (input.patchPaths.length === 0) {
      return { revision: null, lookup: 'unknown', diagnostic: '候选没有补丁文件，无法派生' };
    }
    // `-m` 让 Merge 提交按每个父展开补丁删除改动；同一提交可能重复出现，用 Set 去重。
    const deleters = await git(this.root, [
      'log', '-m', '--diff-filter=D', '--format=%H', '--', ...input.patchPaths,
    ]);
    if (deleters.code !== 0) {
      return { revision: null, lookup: 'unknown', diagnostic: `历史不可读：${describe(deleters)}` };
    }
    const commits = [...new Set(deleters.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))];
    const matches: string[] = [];
    for (const commit of commits) {
      // 条件 1：本提交中的 review.md 是 approved 且 approval 非空。
      const current = await this.readFileAt(commit, input.reviewPath);
      if (current === null || !isApprovedReview(current)) continue;
      // 条件 2：全部父提交中同一文件都不存在或不是 approved（父不可读视为不是 approved）。
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
      // 条件 3：本提交后全部补丁都不复存在（即已被删除）；`cat-file -e` 能识别 Merge 结果树。
      let patchesDeleted = true;
      for (const patchPath of input.patchPaths) {
        const stillThere = await git(this.root, ['cat-file', '-e', `${commit}:${toRepoRelative(patchPath)}`]);
        if (stillThere.code === 0) {
          patchesDeleted = false;
          break;
        }
      }
      if (!patchesDeleted) continue;
      // 条件 4：改动列表（Merge 用 `-m` 展开）命中 target_files 中至少一个业务路径。
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
    // §7.2：baseBranch 非空时同步该分支（fetch + ff-only 推进本地分支）；否则走当前分支 upstream。
    if (this.baseBranch.trim().length > 0) {
      const fetch = await git(this.root, ['fetch', 'origin', this.baseBranch]);
      if (fetch.code !== 0) {
        return { base: before, synced: false, message: `同步失败：${describe(fetch)}` };
      }
      const current = await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const onBranch = current.code === 0 && current.stdout.trim() === this.baseBranch;
      if (onBranch) {
        const pull = await git(this.root, ['pull', '--ff-only']);
        if (pull.code !== 0) return { base: before, synced: false, message: `同步失败：${describe(pull)}` };
      } else {
        // ff-only 推进本地 baseBranch（非快进会被 fetch 拒绝，不产生合并提交）。
        const advance = await git(this.root, ['fetch', 'origin', `${this.baseBranch}:${this.baseBranch}`]);
        if (advance.code !== 0) return { base: before, synced: false, message: `同步失败：${describe(advance)}` };
      }
      const head = await git(this.root, ['rev-parse', this.baseBranch]);
      const base = head.code === 0 ? head.stdout.trim() : before;
      return { base, synced: base !== before, message: base === before ? '已是最新基线' : `已同步 ${this.baseBranch} 到 ${String(base).slice(0, 12)}` };
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

  /** §8.2：patchCheck 派生预检（dry-run，不修改工作区）。 */
  async checkPatch(patchPath: string): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const check = await git(this.root, ['apply', '--check', '--binary', patchPath]);
    return check.code === 0
      ? { ok: true, conflict: false, message: '补丁可应用到当前基线' }
      : { ok: false, conflict: true, message: tailLines(describe(check), 40) };
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
    // §7.5 步骤 9：逐路径核对暂存集合——索引中不得出现指定路径之外的条目
    // （防止门禁或 clean filter 夹带未审核代码进入提交）。
    const stagedList = await git(this.root, ['diff', '--cached', '--name-only']);
    if (stagedList.code === 0) {
      const allowed = new Set([
        ...stagingPaths,
        ...(input.deletePaths ?? []).filter((item) => item.trim().length > 0),
      ]);
      const unexpected = stagedList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && ![...allowed].some((item) => line === item || line.startsWith(`${item}/`)));
      if (unexpected.length > 0) {
        await git(this.root, ['reset', '-q', '--', '.']).catch(() => undefined);
        return {
          success: false,
          commitRevision: null,
          outOfDate: false,
          errorOutput: `暂存区包含指定路径之外的条目，已拒绝提交：\n${unexpected.slice(0, 20).join('\n')}`,
        };
      }
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

  /**
   * §5.6：SVN 的提交探针不使用工作副本根 revision（H1：根 revision 不随子路径提交前进），
   * 而是对每个仓库相对路径取 `svn info --show-item last-changed-revision`；路径未版本化
   * （尚未提交的本地新增/删除）时向上遍历到最近的已版本化祖先，只接受 >0 的整数 revision，
   * 多路径取最大值。全部不可读时返回 null。
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

  /** §5.6：`svn cat -r <rev> <path>`；revision 仅接受十进制数字，防选项注入。 */
  async readFileAt(revision: string, relPath: string): Promise<string | null> {
    const rev = revision.trim();
    if (!/^\d+$/.test(rev)) return null;
    const target = toRepoRelative(relPath);
    if (target.length === 0) return null;
    const result = await svn(this.root, ['cat', '-r', rev, '--', target]);
    return result.code === 0 ? result.stdout : null;
  }

  private async lastChangedRevision(target: string): Promise<number | null> {
    const result = await svn(this.root, ['info', '--show-item', 'last-changed-revision', '--', target]);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    if (!/^\d+$/.test(value)) return null;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  /**
   * §5.5 派生规则（SVN）：在候选目录路径历史中查找同一 revision 内
   * 「M review.md + D 全部补丁」的提交，再用 svn cat -r N 与 -r (N-1) 验证状态迁移，
   * 且该 revision 变更包含 target_files 中至少一个业务路径。
   *
   * `svn log -v --xml` 的 `<path>` 是仓库绝对路径（如 `/trunk/...`），而候选参数是
   * 工作副本相对路径，因此先用 `svn info --show-item relative-url` 取仓库前缀再转换，
   * 之后只做精确相等比较（禁止 endsWith，避免同后缀路径误命中）。
   */
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
    // 解析 XML：每个 <logentry revision="N"> 含 <paths><path action="M|D">…（属性顺序不固定）。
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

  /** §8.2：SVN 无 dry-run 等价物——返回 unknown 诊断，不作为批准依据。 */
  async checkPatch(_patchPath: string): Promise<ApplyPatchResult> {
    return { ok: false, conflict: false, message: 'SVN 暂不支持补丁预检（仅诊断）' };
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

export function createVcs(type: VcsType, root: string, baseBranch = ''): VcsAdapter {
  return type === 'git' ? new GitAdapter(root, baseBranch) : new SvnAdapter(root);
}

/** Make sure an incremental patch never carries review data (it must stay out of the candidate patch). */
export function patchTouchesReviewData(text: string): boolean {
  return parsePatch(text).paths.some(isAiReviewPath);
}
