/**
 * 负向记忆（SPEC §4.6 / AC-MEMORY-01）：
 * 完全由共享事实中各问题的 rejection 与 decisions[] 的 accept_as_is 实时计算，无独立持久化记忆文件。
 */

import type { ReviewCandidate, ReviewFrontmatter } from './types.js';

export const KNOWN_REJECTION_CATEGORIES = new Set([
  'false_positive',
  'intentional_design',
  'high_risk',
  'out_of_scope',
]);

export interface NegativeMemoryEntry {
  candidateId: string;
  findingId: string;
  module: string;
  title: string;
  targetFiles: string[];
  auditType: string;
  fingerprint: string;
  rejectedAt: string;
  rejectedAtMs: number;
  reason: string;
  category: string;
  relatedSymbols: string[];
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function normalizeTitleForFingerprint(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** AC-MEMORY-01：规范 JSON 数组指纹，target_files 按 UTF-8 字节序排序，杜绝拼接碰撞。 */
export function computeRejectionFingerprint(meta: Pick<ReviewFrontmatter, 'module' | 'targetFiles' | 'auditType' | 'title'>): string {
  const sortedFiles = [...new Set(meta.targetFiles)].sort(utf8Compare);
  return JSON.stringify([
    meta.module.trim().toLowerCase(),
    sortedFiles,
    meta.auditType,
    normalizeTitleForFingerprint(meta.title),
  ]);
}

export function normalizeCategory(raw: string | undefined): string {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || !KNOWN_REJECTION_CATEGORIES.has(trimmed)) return 'unspecified';
  return trimmed;
}

/** 从单个共享问题中提取其最近一次有效拒绝记忆（来自当前 rejection 或历史 accept_as_is 决定）。 */
export function entryFromCandidate(input: { candidateId: string; meta: ReviewFrontmatter }): NegativeMemoryEntry | null {
  const { candidateId, meta } = input;
  let rejectedAt = '';
  let reason = '';
  let category: string | undefined;
  let relatedSymbols: string[] = [];

  if (meta.rejection !== null) {
    rejectedAt = meta.rejection.rejectedAt;
    reason = meta.rejection.reason;
    category = meta.rejection.category;
    relatedSymbols = meta.rejection.relatedSymbols ?? [];
  } else {
    const latestAcceptAsIs = [...meta.decisions].reverse().find((d) => d.action === 'accept_as_is');
    if (!latestAcceptAsIs) return null;
    rejectedAt = latestAcceptAsIs.at;
    reason = latestAcceptAsIs.reason;
    category = latestAcceptAsIs.category;
    relatedSymbols = latestAcceptAsIs.relatedSymbols ?? [];
  }

  const rejectedAtMs = Date.parse(rejectedAt);
  if (!Number.isFinite(rejectedAtMs)) return null;

  return {
    candidateId,
    findingId: meta.findingId,
    module: meta.module.trim().toLowerCase(),
    title: meta.title,
    targetFiles: [...meta.targetFiles],
    auditType: meta.auditType,
    fingerprint: computeRejectionFingerprint(meta),
    rejectedAt,
    rejectedAtMs,
    reason,
    category: normalizeCategory(category),
    relatedSymbols,
  };
}

export function withinWindow(entry: NegativeMemoryEntry, windowDays: number, nowMs: number = Date.now()): boolean {
  const windowMs = Math.max(1, windowDays) * 24 * 60 * 60 * 1000;
  return nowMs - entry.rejectedAtMs <= windowMs;
}

/**
 * AC-MEMORY-01：在窗口内查找同指纹拒绝记录。
 * 自问题合法恢复豁免：同一问题（相同 candidateId 或 findingId）自身历史 accept_as_is 不阻断自己恢复后的审批，
 * 但若存在其他问题的窗口内同指纹拒绝记录，仍照常拦截。
 */
export function findDuplicateRejection(
  target: Pick<ReviewCandidate, 'id' | 'meta'>,
  allCandidates: readonly Pick<ReviewCandidate, 'id' | 'meta' | 'parseError'>[],
  windowDays: number,
  nowMs: number = Date.now(),
): NegativeMemoryEntry | null {
  const targetFingerprint = computeRejectionFingerprint(target.meta);
  let match: NegativeMemoryEntry | null = null;
  for (const other of allCandidates) {
    if (other.parseError) continue;
    if (other.id === target.id || other.meta.findingId === target.meta.findingId) continue;
    const entry = entryFromCandidate({ candidateId: other.id, meta: other.meta });
    if (!entry || entry.fingerprint !== targetFingerprint) continue;
    if (!withinWindow(entry, windowDays, nowMs)) continue;
    if (!match || entry.rejectedAtMs > match.rejectedAtMs) {
      match = entry;
    }
  }
  return match;
}

/** 按模块分组、按拒绝时间倒序各保留最多 maxPerModule 条。 */
export function topPerModule(entries: readonly NegativeMemoryEntry[], maxPerModule: number): NegativeMemoryEntry[] {
  const limit = Math.max(1, maxPerModule);
  const byModule = new Map<string, NegativeMemoryEntry[]>();
  for (const entry of entries) {
    const list = byModule.get(entry.module) ?? [];
    list.push(entry);
    byModule.set(entry.module, list);
  }
  const result: NegativeMemoryEntry[] = [];
  for (const [, list] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((left, right) => right.rejectedAtMs - left.rejectedAtMs || left.candidateId.localeCompare(right.candidateId));
    result.push(...list.slice(0, limit));
  }
  return result;
}

/** 按 module -> category 分组生成紧凑提示词负向记忆摘要（不含大段正文）。 */
export function formatMemorySummary(entries: readonly NegativeMemoryEntry[]): string {
  if (entries.length === 0) return '- 无（近期没有被拒绝的方案）。';
  const byModule = new Map<string, Map<string, NegativeMemoryEntry[]>>();
  for (const entry of entries) {
    let categories = byModule.get(entry.module);
    if (!categories) {
      categories = new Map();
      byModule.set(entry.module, categories);
    }
    const list = categories.get(entry.category) ?? [];
    list.push(entry);
    categories.set(entry.category, list);
  }
  const lines: string[] = [];
  for (const [mod, categories] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### 模块 \`${mod}\``);
    for (const [cat, list] of [...categories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- 分类 \`${cat}\`：`);
      for (const item of list) {
        const files = item.targetFiles.join(', ');
        const symbols = item.relatedSymbols.length > 0 ? `；相关符号：${item.relatedSymbols.join(', ')}` : '';
        lines.push(`  - \`${item.candidateId}\`（${item.auditType}）${item.title} — 文件：${files}；拒绝理由：${item.reason}${symbols}`);
      }
    }
  }
  return lines.join('\n');
}
