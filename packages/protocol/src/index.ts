export * from './review.js';

export const PROTOCOL_VERSION = 1;
export const SCHEDULED_AUDIT_ACTOR = 'system-scheduled-audit';
export const SCHEDULED_AUDIT_WAIT_MS = 30 * 60_000;
export const RETIRED_MANUAL_REVISION = 'manual-revision';

export const OPERATIONS = [
    'approve', 'comments', 'comments-batch', 'comment-status', 'takeover', 'reject', 'resume', 'rebase',
    'ai-fix', 'reopen', 'archive-stale', 'audit', 'audit-finalize',
    'audit-release', 'candidate-finalize', 'convert', 'dismiss-finding', 'finding-decision', 'sync', 'test',
] as const;

export type ManagedOperation = typeof OPERATIONS[number];
export type JsonRecord = Record<string, unknown>;
export type CommandState = 'queued' | 'dispatched' | 'accepted' | 'executing' | 'completed' | 'recovery_required';
export type DeliveryState = 'not_required' | 'pending' | 'delivered' | 'conflict' | 'unknown';

export interface Actor {
    userId: string;
    reviewIdentity: string;
}

export interface Guard {
    expectedRevision: number;
    expectedOwner: string;
    expectedUpdatedAt: string;
}

export interface ScheduledAudit {
    scheduledAt: string;
    expiresAt: string;
}

export interface ManagedCommand {
    commandId: string;
    requestHash: string;
    projectId: string;
    nodeId: string;
    bindingGeneration: number;
    projectConfigRevision: number;
    operation: ManagedOperation | typeof RETIRED_MANUAL_REVISION;
    actor: Actor;
    payload: JsonRecord;
    guard?: Guard;
    scheduledAudit?: ScheduledAudit;
    createdAt: string;
}

export interface DeliveryResult {
    state: DeliveryState;
    commitRevision?: string;
    reason?: string;
}

export interface ManagedResult {
    outcome: JsonRecord & { status: string };
    delivery: DeliveryResult;
}

export function retiredManualRevisionResult(): ManagedResult {
    return { outcome: { status: 'ABORTED', reason: 'CANCELLED', message: '人工补丁提交已撤除' }, delivery: { state: 'not_required' } };
}

export interface CommandRecord extends ManagedCommand {
    state: CommandState;
    cancelRequested: boolean;
    updatedAt: string;
    result?: ManagedResult;
}

export interface WorkspaceRegistration {
    workspaceId: string;
    label: string;
    vcsType: 'git' | 'svn';
    target: string;
    executionConfigHash?: string;
    supportsScheduledAudit?: true;
    auditSelfTest?: true;
    findingWorkflow?: true;
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
    lastSeenAt: string | null;
    enabled: boolean;
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
    enabled: boolean;
    executionConfigHash?: string;
}

export interface ArtifactManifest {
    hash: string;
    size: number;
}

export interface ProjectSnapshot {
    findingWorkflow?: boolean;
    projectId: string;
    bindingGeneration: number;
    projectConfigRevision: number;
    snapshotSequence: number;
    vcsSnapshot: string;
    collectedAt: string;
    queue: JsonRecord[];
    findings: JsonRecord[];
    audits: JsonRecord[];
    errors: unknown[];
    artifacts?: ArtifactManifest[];
}

export type QueryKind = 'candidate' | 'patch' | 'diff' | 'audit' | 'reviewers';

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

export interface NodeEvent {
    commandId: string;
    sequence: number;
    type: 'accepted' | 'progress' | 'result' | 'recovery_required';
    logs?: string[];
    result?: ManagedResult;
}

export class ProtocolError extends Error {
    constructor(field: string) {
        super(`无效协议字段：${field}`);
        this.name = 'ProtocolError';
    }
}

export function record(value: unknown, field: string): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(field);
    return value as JsonRecord;
}

export function textValue(value: unknown, field: string, max = 256): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProtocolError(field);
    return value;
}

export function entityId(value: unknown, field: string): string {
    const id = textValue(value, field, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new ProtocolError(field);
    return id;
}

export function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ProtocolError(field);
    return value;
}

export function timestamp(value: unknown, field: string): string {
    const result = textValue(value, field, 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) throw new ProtocolError(field);
    return result;
}

export function validateCommand(value: unknown, allowRetiredManualRevision = false): ManagedCommand {
    const input = record(value, 'command');
    entityId(input.commandId, 'commandId');
    if (typeof input.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new ProtocolError('requestHash');
    entityId(input.projectId, 'projectId');
    entityId(input.nodeId, 'nodeId');
    positiveInteger(input.bindingGeneration, 'bindingGeneration');
    positiveInteger(input.projectConfigRevision, 'projectConfigRevision');
    const operation = input.operation as ManagedCommand['operation'];
    if (operation === RETIRED_MANUAL_REVISION ? !allowRetiredManualRevision : !OPERATIONS.includes(operation)) throw new ProtocolError('operation');
    const actor = record(input.actor, 'actor');
    entityId(actor.userId, 'actor.userId');
    textValue(actor.reviewIdentity, 'actor.reviewIdentity', 160);
    const payload = record(input.payload, 'payload');
    if (operation !== RETIRED_MANUAL_REVISION) validatePayload(operation, payload);
    if (input.scheduledAudit !== undefined) {
        const schedule = record(input.scheduledAudit, 'scheduledAudit');
        const start = timestamp(schedule.scheduledAt, 'scheduledAudit.scheduledAt');
        const expiry = timestamp(schedule.expiresAt, 'scheduledAudit.expiresAt');
        if (input.operation !== 'audit' || actor.userId !== SCHEDULED_AUDIT_ACTOR || (input.payload as JsonRecord).targetPath !== '.'
            || Date.parse(expiry) - Date.parse(start) !== SCHEDULED_AUDIT_WAIT_MS) throw new ProtocolError('scheduledAudit');
    } else if (actor.userId === SCHEDULED_AUDIT_ACTOR) {
        throw new ProtocolError('scheduledAudit');
    }
    timestamp(input.createdAt, 'createdAt');
    const needsGuard = !['audit', 'audit-finalize', 'audit-release', 'candidate-finalize', 'convert', 'dismiss-finding', 'finding-decision', 'sync', 'test'].includes(String(input.operation));
    if (needsGuard || input.guard !== undefined) {
        const guard = record(input.guard, 'guard');
        positiveInteger(guard.expectedRevision, 'guard.expectedRevision');
        textValue(guard.expectedOwner, 'guard.expectedOwner', 160);
        timestamp(guard.expectedUpdatedAt, 'guard.expectedUpdatedAt');
    }
    return structuredClone(input) as unknown as ManagedCommand;
}

function validatePayload(operation: ManagedOperation, payload: JsonRecord): void {
    const fields: Record<ManagedOperation, string[]> = {
        approve: ['id', 'confirmedDecisions', 'waivedDecisions', 'commitMessage', 'commitDetail', 'expectedFindingVersion'], comments: ['id', 'content', 'revision', 'file', 'line', 'side', 'anchor'],
        'comments-batch': ['id', 'comments'], 'comment-status': ['id', 'commentId', 'status'], takeover: ['id'], reject: ['id', 'reason', 'category'], resume: ['id'],
        rebase: ['id'], 'ai-fix': ['id'], reopen: ['id', 'from', 'reason'], 'archive-stale': ['id'],
        audit: ['targetPath', 'note', 'findingWorkflow'], 'audit-finalize': ['auditId'], 'audit-release': ['auditId', 'confirmStopped'], 'candidate-finalize': ['id'],
        convert: ['auditId', 'findingId', 'candidateId'], 'dismiss-finding': ['auditId', 'findingId', 'reason'], sync: [], test: [],
        'finding-decision': ['findingId', 'expectedFindingVersion', 'action', 'reason', 'reviewAfter', 'reviewWhen', 'hint'],
    };
    for (const key of Object.keys(payload)) if (!fields[operation].includes(key)) throw new ProtocolError(`payload.${key}`);
    for (const key of ['id', 'from', 'candidateId']) if (payload[key] !== undefined && (typeof payload[key] !== 'string' || !/^\d{4}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(payload[key]))) throw new ProtocolError(`payload.${key}`);
    if (payload.auditId !== undefined && (typeof payload.auditId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(payload.auditId))) throw new ProtocolError('payload.auditId');
    for (const key of ['content', 'file', 'side', 'commentId', 'status', 'reason', 'category', 'targetPath', 'note', 'findingId', 'commitMessage', 'commitDetail',
        'expectedFindingVersion', 'action', 'reviewAfter', 'reviewWhen', 'hint']) {
        if (payload[key] !== undefined && typeof payload[key] !== 'string') throw new ProtocolError(`payload.${key}`);
    }
    if (payload.revision !== undefined) positiveInteger(payload.revision, 'payload.revision');
    if (payload.line !== undefined && (typeof payload.line !== 'number' || !Number.isSafeInteger(payload.line) || payload.line < 0 || (payload.file && payload.line === 0))) throw new ProtocolError('payload.line');
    for (const key of ['comments', 'confirmedDecisions', 'waivedDecisions']) if (payload[key] !== undefined && !Array.isArray(payload[key])) throw new ProtocolError(`payload.${key}`);
    if (payload.confirmStopped !== undefined && typeof payload.confirmStopped !== 'boolean') throw new ProtocolError('payload.confirmStopped');
    if (payload.findingWorkflow !== undefined && payload.findingWorkflow !== true) throw new ProtocolError('payload.findingWorkflow');
}

export function validateSnapshot(value: unknown): ProjectSnapshot {
    const input = record(value, 'snapshot');
    if (input.findingWorkflow !== undefined && typeof input.findingWorkflow !== 'boolean') throw new ProtocolError('findingWorkflow');
    entityId(input.projectId, 'projectId');
    positiveInteger(input.bindingGeneration, 'bindingGeneration');
    positiveInteger(input.projectConfigRevision, 'projectConfigRevision');
    positiveInteger(input.snapshotSequence, 'snapshotSequence');
    textValue(input.vcsSnapshot, 'vcsSnapshot');
    timestamp(input.collectedAt, 'collectedAt');
    for (const key of ['queue', 'findings', 'audits', 'errors']) {
        if (!Array.isArray(input[key])) throw new ProtocolError(key);
    }
    for (const key of ['queue', 'findings', 'audits']) {
        for (const item of input[key] as unknown[]) record(item, key);
    }
    if (input.artifacts !== undefined) {
        if (!Array.isArray(input.artifacts)) throw new ProtocolError('artifacts');
        for (const item of input.artifacts) {
            const artifact = record(item, 'artifact');
            if (typeof artifact.hash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.hash)) throw new ProtocolError('artifact.hash');
            if (typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new ProtocolError('artifact.size');
        }
    }
    return structuredClone(input) as unknown as ProjectSnapshot;
}

export function validateRegistration(value: unknown): NodeRegistration {
    const input = record(value, 'registration');
    if (Object.keys(input).some(key => !['protocolVersion', 'instanceId', 'pluginVersion', 'dshVersion', 'platform', 'workspaces'].includes(key))) throw new ProtocolError('registration');
    positiveInteger(input.protocolVersion, 'protocolVersion');
    entityId(input.instanceId, 'instanceId');
    for (const key of ['pluginVersion', 'dshVersion', 'platform']) textValue(input[key], key);
    if (!Array.isArray(input.workspaces)) throw new ProtocolError('workspaces');
    const ids = new Set<string>();
    for (const item of input.workspaces) {
        const workspace = record(item, 'workspace');
        if (Object.keys(workspace).some(key => !['workspaceId', 'label', 'vcsType', 'target', 'executionConfigHash', 'supportsScheduledAudit', 'findingWorkflow', 'auditSelfTest'].includes(key))) throw new ProtocolError('workspace');
        const id = entityId(workspace.workspaceId, 'workspaceId');
        if (ids.has(id)) throw new ProtocolError('重复 workspaceId');
        ids.add(id);
        textValue(workspace.label, 'workspace.label');
        if (workspace.vcsType !== 'git' && workspace.vcsType !== 'svn') throw new ProtocolError('workspace.vcsType');
        textValue(workspace.target, 'workspace.target');
        if (workspace.executionConfigHash !== undefined && (typeof workspace.executionConfigHash !== 'string' || !/^[a-f0-9]{64}$/.test(workspace.executionConfigHash))) throw new ProtocolError('workspace.executionConfigHash');
        if (workspace.auditSelfTest !== undefined && workspace.auditSelfTest !== true) throw new ProtocolError('workspace.auditSelfTest');
        if (workspace.supportsScheduledAudit !== undefined && workspace.supportsScheduledAudit !== true) throw new ProtocolError('workspace.supportsScheduledAudit');
        if (workspace.findingWorkflow !== undefined && workspace.findingWorkflow !== true) throw new ProtocolError('workspace.findingWorkflow');
    }
    return structuredClone(input) as unknown as NodeRegistration;
}
