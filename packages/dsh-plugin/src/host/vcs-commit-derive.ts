/**
 * 批准提交派生（AC-APPROVE-01 / SPEC §4.4）：
 * 按具体批准快照身份精确派生业务提交，核验 business_commit 的历史真实性与祖先关系，
 * 优先按所选方案补丁的业务路径核验，并以目标提交 C 当时的 review.md 补丁账本检查补丁留存。
 */

import { parseReviewMarkdown } from './frontmatter.js';
import {
  approvalIdentityKey,
  decodeSvnPath,
  describeProcess,
  extractReviewApproval,
  git,
  svn,
  svnRepoPath,
  toRepoRelative,
  type ApprovalDeriveInput,
  type VcsAdapter,
} from './vcs-types.js';
import { isGitAncestor } from './vcs-mode-c.js';
import type { ApprovalCommitLookup } from './types.js';

function reviewDirPrefix(reviewPath: string): string {
  const normalized = toRepoRelative(reviewPath);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function patchPathsFromReviewText(reviewPath: string, reviewText: string | null, fallback: string[]): string[] {
  if (!reviewText) return fallback;
  try {
    const parsed = parseReviewMarkdown(reviewText);
    const dir = reviewDirPrefix(reviewPath);
    return parsed.meta.patches.map((p) => (dir ? `${dir}/${p.patch}` : p.patch));
  } catch {
    return fallback;
  }
}

export async function deriveGitApprovalCommit(
  vcs: VcsAdapter,
  input: ApprovalDeriveInput,
): Promise<ApprovalCommitLookup> {
  const deliveryPaths = (input.approvedPatchPaths && input.approvedPatchPaths.length > 0
    ? input.approvedPatchPaths
    : input.targetFiles
  ).map(toRepoRelative).filter(Boolean);

  const reviewProbe = await vcs.getCommitProbe([input.reviewPath]);
  const targetApproval = input.approval ?? extractReviewApproval(
    reviewProbe ? await vcs.readFileAt(reviewProbe, input.reviewPath) : null,
  );
  if (!targetApproval) {
    return { revision: null, lookup: 'unknown', diagnostic: '无法读取已批准快照，无法派生业务提交' };
  }

  // 特殊路径：Mode C 提前推送分支写入了 business_commit，核验存在、位于当前历史祖先链且触及交付路径
  if (targetApproval.businessCommit) {
    const bizCommit = targetApproval.businessCommit.trim();
    const verified = await git(vcs.root, ['rev-parse', '--verify', `${bizCommit}^{commit}`]);
    if (verified.code !== 0) {
      return { revision: null, lookup: 'unknown', diagnostic: `business_commit ${bizCommit} 不存在于当前 Git 历史` };
    }
    const resolvedCommit = verified.stdout.trim();
    const headRef = reviewProbe ?? 'HEAD';
    if (!(await isGitAncestor(vcs.root, resolvedCommit, headRef))) {
      return {
        revision: null,
        lookup: 'unknown',
        diagnostic: `business_commit ${resolvedCommit} 不在当前共享历史（${headRef.slice(0, 12)}）的祖先链中`,
      };
    }
    const paths = await vcs.listCommitPaths?.(resolvedCommit);
    if (!paths || !deliveryPaths.some((file) => paths.includes(file))) {
      return { revision: null, lookup: 'unknown', diagnostic: `business_commit ${resolvedCommit} 未触及已批准业务路径` };
    }
    return { revision: resolvedCommit, lookup: 'found' };
  }

  const expectedKey = approvalIdentityKey(targetApproval);
  const history = await git(vcs.root, ['log', '-m', '--format=%H', '--', input.reviewPath]);
  if (history.code !== 0) {
    return { revision: null, lookup: 'unknown', diagnostic: `历史不可读：${describeProcess(history)}` };
  }
  const commits = [...new Set(history.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  const matches: string[] = [];
  let shallowSkipped = false;

  for (const commit of commits) {
    const reviewTextAtCommit = await vcs.readFileAt(commit, input.reviewPath);
    const currentApproval = extractReviewApproval(reviewTextAtCommit);
    if (!currentApproval || approvalIdentityKey(currentApproval) !== expectedKey) continue;

    const parentList = await git(vcs.root, ['show', '-s', '--format=%P', commit]);
    if (parentList.code !== 0) continue;
    const parents = [...new Set(parentList.stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean))];

    let parentUnreadable = false;
    let parentAlreadyApproved = false;
    for (const parent of parents) {
      const parentExists = await git(vcs.root, ['cat-file', '-e', `${parent}^{commit}`]);
      if (parentExists.code !== 0) {
        parentUnreadable = true;
        break;
      }
      const parentApproval = extractReviewApproval(await vcs.readFileAt(parent, input.reviewPath));
      if (parentApproval && approvalIdentityKey(parentApproval) === expectedKey) {
        parentAlreadyApproved = true;
        break;
      }
    }
    if (parentUnreadable) {
      shallowSkipped = true;
      continue;
    }
    if (parentAlreadyApproved) continue;

    // 仅校验目标提交 C 当时的 review.md 所声明的补丁文件（避免重开追加新补丁后破坏旧批准派生）
    const expectedPatchesAtCommit = patchPathsFromReviewText(input.reviewPath, reviewTextAtCommit, input.patchPaths);
    let allPatchesPresent = true;
    for (const patchPath of expectedPatchesAtCommit) {
      const exists = await git(vcs.root, ['cat-file', '-e', `${commit}:${toRepoRelative(patchPath)}`]);
      if (exists.code !== 0) {
        allPatchesPresent = false;
        break;
      }
    }
    if (!allPatchesPresent) continue;

    const changed = await vcs.listCommitPaths?.(commit);
    if (!changed) continue;
    const changedSet = new Set(changed);
    if (!changedSet.has(toRepoRelative(input.reviewPath))) continue;
    if (!deliveryPaths.some((file) => changedSet.has(file))) continue;
    matches.push(commit);
  }

  if (matches.length === 1 && matches[0] !== undefined) return { revision: matches[0], lookup: 'found' };
  if (matches.length > 1) {
    return { revision: null, lookup: 'ambiguous', diagnostic: `${String(matches.length)} 个提交同时满足派生条件，需人工确认` };
  }
  if (shallowSkipped) {
    return { revision: null, lookup: 'unknown', diagnostic: '浅克隆缺少父提交对象，无法证明批准提交唯一性' };
  }
  return { revision: null, lookup: 'unknown', diagnostic: '历史中未找到满足条件的批准提交' };
}

export async function deriveSvnApprovalCommit(
  vcs: VcsAdapter,
  input: ApprovalDeriveInput,
): Promise<ApprovalCommitLookup> {
  const relativeUrl = await svn(vcs.root, ['info', '--show-item', 'relative-url', '--', '.']);
  const prefix = relativeUrl.code === 0 ? relativeUrl.stdout.trim() : '';
  if (!prefix.startsWith('^/')) {
    return { revision: null, lookup: 'unknown', diagnostic: `无法读取 SVN 仓库相对 URL，不能精确匹配路径：${describeProcess(relativeUrl)}` };
  }
  const deliveryPaths = (input.approvedPatchPaths && input.approvedPatchPaths.length > 0
    ? input.approvedPatchPaths
    : input.targetFiles
  ).map(toRepoRelative).filter(Boolean);
  const targetRepoPaths = deliveryPaths.map((target) => svnRepoPath(prefix, target));

  const reviewRepoPath = svnRepoPath(prefix, input.reviewPath);
  const probe = await vcs.getCommitProbe([input.reviewPath]);
  const targetApproval = input.approval ?? extractReviewApproval(
    probe ? await vcs.readFileAt(probe, input.reviewPath) : null,
  );
  if (!targetApproval) {
    return { revision: null, lookup: 'unknown', diagnostic: '无法读取已批准快照，无法派生业务提交' };
  }

  if (targetApproval.businessCommit) {
    const rev = targetApproval.businessCommit.trim();
    if (!/^\d+$/.test(rev)) {
      return { revision: null, lookup: 'unknown', diagnostic: `business_commit 格式无效：${rev}` };
    }
    const revLog = await svn(vcs.root, ['log', '-v', '--xml', '-r', rev]);
    if (revLog.code !== 0 || !revLog.stdout.includes(`revision="${rev}"`)) {
      return { revision: null, lookup: 'unknown', diagnostic: `SVN 历史中不存在版本 r${rev}` };
    }
    const touchedPaths = [...revLog.stdout.matchAll(/<path\b[^>]*\baction="([AMDR])"[^>]*>([^<]+)<\/path>/g)]
      .map((match) => decodeSvnPath((match[2] ?? '').trim()));
    if (!targetRepoPaths.some((target) => touchedPaths.includes(target))) {
      return { revision: null, lookup: 'unknown', diagnostic: `SVN r${rev} 未触及已批准业务路径` };
    }
    return { revision: rev, lookup: 'found' };
  }

  const expectedKey = approvalIdentityKey(targetApproval);
  const normalizedReview = toRepoRelative(input.reviewPath);
  const dir = normalizedReview.includes('/') ? normalizedReview.slice(0, normalizedReview.lastIndexOf('/')) : normalizedReview;
  const log = await svn(vcs.root, ['log', '-v', '--xml', '-r', 'HEAD:1', '--', dir]);
  if (log.code !== 0) return { revision: null, lookup: 'unknown', diagnostic: `svn log 不可读：${describeProcess(log)}` };

  const entries = [...log.stdout.matchAll(/<logentry\s+revision="(\d+)"[\s\S]*?<\/logentry>/g)];
  const matches: string[] = [];
  for (const entry of entries) {
    const revision = entry[1] ?? '';
    const body = entry[0] ?? '';
    const paths = [...body.matchAll(/<path\b[^>]*\baction="([AMDR])"[^>]*>([^<]+)<\/path>/g)]
      .map((match) => ({ action: match[1] ?? '', path: decodeSvnPath((match[2] ?? '').trim()) }));
    const reviewModified = paths.some((item) => item.action === 'M' && item.path === reviewRepoPath);
    const touchesTarget = targetRepoPaths.some((target) => paths.some((item) => item.path === target));
    if (reviewModified && touchesTarget) matches.push(revision);
  }

  const verified: string[] = [];
  for (const revision of matches) {
    const reviewTextAtCommit = await vcs.readFileAt(revision, input.reviewPath);
    const currentApproval = extractReviewApproval(reviewTextAtCommit);
    if (!currentApproval || approvalIdentityKey(currentApproval) !== expectedKey) continue;
    const prevRev = Number(revision) - 1;
    if (prevRev >= 1) {
      const parentApproval = extractReviewApproval(await vcs.readFileAt(String(prevRev), input.reviewPath));
      if (parentApproval && approvalIdentityKey(parentApproval) === expectedKey) continue;
    }
    const expectedPatchesAtCommit = patchPathsFromReviewText(input.reviewPath, reviewTextAtCommit, input.patchPaths);
    if ((await Promise.all(expectedPatchesAtCommit.map((file) => vcs.readFileAt(revision, file)))).some((text) => text === null)) {
      continue;
    }
    verified.push(revision);
  }

  if (verified.length === 1) return { revision: verified[0] ?? null, lookup: 'found' };
  if (verified.length > 1) return { revision: null, lookup: 'ambiguous', diagnostic: `${String(verified.length)} 个提交同时满足派生条件，需人工确认` };
  return { revision: null, lookup: 'unknown', diagnostic: '路径历史中未找到满足条件的批准提交' };
}
