import type { ReviewFrontmatter } from './types.js';

/** 从拒绝记录派生重复判定和提示词摘要。负向记忆没有单独的持久化数据源。 */

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** 限制为 ASCII，避免 Unicode 大小写折叠合并原本独立的标识。 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function sortByUtf8Bytes(files: string[]): string[] {
  return [...files].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

/** JSON 数组的边界和转义可防止字段中含分隔符时产生指纹碰撞。 */
export function fingerprintOf(
  meta: Pick<ReviewFrontmatter, 'module' | 'targetFiles' | 'auditType' | 'title'>,
): string {
  return JSON.stringify([
    asciiLower(meta.module),
    sortByUtf8Bytes(meta.targetFiles),
    meta.auditType,
    normalizeTitle(meta.title),
  ]);
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
  category?: string;
  /** 用于说明拒绝记录涉及的符号，不参与重复指纹。 */
  relatedSymbols?: string[];
  /** 超时归档只表示长期未更新，提示词须把它标成弱信号。 */
  staleArchived?: boolean;
  fingerprint: string;
}

export interface RejectionMemoryInput {
  candidateId: string;
  meta: ReviewFrontmatter;
}

export function entryFromCandidate(input: RejectionMemoryInput): RejectionMemoryEntry | null {
  const { meta } = input;
  if (meta.status !== 'rejected' || !meta.rejection) return null;
  const rejectedAtMs = new Date(meta.rejection.rejectedAt).getTime();
  if (Number.isNaN(rejectedAtMs)) return null;
  const category = (meta.rejection.extra?.['category'] as string | undefined) ?? undefined;
  const relatedRaw = meta.rejection.extra?.['related_symbols'];
  const rejectedBy = meta.rejection.rejectedBy;
  return {
    candidateId: input.candidateId,
    module: meta.module,
    title: meta.title,
    targetFiles: meta.targetFiles,
    auditType: meta.auditType,
    rejectedAt: meta.rejection.rejectedAt,
    rejectedAtMs,
    reason: meta.rejection.reason,
    ...(category !== undefined ? { category } : {}),
    ...(Array.isArray(relatedRaw) ? { relatedSymbols: relatedRaw.map((item) => String(item)) } : {}),
    ...(rejectedBy === 'system:stale' ? { staleArchived: true } : {}),
    fingerprint: fingerprintOf(meta),
  };
}

/** 窗口外的拒绝记录仍可供提示词参考，但不能阻止新候选。 */
export function withinWindow(entry: RejectionMemoryEntry, windowDays: number, now = Date.now()): boolean {
  return now - entry.rejectedAtMs <= windowDays * 86_400_000;
}

/** 只豁免调用方证明属于重开链的祖先，链外的同指纹拒绝记录仍能阻止候选。 */
export function findDuplicate(
  active: { candidateId: string; meta: ReviewFrontmatter },
  memory: RejectionMemoryEntry[],
  windowDays: number,
  now = Date.now(),
): RejectionMemoryEntry | null {
  if (active.meta.status === 'rejected' || active.meta.status === 'approved') return null;
  const fp = fingerprintOf(active.meta);
  return memory
    .filter((entry) => entry.fingerprint === fp && withinWindow(entry, windowDays, now))
    .sort((left, right) => right.rejectedAtMs - left.rejectedAtMs)[0] ?? null;
}

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

export function formatMemorySummary(entries: RejectionMemoryEntry[]): string {
  if (entries.length === 0) return '- 无（近期没有被拒绝的方案）。';
  const knownCategories = new Set(['false_positive', 'intentional_design', 'high_risk', 'out_of_scope', 'stale']);
  const groups = new Map<string, RejectionMemoryEntry[]>();
  for (const entry of entries) {
    const hasCategory = typeof entry.category === 'string' && entry.category.trim().length > 0;
    const key = entry.staleArchived
      ? 'stale'
      : hasCategory && knownCategories.has(entry.category ?? '')
        ? String(entry.category)
        : 'unspecified';
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const groupTitles: Record<string, string> = {
    stale: '超时归档（弱信号——不代表方案被拒绝，仍禁止逐字重复）',
    false_positive: '误报（false_positive）',
    intentional_design: '有意设计（intentional_design）',
    high_risk: '高风险（high_risk）',
    out_of_scope: '超范围（out_of_scope）',
    unspecified: '未分类',
  };
  const lines: string[] = [];
  for (const [key, list] of groups) {
    lines.push(`### ${groupTitles[key] ?? key}`);
    for (const entry of list) {
      const symbols = entry.relatedSymbols && entry.relatedSymbols.length > 0 ? `，相关符号 ${entry.relatedSymbols.join('/')}` : '';
      const category = entry.category && !knownCategories.has(entry.category) ? `，分类 ${entry.category}` : '';
      lines.push(
        `- [${entry.module || '?'}] ${entry.title}（审查类型 ${entry.auditType || '?'}；目标文件 ${entry.targetFiles.length > 0 ? entry.targetFiles.join(', ') : '—'}；被拒于 ${entry.rejectedAt}${category}${symbols}）：${entry.reason}`,
      );
    }
  }
  return lines.join('\n');
}
