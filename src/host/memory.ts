import type { ReviewFrontmatter } from './types.js';

/**
 * §7 负向记忆：事实源是被拒候选（module + target_files + audit_type + title + rejection.reason）。
 * 指纹完全相同且窗口内的候选被阻止进入队列；带合法 reopened_from 的人工重开例外。
 * 一切实时计算，不持久化。
 */

/** §7.3 规范化：去首尾空白、合并连续空白、ASCII 小写化。 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** §7.2 指纹：module + 排序后的 target_files + audit_type + 规范化 title。 */
export function fingerprintOf(
  meta: Pick<ReviewFrontmatter, 'module' | 'targetFiles' | 'auditType' | 'title'>,
): string {
  const files = [...meta.targetFiles].sort().join(',');
  return [meta.module.toLowerCase(), files, meta.auditType, normalizeTitle(meta.title)].join('|');
}

export interface RejectionMemoryEntry {
  candidateId: string;
  module: string;
  title: string;
  targetFiles: string[];
  auditType: string;
  rejectedAt: string;
  rejectedAtMs: number;
  reason: string;
  fingerprint: string;
}

export interface RejectionMemoryInput {
  candidateId: string;
  meta: ReviewFrontmatter;
}

/** 从完整候选事实提取一条负向记忆；非 rejected 返回 null。 */
export function entryFromCandidate(input: RejectionMemoryInput): RejectionMemoryEntry | null {
  const { meta } = input;
  if (meta.status !== 'rejected' || !meta.rejection) return null;
  const rejectedAtMs = new Date(meta.rejection.rejectedAt).getTime();
  if (Number.isNaN(rejectedAtMs)) return null;
  return {
    candidateId: input.candidateId,
    module: meta.module,
    title: meta.title,
    targetFiles: meta.targetFiles,
    auditType: meta.auditType,
    rejectedAt: meta.rejection.rejectedAt,
    rejectedAtMs,
    reason: meta.rejection.reason,
    fingerprint: fingerprintOf(meta),
  };
}

/** 窗口过滤：窗口内阻止，窗口外只作 few-shot（不阻止）。 */
export function withinWindow(entry: RejectionMemoryEntry, windowDays: number, now = Date.now()): boolean {
  return now - entry.rejectedAtMs <= windowDays * 86_400_000;
}

/**
 * §7.4 + §4.8：判断活跃候选是否被负向记忆阻止。
 * 完全相同指纹且在窗口内 → 阻止，除非该候选带合法人工重开（reopened_from 指向该 rejected 候选）。
 */
export function findDuplicate(
  active: { candidateId: string; meta: ReviewFrontmatter },
  memory: RejectionMemoryEntry[],
  windowDays: number,
  now = Date.now(),
): RejectionMemoryEntry | null {
  if (active.meta.status === 'rejected' || active.meta.status === 'approved') return null;
  if (active.meta.reopenedFrom) return null; // 人工重开豁免确定性阻止
  const fp = fingerprintOf(active.meta);
  return memory.find((entry) => entry.fingerprint === fp && withinWindow(entry, windowDays, now)) ?? null;
}

/** §7.6：按 rejected_at 倒序取每模块最近 max 条，供提示词注入。 */
export function topPerModule(memory: RejectionMemoryEntry[], max: number): RejectionMemoryEntry[] {
  const byModule = new Map<string, RejectionMemoryEntry[]>();
  for (const entry of memory) {
    const list = byModule.get(entry.module) ?? [];
    list.push(entry);
    byModule.set(entry.module, list);
  }
  const picked: RejectionMemoryEntry[] = [];
  for (const list of byModule.values()) {
    list.sort((left, right) => right.rejectedAtMs - left.rejectedAtMs);
    picked.push(...list.slice(0, max));
  }
  return picked;
}

/** 提示词注入摘要（few-shot 用）。 */
export function formatMemorySummary(entries: RejectionMemoryEntry[]): string {
  return entries
    .map((entry) => `- [${entry.module || '?'}] ${entry.title}（被拒于 ${entry.rejectedAt}）：${entry.reason}`)
    .join('\n');
}
