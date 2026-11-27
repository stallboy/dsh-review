export * from './review.js';
export * from './diff.js';
export * from './filter.js';
import type { CandidateSummary, IssueFindingView } from './review.js';

export const PROTOCOL_VERSION = 1;
export const SCHEDULED_AUDIT_WAIT_MS = 30 * 60_000;
export const SCHEDULED_AUDIT_ACTOR = 'system-scheduled-audit';

export const OPERATIONS = [
  'comments',
  'comments-batch',
  'comment-status',
  'takeover',
  'resume',
  'approve',
  'ai-fix',
  'rebase',
  'finding-decision',
  'reviewers-init',
  'audit',
  'audit-finalize',
  'audit-release',
  'candidate-finalize',
  'audit-self-test',
  'sync',
] as const;

export type Operation = (typeof OPERATIONS)[number];
export type ManagedOperation = Operation;

export const QUERY_KINDS = ['candidate', 'diff', 'patch', 'audit', 'reviewers', 'findings'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export class ProtocolError extends Error {
  constructor(readonly code: string, message = code, readonly status = 422) {
    super(message);
  }
}

export interface Actor {
  userId: string;
  reviewIdentity: string;
}

export type AuditRecurrence =
  | { kind: 'daily' }
  | { kind: 'weekly'; weekdays: number[] }
  | { kind: 'interval'; days: number; startDate: string };

export interface AuditPlanSettings {
  name: string;
  enabled: boolean;
  startTime: string;
  timeZone: string;
  recurrence: AuditRecurrence;
  note: string;
}

export interface ScheduledAudit {
  scheduledAt: string;
  expiresAt: string;
}

export interface CommandGuard {
  expectedRevision: number;
  expectedOwner: string;
  expectedUpdatedAt: string;
}

export interface ManagedCommand {
  commandId: string;
  requestHash: string;
  projectId: string;
  nodeId: string;
  bindingGeneration: number;
  projectConfigRevision: number;
  actor: Actor;
  operation: Operation;
  payload: JsonRecord;
  guard?: CommandGuard;
  scheduledAudit?: ScheduledAudit;
  createdAt: string;
}

export interface ManagedQuery {
  queryId: string;
  projectId: string;
  bindingGeneration: number;
  vcsSnapshot: string;
  kind: QueryKind;
  params: JsonRecord;
}

export interface ManagedQueryResult {
  queryId: string;
  vcsSnapshot: string;
  status: 'ready' | 'snapshot_moved' | 'error';
  data?: unknown;
  error?: string;
}

export interface WorkspaceRegistration {
  workspaceId: string;
  label: string;
  vcsType: 'git' | 'svn';
  target: string;
  executionConfigHash?: string;
  auditSelfTest?: boolean;
  supportsScheduledAudit?: boolean;
  scheduledAuditNotes?: boolean;
  stageExecutors?: string[];
}

export interface NodeRegistration {
  protocolVersion: number;
  instanceId: string;
  pluginVersion: string;
  dshVersion: string;
  platform: string;
  workspaces: WorkspaceRegistration[];
}

export interface NodeRecord extends NodeRegistration {
  nodeId: string;
  name: string;
  enabled: boolean;
  lastSeenAt: string | null;
  online: boolean;
  compatible: boolean;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  nodeId: string;
  workspaceId: string;
  bindingGeneration: number;
  projectConfigRevision: number;
  vcsType: 'git' | 'svn';
  target: string;
  executionConfigHash?: string;
  enabled: boolean;
}

export interface AuditSummary {
  auditId: string;
  createdAt: string;
  baseRevision: string;
  scope: string;
  trigger: 'manual' | 'scheduled';
  issueCount: number;
  issues: string[];
}

export interface ProjectSnapshot {
  projectId: string;
  bindingGeneration: number;
  projectConfigRevision: number;
  vcsSnapshot: string;
  snapshotSequence: number;
  collectedAt: string;
  currentBase: string | null;
  counts: Record<string, number>;
  queue: CandidateSummary[];
  audits: AuditSummary[];
  findings: IssueFindingView[];
  errors: string[];
  artifacts?: { hash: string; size: number }[];
}

export interface PendingCommandSummary {
  commandId: string;
  projectId: string;
  operation: string;
  state: 'queued' | 'dispatched' | 'accepted' | 'executing' | 'recovery_required';
  detail?: string;
}

export interface CommandRecord extends ManagedCommand {
  state: 'queued' | 'dispatched' | 'accepted' | 'executing' | 'completed' | 'recovery_required';
  cancelRequested: boolean;
  updatedAt: string;
  result?: ManagedResult;
}

export interface ManagedResult {
  outcome: JsonRecord & { status: string };
  delivery: {
    state: 'not_required' | 'pending' | 'delivered' | 'conflict' | 'unknown';
    commitRevision?: string;
    reason?: string;
  };
}

export interface NodeEvent {
  commandId: string;
  sequence: number;
  type: 'accepted' | 'progress' | 'result' | 'recovery_required';
  at?: string;
  logs?: string[];
  result?: ManagedResult;
  auditTimeoutStopping?: true;
  event?: JsonRecord;
}

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('bad_request', `无效协议字段：${field}`);
  }
  return value as JsonRecord;
}

export function textValue(value: unknown, field: string, max = 400): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ProtocolError('bad_request', `无效协议字段：${field}`);
  }
  return value.trim();
}

export function entityId(value: unknown, field: string): string {
  const id = textValue(value, field, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new ProtocolError('bad_request', `无效协议字段：${field}`);
  }
  return id;
}

export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError('bad_request', `无效协议字段：${field}`);
  }
  return value;
}

export function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError('bad_request', `无效协议字段：${field}`);
  }
  return value;
}

export function validateRegistration(value: unknown): NodeRegistration {
  const input = record(value, 'registration');
  const protocolVersion = positiveInteger(input.protocolVersion, 'protocolVersion');
  const instanceId = entityId(input.instanceId, 'instanceId');
  const pluginVersion = textValue(input.pluginVersion, 'pluginVersion', 64);
  const dshVersion = textValue(input.dshVersion, 'dshVersion', 64);
  const platform = textValue(input.platform, 'platform', 64);
  if (!Array.isArray(input.workspaces)) throw new ProtocolError('bad_request', '无效协议字段：workspaces');
  const seen = new Set<string>();
  const workspaces = input.workspaces.map((item, index) => {
    const entry = record(item, 'workspace');
    const workspaceId = entityId(entry.workspaceId, 'workspaceId');
    if (seen.has(workspaceId)) throw new ProtocolError('bad_request', '无效协议字段：重复 workspaceId');
    seen.add(workspaceId);
    const rawVcsType = entry.vcsType;
    if (rawVcsType !== 'git' && rawVcsType !== 'svn') throw new ProtocolError('bad_request', '无效协议字段：workspace.vcsType');
    const vcsType: 'git' | 'svn' = rawVcsType;
    if (entry.executionConfigHash !== undefined && (typeof entry.executionConfigHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.executionConfigHash))) {
      throw new ProtocolError('bad_request', '无效协议字段：workspace.executionConfigHash');
    }
    if (entry.auditSelfTest !== undefined && typeof entry.auditSelfTest !== 'boolean') {
      throw new ProtocolError('bad_request', '无效协议字段：workspace.auditSelfTest');
    }
    if (entry.supportsScheduledAudit !== undefined && typeof entry.supportsScheduledAudit !== 'boolean') {
      throw new ProtocolError('bad_request', '无效协议字段：workspace.supportsScheduledAudit');
    }
    if (entry.scheduledAuditNotes !== undefined && typeof entry.scheduledAuditNotes !== 'boolean') {
      throw new ProtocolError('bad_request', '无效协议字段：workspace.scheduledAuditNotes');
    }
    if (entry.stageExecutors !== undefined && (!Array.isArray(entry.stageExecutors) || entry.stageExecutors.some((e) => typeof e !== 'string'))) {
      throw new ProtocolError('bad_request', '无效协议字段：workspace.stageExecutors');
    }
    return {
      workspaceId,
      label: textValue(entry.label, 'workspace.label', 160),
      vcsType,
      target: textValue(entry.target, 'workspace.target', 200),
      ...(entry.executionConfigHash ? { executionConfigHash: entry.executionConfigHash } : {}),
      ...(entry.auditSelfTest ? { auditSelfTest: true } : {}),
      ...(entry.supportsScheduledAudit ? { supportsScheduledAudit: true } : {}),
      ...(entry.scheduledAuditNotes ? { scheduledAuditNotes: true } : {}),
      ...(Array.isArray(entry.stageExecutors) ? { stageExecutors: entry.stageExecutors as string[] } : {}),
    };
  });
  return { protocolVersion, instanceId, pluginVersion, dshVersion, platform, workspaces };
}

export function validateSnapshot(value: unknown): ProjectSnapshot {
  const input = record(value, 'snapshot');
  const collectedAt = textValue(input.collectedAt, 'collectedAt', 64);
  if (Number.isNaN(Date.parse(collectedAt))) throw new ProtocolError('bad_request', 'collectedAt 格式无效');
  if (!Array.isArray(input.queue)) throw new ProtocolError('bad_request', 'snapshot.queue 必须是数组');
  if (!Array.isArray(input.audits)) throw new ProtocolError('bad_request', 'snapshot.audits 必须是数组');
  if (!Array.isArray(input.errors)) throw new ProtocolError('bad_request', 'snapshot.errors 必须是数组');
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const counts = input.counts === undefined ? {} : record(input.counts, 'counts');
  const normalizedCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    normalizedCounts[key] = nonNegativeInteger(count, `counts.${key}`);
  }
  const artifacts = input.artifacts === undefined ? undefined
    : !Array.isArray(input.artifacts) ? (() => { throw new ProtocolError('bad_request', 'artifacts 必须是数组'); })()
      : input.artifacts.map((item, index) => {
        const entry = record(item, `artifacts[${index}]`);
        const hash = textValue(entry.hash, 'artifact.hash', 64);
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProtocolError('bad_request', 'artifact.hash 必须是 SHA-256 摘要');
        return { hash, size: nonNegativeInteger(entry.size, 'artifact.size') };
      });
  return {
    projectId: entityId(input.projectId, 'projectId'),
    bindingGeneration: positiveInteger(input.bindingGeneration, 'bindingGeneration'),
    projectConfigRevision: positiveInteger(input.projectConfigRevision, 'projectConfigRevision'),
    vcsSnapshot: textValue(input.vcsSnapshot, 'vcsSnapshot', 512),
    snapshotSequence: positiveInteger(input.snapshotSequence, 'snapshotSequence'),
    collectedAt,
    currentBase: input.currentBase === undefined || input.currentBase === null ? null : textValue(input.currentBase, 'currentBase', 200),
    counts: normalizedCounts,
    queue: input.queue.map((item, index) => record(item, `queue[${index}]`) as unknown as CandidateSummary),
    audits: input.audits.map((item, index) => {
      const entry = record(item, `audits[${index}]`);
      const issues = Array.isArray(entry.issues) ? entry.issues.map((v, i) => textValue(v, `audits[${index}].issues[${i}]`, 200)) : [];
      return {
        auditId: textValue(entry.auditId, 'auditId', 120),
        createdAt: textValue(entry.createdAt, 'createdAt', 64),
        baseRevision: textValue(entry.baseRevision, 'baseRevision', 200),
        scope: textValue(entry.scope, 'scope', 200),
        trigger: entry.trigger === 'scheduled' ? 'scheduled' : 'manual',
        issueCount: entry.issueCount === undefined ? issues.length : nonNegativeInteger(entry.issueCount, 'issueCount'),
        issues,
      };
    }),
    findings: findings.map((item, index) => record(item, `findings[${index}]`) as unknown as IssueFindingView),
    errors: input.errors.map((item, index) => textValue(item, `errors[${index}]`, 2000)),
    ...(artifacts ? { artifacts } : {}),
  };
}

const GUARDED_OPERATIONS = new Set<Operation>([
  'comments',
  'comments-batch',
  'comment-status',
  'takeover',
  'resume',
  'approve',
  'ai-fix',
  'rebase',
  'finding-decision',
  'candidate-finalize',
]);

export function validateCommand(value: unknown): ManagedCommand {
  const input = record(value, 'command');
  const operation = input.operation as Operation;
  if (!OPERATIONS.includes(operation)) throw new ProtocolError('bad_request', `不支持的操作类型：operation=${String(input.operation)}`);
  const actorInput = record(input.actor, 'actor');
  const guardInput = input.guard === undefined ? undefined : record(input.guard, 'guard');
  if (GUARDED_OPERATIONS.has(operation) && !guardInput) {
    throw new ProtocolError('bad_request', `${operation} 缺少必需的 guard`);
  }
  const guard = guardInput ? {
    expectedRevision: positiveInteger(guardInput.expectedRevision, 'guard.expectedRevision'),
    expectedOwner: textValue(guardInput.expectedOwner, 'guard.expectedOwner', 160),
    expectedUpdatedAt: textValue(guardInput.expectedUpdatedAt, 'guard.expectedUpdatedAt', 64),
  } : undefined;
  const payload = record(input.payload, 'payload');
  if ('owner' in payload && operation !== 'takeover') {
    throw new ProtocolError('bad_request', '禁止在 payload.owner 伪造负责人');
  }
  if ('patchText' in payload) {
    throw new ProtocolError('bad_request', '不支持 payload.patchText');
  }
  if (operation === 'comments') {
    const file = typeof payload.file === 'string' ? payload.file : '';
    const line = payload.line === undefined ? 0 : Number(payload.line);
    if (file !== '' && (!Number.isSafeInteger(line) || line <= 0)) {
      throw new ProtocolError('bad_request', '行内评论的 payload.line 必须是正整数');
    }
    if (file === '' && line !== 0) {
      throw new ProtocolError('bad_request', '总体评论的 payload.line 必须为 0');
    }
  }
  const scheduledInput = input.scheduledAudit === undefined ? undefined : record(input.scheduledAudit, 'scheduledAudit');
  const scheduledAudit = scheduledInput ? {
    scheduledAt: textValue(scheduledInput.scheduledAt, 'scheduledAudit.scheduledAt', 64),
    expiresAt: textValue(scheduledInput.expiresAt, 'scheduledAudit.expiresAt', 64),
  } : undefined;
  if (scheduledAudit) {
    if (operation !== 'audit') throw new ProtocolError('bad_request', '定时审查参数只适用于 audit 操作');
    const scheduled = Date.parse(scheduledAudit.scheduledAt);
    const expires = Date.parse(scheduledAudit.expiresAt);
    if (!Number.isFinite(scheduled) || !Number.isFinite(expires) || expires - scheduled !== SCHEDULED_AUDIT_WAIT_MS) {
      throw new ProtocolError('bad_request', 'scheduledAudit 窗口无效');
    }
  }
  return {
    commandId: entityId(input.commandId, 'commandId'),
    requestHash: textValue(input.requestHash, 'requestHash', 128),
    projectId: entityId(input.projectId, 'projectId'),
    nodeId: entityId(input.nodeId, 'nodeId'),
    bindingGeneration: positiveInteger(input.bindingGeneration, 'bindingGeneration'),
    projectConfigRevision: positiveInteger(input.projectConfigRevision, 'projectConfigRevision'),
    actor: { userId: textValue(actorInput.userId, 'actor.userId', 128), reviewIdentity: textValue(actorInput.reviewIdentity, 'actor.reviewIdentity', 160) },
    operation,
    payload,
    ...(guard ? { guard } : {}),
    ...(scheduledAudit ? { scheduledAudit } : {}),
    createdAt: textValue(input.createdAt, 'createdAt', 64),
  };
}
