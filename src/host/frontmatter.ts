import { load, dump } from './yaml.js';
import type {
  ApprovalMeta,
  AuditType,
  CommentStatus,
  HumanDecision,
  HumanJudgmentItem,
  RejectionMeta,
  ReviewComment,
  ReviewFrontmatter,
  ReviewSections,
  ReviewStatus,
  RevisionEntry,
} from './types.js';
import { AUDIT_TYPES } from './types.js';

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

function requiredField(doc: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(doc, key)) throw new ReviewFormatError(`${key} 是必填字段，不得缺省`);
  return doc[key];
}

function asString(value: unknown, field: string, allowDate = false): string {
  if (allowDate && value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (value === null) throw new ReviewFormatError(`${field} 不得为 null`);
  throw new ReviewFormatError(`${field} 必须是字符串`);
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new ReviewFormatError(`${field} 必须是字符串或 null`);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ReviewFormatError(`${field} 必须是数字，不得使用字符串或 null`);
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ReviewFormatError(`${field} 必须是数组，不得缺省或为 null`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  return asArray(value, field).map((item, index) => asString(item, `${field}[${String(index)}]`));
}

/** 嵌套对象中未建模的键原样收集（I14：未知嵌套键保留，避免任何一次写入丢字段）。 */
function collectExtra(value: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) extra[key] = item;
  }
  return extra;
}

function parseRevision(value: unknown, index: number): RevisionEntry {
  if (!isRecord(value)) throw new ReviewFormatError(`revisions[${String(index)}] 必须是对象`);
  const field = (key: string): unknown => requiredField(value, key);
  const author = field('author');
  if (author !== 'ai' && author !== 'human') {
    throw new ReviewFormatError(`revisions[${String(index)}].author 只能是 ai | human`);
  }
  const extra = collectExtra(value, new Set(['id', 'base_revision', 'patch', 'author']));
  return {
    id: asNumber(field('id'), `revisions[${String(index)}].id`),
    baseRevision: asString(field('base_revision'), `revisions[${String(index)}].base_revision`),
    patch: asString(field('patch'), `revisions[${String(index)}].patch`),
    author,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function parseComment(value: unknown, index: number): ReviewComment {
  if (!isRecord(value)) throw new ReviewFormatError(`comments[${String(index)}] 必须是对象`);
  const field = (key: string): unknown => requiredField(value, key);
  const status = asString(field('status'), `comments[${String(index)}].status`);
  if (!COMMENT_STATUSES.includes(status as CommentStatus)) {
    throw new ReviewFormatError(`comments[${String(index)}].status 只能是 ${COMMENT_STATUSES.join(' | ')}`);
  }
  const side = value['side'];
  if (side !== undefined && side !== 'LEFT' && side !== 'RIGHT') {
    throw new ReviewFormatError(`comments[${String(index)}].side 只能是 LEFT | RIGHT`);
  }
  const extraComment = collectExtra(value, new Set(['id', 'revision', 'file', 'line', 'side', 'author', 'content', 'status', 'created_at', 'anchor']));
  const comment: ReviewComment = {
    id: asString(field('id'), `comments[${String(index)}].id`),
    revision: asNumber(field('revision'), `comments[${String(index)}].revision`),
    file: asString(field('file'), `comments[${String(index)}].file`),
    line: asNumber(field('line'), `comments[${String(index)}].line`),
    ...(side ? { side: side as 'LEFT' | 'RIGHT' } : {}),
    author: asString(field('author'), `comments[${String(index)}].author`),
    content: asString(field('content'), `comments[${String(index)}].content`),
    status: status as CommentStatus,
    ...(Object.keys(extraComment).length > 0 ? { extra: extraComment } : {}),
  };
  const anchorRaw = value['anchor'];
  if (anchorRaw !== undefined) {
    if (!isRecord(anchorRaw)) throw new ReviewFormatError(`comments[${String(index)}].anchor 必须是对象`);
    const snippet = asString(requiredField(anchorRaw, 'snippet'), `comments[${String(index)}].anchor.snippet`);
    if (!snippet) throw new ReviewFormatError(`comments[${String(index)}].anchor.snippet 不能为空`);
    if (comment.file === '' && comment.line === 0) {
      throw new ReviewFormatError(`comments[${String(index)}].anchor 仅行内评论可携带`);
    }
    const anchor: { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } = { snippet };
    const before = anchorRaw['before'];
    const after = anchorRaw['after'];
    if (before !== undefined && typeof before !== 'string') throw new ReviewFormatError(`comments[${String(index)}].anchor.before 必须是字符串`);
    if (after !== undefined && typeof after !== 'string') throw new ReviewFormatError(`comments[${String(index)}].anchor.after 必须是字符串`);
    if (typeof before === 'string') anchor.before = before;
    if (typeof after === 'string') anchor.after = after;
    const extra = collectExtra(anchorRaw, new Set(['snippet', 'before', 'after']));
    if (Object.keys(extra).length > 0) anchor.extra = extra;
    comment.anchor = anchor;
  }
  if (!comment.id) throw new ReviewFormatError(`comments[${String(index)}].id 不能为空`);
  if (!comment.author.trim()) throw new ReviewFormatError(`comments[${String(index)}].author 不能为空`);
  if (!comment.content.trim()) throw new ReviewFormatError(`comments[${String(index)}].content 不能为空`);
  const createdAt = value['created_at'];
  if (createdAt !== undefined) comment.createdAt = asString(createdAt, `comments[${String(index)}].created_at`, true);
  return comment;
}

function parseHumanDecision(value: unknown, index: number): HumanDecision {
  if (!isRecord(value)) throw new ReviewFormatError(`human_decisions[${String(index)}] 必须是对象`);
  const item: HumanDecision = {
    id: asString(requiredField(value, 'id'), `human_decisions[${String(index)}].id`),
    question: asString(requiredField(value, 'question'), `human_decisions[${String(index)}].question`),
  };
  if (!item.id) throw new ReviewFormatError(`human_decisions[${String(index)}].id 不能为空`);
  if (!item.question.trim()) throw new ReviewFormatError(`human_decisions[${String(index)}].question 不能为空`);
  const note = value['note'];
  if (note !== undefined && typeof note !== 'string') throw new ReviewFormatError(`human_decisions[${String(index)}].note 必须是字符串`);
  if (typeof note === 'string' && note.trim()) item.note = note;
  const extra = collectExtra(value, new Set(['id', 'question', 'note']));
  if (Object.keys(extra).length > 0) item.extra = extra;
  return item;
}

function parseRejection(value: unknown): RejectionMeta | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ReviewFormatError('rejection 必须是对象或 null');
  const extra = collectExtra(value, new Set(['rejected_by', 'rejected_at', 'reason']));
  return {
    rejectedBy: asString(requiredField(value, 'rejected_by'), 'rejection.rejected_by'),
    rejectedAt: asString(requiredField(value, 'rejected_at'), 'rejection.rejected_at', true),
    reason: asString(requiredField(value, 'reason'), 'rejection.reason'),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function parseApproval(value: unknown): ApprovalMeta | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ReviewFormatError('approval 必须是对象或 null');
  const approvedBy = asString(requiredField(value, 'approved_by'), 'approval.approved_by');
  const approvedAt = asString(requiredField(value, 'approved_at'), 'approval.approved_at', true);
  if (!approvedBy.trim() || !approvedAt.trim()) {
    throw new ReviewFormatError('approval.approved_by / approval.approved_at 不能为空');
  }
  const gateChecksRaw = value['gate_checks'] === undefined
    ? undefined
    : asStringArray(value['gate_checks'], 'approval.gate_checks');
  const gateResultsRaw = value['gate_results'] === undefined
    ? undefined
    : asArray(value['gate_results'], 'approval.gate_results').map((item) => {
        if (!isRecord(item)) throw new ReviewFormatError('approval.gate_results[] 必须是对象');
        const extra = collectExtra(item, new Set(['command', 'exit_code', 'duration_ms']));
        return {
          command: asString(requiredField(item, 'command'), 'approval.gate_results[].command'),
          exit_code: asNumber(requiredField(item, 'exit_code'), 'approval.gate_results[].exit_code'),
          duration_ms: asNumber(requiredField(item, 'duration_ms'), 'approval.gate_results[].duration_ms'),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        };
      });
  const confirmedRaw = value['confirmed_decisions'] === undefined
    ? undefined
    : asStringArray(value['confirmed_decisions'], 'approval.confirmed_decisions');
  const waivedRaw = value['waived_decisions'] === undefined
    ? undefined
    : asArray(value['waived_decisions'], 'approval.waived_decisions').map((item) => {
        if (!isRecord(item)) throw new ReviewFormatError('approval.waived_decisions[] 必须是对象');
        const extra = collectExtra(item, new Set(['id', 'reason']));
        return {
          id: asString(requiredField(item, 'id'), 'approval.waived_decisions[].id'),
          reason: asString(requiredField(item, 'reason'), 'approval.waived_decisions[].reason'),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        };
      });
  const extra = collectExtra(value, new Set(['approved_by', 'approved_at', 'gate_checks', 'gate_results', 'confirmed_decisions', 'waived_decisions']));
  return {
    approvedBy,
    approvedAt,
    ...(gateChecksRaw ? { gateChecks: gateChecksRaw } : {}),
    ...(gateResultsRaw ? { gateResults: gateResultsRaw } : {}),
    ...(confirmedRaw ? { confirmedDecisions: confirmedRaw } : {}),
    ...(waivedRaw ? { waivedDecisions: waivedRaw } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

const KNOWN_KEYS = new Set([
  'schema_version',
  'title',
  'module',
  'audit_type',
  'created_at',
  'updated_at',
  'owner',
  'tags',
  'ticket',
  'status',
  'target_files',
  'current_revision',
  'revisions',
  'gate_checks',
  'comments',
  'human_decisions',
  'approval',
  'rejection',
  'commit_message',
  'reopened_from',
  'reopen_reason',
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

  const field = (key: string): unknown => requiredField(doc, key);
  const schemaVersion = asNumber(field('schema_version'), 'schema_version');
  if (schemaVersion !== 1) throw new ReviewFormatError(`不支持的 schema_version：${String(schemaVersion)}（当前仅支持 1）`);
  const status = asString(field('status'), 'status');
  if (!STATUSES.includes(status as ReviewStatus)) {
    throw new ReviewFormatError(`status 只能是 ${STATUSES.join(' | ')}`);
  }
  const revisions = asArray(field('revisions'), 'revisions').map(parseRevision);
  if (revisions.length === 0) throw new ReviewFormatError('revisions 不能为空');
  const currentRevision = asNumber(field('current_revision'), 'current_revision');
  const current = revisions.find((revision) => revision.id === currentRevision);
  if (!current) throw new ReviewFormatError(`current_revision=${String(currentRevision)} 在 revisions 中不存在`);
  if (!current.patch.trim()) throw new ReviewFormatError(`revision ${String(currentRevision)} 缺少 patch 文件名`);

  const tags = [...new Set(asStringArray(field('tags'), 'tags')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0))];
  const gateChecks = asStringArray(field('gate_checks'), 'gate_checks').map((check) => check.trim());
  const comments = asArray(field('comments'), 'comments').map(parseComment);
  const humanDecisions = asArray(field('human_decisions'), 'human_decisions').map(parseHumanDecision);
  const ticket = asNullableString(field('ticket'), 'ticket');
  const title = asString(field('title'), 'title').trim();
  if (!title) throw new ReviewFormatError('title 不能为空');
  const owner = asString(field('owner'), 'owner').trim();
  if (!owner) throw new ReviewFormatError('owner 不能为空');
  const createdAt = asString(field('created_at'), 'created_at', true).trim();
  const moduleField = asString(field('module'), 'module').trim().toLowerCase();
  if (!moduleField) throw new ReviewFormatError('module 不能为空');
  const auditTypeRaw = asString(field('audit_type'), 'audit_type').trim();
  if (!AUDIT_TYPES.includes(auditTypeRaw as AuditType)) {
    throw new ReviewFormatError(`audit_type 只能是 ${AUDIT_TYPES.join(' | ')}`);
  }
  const updatedAt = asString(field('updated_at'), 'updated_at', true).trim();
  const targetFiles = asStringArray(field('target_files'), 'target_files');
  const commitMessage = asString(field('commit_message'), 'commit_message');
  if (!commitMessage.trim()) throw new ReviewFormatError('commit_message 不能为空');
  const reopenedFrom = doc['reopened_from'] === undefined ? null : asNullableString(doc['reopened_from'], 'reopened_from');
  const reopenedReason = doc['reopen_reason'] === undefined ? null : asNullableString(doc['reopen_reason'], 'reopen_reason');
  const rejection = parseRejection(field('rejection'));

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  return {
    meta: {
      schemaVersion,
      title,
      module: moduleField,
      auditType: auditTypeRaw as AuditType | '',
      createdAt,
      updatedAt,
      owner,
      tags,
      status: status as ReviewStatus,
      ticket,
      targetFiles,
      currentRevision,
      revisions,
      gateChecks,
      comments,
      humanDecisions,
      approval: parseApproval(field('approval')),
      rejection,
      commitMessage,
      ...(reopenedFrom !== null || reopenedReason !== null
        ? { reopenedFrom, reopenedReason }
        : {}),
      extra,
    },
    body,
  };
}

export function serializeReviewMarkdown(meta: ReviewFrontmatter, body: string): string {
  const doc: Record<string, unknown> = {
    schema_version: meta.schemaVersion,
    title: meta.title,
    module: meta.module,
    audit_type: meta.auditType,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    owner: meta.owner,
    tags: meta.tags,
    ticket: meta.ticket,
    status: meta.status,
    target_files: meta.targetFiles,
    current_revision: meta.currentRevision,
    revisions: meta.revisions.map((revision) => ({
      id: revision.id,
      base_revision: revision.baseRevision,
      patch: revision.patch,
      author: revision.author,
      ...(revision.extra ?? {}),
    })),
    gate_checks: meta.gateChecks,
    comments: meta.comments.map((comment) => {
      const item: Record<string, unknown> = {
        id: comment.id,
        revision: comment.revision,
        file: comment.file,
        line: comment.line,
        ...(comment.side ? { side: comment.side } : {}),
        ...(comment.anchor
          ? {
              anchor: {
                snippet: comment.anchor.snippet,
                ...(comment.anchor.before ? { before: comment.anchor.before } : {}),
                ...(comment.anchor.after ? { after: comment.anchor.after } : {}),
                ...(comment.anchor.extra ?? {}),
              },
            }
          : {}),
        author: comment.author,
        content: comment.content,
        status: comment.status,
        ...(comment.extra ?? {}),
      };
      if (comment.createdAt) item['created_at'] = comment.createdAt;
      return item;
    }),
    human_decisions: meta.humanDecisions.map((decision) => {
      const item: Record<string, unknown> = {
        id: decision.id,
        question: decision.question,
      };
      if (decision.note) item['note'] = decision.note;
      return { ...item, ...(decision.extra ?? {}) };
    }),
    approval: meta.approval
      ? {
          approved_by: meta.approval.approvedBy,
          approved_at: meta.approval.approvedAt,
          ...(meta.approval.gateChecks ? { gate_checks: meta.approval.gateChecks } : {}),
          ...(meta.approval.gateResults
            ? {
                gate_results: meta.approval.gateResults.map((result) => ({
                  command: result.command,
                  exit_code: result.exit_code,
                  duration_ms: result.duration_ms,
                  ...(result.extra ?? {}),
                })),
              }
            : {}),
          ...(meta.approval.confirmedDecisions ? { confirmed_decisions: meta.approval.confirmedDecisions } : {}),
          ...(meta.approval.waivedDecisions
            ? {
                waived_decisions: meta.approval.waivedDecisions.map((item) => ({
                  id: item.id,
                  reason: item.reason,
                  ...(item.extra ?? {}),
                })),
              }
            : {}),
          ...(meta.approval.extra ?? {}),
        }
      : null,
    rejection: meta.rejection
      ? {
          rejected_by: meta.rejection.rejectedBy,
          rejected_at: meta.rejection.rejectedAt,
          reason: meta.rejection.reason,
          ...(meta.rejection.extra ?? {}),
        }
      : null,
    commit_message: meta.commitMessage,
    ...(meta.reopenedFrom !== undefined && meta.reopenedFrom !== null
      ? { reopened_from: meta.reopenedFrom, reopen_reason: meta.reopenedReason ?? null }
      : {}),
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

const PLACEHOLDER_JUDGMENT = /^(?:无|暂无|没有|不适用|无需|none|n\/a|na)(?:[。.；;，,：:]|$|[（(])/i;

/**
 * Placeholder text such as “无”, “无。” or “无：...详情...” carries no decision
 * for a human. Treat it as empty so the UI does not render a fake review item.
 */
export function isEmptyHumanJudgmentText(value: string): boolean {
  const normalized = value.replace(/[*_`]/g, '').trim();
  if (normalized.length === 0) return true;
  return PLACEHOLDER_JUDGMENT.test(normalized);
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
      if (!isEmptyHumanJudgmentText(raw)) items.push({ label: '需人工确认', text: raw });
      continue;
    }
    const label = raw.slice(0, separator).replace(/\*\*|__/g, '').trim();
    const value = raw.slice(separator + 1).trim();
    if (isEmptyHumanJudgmentText(value)) continue;
    items.push({ label: label || '需人工确认', text: value });
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
