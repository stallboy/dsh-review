/** review.md 解析与序列化层（唯一契约 schema_version: 1，严格键序且往返保留未知键）。 */

import type {
  ApprovalInfo,
  AuditType,
  CommentAnchor,
  CommentSide,
  CommentStatus,
  GateCheckResult,
  HumanDecision,
  HumanJudgmentItem,
  IssueDecision,
  IssueDecisionAction,
  IssueEvidence,
  IssueKind,
  IssueObservation,
  PatchEntry,
  RejectionInfo,
  RepairApplyMode,
  RepairAttempt,
  RepairAttemptResult,
  RepairOption,
  ReviewComment,
  ReviewFrontmatter,
  ReviewPriority,
  ReviewSections,
  ReviewStatus,
  SvnApprovalSource,
  WaivedDecision,
} from './types.js';
import { dump, readMarkdownFrontmatter } from './yaml.js';

export const AUDIT_TYPES: readonly AuditType[] = [
  'bugfix',
  'delete',
  'shrink',
  'reuse',
  'merge',
  'split',
  'stdlib',
  'native',
  'yagni',
];

export const ISSUE_KINDS: readonly IssueKind[] = ['repair', 'confirm', 'deferred'];
export const REVIEW_PRIORITIES: readonly ReviewPriority[] = ['P0', 'P1', 'P2', 'P3'];
export const REVIEW_STATUS_LIST: readonly ReviewStatus[] = [
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'repair_failed',
  'human_takeover',
  'awaiting_verification',
  'resolved',
];
export const COMMENT_STATUSES: readonly CommentStatus[] = ['unresolved', 'partial', 'resolved'];
export const DECISION_ACTIONS: readonly IssueDecisionAction[] = [
  'accept_as_is',
  'defer',
  'human_takeover',
  'add_repair_hint',
  'external_completed',
  'resume_review',
];
export const APPLY_MODES: readonly RepairApplyMode[] = ['program_strict', 'program_3way', 'agent_assisted'];
export const REPAIR_RESULTS: readonly RepairAttemptResult[] = ['applied', 'verification_failed'];

/** SPEC §3.3 固定顶层字段键序。 */
export const TOP_LEVEL_KEY_ORDER = [
  'schema_version',
  'finding_id',
  'title',
  'module',
  'audit_type',
  'issue_kind',
  'depends_on',
  'priority',
  'base_revision',
  'created_at',
  'updated_at',
  'owner',
  'tags',
  'ticket',
  'status',
  'target_files',
  'record_revision',
  'patches',
  'options',
  'observations',
  'decisions',
  'repair_attempts',
  'comments',
  'human_decisions',
  'approval',
  'approval_history',
  'rejection',
  'commit_message',
] as const;

const KNOWN_TOP_KEYS = new Set<string>(TOP_LEVEL_KEY_ORDER);

export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function pickExtra(obj: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`字段 ${field} 必须是字符串`);
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`字段 ${field} 必须是字符串或 null`);
  return value;
}

function asTimestamp(value: unknown, field: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`字段 ${field} 不是合法时间戳`);
    return value.toISOString();
  }
  if (typeof value !== 'string') throw new Error(`字段 ${field} 必须是 ISO-8601 时间戳字符串`);
  const trimmed = value.trim();
  if (!ISO_TIMESTAMP_PATTERN.test(trimmed)) {
    throw new Error(`字段 ${field} 必须是含时区的 ISO-8601 时间戳：${trimmed}`);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new Error(`字段 ${field} 时间戳无效：${trimmed}`);
  return new Date(ms).toISOString();
}

function asOptionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asTimestamp(value, field);
}

function asOptionalUtcDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`字段 ${field} 日期无效`);
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') throw new Error(`字段 ${field} 必须是 YYYY-MM-DD 字符串`);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new Error(`字段 ${field} 必须是 YYYY-MM-DD 格式`);
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(`字段 ${field} 不是有效日期：${trimmed}`);
  }
  return trimmed;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`字段 ${field} 必须是有限数字`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`字段 ${field} 必须是数组`);
  return value.map((item, index) => asString(item, `${field}[${String(index)}]`));
}

function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of raw) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseSvnApprovalSource(value: unknown, field: string): SvnApprovalSource | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const extra = pickExtra(value, new Set(['uuid', 'relative_url']));
  return {
    uuid: asString(value['uuid'], `${field}.uuid`),
    relativeUrl: asString(value['relative_url'], `${field}.relative_url`),
    ...(extra ? { extra } : {}),
  };
}

function parsePatchEntry(value: unknown, index: number): PatchEntry {
  const field = `patches[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const author = asString(value['author'], `${field}.author`);
  if (author !== 'ai' && author !== 'human') throw new Error(`字段 ${field}.author 必须是 ai 或 human`);
  const svnApprovalSource = parseSvnApprovalSource(value['svn_approval_source'], `${field}.svn_approval_source`);
  const extra = pickExtra(value, new Set(['id', 'patch', 'option_id', 'base_revision', 'author', 'sha256', 'svn_approval_source']));
  return {
    id: asNumber(value['id'], `${field}.id`),
    patch: asString(value['patch'], `${field}.patch`),
    optionId: asString(value['option_id'], `${field}.option_id`),
    baseRevision: asString(value['base_revision'], `${field}.base_revision`),
    author,
    sha256: asString(value['sha256'], `${field}.sha256`),
    ...(svnApprovalSource ? { svnApprovalSource } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseOption(value: unknown, index: number): RepairOption {
  const field = `options[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const extra = pickExtra(value, new Set(['id', 'title', 'tradeoff', 'confidence', 'current_patch', 'gate_checks']));
  return {
    id: asString(value['id'], `${field}.id`),
    title: asString(value['title'], `${field}.title`),
    tradeoff: asString(value['tradeoff'], `${field}.tradeoff`),
    confidence: asNumber(value['confidence'], `${field}.confidence`),
    currentPatch: asNumber(value['current_patch'], `${field}.current_patch`),
    gateChecks: asStringArray(value['gate_checks'], `${field}.gate_checks`),
    ...(extra ? { extra } : {}),
  };
}

function parseEvidence(value: unknown, field: string): IssueEvidence {
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const extra = pickExtra(value, new Set(['path', 'line', 'excerpt', 'reason']));
  return {
    path: asString(value['path'], `${field}.path`),
    line: asNumber(value['line'], `${field}.line`),
    excerpt: asString(value['excerpt'], `${field}.excerpt`),
    reason: asString(value['reason'], `${field}.reason`),
    ...(extra ? { extra } : {}),
  };
}

function parseObservation(value: unknown, index: number): IssueObservation {
  const field = `observations[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const verdict = asString(value['verdict'], `${field}.verdict`);
  if (verdict !== 'confirmed' && verdict !== 'resolved' && verdict !== 'unverified') {
    throw new Error(`字段 ${field}.verdict 非法：${verdict}`);
  }
  const rawEvidence = value['evidence'];
  if (!Array.isArray(rawEvidence)) throw new Error(`字段 ${field}.evidence 必须是数组`);
  const extra = pickExtra(value, new Set(['audit_id', 'base_revision', 'at', 'verdict', 'reason', 'evidence']));
  return {
    auditId: asString(value['audit_id'], `${field}.audit_id`),
    baseRevision: asString(value['base_revision'], `${field}.base_revision`),
    at: asTimestamp(value['at'], `${field}.at`),
    verdict,
    reason: asString(value['reason'], `${field}.reason`),
    evidence: rawEvidence.map((item, idx) => parseEvidence(item, `${field}.evidence[${String(idx)}]`)),
    ...(extra ? { extra } : {}),
  };
}

function parseDecision(value: unknown, index: number): IssueDecision {
  const field = `decisions[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const action = asString(value['action'], `${field}.action`) as IssueDecisionAction;
  if (!DECISION_ACTIONS.includes(action)) throw new Error(`字段 ${field}.action 非法：${action}`);
  const reviewAfter = asOptionalUtcDate(value['review_after'], `${field}.review_after`);
  const reviewWhen = value['review_when'] === undefined ? undefined : asString(value['review_when'], `${field}.review_when`);
  const category = value['category'] === undefined ? undefined : asString(value['category'], `${field}.category`);
  const relatedSymbols = value['related_symbols'] === undefined
    ? undefined
    : asStringArray(value['related_symbols'], `${field}.related_symbols`);
  const extra = pickExtra(
    value,
    new Set(['action', 'actor', 'at', 'reason', 'review_after', 'review_when', 'category', 'related_symbols']),
  );
  return {
    action,
    actor: asString(value['actor'], `${field}.actor`),
    at: asTimestamp(value['at'], `${field}.at`),
    reason: asString(value['reason'], `${field}.reason`),
    ...(reviewAfter !== undefined ? { reviewAfter } : {}),
    ...(reviewWhen !== undefined ? { reviewWhen } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(relatedSymbols !== undefined ? { relatedSymbols } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseRepairAttempt(value: unknown, index: number): RepairAttempt {
  const field = `repair_attempts[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const applyMode = asString(value['apply_mode'], `${field}.apply_mode`) as RepairApplyMode;
  if (!APPLY_MODES.includes(applyMode)) throw new Error(`字段 ${field}.apply_mode 非法：${applyMode}`);
  const result = asString(value['result'], `${field}.result`) as RepairAttemptResult;
  if (!REPAIR_RESULTS.includes(result)) throw new Error(`字段 ${field}.result 非法：${result}`);
  if (typeof value['restored'] !== 'boolean') throw new Error(`字段 ${field}.restored 必须是布尔值`);
  const extra = pickExtra(
    value,
    new Set(['id', 'option_id', 'patch_id', 'base_revision', 'actor', 'at', 'apply_mode', 'result', 'restored', 'evidence']),
  );
  return {
    id: asNumber(value['id'], `${field}.id`),
    optionId: asString(value['option_id'], `${field}.option_id`),
    patchId: asNumber(value['patch_id'], `${field}.patch_id`),
    baseRevision: asString(value['base_revision'], `${field}.base_revision`),
    actor: asString(value['actor'], `${field}.actor`),
    at: asTimestamp(value['at'], `${field}.at`),
    applyMode,
    result,
    restored: value['restored'],
    evidence: asString(value['evidence'], `${field}.evidence`),
    ...(extra ? { extra } : {}),
  };
}

function parseAnchor(value: unknown, field: string): CommentAnchor {
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const snippet = asString(value['snippet'], `${field}.snippet`);
  const before = value['before'] === undefined ? undefined : asString(value['before'], `${field}.before`);
  const after = value['after'] === undefined ? undefined : asString(value['after'], `${field}.after`);
  const extra = pickExtra(value, new Set(['snippet', 'before', 'after']));
  return {
    snippet,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseComment(value: unknown, index: number): ReviewComment {
  const field = `comments[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const status = asString(value['status'], `${field}.status`) as CommentStatus;
  if (!COMMENT_STATUSES.includes(status)) throw new Error(`字段 ${field}.status 非法：${status}`);
  const side = value['side'] === undefined ? undefined : asString(value['side'], `${field}.side`) as CommentSide;
  if (side !== undefined && side !== 'LEFT' && side !== 'RIGHT') {
    throw new Error(`字段 ${field}.side 必须是 LEFT 或 RIGHT`);
  }
  const optionId = value['option_id'] === undefined ? undefined : asString(value['option_id'], `${field}.option_id`);
  const patchId = value['patch_id'] === undefined ? undefined : asNumber(value['patch_id'], `${field}.patch_id`);
  const createdAt = asOptionalTimestamp(value['created_at'], `${field}.created_at`);
  const anchor = value['anchor'] === undefined ? undefined : parseAnchor(value['anchor'], `${field}.anchor`);
  const extra = pickExtra(
    value,
    new Set(['id', 'revision', 'option_id', 'patch_id', 'file', 'line', 'side', 'author', 'content', 'status', 'created_at', 'anchor']),
  );
  return {
    id: asString(value['id'], `${field}.id`),
    revision: asNumber(value['revision'], `${field}.revision`),
    ...(optionId !== undefined ? { optionId } : {}),
    ...(patchId !== undefined ? { patchId } : {}),
    file: asString(value['file'], `${field}.file`),
    line: asNumber(value['line'], `${field}.line`),
    ...(side !== undefined ? { side } : {}),
    author: asString(value['author'], `${field}.author`),
    content: asString(value['content'], `${field}.content`),
    status,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseHumanDecision(value: unknown, index: number): HumanDecision {
  const field = `human_decisions[${String(index)}]`;
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const note = value['note'] === undefined ? undefined : asString(value['note'], `${field}.note`);
  const extra = pickExtra(value, new Set(['id', 'question', 'note']));
  return {
    id: asString(value['id'], `${field}.id`),
    question: asString(value['question'], `${field}.question`),
    ...(note !== undefined ? { note } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseWaivedDecision(value: unknown, field: string): WaivedDecision {
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const extra = pickExtra(value, new Set(['id', 'reason']));
  return {
    id: asString(value['id'], `${field}.id`),
    reason: asString(value['reason'], `${field}.reason`),
    ...(extra ? { extra } : {}),
  };
}

function parseGateResult(value: unknown, field: string): GateCheckResult {
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const rawExit = value['exit_code'];
  if (rawExit !== null && (typeof rawExit !== 'number' || !Number.isInteger(rawExit))) {
    throw new Error(`字段 ${field}.exit_code 必须是整数或 null`);
  }
  const extra = pickExtra(value, new Set(['command', 'exit_code', 'duration_ms']));
  return {
    command: asString(value['command'], `${field}.command`),
    exitCode: rawExit,
    durationMs: asNumber(value['duration_ms'], `${field}.duration_ms`),
    ...(extra ? { extra } : {}),
  };
}

function parseApproval(value: unknown, field: string): ApprovalInfo {
  if (!isPlainRecord(value)) throw new Error(`字段 ${field} 必须是对象`);
  const rawGateResults = value['gate_results'];
  if (!Array.isArray(rawGateResults)) throw new Error(`字段 ${field}.gate_results 必须是数组`);
  const rawWaived = value['waived_decisions'];
  if (!Array.isArray(rawWaived)) throw new Error(`字段 ${field}.waived_decisions 必须是数组`);
  const businessCommit = value['business_commit'] === undefined
    ? undefined
    : asString(value['business_commit'], `${field}.business_commit`);
  const extra = pickExtra(
    value,
    new Set([
      'approved_by',
      'approved_at',
      'record_revision',
      'option_id',
      'patch_id',
      'patch_sha256',
      'repair_attempt_id',
      'base_revision',
      'gate_checks',
      'gate_results',
      'confirmed_decisions',
      'waived_decisions',
      'business_commit',
    ]),
  );
  return {
    approvedBy: asString(value['approved_by'], `${field}.approved_by`),
    approvedAt: asTimestamp(value['approved_at'], `${field}.approved_at`),
    recordRevision: asNumber(value['record_revision'], `${field}.record_revision`),
    optionId: asString(value['option_id'], `${field}.option_id`),
    patchId: asNumber(value['patch_id'], `${field}.patch_id`),
    patchSha256: asString(value['patch_sha256'], `${field}.patch_sha256`),
    repairAttemptId: asNumber(value['repair_attempt_id'], `${field}.repair_attempt_id`),
    baseRevision: asString(value['base_revision'], `${field}.base_revision`),
    gateChecks: asStringArray(value['gate_checks'], `${field}.gate_checks`),
    gateResults: rawGateResults.map((item, idx) => parseGateResult(item, `${field}.gate_results[${String(idx)}]`)),
    confirmedDecisions: asStringArray(value['confirmed_decisions'], `${field}.confirmed_decisions`),
    waivedDecisions: rawWaived.map((item, idx) => parseWaivedDecision(item, `${field}.waived_decisions[${String(idx)}]`)),
    ...(businessCommit !== undefined ? { businessCommit } : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseRejection(value: unknown): RejectionInfo {
  if (!isPlainRecord(value)) throw new Error('字段 rejection 必须是对象');
  const category = value['category'] === undefined ? undefined : asString(value['category'], 'rejection.category');
  const relatedSymbols = value['related_symbols'] === undefined
    ? undefined
    : asStringArray(value['related_symbols'], 'rejection.related_symbols');
  const extra = pickExtra(value, new Set(['rejected_by', 'rejected_at', 'reason', 'category', 'related_symbols']));
  return {
    rejectedBy: asString(value['rejected_by'], 'rejection.rejected_by'),
    rejectedAt: asTimestamp(value['rejected_at'], 'rejection.rejected_at'),
    reason: asString(value['reason'], 'rejection.reason'),
    ...(category !== undefined ? { category } : {}),
    ...(relatedSymbols !== undefined ? { relatedSymbols } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function parseReviewMarkdown(text: string): {
  meta: ReviewFrontmatter;
  body: string;
  sections: ReviewSections;
  humanJudgment: HumanJudgmentItem[];
  humanJudgmentDeclared: boolean;
} {
  const { doc, body } = readMarkdownFrontmatter(text, 'review.md');
  if (!isPlainRecord(doc)) throw new Error('review.md Frontmatter 顶层必须是对象');

  for (const requiredKey of TOP_LEVEL_KEY_ORDER) {
    if (!Object.hasOwn(doc, requiredKey)) {
      throw new Error(`review.md 缺少必填顶层字段：${requiredKey}`);
    }
  }

  if (doc['schema_version'] !== 1) {
    throw new Error(`review.md 仅支持 schema_version: 1（当前为 ${String(doc['schema_version'])}）`);
  }

  const auditType = asString(doc['audit_type'], 'audit_type') as AuditType;
  if (!AUDIT_TYPES.includes(auditType)) {
    throw new Error(`字段 audit_type 非法：${auditType}`);
  }
  const issueKind = asString(doc['issue_kind'], 'issue_kind') as IssueKind;
  if (!ISSUE_KINDS.includes(issueKind)) {
    throw new Error(`字段 issue_kind 非法：${issueKind}`);
  }
  const priority = asString(doc['priority'], 'priority') as ReviewPriority;
  if (!REVIEW_PRIORITIES.includes(priority)) {
    throw new Error(`字段 priority 非法：${priority}`);
  }
  const status = asString(doc['status'], 'status') as ReviewStatus;
  if (!REVIEW_STATUS_LIST.includes(status)) {
    throw new Error(`字段 status 非法：${status}`);
  }

  const rawPatches = doc['patches'];
  if (!Array.isArray(rawPatches)) throw new Error('字段 patches 必须是数组');
  const rawOptions = doc['options'];
  if (!Array.isArray(rawOptions)) throw new Error('字段 options 必须是数组');
  const rawObservations = doc['observations'];
  if (!Array.isArray(rawObservations)) throw new Error('字段 observations 必须是数组');
  const rawDecisions = doc['decisions'];
  if (!Array.isArray(rawDecisions)) throw new Error('字段 decisions 必须是数组');
  const rawAttempts = doc['repair_attempts'];
  if (!Array.isArray(rawAttempts)) throw new Error('字段 repair_attempts 必须是数组');
  const rawComments = doc['comments'];
  if (!Array.isArray(rawComments)) throw new Error('字段 comments 必须是数组');
  const rawHumanDecisions = doc['human_decisions'];
  if (!Array.isArray(rawHumanDecisions)) throw new Error('字段 human_decisions 必须是数组');
  const rawApprovalHistory = doc['approval_history'];
  if (!Array.isArray(rawApprovalHistory)) throw new Error('字段 approval_history 必须是数组');

  const extra = pickExtra(doc, KNOWN_TOP_KEYS);
  const meta: ReviewFrontmatter = {
    schemaVersion: 1,
    findingId: asString(doc['finding_id'], 'finding_id'),
    title: asString(doc['title'], 'title'),
    module: asString(doc['module'], 'module'),
    auditType,
    issueKind,
    dependsOn: asNullableString(doc['depends_on'], 'depends_on'),
    priority,
    baseRevision: asString(doc['base_revision'], 'base_revision'),
    createdAt: asTimestamp(doc['created_at'], 'created_at'),
    updatedAt: asTimestamp(doc['updated_at'], 'updated_at'),
    owner: asString(doc['owner'], 'owner'),
    tags: normalizeTags(asStringArray(doc['tags'], 'tags')),
    ticket: asNullableString(doc['ticket'], 'ticket'),
    status,
    targetFiles: asStringArray(doc['target_files'], 'target_files'),
    recordRevision: asNumber(doc['record_revision'], 'record_revision'),
    patches: rawPatches.map(parsePatchEntry),
    options: rawOptions.map(parseOption),
    observations: rawObservations.map(parseObservation),
    decisions: rawDecisions.map(parseDecision),
    repairAttempts: rawAttempts.map(parseRepairAttempt),
    comments: rawComments.map(parseComment),
    humanDecisions: rawHumanDecisions.map(parseHumanDecision),
    approval: doc['approval'] === null ? null : parseApproval(doc['approval'], 'approval'),
    approvalHistory: rawApprovalHistory.map((item, idx) => parseApproval(item, `approval_history[${String(idx)}]`)),
    rejection: doc['rejection'] === null ? null : parseRejection(doc['rejection']),
    commitMessage: asNullableString(doc['commit_message'], 'commit_message'),
    ...(extra ? { extra } : {}),
  };

  const { sections, humanJudgmentDeclared } = parseBodySections(body);
  const humanJudgment = parseHumanJudgmentItems(sections.humanJudgment);

  return { meta, body, sections, humanJudgment, humanJudgmentDeclared };
}

function serializeApproval(approval: ApprovalInfo): Record<string, unknown> {
  return {
    approved_by: approval.approvedBy,
    approved_at: approval.approvedAt,
    record_revision: approval.recordRevision,
    option_id: approval.optionId,
    patch_id: approval.patchId,
    patch_sha256: approval.patchSha256,
    repair_attempt_id: approval.repairAttemptId,
    base_revision: approval.baseRevision,
    gate_checks: approval.gateChecks,
    gate_results: approval.gateResults.map((result) => ({
      command: result.command,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      ...(result.extra ?? {}),
    })),
    confirmed_decisions: approval.confirmedDecisions,
    waived_decisions: approval.waivedDecisions.map((waived) => ({
      id: waived.id,
      reason: waived.reason,
      ...(waived.extra ?? {}),
    })),
    ...(approval.businessCommit !== undefined ? { business_commit: approval.businessCommit } : {}),
    ...(approval.extra ?? {}),
  };
}

export function serializeReviewMarkdown(meta: ReviewFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {
    schema_version: 1,
    finding_id: meta.findingId,
    title: meta.title,
    module: meta.module,
    audit_type: meta.auditType,
    issue_kind: meta.issueKind,
    depends_on: meta.dependsOn,
    priority: meta.priority,
    base_revision: meta.baseRevision,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    owner: meta.owner,
    tags: normalizeTags(meta.tags),
    ticket: meta.ticket,
    status: meta.status,
    target_files: meta.targetFiles,
    record_revision: meta.recordRevision,
    patches: meta.patches.map((entry) => ({
      id: entry.id,
      patch: entry.patch,
      option_id: entry.optionId,
      base_revision: entry.baseRevision,
      author: entry.author,
      sha256: entry.sha256,
      ...(entry.svnApprovalSource
        ? {
          svn_approval_source: {
            uuid: entry.svnApprovalSource.uuid,
            relative_url: entry.svnApprovalSource.relativeUrl,
            ...(entry.svnApprovalSource.extra ?? {}),
          },
        }
        : {}),
      ...(entry.extra ?? {}),
    })),
    options: meta.options.map((option) => ({
      id: option.id,
      title: option.title,
      tradeoff: option.tradeoff,
      confidence: option.confidence,
      current_patch: option.currentPatch,
      gate_checks: option.gateChecks,
      ...(option.extra ?? {}),
    })),
    observations: meta.observations.map((obs) => ({
      audit_id: obs.auditId,
      base_revision: obs.baseRevision,
      at: obs.at,
      verdict: obs.verdict,
      reason: obs.reason,
      evidence: obs.evidence.map((ev) => ({
        path: ev.path,
        line: ev.line,
        excerpt: ev.excerpt,
        reason: ev.reason,
        ...(ev.extra ?? {}),
      })),
      ...(obs.extra ?? {}),
    })),
    decisions: meta.decisions.map((decision) => ({
      action: decision.action,
      actor: decision.actor,
      at: decision.at,
      reason: decision.reason,
      ...(decision.reviewAfter !== undefined ? { review_after: decision.reviewAfter } : {}),
      ...(decision.reviewWhen !== undefined ? { review_when: decision.reviewWhen } : {}),
      ...(decision.category !== undefined ? { category: decision.category } : {}),
      ...(decision.relatedSymbols !== undefined ? { related_symbols: decision.relatedSymbols } : {}),
      ...(decision.extra ?? {}),
    })),
    repair_attempts: meta.repairAttempts.map((attempt) => ({
      id: attempt.id,
      option_id: attempt.optionId,
      patch_id: attempt.patchId,
      base_revision: attempt.baseRevision,
      actor: attempt.actor,
      at: attempt.at,
      apply_mode: attempt.applyMode,
      result: attempt.result,
      restored: attempt.restored,
      evidence: attempt.evidence,
      ...(attempt.extra ?? {}),
    })),
    comments: meta.comments.map((comment) => ({
      id: comment.id,
      revision: comment.revision,
      ...(comment.optionId !== undefined ? { option_id: comment.optionId } : {}),
      ...(comment.patchId !== undefined ? { patch_id: comment.patchId } : {}),
      file: comment.file,
      line: comment.line,
      ...(comment.side !== undefined ? { side: comment.side } : {}),
      author: comment.author,
      content: comment.content,
      status: comment.status,
      ...(comment.createdAt !== undefined ? { created_at: comment.createdAt } : {}),
      ...(comment.anchor
        ? {
          anchor: {
            snippet: comment.anchor.snippet,
            ...(comment.anchor.before !== undefined ? { before: comment.anchor.before } : {}),
            ...(comment.anchor.after !== undefined ? { after: comment.anchor.after } : {}),
            ...(comment.anchor.extra ?? {}),
          },
        }
        : {}),
      ...(comment.extra ?? {}),
    })),
    human_decisions: meta.humanDecisions.map((item) => ({
      id: item.id,
      question: item.question,
      ...(item.note !== undefined ? { note: item.note } : {}),
      ...(item.extra ?? {}),
    })),
    approval: meta.approval === null ? null : serializeApproval(meta.approval),
    approval_history: meta.approvalHistory.map(serializeApproval),
    rejection: meta.rejection === null
      ? null
      : {
        rejected_by: meta.rejection.rejectedBy,
        rejected_at: meta.rejection.rejectedAt,
        reason: meta.rejection.reason,
        ...(meta.rejection.category !== undefined ? { category: meta.rejection.category } : {}),
        ...(meta.rejection.relatedSymbols !== undefined ? { related_symbols: meta.rejection.relatedSymbols } : {}),
        ...(meta.rejection.extra ?? {}),
      },
    commit_message: meta.commitMessage,
    ...(meta.extra ?? {}),
  };

  const yamlText = dump(ordered, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s*$/, '');
  return `---\n${yamlText}---\n\n${normalizedBody}\n`;
}

export function parseBodySections(body: string): { sections: ReviewSections; humanJudgmentDeclared: boolean } {
  const sections: ReviewSections = {
    problem: '',
    rootCause: '',
    solution: '',
    humanJudgment: '',
    evidence: '',
    history: '',
  };
  let humanJudgmentDeclared = false;
  let current: keyof ReviewSections | null = null;
  let inFence = false;
  const buffers: Record<keyof ReviewSections, string[]> = {
    problem: [],
    rootCause: [],
    solution: [],
    humanJudgment: [],
    evidence: [],
    history: [],
  };

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) buffers[current].push(line);
      continue;
    }
    if (!inFence) {
      const heading = /^#\s+(.+?)\s*$/.exec(line);
      if (heading) {
        const title = (heading[1] ?? '').trim();
        if (/^问题与影响|^问题/.test(title)) current = 'problem';
        else if (/^根因|^根本原因/.test(title)) current = 'rootCause';
        else if (/^当前修复方案|^修复方案/.test(title)) current = 'solution';
        else if (/^需人工判断项|^人工判断/.test(title)) {
          current = 'humanJudgment';
          humanJudgmentDeclared = true;
        } else if (/^验证证据/.test(title)) current = 'evidence';
        else if (/^审核记录/.test(title)) current = 'history';
        else current = null;
        continue;
      }
    }
    if (current) buffers[current].push(line);
  }

  for (const key of Object.keys(buffers) as (keyof ReviewSections)[]) {
    sections[key] = buffers[key].join('\n').trim();
  }
  return { sections, humanJudgmentDeclared: humanJudgmentDeclared && sections.humanJudgment.trim().length > 0 };
}

export function isEmptyHumanJudgmentText(raw: string): boolean {
  const cleaned = raw.trim().replace(/^\*\*|\*\*$/g, '').trim();
  if (!cleaned) return true;
  return /^(?:无|暂无|不适用|none|n\/?a)(?:\*\*)?(?:$|[。；;：:,.，\s])/i.test(cleaned);
}

export function parseHumanJudgmentItems(sectionText: string): HumanJudgmentItem[] {
  const items: HumanJudgmentItem[] = [];
  for (const raw of sectionText.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!/^[-*]\s+/.test(line)) continue;
    const content = line.replace(/^[-*]\s+/, '').trim();
    if (isEmptyHumanJudgmentText(content)) continue;
    const sep = content.search(/[：:]/);
    if (sep < 0) {
      items.push({ label: '需人工确认', text: content });
      continue;
    }
    const label = content.slice(0, sep).replace(/^\*\*(.*)\*\*$/, '$1').trim();
    const text = content.slice(sep + 1).trim();
    if (isEmptyHumanJudgmentText(text)) continue;
    items.push({ label: label || '需人工确认', text });
  }
  return items;
}
