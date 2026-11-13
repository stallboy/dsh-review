import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/** §7.5 步骤 9：提交前逐路径核对预期暂存 blob 与模式（防止 clean filter / 门禁夹带）。 */
export interface ExpectedCommitEntry {
  /** 仓库相对路径（正斜杠）。 */
  path: string;
  /** 已验证内容的 Git blob 哈希（对原始字节计算，不经过 clean filter）。 */
  blobHash: string;
  /** Git 索引模式（100644 / 100755）；平台不跟踪文件模式时忽略。 */
  mode?: string;
}

export interface CommitInput {
  message: string;
  /** Absolute or repo-relative paths that must be part of the commit. */
  paths: string[];
  /** Paths that must be deleted (and staged as deletions) in this commit. */
  deletePaths?: string[];
  /**
   * §7.5 步骤 9：这些路径必须以给定 blob/模式暂存；任一不符则拒绝提交。
   * 未提供时仍执行“暂存集合 ⊆ 指定路径 + 删除集合”的路径级核对。
   */
  verifyEntries?: ExpectedCommitEntry[];
  /** §7.5 步骤 9：这些路径必须已从索引删除（暂存删除）。 */
  verifyDeletions?: string[];
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
  /** §7.5 步骤 6：已知且可安全恢复的同步失败（区别于“无远端/无 upstream 的明确跳过”）。 */
  failed?: boolean;
  /** §7.5 步骤 6：同步部分完成或基线状态无法确定，调用方必须 RECOVERY_REQUIRED。 */
  uncertain?: boolean;
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
  /** 列出提交实际改动的完整仓库相对路径；无法证明时返回 null。 */
  listCommitPaths?(revision: string): Promise<string[] | null>;
  applyPatch(patchPath: string, threeWay: boolean): Promise<ApplyPatchResult>;
  /** §7.7：把当前工作区相对 base 的完整改动导出为 Unified Diff（Rebase 新基线补丁）。 */
  exportWorkingTreeDiff(base: string, paths: string[]): Promise<string>;
  revertBusinessWorkspace(): Promise<void>;
  computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff>;
  atomicCommit(input: CommitInput): Promise<CommitResult>;
  /** §8.2 patchCheck 派生预检：只 dry-run 检查补丁能否应用到当前工作区/基线，不实际应用。 */
  checkPatch(patchPath: string): Promise<ApplyPatchResult>;
  /**
   * §7.7/§8.2：比较两个版本之间的**业务代码**变化，排除 `.ai-review/` 评审元数据路径。
   *
   * 为什么必须排除：候选元数据（review.md / 补丁 / 档案）本身就存放在 `.ai-review/` 并
   * 随仓库提交，任何一次评论、状态变更、拒绝或审查收尾都会推进 HEAD / revision。
   * 若直接用 `base_revision === currentBase` 判断“基线未变”，任何已共享的候选都会永远
   * 被判为“落后”，从而让 Rebase 无限空转、并让一切候选集体显示“基线落后”。
   *
   * 返回两个版本的业务路径差异（新增/修改/删除/重命名，仓库相对、正斜杠）。
   * 无法读取时返回 null——调用方必须按“无法证明”处理，不得猜测为“无变化”。
   */
  businessChangesBetween(fromRevision: string, toRevision: string): Promise<string[] | null>;
  /** §5.5：从 VCS 历史派生批准业务提交版本；三态 found/ambiguous/unknown。 */
  deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup>;
  /**
   * §5.6/§10.2（2026-11-12 修订）：作者统计，供「详细」提交信息使用。
   *
   * 统计范围是本候选补丁触及的业务路径；`paths` 为空时统计整个仓库。
   * 实现必须 fail-open：无法读取（浅克隆、命令失败）时返回带 `diagnostic` 的结果，
   * 由调用方在正文写「统计不可用」，绝不猜测数字。
   */
  authorStats(paths: string[], limit?: number): Promise<AuthorStats>;
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

/** §7.5 步骤 9：对原始字节计算 Git blob 哈希（不含 clean filter，用于与索引暂存值比对）。 */
export function gitBlobHash(content: Buffer | string): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${String(buffer.length)}\0`).update(buffer).digest('hex');
}

/** 把提交/索引路径规范化为仓库相对正斜杠形式。 */
function normalizeCommitPath(root: string, value: string): string {
  const relativePath = path.isAbsolute(value) ? path.relative(root, value) : value;
  return toRepoRelative(relativePath);
}

/**
 * §7.5 步骤 9：把“本次要提交的路径集合”展开为完整的 `verifyEntries`。
 *
 * 背景（缺陷 B1）：`verifyEntries` 只声明“这些条目必须存在且内容一致”，并不能阻止
 * 目录中多出未审核文件。为了让 atomicCommit 能做集合相等核对，调用方必须给出**完整**
 * 的文件清单；本函数把目录路径展开为其中全部文件，并读取当前内容计算 blob 与模式。
 *
 * 用法：提交前先算出 entries，写入/核对过程中任何内容变化都会被 atomicCommit 发现。
 */
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

/** §7.5 步骤 9：解析 `git ls-files -s -z` 输出，得到索引中 stage 0 条目的模式与 blob 哈希。 */
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

/**
 * `svnRepoPath` 的逆运算：仓库绝对路径 `/trunk/src/a.js` + 前缀 `^/trunk`
 * → 工作副本相对路径 `src/a.js`。不在该前缀下时返回 null（另一个分支/标签的变更不相关）。
 */
function svnRepoPathToRelative(prefix: string, repoPath: string): string | null {
  const base = decodeSvnPath(prefix.trim().replace(/^\^/, '')).replace(/\/+$/, '');
  const target = decodeSvnPath(repoPath.trim());
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

/**
 * §5.6：把 `--format=%aN%x1f%aE` 的逐行输出按「姓名 + 邮箱」聚合，按提交数倒序。
 * 邮箱做小写归一化（Git 邮箱大小写不敏感），姓名保留首次出现的原文。
 */
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

  async listCommitPaths(revision: string): Promise<string[] | null> {
    const rev = revision.trim();
    if (!/^[0-9a-fA-F]+$/.test(rev)) return null;
    const result = await git(this.root, ['diff-tree', '-m', '-r', '--root', '--no-commit-id', '--name-only', '-z', rev]);
    if (result.code !== 0) return null;
    return result.stdout.split('\0').map((item) => item.trim()).filter((item) => item.length > 0).map(toRepoRelative);
  }

  /**
   * §7.7/§8.2：业务代码差异（排除 `.ai-review/`）。
   *
   * 用 `git diff --name-only -z <from> <to> -- . ":(exclude).ai-review"`：
   * - 只列路径，不读内容，成本低；
   * - pathspec `:(exclude)` 精确排除评审元数据目录，不影响业务路径中的同名子串；
   * - 任一版本不可读（浅克隆、非法 hash）时返回 null，调用方按“无法证明”处理。
   */
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

  /**
   * §5.6/§10.2：作者统计（详细提交信息）。
   *
   * - 历史提交：`git log --format=%aN%x1f%aE --no-merges -<limit> -- <paths>`；
   * - 本次待提交：`git status --porcelain` 中已修改/新增的业务文件数（排除 `.ai-review/`）；
   * - 只做只读命令，不触碰索引；命令失败返回 `diagnostic`，由正文写「统计不可用」。
   */
  async authorStats(paths: string[], limit = 500): Promise<AuthorStats> {
    // 路径来自补丁头（仓库内容，不可信）：< 开头的路径在 `--` 之后仍会被 git 当作 pathspec 魔法
    // 解析，因此统一用 :(literal) 前缀禁止通配与魔法；空路径表示全仓库统计。
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
        return { base: before, synced: false, failed: true, message: `同步失败：${describe(fetch)}` };
      }
      const current = await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const onBranch = current.code === 0 && current.stdout.trim() === this.baseBranch;
      if (onBranch) {
        const pull = await git(this.root, ['pull', '--ff-only']);
        if (pull.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describe(pull)}` };
      } else {
        // ff-only 推进本地 baseBranch（非快进会被 fetch 拒绝，不产生合并提交）。
        const advance = await git(this.root, ['fetch', 'origin', `${this.baseBranch}:${this.baseBranch}`]);
        if (advance.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describe(advance)}` };
      }
      const head = await git(this.root, ['rev-parse', this.baseBranch]);
      if (head.code !== 0) {
        // 已 fetch 但无法证明本地基线状态：不得当作“已同步成功”。
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

  /** §8.2：patchCheck 派生预检（dry-run，不修改工作区）。 */
  async checkPatch(patchPath: string): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const check = await git(this.root, ['apply', '--check', '--binary', patchPath]);
    return check.code === 0
      ? { ok: true, conflict: false, message: '补丁可应用到当前基线' }
      : { ok: false, conflict: true, message: tailLines(describe(check), 40) };
  }

  /** §7.7：导出工作区相对 base 的完整 diff（含新文件），供 Rebase 生成新基线补丁。 */
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
      // §7.5 步骤 9：核对失败必须 fail-closed，并只清空本次暂存的路径，
      // 不丢弃用户/其他流程事先暂存的内容。
      const resetPaths = [...new Set([...stagingPaths, ...deletionPaths])];
      await git(this.root, ['reset', '-q', '--', ...resetPaths]).catch(() => undefined);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput };
    };
    const add = await git(this.root, ['add', '-A', '--', ...stagingPaths]);
    if (add.code !== 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: describe(add) };
    }
    // §7.5 步骤 9：暂存集合必须 ⊆ 指定路径 + 删除集合；读取失败时不得继续提交。
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
    // §7.5 步骤 9：逐路径核对暂存 blob、模式与删除集合（防止 clean filter / 门禁夹带）。
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
    // §7.5 步骤 9（B1）：verifyEntries 只核对“列出的条目必须存在且内容一致”，
    // 这不覆盖“集合相等”。当调用方给出核对集合时，暂存集合中任何未列入的条目都视为
    // 夹带（clean filter、门禁额外产物、门禁写出的同名变体等）并拒绝提交。
    if ((input.verifyEntries?.length ?? 0) > 0 || (input.verifyDeletions?.length ?? 0) > 0) {
      const verified = new Set([
        ...(input.verifyEntries ?? []).map((entry) => normalizeCommitPath(this.root, entry.path)),
      ]);
      const deletedSet = new Set((input.verifyDeletions ?? []).map((entry) => normalizeCommitPath(this.root, entry)));
      // `git diff --cached --name-status -z`：状态与路径也是交替的 NUL 记录；
      // 重命名/复制记录形如 `R100\0旧\0新\0`，因此必须按状态前缀消费变长字段。
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
          // 旧路径被移走：必须声明确认；新路径按普通条目核对。
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
        // §7.2：只把本地锁冲突特征视为可重试撞车，不得把权限/占用等确定性失败误分类。
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

  /** §5.6/§10.2：作者统计（详细提交信息）。用 `svn log --xml` 的 `<author>` 聚合，失败时返回诊断。 */
  async authorStats(paths: string[], limit = 500): Promise<AuthorStats> {
    const scoped = [...new Set(paths.map(toRepoRelative).filter((item) => item.length > 0 && !isAiReviewPath(item)))];
    const scope: AuthorStats['scope'] = scoped.length > 0 ? 'tracked' : 'repo';
    const statusResult = await svn(this.root, ['status']);
    const pendingFiles = statusResult.code === 0 ? parseSvnStatus(statusResult.stdout).filter(acceptedDirtyPath).length : 0;
    const args = ['log', '--xml', '-l', String(Math.max(1, Math.trunc(limit)))];
    // SVN 的 `--` 之后是 peg/ignore-ancestry 等位置参数：不能拼出 `-- -foo` 这种序列。
    // 合法仓库路径不会以 `-` 开头，遇到直接跳过（统计退化为全仓库或其余路径，不猜测）。
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

  /**
   * §7.7/§8.2：业务代码差异（排除 `.ai-review/`）。
   *
   * SVN 没有两版本 diff 的便捷命令，改用 `svn log -v -r (from:to]` 收集区间内
   * 所有变更路径：`A/M/D/R` 行格式为 `   M /trunk/path`。排除 `.ai-review/`
   * 以及 SVN 元数据路径（`svn:` 属性变更行）。任一 revision 非法或日志不可读返回 null。
   */
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
    // <path action="M" kind="file">/trunk/src/a.js</path>
    for (const match of result.stdout.matchAll(/<path\b[^>]*\baction="([^"]+)"[^>]*>([^<]+)<\/path>/g)) {
      const action = (match[1] ?? '').toUpperCase();
      const repoPath = (match[2] ?? '').trim();
      // 属性变更（action=M 且路径以 svn: 开头）不是业务代码变化。
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

  /** §8.2：SVN 无 dry-run 等价物——返回 unknown 诊断，不作为批准依据。 */
  async checkPatch(_patchPath: string): Promise<ApplyPatchResult> {
    return { ok: false, conflict: false, message: 'SVN 暂不支持补丁预检（仅诊断）' };
  }

  /** §7.7：SVN 无三方合并，但可导出工作副本相对 BASE 的完整 diff。 */
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
