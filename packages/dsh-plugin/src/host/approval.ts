/**
 * 批准编排（SPEC §5.5 11 步原子事务）：
 * 协调前置校验、程序优先应用（严格应用 → 确定性三方合并）、Mode C 辅助与拓扑硬护栏、
 * 实际门禁复算、门禁后防篡改核验、三分支落地提交与持久化恢复守卫。
 */

import path from 'node:path';
import { mergeApprovedText, supportedApprovalMergePatch } from './approval-merge.js';
import {
  readApprovalMergeSnapshots,
  replaceApprovalMergeFile,
  svnApprovalBinding,
} from './approval-merge-snapshots.js';
import { landApprovalCommit, landMetaClosingCommitForPushed, landRepairFailureCommit } from './approval-landing.js';
import { runModeCAssist } from './approval-mode-c.js';
import {
  digestAiReviewDir,
  revertAndVerifyClean,
  validateApprovalPreconditions,
  validateHumanDecisionsCoverage,
  type ApprovalDeps,
  type ApproveInput,
  type LocalModeCState,
  type PushedCarryOver,
  type PushedModeCState,
} from './approval-preconditions.js';
import { isRepoRelativePath } from './invariants.js';
import { isAiReviewPath } from './patch.js';
import { runGateChecks } from './validator.js';
import { collectCommitEntries } from './vcs.js';
import type { ApprovalOutcome, RepairApplyMode } from './types.js';

export const MAX_COMMIT_RETRIES = 2;

export { validateHumanDecisionsCoverage, type ApprovalDeps, type ApproveInput };

export async function runApprovalTransaction(deps: ApprovalDeps, input: ApproveInput): Promise<ApprovalOutcome> {
  const { vcs, settings, jobId, log, recoveryStore } = deps;
  const runGatesFn = deps.runGates ?? runGateChecks;

  const abort = (reason: Extract<ApprovalOutcome, { status: 'ABORTED' }>['reason'], message: string, detail?: string): ApprovalOutcome => ({
    status: 'ABORTED',
    jobId,
    reason,
    ...(detail ? { detail } : {}),
    message,
  });

  const recover = async (
    reason: Extract<ApprovalOutcome, { status: 'RECOVERY_REQUIRED' }>['reason'],
    detail: string,
    message?: string,
  ): Promise<ApprovalOutcome> => {
    await recoveryStore?.markRecoveryRequired(vcs.root, {
      kind: 'approve',
      reason,
      detail,
      jobId,
      candidateId: input.id,
    });
    return {
      status: 'RECOVERY_REQUIRED',
      jobId,
      reason,
      detail,
      message: message ?? `批准进入恢复态：${detail}`,
    };
  };

  // 若仓库当前存在未解除的持久化恢复阻塞，直接拒绝进入事务
  const existingBlocker = recoveryStore?.blockerFor(vcs.root);
  if (existingBlocker) {
    return {
      status: 'RECOVERY_REQUIRED',
      jobId,
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail: existingBlocker.detail,
      message: `仓库处于待恢复阻塞态（${existingBlocker.reason}），请先人工核对现场并解除阻塞`,
    };
  }

  let pushedCommitCarriedOver: PushedCarryOver | null = null;
  let writeWindowOpened = false;

  const finalizeOutcome = async (outcome: ApprovalOutcome): Promise<ApprovalOutcome> => {
    if (outcome.status === 'RECOVERY_REQUIRED') {
      await recoveryStore?.markRecoveryRequired(vcs.root, {
        kind: 'approve',
        reason: outcome.reason,
        detail: outcome.detail,
        jobId,
        candidateId: input.id,
      });
    } else if (writeWindowOpened) {
      await recoveryStore?.finishWriteWindow(vcs.root);
    }
    return outcome;
  };

  try {
    for (let attemptNumber = 0; attemptNumber <= MAX_COMMIT_RETRIES; attemptNumber += 1) {
      if (deps.signal?.aborted) {
        return finalizeOutcome(abort('RUNNER_FAILED', '批准任务已取消'));
      }

      // 若上轮在情况 B-已推送中仅 C_meta 提交撞车，绝不回滚至 preHead，直接在 P 上重试 C_meta
      if (pushedCommitCarriedOver) {
        const { commit: pushedHash, snapshot, gateResults, applyMode, base, summary } = pushedCommitCarriedOver;
        log(`情况 B-已推送：在业务提交 ${pushedHash.slice(0, 12)} 上重试元数据关闭提交 C_meta（第 ${String(attemptNumber + 1)} 次）`);
        const landed = await landMetaClosingCommitForPushed({
          deps,
          input,
          snapshot,
          pushedHash,
          gateResults,
          applyMode,
          base,
          summary,
          canRetry: attemptNumber < MAX_COMMIT_RETRIES,
        });
        if (landed.retry) continue;
        return finalizeOutcome(landed.outcome);
      }

      log(`步骤 1–4：校验并发守卫、方案选择、人工判断与完整性（尝试 ${String(attemptNumber + 1)}/${String(MAX_COMMIT_RETRIES + 1)}）`);
      const initial = await validateApprovalPreconditions(deps, input);
      if ('status' in initial) return finalizeOutcome(initial);

      // Step 5: 检查工作区干净 & 无未完成 Git 操作
      log('步骤 5：检查业务工作区干净状态');
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) {
        return finalizeOutcome(abort('DIRTY_WORKSPACE', `批准要求业务工作区干净：${clean.message}`));
      }
      if (vcs.type === 'git' && (await vcs.hasActiveGitOperation?.())) {
        return finalizeOutcome(abort('SYNC_FAILED', 'Git 仓库正处于 merge/rebase/cherry-pick/revert 进行态，已中止批准并保留现场'));
      }

      // Step 6: 按配置同步并重绑共享快照
      let snapshot = initial;
      if (settings.syncBeforeApprove) {
        log('步骤 6：同步远端基线并重绑共享快照');
        const sync = await vcs.syncAndGetLatestBase();
        if (sync.uncertain) {
          return finalizeOutcome(await recover('SYNC_STATE_UNKNOWN', sync.message));
        }
        if (sync.failed) {
          return finalizeOutcome(abort('SYNC_FAILED', sync.message));
        }
        const rechecked = await validateApprovalPreconditions(deps, input);
        if ('status' in rechecked) return finalizeOutcome(rechecked);
        snapshot = rechecked;
      }

      const currentBase = await vcs.getCurrentBase();
      if (!currentBase) {
        return finalizeOutcome(await recover('SYNC_STATE_UNKNOWN', '无法读取当前 VCS 基线版本'));
      }

      const { candidate, option, patchEntry, patchText, approvedPatchPaths } = snapshot;
      const patchFileOnDisk = path.join(candidate.dirPath, patchEntry.patch);
      const preHead = currentBase;
      const preBranch = vcs.type === 'git' ? (await vcs.getCurrentBranch?.()) ?? null : null;
      const preRemoteTip = vcs.type === 'git' && vcs.getRemoteTip ? await vcs.getRemoteTip(preBranch ?? undefined) : null;
      const preAllRefTips = vcs.type === 'git' ? (await vcs.listAllRefTips?.()) ?? new Map<string, string>() : new Map<string, string>();
      const preRemoteRefTips = vcs.type === 'git' && vcs.listRemoteRefTips ? await vcs.listRemoteRefTips() : null;
      const preAiReviewDigest = await digestAiReviewDir(vcs.root);

      // 进入业务写入窗口前持久化登记，确保进程异常退出重启后自动转入 RECOVERY_REQUIRED
      await recoveryStore?.beginWriteWindow(vcs.root, {
        kind: 'approve',
        reason: 'APPROVAL_WRITE_IN_PROGRESS',
        detail: `正在应用并提交 ${candidate.id}（${option.id} / #${String(patchEntry.id)}）`,
        jobId,
        candidateId: candidate.id,
      });
      writeWindowOpened = true;

      // Step 7: 程序优先应用（严格应用 → 确定性三方合并）→ 受阻则 Mode C
      log(`步骤 7：程序性应用方案 ${option.id} 补丁 ${patchEntry.patch}`);
      let applyMode: RepairApplyMode = 'program_strict';
      let applySummary = '程序严格应用成功';
      let appliedOk = false;
      let conflictMessage = '';
      let localModeC: LocalModeCState | null = null;
      let pushedModeC: PushedModeCState | null = null;

      const strict = vcs.applyPatchForApproval
        ? await vcs.applyPatchForApproval(patchFileOnDisk, deps.signal)
        : { ...(await vcs.applyPatch(patchFileOnDisk, false)), workspace: 'unknown' as const, canMerge: true };
      let patchRestore: (() => Promise<void>) | undefined;

      if (strict.ok) {
        appliedOk = true;
        patchRestore = strict.restore;
      } else {
        conflictMessage = strict.message;
        if (strict.workspace === 'unknown') {
          return finalizeOutcome(await recover('SYNC_STATE_UNKNOWN', `程序性应用结果不明，已保留现场：${strict.message}`));
        }
        if (strict.workspace !== 'untouched') {
          const rev = await revertAndVerifyClean({ vcs, preHead, preBranch, preAiReviewDigest });
          if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
        }
        // 仅在严格应用确认可三方合并（strict.canMerge !== false）时尝试隔离环境确定性三方合并
        if (strict.conflict && strict.canMerge !== false && supportedApprovalMergePatch(patchText)) {
          log('严格应用遇到上下文冲突，尝试隔离环境确定性三方合并');
          const mergeSnapshots = await readApprovalMergeSnapshots(vcs, {
            sourceRevision: patchEntry.baseRevision,
            targetRevision: currentBase,
            files: approvedPatchPaths,
            svnBinding: vcs.type === 'svn' ? svnApprovalBinding(patchEntry.svnApprovalSource) : null,
            signal: deps.signal,
          });
          if (mergeSnapshots.status === 'ready') {
            const merged = await mergeApprovedText(patchText, mergeSnapshots.files, deps.signal);
            if (merged.status === 'merged') {
              try {
                for (const file of mergeSnapshots.files) {
                  const nextContent = merged.files.get(file.path);
                  if (!nextContent) throw new Error(`三方合并缺少文件结果：${file.path}`);
                  await replaceApprovalMergeFile(vcs.root, file.path, file.target, nextContent);
                }
                appliedOk = true;
                applyMode = 'program_3way';
                applySummary = '程序确定性三方合并应用成功（逐 hunk 核验一致）';
              } catch (error) {
                conflictMessage = error instanceof Error ? error.message : String(error);
                const rev = await revertAndVerifyClean({ vcs, preHead, preBranch, preAiReviewDigest });
                if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
              }
            } else {
              conflictMessage = merged.detail;
            }
          } else {
            conflictMessage = `${strict.message}\n三方合并不可用：${mergeSnapshots.detail}`;
          }
        }
      }

      if (!appliedOk) {
        applyMode = 'agent_assisted';
        const assist = await runModeCAssist({
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
        });
        if (assist.kind === 'terminal') {
          return finalizeOutcome(assist.outcome);
        }
        applySummary = assist.applySummary;
        localModeC = assist.localModeC;
        pushedModeC = assist.pushedModeC;
        appliedOk = true;
      }

      // 记录步骤 7 业务快照（用于步骤 9 门禁后防篡改核验）
      const businessPathsToVerify = approvedPatchPaths.filter((p) => isRepoRelativePath(p) && !isAiReviewPath(p));
      const preGateBusiness = await collectCommitEntries(vcs.root, businessPathsToVerify);
      const preGateSnapshotMap = new Map(preGateBusiness.entries.map((e) => [e.path, `${e.blobHash}:${e.mode ?? ''}`]));
      const preGateMissingSet = new Set(preGateBusiness.missing);

      // Step 8: 顺序执行所选方案的全部 gate_checks
      log(`步骤 8：在仓库根目录执行 ${String(option.gateChecks.length)} 条实际门禁`);
      const gateResults = await runGatesFn(option.gateChecks, {
        cwd: vcs.root,
        timeoutMs: settings.gateTimeoutMs,
        log,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      const treeNotStopped = gateResults.find((r) => r.processTreeStopped === false);
      if (treeNotStopped) {
        return finalizeOutcome(await recover(
          'RESTORE_INCOMPLETE',
          `门禁命令 "${treeNotStopped.command}" 的子进程树未能确认停止，严禁还原或继续提交，已保留现场`,
        ));
      }

      if (deps.signal?.aborted) {
        if (pushedModeC) {
          return finalizeOutcome(await recover(
            'REMOTE_PUSH_UNREVERTIBLE',
            `门禁执行期间任务被取消，但 Mode C 已推送业务提交 ${pushedModeC.commit} 至 ${pushedModeC.remoteRef}`,
            '门禁已取消但远端已有推送提交，已保留现场',
          ));
        }
        const rev = await revertAndVerifyClean({
          vcs,
          preHead,
          preBranch,
          preAiReviewDigest,
          ...(patchRestore ? { patchRestore } : {}),
          useResetHard: Boolean(localModeC),
        });
        if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
        return finalizeOutcome(abort('RUNNER_FAILED', '门禁执行期间任务已取消，已终止门禁并还原工作区'));
      }

      const allGatesPassed = gateResults.length === option.gateChecks.length && gateResults.every((r) => r.passed && r.exitCode === 0);
      if (!allGatesPassed) {
        log('门禁验证失败：绝不自动调用 Agent，开始还原业务并记录 repair_failed');
        if (pushedModeC) {
          return finalizeOutcome(await recover(
            'REMOTE_PUSH_UNREVERTIBLE',
            `Mode C 已推送业务提交 ${pushedModeC.commit} 至 ${pushedModeC.remoteRef}，随后门禁失败且无法本地撤销，请人工处理远端分支`,
            '门禁失败但远端已被 Mode C 推送，严禁强推，已保留现场',
          ));
        }
        const rev = await revertAndVerifyClean({
          vcs,
          preHead,
          preBranch,
          preAiReviewDigest,
          ...(patchRestore ? { patchRestore } : {}),
          useResetHard: Boolean(localModeC),
        });
        if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));

        return finalizeOutcome(await landRepairFailureCommit({
          deps,
          input,
          snapshot,
          currentBase,
          preHead,
          applyMode,
          applySummary,
          gateResults,
        }));
      }

      // Step 9: 门禁后二次防篡改核验（含分支、共享守卫、.ai-review 防篡改、工作区残留与业务内容快照）
      log('步骤 9：门禁后二次核验共享守卫、.ai-review 完整性与业务内容快照');
      if (vcs.type === 'git' && preBranch !== null) {
        const branchAfterGate = (await vcs.getCurrentBranch?.()) ?? null;
        if (branchAfterGate !== preBranch) {
          return finalizeOutcome(await recover(
            'SYNC_STATE_UNKNOWN',
            `门禁期间当前分支发生切换（${preBranch} -> ${branchAfterGate ?? 'detached'}），已保留现场并停止提交`,
          ));
        }
      }

      const postGateAiDigest = await digestAiReviewDir(vcs.root).catch(() => null);
      if (postGateAiDigest === null || postGateAiDigest !== preAiReviewDigest) {
        if (pushedModeC) {
          return finalizeOutcome(await recover(
            'REMOTE_PUSH_UNREVERTIBLE',
            `门禁期间 .ai-review/ 遭到本地篡改，且业务提交 ${pushedModeC.commit} 已推送远端`,
          ));
        }
        const rev = await revertAndVerifyClean({
          vcs,
          preHead,
          preBranch,
          preAiReviewDigest,
          includeAiReview: true,
          useResetHard: vcs.type === 'git',
        });
        if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
        return finalizeOutcome(abort('BUSINESS_CONTENT_CHANGED', '门禁执行期间 .ai-review/ 文件发生变化，已拒绝提交并还原工作区'));
      }

      const postGateRecheck = await validateApprovalPreconditions(deps, input);
      if ('status' in postGateRecheck) {
        if (pushedModeC) {
          return finalizeOutcome(await recover(
            'REMOTE_PUSH_UNREVERTIBLE',
            `门禁通过但共享状态已变化（${postGateRecheck.message}），且业务提交 ${pushedModeC.commit} 已推送`,
          ));
        }
        const rev = await revertAndVerifyClean({
          vcs,
          preHead,
          preBranch,
          preAiReviewDigest,
          ...(patchRestore ? { patchRestore } : {}),
          useResetHard: Boolean(localModeC),
        });
        if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
        return finalizeOutcome(postGateRecheck);
      }

      const postGateBusiness = await collectCommitEntries(vcs.root, businessPathsToVerify);
      const postGateMap = new Map(postGateBusiness.entries.map((e) => [e.path, `${e.blobHash}:${e.mode ?? ''}`]));
      const postGateMissing = new Set(postGateBusiness.missing);
      let contentChanged = postGateMap.size !== preGateSnapshotMap.size || postGateMissing.size !== preGateMissingSet.size;
      if (!contentChanged) {
        for (const [p, sig] of preGateSnapshotMap) {
          if (postGateMap.get(p) !== sig) { contentChanged = true; break; }
        }
      }
      if (!contentChanged && localModeC && (await vcs.getTreeHash?.('HEAD')) !== localModeC.expectedTreeHash) {
        contentChanged = true;
      }
      if (!contentChanged && pushedModeC && (await vcs.getTreeHash?.('HEAD')) !== pushedModeC.expectedTreeHash) {
        contentChanged = true;
      }
      if (!contentChanged) {
        const statusNow = await vcs.ensureCleanWorkspace();
        if (localModeC || pushedModeC) {
          // Case B 下，门禁不得在已提交树之上留下任何未提交工作区改动或 .tmp 产物
          if (!statusNow.clean) contentChanged = true;
        } else {
          const extraDirty = statusNow.dirtyPaths.filter((p) => !businessPathsToVerify.includes(p));
          if (extraDirty.length > 0) contentChanged = true;
        }
      }

      if (contentChanged) {
        if (pushedModeC) {
          return finalizeOutcome(await recover(
            'REMOTE_PUSH_UNREVERTIBLE',
            `门禁后业务内容快照或工作区发生变化，且提交 ${pushedModeC.commit} 已推送远端`,
          ));
        }
        const rev = await revertAndVerifyClean({
          vcs,
          preHead,
          preBranch,
          preAiReviewDigest,
          ...(patchRestore ? { patchRestore } : {}),
          useResetHard: Boolean(localModeC),
        });
        if (!rev.ok) return finalizeOutcome(await recover('RESTORE_INCOMPLETE', rev.detail));
        return finalizeOutcome(abort('BUSINESS_CONTENT_CHANGED', '门禁执行期间业务文件内容发生变化，已拒绝提交并还原工作区'));
      }

      // Step 10: 落地提交
      log('步骤 10：写入批准记录并执行原子落地提交');
      if (pushedModeC) {
        const landed = await landMetaClosingCommitForPushed({
          deps,
          input,
          snapshot,
          pushedHash: pushedModeC.commit,
          gateResults,
          applyMode,
          base: currentBase,
          summary: applySummary,
          canRetry: attemptNumber < MAX_COMMIT_RETRIES,
        });
        if (landed.retry) {
          pushedCommitCarriedOver = {
            commit: pushedModeC.commit,
            remoteRef: pushedModeC.remoteRef,
            treeHash: pushedModeC.expectedTreeHash,
            summary: applySummary,
            gateResults,
            snapshot,
            applyMode,
            base: currentBase,
          };
          continue;
        }
        return finalizeOutcome(landed.outcome);
      }

      const landed = await landApprovalCommit({
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
        maxRetries: MAX_COMMIT_RETRIES,
      });
      if (landed.retry) continue;
      return finalizeOutcome(landed.outcome);
    }

    // 若携带了已推送的业务提交且重试耗尽，严禁返回 ABORTED（必须进 RECOVERY_REQUIRED）
    if (pushedCommitCarriedOver) {
      return finalizeOutcome(await recover(
        'COMMIT_OUTCOME_UNKNOWN',
        `业务提交 ${pushedCommitCarriedOver.commit} 已推送，但元数据关闭提交 C_meta 连续撞车耗尽重试次数`,
        '已推送业务提交但元数据关闭提交重试耗尽，请人工确认',
      ));
    }
    return finalizeOutcome(abort('MAX_RETRIES_EXCEEDED', '批准重试次数耗尽'));
  } catch (error) {
    if (writeWindowOpened) {
      const detail = error instanceof Error ? error.message : String(error);
      return finalizeOutcome(await recover('COMMIT_OUTCOME_UNKNOWN', `批准写入窗口内发生未预期异常：${detail}`));
    }
    throw error;
  }
}
