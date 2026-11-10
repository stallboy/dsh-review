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

function asString(value: unknown, field: string, fallback?: string): string {
  // §2.2：解析器必须同时接受 YAML 裸 ISO 时间对象（js-yaml 解析为 Date）并规范化为 UTC（Z）ISO 字符串。
  if (value instanceof Date) return value.toISOString();
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
  const author = value['author'];
  if (author !== undefined && author !== 'ai' && author !== 'human') {
    throw new ReviewFormatError(`revisions[${String(index)}].author 只能是 ai | human`);
  }
  const extra = collectExtra(value, new Set(['id', 'base_revision', 'patch', 'author']));
  return {
    id: asNumber(value['id'], `revisions[${String(index)}].id`),
    baseRevision: asString(value['base_revision'], `revisions[${String(index)}].base_revision`),
    patch: asString(value['patch'], `revisions[${String(index)}].patch`),
    ...(author ? { author: author as 'ai' | 'human' } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function parseComment(value: unknown, index: number): ReviewComment {
  if (!isRecord(value)) throw new ReviewFormatError(`comments[${String(index)}] 必须是对象`);
  const status = asString(value['status'], `comments[${String(index)}].status`, 'unresolved');
  if (!COMMENT_STATUSES.includes(status as CommentStatus)) {
    throw new ReviewFormatError(`comments[${String(index)}].status 只能是 ${COMMENT_STATUSES.join(' | ')}`);
  }
  const side = value['side'];
  if (side !== undefined && side !== 'LEFT' && side !== 'RIGHT') {
    throw new ReviewFormatError(`comments[${String(index)}].side 只能是 LEFT | RIGHT`);
  }
  const extraComment = collectExtra(value, new Set(['id', 'revision', 'file', 'line', 'side', 'author', 'content', 'status', 'created_at', 'anchor']));
  const comment: ReviewComment = {
    id: asString(value['id'], `comments[${String(index)}].id`),
    revision: asNumber(value['revision'], `comments[${String(index)}].revision`),
    file: asString(value['file'], `comments[${String(index)}].file`, ''),
    line: asNumber(value['line'] ?? 0, `comments[${String(index)}].line`),
    ...(side ? { side: side as 'LEFT' | 'RIGHT' } : {}),
    author: asString(value['author'], `comments[${String(index)}].author`),
    content: asString(value['content'], `comments[${String(index)}].content`),
    status: status as CommentStatus,
    ...(Object.keys(extraComment).length > 0 ? { extra: extraComment } : {}),
  };
  // §4.3/G39：anchor 仅行内评论可带，snippet 非空；原 revision/file/line/side 仍是权威锚点。
  const anchorRaw = value['anchor'];
  if (isRecord(anchorRaw)) {
    const snippet = asString(anchorRaw['snippet'], `comments[${String(index)}].anchor.snippet`, '');
    if (!snippet) throw new ReviewFormatError(`comments[${String(index)}].anchor.snippet 不能为空`);
    if (comment.file === '' && comment.line === 0) {
      throw new ReviewFormatError(`comments[${String(index)}].anchor 仅行内评论可携带`);
    }
    const anchor: { snippet: string; before?: string; after?: string } = { snippet };
    const before = anchorRaw['before'];
    const after = anchorRaw['after'];
    if (typeof before === 'string' && before) anchor.before = before;
    if (typeof after === 'string' && after) anchor.after = after;
    comment.anchor = anchor;
  }
  if (!comment.id) throw new ReviewFormatError(`comments[${String(index)}].id 不能为空`);
  if (!comment.content.trim()) throw new ReviewFormatError(`comments[${String(index)}].content 不能为空`);
  const createdAt = value['created_at'];
  if (typeof createdAt === 'string' && createdAt) comment.createdAt = createdAt;
  return comment;
}

function parseHumanDecision(value: unknown, index: number): HumanDecision {
  if (!isRecord(value)) throw new ReviewFormatError(`human_decisions[${String(index)}] 必须是对象`);
  const item: HumanDecision = {
    id: asString(value['id'], `human_decisions[${String(index)}].id`),
    question: asString(value['question'], `human_decisions[${String(index)}].question`),
  };
  if (!item.id) throw new ReviewFormatError(`human_decisions[${String(index)}].id 不能为空`);
  if (!item.question.trim()) throw new ReviewFormatError(`human_decisions[${String(index)}].question 不能为空`);
  const note = value['note'];
  if (typeof note === 'string' && note.trim()) item.note = note;
  const extra = collectExtra(value, new Set(['id', 'question', 'note']));
  if (Object.keys(extra).length > 0) item.extra = extra;
  return item;
}

function parseRejection(value: unknown): RejectionMeta | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ReviewFormatError('rejection 必须是对象或 null');
  const extra = collectExtra(value, new Set(['rejected_by', 'rejected_at', 'reason']));
  return {
    rejectedBy: asString(value['rejected_by'], 'rejection.rejected_by'),
    rejectedAt: asString(value['rejected_at'], 'rejection.rejected_at'),
    reason: asString(value['reason'], 'rejection.reason'),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function parseApproval(value: unknown): ApprovalMeta | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ReviewFormatError('approval 必须是对象或 null');
  const approvedBy = asString(value['approved_by'], 'approval.approved_by', '');
  const approvedAt = asString(value['approved_at'], 'approval.approved_at', '');
  if (!approvedBy.trim() || !approvedAt.trim()) {
    // §4.7：approval 存在但关键字段缺失属于格式错误，不得伪装成"未批准"。
    throw new ReviewFormatError('approval.approved_by / approval.approved_at 不能为空');
  }
  const gateChecksRaw = Array.isArray(value['gate_checks']) ? value['gate_checks'].map((item) => String(item)) : undefined;
  const gateResultsRaw = Array.isArray(value['gate_results'])
    ? value['gate_results'].filter((item): item is Record<string, unknown> => isRecord(item)).map((item) => ({
        command: asString(item['command'], 'approval.gate_results[].command'),
        exit_code: asNumber(item['exit_code'], 'approval.gate_results[].exit_code'),
        duration_ms: asNumber(item['duration_ms'], 'approval.gate_results[].duration_ms'),
      }))
    : undefined;
  const confirmedRaw = Array.isArray(value['confirmed_decisions']) ? value['confirmed_decisions'].map((item) => String(item)) : undefined;
  const waivedRaw = Array.isArray(value['waived_decisions'])
    ? value['waived_decisions'].filter((item): item is Record<string, unknown> => isRecord(item)).map((item) => ({
        id: asString(item['id'], 'approval.waived_decisions[].id'),
        reason: asString(item['reason'], 'approval.waived_decisions[].reason'),
      }))
    : undefined;
  // §4.3（2026-11-09 修订）：commit_revision 已从 approval 契约移除；旧数据落入 extra 原样保留（I14）。
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
  // §4.3：tags 逐项 trim 后转 ASCII 小写，空项丢弃，再按规范化值去重。
  const tags = [...new Set(tagsRaw.map((tag) => String(tag).trim().toLowerCase()).filter((tag) => tag.length > 0))];
  const gateRaw = asArray(doc['gate_checks']);
  const gateChecks = gateRaw.map((check) => String(check)).map((check) => check.trim()).filter((check) => check.length > 0);
  const comments = asArray(doc['comments']).map(parseComment);
  const humanDecisions = asArray(doc['human_decisions']).map(parseHumanDecision);
  const ticket = asNullableString(doc['ticket'], 'ticket');
  const title = asString(doc['title'], 'title').trim();
  if (!title) throw new ReviewFormatError('title 不能为空');
  const owner = asString(doc['owner'], 'owner').trim();
  if (!owner) throw new ReviewFormatError('owner 不能为空');
  const createdAt = asString(doc['created_at'], 'created_at').trim();
  // 开发期旧数据可能缺少新契约字段：解析宽松取默认值，新写入一律按契约补全。
  const moduleField = asString(doc['module'], 'module', '').trim().toLowerCase();
  const auditTypeRaw = asString(doc['audit_type'], 'audit_type', '').trim();
  if (auditTypeRaw && !AUDIT_TYPES.includes(auditTypeRaw as AuditType)) {
    throw new ReviewFormatError(`audit_type 只能是 ${AUDIT_TYPES.join(' | ')}`);
  }
  const updatedAt = asString(doc['updated_at'], 'updated_at', createdAt).trim();
  const targetFiles = asArray(doc['target_files'])
    .map((item) => String(item))
    .map((item) => item.replaceAll('\\', '/'))
    .filter((item) => item.trim().length > 0);
  const commitMessage = asString(doc['commit_message'], 'commit_message', '');
  const reopenedFrom = asNullableString(doc['reopened_from'], 'reopened_from');
  const reopenedReason = asNullableString(doc['reopen_reason'], 'reopen_reason');
  const rejection = parseRejection(doc['rejection']);

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
      approval: parseApproval(doc['approval']),
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
    updated_at: meta.updatedAt || meta.createdAt,
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
      ...(revision.author ? { author: revision.author } : {}),
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
          ...(meta.approval.gateResults ? { gate_results: meta.approval.gateResults } : {}),
          ...(meta.approval.confirmedDecisions ? { confirmed_decisions: meta.approval.confirmedDecisions } : {}),
          ...(meta.approval.waivedDecisions ? { waived_decisions: meta.approval.waivedDecisions } : {}),
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
