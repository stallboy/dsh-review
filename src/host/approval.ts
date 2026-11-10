import { readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePatch, isAiReviewPath } from './patch.js';
import { parseReviewMarkdown } from './frontmatter.js';
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
import type { VcsAdapter } from './vcs.js';

export const MAX_COMMIT_RETRIES = 2;

/**
 * §5.4/I8：human_decisions 精确集合校验。
 * confirmed/waived 的 id 必须属于当前判断项，两集合互不相交，各自无重复，
 * 并集恰好覆盖全部判断项；每项 waive 必须有非空理由。
 */
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
  /** §7.1：批准流程内部重读共享事实的数据源（每次重建，绑定当前 VCS 快照）。 */
  sharedSource?: () => Promise<CandidateSource | undefined>;
  /** §7.5 重复候选复检：返回窗口内同指纹被拒候选 id（duplicateOf），无重复返回 null。 */
  checkDuplicate?: () => Promise<string | null>;
  /** §7.7/G30：取消请求轮询；在安全检查点（未产生共享提交前）读取并中止。 */
  shouldCancel?: () => boolean;
  /** §7.7：取消信号，用于终止批准回退中的 Runner。 */
  signal?: AbortSignal;
}

/** §5.5：commit 内容核对用——指定版本中的 review.md 是否为 approved 且 approval 非空。 */
function isApprovedReviewText(text: string): boolean {
  try {
    const parsed = parseReviewMarkdown(text);
    return parsed.meta.status === 'approved' && parsed.meta.approval !== null;
  } catch {
    return false;
  }
}

interface Backup {
  reviewPath: string;
  reviewText: string;
  patches: { path: string; text: string }[];
}

interface ReloadResult {
  candidate: ReviewCandidate | null;
  /** guard（版本/负责人/updated_at/解析失败）或 state（非 pending）冲突；成功为 null。 */
  conflict: 'guard' | 'state' | null;
  status?: string;
  /** 本次重读绑定的共享快照源；补丁内容必须与 review.md 来自同一源。 */
  source?: CandidateSource;
}

interface BusinessFileSnapshot {
  blobHash: string;
  mode: string;
}

/** §7.5 步骤 9：比较门禁前后的业务快照（内容 blob + 模式），返回发生变化的路径。 */
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
  ): Promise<ApprovalOutcome> {
    const { store, vcs, settings } = this.deps;
    const maxAttempts = MAX_COMMIT_RETRIES + 1;
    let lastCommitError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`批准流程开始（第 ${String(attempt)}/${String(maxAttempts)} 次）`);
      // §7.7：取消请求在安全检查点读取——尚未产生任何共享提交，可安全中止。
      if (this.deps.shouldCancel?.()) {
        return { status: 'ABORTED', message: '已按取消请求中止（未产生共享提交）', jobId };
      }
      // §7.5 步骤 1-4：重读共享事实 → guard/状态 → 判断项 → 提交信息 → 完整性；重复候选 ①。
      const pre = await this.runPrechecks(id, guard, decisions, jobId, log, commitMessage);
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
          // §7.5：已知且可安全恢复的同步失败返回 SYNC_FAILED。
          return {
            status: 'ABORTED',
            reason: 'SYNC_FAILED',
            message: `同步最新基线失败：${sync.message}`,
            jobId,
          };
        }
        if (sync.uncertain || sync.base === null || sync.base === undefined) {
          // §7.5：部分同步或基线状态无法确定 → 禁止自动重试，人工恢复。
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'SYNC_STATE_UNKNOWN',
            message: '同步后无法确定当前基线状态，需人工确认 VCS 与工作区。',
            detail: sync.message,
            jobId,
          };
        }
        // §7.5 步骤 6：同步后重新绑定共享快照，重跑步骤 1-4（含负向记忆）→ 重复候选 ②。
        const resync = await this.runPrechecks(id, guard, decisions, jobId, log, commitMessage);
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
      // §7.1/§7.5 步骤 7：补丁必须与 review.md 来自同一共享快照，不得读取工作区本地补丁。
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
      // git/svn apply 都以文件为输入：把共享快照中的补丁文本物化到仓库外临时文件。
      const tempPatch = path.join(tmpdir(), `dcr-approval-${String(process.pid)}-${String(Date.now())}.patch`);
      await writeFile(tempPatch, patch.text, 'utf8');
      let applied;
      try {
        applied = await vcs.applyPatch(tempPatch, false);
      } finally {
        await rm(tempPatch, { force: true }).catch(() => undefined);
      }
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
      // §7.5 步骤 7：记录目标业务文件的内容（blob）与模式快照。
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
      });
      log(report.allPassed ? '门禁检查全部通过' : '门禁检查存在失败项');
      if (!report.allPassed) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return this.fixOrFallback('GATE_CHECK_FAILED', report.formattedEvidenceMarkdown, candidate, jobId, log);
      }
      // §7.5 步骤 9：门禁后重新校验 guard、重复候选（③）与业务内容快照，防止门禁期间夹带未审核代码。
      // 先确认门禁期间基线未漂移（HEAD/相关事实未变化）。
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
        return { status: 'ABORTED', message: '已按取消请求中止（提交前，未产生共享提交）', jobId };
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
      // §7.5 步骤 3/10：请求体 commitMessage 先替换候选 commit_message 再校验；
      // 校验通过的值随本次原子提交一并写入 review.md，并作为业务提交说明。
      if (commitMessage !== undefined) {
        fresh.meta.commitMessage = commitMessage;
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
      // §12.1：approvedBy 是实际批准的操作者，不是并发期望值 expectedOwner。
      await store.applyApproval(fresh, operator?.trim() || guard.expectedOwner, report, decisions);
      const patchPaths = fresh.meta.revisions.map((revision) =>
        relative(store.repoRoot, path.join(fresh.dirPath, revision.patch)),
      );
      const reviewRelPath = relative(store.repoRoot, fresh.reviewPath);
      // §7.5 步骤 9/10：提交前把“已审核内容”的 blob/模式作为强制核对输入。
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
      // §5.6：业务提交必须使用候选 commit_message 全文（首行已校验等于 title）。
      const businessMessage = fresh.meta.commitMessage
        || `review(${id}): approve rev ${String(fresh.meta.currentRevision)}`;
      const probePaths = [reviewRelPath, ...patchPaths];
      // §5.6：提交探针按目标路径取值——SVN 的根 revision 不随子路径提交前进（H1）。
      const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
      const commit = await vcs.atomicCommit({
        message: businessMessage,
        paths: [...businessPaths, relative(store.repoRoot, fresh.dirPath)],
        deletePaths: patchPaths,
        verifyEntries,
        verifyDeletions,
      });
      if (!commit.success) {
        lastCommitError = commit.errorOutput;
        log(`提交失败：${commit.errorOutput}`);
        // §5.6 三分支：提交失败后先查询 VCS，确认提交是否实际存在，不得猜测回滚。
        const outcome = await this.classifyCommitFailure({
          probeBefore,
          probePaths,
          reviewRelPath,
          backup,
          outOfDate: commit.outOfDate,
          errorOutput: commit.errorOutput,
          canRetry: attempt < maxAttempts,
          jobId,
          log,
        });
        if (outcome) return outcome;
        continue; // 撞车且已证明提交不存在：已恢复快照，进入下一次尝试
      }
      let commitRevision: string = commit.commitRevision ?? '';
      if (!commitRevision) {
        // 提交成功但无法读取版本号：用路径级探针兜底；仍无法证明则结果不明。
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
      // §5.5（2026-11-09 修订）：单次原子提交完成；不再有第二次 commit_revision 回填提交，
      // review.md 不保存提交哈希，后续读取按 deriveApprovalCommit 从历史派生。
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
   * §5.6 三分支判定：提交命令失败后查询 VCS。
   * 返回 null 表示"已证明提交不存在且已恢复快照，可以安全重试"。
   */
  private async classifyCommitFailure(input: {
    probeBefore: string | null;
    probePaths: string[];
    reviewRelPath: string;
    backup: Backup;
    outOfDate: boolean;
    errorOutput: string;
    canRetry: boolean;
    jobId: string;
    log: (line: string) => void;
  }): Promise<ApprovalOutcome | null> {
    const { vcs } = this.deps;
    // §5.6：路径级提交探针——Git=HEAD；SVN=相关路径 last-changed-revision（根 revision 不随子路径提交前进）。
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
      // 探针前进：按提交内容核对——该版本中的 review.md 必须是本次写入的 approved 内容。
      // （§5.5；不再用可伪造/可能被并发使用的提交主题字符串判定。）
      const text = await vcs.readFileAt(probeAfter, input.reviewRelPath).catch(() => null);
      if (text !== null && isApprovedReviewText(text)) {
        input.log(`提交命令报错但提交已落地且内容匹配（${probeAfter.slice(0, 12)}），按成功继续`);
        return {
          status: 'COMMITTED',
          message: '提交命令超时/报错，但 VCS 中提交已存在且内容匹配，按成功处理。',
          commitRevision: probeAfter,
          jobId: input.jobId,
        };
      }
      return {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        message: '提交失败但提交探针已前进且提交内容不匹配，无法确认提交归属；禁止回滚，请人工核对。',
        detail: `probe=${probeAfter.slice(0, 12)}，${input.reviewRelPath} 在该版本不是 approved 或不可读`,
        jobId: input.jobId,
      };
    }
    // 探针未前进 → 证明业务提交不存在：恢复操作前快照（§5.6 分支 2）。
    input.log('已证明业务提交不存在，恢复操作前快照');
    await this.restore(input.backup);
    await vcs.revertBusinessWorkspace().catch(() => undefined);
    if (input.outOfDate && input.canRetry) {
      input.log('远端基线前进（撞车），先同步最新基线后重试');
      return null;
    }
    return {
      status: 'ABORTED',
      // §7.5/AC-RETRY-01：非撞车的明确失败是 COMMIT_FAILED；只有真实耗尽才是 MAX_RETRIES_EXCEEDED。
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
      // §7.1：批准流程重读候选必须使用共享快照源（本地未提交改动不得参与 guard/状态判定）。
      const source = this.deps.sharedSource ? await this.deps.sharedSource() : undefined;
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
      // §7.5 步骤 1：guard 三字段完整校验（updated_at 检出不推进版本的写入）。
      const expectedAt = new Date(guard.expectedUpdatedAt).getTime();
      if (expectedAt !== new Date(candidate.meta.updatedAt).getTime()) {
        log(`候选已在其他写入中更新（updated_at ${candidate.meta.updatedAt}）`);
        return { candidate: null, conflict: 'guard' };
      }
      // §7.5/G19：只有 pending 可批准；changes_requested 等非 pending 是状态冲突而非并发冲突。
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

  /** §7.5 步骤 1-4：guard/状态 → 判断项 → 提交信息 → 候选完整性。 */
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
    // §7.5 步骤 3：/approve 提供 commitMessage 时先替换候选 commit_message，再做首行校验。
    if (commitMessage !== undefined) candidate.meta.commitMessage = commitMessage;
    // §4.7/I8：人工判断项必须逐项确认或知悉（waived 带理由）。
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
    // §4.9：commit_message 首行 == title。
    const messageError = checkCommitMessage(candidate.meta.title, candidate.meta.commitMessage);
    if (messageError) {
      return { outcome: { status: 'ABORTED', reason: 'COMMIT_MESSAGE_MISMATCH', message: messageError, jobId } };
    }
    const validation = await store.validateFullCandidate(candidate);
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

  /** §7.5 步骤 7/9：目标业务文件的内容（Git blob）与模式快照；缺失为 null。 */
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

  /** §5.6(2)：恢复操作前文件，并删除本次 Runner 新生成、操作前不存在的文件。 */
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
    // §7.5/G27/G32：Runner 成功 → 先做全部提交前校验，通过后由 Host 原子提交新版本目录；
    // 只有提交成功才返回 FALLBACK_TO_PENDING + newRevision（新版本必须成为共享事实）。
    try {
      const { store } = this.deps;
      const latest = await store.get(candidate.id, null);
      const validationErrors: string[] = [];
      if (latest.candidate.parseError) validationErrors.push(latest.candidate.parseError);
      if (latest.candidate.meta.status !== 'pending') {
        validationErrors.push(`AI 新版本状态必须是 pending，当前为 ${latest.candidate.meta.status}`);
      }
      if (latest.candidate.meta.approval !== null) validationErrors.push('AI 新版本的 approval 必须为 null');
      if (latest.candidate.meta.currentRevision <= candidate.meta.currentRevision) {
        validationErrors.push(`AI 未推进版本：current_revision 仍为 ${String(latest.candidate.meta.currentRevision)}`);
      }
      validationErrors.push(...await store.validateFullCandidate(latest.candidate));
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
        if (patchText !== null && parsePatch(patchText).paths.some((file) => isAiReviewPath(file))) {
          validationErrors.push('新补丁包含禁止路径（.ai-review/.tmp/node_modules/.git/.svn）');
        }
      }
      if (validationErrors.length === 0 && patchText !== null) {
        // §7.4：补丁必须能在干净基线上应用；验证后立即还原。
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
      if (!commit.success) {
        const probeAfter = await this.deps.vcs.getCommitProbe(probePaths).catch(() => null);
        if (probeBeforeFix === null || probeAfter === null) {
          // 结果不明（探针不可读）：禁止恢复，人工核对。
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            message: '新版本提交命令失败且无法读取提交探针，请人工核对 VCS 与工作区。',
            detail: commit.errorOutput,
            jobId,
          };
        }
        if (probeAfter !== probeBeforeFix) {
          // 探针前进：内容核对，匹配才按成功继续（§5.6 分支 1）。
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
