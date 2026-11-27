/**
 * 批准落地与失败记账提交（SPEC §5.5 步骤 8 失败分支、步骤 10–11）：
 * 全部提交统一经 commitWithThreeBranchRecovery 执行三分支恢复与持久化恢复守卫登记。
 */

import { readFile } from 'node:fs/promises';
import { auditFiles } from './audit-files.js';
import { commitWithThreeBranchRecovery } from './commit-recovery.js';
import { nextUpdatedAt } from './issue-review.js';
import { gitBlobHash, type ExpectedCommitEntry } from './vcs.js';
import type {
  ApprovalInfo,
  ApprovalOutcome,
  GateCheckResult,
  RepairApplyMode,
  RepairAttempt,
} from './types.js';
import {
  assembleFinalCommitMessage,
  revertAndVerifyClean,
  type ApprovalDeps,
  type ApproveInput,
  type LocalModeCState,
  type ValidatedSnapshot,
} from './approval-preconditions.js';

async function readSharedReviewBackup(snapshot: ValidatedSnapshot): Promise<string> {
  const fromShared = await snapshot.source?.readReviewText(snapshot.candidate.month, snapshot.candidate.slug);
  if (fromShared !== null && fromShared !== undefined) return fromShared;
  return readFile(snapshot.candidate.reviewPath, 'utf8');
}

export async function landRepairFailureCommit(params: {
  deps: ApprovalDeps;
  input: ApproveInput;
  snapshot: ValidatedSnapshot;
  currentBase: string;
  preHead: string;
  applyMode: RepairApplyMode;
  applySummary: string;
  gateResults: GateCheckResult[];
}): Promise<ApprovalOutcome> {
  const { deps, input, snapshot, currentBase, preHead, applyMode, applySummary, gateResults } = params;
  const { store, vcs, jobId } = deps;
  const { candidate, option, patchEntry } = snapshot;

  const failedSummary = gateResults
    .map((r) => `${r.command} -> exit ${String(r.exitCode)} (${String(r.durationMs)}ms)${r.passed ? ' PASS' : ' FAIL'}`)
    .join('；');
  const failedAttempt: RepairAttempt = {
    id: candidate.meta.repairAttempts.length + 1,
    optionId: option.id,
    patchId: patchEntry.id,
    baseRevision: currentBase,
    actor: input.actor,
    at: nextUpdatedAt(candidate.meta.updatedAt),
    applyMode,
    result: 'verification_failed',
    restored: true,
    evidence: `${applySummary}；门禁失败：${failedSummary}；已完整还原业务工作区至 ${preHead}`,
  };

  const reviewBackup = await readSharedReviewBackup(snapshot);
  const updatedCandidate = await store.recordRepairFailure(candidate, failedAttempt);
  const relReviewPath = `.ai-review/${candidate.id}/review.md`;
  const expectedReviewBlob = gitBlobHash(await readFile(updatedCandidate.reviewPath));

  const committed = await commitWithThreeBranchRecovery({
    vcs,
    probePaths: [relReviewPath],
    commitInput: {
      message: `review(${candidate.id}): 门禁验证失败已还原，标记 repair_failed [skip ci]`,
      paths: [relReviewPath],
      verifyEntries: [{ path: relReviewPath, blobHash: expectedReviewBlob }],
    },
    verifyOnProbeChange: async (rev) => {
      const text = await vcs.readFileAt(rev, relReviewPath).catch(() => null);
      return text !== null && gitBlobHash(text) === expectedReviewBlob;
    },
    restoreOnProvenNotCommitted: async () => {
      await auditFiles(vcs.root, { op: 'write', paths: [relReviewPath], text: reviewBackup });
    },
    ...(deps.recoveryStore ? {
      recoveryStore: deps.recoveryStore,
      recoveryContext: { repoRoot: vcs.root, kind: 'approve', jobId, candidateId: candidate.id },
    } : {}),
  });

  if (committed.status === 'committed') {
    return {
      status: 'REPAIR_FAILED',
      jobId,
      reason: 'GATE_CHECK_FAILED',
      commitRevision: committed.commitRevision,
      gateResults,
      message: `门禁验证失败，已还原业务改动并将问题置为 repair_failed（补丁 #${String(patchEntry.id)} 已永久封禁）`,
    };
  }
  if (committed.status === 'recovery_required') {
    return {
      status: 'RECOVERY_REQUIRED',
      jobId,
      reason: committed.reason,
      detail: `已还原业务但提交 repair_failed 记录进入恢复态：${committed.detail}`,
      message: `已还原业务但提交 repair_failed 记录失败，请人工确认：${committed.detail}`,
    };
  }
  return {
    status: 'RECOVERY_REQUIRED',
    jobId,
    reason: 'COMMIT_OUTCOME_UNKNOWN',
    detail: `已还原业务但提交 repair_failed 记录失败（已恢复 review.md）：${committed.errorOutput}`,
    message: `已还原业务但未能写入 repair_failed 记录：${committed.errorOutput}`,
  };
}

export async function landApprovalCommit(params: {
  deps: ApprovalDeps;
  input: ApproveInput;
  snapshot: ValidatedSnapshot;
  currentBase: string;
  preHead: string;
  preBranch: string | null;
  preAiReviewDigest: string;
  applyMode: RepairApplyMode;
  applySummary: string;
  gateResults: GateCheckResult[];
  businessPathsToVerify: string[];
  preGateBusiness: { entries: ExpectedCommitEntry[]; missing: string[] };
  localModeC: LocalModeCState | null;
  attemptNumber: number;
  maxRetries: number;
}): Promise<{ retry: true } | { retry: false; outcome: ApprovalOutcome }> {
  const {
    deps,
    input,
    snapshot,
    currentBase,
    preHead,
    preBranch,
    preAiReviewDigest,
    applyMode,
    applySummary,
    gateResults,
    businessPathsToVerify,
    preGateBusiness,
    localModeC,
    attemptNumber,
    maxRetries,
  } = params;
  const { store, vcs, jobId, log } = deps;
  const { candidate, option, patchEntry, patchText } = snapshot;

  const approvedAt = nextUpdatedAt(candidate.meta.updatedAt);
  const successAttempt: RepairAttempt = {
    id: candidate.meta.repairAttempts.length + 1,
    optionId: option.id,
    patchId: patchEntry.id,
    baseRevision: currentBase,
    actor: input.actor,
    at: approvedAt,
    applyMode,
    result: 'applied',
    restored: false,
    evidence: `${applySummary}；全部 ${String(gateResults.length)} 项门禁通过`,
  };
  const approvalInfo: ApprovalInfo = {
    approvedBy: input.actor,
    approvedAt,
    recordRevision: candidate.meta.recordRevision,
    optionId: option.id,
    patchId: patchEntry.id,
    patchSha256: patchEntry.sha256,
    repairAttemptId: successAttempt.id,
    baseRevision: currentBase,
    gateChecks: [...option.gateChecks],
    gateResults: gateResults.map((r) => ({
      command: r.command,
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs,
    })),
    confirmedDecisions: [...input.confirmedDecisions],
    waivedDecisions: input.waivedDecisions.map((w) => ({ id: w.id, reason: w.reason.trim() })),
  };

  const relReviewPath = `.ai-review/${candidate.id}/review.md`;
  const reviewBackup = await readSharedReviewBackup(snapshot);
  const updatedCandidate = await store.applyApproval(candidate, {
    approval: approvalInfo,
    attempt: successAttempt,
    commitMessage: snapshot.commitMessage,
    now: new Date(approvedAt),
  });

  const vcsCommitMessage = await assembleFinalCommitMessage({
    candidate,
    optionId: option.id,
    patchId: patchEntry.id,
    patchText,
    commitMessage: snapshot.commitMessage,
    commitDetail: input.commitDetail,
    vcs,
  });

  const updatedReviewBytes = await readFile(updatedCandidate.reviewPath);
  const expectedReviewBlob = gitBlobHash(updatedReviewBytes);

  if (vcs.type === 'git' && preBranch !== null) {
    const branchBeforeCommit = (await vcs.getCurrentBranch?.()) ?? null;
    if (branchBeforeCommit !== preBranch) {
      await auditFiles(vcs.root, { op: 'write', paths: [relReviewPath], text: reviewBackup }).catch(() => undefined);
      const detail = `提交前当前分支发生切换（${preBranch} -> ${branchBeforeCommit ?? 'detached'}），已停止提交并保留现场`;
      await deps.recoveryStore?.markRecoveryRequired(vcs.root, {
        kind: 'approve',
        reason: 'SYNC_STATE_UNKNOWN',
        detail,
        jobId,
        candidateId: candidate.id,
      });
      return {
        retry: false,
        outcome: { status: 'RECOVERY_REQUIRED', jobId, reason: 'SYNC_STATE_UNKNOWN', detail, message: `批准进入恢复态：${detail}` },
      };
    }
  }

  // 在触发提交探针前锁定 Git 目标符号引用，防止探针阶段发生同 SHA 切分支后误推进新分支。
  const gitTarget = vcs.type === 'git' ? (await vcs.getApprovalTarget?.()) ?? undefined : undefined;
  const probePaths = [relReviewPath, ...businessPathsToVerify];
  const committed = await commitWithThreeBranchRecovery({
    vcs,
    probePaths,
    executeCommit: async () => {
      if (localModeC) {
        if (localModeC.commitCount === 1 && vcs.amendCommitWithReview) {
          return vcs.amendCommitWithReview({
            reviewPath: relReviewPath,
            expectedReviewBlob,
            message: vcsCommitMessage,
          });
        }
        if (vcs.collapseLocalCommitsWithReview) {
          return vcs.collapseLocalCommitsWithReview({
            preHead: localModeC.preHead,
            mergedParents: localModeC.mergedParents,
            reviewPath: relReviewPath,
            expectedReviewBlob,
            message: vcsCommitMessage,
          });
        }
        return { success: false, commitRevision: null, outOfDate: false, errorOutput: '缺少本地提交收拢能力' };
      }
      const verifyEntries: ExpectedCommitEntry[] = [
        ...preGateBusiness.entries,
        { path: relReviewPath, blobHash: expectedReviewBlob },
      ];
      return vcs.atomicCommit({
        message: vcsCommitMessage,
        paths: [...businessPathsToVerify, relReviewPath],
        verifyEntries,
        verifyDeletions: preGateBusiness.missing,
        ...(gitTarget ? { gitTarget } : {}),
      });
    },
    verifyOnProbeChange: async (rev) => {
      const committedReview = await vcs.readFileAt(rev, relReviewPath).catch(() => null);
      return committedReview !== null && gitBlobHash(committedReview) === expectedReviewBlob;
    },
    restoreOnProvenNotCommitted: async () => {
      await auditFiles(vcs.root, { op: 'write', paths: [relReviewPath], text: reviewBackup });
      if (localModeC && vcs.resetHard) {
        await vcs.resetHard(localModeC.preHead);
      } else {
        await vcs.revertBusinessWorkspace();
      }
    },
    verifyRestored: async () => {
      const check = await revertAndVerifyClean({
        vcs,
        preHead,
        preBranch,
        preAiReviewDigest,
        useResetHard: Boolean(localModeC),
      });
      return check.ok ? null : check.detail;
    },
    ...(deps.recoveryStore ? {
      recoveryStore: deps.recoveryStore,
      recoveryContext: { repoRoot: vcs.root, kind: 'approve', jobId, candidateId: candidate.id },
    } : {}),
  });

  if (committed.status === 'committed') {
    log(`步骤 11：批准原子提交成功（${committed.commitRevision.slice(0, 12)}）`);
    return {
      retry: false,
      outcome: {
        status: 'COMMITTED',
        jobId,
        commitRevision: committed.commitRevision,
        gateResults,
        message: committed.recoveredFromProbe
          ? `提交命令异常但已核实落地（${committed.commitRevision.slice(0, 12)}）`
          : `批准并提交成功：${committed.commitRevision.slice(0, 12)}`,
      },
    };
  }

  if (committed.status === 'recovery_required') {
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: committed.reason,
        detail: committed.detail,
        message: `批准进入恢复态：${committed.detail}`,
      },
    };
  }

  if (committed.outOfDate) {
    if (attemptNumber < maxRetries) {
      log(`提交撞车（${committed.errorOutput}），已还原，准备重试`);
      return { retry: true };
    }
    return {
      retry: false,
      outcome: {
        status: 'ABORTED',
        jobId,
        reason: 'MAX_RETRIES_EXCEEDED',
        message: `提交连续撞车耗尽重试上限：${committed.errorOutput}`,
      },
    };
  }

  return {
    retry: false,
    outcome: {
      status: 'ABORTED',
      jobId,
      reason: 'COMMIT_FAILED',
      message: `原子提交失败并已完整还原：${committed.errorOutput}`,
    },
  };
}

export async function landMetaClosingCommitForPushed(params: {
  deps: ApprovalDeps;
  input: ApproveInput;
  snapshot: ValidatedSnapshot;
  pushedHash: string;
  gateResults: GateCheckResult[];
  applyMode: RepairApplyMode;
  base: string;
  summary: string;
  canRetry: boolean;
}): Promise<{ retry: true } | { retry: false; outcome: ApprovalOutcome }> {
  const { deps, input, snapshot, pushedHash, gateResults, applyMode, base, summary, canRetry } = params;
  const { store, vcs, jobId } = deps;
  const { candidate, option, patchEntry, approvedPatchPaths } = snapshot;

  // SPEC §5.5 步骤 10（情况 B-已推送）：先核验 P 仍在当前祖先链中且触及获批业务路径，再生成 C_meta
  const headNow = await vcs.getCurrentBase();
  const isAnc = headNow && vcs.isAncestor ? await vcs.isAncestor(pushedHash, headNow) : false;
  const pushedPaths = await vcs.listCommitPaths?.(pushedHash);
  const touchesApproved = Boolean(pushedPaths && approvedPatchPaths.some((file) => pushedPaths.includes(file)));
  if (!isAnc || !touchesApproved) {
    const detail = !isAnc
      ? `已推送业务提交 ${pushedHash} 不再位于当前 HEAD（${headNow ?? 'null'}）祖先链中`
      : `已推送业务提交 ${pushedHash} 未触及获批补丁业务路径（${approvedPatchPaths.join(', ')}）`;
    await deps.recoveryStore?.markRecoveryRequired(vcs.root, {
      kind: 'approve',
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail,
      jobId,
      candidateId: candidate.id,
    });
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail,
        message: '已推送业务提交核验异常，严禁继续写入元数据关闭提交，已保留现场',
      },
    };
  }

  const relReviewPath = `.ai-review/${candidate.id}/review.md`;
  const reviewBackup = await readSharedReviewBackup(snapshot);
  const approvedAt = nextUpdatedAt(candidate.meta.updatedAt);

  const successAttempt: RepairAttempt = {
    id: candidate.meta.repairAttempts.length + 1,
    optionId: option.id,
    patchId: patchEntry.id,
    baseRevision: base,
    actor: input.actor,
    at: approvedAt,
    applyMode,
    result: 'applied',
    restored: false,
    evidence: `${summary}；全部 ${String(gateResults.length)} 项门禁通过（已推送业务提交 ${pushedHash}）`,
  };
  const approvalInfo: ApprovalInfo = {
    approvedBy: input.actor,
    approvedAt,
    recordRevision: candidate.meta.recordRevision,
    optionId: option.id,
    patchId: patchEntry.id,
    patchSha256: patchEntry.sha256,
    repairAttemptId: successAttempt.id,
    baseRevision: base,
    gateChecks: [...option.gateChecks],
    gateResults: gateResults.map((r) => ({
      command: r.command,
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs,
    })),
    confirmedDecisions: [...input.confirmedDecisions],
    waivedDecisions: input.waivedDecisions.map((w) => ({ id: w.id, reason: w.reason.trim() })),
    businessCommit: pushedHash,
  };

  const updatedCandidate = await store.applyApproval(candidate, {
    approval: approvalInfo,
    attempt: successAttempt,
    commitMessage: snapshot.commitMessage,
    now: new Date(approvedAt),
  });
  const expectedReviewBlob = gitBlobHash(await readFile(updatedCandidate.reviewPath));

  const committed = await commitWithThreeBranchRecovery({
    vcs,
    probePaths: [relReviewPath],
    commitInput: {
      message: `review(${candidate.id}): 关闭已推送业务提交 ${pushedHash.slice(0, 12)} 的审批记录 [skip ci]`,
      paths: [relReviewPath],
      verifyEntries: [{ path: relReviewPath, blobHash: expectedReviewBlob }],
    },
    verifyOnProbeChange: async (rev) => {
      const committedReview = await vcs.readFileAt(rev, relReviewPath).catch(() => null);
      return committedReview !== null && gitBlobHash(committedReview) === expectedReviewBlob;
    },
    restoreOnProvenNotCommitted: async () => {
      // 绝不回滚至 preHead，仅还原 review.md 回到已推送业务提交 P
      await auditFiles(vcs.root, { op: 'write', paths: [relReviewPath], text: reviewBackup });
    },
    ...(deps.recoveryStore ? {
      recoveryStore: deps.recoveryStore,
      recoveryContext: { repoRoot: vcs.root, kind: 'approve', jobId, candidateId: candidate.id },
    } : {}),
  });

  if (committed.status === 'committed') {
    const closingRev = committed.commitRevision;
    const pushHint = deps.isManaged
      ? ''
      : `（元数据关闭提交 ${closingRev.slice(0, 12)} 尚未推送，请手动推送至远端）`;
    return {
      retry: false,
      outcome: {
        status: 'COMMITTED',
        jobId,
        commitRevision: pushedHash,
        closingCommitRevision: closingRev,
        gateResults,
        message: `批准并关闭成功，业务提交：${pushedHash.slice(0, 12)}，关闭提交：${closingRev.slice(0, 12)}${pushHint}`,
      },
    };
  }

  if (committed.status === 'recovery_required') {
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: committed.reason,
        detail: `业务提交 ${pushedHash} 已推送，元数据关闭提交 C_meta 进入恢复态：${committed.detail}`,
        message: '已推送业务提交但元数据关闭提交结果不明，请人工确认',
      },
    };
  }

  if (committed.outOfDate && canRetry) {
    return { retry: true };
  }

  const detail = `业务提交 ${pushedHash} 已推送，但创建元数据关闭提交 C_meta 失败${committed.outOfDate ? '（重试耗尽）' : ''}：${committed.errorOutput}`;
  await deps.recoveryStore?.markRecoveryRequired(vcs.root, {
    kind: 'approve',
    reason: 'COMMIT_OUTCOME_UNKNOWN',
    detail,
    jobId,
    candidateId: candidate.id,
  });
  return {
    retry: false,
    outcome: {
      status: 'RECOVERY_REQUIRED',
      jobId,
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail,
      message: '已推送业务提交但元数据关闭提交未能完成，严禁回滚业务提交，请人工确认',
    },
  };
}
