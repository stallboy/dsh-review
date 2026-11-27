/**
 * 前后端与中央服务共享的队列 / 发现筛选及 8 状态聚合统计工具（SPEC §6.2 / §6.5）。
 */

import { REVIEW_STATUSES, type CandidateSummary, type FindingDisposition, type IssueFindingView, type ReviewStatus } from './review.js';

export interface QueueFilterParams {
  owner?: string;
  statuses?: string | readonly string[];
  tag?: string;
  dir?: string;
  text?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface FindingsFilterParams {
  scope?: string;
  dispositions?: string | readonly string[];
  owner?: string;
  text?: string;
  findingId?: string;
}

export function emptyReviewCounts(): Record<ReviewStatus, number> {
  return {
    pending: 0,
    changes_requested: 0,
    repair_failed: 0,
    human_takeover: 0,
    awaiting_verification: 0,
    approved: 0,
    rejected: 0,
    resolved: 0,
  };
}

function normalizeScope(scope: string): string {
  const cleaned = scope.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return cleaned === '' || cleaned === '.' ? '.' : cleaned;
}

export function scopeMatchesPaths(scope: string, paths: readonly string[]): boolean {
  const normalized = normalizeScope(scope);
  if (normalized === '.') return true;
  const prefix = `${normalized}/`;
  return paths.some((raw) => {
    const p = raw.replaceAll('\\', '/').replace(/^\.\/+/, '');
    return p === normalized || p.startsWith(prefix);
  });
}

function parseList(value: string | readonly string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 按负责人、状态、标签、目录、全文与创建时间区间筛选队列项，同时产出负责人维度全量 8 状态统计。 */
export function filterQueueItems<T extends Partial<CandidateSummary>>(
  items: readonly T[],
  params: QueueFilterParams = {},
): { items: T[]; counts: Record<ReviewStatus, number> } {
  const owner = (params.owner ?? '').trim();
  const statuses = new Set(parseList(params.statuses));
  const tag = (params.tag ?? '').trim().toLowerCase();
  const dir = (params.dir ?? '').trim().replaceAll('\\', '/').toLowerCase();
  const text = (params.text ?? '').trim().toLowerCase();
  const afterMs = params.createdAfter ? Date.parse(params.createdAfter) : Number.NaN;
  const beforeMs = params.createdBefore ? Date.parse(params.createdBefore) : Number.NaN;

  const counts = emptyReviewCounts();
  const filtered: T[] = [];

  for (const item of items) {
    if (owner && item.owner !== owner) continue;
    const status = item.status as ReviewStatus | undefined;
    if (status && REVIEW_STATUSES.includes(status)) {
      counts[status] += 1;
    }

    if (statuses.size > 0 && (!status || !statuses.has(status))) continue;
    if (tag && !(item.tags ?? []).some((t) => t.toLowerCase() === tag)) continue;
    if (dir && !(item.targetFiles ?? []).some((p) => p.replaceAll('\\', '/').toLowerCase().includes(dir))) continue;
    if (text) {
      const hay = `${item.id ?? ''} ${item.findingId ?? ''} ${item.title ?? ''} ${item.ticket ?? ''} ${item.module ?? ''}`.toLowerCase();
      if (!hay.includes(text)) continue;
    }
    if (Number.isFinite(afterMs) || Number.isFinite(beforeMs)) {
      const createdMs = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
      if (!Number.isFinite(createdMs)) continue;
      if (Number.isFinite(afterMs) && createdMs < afterMs) continue;
      if (Number.isFinite(beforeMs) && createdMs > beforeMs) continue;
    }
    filtered.push(item);
  }

  return { items: filtered, counts };
}

/** 按范围、处置态（含 awaiting_verification）、负责人、关键词与 findingId 筛选问题发现列表。 */
export function filterFindingViews<T extends Partial<IssueFindingView>>(
  findings: readonly T[],
  params: FindingsFilterParams = {},
): T[] {
  const scope = params.scope?.trim() || '.';
  const dispositions = new Set(parseList(params.dispositions) as FindingDisposition[]);
  const owner = (params.owner ?? '').trim();
  const text = (params.text ?? '').trim().toLowerCase();
  const findingId = (params.findingId ?? '').trim();

  return findings.filter((item) => {
    if (findingId && item.findingId !== findingId) return false;
    if (owner && item.owner !== owner) return false;
    if (scope !== '.' && !scopeMatchesPaths(scope, item.targetFiles ?? [])) return false;
    if (dispositions.size > 0 && (!item.disposition || !dispositions.has(item.disposition))) return false;
    if (text) {
      const hay = `${item.id ?? ''} ${item.findingId ?? ''} ${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}
