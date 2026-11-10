import type { ReviewFrontmatter } from './types.js';

/**
 * §6 负向记忆（2026-11-10 对齐 SPEC）：事实源是被拒候选的
 * module + target_files + audit_type + title（+ rejection.reason 作为展示信息）。
 * 确定性指纹使用规范 JSON 数组（无分隔符碰撞），target_files 按 UTF-8 字节序排序。
 * 一切实时计算，不持久化。
 */

/** §6.1 规范化：去首尾空白、合并连续空白、ASCII 小写化。 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** §6.1：target_files 按 UTF-8 字节序排序（Buffer.compare）。 */
function sortByUtf8Bytes(files: string[]): string[] {
  return [...files].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

/**
 * §6.1 确定性指纹：JSON.stringify([module 小写, 排序 target_files, audit_type, 规范化 title])。
 * JSON 字段转义与数组边界是指纹的一部分——禁止改用逗号或竖线拼接。
 */
export function fingerprintOf(
  meta: Pick<ReviewFrontmatter, 'module' | 'targetFiles' | 'auditType' | 'title'>,
): string {
  return JSON.stringify([
    meta.module.toLowerCase(),
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
  /** §4.3/G38：拒绝分类（缺省/未知归入 unspecified 分组）。 */
  category?: string;
  /** §4.3/G38：Host 从补丁 hunk header 提取的相关符号；仅用于提示词/UI，不进指纹。 */
  relatedSymbols?: string[];
  /** §6.2：system:stale 超时归档——弱信号，提示词必须标注，不得描述为“方案被拒绝”。 */
  staleArchived?: boolean;
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

/** 窗口过滤：窗口内阻止，窗口外只作 few-shot（不阻止）。 */
export function withinWindow(entry: RejectionMemoryEntry, windowDays: number, now = Date.now()): boolean {
  return now - entry.rejectedAtMs <= windowDays * 86_400_000;
}

/**
 * §6.2 阻止与豁免：
 * - 豁免集合 = 沿合法重开链向上追溯到的全部被拒祖先（active → reopenedFrom → … ，带环防护）；
 * - duplicateOf = 按 rejected_at 倒序的第一条**未豁免**同指纹窗口内记录；
 * - 链外或其他同指纹未豁免记录仍正常阻止。
 */
export function findDuplicate(
  active: { candidateId: string; meta: ReviewFrontmatter },
  memory: RejectionMemoryEntry[],
  windowDays: number,
  now = Date.now(),
): RejectionMemoryEntry | null {
  if (active.meta.status === 'rejected' || active.meta.status === 'approved') return null;
  // 本候选自身带重开标记（链成员）→ 只豁免链上祖先，链外匹配仍阻止（在 store 层传入豁免集）。
  const fp = fingerprintOf(active.meta);
  return memory
    .filter((entry) => entry.fingerprint === fp && withinWindow(entry, windowDays, now))
    .sort((left, right) => right.rejectedAtMs - left.rejectedAtMs)[0] ?? null;
}

/** §6.3：按 rejected_at 倒序取每模块最近 max 条，供提示词注入。 */
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

/** §6.3 提示词注入摘要：按 category 分组呈现约束；stale 标注为弱信号；不注入大段历史正文。 */
export function formatMemorySummary(entries: RejectionMemoryEntry[]): string {
  if (entries.length === 0) return '- 无（近期没有被拒绝的方案）。';
  const groups = new Map<string, RejectionMemoryEntry[]>();
  for (const entry of entries) {
    const key = entry.staleArchived ? 'stale' : entry.category && entry.category.trim() ? entry.category : 'unspecified';
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
      lines.push(`- [${entry.module || '?'}] ${entry.title}（被拒于 ${entry.rejectedAt}${symbols}）：${entry.reason}`);
    }
  }
  return lines.join('\n');
}
