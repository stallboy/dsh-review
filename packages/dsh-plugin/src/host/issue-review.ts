/** 问题生命周期领域逻辑：8 状态转移、补丁永久封禁、延期暂停、人工处置与视图投影。 */

import { createHash } from 'node:crypto';
import type {
  FindingDisposition,
  IssueDecision,
  IssueDecisionAction,
  IssueFindingView,
  IssueSelection,
  PatchEntry,
  RepairOption,
  ReviewCandidate,
  ReviewFrontmatter,
  ReviewStatus,
} from './types.js';
import { ApiError } from './types.js';

export type IssueDecisionRequest =
  | { action: 'accept_as_is'; reason: string; category?: string }
  | { action: 'defer'; reason: string; reviewAfter?: string; reviewWhen?: string }
  | { action: 'human_takeover'; reason?: string }
  | { action: 'add_repair_hint'; hint: string }
  | { action: 'external_completed'; reason: string }
  | { action: 'resume_review'; reason: string };

export const COMMENTABLE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'pending',
  'changes_requested',
  'repair_failed',
]);

export function sha256Hex(content: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function formatPatchFilename(patchId: number): string {
  return `${String(patchId).padStart(3, '0')}.patch`;
}

/** AC-LOCK-01 / I13：所有共享写入（含审查发布）严格递增 updated_at，毫秒级防时钟回拨并规范化 UTC Z。 */
export function nextUpdatedAt(previous: string, now: Date = new Date()): string {
  const prevMs = Date.parse(previous);
  const nowMs = now.getTime();
  const nextMs = Number.isFinite(prevMs) && nowMs <= prevMs ? prevMs + 1 : nowMs;
  return new Date(nextMs).toISOString();
}

function patchKey(optionId: string, patchId: number): string {
  return `${optionId}#${String(patchId)}`;
}

/** I16：凡在 repair_attempts[] 中记录过 verification_failed 的 (option_id, patch_id) 永久禁止直接批准。 */
export function bannedOptionPatches(meta: ReviewFrontmatter): Set<string> {
  const banned = new Set<string>();
  for (const attempt of meta.repairAttempts) {
    if (attempt.result === 'verification_failed') {
      banned.add(patchKey(attempt.optionId, attempt.patchId));
    }
  }
  return banned;
}

export function isPatchBanned(meta: ReviewFrontmatter, optionId: string, patchId: number): boolean {
  return bannedOptionPatches(meta).has(patchKey(optionId, patchId));
}

/** 所有曾经使用过、且当前已不在 options[] 中的 option_id（含历史批准方案）均视为退役，不得复用。 */
export function retiredOptionIds(meta: ReviewFrontmatter): Set<string> {
  const active = new Set(meta.options.map((o) => o.id));
  const retired = new Set<string>();
  for (const patch of meta.patches) {
    if (!active.has(patch.optionId)) retired.add(patch.optionId);
  }
  for (const historic of meta.approvalHistory) {
    if (!active.has(historic.optionId)) retired.add(historic.optionId);
  }
  return retired;
}

/**
 * SPEC §4.1 defer 暂停态判定（无时钟漂移）：
 * 扫描 decisions[] 最后一条影响暂停态的记录；绝不因服务器时钟跨过 review_after 自动解除。
 */
export function isDeferred(meta: ReviewFrontmatter): boolean {
  if (!COMMENTABLE_STATUSES.has(meta.status)) return false;
  for (let index = meta.decisions.length - 1; index >= 0; index -= 1) {
    const decision = meta.decisions[index];
    if (!decision) continue;
    if (decision.action === 'add_repair_hint') continue;
    return decision.action === 'defer';
  }
  return false;
}

export function latestDeferDecision(meta: ReviewFrontmatter): IssueDecision | undefined {
  if (!isDeferred(meta)) return undefined;
  for (let index = meta.decisions.length - 1; index >= 0; index -= 1) {
    if (meta.decisions[index]?.action === 'defer') return meta.decisions[index];
  }
  return undefined;
}

export function hasUnbannedOption(meta: ReviewFrontmatter): boolean {
  if (meta.options.length === 0) return false;
  const banned = bannedOptionPatches(meta);
  return meta.options.some((option) => !banned.has(patchKey(option.id, option.currentPatch)));
}

/** 非延期 repair_failed 仅当存在另一未失败的当前方案时，才允许 resume_review 解锁改选。 */
export function canResumeRepairFailed(meta: ReviewFrontmatter): boolean {
  return meta.status === 'repair_failed' && !isDeferred(meta) && hasUnbannedOption(meta);
}

export function findOption(meta: ReviewFrontmatter, optionId: string): RepairOption | undefined {
  return meta.options.find((option) => option.id === optionId);
}

export function findPatch(meta: ReviewFrontmatter, patchId: number): PatchEntry | undefined {
  return meta.patches.find((patch) => patch.id === patchId);
}

export function resolveOptionSelection(
  meta: ReviewFrontmatter,
  requested?: { optionId?: string; patchId?: number },
): { option: RepairOption; patch: PatchEntry; selection: IssueSelection } | null {
  if (meta.options.length === 0) {
    if (requested?.optionId || requested?.patchId !== undefined) {
      throw new ApiError(409, 'conflict', '纯文字问题没有可应用的修复方案与补丁');
    }
    return null;
  }
  const option = requested?.optionId
    ? meta.options.find((item) => item.id === requested.optionId)
    : meta.options[0];
  if (!option) {
    throw new ApiError(409, 'conflict', `所选方案不存在或已失效：${requested?.optionId ?? ''}`);
  }
  const targetPatchId = requested?.patchId ?? option.currentPatch;
  if (requested?.patchId !== undefined && requested.patchId !== option.currentPatch) {
    throw new ApiError(
      409,
      'conflict',
      `方案 ${option.id} 的当前补丁已更新为 #${String(option.currentPatch)}（请求为 #${String(requested.patchId)}），请刷新后再操作`,
    );
  }
  const patch = meta.patches.find((item) => item.id === targetPatchId && item.optionId === option.id);
  if (!patch) {
    throw new ApiError(409, 'conflict', `方案 ${option.id} 指向的补丁 #${String(targetPatchId)} 不存在或归属不符`);
  }
  return { option, patch, selection: { optionId: option.id, patchId: patch.id } };
}

export function requireExplicitSelection(
  meta: ReviewFrontmatter,
  requested?: { optionId?: string; patchId?: number },
): { option: RepairOption; patch: PatchEntry; selection: IssueSelection } {
  if (!requested?.optionId || typeof requested.patchId !== 'number' || !Number.isInteger(requested.patchId) || requested.patchId <= 0) {
    throw new ApiError(400, 'bad_request', '必须显式指定有效的 optionId 与 patchId');
  }
  const resolved = resolveOptionSelection(meta, requested);
  if (!resolved) {
    throw new ApiError(409, 'conflict', '纯文字问题不支持基于补丁的操作');
  }
  return resolved;
}

export function parseDecisionRequest(body: Record<string, unknown>): IssueDecisionRequest {
  const action = body['action'];
  const nonEmpty = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ApiError(422, 'bad_request', `${field} 必须是非空字符串`);
    }
    return value.trim();
  };
  switch (action) {
    case 'accept_as_is': {
      const reason = nonEmpty(body['reason'], 'reason');
      const rawCategory = body['category'];
      if (rawCategory !== undefined && typeof rawCategory !== 'string') {
        throw new ApiError(422, 'bad_request', 'category 必须是字符串');
      }
      const category = typeof rawCategory === 'string' && rawCategory.trim() ? rawCategory.trim() : undefined;
      return { action, reason, ...(category ? { category } : {}) };
    }
    case 'defer': {
      const reason = nonEmpty(body['reason'], 'reason');
      let reviewAfter: string | undefined;
      if (body['reviewAfter'] !== undefined && body['reviewAfter'] !== '') {
        reviewAfter = nonEmpty(body['reviewAfter'], 'reviewAfter');
        const parsed = new Date(`${reviewAfter}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewAfter) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== reviewAfter) {
          throw new ApiError(422, 'bad_request', 'reviewAfter 必须是有效的 UTC 日期（YYYY-MM-DD）');
        }
      }
      let reviewWhen: string | undefined;
      if (body['reviewWhen'] !== undefined && body['reviewWhen'] !== '') {
        reviewWhen = nonEmpty(body['reviewWhen'], 'reviewWhen');
      }
      return {
        action,
        reason,
        ...(reviewAfter ? { reviewAfter } : {}),
        ...(reviewWhen ? { reviewWhen } : {}),
      };
    }
    case 'human_takeover': {
      if (body['reason'] !== undefined && typeof body['reason'] !== 'string') {
        throw new ApiError(422, 'bad_request', 'reason 必须是字符串');
      }
      const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : undefined;
      return { action, ...(reason !== undefined ? { reason } : {}) };
    }
    case 'add_repair_hint':
      return { action, hint: nonEmpty(body['hint'], 'hint') };
    case 'external_completed':
      return { action, reason: nonEmpty(body['reason'], 'reason') };
    case 'resume_review':
      return { action, reason: nonEmpty(body['reason'], 'reason') };
    default:
      throw new ApiError(422, 'bad_request', `不支持的处置动作：${String(action ?? '')}`);
  }
}

/**
 * AC-STATE-01 / I16 / I20：严格按 SPEC §4.1–§4.2 状态转移矩阵应用人工处置，
 * 就地返回新 ReviewFrontmatter（不修改入参对象）。
 */
export function applyIssueDecision(
  meta: ReviewFrontmatter,
  request: IssueDecisionRequest,
  actor: string,
  now: Date = new Date(),
  relatedSymbols?: string[],
): ReviewFrontmatter {
  const at = nextUpdatedAt(meta.updatedAt, now);
  const deferred = isDeferred(meta);
  let nextStatus: ReviewStatus = meta.status;
  let nextRejection = meta.rejection;
  let entry: IssueDecision;

  switch (request.action) {
    case 'accept_as_is': {
      if (!['pending', 'changes_requested', 'repair_failed', 'human_takeover'].includes(meta.status)) {
        throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许执行 accept_as_is`);
      }
      const symbols = relatedSymbols && relatedSymbols.length > 0 ? relatedSymbols : undefined;
      entry = {
        action: 'accept_as_is',
        actor,
        at,
        reason: request.reason,
        ...(request.category ? { category: request.category } : {}),
        ...(symbols ? { relatedSymbols: symbols } : {}),
      };
      nextStatus = 'rejected';
      nextRejection = {
        rejectedBy: actor,
        rejectedAt: at,
        reason: request.reason,
        ...(request.category ? { category: request.category } : {}),
        ...(symbols ? { relatedSymbols: symbols } : {}),
      };
      break;
    }
    case 'defer': {
      if (!COMMENTABLE_STATUSES.has(meta.status)) {
        throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许执行 defer`);
      }
      entry = {
        action: 'defer',
        actor,
        at,
        reason: request.reason,
        ...(request.reviewAfter ? { reviewAfter: request.reviewAfter } : {}),
        ...(request.reviewWhen ? { reviewWhen: request.reviewWhen } : {}),
      };
      nextStatus = meta.status;
      break;
    }
    case 'human_takeover': {
      if (!['pending', 'changes_requested', 'repair_failed', 'awaiting_verification'].includes(meta.status)) {
        throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许执行 human_takeover`);
      }
      if (meta.status === 'awaiting_verification' && (!request.reason || !request.reason.trim())) {
        throw new ApiError(422, 'bad_request', '从 awaiting_verification 撤回外部完成时必须填写非空 reason');
      }
      entry = {
        action: 'human_takeover',
        actor,
        at,
        reason: request.reason?.trim() ?? '',
      };
      nextStatus = 'human_takeover';
      break;
    }
    case 'add_repair_hint': {
      if (meta.status !== 'human_takeover') {
        throw new ApiError(409, 'conflict', `只有 human_takeover 状态允许补充修复线索（当前为 ${meta.status}）`);
      }
      entry = {
        action: 'add_repair_hint',
        actor,
        at,
        reason: request.hint,
      };
      nextStatus = 'human_takeover';
      break;
    }
    case 'external_completed': {
      if (meta.status !== 'human_takeover') {
        throw new ApiError(409, 'conflict', `只有 human_takeover 状态允许反馈外部完成（当前为 ${meta.status}）`);
      }
      entry = {
        action: 'external_completed',
        actor,
        at,
        reason: request.reason,
      };
      nextStatus = 'awaiting_verification';
      break;
    }
    case 'resume_review': {
      if (deferred) {
        // 解除 defer 暂停时严格保留原状态（repair_failed 仍为 repair_failed，不可洗白为 pending）。
        nextStatus = meta.status;
      } else if (meta.status === 'rejected' || meta.status === 'human_takeover') {
        nextRejection = null;
        if (meta.options.length === 0 || hasUnbannedOption(meta)) {
          nextStatus = 'pending';
        } else {
          nextStatus = 'repair_failed';
        }
      } else if (meta.status === 'repair_failed') {
        if (!hasUnbannedOption(meta)) {
          throw new ApiError(
            409,
            'conflict',
            '当前所有方案的补丁均已因验证失败被永久封禁，不能直接 resume_review 回到 pending；请评论并生成新补丁、或转人工接手/本次不修改',
          );
        }
        nextStatus = 'pending';
      } else {
        throw new ApiError(409, 'conflict', `当前状态 ${meta.status}（未处于延期）不允许执行 resume_review`);
      }
      entry = {
        action: 'resume_review',
        actor,
        at,
        reason: request.reason,
      };
      break;
    }
  }

  return {
    ...meta,
    status: nextStatus,
    rejection: nextRejection,
    recordRevision: meta.recordRevision + 1,
    updatedAt: at,
    decisions: [...meta.decisions, entry],
  };
}

export function deriveIssueDisposition(meta: ReviewFrontmatter): FindingDisposition {
  if (meta.status === 'approved') return 'applied';
  if (meta.status === 'resolved') return 'resolved';
  if (meta.status === 'rejected') return 'accept_as_is';
  if (meta.status === 'awaiting_verification') return 'awaiting_verification';
  if (meta.status === 'human_takeover') return 'human_takeover';
  if (isDeferred(meta)) return 'defer';
  return 'undecided';
}

export function buildFindingView(candidate: ReviewCandidate): IssueFindingView {
  const { meta, sections } = candidate;
  const banned = bannedOptionPatches(meta);
  const deferred = isDeferred(meta);
  const disposition = deriveIssueDisposition(meta);
  const latestDecision = [...meta.decisions].reverse().find((d) => d.action !== 'add_repair_hint');
  const repairHints = meta.decisions
    .filter((d) => d.action === 'add_repair_hint' && d.reason.trim().length > 0)
    .map((d) => d.reason);
  const summary = meta.observations[meta.observations.length - 1]?.reason
    || sections.problem.split('\n')[0]?.trim()
    || meta.title;

  return {
    id: candidate.id,
    findingId: meta.findingId,
    recordRevision: meta.recordRevision,
    owner: meta.owner,
    updatedAt: meta.updatedAt,
    title: meta.title,
    summary,
    module: meta.module,
    auditType: meta.auditType,
    priority: meta.priority,
    issueStatus: meta.status,
    issueKind: meta.issueKind,
    dependsOn: meta.dependsOn,
    deferred,
    disposition,
    baseRevision: meta.baseRevision,
    targetFiles: [...meta.targetFiles],
    repairPlan: sections.solution || '',
    options: meta.options.map((option) => ({
      optionId: option.id,
      title: option.title,
      tradeoff: option.tradeoff,
      confidence: option.confidence,
      patchId: option.currentPatch,
      banned: banned.has(patchKey(option.id, option.currentPatch)),
      gateChecks: [...option.gateChecks],
    })),
    ...(latestDecision
      ? {
        decision: {
          action: latestDecision.action,
          actor: latestDecision.actor,
          at: latestDecision.at,
          reason: latestDecision.reason,
          ...(latestDecision.reviewAfter ? { reviewAfter: latestDecision.reviewAfter } : {}),
          ...(latestDecision.reviewWhen ? { reviewWhen: latestDecision.reviewWhen } : {}),
          ...(latestDecision.category ? { category: latestDecision.category } : {}),
        },
      }
      : {}),
    repairHints,
    repairAttempts: [...meta.repairAttempts],
  };
}
