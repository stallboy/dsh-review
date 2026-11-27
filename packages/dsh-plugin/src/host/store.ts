/**
 * 评审存储层（唯一契约 schema_version: 1）：
 * 管理 .ai-review/ 下的问题记录读写、快照一致性、不变量校验、评论/接管/处置/批准落盘与 8 状态统计。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditFiles } from './audit-files.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from './frontmatter.js';
import { fullReviewInvariants, MONTH_PATTERN, quickReviewInvariants, SLUG_PATTERN, validateSafeBusinessPath } from './invariants.js';
import {
  applyIssueDecision,
  bannedOptionPatches,
  COMMENTABLE_STATUSES,
  formatPatchFilename,
  isDeferred,
  nextUpdatedAt,
  resolveOptionSelection,
  type IssueDecisionRequest,
} from './issue-review.js';
import { entryFromCandidate, findDuplicateRejection, type NegativeMemoryEntry } from './memory.js';
import { extractPatchSymbols, parsePatch } from './patch.js';
import { loadReviewers } from './reviewers.js';
import {
  ApiError,
  REVIEW_STATUSES,
  type ApprovalInfo,
  type CandidateSummary,
  type CommentAnchor,
  type CommentSide,
  type CommentStatus,
  type ConcurrencyGuard,
  type IssueSelection,
  type OptionSummary,
  type PatchEntry,
  type PatchStats,
  type RepairAttempt,
  type RepairOption,
  type ReviewCandidate,
  type ReviewComment,
  type ReviewFilter,
  type ReviewFrontmatter,
  type ReviewStatus,
} from './types.js';

export const EMPTY_STATS: PatchStats = { files: 0, additions: 0, deletions: 0, entries: [] };

export interface CandidateSource {
  listCandidateDirs(): Promise<string[]>;
  listDirEntries(month: string, slug: string): Promise<string[] | null>;
  readReviewText(month: string, slug: string): Promise<string | null>;
  readPatchText(month: string, slug: string, patchName: string): Promise<string | null>;
  readPatchBytes(month: string, slug: string, patchName: string): Promise<Buffer | null>;
  hasLocalChanges?(month: string, slug: string): Promise<boolean>;
  localChangedCandidateIds?(): Promise<Set<string> | null>;
  listLocalOnlyDirs?(): Promise<string[]>;
  listTopLevelReviewEntries?(): Promise<string[]>;
}

export class FilesystemCandidateSource implements CandidateSource {
  constructor(private readonly repoRoot: string) {}

  async listCandidateDirs(): Promise<string[]> {
    const aiRoot = path.join(this.repoRoot, '.ai-review');
    let months: string[];
    try {
      const entries = await readdir(aiRoot, { withFileTypes: true });
      months = entries.filter((e) => e.isDirectory() && MONTH_PATTERN.test(e.name)).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids: string[] = [];
    for (const month of months.sort()) {
      const monthPath = path.join(aiRoot, month);
      const entries = await readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        ids.push(`${month}/${entry.name}`);
      }
    }
    return ids;
  }

  async listTopLevelReviewEntries(): Promise<string[]> {
    try {
      return (await readdir(path.join(this.repoRoot, '.ai-review'))).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    try {
      return await readdir(path.join(this.repoRoot, '.ai-review', month, slug));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readReviewText(month: string, slug: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.repoRoot, '.ai-review', month, slug, 'review.md'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readPatchBytes(month: string, slug: string, patchName: string): Promise<Buffer | null> {
    try {
      return await readFile(path.join(this.repoRoot, '.ai-review', month, slug, patchName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    const bytes = await this.readPatchBytes(month, slug, patchName);
    return bytes === null ? null : bytes.toString('utf8');
  }
}

export interface CandidateDetail {
  candidate: ReviewCandidate;
  /** 仅当问题目录相对共享快照存在未提交改动时为 true（AC-READ-01）。 */
  local?: boolean;
  selection?: IssueSelection;
  option?: RepairOption;
  patchEntry?: PatchEntry;
  currentBase: string | null;
  isBaseBehind: boolean;
  patchText: string;
  patchStats: PatchStats;
  patchPaths: string[];
  comments: ReviewComment[];
  validation: string[];
  revisionStats: Record<string, { patch: string; baseRevision: string; optionId: string; author: 'ai' | 'human'; stats: PatchStats | null }>;
}

export interface ListResult {
  items: CandidateSummary[];
  errors: string[];
  counts: Record<ReviewStatus, number>;
}

export interface AddCommentInput {
  author: string;
  content: string;
  revision?: number;
  optionId?: string;
  patchId?: number;
  file?: string;
  line?: number;
  side?: CommentSide;
  anchor?: CommentAnchor;
}

export interface BusinessBaseCheck {
  (fromBase: string, currentBase: string): Promise<boolean>;
}

export function emptyStatusCounts(): Record<ReviewStatus, number> {
  return {
    pending: 0,
    changes_requested: 0,
    approved: 0,
    rejected: 0,
    repair_failed: 0,
    human_takeover: 0,
    awaiting_verification: 0,
    resolved: 0,
  };
}

function emptyFrontmatter(): ReviewFrontmatter {
  return {
    schemaVersion: 1,
    findingId: '',
    title: '',
    module: '',
    auditType: '',
    issueKind: 'confirm',
    dependsOn: null,
    priority: 'P2',
    baseRevision: '',
    createdAt: '',
    updatedAt: '',
    owner: '',
    tags: [],
    ticket: null,
    status: 'pending',
    targetFiles: [],
    recordRevision: 1,
    patches: [],
    options: [],
    observations: [],
    decisions: [],
    repairAttempts: [],
    comments: [],
    humanDecisions: [],
    approval: null,
    approvalHistory: [],
    rejection: null,
    commitMessage: null,
  };
}

function nextCommentId(comments: readonly ReviewComment[]): string {
  const used = new Set(comments.map((c) => c.id));
  let max = 0;
  for (const comment of comments) {
    const match = /^c(\d+)$/.exec(comment.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = max + 1;
  while (used.has(`c${String(candidate)}`)) candidate += 1;
  return `c${String(candidate)}`;
}

function splitAndValidateId(id: string): [string, string] {
  const normalized = id.replaceAll('\\', '/').trim();
  const parts = normalized.split('/');
  if (parts.length !== 2) throw new ApiError(400, 'bad_request', `问题 id 格式非法（须为 YYYY-MM/slug）：${id}`);
  const [month, slug] = [parts[0] ?? '', parts[1] ?? ''];
  if (!MONTH_PATTERN.test(month) || !SLUG_PATTERN.test(slug)) {
    throw new ApiError(400, 'bad_request', `问题 id 格式非法（slug 必须小写 ASCII）：${id}`);
  }
  return [month, slug];
}

export class ReviewStore {
  readonly reviewRoot: string;

  constructor(readonly repoRoot: string) {
    this.reviewRoot = path.join(repoRoot, '.ai-review');
  }

  private fsSource(): FilesystemCandidateSource {
    return new FilesystemCandidateSource(this.repoRoot);
  }

  dirOf(month: string, slug: string): string {
    return path.join(this.reviewRoot, month, slug);
  }

  reviewFileOf(month: string, slug: string): string {
    return path.join(this.dirOf(month, slug), 'review.md');
  }

  async listCandidateIds(source?: CandidateSource): Promise<string[]> {
    const activeSource = source ?? this.fsSource();
    return (await activeSource.listCandidateDirs()).sort();
  }

  async readPatchBytes(month: string, slug: string, patchName: string, source?: CandidateSource): Promise<Buffer | null> {
    const activeSource = source ?? this.fsSource();
    return activeSource.readPatchBytes(month, slug, patchName);
  }

  async readPatch(id: string, name: string, source?: CandidateSource): Promise<string> {
    const [month, slug] = splitAndValidateId(id);
    if (!/^\d{3,}\.patch$/.test(name)) {
      throw new ApiError(400, 'bad_request', `非法补丁文件名：${name}`);
    }
    const candidate = await this.loadCandidate(month, slug, source);
    if (!candidate) throw new ApiError(404, 'not_found', `问题不存在：${id}`);
    if (candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${candidate.parseError}`);
    if (!candidate.meta.patches.some((entry) => entry.patch === name)) {
      throw new ApiError(404, 'not_found', `补丁 ${name} 不在问题 ${id} 的 patches 账本中`);
    }
    const text = await (source ?? this.fsSource()).readPatchText(month, slug, name);
    if (text === null) throw new ApiError(404, 'not_found', `补丁文件缺失：${name}`);
    return text;
  }

  async loadCandidate(month: string, slug: string, source?: CandidateSource): Promise<ReviewCandidate | null> {
    const activeSource = source ?? this.fsSource();
    const id = `${month}/${slug}`;
    const dirPath = this.dirOf(month, slug);
    const reviewPath = this.reviewFileOf(month, slug);
    const text = await activeSource.readReviewText(month, slug);
    if (text === null) return null;
    try {
      const parsed = parseReviewMarkdown(text);
      const quickErrors = quickReviewInvariants({ id, month, slug, meta: parsed.meta });
      return {
        id,
        month,
        slug,
        dirPath,
        reviewPath,
        meta: parsed.meta,
        body: parsed.body,
        sections: parsed.sections,
        humanJudgment: parsed.humanJudgment,
        humanJudgmentDeclared: parsed.humanJudgmentDeclared,
        ...(quickErrors.length > 0 ? { parseError: quickErrors.join('；') } : {}),
      };
    } catch (error) {
      return {
        id,
        month,
        slug,
        dirPath,
        reviewPath,
        meta: emptyFrontmatter(),
        body: '',
        sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '' },
        humanJudgment: [],
        humanJudgmentDeclared: false,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async validateFullCandidate(candidate: ReviewCandidate, source?: CandidateSource): Promise<string[]> {
    if (candidate.parseError) return [candidate.parseError];
    const activeSource = source ?? this.fsSource();
    const entries = await activeSource.listDirEntries(candidate.month, candidate.slug);
    if (entries === null) return [`问题目录不存在：${candidate.id}`];
    const errors = await fullReviewInvariants({
      id: candidate.id,
      month: candidate.month,
      slug: candidate.slug,
      meta: candidate.meta,
      patchFilesOnDisk: entries,
      readPatchBytes: (patchName) => this.readPatchBytes(candidate.month, candidate.slug, patchName, activeSource),
    });
    if (!candidate.humanJudgmentDeclared) {
      errors.push('需人工判断项未填写');
    }
    return errors;
  }

  /** 读取共享快照中的全部合法问题记录（用于跨问题校验、负向记忆、KPI 统计与 /findings 投影；排除有本地未提交改动与补丁不完整的 broken 候选，遵循 AC-READ-01 / SPEC §5.1）。 */
  async listSharedCandidates(source?: CandidateSource): Promise<{ candidates: ReviewCandidate[]; errors: string[] }> {
    const activeSource: CandidateSource = source ?? this.fsSource();
    const ids = await this.listCandidateIds(activeSource);
    const localChanged = activeSource.localChangedCandidateIds ? await activeSource.localChangedCandidateIds() : null;
    const candidates: ReviewCandidate[] = [];
    const errors: string[] = [];
    const findingIdMap = new Map<string, string[]>();

    for (const id of ids) {
      const [month, slug] = id.split('/');
      if (!month || !slug) continue;
      if (localChanged?.has(id)) continue;
      if (!localChanged && activeSource.hasLocalChanges && await activeSource.hasLocalChanges(month, slug)) continue;
      const candidate = await this.loadCandidate(month, slug, activeSource);
      if (!candidate) continue;
      if (!candidate.parseError) {
        const fullErrors = await this.validateFullCandidate(candidate, activeSource);
        if (fullErrors.length > 0) {
          candidate.parseError = fullErrors.join('；');
        }
      }
      if (!candidate.parseError && candidate.meta.findingId) {
        const list = findingIdMap.get(candidate.meta.findingId) ?? [];
        list.push(id);
        findingIdMap.set(candidate.meta.findingId, list);
      }
      candidates.push(candidate);
    }

    for (const [findingId, dupIds] of findingIdMap) {
      if (dupIds.length > 1) {
        const message = `重复的 finding_id（${findingId}）出现在多个问题目录：${dupIds.join(', ')}`;
        errors.push(message);
        for (const candidate of candidates) {
          if (dupIds.includes(candidate.id)) {
            candidate.parseError = candidate.parseError ? `${candidate.parseError}；${message}` : message;
          }
        }
      }
    }

    return { candidates, errors };
  }

  /** AC-READ-01 / §3.1：检测 .ai-review/ 下非规范目录或开发期遗留文件（如 findings/），仅诊断不阻断合法问题。 */
  async nonCanonicalReviewEntries(source?: CandidateSource): Promise<string[]> {
    const activeSource = source ?? this.fsSource();
    const entries = activeSource.listTopLevelReviewEntries
      ? await activeSource.listTopLevelReviewEntries()
      : await this.fsSource().listTopLevelReviewEntries();
    const diagnostics: string[] = [];
    for (const name of entries) {
      if (name === 'reviewers.yml' || name === 'audits' || MONTH_PATTERN.test(name)) continue;
      diagnostics.push(`检测到非规范或遗留评审目录/文件 .ai-review/${name}，不参与当前共享流程，请手动清理。`);
    }
    return diagnostics;
  }

  async list(
    filter: ReviewFilter,
    currentBase: string | null,
    isBehind?: BusinessBaseCheck,
    nowMs: number = Date.now(),
    source?: CandidateSource,
    reviewersSource?: { readReviewersText(): Promise<string | null> },
  ): Promise<ListResult> {
    const activeSource: CandidateSource = source ?? this.fsSource();
    const errors: string[] = await this.nonCanonicalReviewEntries(activeSource);
    const sharedIds = await this.listCandidateIds(activeSource);
    const sharedSet = new Set(sharedIds);
    const localChanged = activeSource.localChangedCandidateIds ? await activeSource.localChangedCandidateIds() : null;
    const localOnlyDirs = activeSource.listLocalOnlyDirs
      ? (await activeSource.listLocalOnlyDirs()).filter((id: string) => !sharedSet.has(id))
      : [];

    const reviewers = await loadReviewers(this.repoRoot, reviewersSource).catch(() => null);
    const staleDays = reviewers?.staleDays ?? 14;
    const rejectionWindowDays = reviewers?.rejectionMemoryDays ?? 30;
    const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;

    // 加载全部共享候选，用于 I1 finding_id 唯一性校验与负向记忆重复计算
    const loadedShared: Array<{ candidate: ReviewCandidate; local: boolean }> = [];
    const findingIdMap = new Map<string, string[]>();

    for (const id of sharedIds) {
      const [month, slug] = id.split('/');
      if (!month || !slug) continue;
      let isLocal = false;
      if (localChanged !== null) {
        isLocal = localChanged.has(id);
      } else if (activeSource.hasLocalChanges) {
        isLocal = await activeSource.hasLocalChanges(month, slug).catch(() => true);
      }
      const candidate = await this.loadCandidate(month, slug, activeSource);
      if (!candidate) continue;
      if (!candidate.parseError) {
        const fullErrors = await this.validateFullCandidate(candidate, activeSource);
        if (fullErrors.length > 0) {
          candidate.parseError = fullErrors.join('；');
        }
      }
      if (candidate.parseError) {
        errors.push(`${candidate.id}: ${candidate.parseError}`);
      } else if (!isLocal && candidate.meta.findingId) {
        const list = findingIdMap.get(candidate.meta.findingId) ?? [];
        list.push(id);
        findingIdMap.set(candidate.meta.findingId, list);
      }
      loadedShared.push({ candidate, local: isLocal });
    }

    for (const [findingId, dupIds] of findingIdMap) {
      if (dupIds.length > 1) {
        const message = `重复的 finding_id（${findingId}）出现在多个问题目录：${dupIds.join(', ')}`;
        errors.push(message);
        for (const item of loadedShared) {
          if (dupIds.includes(item.candidate.id)) {
            item.candidate.parseError = item.candidate.parseError ? `${item.candidate.parseError}；${message}` : message;
          }
        }
      }
    }

    const cleanSharedCandidates = loadedShared
      .filter((entry) => !entry.local && !entry.candidate.parseError)
      .map((entry) => entry.candidate);

    const counts = emptyStatusCounts();
    for (const candidate of cleanSharedCandidates) {
      if (filter.owner && candidate.meta.owner !== filter.owner) continue;
      if (REVIEW_STATUSES.includes(candidate.meta.status)) {
        counts[candidate.meta.status] += 1;
      }
    }

    const summaries: CandidateSummary[] = [];

    const toSummary = async (
      candidate: ReviewCandidate,
      summarySource: CandidateSource,
      flags: { local?: boolean; localOnly?: boolean },
    ): Promise<CandidateSummary> => {
      const meta = candidate.meta;
      if (candidate.parseError) {
        return {
          id: candidate.id,
          findingId: meta.findingId,
          title: meta.title || candidate.id,
          module: meta.module,
          auditType: meta.auditType,
          issueKind: meta.issueKind,
          dependsOn: meta.dependsOn,
          priority: meta.priority,
          owner: meta.owner,
          status: 'broken',
          tags: meta.tags,
          ticket: meta.ticket,
          currentRevision: meta.recordRevision,
          recordRevision: meta.recordRevision,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          baseRevision: meta.baseRevision,
          patchStats: EMPTY_STATS,
          unresolvedComments: 0,
          humanJudgmentCount: 0,
          humanJudgmentDeclared: candidate.humanJudgmentDeclared,
          isBaseBehind: false,
          lastFeedback: '',
          deferred: false,
          options: [],
          parseError: candidate.parseError,
          ...flags,
        };
      }

      const banned = bannedOptionPatches(meta);
      const optionSummaries: OptionSummary[] = [];
      let primaryStats: PatchStats = EMPTY_STATS;
      let primaryBase = meta.baseRevision;

      for (let i = 0; i < meta.options.length; i += 1) {
        const option = meta.options[i]!;
        const patchEntry = meta.patches.find((p) => p.id === option.currentPatch);
        const patchText = patchEntry
          ? await summarySource.readPatchText(candidate.month, candidate.slug, patchEntry.patch)
          : null;
        const stats = patchText !== null ? parsePatch(patchText).stats : EMPTY_STATS;
        if (i === 0) {
          primaryStats = stats;
          if (patchEntry?.baseRevision) primaryBase = patchEntry.baseRevision;
        }
        optionSummaries.push({
          id: option.id,
          title: option.title,
          tradeoff: option.tradeoff,
          confidence: option.confidence,
          currentPatch: option.currentPatch,
          banned: banned.has(`${option.id}#${String(option.currentPatch)}`),
          patchStats: stats,
        });
      }

      let behind = false;
      if (currentBase && primaryBase && primaryBase !== currentBase) {
        behind = isBehind ? await isBehind(primaryBase, currentBase) : true;
      }

      const unresolvedComments = meta.comments.filter((c) => c.status !== 'resolved').length;
      const lastComment = meta.comments[meta.comments.length - 1];
      const lastFeedback = lastComment ? `${lastComment.author}: ${lastComment.content.slice(0, 80)}` : '';
      const updatedMs = Date.parse(meta.updatedAt);
      const isActiveOpen = ['pending', 'changes_requested', 'repair_failed'].includes(meta.status);
      const isStale = !flags.local && isActiveOpen && Number.isFinite(updatedMs) && (nowMs - updatedMs) > staleThresholdMs;

      let duplicateOf: string | undefined;
      if (!flags.local && isActiveOpen) {
        const dup = findDuplicateRejection(candidate, cleanSharedCandidates, rejectionWindowDays, nowMs);
        if (dup) duplicateOf = dup.candidateId;
      }

      return {
        id: candidate.id,
        findingId: meta.findingId,
        title: meta.title,
        module: meta.module,
        auditType: meta.auditType,
        issueKind: meta.issueKind,
        dependsOn: meta.dependsOn,
        priority: meta.priority,
        owner: meta.owner,
        status: meta.status,
        tags: [...meta.tags],
        targetFiles: [...meta.targetFiles],
        ticket: meta.ticket,
        currentRevision: meta.recordRevision,
        recordRevision: meta.recordRevision,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        baseRevision: primaryBase,
        patchStats: primaryStats,
        unresolvedComments,
        humanJudgmentCount: meta.humanDecisions.length,
        humanJudgmentDeclared: candidate.humanJudgmentDeclared,
        isBaseBehind: behind,
        lastFeedback,
        deferred: isDeferred(meta),
        options: optionSummaries,
        ...(isStale ? { isStale: true } : {}),
        ...(duplicateOf ? { duplicateOf } : {}),
        ...flags,
      };
    };

    for (const { candidate, local } of loadedShared) {
      summaries.push(await toSummary(candidate, activeSource, local ? { local: true } : {}));
    }

    const fsSrc = this.fsSource();
    for (const id of localOnlyDirs) {
      const [month, slug] = id.split('/');
      if (!month || !slug) continue;
      const candidate = await this.loadCandidate(month, slug, fsSrc);
      if (!candidate) continue;
      summaries.push(await toSummary(candidate, fsSrc, { local: true, localOnly: true }));
    }

    const filtered = summaries.filter((item) => matchesFilter(item, filter));
    filtered.sort((left, right) => {
      const lMs = Date.parse(left.updatedAt) || 0;
      const rMs = Date.parse(right.updatedAt) || 0;
      return rMs - lMs || left.id.localeCompare(right.id);
    });

    return { items: filtered, errors, counts };
  }

  /** SPEC §6.2：counts 必须包含全部 8 个规范状态键，仅统计非 local 共享问题。 */
  async listStatusCounts(
    owner: string | undefined,
    source?: CandidateSource,
  ): Promise<Record<ReviewStatus, number>> {
    const counts = emptyStatusCounts();
    const activeSource = source ?? this.fsSource();
    const { candidates } = await this.listSharedCandidates(activeSource);
    for (const candidate of candidates) {
      if (candidate.parseError) continue;
      if (owner && candidate.meta.owner !== owner) continue;
      if (REVIEW_STATUSES.includes(candidate.meta.status)) {
        counts[candidate.meta.status] += 1;
      }
    }
    return counts;
  }

  /** AC-READ-01 / I1：校验目标问题记录处于合法、非 local 且全仓 finding_id 唯一的共享可写状态。 */
  assertWritableSharedCandidate(detail: CandidateDetail): void {
    if (detail.candidate.parseError) {
      throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
    }
    if (detail.local) {
      throw new ApiError(409, 'conflict', `问题目录 ${detail.candidate.id} 存在未提交本地改动（local 视图），请先提交或清理本地改动后再写入`);
    }
  }

  /** 检测目标问题是否与仓库中其他共享问题共用同一 finding_id（I1）。 */
  private async findDuplicateFindingIdDirs(id: string, findingId: string, activeSource: CandidateSource): Promise<string[]> {
    if (!findingId) return [];
    const allIds = await this.listCandidateIds(activeSource);
    const localChanged = activeSource.localChangedCandidateIds ? await activeSource.localChangedCandidateIds() : null;
    const duplicates: string[] = [];
    for (const otherId of allIds) {
      if (otherId === id) continue;
      if (localChanged?.has(otherId)) continue;
      const [otherMonth, otherSlug] = otherId.split('/');
      if (!otherMonth || !otherSlug) continue;
      if (!localChanged && activeSource.hasLocalChanges && await activeSource.hasLocalChanges(otherMonth, otherSlug).catch(() => true)) {
        continue;
      }
      const other = await this.loadCandidate(otherMonth, otherSlug, activeSource);
      if (other && !other.parseError && other.meta.findingId === findingId) {
        duplicates.push(otherId);
      }
    }
    return duplicates;
  }

  async get(
    id: string,
    currentBase: string | null,
    source?: CandidateSource,
    isBehind?: BusinessBaseCheck,
    requestedSelection?: { optionId?: string; patchId?: number },
  ): Promise<CandidateDetail> {
    const [month, slug] = splitAndValidateId(id);
    const activeSource: CandidateSource = source ?? this.fsSource();
    const candidate = await this.loadCandidate(month, slug, activeSource);
    if (!candidate) throw new ApiError(404, 'not_found', `问题不存在：${id}`);

    const isLocal = activeSource.hasLocalChanges
      ? await activeSource.hasLocalChanges(month, slug).catch(() => true)
      : false;
    const validation = await this.validateFullCandidate(candidate, activeSource);
    if (!candidate.parseError && !isLocal && candidate.meta.findingId && source) {
      const dupDirs = await this.findDuplicateFindingIdDirs(candidate.id, candidate.meta.findingId, activeSource);
      if (dupDirs.length > 0) {
        validation.push(`重复的 finding_id（${candidate.meta.findingId}）同时存在于：${dupDirs.join(', ')}`);
      }
    }
    if (!candidate.parseError && validation.length > 0) {
      candidate.parseError = validation.join('；');
    }
    const meta = candidate.meta;

    let selection: IssueSelection | undefined;
    let option: RepairOption | undefined;
    let patchEntry: PatchEntry | undefined;
    let patchText = '';
    let patchStats: PatchStats = EMPTY_STATS;
    let patchPaths: string[] = [];

    if (!candidate.parseError) {
      const resolved = resolveOptionSelection(meta, requestedSelection);
      if (resolved) {
        selection = resolved.selection;
        option = resolved.option;
        patchEntry = resolved.patch;
        const text = await activeSource.readPatchText(month, slug, patchEntry.patch);
        if (text !== null) {
          patchText = text;
          const parsed = parsePatch(text);
          patchStats = parsed.stats;
          patchPaths = parsed.paths;
        }
      }
    }

    const revisionStats: CandidateDetail['revisionStats'] = {};
    for (const entry of meta.patches) {
      const text = await activeSource.readPatchText(month, slug, entry.patch);
      revisionStats[String(entry.id)] = {
        patch: entry.patch,
        baseRevision: entry.baseRevision,
        optionId: entry.optionId,
        author: entry.author,
        stats: text !== null ? parsePatch(text).stats : null,
      };
    }

    const activeBase = patchEntry?.baseRevision || meta.baseRevision;
    let isBaseBehind = false;
    if (currentBase && activeBase && activeBase !== currentBase) {
      isBaseBehind = isBehind ? await isBehind(activeBase, currentBase) : true;
    }

    return {
      candidate,
      ...(isLocal ? { local: true } : {}),
      ...(selection ? { selection } : {}),
      ...(option ? { option } : {}),
      ...(patchEntry ? { patchEntry } : {}),
      currentBase,
      isBaseBehind,
      patchText,
      patchStats,
      patchPaths,
      comments: [...meta.comments],
      validation,
      revisionStats,
    };
  }

  checkGuard(meta: ReviewFrontmatter, guard: ConcurrencyGuard): void {
    const expectedMs = Date.parse(guard.expectedUpdatedAt);
    const actualMs = Date.parse(meta.updatedAt);
    const timestampMatch = Number.isFinite(expectedMs) && Number.isFinite(actualMs)
      ? expectedMs === actualMs
      : guard.expectedUpdatedAt === meta.updatedAt;
    if (
      meta.recordRevision !== guard.expectedRevision
      || meta.owner !== guard.expectedOwner
      || !timestampMatch
    ) {
      throw new ApiError(409, 'stale', '问题已被并发修改，请刷新后重试', {
        currentRevision: meta.recordRevision,
        currentOwner: meta.owner,
        currentUpdatedAt: meta.updatedAt,
      });
    }
  }

  async write(candidate: ReviewCandidate, options: { touchUpdatedAt?: boolean; now?: Date } = {}): Promise<ReviewCandidate> {
    const touch = options.touchUpdatedAt ?? true;
    const now = options.now ?? new Date();
    const updatedMeta: ReviewFrontmatter = touch
      ? { ...candidate.meta, updatedAt: nextUpdatedAt(candidate.meta.updatedAt, now) }
      : candidate.meta;
    const serialized = serializeReviewMarkdown(updatedMeta, candidate.body);
    await auditFiles(this.repoRoot, {
      op: 'write',
      paths: [`.ai-review/${candidate.id}/review.md`],
      text: serialized,
    });
    const parsed = parseReviewMarkdown(serialized);
    return {
      ...candidate,
      meta: parsed.meta,
      body: parsed.body,
      sections: parsed.sections,
      humanJudgment: parsed.humanJudgment,
      humanJudgmentDeclared: parsed.humanJudgmentDeclared,
    };
  }

  private buildCommentEntry(
    meta: ReviewFrontmatter,
    input: AddCommentInput,
    existingComments: readonly ReviewComment[],
    at: string,
  ): ReviewComment {
    const content = input.content.trim();
    if (!content) throw new ApiError(422, 'bad_request', '评论内容不能为空');
    const author = input.author.trim();
    if (!author) throw new ApiError(422, 'bad_request', '评论作者不能为空');

    // SPEC §3.3 / §6.3：revision 缺省取提交前当前共享 record_revision；显式传入须在 1..record_revision 内。
    const revision = input.revision === undefined ? meta.recordRevision : input.revision;
    if (!Number.isInteger(revision) || revision < 1 || revision > meta.recordRevision) {
      throw new ApiError(422, 'bad_request', `评论 revision 越界（须在 1..${String(meta.recordRevision)} 之间）`);
    }

    const file = (input.file ?? '').trim();
    const line = input.line ?? 0;
    const isGeneral = file === '' && line === 0;
    const id = nextCommentId(existingComments);

    if (isGeneral) {
      if (input.side !== undefined || input.anchor !== undefined || input.optionId !== undefined || input.patchId !== undefined) {
        throw new ApiError(422, 'bad_request', '总体评论不得携带 side / anchor / optionId / patchId');
      }
      return {
        id,
        revision,
        file: '',
        line: 0,
        author,
        content,
        status: 'unresolved',
        createdAt: at,
      };
    }

    if (!file || !Number.isInteger(line) || line < 1) {
      throw new ApiError(422, 'bad_request', '行内评论必须提供非空 file 与正整数 line');
    }
    const pathErrors: string[] = [];
    if (!validateSafeBusinessPath(file, 'file', pathErrors)) {
      throw new ApiError(422, 'bad_request', pathErrors[0] ?? `行内评论 file 路径非法：${file}`);
    }
    if (input.side !== 'LEFT' && input.side !== 'RIGHT') {
      throw new ApiError(422, 'bad_request', '行内评论必须提供合法 side（LEFT 或 RIGHT）');
    }
    if (!input.optionId || typeof input.patchId !== 'number' || !Number.isInteger(input.patchId) || input.patchId < 1) {
      throw new ApiError(422, 'bad_request', '行内评论必须显式指定 optionId 与 patchId');
    }
    const patch = meta.patches.find((p) => p.id === input.patchId && p.optionId === input.optionId);
    if (!patch) {
      throw new ApiError(422, 'bad_request', `行内评论指向的方案/补丁不存在或归属不匹配（${input.optionId} / #${String(input.patchId)}）`);
    }
    if (input.anchor && !input.anchor.snippet.trim()) {
      throw new ApiError(422, 'bad_request', 'anchor.snippet 不能为空');
    }
    return {
      id,
      revision,
      optionId: input.optionId,
      patchId: input.patchId,
      file,
      line,
      side: input.side,
      author,
      content,
      status: 'unresolved',
      createdAt: at,
      ...(input.anchor ? { anchor: input.anchor } : {}),
    };
  }

  async addCommentsBatch(
    id: string,
    guard: ConcurrencyGuard,
    inputs: readonly AddCommentInput[],
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<{ candidate: ReviewCandidate; added: ReviewComment[] }> {
    if (inputs.length === 0) throw new ApiError(400, 'bad_request', '评论列表不能为空');
    const detail = await this.get(id, null, source);
    this.assertWritableSharedCandidate(detail);
    const meta = detail.candidate.meta;
    this.checkGuard(meta, guard);

    if (!COMMENTABLE_STATUSES.has(meta.status)) {
      throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许提交评论`);
    }

    const at = nextUpdatedAt(meta.updatedAt, now);
    const allComments = [...meta.comments];
    const added: ReviewComment[] = [];
    for (const input of inputs) {
      const comment = this.buildCommentEntry(meta, input, allComments, at);
      allComments.push(comment);
      added.push(comment);
    }

    // SPEC §4.1：pending 新增未解决评论变 changes_requested；repair_failed 保持 repair_failed！
    const nextStatus: ReviewStatus = meta.status === 'pending' ? 'changes_requested' : meta.status;
    const nextMeta: ReviewFrontmatter = {
      ...meta,
      status: nextStatus,
      recordRevision: meta.recordRevision + 1,
      updatedAt: at,
      comments: allComments,
    };

    const updated = await this.write({ ...detail.candidate, meta: nextMeta }, { touchUpdatedAt: false });
    return { candidate: updated, added };
  }

  async addComment(
    id: string,
    guard: ConcurrencyGuard,
    input: AddCommentInput,
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<{ candidate: ReviewCandidate; comment: ReviewComment }> {
    const { candidate, added } = await this.addCommentsBatch(id, guard, [input], source, now);
    return { candidate, comment: added[0]! };
  }

  async setCommentStatus(
    id: string,
    guard: ConcurrencyGuard,
    commentId: string,
    status: CommentStatus,
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<ReviewCandidate> {
    const detail = await this.get(id, null, source);
    this.assertWritableSharedCandidate(detail);
    const meta = detail.candidate.meta;
    this.checkGuard(meta, guard);
    if (!COMMENTABLE_STATUSES.has(meta.status)) {
      throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许修改评论状态`);
    }
    const index = meta.comments.findIndex((c) => c.id === commentId);
    if (index < 0) throw new ApiError(404, 'not_found', `评论不存在：${commentId}`);
    const nextComments = meta.comments.map((c, idx) => (idx === index ? { ...c, status } : c));
    const at = nextUpdatedAt(meta.updatedAt, now);
    const nextMeta: ReviewFrontmatter = {
      ...meta,
      recordRevision: meta.recordRevision + 1,
      updatedAt: at,
      comments: nextComments,
    };
    return this.write({ ...detail.candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  async takeover(
    id: string,
    guard: ConcurrencyGuard,
    newOwner: string,
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<ReviewCandidate> {
    const owner = newOwner.trim();
    if (!owner) throw new ApiError(422, 'bad_request', '目标负责人不能为空');
    const detail = await this.get(id, null, source);
    this.assertWritableSharedCandidate(detail);
    const meta = detail.candidate.meta;
    this.checkGuard(meta, guard);
    if (meta.status === 'approved' || meta.status === 'resolved') {
      throw new ApiError(409, 'conflict', `已关闭状态（${meta.status}）不允许接管`);
    }
    const at = nextUpdatedAt(meta.updatedAt, now);
    const nextMeta: ReviewFrontmatter = {
      ...meta,
      owner,
      recordRevision: meta.recordRevision + 1,
      updatedAt: at,
    };
    return this.write({ ...detail.candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  /** SPEC §4.1：/resume 仅用于 Owner 将 changes_requested 转回 pending，不得用于 repair_failed。 */
  async resume(
    id: string,
    guard: ConcurrencyGuard,
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<ReviewCandidate> {
    const detail = await this.get(id, null, source);
    this.assertWritableSharedCandidate(detail);
    const meta = detail.candidate.meta;
    this.checkGuard(meta, guard);
    if (meta.status !== 'changes_requested') {
      throw new ApiError(409, 'conflict', `/resume 仅适用于 changes_requested 状态（当前为 ${meta.status}）`);
    }
    const at = nextUpdatedAt(meta.updatedAt, now);
    const nextMeta: ReviewFrontmatter = {
      ...meta,
      status: 'pending',
      recordRevision: meta.recordRevision + 1,
      updatedAt: at,
    };
    return this.write({ ...detail.candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  async applyDecision(
    id: string,
    guard: ConcurrencyGuard,
    request: IssueDecisionRequest,
    actor: string,
    source?: CandidateSource,
    now: Date = new Date(),
  ): Promise<ReviewCandidate> {
    const detail = await this.get(id, null, source);
    this.assertWritableSharedCandidate(detail);
    const meta = detail.candidate.meta;
    this.checkGuard(meta, guard);

    let relatedSymbols: string[] | undefined;
    if (request.action === 'accept_as_is' && meta.options.length > 0) {
      const activeSource = source ?? this.fsSource();
      const patchTexts: string[] = [];
      for (const option of meta.options) {
        const patchEntry = meta.patches.find((p) => p.id === option.currentPatch);
        if (!patchEntry) continue;
        const text = await activeSource.readPatchText(detail.candidate.month, detail.candidate.slug, patchEntry.patch);
        if (text) patchTexts.push(text);
      }
      relatedSymbols = extractPatchSymbols(patchTexts);
    }

    const nextMeta = applyIssueDecision(meta, request, actor, now, relatedSymbols);
    return this.write({ ...detail.candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  async applyApproval(
    candidate: ReviewCandidate,
    input: {
      approval: ApprovalInfo;
      attempt: RepairAttempt;
      commitMessage: string;
      now?: Date;
    },
  ): Promise<ReviewCandidate> {
    const at = nextUpdatedAt(candidate.meta.updatedAt, input.now ?? new Date());
    const nextMeta: ReviewFrontmatter = {
      ...candidate.meta,
      status: 'approved',
      recordRevision: candidate.meta.recordRevision + 1,
      updatedAt: at,
      repairAttempts: [...candidate.meta.repairAttempts, input.attempt],
      approval: input.approval,
      rejection: null,
      commitMessage: input.commitMessage,
    };
    return this.write({ ...candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  async recordRepairFailure(
    candidate: ReviewCandidate,
    attempt: RepairAttempt,
    now: Date = new Date(),
  ): Promise<ReviewCandidate> {
    const at = nextUpdatedAt(candidate.meta.updatedAt, now);
    const nextMeta: ReviewFrontmatter = {
      ...candidate.meta,
      status: 'repair_failed',
      recordRevision: candidate.meta.recordRevision + 1,
      updatedAt: at,
      repairAttempts: [...candidate.meta.repairAttempts, attempt],
    };
    return this.write({ ...candidate, meta: nextMeta }, { touchUpdatedAt: false });
  }

  async findDuplicateForCandidate(
    candidate: ReviewCandidate,
    source?: CandidateSource,
    reviewersSource?: { readReviewersText(): Promise<string | null> },
    nowMs: number = Date.now(),
  ): Promise<NegativeMemoryEntry | null> {
    const reviewers = await loadReviewers(this.repoRoot, reviewersSource).catch(() => null);
    const windowDays = reviewers?.rejectionMemoryDays ?? 30;
    const { candidates } = await this.listSharedCandidates(source);
    return findDuplicateRejection(candidate, candidates, windowDays, nowMs);
  }

  async negativeMemoryEntries(
    source?: CandidateSource,
    reviewersSource?: { readReviewersText(): Promise<string | null> },
    nowMs: number = Date.now(),
  ): Promise<{ entries: NegativeMemoryEntry[]; windowDays: number; maxAntiPatterns: number }> {
    const reviewers = await loadReviewers(this.repoRoot, reviewersSource).catch(() => null);
    const windowDays = reviewers?.rejectionMemoryDays ?? 30;
    const maxAntiPatterns = reviewers?.maxAntiPatterns ?? 20;
    const { candidates } = await this.listSharedCandidates(source);
    const entries: NegativeMemoryEntry[] = [];
    for (const candidate of candidates) {
      if (candidate.parseError) continue;
      const entry = entryFromCandidate({ candidateId: candidate.id, meta: candidate.meta });
      if (entry && (nowMs - entry.rejectedAtMs) <= windowDays * 24 * 60 * 60 * 1000) {
        entries.push(entry);
      }
    }
    return { entries, windowDays, maxAntiPatterns };
  }

  /** 为新补丁分配递增编号与文件名。 */
  nextPatchNumber(meta: ReviewFrontmatter): { id: number; patch: string } {
    const id = meta.patches.length + 1;
    return { id, patch: formatPatchFilename(id) };
  }
}

function matchesFilter(item: CandidateSummary, filter: ReviewFilter): boolean {
  if (filter.owner !== undefined && filter.owner !== '' && item.owner !== filter.owner) return false;
  if (filter.statuses && filter.statuses.length > 0 && item.status !== 'broken' && !filter.statuses.includes(item.status)) {
    return false;
  }
  if (filter.tag) {
    const wanted = filter.tag.trim().toLowerCase();
    if (!item.tags.includes(wanted)) return false;
  }
  if (filter.dir) {
    const prefix = filter.dir.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const matchPath = (filePath: string): boolean => filePath === prefix || filePath.startsWith(`${prefix}/`);
    const touched = item.patchStats.entries.some((e) => matchPath(e.path))
      || (item.targetFiles?.some(matchPath) ?? false)
      || item.options.some((opt) => opt.patchStats.entries.some((e) => matchPath(e.path)));
    if (!touched && item.module !== prefix) return false;
  }
  if (filter.text) {
    const needle = filter.text.trim().toLowerCase();
    const haystack = `${item.id} ${item.findingId} ${item.title} ${item.module} ${item.owner} ${item.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filter.createdAfter) {
    const afterMs = Date.parse(filter.createdAfter);
    const createdMs = Date.parse(item.createdAt);
    if (Number.isFinite(afterMs) && Number.isFinite(createdMs) && createdMs < afterMs) return false;
  }
  if (filter.createdBefore) {
    const beforeMs = Date.parse(filter.createdBefore);
    const createdMs = Date.parse(item.createdAt);
    if (Number.isFinite(beforeMs) && Number.isFinite(createdMs) && createdMs > beforeMs) return false;
  }
  return true;
}
