/**
 * Git Mode C 物理拓扑净改动计算（AC-REPAIR-ASSIST / I19）：
 * 核验 preHead 为 postHead 祖先、全部合并父提交均可追溯至启动前既有分支/远端，
 * 在多父合并场景下仅排除单源或完全一致收敛的无冲突纯继承文件，并纳入工作区/未跟踪/.tmp 改动。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  describeProcess,
  git,
  hasTmpDir,
  parseGitPorcelainZ,
  toRepoRelative,
  type ModeCTopologyCheck,
} from './vcs-types.js';

export async function hasActiveGitOp(root: string): Promise<boolean> {
  const sequencer = await git(root, [
    'rev-parse',
    ...['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
      .flatMap((file) => ['--git-path', file]),
  ]);
  if (sequencer.code !== 0) return true;
  const paths = sequencer.stdout.trimEnd().split(/\r?\n/);
  return paths.some((file) => file.length > 0 && existsSync(path.resolve(root, file)));
}

export async function isGitAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.code === 0;
}

/** 返回 mode:type:oid 完整树条目签名；使用 --literal-pathspecs 并严格核对路径精确相等，防 glob 误命中。 */
async function treeEntryAtCommit(root: string, revision: string, relPath: string): Promise<string | null> {
  const normalized = toRepoRelative(relPath);
  const result = await git(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', revision, '--', normalized]);
  if (result.code !== 0 || !result.stdout) return null;
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const entryPath = toRepoRelative(record.slice(tab + 1));
    if (entryPath !== normalized) continue;
    const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]+)$/.exec(record.slice(0, tab));
    if (match) return `${match[1]}:${match[2]}:${match[3]}`;
  }
  return null;
}

export async function computeGitModeCNetChangedPaths(
  root: string,
  preHead: string,
  postHead: string,
  trustedUpstreamTips?: readonly string[],
): Promise<ModeCTopologyCheck> {
  const fail = (diagnostic: string, aiReviewTouched = false): ModeCTopologyCheck => ({
    ok: false,
    preHead,
    postHead,
    netChangedPaths: [],
    mergedParents: [],
    commitCount: 0,
    aiReviewTouched,
    diagnostic,
  });

  if (await hasActiveGitOp(root)) return fail('存在未完成的 merge/rebase/cherry-pick/revert 操作');
  if (!(await isGitAncestor(root, preHead, postHead))) {
    return fail('Mode C 改写了既有提交历史（preHead 不是 postHead 的祖先）');
  }

  // 仅沿 first-parent 链路枚举本地提交，避免将合入的上游分支提交误判为本地区间内提交
  const revList = await git(root, ['rev-list', '--first-parent', '--parents', `${preHead}..${postHead}`]);
  if (revList.code !== 0) return fail(`无法读取提交拓扑：${describeProcess(revList)}`);
  const lines = revList.stdout.trim().split(/\r?\n/).filter(Boolean);
  const inRange = new Set<string>();
  const parsedCommits: Array<{ oid: string; parents: string[] }> = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const oid = parts[0];
    if (!oid) continue;
    inRange.add(oid);
    parsedCommits.push({ oid, parents: parts.slice(1) });
  }

  const mergedParents: string[] = [];
  const seenParents = new Set<string>();
  for (const commit of parsedCommits) {
    for (const parent of commit.parents.slice(1)) {
      if (!inRange.has(parent) && parent !== preHead && !seenParents.has(parent)) {
        const exists = await git(root, ['cat-file', '-e', `${parent}^{commit}`]);
        if (exists.code !== 0) return fail(`合并父提交 ${parent} 无效或不可追溯`);
        if (trustedUpstreamTips !== undefined) {
          let traceable = false;
          for (const tip of trustedUpstreamTips) {
            if (tip === parent || (await isGitAncestor(root, parent, tip))) {
              traceable = true;
              break;
            }
          }
          if (!traceable) {
            return fail(`合并父提交 ${parent} 无法追溯至 Mode C 启动前既有分支或远端提交（禁止自建侧分支绕过护栏）`);
          }
        }
        seenParents.add(parent);
        mergedParents.push(parent);
      }
    }
  }

  // 检查 .ai-review/ 是否在提交区间或工作区被改动
  const aiDiff = await git(root, ['diff', '--name-only', preHead, '--', '.ai-review']);
  const aiStatus = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.ai-review']);
  const aiReviewTouched = (aiDiff.stdout.trim().length > 0) || (aiStatus.stdout.length > 0);

  // 工作区相对 postHead 的未提交改动与 .tmp/ 始终属于净改动（即便存在上游合并也不得被 tree 继承逻辑掩盖）
  const worktreeRelativeToPost = new Set<string>();
  const statusNow = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (statusNow.code !== 0) return fail(`无法读取工作区状态：${describeProcess(statusNow)}`, aiReviewTouched);
  for (const entry of parseGitPorcelainZ(statusNow.stdout)) {
    if (!entry.startsWith('.ai-review/') && entry !== '.ai-review') worktreeRelativeToPost.add(entry);
  }
  if (await hasTmpDir(root)) {
    worktreeRelativeToPost.add('.tmp');
  }

  // 收集候选差异文件（preHead -> postHead 以及工作区）
  const candidateFiles = new Set<string>(worktreeRelativeToPost);
  const diffCommitted = await git(root, ['diff', '--name-only', '-z', preHead, postHead]);
  if (diffCommitted.code !== 0) return fail(`无法读取与 preHead 的差异：${describeProcess(diffCommitted)}`, aiReviewTouched);
  for (const entry of diffCommitted.stdout.split('\0').map((s) => s.trim()).filter(Boolean)) {
    if (!entry.startsWith('.ai-review/') && entry !== '.ai-review') candidateFiles.add(toRepoRelative(entry));
  }

  if (mergedParents.length === 0) {
    return {
      ok: true,
      preHead,
      postHead,
      netChangedPaths: [...candidateFiles].sort(),
      mergedParents: [],
      commitCount: parsedCommits.length,
      aiReviewTouched,
    };
  }

  // 含分支合并：计算每个 mergedParent 对应的 mergeBase，严格收敛多父继承判定
  const parentBases: Array<{ parent: string; base: string }> = [];
  for (const parent of mergedParents) {
    const mb = await git(root, ['merge-base', preHead, parent]);
    if (mb.code !== 0 || !mb.stdout.trim()) return fail(`无法计算 preHead 与 ${parent} 的 merge-base`, aiReviewTouched);
    parentBases.push({ parent, base: mb.stdout.trim() });
    const diffParent = await git(root, ['diff', '--name-only', '-z', parent, postHead]);
    if (diffParent.code === 0) {
      for (const entry of diffParent.stdout.split('\0').map((s) => s.trim()).filter(Boolean)) {
        if (!entry.startsWith('.ai-review/') && entry !== '.ai-review') candidateFiles.add(toRepoRelative(entry));
      }
    }
  }

  const netChangedPaths: string[] = [];
  for (const file of candidateFiles) {
    // 若该文件在工作区相对 postHead 仍有未提交改动，必定计入净改动
    if (worktreeRelativeToPost.has(file)) {
      netChangedPaths.push(file);
      continue;
    }
    const [preBlob, postBlob] = await Promise.all([
      treeEntryAtCommit(root, preHead, file),
      treeEntryAtCommit(root, postHead, file),
    ]);
    const parentStates = await Promise.all(
      parentBases.map(async ({ parent, base }) => ({
        parentBlob: await treeEntryAtCommit(root, parent, file),
        baseBlob: await treeEntryAtCommit(root, base, file),
      })),
    );
    const inheritedFromLocal = postBlob === preBlob
      && parentStates.every(({ parentBlob, baseBlob }) => parentBlob === baseBlob);

    // 多父合并下，仅当所有相对自身 merge-base 有变动的上游父提交收敛到同一内容且本地相对对应 merge-base 无改动，
    // 且 postBlob 精确等于该收敛内容时，才视为纯上游继承（防止借 U2 覆盖 U1 的变动绕过护栏）
    const changedUpstreams = parentStates.filter(({ parentBlob, baseBlob }) => parentBlob !== baseBlob);
    const inheritedFromUpstream = changedUpstreams.length > 0
      && changedUpstreams.every(({ baseBlob }) => preBlob === baseBlob)
      && changedUpstreams.every(({ parentBlob }) => parentBlob === changedUpstreams[0]!.parentBlob)
      && postBlob === changedUpstreams[0]!.parentBlob;

    if (!inheritedFromLocal && !inheritedFromUpstream) {
      netChangedPaths.push(file);
    }
  }

  return {
    ok: true,
    preHead,
    postHead,
    netChangedPaths: netChangedPaths.sort(),
    mergedParents,
    commitCount: parsedCommits.length,
    aiReviewTouched,
  };
}
