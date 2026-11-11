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

/**
 * §7.1 候选数据读取源：默认读文件系统（写路径/审计收尾使用）；
 * 共享读取（队列/详情/负向记忆/派生）传入绑定同一 VCS 快照的源（如 GitHeadCandidateSource），
 * 只读已提交内容并标记 local 差异。
 */
export interface CandidateSource {
  /** 列出共享快照中存在 review.md 的候选目录（'YYYY-MM/slug'）。 */
  listCandidateDirs(): Promise<string[]>;
  /** 候选目录内文件名列表；目录不存在返回 null。 */
  listDirEntries(month: string, slug: string): Promise<string[] | null>;
  /** 读取 review.md 文本；不存在返回 null。 */
  readReviewText(month: string, slug: string): Promise<string | null>;
  /** 读取补丁文本；不存在返回 null。 */
  readPatchText(month: string, slug: string, patchName: string): Promise<string | null>;
  /** 工作区相对共享快照是否存在本地改动（review/补丁任一）。 */
  hasLocalChanges(month: string, slug: string): Promise<boolean>;
  /** 仅存在于工作区、未进入共享快照的候选目录（local 诊断）。 */
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

/** Queue filter shared by `list()` and the API, which reuses one scan for items and counts. */
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

/** §2.2：时间比较一律按解析后的时间点；无效时间排最后。 */
function timePoint(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * §4.3 updated_at 严格单调：每次共享写入必须严格大于上一值，精度至少毫秒。
 * 同一刻度或时钟回拨时使用“上一值 + 1ms”，再规范化为 UTC ISO 字符串。
 */
export function nextUpdatedAt(previous: string): string {
  const now = Date.now();
  const prevMs = previous ? new Date(previous).getTime() : Number.NaN;
  const nextMs = Number.isNaN(prevMs) || now > prevMs ? now : prevMs + 1;
  return new Date(nextMs).toISOString();
}

export class ReviewStore {
  private readonly fsSource: FilesystemCandidateSource;

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
      // §13.2：读取候选时执行只读不变量校验，违反者标记 broken，不参与批准/投影。
      const invariantErrors = quickReviewInvariants(candidate);
      if (invariantErrors.length > 0) {
        return this.brokenCandidate(month, slug, dir, reviewPath, invariantErrors.join('；'));
      }
      return candidate;
    } catch (error) {
      if (!(error instanceof ReviewFormatError)) throw error;
      return this.brokenCandidate(month, slug, dir, reviewPath, error.message);
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

  async list(
    filter: ReviewFilter,
    currentBase: string | null,
    staleDays?: number | null,
    rejectionMemoryWindow?: number | null,
    source?: CandidateSource,
  ): Promise<{ items: CandidateSummary[]; errors: string[] }> {
    const src = source ?? this.fsSource;
    const items: CandidateSummary[] = [];
    const errors: string[] = [];
    const memoryEntries: import('./memory.js').RejectionMemoryEntry[] = [];
    // §6.2 链豁免计算输入：id → 重开指向与状态（仅共享事实候选）。
    const chainInfo = new Map<string, { reopenedFrom: string | null; status: ReviewStatus }>();
    let sharedDirs: string[] = [];
    try {
      sharedDirs = await src.listCandidateDirs();
    } catch (error) {
      return { items, errors: [error instanceof Error ? error.message : String(error)] };
    }
    // §7.1：仅存在于工作区的候选目录只作 local 诊断，不进入共享流程。
    const shared = new Set(sharedDirs);
    const localOnly = new Set((await src.listLocalOnlyDirs().catch(() => [] as string[])).filter((id) => !shared.has(id)));
    const allDirs = [...new Set([...sharedDirs, ...localOnly])].sort((left, right) => right.localeCompare(left));
    for (const id of allDirs) {
      const [month = '', slug = ''] = id.split('/');
      const isLocalOnly = localOnly.has(id);
      const readSource = isLocalOnly ? this.fsSource : src;
      try {
        const text = await readSource.readReviewText(month, slug);
        if (text === null) continue;
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
          if (patchText !== null) stats = parsePatch(patchText).stats;
        }
        // I5/I4 的补丁上下文校验（声明非空时强制路径一致）。
        if (candidate.parseError === undefined) {
          const invariantErrors = fullReviewInvariants({
            candidate,
            patchExists: (revision) => archived || entriesHas(revision.patch),
            currentPatchPaths: stats === EMPTY_STATS ? null : stats.entries.map((entry) => entry.path),
          });
          if (invariantErrors.length > 0) {
            const summary = this.toSummary(
              this.brokenCandidate(month, slug, path.join(this.aiReviewRoot, month, slug), path.join(this.aiReviewRoot, month, slug, 'review.md'), invariantErrors.join('；')),
              stats, currentBase, staleDays,
            );
            summary.local = isLocalOnly || (await src.hasLocalChanges(month, slug).catch(() => false)) || undefined;
            if (matchesReviewFilter(summary, filter)) items.push(summary);
            continue;
          }
        }
        const summary = this.toSummary(candidate, stats, currentBase, staleDays);
        summary.local = isLocalOnly || (await src.hasLocalChanges(month, slug).catch(() => false)) || undefined;
        if (!summary.local) {
          chainInfo.set(candidate.id, { reopenedFrom: candidate.meta.reopenedFrom ?? null, status: candidate.meta.status });
          // §7.1：local 候选不进入共享流程——不作负向记忆来源。
          if (candidate.meta.status === 'rejected') {
            const entry = entryFromCandidate({ candidateId: candidate.id, meta: candidate.meta });
            if (entry) memoryEntries.push(entry);
          }
        }
        if (!matchesReviewFilter(summary, filter)) continue;
        items.push(summary);
      } catch (error) {
        const message = `${month}/${slug}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
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
          parseError: message,
        };
        // §7.1：错误路径同样必须标记本地视图，否则 local 草稿会被误当作共享事实。
        summary.local = isLocalOnly || (await src.hasLocalChanges(month, slug).catch(() => false)) || undefined;
        if (matchesReviewFilter(summary, filter)) items.push(summary);
      }
    }
    // §4.8/I16：每个 rejected 候选最多一个直接替代候选——重复替代属链异常，报告为队列错误。
    const replacementCount = new Map<string, number>();
    for (const info of chainInfo.values()) {
      if (info.reopenedFrom) replacementCount.set(info.reopenedFrom, (replacementCount.get(info.reopenedFrom) ?? 0) + 1);
    }
    for (const [rejectedId, count] of replacementCount) {
      if (count > 1) errors.push(`I16: rejected 候选 ${rejectedId} 有 ${String(count)} 个直接替代候选（应最多 1 个），相关 finding 不参与正常投影`);
    }
    items.sort((left, right) => {
      // §2.2：按时间点而非字符串；同一时间点以候选 id 为次序键。
      const byDate = timePoint(right.createdAt) - timePoint(left.createdAt);
      return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });
    // §7：负向记忆实时计算——窗口内完全相同指纹的活跃候选被标记阻止（合法重开链豁免祖先）。
    if (rejectionMemoryWindow !== undefined && rejectionMemoryWindow !== null && rejectionMemoryWindow > 0) {
      // §6.2：豁免按候选各自的重开链计算——链上候选只豁免自己的全部被拒祖先，
      // 链外候选的同指纹匹配仍正常阻止。
      const chainExempted = new Map<string, Set<string>>();
      for (const [startId, info] of chainInfo) {
        if (!info.reopenedFrom) continue;
        const exempt = new Set<string>();
        const visited = new Set<string>([startId]);
        let current: string | null = info.reopenedFrom;
        while (current !== null && !visited.has(current)) {
          visited.add(current);
          const ancestor = chainInfo.get(current);
          if (!ancestor || ancestor.status !== 'rejected') break; // 链异常：其后祖先不豁免
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
        // duplicateOf = 按 rejected_at 倒序的第一条未豁免匹配记录（链外同指纹仍阻止）。
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
    // §18.1：队列加载只提示过期（本地派生状态），不做读时写。
    const anchor = new Date(candidate.meta.updatedAt || candidate.meta.createdAt).getTime();
    const isStale = staleDays !== undefined && staleDays !== null && staleDays > 0 && !archived
      && !Number.isNaN(anchor) && (Date.now() - anchor) / 86_400_000 >= staleDays;
    return {
      id: candidate.id,
      title: candidate.meta.title,
      owner: candidate.meta.owner,
      status: candidate.meta.status,
      tags: candidate.meta.tags,
      ticket: candidate.meta.ticket,
      currentRevision: candidate.meta.currentRevision,
      createdAt: candidate.meta.createdAt,
      dirPath: candidate.dirPath,
      patchStats: stats,
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
    // §18.8：broken 候选只读展示（详情页可见 parseError），不在此抛错造成死胡同；
    // 写路径各自经 readCategory/校验拦截。
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

  /**
   * §12.2：写入前用真实路径确认仍在 `.ai-review` 内，并拒绝覆盖符号链接目标；
   * 写入后再复核一次，防止校验后被替换为 symlink。
   */
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
      // §4.3：每次共享写入严格推进 updated_at（冻结时钟/回拨时上一值 +1ms，规范为 UTC）。
      candidate.meta.updatedAt = nextUpdatedAt(candidate.meta.updatedAt);
    }
    const text = serializeReviewMarkdown(candidate.meta, candidate.sections.rawBody);
    const temp = `${candidate.reviewPath}.tmp-${String(process.pid)}`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, candidate.reviewPath);
    // 操作后复核包含关系，防止校验后父目录被替换为 symlink。
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
    // §8.1：expectedUpdatedAt 必须等于当前规范化后的 updated_at（按时间点比较），
    // 用于发现评论等不推进补丁版本的写入。
    const expectedAt = new Date(guard.expectedUpdatedAt).getTime();
    const currentAt = new Date(candidate.meta.updatedAt).getTime();
    if (Number.isNaN(expectedAt) || expectedAt !== currentAt) {
      throw new ApiError(409, 'stale', '候选已被其他人更新，请重新加载', staleDetails());
    }
    if (candidate.meta.status === 'approved' || candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '该候选已归档，不能再修改');
    }
  }

  /** §4.3/I11：统一校验评论形状，并在行内评论未提供 anchor 时由 Host 从 Hunk 兜底提取。 */
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
      // §4.3：Client 未上传时 Host 从该 revision 的补丁 Hunk 提取；失败静默省略。
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

  /**
   * §5.1 /resume：仅 Owner 显式把 changes_requested 转回 pending；
   * 不产生新补丁版本，只改状态并推进 updated_at。
   */
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

  /**
   * §8.3 /comments/batch：全有或全无——先逐条校验，任一条非法整批 422 不写入；
   * 一次共享写入与一次提交，pending→changes_requested 只在批次内发生一次。
   */
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
    // §8.3：先整体校验（含 Host anchor 兜底），任一条非法即抛错，不部分写入。
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
      // §18.1：显式归档过期候选——只有确实超过 stale_days 的候选可归档（乐观锁保证只写一次）。
      const anchor = new Date(candidate.meta.updatedAt || candidate.meta.createdAt).getTime();
      const ageDays = (Date.now() - anchor) / 86_400_000;
      if (Number.isNaN(anchor)) throw new ApiError(422, 'bad_request', 'updated_at 无法解析，不能判定超时');
      if (ageDays < options.requireStaleDays) {
        throw new ApiError(409, 'conflict', `未超过 stale_days（${String(options.requireStaleDays)} 天，当前 ${ageDays.toFixed(1)} 天），不能按超时归档`);
      }
    }
    candidate.meta.status = 'rejected';
    candidate.meta.approval = null;
    // §4.8：拒绝必须在同一写入中留痕 rejection；G38：可选 category/related_symbols
    //（related_symbols 由 Host 在删除补丁前从 hunk header 提取；未知 category 原样保留）。
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

  /**
   * §4.8/§18.6：人工重开被拒方案——在活跃候选上标记 reopened_from/reopen_reason。
   * 仅 Owner 人工操作（API 层保证不由 AI 路径触发）；目标必须是真实存在的 rejected 候选。
   */
  async reopen(id: string, fromId: string, reason: string, guard: ConcurrencyGuard): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new ApiError(422, 'bad_request', '重开理由不能为空');
    const { month: fromMonth, slug: fromSlug } = this.resolveCandidateDir(fromId);
    const fromPath = path.join(this.aiReviewRoot, fromMonth, fromSlug, 'review.md');
    if (!existsSync(fromPath)) throw new ApiError(404, 'not_found', `被拒候选不存在：${fromId}`);
    const fromCandidate = await this.readCandidate(fromMonth, fromSlug);
    if (fromCandidate.parseError) throw new ApiError(422, 'bad_request', `被拒候选无法解析：${fromCandidate.parseError}`);
    if (fromCandidate.meta.status !== 'rejected' || !fromCandidate.meta.rejection) {
      throw new ApiError(409, 'conflict', `reopened_from 必须指向 rejected 候选：${fromId}`);
    }
    // §8.3/I16：每个 rejected 候选最多一个直接替代候选，/reopen 必须在锁内强制。
    if (await this.hasDirectReplacement(fromId, candidate.id)) {
      throw new ApiError(409, 'conflict', `被拒候选 ${fromId} 已有直接替代候选，不能再重开（I16）`);
    }
    candidate.meta.reopenedFrom = fromId;
    candidate.meta.reopenedReason = trimmedReason;
    await this.write(candidate);
    return candidate;
  }

  /** §8.3/I16：扫描现有候选，判断某个 rejected 候选是否已有直接替代。 */
  private async hasDirectReplacement(fromId: string, excludeId: string): Promise<boolean> {
    const months = await readdir(this.aiReviewRoot, { withFileTypes: true }).catch(() => []);
    for (const monthEntry of months) {
      if (!monthEntry.isDirectory() || !MONTH_PATTERN.test(monthEntry.name)) continue;
      const month = monthEntry.name;
      const slugs = await readdir(path.join(this.aiReviewRoot, month), { withFileTypes: true }).catch(() => []);
      for (const slugEntry of slugs) {
        if (!slugEntry.isDirectory()) continue;
        const slug = slugEntry.name;
        if (candidateId(month, slug) === excludeId) continue;
        try {
          const candidate = await this.readCandidate(month, slug);
          if (candidate.meta.reopenedFrom === fromId) return true;
        } catch {
          // 不可读候选不影响唯一性判断。
        }
      }
    }
    return false;
  }

  /**
   * §6.4/§6.5：追加新版本（人工微调 author=human / Rebase author=ai）。
   * 调用方负责隔离工作区与门禁；本方法只落盘新补丁、推进版本、回到 pending 并清空批准。
   */
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
      // §5.5（2026-11-09 修订）：approval 不保存提交哈希；业务提交版本由 Host 从 VCS 历史派生。
      // §4.7：批准留痕——门禁快照、逐条执行结果、判断项确认/知悉记录。
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
    // §7.1：传入共享源时补丁必须与 review.md 来自同一快照，不得读取工作区本地文件。
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

  /**
   * §7.1/§7.7：从**共享快照**读取当前版本补丁。返回值**不含工作区路径**——调用方
   * 没有机会再回头读本地文件（历史缺陷 B2：Rebase 绕过共享源读了工作区补丁）。
   * 这是批准、Rebase、收尾、转换等所有共享流程唯一合法的补丁读取入口。
   */
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

  /** §7.5 步骤 4 / §7.6：批准与收尾必须通过的完整不变量（含 I4/I5/I16 引用目标）。 */
  async validateFullCandidate(candidate: ReviewCandidate, source?: CandidateSource): Promise<string[]> {
    const errors = await this.validateCandidate(candidate);
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) return errors;
    let currentPatchPaths: string[] | null = null;
    try {
      // §7.1：共享流程的完整性校验必须与提交内容来自同一快照。
      const text = source
        ? await source.readPatchText(candidate.month, candidate.slug, current.patch)
        : await readFile(this.patchPathFor(candidate, current.patch), 'utf8');
      currentPatchPaths = text === null ? null : parsePatch(text).paths.filter((file) => !isAiReviewPath(file));
    } catch {
      currentPatchPaths = null;
    }
    const reopenedTargetRejected = candidate.meta.reopenedFrom
      ? await (async (): Promise<((target: string) => boolean | null) | undefined> => {
          try {
            const { month, slug } = this.resolveCandidateDir(candidate.meta.reopenedFrom ?? '');
            const targetCandidate = await this.readCandidate(month, slug);
            const rejected = targetCandidate.meta.status === 'rejected' && targetCandidate.meta.rejection !== null;
            return () => rejected;
          } catch {
            return () => false;
          }
        })()
      : undefined;
    errors.push(...fullReviewInvariants({
      candidate,
      patchExists: (revision) => existsSync(this.patchPathFor(candidate, revision.patch)),
      currentPatchPaths,
      ...(reopenedTargetRejected ? { reopenedTargetRejected } : {}),
    }));
    return errors;
  }

  async listStatusCounts(owner: string): Promise<Record<ReviewStatus, number>> {
    const counts: Record<ReviewStatus, number> = {
      pending: 0,
      changes_requested: 0,
      approved: 0,
      rejected: 0,
    };
    const { items } = await this.list({ owner }, null);
    for (const item of items) counts[item.status] += 1;
    return counts;
  }

  /**
   * List candidate directories without requiring a readable review.md. Used by the
   * auditor to detect what an external agent actually produced, including broken
   * or incomplete packages that `list()` would only surface as errors.
   */
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
