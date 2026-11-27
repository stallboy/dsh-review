/**
 * 统一三分支提交恢复原语（SPEC §8.3）：
 * 所有共享提交路径统一经过本模块：提交异常或核验失败先探针确认，绝不盲目回滚已落地提交；
 * 结果不明或还原不完整时落盘持久化 RECOVERY_REQUIRED 阻塞后续写入。
 */

import type { RecoveryKind, RepoRecoveryStore } from './recovery-store.js';
import type { CommitInput, CommitResult, VcsAdapter } from './vcs-types.js';

export type ThreeBranchCommitOutcome =
  | { status: 'committed'; commitRevision: string; recoveredFromProbe?: boolean }
  | { status: 'failed_restored'; outOfDate: boolean; targetChanged: boolean; errorOutput: string }
  | { status: 'recovery_required'; reason: 'COMMIT_OUTCOME_UNKNOWN' | 'RESTORE_INCOMPLETE'; detail: string };

export interface ThreeBranchCommitParams {
  vcs: VcsAdapter;
  probePaths: string[];
  /** 默认执行 vcs.atomicCommit(commitInput)；Mode C 本地 amend/collapse 等场景可传入自定义提交执行器。 */
  commitInput?: CommitInput;
  executeCommit?: () => Promise<CommitResult>;
  /** 探针变化时核验目标提交是否与本次预期写入完全一致。 */
  verifyOnProbeChange: (probeRevision: string) => Promise<boolean>;
  /** 仅在探针证明提交确实未落地时调用，用于恢复备份与业务改动。 */
  restoreOnProvenNotCommitted: () => Promise<void>;
  /** 可选：还原完成后校验工作区/文件恢复是否完整，返回非空错误说明时升级为 RESTORE_INCOMPLETE。 */
  verifyRestored?: () => Promise<string | null>;
  recoveryStore?: RepoRecoveryStore;
  recoveryContext?: {
    repoRoot: string;
    kind: RecoveryKind;
    jobId?: string;
    candidateId?: string;
  };
}

export async function commitWithThreeBranchRecovery(
  params: ThreeBranchCommitParams,
): Promise<ThreeBranchCommitOutcome> {
  const {
    vcs,
    probePaths,
    commitInput,
    executeCommit,
    verifyOnProbeChange,
    restoreOnProvenNotCommitted,
    verifyRestored,
    recoveryStore,
    recoveryContext,
  } = params;

  const markRecovery = async (
    reason: 'COMMIT_OUTCOME_UNKNOWN' | 'RESTORE_INCOMPLETE',
    detail: string,
  ): Promise<ThreeBranchCommitOutcome> => {
    if (recoveryStore && recoveryContext) {
      await recoveryStore.markRecoveryRequired(recoveryContext.repoRoot, {
        kind: recoveryContext.kind,
        reason,
        detail,
        ...(recoveryContext.jobId ? { jobId: recoveryContext.jobId } : {}),
        ...(recoveryContext.candidateId ? { candidateId: recoveryContext.candidateId } : {}),
      });
    }
    return { status: 'recovery_required', reason, detail };
  };

  const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
  let commit: CommitResult;
  let commitThrew = false;
  try {
    if (executeCommit) {
      commit = await executeCommit();
    } else if (commitInput) {
      commit = await vcs.atomicCommit(commitInput);
    } else {
      throw new Error('commitWithThreeBranchRecovery 缺少 commitInput 或 executeCommit');
    }
  } catch (error) {
    commitThrew = true;
    commit = {
      success: false,
      commitRevision: null,
      outOfDate: false,
      errorOutput: error instanceof Error ? error.message : String(error),
    };
  }

  if (commit.success && commit.commitRevision) {
    return { status: 'committed', commitRevision: commit.commitRevision };
  }

  if (commit.verificationFailed) {
    return markRecovery('COMMIT_OUTCOME_UNKNOWN', `提交后核验失败，现场保留待人工核对：${commit.errorOutput}`);
  }

  if (commit.targetChanged) {
    // 目标分支或基线引用在提交临界区发生变化：不得切回原分支或静默重试，立即保留现场进入恢复态。
    return markRecovery('COMMIT_OUTCOME_UNKNOWN', `提交目标引用或分支发生变化，已停止提交并保留现场：${commit.errorOutput}`);
  }

  const probeAfter = await vcs.getCommitProbe(probePaths).catch(() => null);
  if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
    const verified = await verifyOnProbeChange(probeAfter).catch(() => false);
    if (verified) {
      return { status: 'committed', commitRevision: probeAfter, recoveredFromProbe: true };
    }
    return markRecovery(
      'COMMIT_OUTCOME_UNKNOWN',
      `提交探针已由 ${probeBefore} 变为 ${probeAfter}，但内容无法核对一致，现场保留：${commit.errorOutput}`,
    );
  }

  if (commitThrew || probeBefore === null || probeAfter === null) {
    return markRecovery(
      'COMMIT_OUTCOME_UNKNOWN',
      `提交命令异常中断或探针不可读，无法确认提交是否落地，现场保留：${commit.errorOutput}`,
    );
  }

  // 分支 3：探针未变且提交命令明确返回非零失败 -> 已证明未提交，先撤暂存再恢复备份并核验
  try {
    await commit.restorePreparation?.();
    await restoreOnProvenNotCommitted();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return markRecovery('RESTORE_INCOMPLETE', `提交失败后还原工作区或备份异常：${detail}`);
  }

  if (verifyRestored) {
    const restoreError = await verifyRestored().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (restoreError) {
      return markRecovery('RESTORE_INCOMPLETE', restoreError);
    }
  }

  return {
    status: 'failed_restored',
    outOfDate: commit.outOfDate,
    targetChanged: Boolean(commit.targetChanged),
    errorOutput: commit.errorOutput,
  };
}
