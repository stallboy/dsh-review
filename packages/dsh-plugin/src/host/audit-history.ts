/**
 * 审查历史只读投影（SPEC §9.11）：
 * 直接从当前共享快照的 review.md 派生，供总调度了解开放问题、到期 defer、human_takeover 与 awaiting_verification；
 * 严禁主动拉起已程序修复关闭（approved）问题的复查（仅在正常扫描发现复发新证据时沿原记录重开）。
 */

import { scopeCovers } from './audit-archive.js';
import { buildFindingView, isDeferred, latestDeferDecision } from './issue-review.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import type { FindingDisposition, IssueFindingView, ReviewCandidate } from './types.js';

export interface AuditHistorySnapshot {
  /** 全部共享问题（按 findingId 索引，用于跨轮沿用目录与退役检查）。 */
  byFindingId: Map<string, ReviewCandidate>;
  /** 全部共享问题（按目录 ID `YYYY-MM/<slug>` 索引，用于外部复核等按目录 ID 引用场景）。 */
  byDirId: Map<string, ReviewCandidate>;
  /** 需要总调度在常规/定时审查中关注的活跃与待核验问题（绝不包含 approved）。 */
  activeForOrchestrator: IssueFindingView[];
  /** 等待代码证据核验的外部完成项（awaiting_verification）。 */
  awaitingVerification: IssueFindingView[];
  /** 到期或声明了条件的 defer 暂停项。 */
  dueDeferred: IssueFindingView[];
  /** 近期已接受现状（rejected / accept_as_is）问题，用于去重与防重复提报。 */
  acceptedAsIs: IssueFindingView[];
  /** 已关闭（approved / resolved）的 findingId 集合，供 Deferred 依赖解除判定。 */
  closedFindingIds: Set<string>;
}

export async function loadAuditHistory(
  store: ReviewStore,
  source?: SharedCandidateSource,
  scope = '.',
  now: Date = new Date(),
): Promise<AuditHistorySnapshot> {
  const { candidates } = await store.listSharedCandidates(source);
  const byFindingId = new Map<string, ReviewCandidate>();
  const byDirId = new Map<string, ReviewCandidate>();
  const activeForOrchestrator: IssueFindingView[] = [];
  const awaitingVerification: IssueFindingView[] = [];
  const dueDeferred: IssueFindingView[] = [];
  const acceptedAsIs: IssueFindingView[] = [];
  const closedFindingIds = new Set<string>();
  const todayUtc = now.toISOString().slice(0, 10);

  for (const candidate of candidates) {
    if (candidate.parseError) continue;
    const meta = candidate.meta;
    byFindingId.set(meta.findingId, candidate);
    byDirId.set(candidate.id, candidate);
    if (meta.status === 'approved' || meta.status === 'resolved') {
      closedFindingIds.add(meta.findingId);
    }
    if (!scopeCovers(scope, meta.targetFiles)) continue;

    // 绝不将已关闭（approved / resolved）问题列入主动复查清单。
    if (meta.status === 'approved' || meta.status === 'resolved') continue;

    const view = buildFindingView(candidate);
    if (meta.status === 'awaiting_verification') {
      awaitingVerification.push(view);
      activeForOrchestrator.push(view);
      continue;
    }
    if (meta.status === 'rejected') {
      acceptedAsIs.push(view);
      continue;
    }
    if (isDeferred(meta)) {
      const defer = latestDeferDecision(meta);
      const isDateDue = Boolean(defer?.reviewAfter && defer.reviewAfter <= todayUtc);
      const hasCondition = Boolean(defer?.reviewWhen);
      if (isDateDue || hasCondition) {
        dueDeferred.push(view);
      }
      activeForOrchestrator.push(view);
      continue;
    }
    activeForOrchestrator.push(view);
  }

  return {
    byFindingId,
    byDirId,
    activeForOrchestrator,
    awaitingVerification,
    dueDeferred,
    acceptedAsIs,
    closedFindingIds,
  };
}

export async function queryAuditHistoryItems(
  store: ReviewStore,
  source: SharedCandidateSource | undefined,
  scope: string,
  disposition?: string,
): Promise<IssueFindingView[]> {
  const { candidates } = await store.listSharedCandidates(source);
  return candidates
    .filter((c) => !c.parseError)
    .filter((c) => scopeCovers(scope, c.meta.targetFiles))
    .map((c) => buildFindingView(c))
    // 若调用方未显式查询 applied，默认排除已程序关闭的 approved/resolved 问题；支持按 awaiting_verification 精准过滤。
    .filter((item) => {
      if (!disposition) return item.disposition !== 'applied' && item.disposition !== 'resolved';
      if (disposition === 'awaiting_verification') return item.issueStatus === 'awaiting_verification';
      return item.disposition === (disposition as FindingDisposition);
    });
}
