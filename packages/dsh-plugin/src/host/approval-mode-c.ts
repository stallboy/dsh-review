/**
 * Mode C 获批辅助应用与物理拓扑硬护栏（SPEC §5.5 步骤 7 / AC-REPAIR-ASSIST / I19）：
 * 涵盖 Case A（工作区适配）、Case B-本地（本地提交/合并）、Case B-已推送（严禁强推）以及实质变化回退重审。
 */

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { stampSvnApprovalSource } from './approval-merge-snapshots.js';
import { auditFiles } from './audit-files.js';
import { commitWithThreeBranchRecovery } from './commit-recovery.js';
import { isRepoRelativePath } from './invariants.js';
import { nextUpdatedAt, sha256Hex } from './issue-review.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import {
  buildModeCPrompt,
  loadModeCSystemPrompt,
  parseModeCOutput,
  runAgent,
  wrapAgentPrompt,
} from './runner.js';
import { gitBlobHash, type RemoteRefTipsResult, type RemoteTipResult } from './vcs.js';
import type { ApprovalOutcome, PatchEntry, ReviewFrontmatter } from './types.js';
import {
  digestAiReviewDir,
  hasSymlinkEscape,
  revertAndVerifyClean,
  type ApprovalDeps,
  type LocalModeCState,
  type PushedModeCState,
  type ValidatedSnapshot,
} from './approval-preconditions.js';

export type ModeCAssistOutcome =
  | {
    kind: 'applied';
    applySummary: string;
    localModeC: LocalModeCState | null;
    pushedModeC: PushedModeCState | null;
  }
  | {
    kind: 'terminal';
    outcome: ApprovalOutcome;
  };

export async function runModeCAssist(params: {
  deps: ApprovalDeps;
  snapshot: ValidatedSnapshot;
  currentBase: string;
  conflictMessage: string;
  preHead: string;
  preBranch: string | null;
  preRemoteTip: RemoteTipResult | null;
  preAllRefTips: Map<string, string>;
  preRemoteRefTips: RemoteRefTipsResult | null;
  preAiReviewDigest: string;
}): Promise<ModeCAssistOutcome> {
  const {
    deps,
    snapshot,
    currentBase,
    conflictMessage,
    preHead,
    preBranch,
    preRemoteTip,
    preAllRefTips,
    preRemoteRefTips,
    preAiReviewDigest,
  } = params;
  const { store, vcs, settings, jobId, log } = deps;
  const { candidate, option, patchEntry, patchText, approvedPatchPaths } = snapshot;

  const abort = (reason: Extract<ApprovalOutcome, { status: 'ABORTED' }>['reason'], message: string, detail?: string): ModeCAssistOutcome => ({
    kind: 'terminal',
    outcome: { status: 'ABORTED', jobId, reason, ...(detail ? { detail } : {}), message },
  });

  const recover = async (
    reason: Extract<ApprovalOutcome, { status: 'RECOVERY_REQUIRED' }>['reason'],
    detail: string,
    message?: string,
  ): Promise<ModeCAssistOutcome> => {
    await deps.recoveryStore?.markRecoveryRequired(vcs.root, {
      kind: 'approve',
      reason,
      detail,
      jobId,
      candidateId: candidate.id,
    });
    return {
      kind: 'terminal',
      outcome: { status: 'RECOVERY_REQUIRED', jobId, reason, detail, message: message ?? `批准进入恢复态：${detail}` },
    };
  };

  const modeCPrompt = wrapAgentPrompt(
    await loadModeCSystemPrompt(),
    buildModeCPrompt({
      candidate,
      option,
      patchEntry,
      patchText,
      approvedPatchPaths,
      targetBase: currentBase,
      conflictMessage,
      vcsType: vcs.type,
      repoRoot: vcs.root,
    }),
  );

  if (!settings.autoFixOnFailure || settings.runner === 'manual') {
    const reverted = await revertAndVerifyClean({
      vcs,
      preHead,
      preBranch,
      preAiReviewDigest,
    });
    if (!reverted.ok) {
      return recover('RESTORE_INCOMPLETE', reverted.detail);
    }
    return {
      kind: 'terminal',
      outcome: {
        status: 'FALLBACK_TO_PENDING',
        jobId,
        reason: 'PATCH_CONFLICT',
        ...(settings.runner === 'manual' ? { manualPrompt: modeCPrompt } : {}),
        message: `补丁程序性应用受阻（${conflictMessage.slice(0, 300)}），已回退待审核`,
      },
    };
  }

  log('程序性应用受阻，唤起修复 Agent（Mode C：完整权限辅助应用 / 分支合并）');
  const modeCResult = deps.runModeC
    ? await deps.runModeC({ prompt: modeCPrompt, cwd: vcs.root, signal: deps.signal })
    : await runAgent({
      kind: settings.runner === 'dsh' ? 'dsh' : 'external',
      settings,
      cwd: vcs.root,
      prompt: modeCPrompt,
      log,
      timeoutMs: 30 * 60_000,
      label: 'Mode C 获批辅助',
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.resolveCredential ? { resolveCredential: deps.resolveCredential } : {}),
    });

  const verdict = parseModeCOutput(modeCResult.assistantText || modeCResult.outputTail);
  const postHead = await vcs.getCurrentBase();
  const postBranch = vcs.type === 'git' ? (await vcs.getCurrentBranch?.()) ?? null : null;
  const postRemoteTipRes = vcs.type === 'git' && vcs.getRemoteTip
    ? await vcs.getRemoteTip(preBranch ?? undefined)
    : null;
  const postRemoteRefTipsRes = vcs.type === 'git' && vcs.listRemoteRefTips
    ? await vcs.listRemoteRefTips()
    : null;

  // 若 Mode C 推进了本地历史或存在远端，但远端探针失败，严禁假定未推送而直接 reset/回滚
  const hadRemotes = preRemoteRefTips?.ok ? preRemoteRefTips.hasRemotes : Boolean(preRemoteRefTips);
  if (vcs.type === 'git' && ((postRemoteRefTipsRes && !postRemoteRefTipsRes.ok) || (postRemoteTipRes && !postRemoteTipRes.ok))) {
    if (postHead !== preHead || hadRemotes) {
      const errDetail = (!postRemoteRefTipsRes?.ok ? postRemoteRefTipsRes?.error : '')
        || (!postRemoteTipRes?.ok ? postRemoteTipRes?.error : '')
        || '远端状态不可读';
      return recover('SYNC_STATE_UNKNOWN', `Mode C 结束后无法核验远端引用（${errDetail}），严禁盲目回滚，已保留现场`);
    }
  }

  const preRemoteMap = preRemoteRefTips?.ok ? preRemoteRefTips.tips : new Map<string, string>();
  const postRemoteMap = postRemoteRefTipsRes?.ok ? postRemoteRefTipsRes.tips : new Map<string, string>();
  const prePrimaryRemote = preRemoteTip?.ok ? preRemoteTip.remote : null;
  const postPrimaryRemote = postRemoteTipRes?.ok ? postRemoteTipRes.remote : null;

  // 仅当远端引用推进到的新提交存在于本地对象库，且等于 postHead 或以 preHead 为祖先时，才判定为本次 Mode C 推送；
  // 避免其他协作者在无关分支上的并发推送造成误判。
  const changedRemoteRefs: Array<{ ref: string; before: string | undefined; after: string }> = [];
  for (const [refName, afterTip] of postRemoteMap) {
    const beforeTip = preRemoteMap.get(refName);
    if (beforeTip === afterTip) continue;
    const isLocalCommit = await vcs.commitExists?.(afterTip).catch(() => false);
    if (!isLocalCommit) continue;
    const matchesCurrentPush = (postHead !== null && afterTip === postHead)
      || Boolean(await vcs.isAncestor?.(preHead, afterTip).catch(() => false));
    if (matchesCurrentPush) {
      changedRemoteRefs.push({ ref: refName, before: beforeTip, after: afterTip });
    }
  }
  const primaryRemoteAdvanced = Boolean(
    prePrimaryRemote
    && postPrimaryRemote
    && postPrimaryRemote.tip !== prePrimaryRemote.tip
    && (await vcs.commitExists?.(postPrimaryRemote.tip).catch(() => false))
    && ((postHead !== null && postPrimaryRemote.tip === postHead)
      || Boolean(await vcs.isAncestor?.(preHead, postPrimaryRemote.tip).catch(() => false))),
  );
  const remoteAdvanced = primaryRemoteAdvanced || changedRemoteRefs.length > 0;
  const primaryRemoteRef = (primaryRemoteAdvanced ? postPrimaryRemote?.remoteRef : undefined)
    ?? changedRemoteRefs[0]?.ref
    ?? postPrimaryRemote?.remoteRef
    ?? 'origin';

  // 仅采信 Mode C 启动前已存在的本地/远端引用，以及未被本次 Mode C 推进的远端引用（防伪造侧分支绕过护栏）
  const trustedUpstreamTips = new Set<string>([
    ...preAllRefTips.values(),
    ...preRemoteMap.values(),
  ]);
  for (const [refName, tip] of postRemoteMap) {
    if (preRemoteMap.get(refName) === tip) trustedUpstreamTips.add(tip);
  }

  const branchSwitched = vcs.type === 'git' && preBranch !== null && postBranch !== preBranch;
  const postAiReviewDigest = await digestAiReviewDir(vcs.root).catch(() => null);
  const aiReviewTampered = postAiReviewDigest === null || postAiReviewDigest !== preAiReviewDigest;
  const activeGitOp = vcs.type === 'git' ? Boolean(await vcs.hasActiveGitOperation?.()) : false;
  const allowedSet = new Set(approvedPatchPaths);

  const safeRevertOrRecover = async (includeAiReview: boolean): Promise<ModeCAssistOutcome | null> => {
    const res = await revertAndVerifyClean({
      vcs,
      preHead,
      preBranch,
      preAiReviewDigest,
      includeAiReview,
      useResetHard: vcs.type === 'git',
    });
    if (!res.ok) {
      return recover('RESTORE_INCOMPLETE', res.detail);
    }
    return null;
  };

  const exportNewPatchAndFallback = async (summary: string, scopedExportPaths: readonly string[]): Promise<ModeCAssistOutcome> => {
    // SPEC §5.5：先相对 preHead 导出新补丁（Case B 仅导出 netChangedPaths，不混入上游合并文件），再还原业务工作区！
    const safePaths = [...new Set(scopedExportPaths)].filter((p) => isRepoRelativePath(p) && !isAiReviewPath(p));
    let exportedDiff = '';
    try {
      exportedDiff = await vcs.exportWorkingTreeDiff(preHead, safePaths);
    } catch (error) {
      const revertFail = await safeRevertOrRecover(aiReviewTampered);
      if (revertFail) return revertFail;
      return abort('RUNNER_FAILED', `导出 Mode C 实质变更补丁失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const revertFail = await safeRevertOrRecover(aiReviewTampered);
    if (revertFail) return revertFail;

    if (!exportedDiff.trim()) {
      return abort('RUNNER_FAILED', 'Mode C 声明实质变化但未产生有效业务 diff');
    }
    const parsedNew = parsePatch(exportedDiff);
    if (
      parsedNew.paths.length === 0
      || parsedNew.paths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p))
      || parsedNew.unsafeModes.length > 0
    ) {
      return abort('RUNNER_FAILED', 'Mode C 导出的新补丁包含非法路径或禁止文件模式');
    }

    const { id: newPatchId, patch: newPatchName } = store.nextPatchNumber(candidate.meta);
    const relReviewPath = `.ai-review/${candidate.id}/review.md`;
    const relNewPatchPath = `.ai-review/${candidate.id}/${newPatchName}`;
    const newPatchAbs = path.join(candidate.dirPath, newPatchName);
    const newPatchBytes = Buffer.from(exportedDiff, 'utf8');

    await auditFiles(vcs.root, { op: 'write', paths: [relNewPatchPath], text: exportedDiff });
    const check = await vcs.checkPatch(newPatchAbs);
    if (!check.ok) {
      await rm(newPatchAbs, { force: true }).catch(() => undefined);
      return abort('RUNNER_FAILED', `Mode C 导出的新补丁未通过只读预检：${check.message}`);
    }

    const at = nextUpdatedAt(candidate.meta.updatedAt);
    const newPatchEntry: PatchEntry = {
      id: newPatchId,
      patch: newPatchName,
      optionId: option.id,
      baseRevision: preHead,
      author: 'ai',
      sha256: sha256Hex(newPatchBytes),
    };
    if (vcs.type === 'svn') {
      await stampSvnApprovalSource(vcs, newPatchEntry, parsedNew.paths).catch(() => undefined);
    }

    const reviewBackup = (await snapshot.source?.readReviewText(candidate.month, candidate.slug))
      ?? (await readFile(candidate.reviewPath, 'utf8'));
    const mergedTargets = [...new Set([...candidate.meta.targetFiles, ...parsedNew.paths])];
    const nextMeta: ReviewFrontmatter = {
      ...candidate.meta,
      status: 'pending',
      baseRevision: preHead,
      targetFiles: mergedTargets,
      recordRevision: candidate.meta.recordRevision + 1,
      updatedAt: at,
      patches: [...candidate.meta.patches, newPatchEntry],
      options: candidate.meta.options.map((o) => (o.id === option.id ? { ...o, currentPatch: newPatchId } : o)),
    };
    const nextBody = `${candidate.body.trimEnd()}\n\n## 记录版本 ${String(nextMeta.recordRevision)}\n- Mode C 实质变化回退重审：方案 \`${option.id}\` 追加补丁 \`${newPatchName}\`（${summary}）。\n`;
    await store.write({ ...candidate, meta: nextMeta, body: nextBody }, { touchUpdatedAt: false });

    const expectedReviewBlob = gitBlobHash(await readFile(candidate.reviewPath));
    const expectedPatchBlob = gitBlobHash(newPatchBytes);
    const committed = await commitWithThreeBranchRecovery({
      vcs,
      probePaths: [relReviewPath, relNewPatchPath],
      commitInput: {
        message: `review(${candidate.id}): Mode C 实质变更生成新补丁 ${newPatchName} 重新人审 [skip ci]`,
        paths: [relReviewPath, relNewPatchPath],
        verifyEntries: [
          { path: relReviewPath, blobHash: expectedReviewBlob },
          { path: relNewPatchPath, blobHash: expectedPatchBlob },
        ],
      },
      verifyOnProbeChange: async (rev) => {
        const revReview = await vcs.readFileAt(rev, relReviewPath).catch(() => null);
        const revPatch = await vcs.readFileAt(rev, relNewPatchPath).catch(() => null);
        return revReview !== null
          && revPatch !== null
          && gitBlobHash(revReview) === expectedReviewBlob
          && gitBlobHash(revPatch) === expectedPatchBlob;
      },
      restoreOnProvenNotCommitted: async () => {
        await auditFiles(vcs.root, { op: 'write', paths: [relReviewPath], text: reviewBackup });
        await rm(newPatchAbs, { force: true });
      },
      ...(deps.recoveryStore ? {
        recoveryStore: deps.recoveryStore,
        recoveryContext: { repoRoot: vcs.root, kind: 'approve', jobId, candidateId: candidate.id },
      } : {}),
    });

    if (committed.status === 'committed') {
      return {
        kind: 'terminal',
        outcome: {
          status: 'FALLBACK_TO_PENDING',
          jobId,
          reason: 'MATERIAL_CHANGE',
          newRevision: nextMeta.recordRevision,
          message: `Mode C 辅助产生实质变更（${summary}），已导出新补丁 ${newPatchName}、还原业务并退回重新人审`,
        },
      };
    }
    if (committed.status === 'recovery_required') {
      return {
        kind: 'terminal',
        outcome: {
          status: 'RECOVERY_REQUIRED',
          jobId,
          reason: committed.reason,
          detail: committed.detail,
          message: `Mode C 新补丁提交进入恢复态：${committed.detail}`,
        },
      };
    }
    return abort('COMMIT_FAILED', `Mode C 新补丁提交失败并已还原：${committed.errorOutput}`);
  };

  const isCaseA = postHead === preHead && postBranch === preBranch && !remoteAdvanced;
  if (isCaseA) {
    // Case A：仅工作区适配
    const postClean = await vcs.ensureCleanWorkspace();
    const dirtyPaths = postClean.dirtyPaths;
    const hasForbidden = dirtyPaths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p));
    const symlinkBad = !hasForbidden && (await hasSymlinkEscape(vcs.root, dirtyPaths));

    if (!modeCResult.ok || !verdict || aiReviewTampered || activeGitOp || hasForbidden || symlinkBad || dirtyPaths.length === 0) {
      const revertFail = await safeRevertOrRecover(aiReviewTampered);
      if (revertFail) return revertFail;
      const why = aiReviewTampered
        ? 'Mode C 篡改了 .ai-review/ 目录'
        : activeGitOp
          ? 'Mode C 留下未完成 Git 合并/变基状态'
          : hasForbidden || symlinkBad
            ? 'Mode C 触及禁止路径或符号链接逃逸'
            : !verdict
              ? 'Mode C 未返回合法结构化 JSON 结果'
              : dirtyPaths.length === 0
                ? 'Mode C 未产生任何业务代码修改'
                : (modeCResult.errorMessage ?? 'Mode C 执行失败');
      return abort('RUNNER_FAILED', `Mode C 辅助失败并已还原：${why}`);
    }

    const outOfScope = dirtyPaths.filter((p) => !allowedSet.has(p));
    if (verdict.verdict === 'material_change' || outOfScope.length > 0) {
      const reasonText = verdict.verdict === 'material_change'
        ? verdict.summary
        : `业务改动超出获批源补丁范围（越界文件：${outOfScope.join(', ')}）`;
      return exportNewPatchAndFallback(reasonText, [...approvedPatchPaths, ...dirtyPaths]);
    }

    return {
      kind: 'applied',
      applySummary: `Mode C 工作区等价适配：${verdict.summary}`,
      localModeC: null,
      pushedModeC: null,
    };
  }

  // Case B：本地 commit/merge 或已推送远端
  if (vcs.type !== 'git' || !postHead || !vcs.computeModeCNetChangedPaths) {
    if (remoteAdvanced) {
      return recover('REMOTE_PUSH_UNREVERTIBLE', `远端分支已推进至 ${postPrimaryRemote?.tip ?? '(未知)'}，无法本地撤销`);
    }
    const revertFail = await safeRevertOrRecover(aiReviewTampered);
    if (revertFail) return revertFail;
    return abort('RUNNER_FAILED', '非 Git 环境不支持 Mode C 拓扑变更');
  }

  const topology = await vcs.computeModeCNetChangedPaths(preHead, postHead, [...trustedUpstreamTips]);
  const hasForbidden = topology.netChangedPaths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p));
  const symlinkBad = !hasForbidden && (await hasSymlinkEscape(vcs.root, topology.netChangedPaths));
  const outOfScope = topology.netChangedPaths.filter((p) => !allowedSet.has(p));
  const severeViolation = !modeCResult.ok
    || !verdict
    || branchSwitched
    || !topology.ok
    || topology.aiReviewTouched
    || aiReviewTampered
    || activeGitOp
    || hasForbidden
    || symlinkBad
    || topology.netChangedPaths.length === 0;
  const isMaterial = !severeViolation && (verdict!.verdict === 'material_change' || outOfScope.length > 0);

  if (remoteAdvanced) {
    // 情况 B-已推送：严禁 force push！任何违例或实质变化必须进 RECOVERY_REQUIRED / REMOTE_PUSH_UNREVERTIBLE
    if (severeViolation || isMaterial) {
      const detail = [
        `已推送提交：${postHead}`,
        `远端引用：${primaryRemoteRef}（${prePrimaryRemote?.tip.slice(0, 12) ?? ''} -> ${postPrimaryRemote?.tip.slice(0, 12) ?? changedRemoteRefs[0]?.after.slice(0, 12) ?? ''}）`,
        `原因：${severeViolation ? (branchSwitched ? `当前分支被切换（${preBranch} -> ${postBranch ?? 'detached'}）` : topology.diagnostic ?? (aiReviewTampered ? '篡改 .ai-review' : !verdict ? '缺少合法 JSON 裁决' : '硬护栏违例')) : (verdict?.verdict === 'material_change' ? verdict.summary : `越界路径 ${outOfScope.join(', ')}`)}`,
      ].join('；');
      return recover('REMOTE_PUSH_UNREVERTIBLE', detail, 'Mode C 已推送远端但未通过硬护栏，严禁强推覆盖，已保留现场待人工恢复');
    }
    const workClean = await vcs.ensureCleanWorkspace();
    if (!workClean.clean) {
      return recover(
        'REMOTE_PUSH_UNREVERTIBLE',
        `已推送提交 ${postHead} 后工作区仍残留未提交业务改动（${workClean.dirtyPaths.join(', ')}），已保留现场待人工处理`,
      );
    }
    return {
      kind: 'applied',
      applySummary: `Mode C 分支合并/推送等价适配（${postHead.slice(0, 12)}）：${verdict!.summary}`,
      localModeC: null,
      pushedModeC: {
        commit: postHead,
        remoteRef: primaryRemoteRef,
        expectedTreeHash: (await vcs.getTreeHash?.('HEAD')) ?? null,
      },
    };
  }

  // 情况 B-本地（未 push）
  if (severeViolation) {
    const revertFail = await safeRevertOrRecover(aiReviewTampered || topology.aiReviewTouched);
    if (revertFail) return revertFail;
    return abort(
      'RUNNER_FAILED',
      `Mode C 本地提交未通过硬护栏并已回滚至 ${preHead.slice(0, 12)}：${branchSwitched ? `当前分支被切换（${preBranch} -> ${postBranch ?? 'detached'}）` : topology.diagnostic ?? (aiReviewTampered ? '篡改 .ai-review' : !verdict ? '缺少合法 JSON' : '违例')}`,
    );
  }
  if (isMaterial) {
    const reasonText = verdict!.verdict === 'material_change'
      ? verdict!.summary
      : `本地提交/合并净改动超出获批源补丁范围（越界：${outOfScope.join(', ')}）`;
    // 仅导出本次 Mode C 的净改动路径（不混入上游无关合并文件）
    return exportNewPatchAndFallback(reasonText, topology.netChangedPaths);
  }
  const workClean = await vcs.ensureCleanWorkspace();
  if (!workClean.clean) {
    const revertFail = await safeRevertOrRecover(aiReviewTampered);
    if (revertFail) return revertFail;
    return abort('RUNNER_FAILED', `Mode C 本地提交后工作区仍留有未提交改动（${workClean.dirtyPaths.join(', ')}），已回滚至 ${preHead.slice(0, 12)}`);
  }
  return {
    kind: 'applied',
    applySummary: `Mode C 本地提交/合并等价适配（${String(topology.commitCount)} 提交）：${verdict!.summary}`,
    localModeC: {
      preHead,
      postHead,
      mergedParents: topology.mergedParents,
      commitCount: topology.commitCount,
      expectedTreeHash: (await vcs.getTreeHash?.('HEAD')) ?? null,
    },
    pushedModeC: null,
  };
}
