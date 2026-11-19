import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  appendVersionSection,
  extractHumanJudgment,
  findLastFeedback,
  parseReviewMarkdown,
  parseSections,
  ReviewFormatError,
  serializeReviewMarkdown,
} from './frontmatter.js';
import { parsePatch, isAiReviewPath, anchorFromPatch } from './patch.js';
import { quickReviewInvariants, fullReviewInvariants, isRepoRelativePath } from './invariants.js';
import { entryFromCandidate, fingerprintOf, withinWindow } from './memory.js';
import type {
  CandidateSummary,
  ConcurrencyGuard,
  PatchStats,
  ReviewCandidate,
  ReviewComment,
  ReviewFilter,
  ReviewFrontmatter,
  ReviewStatus,
  ValidationReport,
} from './types.js';
import { ApiError } from './types.js';

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMPTY_STATS: PatchStats = { files: 0, additions: 0, deletions: 0, entries: [] };

export interface CandidateDetail {
  candidate: ReviewCandidate;
  currentBase: string | null;
  isBaseBehind: boolean;
  patchText: string;
  patchStats: PatchStats;
}

function candidateId(month: string, slug: string): string {
  return `${month}/${slug}`;
}

interface ScannedCandidate {
  candidate: ReviewCandidate | null;
  stats: PatchStats;
  invariantErrors: string[] | null;
  error: string | null;
}

/** 限制并发 VCS 子进程数量，减少大量候选扫描时的资源占用。 */
const SCAN_CONCURRENCY = 6;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 写路径可读工作区。共享读必须由同一 VCS 快照提供评审数据和补丁。 */
export interface CandidateSource {
  /** 目录必须包含 review.md，返回值使用 YYYY-MM/slug。 */
  listCandidateDirs(): Promise<string[]>;
  listDirEntries(month: string, slug: string): Promise<string[] | null>;
  readReviewText(month: string, slug: string): Promise<string | null>;
  readPatchText(month: string, slug: string, patchName: string): Promise<string | null>;
  /** 评审文件或补丁相对读取快照有本地改动时返回 true。 */
  hasLocalChanges(month: string, slug: string): Promise<boolean>;
  /** 一次读取可代替逐候选查询。返回 null 时须逐项回退，本地视图也不能随共享快照缓存。 */
  localChangedCandidateIds?(): Promise<Set<string> | null>;
  /** VCS status 可能折叠未跟踪目录或应用忽略规则，须通过文件系统发现本地候选。 */
  listLocalOnlyDirs(): Promise<string[]>;
}

export class FilesystemCandidateSource implements CandidateSource {
  constructor(private readonly repoRoot: string) {}

  async listCandidateDirs(): Promise<string[]> {
    const root = path.join(this.repoRoot, '.ai-review');
    const ids: string[] = [];
    let months: string[] = [];
    try {
      months = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && MONTH_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return ids;
    }
    for (const month of months) {
      let slugs: string[] = [];
      try {
        slugs = (await readdir(path.join(root, month), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        if (existsSync(path.join(root, month, slug, 'review.md'))) ids.push(candidateId(month, slug));
      }
    }
    return ids;
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    try {
      return await readdir(path.join(this.repoRoot, '.ai-review', month, slug));
    } catch {
      return null;
    }
  }

  async readReviewText(month: string, slug: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.repoRoot, '.ai-review', month, slug, 'review.md'), 'utf8');
    } catch {
      return null;
    }
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.repoRoot, '.ai-review', month, slug, patchName), 'utf8');
    } catch {
      return null;
    }
  }

  async hasLocalChanges(): Promise<boolean> {
    return false;
  }

  async listLocalOnlyDirs(): Promise<string[]> {
    return [];
  }
}

function ensureInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ApiError(400, 'bad_request', '候选目录路径越界');
  }
}

/** 列表和计数共用过滤条件，保证两者使用同一份扫描结果时口径一致。 */
export function matchesReviewFilter(summary: CandidateSummary, filter: ReviewFilter): boolean {
  if (filter.owner && summary.owner !== filter.owner) return false;
  if (filter.statuses && filter.statuses.length > 0 && !filter.statuses.includes(summary.status)) return false;
  if (filter.tag && !summary.tags.some((tag) => tag.toLowerCase() === filter.tag?.toLowerCase())) return false;
  if (filter.dir) {
    const needle = filter.dir.replaceAll('\\', '/').toLowerCase();
    if (!summary.id.toLowerCase().includes(needle) && !summary.patchStats.entries.some((entry) => entry.path.toLowerCase().includes(needle))) {
      return false;
    }
  }
  if (filter.text) {
    const needle = filter.text.toLowerCase();
    const haystack = `${summary.title} ${summary.id} ${summary.ticket ?? ''} ${summary.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filter.createdAfter && timePoint(summary.createdAt) < timePoint(filter.createdAfter)) return false;
  if (filter.createdBefore && timePoint(summary.createdAt) > timePoint(filter.createdBefore)) return false;
  return true;
}

function timePoint(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** 冻结时钟和回拨也必须推进值，否则并发守卫无法检出未推进补丁版本的写入。 */
export function nextUpdatedAt(previous: string): string {
  const now = Date.now();
  const prevMs = previous ? new Date(previous).getTime() : Number.NaN;
  const nextMs = Number.isNaN(prevMs) || now > prevMs ? now : prevMs + 1;
  return new Date(nextMs).toISOString();
}

export class ReviewStore {
  private readonly fsSource: FilesystemCandidateSource;
  /** 只缓存可证明的共享快照及其解析结果。本地视图实时计算，带扫描错误的条目在后续请求重新读取。 */
  private readonly scanCache = new Map<string, Map<string, ScannedCandidate | null>>();
  private static readonly SCAN_CACHE_MAX = 8;

  constructor(readonly repoRoot: string) {
    this.fsSource = new FilesystemCandidateSource(repoRoot);
  }

  private get aiReviewRoot(): string {
    return path.join(this.repoRoot, '.ai-review');
  }

  resolveCandidateDir(id: string): { month: string; slug: string; dir: string } {
    const normalized = id.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    const parts = normalized.split('/');
    if (parts.length !== 2) throw new ApiError(400, 'bad_request', '候选 id 必须是 YYYY-MM/slug');
    const [month = '', slug = ''] = parts;
    if (!MONTH_PATTERN.test(month) || !SLUG_PATTERN.test(slug)) {
      throw new ApiError(400, 'bad_request', '候选 id 格式非法');
    }
    const dir = path.join(this.aiReviewRoot, month, slug);
    ensureInside(this.aiReviewRoot, dir);
    return { month, slug, dir };
  }

  private parseCandidateText(month: string, slug: string, text: string): ReviewCandidate {
    const dir = path.join(this.aiReviewRoot, month, slug);
    const reviewPath = path.join(dir, 'review.md');
    try {
      const parsed = parseReviewMarkdown(text);
      const sections = parseSections(parsed.body);
      const candidate: ReviewCandidate = {
        id: candidateId(month, slug),
        month,
        slug,
        dirPath: dir,
        reviewPath,
        meta: parsed.meta,
        sections,
        humanJudgment: extractHumanJudgment(sections.humanJudgment),
        humanJudgmentDeclared: sections.humanJudgment.trim().length > 0,
      };
      const invariantErrors = quickReviewInvariants(candidate);
      if (invariantErrors.length > 0) {
        return this.brokenCandidate(month, slug, dir, reviewPath, invariantErrors.join('；'), candidate.meta.reopenedFrom);
      }
      return candidate;
    } catch (error) {
      if (!(error instanceof ReviewFormatError)) throw error;
      const reopenedFrom = /^reopened_from:\s*["']?([^\s"']+)["']?\s*$/m.exec(text)?.[1] ?? null;
      return this.brokenCandidate(month, slug, dir, reviewPath, error.message, reopenedFrom);
    }
  }

  private async readCandidate(month: string, slug: string): Promise<ReviewCandidate> {
    return this.parseCandidateText(
      month,
      slug,
      await readFile(path.join(this.aiReviewRoot, month, slug, 'review.md'), 'utf8'),
    );
  }

  private brokenCandidate(
    month: string,
    slug: string,
    dir: string,
    reviewPath: string,
    message: string,
    reopenedFrom?: string | null,
  ): ReviewCandidate {
    const meta: ReviewFrontmatter = {
      schemaVersion: 1,
      title: slug,
      module: '',
      auditType: '',
      createdAt: '',
      updatedAt: '',
      owner: '',
      tags: [],
      status: 'pending',
      ticket: null,
      targetFiles: [],
      currentRevision: 0,
      revisions: [],
      gateChecks: [],
      comments: [],
      humanDecisions: [],
      approval: null,
      rejection: null,
      commitMessage: '',
      ...(reopenedFrom !== undefined ? { reopenedFrom } : {}),
      extra: {},
    };
    return {
      id: candidateId(month, slug),
      month,
      slug,
      dirPath: dir,
      reviewPath,
      meta,
      sections: {
        problem: '',
        rootCause: '',
        solution: '',
        humanJudgment: '',
        evidence: '',
        history: '',
        rawBody: '',
      },
      humanJudgment: [],
      humanJudgmentDeclared: false,
      parseError: message,
    };
  }

  private async scanCandidate(readSource: CandidateSource, month: string, slug: string): Promise<ScannedCandidate | null> {
    try {
      const text = await readSource.readReviewText(month, slug);
      if (text === null) return null;
      const candidate = this.parseCandidateText(month, slug, text);
      const entries = await readSource.listDirEntries(month, slug).catch(() => null);
      const entriesHas = (name: string): boolean => entries?.includes(name) ?? false;
      const currentPatchName = candidate.meta.revisions.find(
        (revision) => revision.id === candidate.meta.currentRevision,
      )?.patch ?? '';
      let stats = EMPTY_STATS;
      const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
      if (candidate.parseError === undefined && currentPatchName) {
        if (!entriesHas(currentPatchName) && !archived) {
          throw new Error(`当前版本补丁不存在：${currentPatchName}`);
        }
        const patchText = entriesHas(currentPatchName) ? await readSource.readPatchText(month, slug, currentPatchName) : null;
        // 补丁全文只用于本次解析，避免共享快照缓存随补丁体积增长。
        if (patchText !== null) stats = parsePatch(patchText).stats;
      }
      let invariantErrors: string[] | null = null;
      if (candidate.parseError === undefined) {
        const violations = fullReviewInvariants({
          candidate,
          patchExists: (revision) => archived || entriesHas(revision.patch),
          currentPatchPaths: stats === EMPTY_STATS ? null : stats.entries.map((entry) => entry.path),
        });
        if (violations.length > 0) invariantErrors = violations;
      }
      return { candidate, stats, invariantErrors, error: null };
    } catch (error) {
      const message = `${month}/${slug}: ${error instanceof Error ? error.message : String(error)}`;
      return { candidate: null, stats: EMPTY_STATS, invariantErrors: null, error: message };
    }
  }

  private async scanCandidates(src: CandidateSource, ids: string[]): Promise<Map<string, ScannedCandidate | null>> {
    const entries = await mapLimit(ids, SCAN_CONCURRENCY, async (id) => {
      const [month = '', slug = ''] = id.split('/');
      return [id, await this.scanCandidate(src, month, slug)] as const;
    });
    return new Map(entries);
  }

  async list(
    filter: ReviewFilter,
    currentBase: string | null,
    staleDays?: number | null,
    rejectionMemoryWindow?: number | null,
    source?: CandidateSource,
  ): Promise<{ items: CandidateSummary[]; errors: string[] }> {
    const src: CandidateSource = source ?? this.fsSource;
    const items: CandidateSummary[] = [];
    const errors: string[] = [];
    const memoryEntries: import('./memory.js').RejectionMemoryEntry[] = [];
    const chainInfo = new Map<string, { reopenedFrom: string | null; status: ReviewStatus }>();
    let sharedDirs: string[] = [];
    try {
      sharedDirs = await src.listCandidateDirs();
    } catch (error) {
      return { items, errors: [error instanceof Error ? error.message : String(error)] };
    }
    const shared = new Set(sharedDirs);
    const localOnly = new Set((await src.listLocalOnlyDirs().catch(() => [] as string[])).filter((id) => !shared.has(id)));
    const allDirs = [...new Set([...sharedDirs, ...localOnly])].sort((left, right) => right.localeCompare(left));

    const snapshotReader = (src as { snapshotId?: () => Promise<string | null> }).snapshotId;
    const snapshot = typeof snapshotReader === 'function' ? await snapshotReader.call(src).catch(() => null) : null;
    const cachedScan = snapshot !== null ? this.scanCache.get(snapshot) ?? null : null;
    let scannedShared: Map<string, ScannedCandidate | null>;
    if (cachedScan) {
      const missing = sharedDirs.filter((id) => !cachedScan.has(id));
      scannedShared = missing.length > 0
        ? new Map([...cachedScan, ...await this.scanCandidates(src, missing)])
        : cachedScan;
    } else {
      scannedShared = await this.scanCandidates(src, sharedDirs);
      if (snapshot !== null) {
        const cacheable = new Map<string, ScannedCandidate | null>();
        for (const [id, entry] of scannedShared) {
          if (entry?.error) continue;
          cacheable.set(id, entry);
        }
        this.scanCache.set(snapshot, cacheable);
        if (this.scanCache.size > ReviewStore.SCAN_CACHE_MAX) {
          const first = this.scanCache.keys().next().value;
          if (first !== undefined) this.scanCache.delete(first);
        }
      }
    }
    const scannedLocal = await this.scanCandidates(this.fsSource, [...localOnly]);

    const changedIds = typeof src.localChangedCandidateIds === 'function'
      ? await src.localChangedCandidateIds().catch(() => null)
      : null;
    const localOf = async (month: string, slug: string): Promise<boolean> => {
      if (changedIds) return changedIds.has(candidateId(month, slug));
      return src.hasLocalChanges(month, slug).catch(() => true);
    };

    for (const id of allDirs) {
      const [month = '', slug = ''] = id.split('/');
      const isLocalOnly = localOnly.has(id);
      const scanned = (isLocalOnly ? scannedLocal : scannedShared).get(id);
      if (!scanned) continue;
      if (scanned.error !== null) {
        errors.push(scanned.error);
        const summary: CandidateSummary = {
          id: candidateId(month, slug),
          title: slug,
          owner: '',
          status: 'pending',
          tags: [],
          ticket: null,
          currentRevision: 0,
          createdAt: '',
          dirPath: path.join(this.aiReviewRoot, month, slug),
          patchStats: EMPTY_STATS,
          unresolvedComments: 0,
          humanJudgmentCount: 0,
          humanJudgmentDeclared: false,
          isBaseBehind: false,
          baseRevision: '',
          lastFeedback: '',
          parseError: scanned.error,
        };
        // 解析失败的本地草稿也须标为本地，否则会被误作共享事实。
        summary.local = isLocalOnly || (await localOf(month, slug)) || undefined;
        summary.localOnly = isLocalOnly || undefined;
        if (matchesReviewFilter(summary, filter)) items.push(summary);
        continue;
      }
      const candidate = scanned.candidate;
      if (!candidate) continue;
      if (scanned.invariantErrors) {
        const summary = this.toSummary(
          this.brokenCandidate(month, slug, path.join(this.aiReviewRoot, month, slug), path.join(this.aiReviewRoot, month, slug, 'review.md'), scanned.invariantErrors.join('；')),
          scanned.stats, currentBase, staleDays,
        );
        summary.reopenedFrom = candidate.meta.reopenedFrom ?? null;
        summary.local = isLocalOnly || (await localOf(month, slug)) || undefined;
        summary.localOnly = isLocalOnly || undefined;
        if (matchesReviewFilter(summary, filter)) items.push(summary);
        continue;
      }
      const summary = this.toSummary(candidate, scanned.stats, currentBase, staleDays);
      summary.local = isLocalOnly || (await localOf(month, slug)) || undefined;
      summary.localOnly = isLocalOnly || undefined;
      if (!summary.local) {
        chainInfo.set(candidate.id, { reopenedFrom: candidate.meta.reopenedFrom ?? null, status: candidate.meta.status });
        if (candidate.meta.status === 'rejected') {
          const entry = entryFromCandidate({ candidateId: candidate.id, meta: candidate.meta });
          if (entry) memoryEntries.push(entry);
        }
      }
      if (!matchesReviewFilter(summary, filter)) continue;
      items.push(summary);
    }
    // I16 将指向同一被拒候选的多个直接替代者视为重开链异常。
    const replacementCount = new Map<string, number>();
    for (const info of chainInfo.values()) {
      if (info.reopenedFrom) replacementCount.set(info.reopenedFrom, (replacementCount.get(info.reopenedFrom) ?? 0) + 1);
    }
    for (const [rejectedId, count] of replacementCount) {
      if (count > 1) errors.push(`I16: rejected 候选 ${rejectedId} 有 ${String(count)} 个直接替代候选（应最多 1 个），相关 finding 不参与正常投影`);
    }
    items.sort((left, right) => {
      const byDate = timePoint(right.createdAt) - timePoint(left.createdAt);
      return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });
    if (rejectionMemoryWindow !== undefined && rejectionMemoryWindow !== null && rejectionMemoryWindow > 0) {
      // 只豁免该候选在自身重开链上继承的拒绝记录，链外同指纹的拒绝仍生效。
      const chainExempted = new Map<string, Set<string>>();
      for (const [startId, info] of chainInfo) {
        if (!info.reopenedFrom) continue;
        const exempt = new Set<string>();
        const visited = new Set<string>([startId]);
        let current: string | null = info.reopenedFrom;
        while (current !== null && !visited.has(current)) {
          visited.add(current);
          const ancestor = chainInfo.get(current);
          if (!ancestor || ancestor.status !== 'rejected') break;
          exempt.add(current);
          current = ancestor.reopenedFrom;
        }
        if (exempt.size > 0) chainExempted.set(startId, exempt);
      }
      const memory = memoryEntries
        .filter((entry) => withinWindow(entry, rejectionMemoryWindow))
        .sort((left, right) => right.rejectedAtMs - left.rejectedAtMs);
      for (const item of items) {
        if (item.local || item.parseError || item.status === 'rejected' || item.status === 'approved') continue;
        const exempt = chainExempted.get(item.id);
        const match = memory.find((entry) => entry.fingerprint === item.fingerprint && !(exempt?.has(entry.candidateId) ?? false));
        if (match) item.duplicateOf = match.candidateId;
      }
    }
    return { items, errors };
  }

  private toSummary(candidate: ReviewCandidate, stats: PatchStats, currentBase: string | null, staleDays?: number | null): CandidateSummary {
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    const baseRevision = current?.baseRevision ?? '';
    const unresolved = candidate.meta.comments.filter((comment) => comment.status !== 'resolved').length;
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
    const anchor = new Date(candidate.meta.updatedAt || candidate.meta.createdAt).getTime();
    const isStale = staleDays !== undefined && staleDays !== null && staleDays > 0 && !archived
      && !Number.isNaN(anchor) && (Date.now() - anchor) / 86_400_000 >= staleDays;
    return {
      id: candidate.id,
      title: candidate.meta.title,
      owner: candidate.meta.owner,
      status: candidate.meta.status,
      // 返回值可能被调用方修改，防止修改传播到跨请求共享的扫描缓存。
      tags: [...candidate.meta.tags],
      ticket: candidate.meta.ticket,
      currentRevision: candidate.meta.currentRevision,
      createdAt: candidate.meta.createdAt,
      dirPath: candidate.dirPath,
      patchStats: { files: stats.files, additions: stats.additions, deletions: stats.deletions, entries: stats.entries.map((entry) => ({ ...entry })) },
      unresolvedComments: unresolved,
      humanJudgmentCount: candidate.humanJudgment.length,
      humanJudgmentDeclared: candidate.humanJudgmentDeclared,
      isBaseBehind: !archived && currentBase !== null && baseRevision !== '' && baseRevision !== currentBase,
      baseRevision,
      lastFeedback: findLastFeedback(candidate.meta),
      reopenedFrom: candidate.meta.reopenedFrom ?? null,
      fingerprint: fingerprintOf(candidate.meta),
      ...(isStale ? { isStale: true } : {}),
      ...(candidate.parseError ? { parseError: candidate.parseError } : {}),
    };
  }

  private patchPathFor(candidate: ReviewCandidate, patchName: string): string {
    const name = path.basename(patchName);
    if (name !== patchName || name.includes('..')) {
      throw new ApiError(400, 'bad_request', 'patch 文件名非法');
    }
    return path.join(candidate.dirPath, name);
  }

  async get(id: string, currentBase: string | null, source?: CandidateSource): Promise<CandidateDetail> {
    const src = source ?? this.fsSource;
    const { month, slug } = this.resolveCandidateDir(id);
    const text = await src.readReviewText(month, slug);
    if (text === null) {
      throw new ApiError(404, 'not_found', `候选不存在：${id}`);
    }
    const candidate = this.parseCandidateText(month, slug, text);
    // 保留损坏候选的诊断入口，使用户能看到错误并处理该候选。
    if (candidate.parseError) {
      return {
        candidate,
        currentBase,
        isBaseBehind: false,
        patchText: '',
        patchStats: EMPTY_STATS,
      };
    }
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) throw new ApiError(500, 'internal', '当前版本元数据缺失');
    const entries = await src.listDirEntries(month, slug).catch(() => null);
    const hasPatch = entries?.includes(current.patch) ?? false;
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
    if (!hasPatch && !archived) {
      throw new ApiError(422, 'bad_request', `当前版本补丁不存在：${current.patch}`);
    }
    const patchText = hasPatch ? (await src.readPatchText(month, slug, current.patch)) ?? '' : '';
    return {
      candidate,
      currentBase,
      isBaseBehind: currentBase !== null && current.baseRevision !== currentBase,
      patchText,
      patchStats: patchText ? parsePatch(patchText).stats : EMPTY_STATS,
    };
  }

  async readPatch(id: string, patchName: string, source?: CandidateSource): Promise<string> {
    const src = source ?? this.fsSource;
    const { month, slug } = this.resolveCandidateDir(id);
    const name = path.basename(patchName);
    if (name !== patchName || name.includes('..')) {
      throw new ApiError(400, 'bad_request', 'patch 文件名非法');
    }
    const text = await src.readPatchText(month, slug, patchName);
    if (text === null) throw new ApiError(404, 'not_found', `补丁不存在：${patchName}`);
    return text;
  }

  /** 评审目录必须解析到实际仓库内，且目标文件不能是符号链接。 */
  private async ensureSafeWriteTarget(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    const realDir = await realpath(dir).catch(() => null);
    const realRepo = await realpath(this.repoRoot).catch(() => path.resolve(this.repoRoot));
    const realRoot = await realpath(this.aiReviewRoot).catch(() => path.resolve(this.aiReviewRoot));
    if (!realDir) throw new ApiError(422, 'bad_request', `写入目录不存在：${dir}`);
    ensureInside(realRepo, realRoot);
    ensureInside(realRoot, realDir);
    const existing = await lstat(filePath).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new ApiError(422, 'bad_request', `拒绝写入符号链接目标：${filePath}`);
    }
  }

  async write(candidate: ReviewCandidate, options?: { touchUpdatedAt?: boolean }): Promise<void> {
    await this.ensureSafeWriteTarget(candidate.reviewPath);
    if (options?.touchUpdatedAt !== false) {
      candidate.meta.updatedAt = nextUpdatedAt(candidate.meta.updatedAt);
    }
    const text = serializeReviewMarkdown(candidate.meta, candidate.sections.rawBody);
    const temp = `${candidate.reviewPath}.tmp-${String(process.pid)}`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, candidate.reviewPath);
    // 检测首次校验之后父目录被换成符号链接的情况。
    const realAfter = await realpath(path.dirname(candidate.reviewPath)).catch(() => null);
    const realRoot = await realpath(this.aiReviewRoot).catch(() => path.resolve(this.aiReviewRoot));
    if (realAfter) ensureInside(realRoot, realAfter);
    candidate.sections = parseSections(candidate.sections.rawBody);
    candidate.humanJudgment = extractHumanJudgment(candidate.sections.humanJudgment);
    candidate.humanJudgmentDeclared = candidate.sections.humanJudgment.trim().length > 0;
  }

  async ensureWriteAllowed(candidate: ReviewCandidate, guard: ConcurrencyGuard): Promise<void> {
    const staleDetails = () => ({
      currentRevision: candidate.meta.currentRevision,
      currentOwner: candidate.meta.owner,
      currentUpdatedAt: candidate.meta.updatedAt,
    });
    if (guard.expectedRevision !== candidate.meta.currentRevision || guard.expectedOwner !== candidate.meta.owner) {
      throw new ApiError(409, 'stale', '候选已被其他人更新，请重新加载', staleDetails());
    }
    const expectedAt = new Date(guard.expectedUpdatedAt).getTime();
    const currentAt = new Date(candidate.meta.updatedAt).getTime();
    if (Number.isNaN(expectedAt) || expectedAt !== currentAt) {
      throw new ApiError(409, 'stale', '候选已被其他人更新，请重新加载', staleDetails());
    }
    if (candidate.meta.status === 'approved' || candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '该候选已归档，不能再修改');
    }
  }

  private async normalizeCommentInput(
    candidate: ReviewCandidate,
    input: { content: string; file?: string; line?: number; revision?: number; side?: 'LEFT' | 'RIGHT'; anchor?: { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } },
  ): Promise<{ content: string; revision: number; file: string; line: number; side?: 'LEFT' | 'RIGHT'; anchor?: { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } }> {
    const content = input.content.trim();
    if (!content) throw new ApiError(422, 'bad_request', '意见内容不能为空');
    const revision = input.revision ?? candidate.meta.currentRevision;
    if (!Number.isInteger(revision) || !candidate.meta.revisions.some((item) => item.id === revision)) {
      throw new ApiError(422, 'bad_request', `评论 revision 必须指向已有版本：${String(revision)}`);
    }
    const file = (input.file ?? '').replaceAll('\\', '/');
    const line = input.line ?? 0;
    if (file === '') {
      if (line !== 0) throw new ApiError(422, 'bad_request', '总体评论必须 line=0');
      if (input.side !== undefined) throw new ApiError(422, 'bad_request', '总体评论不能携带 side');
      if (input.anchor !== undefined) throw new ApiError(422, 'bad_request', '总体评论不能携带 anchor');
      return { content, revision, file: '', line: 0 };
    }
    if (!isRepoRelativePath(file)) throw new ApiError(422, 'bad_request', `行内评论文件不是合法仓库相对路径：${file}`);
    if (!Number.isInteger(line) || line <= 0) throw new ApiError(422, 'bad_request', '行内评论 line 必须为正整数');
    if (input.side !== 'LEFT' && input.side !== 'RIGHT') {
      throw new ApiError(422, 'bad_request', '行内评论必须指明 LEFT 或 RIGHT');
    }
    let anchor = input.anchor;
    if (anchor !== undefined) {
      if (!anchor.snippet.trim()) throw new ApiError(422, 'bad_request', 'anchor.snippet 不能为空');
      anchor = {
        snippet: anchor.snippet,
        ...(typeof anchor.before === 'string' && anchor.before ? { before: anchor.before } : {}),
        ...(typeof anchor.after === 'string' && anchor.after ? { after: anchor.after } : {}),
        ...(anchor.extra ? { extra: anchor.extra } : {}),
      };
    } else {
      anchor = await this.extractHostAnchor(candidate, revision, file, line, input.side);
    }
    return { content, revision, file, line, side: input.side, ...(anchor ? { anchor } : {}) };
  }

  private async extractHostAnchor(
    candidate: ReviewCandidate,
    revision: number,
    file: string,
    line: number,
    side: 'LEFT' | 'RIGHT',
  ): Promise<{ snippet: string; before?: string; after?: string } | undefined> {
    const entry = candidate.meta.revisions.find((item) => item.id === revision);
    if (!entry) return undefined;
    try {
      const patchText = await readFile(path.join(candidate.dirPath, entry.patch), 'utf8');
      return anchorFromPatch(patchText, file, line, side);
    } catch {
      return undefined;
    }
  }

  async addComment(
    id: string,
    author: string,
    input: { content: string; file?: string; line?: number; revision?: number; side?: 'LEFT' | 'RIGHT'; anchor?: { snippet: string; before?: string; after?: string } },
    guard: ConcurrencyGuard,
  ): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const normalized = await this.normalizeCommentInput(candidate, input);
    const comment: ReviewComment = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      ...normalized,
      author,
      status: 'unresolved',
      createdAt: new Date().toISOString(),
    };
    candidate.meta.comments.push(comment);
    if (candidate.meta.status === 'pending') candidate.meta.status = 'changes_requested';
    await this.write(candidate);
    return candidate;
  }

  /** 恢复审核只改变候选状态，不要求作者重新生产补丁。 */
  async resume(id: string, guard: ConcurrencyGuard): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    if (candidate.meta.status !== 'changes_requested') {
      throw new ApiError(409, 'conflict', `只有 changes_requested 可转回 pending（当前 ${candidate.meta.status}）`);
    }
    candidate.meta.status = 'pending';
    await this.write(candidate);
    return candidate;
  }

  /** 任一评论无效时整批不落盘，避免修正输入后重试时重复写入先前的评论。 */
  async addComments(
    id: string,
    author: string,
    inputs: Array<{ content: string; file?: string; line?: number; revision?: number; side?: 'LEFT' | 'RIGHT'; anchor?: { snippet: string; before?: string; after?: string } }>,
    guard: ConcurrencyGuard,
  ): Promise<ReviewCandidate> {
    if (inputs.length === 0) throw new ApiError(422, 'bad_request', '批量评论不能为空');
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const normalized: Array<{ content: string; revision: number; file: string; line: number; side?: 'LEFT' | 'RIGHT'; anchor?: { snippet: string; before?: string; after?: string } }> = [];
    for (const input of inputs) {
      normalized.push(await this.normalizeCommentInput(candidate, input));
    }
    const comments: ReviewComment[] = normalized.map((item) => ({
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      ...item,
      author,
      status: 'unresolved' as const,
      createdAt: new Date().toISOString(),
    }));
    candidate.meta.comments.push(...comments);
    if (candidate.meta.status === 'pending') candidate.meta.status = 'changes_requested';
    await this.write(candidate);
    return candidate;
  }

  async setCommentStatus(
    id: string,
    commentId: string,
    status: ReviewComment['status'],
    guard: ConcurrencyGuard,
  ): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const comment = candidate.meta.comments.find((item) => item.id === commentId);
    if (!comment) throw new ApiError(404, 'not_found', '意见不存在');
    comment.status = status;
    await this.write(candidate);
    return candidate;
  }

  async transferOwner(id: string, owner: string, guard: ConcurrencyGuard): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const next = owner.trim();
    if (!next) throw new ApiError(400, 'bad_request', '新负责人不能为空');
    candidate.meta.owner = next;
    await this.write(candidate);
    return candidate;
  }

  async reject(
    id: string,
    reason: string,
    guard: ConcurrencyGuard,
    options?: { rejectedBy?: string; requireStaleDays?: number; category?: string; relatedSymbols?: string[] },
  ): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const trimmed = reason.trim();
    if (!trimmed) throw new ApiError(422, 'bad_request', '放弃原因不能为空');
    if (options?.category !== undefined && !options.category.trim()) {
      throw new ApiError(422, 'bad_request', '拒绝分类必须是非空字符串');
    }
    if (options?.requireStaleDays !== undefined) {
      const anchor = new Date(candidate.meta.updatedAt || candidate.meta.createdAt).getTime();
      const ageDays = (Date.now() - anchor) / 86_400_000;
      if (Number.isNaN(anchor)) throw new ApiError(422, 'bad_request', 'updated_at 无法解析，不能判定超时');
      if (ageDays < options.requireStaleDays) {
        throw new ApiError(409, 'conflict', `未超过 stale_days（${String(options.requireStaleDays)} 天，当前 ${ageDays.toFixed(1)} 天），不能按超时归档`);
      }
    }
    candidate.meta.status = 'rejected';
    candidate.meta.approval = null;
    // 补丁会在拒绝后删除，须先保存可供后续复查的关联符号。
    candidate.meta.rejection = {
      rejectedBy: options?.rejectedBy ?? guard.expectedOwner,
      rejectedAt: new Date().toISOString(),
      reason: trimmed,
      ...((options?.category !== undefined || (options?.relatedSymbols?.length ?? 0) > 0)
        ? {
            extra: {
              ...(options?.category !== undefined ? { category: options.category } : {}),
              ...(options?.relatedSymbols && options.relatedSymbols.length > 0 ? { related_symbols: options.relatedSymbols } : {}),
            },
          }
        : {}),
    };
    candidate.sections.rawBody = appendVersionSection(
      candidate.sections.rawBody,
      candidate.meta.currentRevision,
      candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision)?.baseRevision ?? '',
      `### 放弃\n${trimmed}`,
    );
    await this.write(candidate);
    return candidate;
  }

  /** 调用方负责核验 Owner 的人工操作，防止自动流程自行豁免拒绝记忆。 */
  async reopen(
    id: string,
    fromId: string,
    reason: string,
    guard: ConcurrencyGuard,
    source?: CandidateSource,
  ): Promise<ReviewCandidate> {
    const readShared = async (candidateKey: string): Promise<ReviewCandidate> => {
      const resolved = this.resolveCandidateDir(candidateKey);
      if (!source) return this.readCandidate(resolved.month, resolved.slug);
      const text = await source.readReviewText(resolved.month, resolved.slug);
      if (text === null) throw new ApiError(404, 'not_found', `共享候选不存在：${candidateKey}`);
      return this.parseCandidateText(resolved.month, resolved.slug, text);
    };
    const candidate = await readShared(id);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new ApiError(422, 'bad_request', '重开理由不能为空');
    const fromCandidate = await readShared(fromId);
    if (fromCandidate.parseError) throw new ApiError(422, 'bad_request', `被拒候选无法解析：${fromCandidate.parseError}`);
    if (fromCandidate.meta.status !== 'rejected' || !fromCandidate.meta.rejection) {
      throw new ApiError(409, 'conflict', `reopened_from 必须指向 rejected 候选：${fromId}`);
    }
    if (await this.hasDirectReplacement(fromId, candidate.id, source)) {
      throw new ApiError(409, 'conflict', `被拒候选 ${fromId} 已有直接替代候选，不能再重开（I16）`);
    }
    candidate.meta.reopenedFrom = fromId;
    candidate.meta.reopenedReason = trimmedReason;
    await this.write(candidate);
    return candidate;
  }

  private async hasDirectReplacement(fromId: string, excludeId: string, source?: CandidateSource): Promise<boolean> {
    if (source) {
      for (const id of await source.listCandidateDirs()) {
        if (id === excludeId) continue;
        const { month, slug } = this.resolveCandidateDir(id);
        const text = await source.readReviewText(month, slug);
        if (text === null) throw new Error(`无法读取共享候选 ${id}，不能证明重开唯一性`);
        const candidate = this.parseCandidateText(month, slug, text);
        if (candidate.meta.reopenedFrom === fromId) return true;
      }
      return false;
    }
    const months = await readdir(this.aiReviewRoot, { withFileTypes: true }).catch(() => []);
    for (const monthEntry of months) {
      if (!monthEntry.isDirectory() || !MONTH_PATTERN.test(monthEntry.name)) continue;
      const month = monthEntry.name;
      const slugs = await readdir(path.join(this.aiReviewRoot, month), { withFileTypes: true }).catch(() => []);
      for (const slugEntry of slugs) {
        if (!slugEntry.isDirectory()) continue;
        const slug = slugEntry.name;
        if (candidateId(month, slug) === excludeId) continue;
        const candidate = await this.readCandidate(month, slug);
        if (candidate.meta.reopenedFrom === fromId) return true;
      }
    }
    return false;
  }

  /** 调用方负责隔离工作区并运行门禁。此处写入评审数据和补丁。 */
  async appendRevision(
    id: string,
    input: { author: 'ai' | 'human'; baseRevision: string; patchText: string },
    guard: ConcurrencyGuard,
  ): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const nextId = candidate.meta.currentRevision + 1;
    const patchName = `${String(nextId).padStart(3, '0')}.patch`;
    const { writeFile: writePatchFile } = await import('node:fs/promises');
    const patchPath = path.join(candidate.dirPath, patchName);
    await this.ensureSafeWriteTarget(patchPath);
    await writePatchFile(patchPath, input.patchText, 'utf8');
    candidate.meta.revisions.push({ id: nextId, baseRevision: input.baseRevision, patch: patchName, author: input.author });
    candidate.meta.currentRevision = nextId;
    candidate.meta.status = 'pending';
    candidate.meta.approval = null;
    await this.write(candidate);
    return candidate;
  }

  async applyApproval(
    candidate: ReviewCandidate,
    approvedBy: string,
    report: ValidationReport,
    decisions?: { confirmed: string[]; waived: { id: string; reason: string }[] },
  ): Promise<void> {
    candidate.meta.status = 'approved';
    candidate.meta.approval = {
      approvedBy,
      approvedAt: new Date().toISOString(),
      // 业务提交版本从 VCS 历史派生，避免为回填哈希额外产生一次提交。
      gateChecks: [...candidate.meta.gateChecks],
      gateResults: report.results.map((result) => ({
        command: result.command,
        exit_code: result.exitCode ?? -1,
        duration_ms: result.durationMs,
      })),
      confirmedDecisions: decisions ? [...decisions.confirmed] : [],
      waivedDecisions: decisions ? decisions.waived.map((item) => ({ ...item })) : [],
    };
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    candidate.sections.rawBody = appendVersionSection(
      candidate.sections.rawBody,
      candidate.meta.currentRevision,
      current?.baseRevision ?? '',
      ['### 验证结果', report.formattedEvidenceMarkdown, '### 人类总体意见', `批准（${approvedBy}）`].join('\n\n'),
    );
    await this.write(candidate);
  }

  async validateCandidate(candidate: ReviewCandidate): Promise<string[]> {
    const errors: string[] = [];
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
    const ids = new Set<number>();
    for (const revision of candidate.meta.revisions) {
      if (ids.has(revision.id)) errors.push(`重复的版本号：${String(revision.id)}`);
      ids.add(revision.id);
      if (!Number.isInteger(revision.id) || revision.id <= 0) errors.push(`版本号必须是正整数：${String(revision.id)}`);
      if (!archived) {
        const patchPath = this.patchPathFor(candidate, revision.patch);
        if (!existsSync(patchPath)) errors.push(`版本 ${String(revision.id)} 的补丁不存在：${revision.patch}`);
      }
    }
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) errors.push('current_revision 不在 revisions 中');
    if (!archived && candidate.meta.gateChecks.length === 0) errors.push('gate_checks 为空：批准前必须定义合并门禁命令');
    if (!candidate.meta.owner) errors.push('owner 为空');
    if (!archived && !candidate.humanJudgmentDeclared) {
      errors.push('需人工判断项未填写');
    }
    return errors;
  }

  async currentPatch(candidate: ReviewCandidate, source?: CandidateSource): Promise<{ path: string; text: string; baseRevision: string }> {
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) throw new ApiError(500, 'internal', '当前版本缺失');
    const patchPath = this.patchPathFor(candidate, current.patch);
    const text = source
      ? await source.readPatchText(candidate.month, candidate.slug, current.patch)
      : await readFile(patchPath, 'utf8');
    if (text === null) throw new ApiError(404, 'not_found', `共享快照中不存在补丁：${current.patch}`);
    return {
      path: patchPath,
      text,
      baseRevision: current.baseRevision,
    };
  }

  /** 只交付共享补丁内容，避免共享流程通过返回的路径读到工作区草稿。 */
  async readSharedPatch(
    candidate: ReviewCandidate,
    source: CandidateSource,
    revisionId?: number,
  ): Promise<{ revision: number; patchName: string; text: string; baseRevision: string }> {
    const revision = revisionId === undefined
      ? candidate.meta.revisions.find((item) => item.id === candidate.meta.currentRevision)
      : candidate.meta.revisions.find((item) => item.id === revisionId);
    if (!revision) throw new ApiError(500, 'internal', '版本缺失');
    const text = await source.readPatchText(candidate.month, candidate.slug, revision.patch);
    if (text === null) {
      throw new ApiError(404, 'not_found', `共享快照中不存在补丁：${revision.patch}（候选 ${candidate.id}）`);
    }
    return { revision: revision.id, patchName: revision.patch, text, baseRevision: revision.baseRevision };
  }

  async validateFullCandidate(
    candidate: ReviewCandidate,
    source?: CandidateSource,
    associationSource?: CandidateSource,
  ): Promise<string[]> {
    const errors = await this.validateCandidate(candidate);
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) return errors;
    const entries = source
      ? await source.listDirEntries(candidate.month, candidate.slug).catch(() => null)
      : await readdir(candidate.dirPath).catch(() => null);
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
    let currentPatchPaths: string[] | null = null;
    if (!archived) {
      try {
        const text = source
          ? await source.readPatchText(candidate.month, candidate.slug, current.patch)
          : await readFile(this.patchPathFor(candidate, current.patch), 'utf8');
        if (text === null) errors.push(`I5: 无法读取当前补丁 ${current.patch}，不能证明 target_files 一致`);
        else currentPatchPaths = parsePatch(text).paths.filter((file) => !isAiReviewPath(file));
      } catch {
        errors.push(`I5: 无法读取当前补丁 ${current.patch}，不能证明 target_files 一致`);
      }
    }
    const linkedSource = associationSource ?? source;
    const reopenedTargetRejected = candidate.meta.reopenedFrom
      ? await (async (): Promise<((target: string) => boolean | null) | undefined> => {
          try {
            const { month, slug } = this.resolveCandidateDir(candidate.meta.reopenedFrom ?? '');
            const targetCandidate = linkedSource
              ? await (async () => {
                  const text = await linkedSource.readReviewText(month, slug);
                  return text === null ? null : this.parseCandidateText(month, slug, text);
                })()
              : await this.readCandidate(month, slug);
            const rejected = targetCandidate !== null && targetCandidate.parseError === undefined
              && targetCandidate.meta.status === 'rejected' && targetCandidate.meta.rejection !== null;
            return () => rejected;
          } catch {
            return () => false;
          }
        })()
      : undefined;
    errors.push(...fullReviewInvariants({
      candidate,
      patchExists: (revision) => entries?.includes(revision.patch) ?? false,
      currentPatchPaths,
      ...(reopenedTargetRejected ? { reopenedTargetRejected } : {}),
    }));
    return [...new Set(errors)];
  }

  async listStatusCounts(owner: string, source?: CandidateSource): Promise<Record<ReviewStatus, number>> {
    const counts: Record<ReviewStatus, number> = {
      pending: 0,
      changes_requested: 0,
      approved: 0,
      rejected: 0,
    };
    const { items } = await this.list({ owner }, null, undefined, undefined, source);
    for (const item of items) if (!item.local) counts[item.status] += 1;
    return counts;
  }

  /** 包含损坏或未写完的候选目录，便于审查收尾核对 Agent 的实际产物。 */
  async listCandidateIds(): Promise<string[]> {
    const ids: string[] = [];
    let months: string[] = [];
    try {
      months = (await readdir(this.aiReviewRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && MONTH_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return ids;
    }
    months.sort((left, right) => left.localeCompare(right));
    for (const month of months) {
      let slugs: string[] = [];
      try {
        slugs = (await readdir(path.join(this.aiReviewRoot, month), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const dir = path.join(this.aiReviewRoot, month, slug);
        const entries = await readdir(dir).catch(() => [] as string[]);
        if (!entries.some((name) => name === 'review.md' || /\.patch$/i.test(name))) continue;
        ids.push(candidateId(month, slug));
      }
    }
    return ids;
  }
}
