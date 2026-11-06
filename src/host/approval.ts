import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePatch, isAiReviewPath } from './patch.js';
import { runGateChecks } from './validator.js';
import type { Runner, RunnerRequest } from './runner.js';
import type { ReviewStore } from './store.js';
import type {
  AppSettings,
  ApprovalAbortReason,
  ApprovalDecisions,
  ApprovalOutcome,
  ConcurrencyGuard,
  ReviewCandidate,
  RunnerExecutionResult,
} from './types.js';
import type { VcsAdapter } from './vcs.js';

export const MAX_COMMIT_RETRIES = 2;

/** §4.7/I8：human_decisions 全覆盖校验——每个 id 被确认或知悉，waived 必须有非空理由。 */
export function checkDecisionCoverage(
  decisions: { id: string; question: string }[],
  confirmed: string[],
  waived: { id: string; reason: string }[],
): string[] {
  const errors: string[] = [];
  for (const item of waived) {
    if (!item.reason.trim()) errors.push(`知悉项 ${item.id} 缺少理由`);
  }
  const confirmedSet = new Set(confirmed);
  const waivedSet = new Set(waived.map((item) => item.id));
  for (const item of decisions) {
    if (!confirmedSet.has(item.id) && !waivedSet.has(item.id)) {
      errors.push(`人工判断项 ${item.id} 未确认也未标记知悉：${item.question}`);
    }
  }
  return errors;
}

/** §4.9：commit_message 首行必须与 title 完全一致。 */
export function checkCommitMessage(title: string, commitMessage: string): string | null {
  const firstLine = commitMessage.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'commit_message 为空：批准前必须填写提交信息';
  if (firstLine !== title.trim()) return `commit_message 首行必须与 title 一致：${JSON.stringify(firstLine)} vs ${JSON.stringify(title)}`;
  return null;
}

export interface RunnerLike {
  run(): Promise<RunnerExecutionResult>;
}

export interface ApprovalDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  makeRunner: (request: RunnerRequest) => RunnerLike | Runner;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
}

interface Backup {
  reviewPath: string;
  reviewText: string;
  patches: { path: string; text: string }[];
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

export class ApprovalOrchestrator {
  constructor(private readonly deps: ApprovalDeps) {}

  async approve(
    id: string,
    guard: ConcurrencyGuard,
    jobId: string,
    log: (line: string) => void,
    decisions: ApprovalDecisions = { confirmed: [], waived: [] },
  ): Promise<ApprovalOutcome> {
    const { store, vcs, settings } = this.deps;
    const maxAttempts = MAX_COMMIT_RETRIES + 1;
    let lastCommitError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`批准流程开始（第 ${String(attempt)}/${String(maxAttempts)} 次）`);
      const candidate = await this.reload(id, guard, log);
      if (!candidate) {
        return {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          message: '候选已被其他人更新（版本或负责人变化），请重新加载后再批准。',
          jobId,
        };
      }
      // §4.7/I8：人工判断项必须逐项确认或知悉（waived 带理由）。
      const decisionErrors = checkDecisionCoverage(candidate.meta.humanDecisions, decisions.confirmed, decisions.waived);
      if (decisionErrors.length > 0) {
        return {
          status: 'ABORTED',
          reason: 'DECISIONS_UNCONFIRMED',
          message: `人工判断项未全部处理，无法批准：\n${decisionErrors.join('\n')}`,
          jobId,
        };
      }
      // §4.9：commit_message 首行 == title。
      const messageError = checkCommitMessage(candidate.meta.title, candidate.meta.commitMessage);
      if (messageError) {
        return { status: 'ABORTED', reason: 'COMMIT_MESSAGE_MISMATCH', message: messageError, jobId };
      }
      const validation = await store.validateCandidate(candidate);
      if (validation.length > 0) {
        return {
          status: 'ABORTED',
          reason: 'INTERNAL_ERROR',
          message: `评审数据不完整，无法批准：\n${validation.join('\n')}`,
          jobId,
        };
      }
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) {
        return { status: 'ABORTED', reason: 'DIRTY_WORKSPACE', message: clean.message, jobId };
      }
      log('工作区干净，准备同步最新基线');
      if (settings.syncBeforeApprove) {
        const sync = await vcs.syncAndGetLatestBase();
        log(sync.message);
        if (/同步失败/.test(sync.message)) {
          return {
            status: 'ABORTED',
            reason: 'INTERNAL_ERROR',
            message: `同步最新基线失败：${sync.message}`,
            jobId,
          };
        }
      }
      const base = await vcs.getCurrentBase();
      if (!base) {
        return { status: 'ABORTED', reason: 'INTERNAL_ERROR', message: '无法读取当前基线版本', jobId };
      }
      const patch = await store.currentPatch(candidate);
      log(`严格应用版本 ${String(candidate.meta.currentRevision)} 的补丁（基线 ${base.slice(0, 12)}）`);
      const applied = await vcs.applyPatch(patch.path, false);
      if (!applied.ok) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return this.fixOrFallback(
          'PATCH_CONFLICT',
          applied.message,
          candidate,
          jobId,
          log,
        );
      }
      log('补丁已应用，开始执行门禁检查');
      const report = await runGateChecks(candidate.meta.gateChecks, {
        cwd: store.repoRoot,
        baseRevision: base,
        timeoutMs: settings.gateTimeoutMs,
        onLine: (line) => {
          if (line.trim().length > 0) log(`  ${line.slice(0, 500)}`);
        },
      });
      log(report.allPassed ? '门禁检查全部通过' : '门禁检查存在失败项');
      if (!report.allPassed) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return this.fixOrFallback('GATE_CHECK_FAILED', report.formattedEvidenceMarkdown, candidate, jobId, log);
      }
      const fresh = await this.reload(id, guard, log);
      if (!fresh) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          message: '门禁执行期间候选被其他人更新，已回滚业务改动。',
          jobId,
        };
      }
      const backup = await this.backup(fresh);
      await store.applyApproval(fresh, guard.expectedOwner, report, null, decisions);
      const patchPaths = fresh.meta.revisions.map((revision) =>
        relative(store.repoRoot, path.join(fresh.dirPath, revision.patch)),
      );
      const businessPaths = parsePatch(patch.text).paths.filter((file) => !isAiReviewPath(file));
      // §4.9：业务提交使用 review.md 中的最新 commit_message（首行 == title），不用插件拼接的固定标题。
      const businessMessage = fresh.meta.commitMessage.trim()
        || `review(${id}): approve rev ${String(fresh.meta.currentRevision)}`;
      const commit = await vcs.atomicCommit({
        message: businessMessage,
        paths: [...businessPaths, relative(store.repoRoot, fresh.dirPath)],
        deletePaths: patchPaths,
      });
      if (!commit.success) {
        lastCommitError = commit.errorOutput;
        log(`提交失败：${commit.errorOutput}`);
        await this.restore(backup);
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        if (commit.outOfDate && attempt < maxAttempts) {
          log('远端基线前进，正在重试（先同步最新基线）');
          continue;
        }
        return {
          status: 'ABORTED',
          reason: 'MAX_RETRIES_EXCEEDED',
          message: `原子提交失败，已回滚到 pending${commit.outOfDate ? '（基线竞争）' : ''}：\n${commit.errorOutput}`,
          jobId,
        };
      }
      log(`批准提交成功：${commit.commitRevision ?? '(无版本号)'}`);
      let backfillNote = '';
      if (fresh.meta.approval) {
        fresh.meta.approval.commitRevision = commit.commitRevision;
        try {
          // §8 规则 6：回填只写 commit_revision，不改变 updated_at（幂等可重试）。
          await store.write(fresh, { touchUpdatedAt: false });
          const backfill = await vcs.atomicCommit({
            message: `review(${id}): record commit_revision ${commit.commitRevision ?? ''}`.trim(),
            paths: [relative(store.repoRoot, fresh.dirPath)],
          });
          if (!backfill.success) backfillNote = `（commit_revision 回填失败：${backfill.errorOutput}）`;
        } catch (error) {
          backfillNote = `（commit_revision 回填失败：${error instanceof Error ? error.message : String(error)}）`;
        }
      }
      return {
        status: 'COMMITTED',
        message: `已批准并原子提交版本 ${String(fresh.meta.currentRevision)}${backfillNote}`,
        ...(commit.commitRevision ? { commitRevision: commit.commitRevision } : {}),
        jobId,
      };
    }
    return {
      status: 'ABORTED',
      reason: 'MAX_RETRIES_EXCEEDED',
      message: `提交重试次数已用完：${lastCommitError}`,
      jobId,
    };
  }

  private async reload(id: string, guard: ConcurrencyGuard, log: (line: string) => void): Promise<ReviewCandidate | null> {
    try {
      const detail = await this.deps.store.get(id, null);
      const candidate = detail.candidate;
      if (candidate.parseError) {
        log(`候选数据无效：${candidate.parseError}`);
        return null;
      }
      if (candidate.meta.currentRevision !== guard.expectedRevision) {
        log(`版本已从 ${String(guard.expectedRevision)} 变为 ${String(candidate.meta.currentRevision)}`);
        return null;
      }
      if (candidate.meta.owner !== guard.expectedOwner) {
        log(`负责人已从 ${guard.expectedOwner} 变为 ${candidate.meta.owner}`);
        return null;
      }
      if (candidate.meta.status === 'approved' || candidate.meta.status === 'rejected') {
        log(`候选状态已经是 ${candidate.meta.status}`);
        return null;
      }
      return candidate;
    } catch (error) {
      log(`读取候选失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async backup(candidate: ReviewCandidate): Promise<Backup> {
    const reviewText = await readFile(candidate.reviewPath, 'utf8');
    const patches: Backup['patches'] = [];
    for (const revision of candidate.meta.revisions) {
      const file = path.join(candidate.dirPath, revision.patch);
      try {
        patches.push({ path: file, text: await readFile(file, 'utf8') });
      } catch {
        // Missing patch is a validation error handled earlier.
      }
    }
    return { reviewPath: candidate.reviewPath, reviewText, patches };
  }

  private async restore(backup: Backup): Promise<void> {
    await writeFile(backup.reviewPath, backup.reviewText, 'utf8');
    for (const patch of backup.patches) {
      await writeFile(patch.path, patch.text, 'utf8').catch(() => undefined);
    }
  }

  private async fixOrFallback(
    reason: ApprovalAbortReason,
    detail: string,
    candidate: ReviewCandidate,
    jobId: string,
    log: (line: string) => void,
  ): Promise<ApprovalOutcome> {
    const { store, vcs, settings } = this.deps;
    if (!settings.autoFixOnFailure) {
      return {
        status: 'FALLBACK_TO_PENDING',
        reason,
        message: `批准中止（${reason}）。候选保持 pending，自动修复已关闭。\n\n${detail}`,
        jobId,
      };
    }
    log(`批准中止（${reason}），尝试 AI 修复失败原因`);
    const backup = await this.backup(candidate);
    const runner = this.deps.makeRunner({
      kind: settings.runner,
      settings,
      store,
      candidate,
      mode: 'RESOLVE_CONFLICT',
      comments: candidate.meta.comments.filter((comment) => comment.status !== 'resolved'),
      failureDetail: detail,
      workingTree: 'clean_base',
      log,
      ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
    });
    let result: RunnerExecutionResult;
    try {
      result = await runner.run();
    } catch (error) {
      result = { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    } finally {
      await vcs.revertBusinessWorkspace().catch(() => undefined);
    }
    if (result.manual) {
      return {
        status: 'FALLBACK_TO_PENDING',
        reason,
        message: `批准中止（${reason}），已生成手动修复提示，候选保持 pending。\n\n${result.prompt ?? detail}`,
        jobId,
      };
    }
    if (!result.success) {
      await this.restore(backup);
      return {
        status: 'ABORTED',
        reason: 'RUNNER_FAILED',
        message: `批准中止（${reason}），AI 修复也失败：${result.errorMessage ?? '未知错误'}${result.outputTail ? `\n\n${result.outputTail.slice(-4000)}` : ''}`,
        jobId,
      };
    }
    return {
      status: 'FALLBACK_TO_PENDING',
      reason,
      message: `批准中止（${reason}），AI 已生成新版本 ${String(result.newRevisionId)},候选回到 pending，请重新审核。`,
      ...(result.newRevisionId ? { newRevision: result.newRevisionId } : {}),
      jobId,
    };
  }
}
