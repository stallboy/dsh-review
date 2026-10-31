import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
import { parsePatch } from './patch.js';
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
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
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
  if (filter.createdAfter && summary.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore && summary.createdAt > filter.createdBefore) return false;
  return true;
}

export class ReviewStore {
  constructor(readonly repoRoot: string) {}

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

  private async readCandidate(month: string, slug: string): Promise<ReviewCandidate> {
    const dir = path.join(this.aiReviewRoot, month, slug);
    const reviewPath = path.join(dir, 'review.md');
    const text = await readFile(reviewPath, 'utf8');
    try {
      const parsed = parseReviewMarkdown(text);
      return {
        id: candidateId(month, slug),
        month,
        slug,
        dirPath: dir,
        reviewPath,
        meta: parsed.meta,
        sections: parseSections(parsed.body),
        humanJudgment: extractHumanJudgment(parseSections(parsed.body).humanJudgment),
      };
    } catch (error) {
      if (!(error instanceof ReviewFormatError)) throw error;
      return this.brokenCandidate(month, slug, dir, reviewPath, error.message);
    }
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
      createdAt: '',
      owner: '',
      tags: [],
      status: 'pending',
      ticket: null,
      currentRevision: 0,
      revisions: [],
      gateChecks: [],
      comments: [],
      approval: null,
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
      parseError: message,
    };
  }

  async list(filter: ReviewFilter, currentBase: string | null): Promise<{ items: CandidateSummary[]; errors: string[] }> {
    const items: CandidateSummary[] = [];
    const errors: string[] = [];
    let months: string[] = [];
    try {
      months = (await readdir(this.aiReviewRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && MONTH_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return { items, errors: ['当前会话仓库中不存在 .ai-review 目录'] };
    }
    months.sort((left, right) => right.localeCompare(left));
    for (const month of months) {
      const monthDir = path.join(this.aiReviewRoot, month);
      let slugs: string[] = [];
      try {
        slugs = (await readdir(monthDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const reviewPath = path.join(monthDir, slug, 'review.md');
        if (!existsSync(reviewPath)) continue;
        try {
          const candidate = await this.readCandidate(month, slug);
          const patchPath = candidate.meta.currentRevision > 0
            ? this.patchPathFor(candidate, candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision)?.patch ?? '')
            : '';
          let stats = EMPTY_STATS;
          const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
          if (candidate.parseError === undefined && patchPath) {
            if (!existsSync(patchPath) && !archived) {
              throw new Error(`当前版本补丁不存在：${path.basename(patchPath)}`);
            }
            if (existsSync(patchPath)) stats = parsePatch(await readFile(patchPath, 'utf8')).stats;
          }
          const summary = this.toSummary(candidate, stats, currentBase);
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
            dirPath: path.join(monthDir, slug),
            patchStats: EMPTY_STATS,
            unresolvedComments: 0,
            humanJudgmentCount: 0,
            isBaseBehind: false,
            baseRevision: '',
            lastFeedback: '',
            parseError: message,
          };
          if (matchesReviewFilter(summary, filter)) items.push(summary);
        }
      }
    }
    items.sort((left, right) => {
      const byDate = right.createdAt.localeCompare(left.createdAt);
      return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });
    return { items, errors };
  }

  private toSummary(candidate: ReviewCandidate, stats: PatchStats, currentBase: string | null): CandidateSummary {
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    const baseRevision = current?.baseRevision ?? '';
    const unresolved = candidate.meta.comments.filter((comment) => comment.status !== 'resolved').length;
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
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
      humanJudgmentCount: candidate.humanJudgment.filter((item) => item.text.trim().length > 0).length,
      isBaseBehind: !archived && currentBase !== null && baseRevision !== '' && baseRevision !== currentBase,
      baseRevision,
      lastFeedback: findLastFeedback(candidate.meta),
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

  async get(id: string, currentBase: string | null): Promise<CandidateDetail> {
    const { month, slug } = this.resolveCandidateDir(id);
    if (!existsSync(path.join(this.aiReviewRoot, month, slug, 'review.md'))) {
      throw new ApiError(404, 'not_found', `候选不存在：${id}`);
    }
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', `review.md 格式错误：${candidate.parseError}`);
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) throw new ApiError(500, 'internal', '当前版本元数据缺失');
    const patchPath = this.patchPathFor(candidate, current.patch);
    const archived = candidate.meta.status === 'approved' || candidate.meta.status === 'rejected';
    if (!existsSync(patchPath) && !archived) {
      throw new ApiError(422, 'bad_request', `当前版本补丁不存在：${current.patch}`);
    }
    const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : '';
    return {
      candidate,
      currentBase,
      isBaseBehind: currentBase !== null && current.baseRevision !== currentBase,
      patchText,
      patchStats: patchText ? parsePatch(patchText).stats : EMPTY_STATS,
    };
  }

  async readPatch(id: string, patchName: string): Promise<string> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    return readFile(this.patchPathFor(candidate, patchName), 'utf8');
  }

  async write(candidate: ReviewCandidate): Promise<void> {
    const text = serializeReviewMarkdown(candidate.meta, candidate.sections.rawBody);
    const temp = `${candidate.reviewPath}.tmp-${String(process.pid)}`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, candidate.reviewPath);
    candidate.sections = parseSections(candidate.sections.rawBody);
    candidate.humanJudgment = extractHumanJudgment(candidate.sections.humanJudgment);
  }

  async ensureWriteAllowed(candidate: ReviewCandidate, guard: ConcurrencyGuard): Promise<void> {
    if (guard.expectedRevision !== candidate.meta.currentRevision || guard.expectedOwner !== candidate.meta.owner) {
      throw new ApiError(409, 'stale', '候选已被其他人更新，请重新加载', {
        currentRevision: candidate.meta.currentRevision,
        currentOwner: candidate.meta.owner,
      });
    }
    if (candidate.meta.status === 'approved' || candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '该候选已归档，不能再修改');
    }
  }

  async addComment(
    id: string,
    author: string,
    input: { content: string; file?: string; line?: number; revision?: number },
    guard: ConcurrencyGuard,
  ): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const content = input.content.trim();
    if (!content) throw new ApiError(400, 'bad_request', '意见内容不能为空');
    const revision = input.revision ?? candidate.meta.currentRevision;
    const file = (input.file ?? '').replaceAll('\\', '/');
    const line = input.line ?? 0;
    const comment: ReviewComment = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      revision,
      file,
      line,
      author,
      content,
      status: 'unresolved',
      createdAt: new Date().toISOString(),
    };
    candidate.meta.comments.push(comment);
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

  async reject(id: string, reason: string, guard: ConcurrencyGuard): Promise<ReviewCandidate> {
    const { month, slug } = this.resolveCandidateDir(id);
    const candidate = await this.readCandidate(month, slug);
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    await this.ensureWriteAllowed(candidate, guard);
    const trimmed = reason.trim();
    if (!trimmed) throw new ApiError(400, 'bad_request', '放弃原因不能为空');
    candidate.meta.status = 'rejected';
    candidate.meta.approval = null;
    candidate.sections.rawBody = appendVersionSection(
      candidate.sections.rawBody,
      candidate.meta.currentRevision,
      candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision)?.baseRevision ?? '',
      `### 放弃\n${trimmed}`,
    );
    await this.write(candidate);
    return candidate;
  }

  async applyApproval(
    candidate: ReviewCandidate,
    approvedBy: string,
    report: ValidationReport,
    commitRevision: string | null,
  ): Promise<void> {
    candidate.meta.status = 'approved';
    candidate.meta.approval = {
      approvedBy,
      approvedAt: new Date().toISOString(),
      commitRevision,
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
    if (!archived && candidate.humanJudgment.every((item) => item.text.trim().length === 0)) {
      errors.push('需人工判断项未填写');
    }
    return errors;
  }

  async currentPatch(candidate: ReviewCandidate): Promise<{ path: string; text: string; baseRevision: string }> {
    const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
    if (!current) throw new ApiError(500, 'internal', '当前版本缺失');
    const patchPath = this.patchPathFor(candidate, current.patch);
    return {
      path: patchPath,
      text: await readFile(patchPath, 'utf8'),
      baseRevision: current.baseRevision,
    };
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
