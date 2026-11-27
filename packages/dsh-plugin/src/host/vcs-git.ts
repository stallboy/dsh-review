/**
 * Git VCS 适配器：
 * 封装干净工作区检测（含 -z 重命名与 .tmp）、安全同步、严格/三方应用、隔离 worktree 增量对比、
 * Mode C 本地提交收拢与原子审批提交。
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildHunkFallbackDiff, isAiReviewPath } from './patch.js';
import { runProcess, tailLines, type ProcessResult } from './shell.js';
import type { ApplyPatchResult, ApprovalCommitLookup, AuthorStats, InterRevisionDiff } from './types.js';
import { deriveGitApprovalCommit } from './vcs-commit-derive.js';
import { computeGitModeCNetChangedPaths, hasActiveGitOp, isGitAncestor } from './vcs-mode-c.js';
import {
  acceptedDirtyPath,
  describeProcess,
  git,
  hasTmpDir,
  normalizeCommitPath,
  parseGitPorcelainZ,
  parseStagedIndex,
  tallyAuthors,
  toRepoRelative,
  VCS_TIMEOUT_MS,
  type ApprovalDeriveInput,
  type ApprovalPatchAttempt,
  type CleanResult,
  type CommitInput,
  type CommitResult,
  type DiffInput,
  type GitApprovalTarget,
  type ModeCTopologyCheck,
  type RemoteRefTipsResult,
  type RemoteTipResult,
  type SyncResult,
  type VcsAdapter,
} from './vcs-types.js';

export class GitAdapter implements VcsAdapter {
  readonly type = 'git' as const;

  constructor(
    readonly root: string,
    private readonly baseBranch = '',
  ) {}

  async ensureCleanWorkspace(): Promise<CleanResult> {
    const result = await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (result.code !== 0) {
      return { clean: false, dirtyPaths: [], message: `无法读取 git 状态：${describeProcess(result)}` };
    }
    const dirtyPaths = parseGitPorcelainZ(result.stdout).filter(acceptedDirtyPath);
    if (await hasTmpDir(this.root)) {
      if (!dirtyPaths.includes('.tmp')) dirtyPaths.push('.tmp');
    }
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

  async commitExists(revision: string): Promise<boolean> {
    const rev = revision.trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(rev)) return false;
    const result = await git(this.root, ['cat-file', '-e', `${rev}^{commit}`]);
    return result.code === 0;
  }

  async getApprovalTarget(): Promise<GitApprovalTarget | null> {
    const [ref, base, sequencer] = await Promise.all([
      git(this.root, ['rev-parse', '--symbolic-full-name', 'HEAD']),
      this.getCurrentBase(),
      git(this.root, [
        'rev-parse',
        ...['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
          .flatMap((file) => ['--git-path', file]),
      ]),
    ]);
    const name = ref.stdout.replace(/\r?\n$/, '');
    const statePaths = sequencer.stdout.trimEnd().split(/\r?\n/);
    if (sequencer.code !== 0 || statePaths.length !== 6 || statePaths.some((file) => existsSync(path.resolve(this.root, file)))) {
      return null;
    }
    return ref.code === 0 && base && /^(?:HEAD|refs\/heads\/[^\x00-\x20\x7f]+)$/.test(name) ? { ref: name, base } : null;
  }

  private async matchesApprovalTarget(target: GitApprovalTarget): Promise<boolean> {
    const current = await this.getApprovalTarget();
    return current?.ref === target.ref && current.base === target.base;
  }

  private async commitApprovedTree(target: GitApprovalTarget, tree: string, message: string): Promise<CommitResult> {
    const failed = (
      errorOutput: string,
      flags: Partial<Pick<CommitResult, 'targetChanged' | 'verificationFailed' | 'outOfDate'>> = {},
    ): CommitResult => ({ success: false, commitRevision: null, outOfDate: false, errorOutput, ...flags });

    if (!(await this.matchesApprovalTarget(target))) {
      return failed('Git 审批目标引用或基线已变化', { targetChanged: true });
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'dcr-approved-message-')).catch(() => null);
    if (!directory) return failed('无法创建审批提交消息文件');
    try {
      const messageFile = path.join(directory, 'COMMIT_EDITMSG');
      await writeFile(messageFile, `${message}\n`, 'utf8');
      for (const args of [['pre-commit'], ['prepare-commit-msg', '--', messageFile, 'message'], ['commit-msg', '--', messageFile]]) {
        const hook = await runProcess('git', ['hook', 'run', '--ignore-missing', ...args], {
          cwd: this.root,
          timeoutMs: VCS_TIMEOUT_MS,
          env: { GIT_EDITOR: ':' },
        });
        if (hook.code !== 0) return failed(describeProcess(hook));
      }
      const afterHooks = await git(this.root, ['write-tree']);
      if (afterHooks.code !== 0 || afterHooks.stdout.trim() !== tree) return failed('Git 提交钩子改变了已核验的提交树');
      if (!(await this.matchesApprovalTarget(target))) return failed('Git 审批目标在提交钩子期间变化', { targetChanged: true });
      const signing = await git(this.root, ['config', '--bool', '--get', 'commit.gpgsign']);
      if (signing.code !== 0 && signing.code !== 1) return failed(describeProcess(signing));
      const created = await git(this.root, [
        'commit-tree',
        tree,
        '-p',
        target.base,
        ...(signing.stdout.trim() === 'true' ? ['-S'] : []),
        '-F',
        messageFile,
      ]);
      const oid = created.stdout.trim();
      if (created.code !== 0 || !/^(?:[\da-f]{40}|[\da-f]{64})$/.test(oid)) return failed(describeProcess(created));
      let sent = false;
      let changed = false;
      const updated = await runProcess('git', ['update-ref', '-m', `commit: ${message.split(/\r?\n/)[0] ?? ''}`, '--stdin'], {
        cwd: this.root,
        timeoutMs: VCS_TIMEOUT_MS,
        input: {
          initial: `start\noption no-deref\nupdate ${target.ref} ${oid} ${target.base}\nprepare\n`,
          reply: (line) => (line === 'prepare: ok'
            ? (async () => {
              changed = !(await this.matchesApprovalTarget(target));
              sent = !changed;
              return changed ? 'abort\n' : 'commit\n';
            })()
            : undefined),
        },
      });
      if (changed || (!sent && !(await this.matchesApprovalTarget(target)))) {
        return failed('Git 审批目标引用或基线在提交事务期间变化', { targetChanged: true });
      }
      if (updated.code !== 0 || !/^commit: ok$/m.test(updated.stdout.replaceAll('\r', ''))) {
        if (!sent) return failed(describeProcess(updated), { outOfDate: /cannot lock ref|index\.lock/i.test(updated.stderr) });
        const actual = await git(this.root, ['rev-parse', '--verify', target.ref]);
        if (actual.code !== 0 || actual.stdout.trim() !== oid) {
          return failed(describeProcess(updated), { verificationFailed: true });
        }
      }
      await git(this.root, ['hook', 'run', '--ignore-missing', 'post-commit']);
      return { success: true, commitRevision: oid, outOfDate: false, errorOutput: '' };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
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
    const statusResult = await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const pendingFiles = statusResult.code === 0
      ? parseGitPorcelainZ(statusResult.stdout).filter(acceptedDirtyPath).length
      : 0;
    if (logResult.code !== 0) {
      return { buckets: [], historyCommits: 0, pendingFiles, diagnostic: describeProcess(logResult).slice(0, 200), scope };
    }
    const buckets = tallyAuthors(logResult.stdout);
    return {
      buckets,
      historyCommits: buckets.reduce((sum, bucket) => sum + bucket.commits, 0),
      pendingFiles,
      scope,
    };
  }

  deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup> {
    return deriveGitApprovalCommit(this, input);
  }

  async getCurrentBranch(): Promise<string | null> {
    const result = await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.code !== 0) return null;
    const branch = result.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  }

  async getRemoteTip(branch?: string): Promise<RemoteTipResult> {
    const remotes = await git(this.root, ['remote']);
    if (remotes.code !== 0) return { ok: false, error: `无法列出远端：${describeProcess(remotes)}` };
    if (!remotes.stdout.trim()) return { ok: true, remote: null };
    const targetBranch = branch ?? (await this.getCurrentBranch()) ?? undefined;
    if (!targetBranch) return { ok: true, remote: null };
    const upstream = await git(this.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    let remoteName = 'origin';
    let remoteBranch = targetBranch;
    if (upstream.code === 0 && upstream.stdout.trim().includes('/')) {
      const full = upstream.stdout.trim();
      const slash = full.indexOf('/');
      remoteName = full.slice(0, slash);
      remoteBranch = full.slice(slash + 1);
    }
    const remoteRef = `refs/heads/${remoteBranch}`;
    const ls = await git(this.root, ['ls-remote', remoteName, remoteRef]);
    if (ls.code !== 0) return { ok: false, error: `ls-remote ${remoteName} 失败：${describeProcess(ls)}` };
    const firstLine = ls.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    const tip = firstLine.split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{40,64}$/i.test(tip)) return { ok: true, remote: null };
    return { ok: true, remote: { remoteRef: `${remoteName}/${remoteBranch}`, tip } };
  }

  async listAllRefTips(): Promise<Map<string, string>> {
    const result = await git(this.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs = new Map<string, string>();
    if (result.code !== 0) return refs;
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] && parts[1] && /^[0-9a-f]{40,64}$/i.test(parts[1])) {
        refs.set(parts[0], parts[1]);
      }
    }
    return refs;
  }

  async listRemoteRefTips(): Promise<RemoteRefTipsResult> {
    const tips = new Map<string, string>();
    const remotes = await git(this.root, ['remote']);
    if (remotes.code !== 0) return { ok: false, error: `无法列出远端：${describeProcess(remotes)}` };
    const remoteNames = remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (remoteNames.length === 0) return { ok: true, tips, hasRemotes: false };
    for (const remoteName of remoteNames) {
      const ls = await git(this.root, ['ls-remote', '--heads', remoteName]);
      if (ls.code !== 0) {
        return { ok: false, error: `ls-remote --heads ${remoteName} 失败：${describeProcess(ls)}` };
      }
      for (const line of ls.stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const oid = parts[0];
        const ref = parts[1];
        if (oid && ref && /^[0-9a-f]{40,64}$/i.test(oid)) {
          tips.set(`${remoteName}:${ref}`, oid);
        }
      }
    }
    return { ok: true, tips, hasRemotes: true };
  }

  async checkoutBranch(branch: string): Promise<void> {
    const res = await git(this.root, ['checkout', '-q', '--force', branch]);
    if (res.code !== 0) throw new Error(`git checkout ${branch} 失败：${describeProcess(res)}`);
  }

  hasActiveGitOperation(): Promise<boolean> {
    return hasActiveGitOp(this.root);
  }

  async getTreeHash(revision = 'HEAD'): Promise<string | null> {
    const result = await git(this.root, ['rev-parse', `${revision}^{tree}`]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return isGitAncestor(this.root, ancestor, descendant);
  }

  computeModeCNetChangedPaths(
    preHead: string,
    postHead: string,
    trustedUpstreamTips?: readonly string[],
  ): Promise<ModeCTopologyCheck> {
    return computeGitModeCNetChangedPaths(this.root, preHead, postHead, trustedUpstreamTips);
  }

  async resetHard(revision: string, options?: { includeAiReview?: boolean }): Promise<void> {
    const res = await git(this.root, ['reset', '--hard', revision]);
    if (res.code !== 0) throw new Error(`git reset --hard ${revision} 失败：${describeProcess(res)}`);
    const cleanArgs = options?.includeAiReview ? ['clean', '-fdq'] : ['clean', '-fdq', '-e', '.ai-review'];
    const cleaned = await git(this.root, cleanArgs);
    if (cleaned.code !== 0) throw new Error(`git clean 失败：${describeProcess(cleaned)}`);
    await rm(path.join(this.root, '.tmp'), { recursive: true, force: true });
  }

  async revertAllToPreHead(preHead: string, includeAiReview: boolean): Promise<void> {
    await this.resetHard(preHead, { includeAiReview });
  }

  /** SPEC §5.5 情况 B-本地（单提交/单合并）：将 review.md 并入当前提交，保留合并父关系。 */
  async amendCommitWithReview(input: { reviewPath: string; expectedReviewBlob: string; message: string }): Promise<CommitResult> {
    const relReview = normalizeCommitPath(this.root, input.reviewPath);
    const add = await git(this.root, ['add', '--', relReview]);
    if (add.code !== 0) return { success: false, commitRevision: null, outOfDate: false, errorOutput: describeProcess(add) };
    const staged = await git(this.root, ['ls-files', '-s', '-z', '--', relReview]);
    const parsed = parseStagedIndex(staged.stdout);
    if (parsed.get(relReview)?.hash !== input.expectedReviewBlob) {
      await git(this.root, ['reset', '-q', '--', relReview]).catch(() => undefined);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'amend 前 review.md 暂存内容与已核对快照不一致' };
    }
    const amend = await git(this.root, ['commit', '--amend', '-m', input.message]);
    if (amend.code !== 0) {
      const output = describeProcess(amend);
      return {
        success: false,
        commitRevision: null,
        outOfDate: /index\.lock|cannot lock ref|Another git process/i.test(output),
        errorOutput: output,
      };
    }
    const head = await this.getCurrentBase();
    return { success: true, commitRevision: head, outOfDate: false, errorOutput: '' };
  }

  /** SPEC §5.5 情况 B-本地（多提交）：以 preHead 与 mergedParents 为父列表构造单一原子提交。 */
  async collapseLocalCommitsWithReview(input: {
    preHead: string;
    mergedParents: string[];
    reviewPath: string;
    expectedReviewBlob: string;
    message: string;
  }): Promise<CommitResult> {
    const relReview = normalizeCommitPath(this.root, input.reviewPath);
    const target = await this.getApprovalTarget();
    if (!target) return { success: false, commitRevision: null, outOfDate: false, errorOutput: '无法锁定 Git 目标引用' };
    const add = await git(this.root, ['add', '--', relReview]);
    if (add.code !== 0) return { success: false, commitRevision: null, outOfDate: false, errorOutput: describeProcess(add) };
    const staged = await git(this.root, ['ls-files', '-s', '-z', '--', relReview]);
    const parsed = parseStagedIndex(staged.stdout);
    if (parsed.get(relReview)?.hash !== input.expectedReviewBlob) {
      await git(this.root, ['reset', '-q', '--', relReview]).catch(() => undefined);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'commit-tree 前 review.md 内容与已核对快照不一致' };
    }
    const writtenTree = await git(this.root, ['write-tree']);
    if (writtenTree.code !== 0) return { success: false, commitRevision: null, outOfDate: false, errorOutput: describeProcess(writtenTree) };
    const tree = writtenTree.stdout.trim();
    const parents = [input.preHead, ...input.mergedParents];
    const parentArgs = parents.flatMap((p) => ['-p', p]);
    const commitArgs = ['commit-tree', tree, ...parentArgs, '-m', input.message];
    const created = await git(this.root, commitArgs);
    const oid = created.stdout.trim();
    if (created.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(oid)) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: describeProcess(created) };
    }
    const updated = await git(this.root, ['update-ref', target.ref, oid, target.base]);
    if (updated.code !== 0) {
      const output = describeProcess(updated);
      return {
        success: false,
        commitRevision: null,
        outOfDate: /cannot lock ref|lock|expected/i.test(output),
        errorOutput: output,
      };
    }
    await git(this.root, ['reset', '--mixed', '-q', oid]).catch(() => undefined);
    return { success: true, commitRevision: oid, outOfDate: false, errorOutput: '' };
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
        return { base: before, synced: false, failed: true, message: `同步失败：${describeProcess(fetch)}` };
      }
      const current = await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const onBranch = current.code === 0 && current.stdout.trim() === this.baseBranch;
      if (onBranch) {
        // 已显式 fetch origin <baseBranch> 至 FETCH_HEAD，直接 ff-only 合并以避免无 upstream tracking 报错
        const merge = await git(this.root, ['merge', '--ff-only', 'FETCH_HEAD']);
        if (merge.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describeProcess(merge)}` };
      } else {
        const advance = await git(this.root, ['fetch', 'origin', `${this.baseBranch}:${this.baseBranch}`]);
        if (advance.code !== 0) return { base: before, synced: false, failed: true, message: `同步失败：${describeProcess(advance)}` };
      }
      const head = await git(this.root, ['rev-parse', this.baseBranch]);
      if (head.code !== 0) {
        return { base: null, synced: false, uncertain: true, message: `同步后无法读取 ${this.baseBranch} 基线：${describeProcess(head)}` };
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
      return { base: before, synced: false, failed: true, message: `同步失败：${describeProcess(pull)}` };
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
        return { ok: false, conflict: true, message: tailLines(describeProcess(check), 80) };
      }
      const apply = await git(this.root, ['apply', '--binary', patchPath]);
      return apply.code === 0
        ? { ok: true, conflict: false, message: '补丁已应用到工作区' }
        : { ok: false, conflict: true, message: tailLines(describeProcess(apply), 80) };
    }
    const apply = await git(this.root, args);
    return apply.code === 0
      ? { ok: true, conflict: false, message: '补丁已三方应用' }
      : { ok: false, conflict: true, message: tailLines(describeProcess(apply), 80) };
  }

  async applyPatchForApproval(patchPath: string, signal?: AbortSignal): Promise<ApprovalPatchAttempt> {
    const options = {
      cwd: this.root,
      timeoutMs: VCS_TIMEOUT_MS,
      env: { LC_ALL: 'C' },
      ...(signal ? { signal } : {}),
    };
    const checked = await runProcess('git', ['apply', '--check', '--binary', '--', patchPath], options);
    if (checked.code !== 0) {
      return {
        ok: false,
        conflict: checked.code !== null,
        workspace: 'untouched',
        canMerge: checked.code === 1
          && /^error: patch failed:/m.test(checked.stderr)
          && !checked.stderr.split(/\r?\n/).some((line) => line.startsWith('error:')
            && !/^error: (?:patch failed:|.+: patch does not apply$)/.test(line)),
        message: tailLines(describeProcess(checked), 80),
      };
    }
    const applied = await runProcess('git', ['apply', '--binary', '--', patchPath], options);
    return applied.code === 0
      ? { ok: true, conflict: false, workspace: 'applied', message: '补丁已应用到工作区' }
      : { ok: false, conflict: false, workspace: 'unknown', message: tailLines(describeProcess(applied), 80) };
  }

  async checkPatch(patchPath: string): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const check = await git(this.root, ['apply', '--check', '--binary', patchPath]);
    return check.code === 0
      ? { ok: true, conflict: false, message: '补丁可应用到当前基线' }
      : { ok: false, conflict: true, message: tailLines(describeProcess(check), 40) };
  }

  async exportWorkingTreeDiff(base: string, paths: string[]): Promise<string> {
    const rel = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)).filter((item) => item.length > 0))];
    if (rel.length === 0) return '';
    await git(this.root, ['add', '-N', '--', ...rel]).catch(() => undefined);
    const diff = await git(this.root, ['diff', '--binary', '--no-ext-diff', base, '--', ...rel]);
    await git(this.root, ['reset', '-q', '--', ...rel]).catch(() => undefined);
    if (diff.code !== 0) throw new Error(`导出工作区 diff 失败：${describeProcess(diff)}`);
    return diff.stdout;
  }

  async revertBusinessWorkspace(): Promise<void> {
    const reset = await git(this.root, ['reset', '-q', '--', '.']);
    if (reset.code !== 0) throw new Error(`git reset 失败：${describeProcess(reset)}`);
    const checkout = await git(this.root, ['checkout', '--', '.', ':(exclude).ai-review']);
    if (checkout.code !== 0 && !/did not match any file\(s\) known to git/i.test(checkout.stderr)) {
      throw new Error(`git checkout 还原业务目录失败：${describeProcess(checkout)}`);
    }
    const clean = await git(this.root, ['clean', '-fdq', '-e', '.ai-review']);
    if (clean.code !== 0) throw new Error(`git clean 清理未跟踪文件失败：${describeProcess(clean)}`);
    await rm(path.join(this.root, '.tmp'), { recursive: true, force: true });
  }

  private async withWorktree<T>(base: string, run: (dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(tmpdir(), 'dsh-code-review-diff', randomUUID());
    await mkdir(path.dirname(dir), { recursive: true });
    const add = await git(this.root, ['worktree', 'add', '--detach', dir, base]);
    if (add.code !== 0) throw new Error(`无法创建临时 worktree：${describeProcess(add)}`);
    try {
      return await run(dir);
    } finally {
      await git(this.root, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async materialize(dir: string, patchPath: string, label: string): Promise<string> {
    const apply = await git(dir, ['apply', '--binary', patchPath]);
    if (apply.code !== 0) throw new Error(`${label}补丁应用失败：${describeProcess(apply)}`);
    await git(dir, ['add', '-A']);
    const commit = await git(dir, [
      '-c', 'user.name=AI Review Diff',
      '-c', 'user.email=ai-review@local',
      'commit', '-q', '--no-verify', '-m', label,
    ]);
    if (commit.code !== 0) throw new Error(`${label}临时提交失败：${describeProcess(commit)}`);
    const head = await git(dir, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }

  /** 将共享快照中的补丁文本落盘到临时目录，确保 /diff 绝不读取工作区未提交磁盘补丁。 */
  private async withTempPatches<T>(
    fromPatchText: string,
    toPatchText: string,
    run: (fromFile: string, toFile: string) => Promise<T>,
  ): Promise<T> {
    const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-diff-patches-'));
    try {
      const fromFile = path.join(scratch, 'from.patch');
      const toFile = path.join(scratch, 'to.patch');
      await writeFile(fromFile, fromPatchText, 'utf8');
      await writeFile(toFile, toPatchText, 'utf8');
      return await run(fromFile, toFile);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff> {
    const sameBase = input.fromBase === input.toBase;
    if (sameBase) {
      try {
        const unifiedDiff = await this.withTempPatches(input.fromPatchText, input.toPatchText, (fromFile, toFile) =>
          this.withWorktree(input.fromBase, async (dir) => {
            const left = await this.materialize(dir, fromFile, `rev ${String(input.fromRevision)}`);
            await git(dir, ['reset', '--hard', input.fromBase]);
            await git(dir, ['clean', '-fdq', '-e', '.ai-review']);
            const right = await this.materialize(dir, toFile, `rev ${String(input.toRevision)}`);
            const diff = await git(dir, ['diff', '--no-ext-diff', '--binary', left, right]);
            if (diff.code !== 0) throw new Error(describeProcess(diff));
            return diff.stdout;
          }),
        );
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
      const unifiedDiff = await this.withTempPatches(input.fromPatchText, input.toPatchText, (fromFile, toFile) =>
        this.withWorktree(input.toBase, async (dir) => {
          const appliable = await git(dir, ['apply', '--3way', '--binary', fromFile]);
          if (appliable.code !== 0) {
            throw new Error(`旧补丁无法三方应用：${describeProcess(appliable)}`);
          }
          await git(dir, ['add', '-A']);
          const commit = await git(dir, [
            '-c', 'user.name=AI Review Diff',
            '-c', 'user.email=ai-review@local',
            'commit', '-q', '--no-verify', '-m', `rev ${String(input.fromRevision)} on ${input.toBase}`,
          ]);
          if (commit.code !== 0) throw new Error(`旧版本临时提交失败：${describeProcess(commit)}`);
          const left = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
          await git(dir, ['reset', '--hard', input.toBase]);
          await git(dir, ['clean', '-fdq', '-e', '.ai-review']);
          const right = await this.materialize(dir, toFile, `rev ${String(input.toRevision)}`);
          const diff = await git(dir, ['diff', '--no-ext-diff', '--binary', left, right]);
          if (diff.code !== 0) throw new Error(describeProcess(diff));
          return diff.stdout;
        }),
      );
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
    if (input.gitTarget && !(await this.matchesApprovalTarget(input.gitTarget))) {
      return { success: false, commitRevision: null, outOfDate: false, targetChanged: true, errorOutput: 'Git 审批目标引用或基线已变化' };
    }
    const paths = input.paths.filter((item) => item.trim().length > 0);
    const deletions = (input.deletePaths ?? []).filter((item) => item.trim().length > 0);
    const stagingPaths = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)))];
    const deletionPaths = [...new Set(deletions.map((item) => normalizeCommitPath(this.root, item)))];
    const allowed = [...new Set([...stagingPaths, ...deletionPaths])];
    if (allowed.length === 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: '没有指定要提交的路径' };
    }
    for (const deletion of deletions) {
      const absolute = path.isAbsolute(deletion) ? deletion : path.join(this.root, deletion);
      await rm(absolute, { force: true }).catch(() => undefined);
    }
    const fail = async (errorOutput: string): Promise<CommitResult> => {
      // 回退本次暂存范围，保留范围外原先存在的索引条目。
      await git(this.root, ['reset', '-q', '--', ...allowed]).catch(() => undefined);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput };
    };
    const add = await git(this.root, ['add', '-A', '--', ...allowed]);
    if (add.code !== 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: describeProcess(add) };
    }
    const planned = input.gitTarget ? await git(this.root, ['write-tree']) : undefined;
    if (planned && (planned.code !== 0 || !/^(?:[\da-f]{40}|[\da-f]{64})$/.test(planned.stdout.trim()))) {
      return fail(`无法写出审批提交树：${describeProcess(planned)}`);
    }
    const tree = planned?.stdout.trim();
    const stagedDiff = (args: string[]): Promise<ProcessResult> => (input.gitTarget && tree
      ? git(this.root, ['diff-tree', '-r', ...args, input.gitTarget.base, tree])
      : git(this.root, ['diff', '--cached', ...args]));
    const stagedList = await stagedDiff(['--name-only', '-z']);
    if (stagedList.code !== 0) {
      return fail(`无法读取暂存区，拒绝提交：${describeProcess(stagedList)}`);
    }
    const stagedFiles = stagedList.stdout.split('\0').map((line) => line.trim()).filter((line) => line.length > 0);
    const unexpected = stagedFiles.filter((line) => !allowed.some((item) => line === item || line.startsWith(`${item}/`)));
    if (unexpected.length > 0) {
      return fail(`暂存区包含指定路径之外的条目，已拒绝提交：\n${unexpected.slice(0, 20).join('\n')}`);
    }
    const indexResult = await git(this.root, ['ls-files', '-s', '-z', '--', ...allowed]);
    if (indexResult.code !== 0) {
      return fail(`无法读取索引，拒绝提交：${describeProcess(indexResult)}`);
    }
    const verifiedTree = tree
      ? await git(this.root, ['ls-tree', '-rz', '--format=%(objectmode) %(objectname) 0%x09%(path)', tree, '--', ...allowed])
      : undefined;
    if (verifiedTree && verifiedTree.code !== 0) return fail(`无法核对审批提交树：${describeProcess(verifiedTree)}`);
    const index = parseStagedIndex(verifiedTree?.stdout ?? indexResult.stdout);
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
      const changed = await stagedDiff(['--name-status', '-z']);
      if (changed.code !== 0) {
        return fail(`无法读取暂存变更，拒绝提交：${describeProcess(changed)}`);
      }
      const tokens = changed.stdout.split('\0');
      for (let idx = 0; idx < tokens.length;) {
        const status = tokens[idx] ?? '';
        idx += 1;
        if (!status) continue;
        const takesTwoPaths = status.startsWith('R') || status.startsWith('C');
        const first = tokens[idx] ?? '';
        idx += 1;
        const second = takesTwoPaths ? (tokens[idx] ?? '') : '';
        if (takesTwoPaths) idx += 1;
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
    const staged = await stagedDiff(['--quiet']);
    if (staged.code === 0) {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: '没有可提交的改动' };
    }
    if (staged.code !== 1) return fail(`无法确认提交树差异：${describeProcess(staged)}`);
    const restorePreparation = async (): Promise<void> => {
      const current = await git(this.root, ['ls-files', '-s', '-z', '--', ...allowed]);
      if (current.code !== 0 || current.stdout !== indexResult.stdout) throw new Error('提交失败后本轮暂存项发生变化');
      const restored = await git(this.root, ['reset', '-q', '--', ...allowed]);
      if (restored.code !== 0) throw new Error(`无法撤销本轮暂存项：${describeProcess(restored)}`);
    };
    if (input.gitTarget && tree) {
      const result = await this.commitApprovedTree(input.gitTarget, tree, input.message);
      return result.success ? result : { ...result, restorePreparation };
    }
    const commit = await git(this.root, ['commit', '-m', input.message]);
    if (commit.code !== 0) {
      const output = describeProcess(commit);
      return {
        success: false,
        commitRevision: null,
        outOfDate: /index\.lock|cannot lock ref|unable to create.*lock|Another git process/i.test(output),
        errorOutput: output,
        restorePreparation,
      };
    }
    const head = await git(this.root, ['rev-parse', 'HEAD']);
    return { success: true, commitRevision: head.code === 0 ? head.stdout.trim() : null, outOfDate: false, errorOutput: '' };
  }
}
