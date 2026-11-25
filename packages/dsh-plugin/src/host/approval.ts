import { readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePatch, isAiReviewPath } from './patch.js';
import { runGateChecks } from './validator.js';
import { gitBlobHash } from './vcs.js';
import type { Runner, RunnerRequest } from './runner.js';
import type { CandidateSource, ReviewStore } from './store.js';
import type {
  AppSettings,
  ApprovalFallbackReason,
  ApprovalDecisions,
  ApprovalOutcome,
  ConcurrencyGuard,
  ReviewCandidate,
  RunnerExecutionResult,
} from './types.js';
import { composeCommitMessage } from './commit-message.js';
import { buildCommitDetails } from './commit-message.js';
import type { CommitMessageDetail } from './commit-message.js';
import type { VcsAdapter } from './vcs.js';

export const MAX_COMMIT_RETRIES = 2;

/** I8 要求每项人工判断恰好有一个决定，并记录知悉的理由以便追溯。 */
export function checkDecisionCoverage(
  decisions: { id: string; question: string }[],
  confirmed: string[],
  waived: { id: string; reason: string }[],
): string[] {
  const errors: string[] = [];
  const validIds = new Set(decisions.map((item) => item.id));
  const confirmedSeen = new Set<string>();
  for (const raw of confirmed) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) {
      errors.push('确认项 id 不能为空');
      continue;
    }
    if (!validIds.has(id)) errors.push(`确认项 ${id} 不属于当前人工判断项`);
    if (confirmedSeen.has(id)) errors.push(`确认项 ${id} 重复`);
    confirmedSeen.add(id);
  }
  const waivedSeen = new Set<string>();
  for (const item of waived) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      errors.push('知悉项 id 不能为空');
      continue;
    }
    if (!validIds.has(id)) errors.push(`知悉项 ${id} 不属于当前人工判断项`);
    if (waivedSeen.has(id)) errors.push(`知悉项 ${id} 重复`);
    if (confirmedSeen.has(id)) errors.push(`判断项 ${id} 同时被确认与知悉`);
    if (!item.reason.trim()) errors.push(`知悉项 ${id} 缺少理由`);
    waivedSeen.add(id);
  }
  for (const item of decisions) {
    if (!confirmedSeen.has(item.id) && !waivedSeen.has(item.id)) {
      errors.push(`人工判断项 ${item.id} 未确认也未标记知悉：${item.question}`);
    }
  }
  return errors;
}

export function checkCommitMessage(title: string, commitMessage: string): string | null {
  const firstLine = commitMessage.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'commit_message 为空：批准前必须填写提交信息';
  if (firstLine !== title.trim()) return `commit_message 首行必须与 title 一致：${JSON.stringify(firstLine)} vs ${JSON.stringify(title)}`;
  return null;
}

export interface RunnerLike {
  run(): Promise<RunnerExecutionResult>;
}

export interface ApprovalCommitInput {
  commitMessage?: string;
  commitDetail?: CommitMessageDetail;
  commitMessageBody?: string;
}

export interface ApprovalDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  makeRunner: (request: RunnerRequest) => RunnerLike | Runner;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  /** 每次重读都绑定当前共享快照，以免工作区草稿参与批准判定。 */
  sharedSource?: () => Promise<CandidateSource | undefined>;
  /** 返回阻止批准的被拒候选 ID。窗口与人工重开豁免由提供者判定。 */
  checkDuplicate?: () => Promise<string | null>;
  checkFinding?: (candidate: ReviewCandidate) => Promise<{ reason: 'STATE_CONFLICT' | 'CONCURRENCY_MISMATCH'; message: string } | null>;
  beginFindingCommit?: (candidate: ReviewCandidate, paths: string[], probe: string | null) => Promise<void>;
  finishFindingCommit?: (candidate: ReviewCandidate) => Promise<void>;
  validateNewRevision?: (previous: ReviewCandidate, latest: ReviewCandidate) => Promise<string[]>;
  /** 只在仍可安全中止的检查点轮询。 */
  shouldCancel?: () => boolean;
  signal?: AbortSignal;
}

interface Backup {
  reviewPath: string;
  reviewText: string;
  patches: { path: string; text: string }[];
}

interface ReloadResult {
  candidate: ReviewCandidate | null;
  conflict: 'guard' | 'state' | null;
  status?: string;
  /** 当前补丁与评审数据必须取自这次读取绑定的同一快照。 */
  source?: CandidateSource;
}

interface BusinessFileSnapshot {
  blobHash: string;
  mode: string;
}

function diffBusinessSnapshot(
  before: Map<string, BusinessFileSnapshot | null>,
  after: Map<string, BusinessFileSnapshot | null>,
): string[] {
  const changed: string[] = [];
  for (const [file, snapshot] of before) {
    const next = after.get(file) ?? null;
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) changed.push(file);
  }
  return changed;
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
    operator?: string,
    commitMessage?: string,
    commitInput?: ApprovalCommitInput,
  ): Promise<ApprovalOutcome> {
    const messageOverride = commitInput?.commitMessage !== undefined ? commitInput.commitMessage : commitMessage;
    const businessMessageFor = async (candidate: ReviewCandidate): Promise<string | undefined> => {
      const detail = commitInput?.commitDetail;
      if (!detail) return undefined;
      const body = detail === 'detailed' ? await this.buildDetailBody(candidate) : '';
      return composeCommitMessage(candidate, detail, body);
    };
    const { store, vcs, settings } = this.deps;
    const maxAttempts = MAX_COMMIT_RETRIES + 1;
    let lastCommitError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`批准流程开始（第 ${String(attempt)}/${String(maxAttempts)} 次）`);
      if (this.deps.shouldCancel?.()) {
        return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: '已按取消请求中止（未产生共享提交）', jobId };
      }
      const pre = await this.runPrechecks(id, guard, decisions, jobId, log, messageOverride);
      if ('outcome' in pre) return pre.outcome;
      let candidate = pre.candidate;
      let sharedSource = pre.source;
      const duplicate1 = await this.deps.checkDuplicate?.();
      if (duplicate1) {
        return {
          status: 'ABORTED',
          reason: 'DUPLICATE_CANDIDATE',
          message: `该候选与窗口内的被拒候选完全重复（${duplicate1}），不能批准。`,
          detail: `duplicateOf=${duplicate1}`,
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
        if (sync.failed) {
          return {
            status: 'ABORTED',
            reason: 'SYNC_FAILED',
            message: `同步最新基线失败：${sync.message}`,
            jobId,
          };
        }
        if (sync.uncertain || sync.base === null || sync.base === undefined) {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'SYNC_STATE_UNKNOWN',
            message: '同步后无法确定当前基线状态，需人工确认 VCS 与工作区。',
            detail: sync.message,
            jobId,
          };
        }
        // 同步可能推进共享快照，基于原快照的预检结果随之失效。
        const resync = await this.runPrechecks(id, guard, decisions, jobId, log, messageOverride);
        if ('outcome' in resync) return resync.outcome;
        candidate = resync.candidate;
        sharedSource = resync.source;
        const duplicate2 = await this.deps.checkDuplicate?.();
        if (duplicate2) {
          return {
            status: 'ABORTED',
            reason: 'DUPLICATE_CANDIDATE',
            message: `同步后该候选与窗口内的被拒候选完全重复（${duplicate2}），不能批准。`,
            detail: `duplicateOf=${duplicate2}`,
            jobId,
          };
        }
      }
      const base = await vcs.getCurrentBase();
      if (!base) {
        return { status: 'ABORTED', reason: 'SYNC_FAILED', message: '无法读取当前基线版本', jobId };
      }
      const patch = sharedSource
        ? await store.currentPatch(candidate, sharedSource)
        : await store.currentPatch(candidate);
      const touchedPaths = parsePatch(patch.text).paths;
      const forbiddenPaths = touchedPaths.filter((file) => isAiReviewPath(file));
      if (forbiddenPaths.length > 0) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'INVALID_CANDIDATE',
          message: `补丁包含禁止路径，已在应用前拒绝：\n${forbiddenPaths.join('\n')}`,
          jobId,
        };
      }
      log(`严格应用版本 ${String(candidate.meta.currentRevision)} 的补丁（基线 ${base.slice(0, 12)}）`);
      // VCS 接受补丁文件。放在仓库外可避免把中间文件写入业务工作区。
      const tempPatch = path.join(tmpdir(), `dcr-approval-${String(process.pid)}-${String(Date.now())}.patch`);
      await writeFile(tempPatch, patch.text, 'utf8');
      let applied;
      let svnAttempt;
      try {
        svnAttempt = await vcs.applyPatchForApproval?.(tempPatch, this.deps.signal);
        applied = svnAttempt ?? await vcs.applyPatch(tempPatch, false);
      } finally {
        await rm(tempPatch, { force: true }).catch(() => undefined);
      }
      if (!applied.ok) {
        if (svnAttempt?.workspace === 'unknown') {
          return { status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', jobId,
            message: 'SVN 实际应用结果无法核验，已保留现场', detail: applied.message };
        }
        if (svnAttempt) {
          if (!applied.conflict) {
            return { status: 'ABORTED', reason: 'SYNC_FAILED', jobId, message: 'SVN 补丁预检无法核验', detail: applied.message };
          }
          const afterCheck = await vcs.ensureCleanWorkspace();
          if (!afterCheck.clean) {
            return { status: 'ABORTED', reason: 'DIRTY_WORKSPACE', jobId, message: afterCheck.message };
          }
        } else {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
        }
        return this.fixOrFallback(
          'PATCH_CONFLICT',
          applied.message,
          candidate,
          jobId,
          log,
          base,
        );
      }
      const businessPaths = touchedPaths.filter((file) => !isAiReviewPath(file));
      const businessSnapshot = await this.snapshotBusiness(businessPaths);
      log('补丁已应用，开始执行门禁检查');
      const report = await runGateChecks(candidate.meta.gateChecks, {
        cwd: store.repoRoot,
        baseRevision: base,
        timeoutMs: settings.gateTimeoutMs,
        onLine: (line) => {
          if (line.trim().length > 0) log(`  ${line.slice(0, 500)}`);
        },
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      });
      log(report.allPassed ? '门禁检查全部通过' : '门禁检查存在失败项');
      if (this.deps.signal?.aborted) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: '门禁已按取消请求终止，未产生共享提交', jobId };
      }
      if (!report.allPassed) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return this.fixOrFallback('GATE_CHECK_FAILED', report.formattedEvidenceMarkdown, candidate, jobId, log, base);
      }
      // AC-APPROVE-01 要求门禁后重新验证共享事实和业务内容，防止门禁期间的改动混入提交。
      const baseAfterGates = await vcs.getCurrentBase();
      if (baseAfterGates === null || baseAfterGates !== base) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          message: `门禁执行期间基线发生漂移（${base.slice(0, 12)} → ${baseAfterGates?.slice(0, 12) ?? '(不可读)'}），已回滚业务改动。`,
          jobId,
        };
      }
      if (this.deps.shouldCancel?.()) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: '已按取消请求中止（提交前，未产生共享提交）', jobId };
      }
      const duplicate3 = await this.deps.checkDuplicate?.();
      if (duplicate3) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'DUPLICATE_CANDIDATE',
          message: `门禁执行期间出现完全重复的被拒候选（${duplicate3}），已回滚业务改动。`,
          detail: `duplicateOf=${duplicate3}`,
          jobId,
        };
      }
      const freshReload = await this.reload(id, guard, log);
      if (!freshReload.candidate) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          message: '门禁执行期间候选被其他人更新，已回滚业务改动。',
          jobId,
        };
      }
      const fresh = freshReload.candidate;
      const findingConflict = await this.findingConflict(fresh);
      if (findingConflict) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', ...findingConflict, jobId };
      }
      if (messageOverride !== undefined) {
        fresh.meta.commitMessage = messageOverride;
        const replacedMessageError = checkCommitMessage(fresh.meta.title, fresh.meta.commitMessage);
        if (replacedMessageError) {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
          return {
            status: 'ABORTED',
            reason: 'COMMIT_MESSAGE_MISMATCH',
            message: replacedMessageError,
            jobId,
          };
        }
      }
      const snapshotAfter = await this.snapshotBusiness(businessPaths);
      const businessChanged = diffBusinessSnapshot(businessSnapshot, snapshotAfter);
      const dirtyAfter = await vcs.ensureCleanWorkspace();
      const extraDirty = dirtyAfter.dirtyPaths.filter((file) => !businessPaths.includes(file.replaceAll('\\', '/')));
      if (businessChanged.length > 0 || extraDirty.length > 0) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: 'BUSINESS_CONTENT_CHANGED',
          message: `门禁执行期间业务内容发生变化，已回滚：\n${[...businessChanged, ...extraDirty.map((file) => `${file}（额外改动）`)].join('\n')}`,
          jobId,
        };
      }
      const backup = await this.backup(fresh);
      const patchPaths = fresh.meta.revisions.map((revision) =>
        relative(store.repoRoot, path.join(fresh.dirPath, revision.patch)),
      );
      const reviewRelPath = relative(store.repoRoot, fresh.reviewPath);
      const probePaths = [reviewRelPath, ...patchPaths];
      const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
      if (fresh.meta.findingId) {
        try {
          if (!this.deps.beginFindingCommit || !this.deps.finishFindingCommit) throw new Error('缺少发现审批状态存储');
          await this.deps.beginFindingCommit(fresh, probePaths, probeBefore);
        } catch (error) {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
          return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: error instanceof Error ? error.message : String(error), jobId };
        }
      }
      const finishFinding = async (): Promise<void> => {
        if (fresh.meta.findingId) await this.deps.finishFindingCommit?.(fresh).catch(error => log(String(error)));
      };
      await store.applyApproval(fresh, operator?.trim() || guard.expectedOwner, report, decisions);
      const reviewText = await readFile(fresh.reviewPath, 'utf8');
      const reviewStat = await stat(fresh.reviewPath);
      const verifyEntries = businessPaths.flatMap((rel) => {
        const snapshot = snapshotAfter.get(rel);
        return snapshot ? [{ path: rel, blobHash: snapshot.blobHash, mode: snapshot.mode }] : [];
      });
      verifyEntries.push({
        path: reviewRelPath,
        blobHash: gitBlobHash(reviewText),
        mode: (reviewStat.mode & 0o111) !== 0 ? '100755' : '100644',
      });
      const verifyDeletions = [...new Set([
        ...patchPaths,
        ...businessPaths.filter((rel) => !snapshotAfter.get(rel)),
      ])];
      const businessMessage = (await businessMessageFor(fresh))
        ?? (fresh.meta.commitMessage || `review(${id}): approve rev ${String(fresh.meta.currentRevision)}`);
      if (commitInput?.commitDetail) log(`提交信息模式：${commitInput.commitDetail === 'detailed' ? '详细（单行综述 + 空行 + 事实正文）' : '简略（单行）'}`);
      const commit = await vcs.atomicCommit({
        message: businessMessage,
        paths: [...businessPaths, relative(store.repoRoot, fresh.dirPath)],
        deletePaths: patchPaths,
        verifyEntries,
        verifyDeletions,
      });
      if (commit.verificationFailed) return {
          status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN',
          message: '提交已执行但完整核验失败，请保留现场并人工核对。', detail: commit.errorOutput, jobId,
      };
      if (!commit.success) {
        lastCommitError = commit.errorOutput;
        log(`提交失败：${commit.errorOutput}`);
        const outcome = await this.classifyCommitFailure({
          probeBefore,
          probePaths,
          reviewRelPath,
          expectedReviewText: reviewText,
          expectedEntries: verifyEntries,
          expectedDeletions: verifyDeletions,
          backup,
          outOfDate: commit.outOfDate,
          errorOutput: commit.errorOutput,
          restorePreparation: commit.restorePreparation,
          canRetry: attempt < maxAttempts,
          jobId,
          log,
        });
        if (outcome?.status !== 'RECOVERY_REQUIRED') await finishFinding();
        if (outcome) return outcome;
        continue;
      }
      let commitRevision: string = commit.commitRevision ?? '';
      if (!commitRevision) {
        // 提交成功但适配器未提供版本号时，用提交探针补充定位。
        const probeAfter = await vcs.getCommitProbe(probePaths).catch(() => null);
        if (probeAfter === null || probeAfter === probeBefore) {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            message: '业务提交已执行，但无法确定提交版本号；请人工核对 VCS 历史后处理。',
            detail: `atomicCommit 成功但 commitRevision 为空，且提交探针无法证明版本前进（候选 ${id}）`,
            jobId,
          };
        }
        commitRevision = probeAfter;
      }
      log(`批准提交成功：${commitRevision.slice(0, 12)}`);
      await finishFinding();
      return {
        status: 'COMMITTED',
        message: `已批准并原子提交版本 ${String(fresh.meta.currentRevision)}`,
        commitRevision,
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

  /**
   * 只有证明提交未落地才允许恢复备份。返回 null 表示已经恢复，可安全重试。
   */
  private async classifyCommitFailure(input: {
    probeBefore: string | null;
    probePaths: string[];
    reviewRelPath: string;
    expectedReviewText: string;
    expectedEntries: { path: string; blobHash: string }[];
    expectedDeletions: string[];
    backup: Backup;
    outOfDate: boolean;
    errorOutput: string;
    restorePreparation?: () => Promise<void>;
    canRetry: boolean;
    jobId: string;
    log: (line: string) => void;
  }): Promise<ApprovalOutcome | null> {
    const { vcs } = this.deps;
    const probeAfter = await vcs.getCommitProbe(input.probePaths).catch(() => null);
    if (input.probeBefore === null || probeAfter === null) {
      return {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        message: '提交失败且无法读取提交探针，不能判定提交是否存在；请人工核对 VCS 状态。',
        detail: input.errorOutput,
        jobId: input.jobId,
      };
    }
    if (probeAfter !== input.probeBefore) {
      const text = await vcs.readFileAt(probeAfter, input.reviewRelPath).catch(() => null);
      let complete = text === input.expectedReviewText;
      for (const entry of input.expectedEntries) {
        const actual = await vcs.readFileAt(probeAfter, entry.path).catch(() => null);
        if (actual === null || gitBlobHash(actual) !== entry.blobHash) complete = false;
      }
      for (const relPath of input.expectedDeletions) {
        const actual = await vcs.readFileAt(probeAfter, relPath).catch(() => null);
        if (actual !== null) complete = false;
      }
      if (complete) {
        input.log(`提交命令报错但提交已落地且完整内容匹配（${probeAfter.slice(0, 12)}），按成功继续`);
        return {
          status: 'COMMITTED',
          message: '提交命令超时/报错，但 VCS 中提交已存在且完整内容匹配，按成功处理。',
          commitRevision: probeAfter,
          jobId: input.jobId,
        };
      }
      return {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        message: '提交失败但提交探针已前进且本次预期完整内容不匹配，无法确认提交归属；禁止回滚，请人工核对。',
        detail: `probe=${probeAfter.slice(0, 12)}，review/业务内容/删除集合中至少一项不匹配或不可读`,
        jobId: input.jobId,
      };
    }
    input.log('已证明业务提交不存在，恢复操作前快照');
    try {
      await input.restorePreparation?.();
      await this.restore(input.backup);
      await vcs.revertBusinessWorkspace();
      const restored = await vcs.ensureCleanWorkspace();
      if (!restored.clean) throw new Error(restored.message);
    } catch (error) {
      return {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        message: '已确认未提交，但批准前状态未能完整恢复。',
        detail: String(error),
        jobId: input.jobId,
      };
    }
    if (input.outOfDate && input.canRetry) {
      input.log('远端基线前进（撞车），先同步最新基线后重试');
      return null;
    }
    return {
      status: 'ABORTED',
      reason: input.outOfDate ? 'MAX_RETRIES_EXCEEDED' : 'COMMIT_FAILED',
      message: `原子提交失败，已恢复到批准前状态${input.outOfDate ? '（基线竞争且重试已耗尽）' : ''}：\n${input.errorOutput}`,
      jobId: input.jobId,
    };
  }

  private async reload(
    id: string,
    guard: ConcurrencyGuard,
    log: (line: string) => void,
  ): Promise<ReloadResult> {
    try {
      const source = this.deps.sharedSource ? await this.deps.sharedSource() : undefined;
      if (source) {
        const { month, slug } = this.deps.store.resolveCandidateDir(id);
        if (await source.hasLocalChanges(month, slug)) {
          log('候选存在本地或暂存改动，共享/本地边界无法证明');
          return { candidate: null, conflict: 'guard', status: 'local' };
        }
      }
      const detail = await this.deps.store.get(id, null, source);
      const candidate = detail.candidate;
      if (candidate.parseError) {
        log(`候选数据无效：${candidate.parseError}`);
        return { candidate: null, conflict: 'guard' };
      }
      if (candidate.meta.currentRevision !== guard.expectedRevision) {
        log(`版本已从 ${String(guard.expectedRevision)} 变为 ${String(candidate.meta.currentRevision)}`);
        return { candidate: null, conflict: 'guard' };
      }
      if (candidate.meta.owner !== guard.expectedOwner) {
        log(`负责人已从 ${guard.expectedOwner} 变为 ${candidate.meta.owner}`);
        return { candidate: null, conflict: 'guard' };
      }
      // 评论等共享写入不会推进补丁版本，仍须用时间戳检出。
      const expectedAt = new Date(guard.expectedUpdatedAt).getTime();
      if (expectedAt !== new Date(candidate.meta.updatedAt).getTime()) {
        log(`候选已在其他写入中更新（updated_at ${candidate.meta.updatedAt}）`);
        return { candidate: null, conflict: 'guard' };
      }
      if (candidate.meta.status !== 'pending') {
        log(`候选状态是 ${candidate.meta.status}，不是 pending`);
        return { candidate: null, conflict: 'state', status: candidate.meta.status };
      }
      return { candidate, conflict: null, ...(source ? { source } : {}) };
    } catch (error) {
      log(`读取候选失败：${error instanceof Error ? error.message : String(error)}`);
      return { candidate: null, conflict: 'guard' };
    }
  }

  private findingConflict(candidate: ReviewCandidate) {
    if (!candidate.meta.findingId) return null;
    return this.deps.checkFinding?.(candidate)
      ?? { reason: 'STATE_CONFLICT' as const, message: '发现候选缺少同组审批守卫' };
  }

  private async runPrechecks(
    id: string,
    guard: ConcurrencyGuard,
    decisions: ApprovalDecisions,
    jobId: string,
    log: (line: string) => void,
    commitMessage?: string,
  ): Promise<{ candidate: ReviewCandidate; source?: CandidateSource } | { outcome: ApprovalOutcome }> {
    const { store } = this.deps;
    const reload = await this.reload(id, guard, log);
    if (!reload.candidate) {
      if (reload.conflict === 'state') {
        return {
          outcome: {
            status: 'ABORTED',
            reason: 'STATE_CONFLICT',
            message: `候选状态不是 pending（当前 ${reload.status ?? '未知'}）；changes_requested 需先产生新版本或由 Owner 显式转回。`,
            jobId,
          },
        };
      }
      return {
        outcome: {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          message: '候选已被其他人更新（版本/负责人/updated_at 变化），请重新加载后再批准。',
          jobId,
        },
      };
    }
    const candidate = reload.candidate;
    const findingConflict = await this.findingConflict(candidate);
    if (findingConflict) return { outcome: { status: 'ABORTED', ...findingConflict, jobId } };
    if (commitMessage !== undefined) candidate.meta.commitMessage = commitMessage;
    const decisionErrors = checkDecisionCoverage(candidate.meta.humanDecisions, decisions.confirmed, decisions.waived);
    if (decisionErrors.length > 0) {
      return {
        outcome: {
          status: 'ABORTED',
          reason: 'DECISIONS_UNCONFIRMED',
          message: `人工判断项未全部处理，无法批准：\n${decisionErrors.join('\n')}`,
          jobId,
        },
      };
    }
    const messageError = checkCommitMessage(candidate.meta.title, candidate.meta.commitMessage);
    if (messageError) {
      return { outcome: { status: 'ABORTED', reason: 'COMMIT_MESSAGE_MISMATCH', message: messageError, jobId } };
    }
    const validation = await store.validateFullCandidate(candidate, reload.source);
    if (validation.length > 0) {
      return {
        outcome: {
          status: 'ABORTED',
          reason: 'INVALID_CANDIDATE',
          message: `评审数据不完整，无法批准：\n${validation.join('\n')}`,
          jobId,
        },
      };
    }
    return { candidate, ...(reload.source ? { source: reload.source } : {}) };
  }

  /**
   * 在锁内且同步重绑后生成正文，避免正文描述旧补丁而提交新补丁。
   * 部分数据不可读时降级对应小节。
   */
  private async buildDetailBody(candidate: ReviewCandidate): Promise<string> {
    const { store, vcs, settings } = this.deps;
    const source = this.deps.sharedSource ? await this.deps.sharedSource() : undefined;
    const patch = await store.currentPatch(candidate, source).catch(() => null);
    const touched = patch ? parsePatch(patch.text).paths : [];
    const authorStats = await vcs.authorStats(touched).catch(() => undefined);
    return buildCommitDetails(candidate, {
      repoRoot: store.repoRoot,
      ...(authorStats ? { authorStats } : {}),
      ...(patch ? { patchText: patch.text } : {}),
      ...(source ? { readReviewersText: () => (source as { readReviewersText?: () => Promise<string | null> }).readReviewersText?.() ?? Promise.resolve(null) } : {}),
      vcsType: settings.vcsType === 'svn' ? 'svn' : 'git',
    });
  }

  private async snapshotBusiness(businessPaths: string[]): Promise<Map<string, BusinessFileSnapshot | null>> {
    const snapshot = new Map<string, BusinessFileSnapshot | null>();
    for (const rel of businessPaths) {
      const absolute = path.join(this.deps.store.repoRoot, rel);
      try {
        const [buffer, fileStat] = await Promise.all([readFile(absolute), stat(absolute)]);
        snapshot.set(rel, {
          blobHash: gitBlobHash(buffer),
          mode: (fileStat.mode & 0o111) !== 0 ? '100755' : '100644',
        });
      } catch {
        snapshot.set(rel, null);
      }
    }
    return snapshot;
  }

  private async backup(candidate: ReviewCandidate): Promise<Backup> {
    const reviewText = await readFile(candidate.reviewPath, 'utf8');
    const patches: Backup['patches'] = [];
    for (const revision of candidate.meta.revisions) {
      const file = path.join(candidate.dirPath, revision.patch);
      try {
        patches.push({ path: file, text: await readFile(file, 'utf8') });
      } catch {
        // 缺失补丁已由批准预检处理。
      }
    }
    return { reviewPath: candidate.reviewPath, reviewText, patches };
  }

  private async restore(backup: Backup): Promise<void> {
    await writeFile(backup.reviewPath, backup.reviewText, 'utf8');
    for (const patch of backup.patches) {
      await writeFile(patch.path, patch.text, 'utf8');
    }
  }

  /** Runner 可能创建备份中没有的文件，单纯覆盖备份不能还原候选目录。 */
  private async restoreWithCleanup(backup: Backup, dirPath: string, entriesBefore: Set<string>): Promise<void> {
    await this.restore(backup);
    const after = await readdir(dirPath).catch(() => [] as string[]);
    for (const name of after) {
      if (!entriesBefore.has(name)) await rm(path.join(dirPath, name), { force: true }).catch(() => undefined);
    }
  }

  private async fixOrFallback(
    reason: ApprovalFallbackReason,
    detail: string,
    candidate: ReviewCandidate,
    jobId: string,
    log: (line: string) => void,
    baseRevision: string,
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
    const entriesBefore = new Set(await readdir(candidate.dirPath).catch(() => [] as string[]));
    const runner = this.deps.makeRunner({
      kind: settings.runner,
      settings,
      store,
      candidate,
      mode: 'RESOLVE_CONFLICT',
      comments: candidate.meta.comments.filter((comment) => comment.status !== 'resolved'),
      failureDetail: detail,
      baseRevision,
      workingTree: 'clean_base',
      log,
      ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
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
        message: `批准中止（${reason}），已生成手动修复提示，候选保持 pending。`,
        manualPrompt: result.prompt ?? detail,
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
    // 新版本必须先成为共享事实，才可通知复核者重新审核。
    try {
      const { store } = this.deps;
      const latest = await store.get(candidate.id, null);
      const validationErrors: string[] = this.deps.validateNewRevision
        ? await this.deps.validateNewRevision(candidate, latest.candidate)
        : [];
      const current = latest.candidate.meta.revisions.find(
        (revision) => revision.id === latest.candidate.meta.currentRevision,
      );
      let patchText: string | null = null;
      if (current) {
        try {
          patchText = await readFile(path.join(latest.candidate.dirPath, current.patch), 'utf8');
        } catch {
          validationErrors.push(`新补丁不存在：${current.patch}`);
        }
      }
      if (!this.deps.validateNewRevision) {
        if (latest.candidate.parseError) validationErrors.push(latest.candidate.parseError);
        if (latest.candidate.meta.status !== 'pending') validationErrors.push('AI 新版本状态必须是 pending');
        if (latest.candidate.meta.approval !== null) validationErrors.push('AI 新版本的 approval 必须为 null');
        if (latest.candidate.meta.currentRevision <= candidate.meta.currentRevision) validationErrors.push('AI 未推进版本');
        validationErrors.push(...await store.validateFullCandidate(latest.candidate));
        if (patchText !== null && parsePatch(patchText).paths.some((file) => isAiReviewPath(file))) {
          validationErrors.push('新补丁包含禁止路径');
        }
        if (validationErrors.length === 0 && patchText !== null) {
          const tempFixPatch = path.join(tmpdir(), `dcr-fix-${String(process.pid)}-${String(Date.now())}.patch`);
          await writeFile(tempFixPatch, patchText, 'utf8');
          let applied;
          try {
            applied = await this.deps.vcs.applyPatch(tempFixPatch, false);
          } finally {
            await rm(tempFixPatch, { force: true }).catch(() => undefined);
          }
          await this.deps.vcs.revertBusinessWorkspace().catch(() => undefined);
          if (!applied.ok) validationErrors.push(`AI 新补丁无法在基线干净应用：${applied.message}`);
        }
      }
      if (validationErrors.length > 0 || !current || patchText === null) {
        await this.restoreWithCleanup(backup, candidate.dirPath, entriesBefore);
        return {
          status: 'ABORTED',
          reason: 'RUNNER_FAILED',
          message: `AI 生成的新版本未通过提交前校验，已恢复：\n${validationErrors.join('\n')}`,
          jobId,
        };
      }
      const reviewRelPath = relative(store.repoRoot, latest.candidate.reviewPath);
      const probePaths = [reviewRelPath];
      const probeBeforeFix = await this.deps.vcs.getCommitProbe(probePaths).catch(() => null);
      const writtenReview = await readFile(latest.candidate.reviewPath, 'utf8').catch(() => null);
      const reviewStat = writtenReview === null ? null : await stat(latest.candidate.reviewPath).catch(() => null);
      const patchStat = await stat(path.join(latest.candidate.dirPath, current.patch)).catch(() => null);
      const verifyEntries = [
        ...(writtenReview !== null && reviewStat !== null
          ? [{
              path: reviewRelPath,
              blobHash: gitBlobHash(writtenReview),
              mode: (reviewStat.mode & 0o111) !== 0 ? '100755' : '100644',
            }]
          : []),
        {
          path: relative(store.repoRoot, path.join(latest.candidate.dirPath, current.patch)),
          blobHash: gitBlobHash(patchText),
          ...(patchStat ? { mode: (patchStat.mode & 0o111) !== 0 ? '100755' : '100644' } : {}),
        },
      ];
      const commit = await this.deps.vcs.atomicCommit({
        message: `review(${candidate.id}): fix ${reason} (rev ${String(latest.candidate.meta.currentRevision)})`,
        paths: [relative(store.repoRoot, latest.candidate.dirPath)],
        verifyEntries,
      });
      if (commit.verificationFailed) return {
          status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN',
          message: '新版本提交已执行但完整核验失败，请保留现场并人工核对。', detail: commit.errorOutput, jobId,
      };
      if (!commit.success) {
        const probeAfter = await this.deps.vcs.getCommitProbe(probePaths).catch(() => null);
        if (probeBeforeFix === null || probeAfter === null) {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            message: '新版本提交命令失败且无法读取提交探针，请人工核对 VCS 与工作区。',
            detail: commit.errorOutput,
            jobId,
          };
        }
        if (probeAfter !== probeBeforeFix) {
          const atCommit = writtenReview === null ? null : await this.deps.vcs.readFileAt(probeAfter, reviewRelPath).catch(() => null);
          if (atCommit !== null && atCommit === writtenReview) {
            log(`AI 修复新版本提交已落地（${probeAfter.slice(0, 12)}），按成功继续`);
          } else {
            return {
              status: 'RECOVERY_REQUIRED',
              reason: 'COMMIT_OUTCOME_UNKNOWN',
              message: '新版本提交命令失败但提交探针已前进且内容不匹配，请人工核对 VCS 与工作区。',
              detail: commit.errorOutput,
              jobId,
            };
          }
        } else {
          await this.restoreWithCleanup(backup, candidate.dirPath, entriesBefore);
          return {
            status: 'ABORTED',
            reason: 'COMMIT_FAILED',
            message: `AI 已生成新版本，但提交 .ai-review 失败（已恢复）：\n${commit.errorOutput}`,
            jobId,
          };
        }
      }
      log(`AI 修复新版本已提交：${commit.commitRevision?.slice(0, 12) ?? ''}`);
    } catch (error) {
      await this.restoreWithCleanup(backup, candidate.dirPath, entriesBefore).catch(() => undefined);
      return {
        status: 'ABORTED',
        reason: 'RUNNER_FAILED',
        message: `AI 修复新版本提交异常：${error instanceof Error ? error.message : String(error)}`,
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
