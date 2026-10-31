import { load, dump } from './yaml.js';
import type {
  ApprovalMeta,
  CommentStatus,
  HumanJudgmentItem,
  ReviewComment,
  ReviewFrontmatter,
  ReviewSections,
  ReviewStatus,
  RevisionEntry,
} from './types.js';

const STATUSES: ReviewStatus[] = ['pending', 'changes_requested', 'approved', 'rejected'];
const COMMENT_STATUSES: CommentStatus[] = ['unresolved', 'partial', 'resolved'];

export class ReviewFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewFormatError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, fallback?: string): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    return '';
  }
  throw new ReviewFormatError(`${field} 必须是字符串`);
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new ReviewFormatError(`${field} 必须是字符串或 null`);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ReviewFormatError(`${field} 必须是数字`);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseRevision(value: unknown, index: number): RevisionEntry {
  if (!isRecord(value)) throw new ReviewFormatError(`revisions[${String(index)}] 必须是对象`);
  return {
    id: asNumber(value['id'], `revisions[${String(index)}].id`),
    baseRevision: asString(value['base_revision'], `revisions[${String(index)}].base_revision`),
    patch: asString(value['patch'], `revisions[${String(index)}].patch`),
  };
}

function parseComment(value: unknown, index: number): ReviewComment {
  if (!isRecord(value)) throw new ReviewFormatError(`comments[${String(index)}] 必须是对象`);
  const status = asString(value['status'], `comments[${String(index)}].status`, 'unresolved');
  if (!COMMENT_STATUSES.includes(status as CommentStatus)) {
    throw new ReviewFormatError(`comments[${String(index)}].status 只能是 ${COMMENT_STATUSES.join(' | ')}`);
  }
  const comment: ReviewComment = {
    id: asString(value['id'], `comments[${String(index)}].id`),
    revision: asNumber(value['revision'], `comments[${String(index)}].revision`),
    file: asString(value['file'], `comments[${String(index)}].file`, ''),
    line: asNumber(value['line'] ?? 0, `comments[${String(index)}].line`),
    author: asString(value['author'], `comments[${String(index)}].author`),
    content: asString(value['content'], `comments[${String(index)}].content`),
    status: status as CommentStatus,
  };
  if (!comment.id) throw new ReviewFormatError(`comments[${String(index)}].id 不能为空`);
  if (!comment.content.trim()) throw new ReviewFormatError(`comments[${String(index)}].content 不能为空`);
  const createdAt = value['created_at'];
  if (typeof createdAt === 'string' && createdAt) comment.createdAt = createdAt;
  return comment;
}

function parseApproval(value: unknown): ApprovalMeta | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ReviewFormatError('approval 必须是对象或 null');
  const approvedBy = asString(value['approved_by'], 'approval.approved_by', '');
  const approvedAt = asString(value['approved_at'], 'approval.approved_at', '');
  const commitRevision = value['commit_revision'];
  if (!approvedBy.trim() || !approvedAt.trim()) return null;
  return {
    approvedBy,
    approvedAt,
    commitRevision: commitRevision === null || commitRevision === undefined || commitRevision === ''
      ? null
      : String(commitRevision),
  };
}

const KNOWN_KEYS = new Set([
  'schema_version',
  'title',
  'created_at',
  'owner',
  'tags',
  'status',
  'ticket',
  'current_revision',
  'revisions',
  'gate_checks',
  'comments',
  'approval',
]);

export interface ParsedReview {
  meta: ReviewFrontmatter;
  body: string;
}

export function parseReviewMarkdown(text: string): ParsedReview {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) throw new ReviewFormatError('review.md 缺少 YAML Frontmatter（应以 --- 开头）');
  const yamlText = match[1] ?? '';
  const body = normalized.slice(match[0].length);
  let doc: unknown;
  try {
    doc = load(yamlText, { json: true });
  } catch (error) {
    throw new ReviewFormatError(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(doc)) throw new ReviewFormatError('review.md Frontmatter 必须是 YAML 对象');

  const schemaVersion = asNumber(doc['schema_version'], 'schema_version');
  if (schemaVersion !== 1) throw new ReviewFormatError(`不支持的 schema_version：${String(schemaVersion)}（当前仅支持 1）`);
  const status = asString(doc['status'], 'status');
  if (!STATUSES.includes(status as ReviewStatus)) {
    throw new ReviewFormatError(`status 只能是 ${STATUSES.join(' | ')}`);
  }
  const revisions = asArray(doc['revisions']).map(parseRevision);
  if (revisions.length === 0) throw new ReviewFormatError('revisions 不能为空');
  const currentRevision = asNumber(doc['current_revision'], 'current_revision');
  const current = revisions.find((revision) => revision.id === currentRevision);
  if (!current) throw new ReviewFormatError(`current_revision=${String(currentRevision)} 在 revisions 中不存在`);
  if (!current.patch.trim()) throw new ReviewFormatError(`revision ${String(currentRevision)} 缺少 patch 文件名`);

  const tagsRaw = asArray(doc['tags']);
  const tags = tagsRaw.map((tag) => String(tag)).filter((tag) => tag.length > 0);
  const gateRaw = asArray(doc['gate_checks']);
  const gateChecks = gateRaw.map((check) => String(check)).map((check) => check.trim()).filter((check) => check.length > 0);
  const comments = asArray(doc['comments']).map(parseComment);
  const ticket = asNullableString(doc['ticket'], 'ticket');
  const title = asString(doc['title'], 'title').trim();
  if (!title) throw new ReviewFormatError('title 不能为空');
  const owner = asString(doc['owner'], 'owner').trim();
  if (!owner) throw new ReviewFormatError('owner 不能为空');
  const createdAt = asString(doc['created_at'], 'created_at').trim();

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  return {
    meta: {
      schemaVersion,
      title,
      createdAt,
      owner,
      tags,
      status: status as ReviewStatus,
      ticket,
      currentRevision,
      revisions,
      gateChecks,
      comments,
      approval: parseApproval(doc['approval']),
      extra,
    },
    body,
  };
}

export function serializeReviewMarkdown(meta: ReviewFrontmatter, body: string): string {
  const doc: Record<string, unknown> = {
    schema_version: meta.schemaVersion,
    title: meta.title,
    created_at: meta.createdAt,
    owner: meta.owner,
    tags: meta.tags,
    status: meta.status,
    ticket: meta.ticket,
    current_revision: meta.currentRevision,
    revisions: meta.revisions.map((revision) => ({
      id: revision.id,
      base_revision: revision.baseRevision,
      patch: revision.patch,
    })),
    gate_checks: meta.gateChecks,
    comments: meta.comments.map((comment) => {
      const item: Record<string, unknown> = {
        id: comment.id,
        revision: comment.revision,
        file: comment.file,
        line: comment.line,
        author: comment.author,
        content: comment.content,
        status: comment.status,
      };
      if (comment.createdAt) item['created_at'] = comment.createdAt;
      return item;
    }),
    approval: meta.approval
      ? {
          approved_by: meta.approval.approvedBy,
          approved_at: meta.approval.approvedAt,
          commit_revision: meta.approval.commitRevision,
        }
      : null,
    ...meta.extra,
  };
  const yamlText = dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n$/, '');
  return `---\n${yamlText}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

const SECTION_NAMES: Array<[keyof ReviewSections, string]> = [
  ['problem', '问题与影响'],
  ['rootCause', '根因'],
  ['solution', '当前修复方案'],
  ['humanJudgment', '需人工判断项'],
  ['evidence', '验证证据'],
  ['history', '审核记录'],
];

export function parseSections(body: string): ReviewSections {
  const sections: ReviewSections = {
    problem: '',
    rootCause: '',
    solution: '',
    humanJudgment: '',
    evidence: '',
    history: '',
    rawBody: body,
  };
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let current: keyof ReviewSections | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === null) return;
    sections[current] = buffer.join('\n').trim();
  };
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    const name = heading?.[1];
    if (name) {
      flush();
      const known = SECTION_NAMES.find(([, title]) => title === name);
      current = known ? known[0] : null;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

export function extractHumanJudgment(text: string): HumanJudgmentItem[] {
  const items: HumanJudgmentItem[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]\s*(.+)$/.exec(line);
    if (!match) continue;
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    const separator = raw.search(/[：:]/);
    if (separator === -1) {
      items.push({ label: raw, text: '' });
      continue;
    }
    const label = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    items.push({ label: label || raw, text: value });
  }
  return items;
}

export function appendVersionSection(
  body: string,
  revision: number,
  baseRevision: string,
  note: string,
): string {
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n## 版本 ${String(revision)} (base: ${baseRevision})\n\n${note.trim()}\n`;
}

export function findLastFeedback(meta: ReviewFrontmatter): string {
  const comments = [...meta.comments].sort((left, right) => {
    if (left.revision !== right.revision) return left.revision - right.revision;
    return left.id.localeCompare(right.id);
  });
  const last = comments[comments.length - 1];
  if (!last) return '';
  return last.content.length > 160 ? `${last.content.slice(0, 157)}...` : last.content;
}
