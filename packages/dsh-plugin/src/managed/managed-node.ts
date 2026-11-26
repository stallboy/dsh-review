import { createHash, randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, RETIRED_MANUAL_REVISION, retiredManualRevisionResult, validateCommand, type CommandRecord, type ManagedCommand, type ManagedQuery,
    type ManagedQueryResult, type ManagedResult, type ProjectRecord, type ProjectSnapshot, type WorkspaceRegistration } from '@dsh-review/protocol';
import { ManagedJournal } from './managed-journal.js';

export interface ManagedNodeOptions {
    config: {
        centerUrl: string;
        nodeId: string;
        token: string;
        instanceId?: string;
        pluginVersion?: string;
        dshVersion?: string;
        workspaces: WorkspaceRegistration[];
        pauseAdmission?: boolean;
    };
    journal: ManagedJournal;
    execute(command: ManagedCommand, signal: AbortSignal, emit: (line: string) => void, project: ProjectRecord,
        reportStopping?: (line: string) => Promise<void>, nodeShutdown?: AbortSignal): Promise<ManagedResult>;
    read(query: ManagedQuery, project: ProjectRecord): Promise<ManagedQueryResult>;
    snapshot?: (project: ProjectRecord) => Promise<Pick<ProjectSnapshot, 'vcsSnapshot' | 'queue' | 'findings' | 'audits' | 'errors'>>;
    recover?: (command: ManagedCommand, previous: ManagedResult | undefined, project: ProjectRecord) => Promise<ManagedResult>;
    initializeWorkspaces?: () => Promise<void>;
    workspaceIssues?: () => { workspaceId: string; message: string }[];
    refreshWorkspaceIssues?: (projects: ProjectRecord[]) => Promise<void>;
    fetch?: typeof globalThis.fetch;
    clock?: () => Date;
    onError?: (error: Error) => void;
}

interface PollResult {
    commands: ManagedCommand[];
    cancellations: string[];
    recoveries: string[];
    projects: ProjectRecord[];
    queries: ManagedQuery[];
}

const registrationFailures = {
    instance_conflict: '相同节点已有活动实例',
    binding_mismatch: '既有项目的工作副本目标不能变更',
    configuration_required: '节点必须继续提供已登记的执行配置摘要',
    project_busy: '项目有未决操作，不能更改执行配置',
};
const registrationFields = ['registration', 'protocolVersion', 'instanceId', 'pluginVersion', 'dshVersion', 'platform', 'workspaces',
    'workspace', 'workspaceId', '重复 workspaceId', 'workspace.label', 'workspace.vcsType', 'workspace.target', 'workspace.executionConfigHash',
    'workspace.supportsScheduledAudit'];

export class NodeRegistrationError extends Error {
    readonly code: keyof typeof registrationFailures | 'registration_rejected' | 'workspace_rejected' | 'registration_field_invalid';

    constructor(readonly status?: number, rejection?: keyof typeof registrationFailures, readonly protocolField?: string) {
        super(protocolField ? `无效协议字段：${protocolField}`
            : rejection ? registrationFailures[rejection] : status ? '中央服务器拒绝注册节点' : '节点注册请求失败');
        this.code = rejection ?? (protocolField === 'workspace' ? 'workspace_rejected' : protocolField ? 'registration_field_invalid' : 'registration_rejected');
    }
}

export function managedCenterUrl(value: string): URL {
    const url = new URL(value.replace(/\/?$/, '/'));
    if (url.username || url.password || url.search || url.hash) throw new Error('中央地址不能包含凭据、查询参数或片段');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('跨机器节点通信必须使用 HTTPS');
    return url;
}

export class ManagedNode {
    private readonly centerUrl: URL;
    readonly instanceId: string;
    private readonly transport: typeof globalThis.fetch;
    private readonly clock: () => Date;
    private readonly shutdown = new AbortController();
    private readonly active = new Map<string, { projectId: string; controller: AbortController; promise: Promise<void> }>();
    private readonly background = new Map<string, { projectId: string; promise: Promise<void> }>();
    private readonly lastSync = new Map<string, number>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private registered = false;
    private registrationKey = '';
    private capabilities?: { executionConfigHash: boolean; workspaceIssues: boolean; findingWorkflow: boolean; issueWorkflow: boolean; auditSelfTest: boolean };
    private nextCapabilityCheck = 0;
    private workspaceCheck: Promise<void> | undefined;
    private initialized = false;
    private ticking: Promise<void> | null = null;
    private stopping = false;

    constructor(private readonly options: ManagedNodeOptions) {
        this.centerUrl = managedCenterUrl(options.config.centerUrl);
        this.instanceId = options.config.instanceId ?? randomUUID();
        this.transport = options.fetch ?? globalThis.fetch;
        this.clock = options.clock ?? (() => new Date());
    }

    private async request<T>(pathname: string, payload: unknown): Promise<T> {
        const url = new URL(pathname.replace(/^\//, ''), this.centerUrl);
        const response = await this.transport(url, {
            method: 'POST', headers: { authorization: `Bearer ${this.options.config.token}`, 'content-type': 'application/json',
                ...(pathname === '/node-api/v1/register' && this.options.config.pauseAdmission ? { 'x-dsh-review-admission': 'paused' } : {}) },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            if (response.status === 401 || response.status === 409) this.registered = false;
            const result = await response.json().catch(() => null) as { error?: { code?: unknown; message?: string } } | null;
            if (pathname === '/node-api/v1/register') {
                const code = result?.error?.code;
                const field = response.status === 422 ? registrationFields.find(field => `无效协议字段：${field}` === result?.error?.message) : undefined;
                const rejection = response.status === 409 && typeof code === 'string' && Object.hasOwn(registrationFailures, code)
                    ? code as keyof typeof registrationFailures : undefined;
                throw new NodeRegistrationError(response.status, rejection, field);
            }
            const message = result?.error?.message;
            throw new Error(typeof message === 'string' && this.options.config.token
                ? message.replaceAll(this.options.config.token, '[已隐藏]') : `中央通信失败（${response.status}）`);
        }
        return await response.json() as T;
    }

    async start(): Promise<void> {
        this.timer = setInterval(() => { void this.tick().catch(error => this.options.onError?.(error instanceof Error ? error : new Error(String(error)))); }, 2000);
        this.timer.unref?.();
        void this.tick().catch(error => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
    }

    completeConfiguration(): void {
        this.options.config.pauseAdmission = false;
    }

    async tick(): Promise<void> {
        if (this.stopping) return;
        if (this.ticking) return this.ticking;
        const task = this.cycle();
        this.ticking = task;
        try { await task; }
        finally { this.ticking = null; }
    }

    private async refreshCapabilities(): Promise<void> {
        if (!this.options.workspaceIssues || (this.registered && this.clock().getTime() < this.nextCapabilityCheck)) return;
        const url = new URL('api/v1/info', this.centerUrl);
        const info = await this.transport(url, { signal: AbortSignal.timeout(3000) }).then(async response => {
            if (!response.ok) throw new Error('无法读取中央服务器协议能力');
            const data = await response.json() as { protocolVersion?: number; registrationCapabilities?: {
                executionConfigHash?: boolean; workspaceIssues?: boolean; findingWorkflow?: boolean; issueWorkflow?: boolean; auditSelfTest?: boolean;
            } };
            if (typeof data?.protocolVersion !== 'number') throw new Error('中央服务器协议能力响应无效');
            return data;
        }).catch(error => {
            if (!this.capabilities) throw error;
        });
        this.nextCapabilityCheck = this.clock().getTime() + 10000;
        if (!info) return;
        if (info.protocolVersion !== PROTOCOL_VERSION) {
            this.registered = false;
            this.capabilities = undefined;
            throw new Error('中央协议版本不兼容');
        }
        this.capabilities = { executionConfigHash: info.registrationCapabilities?.executionConfigHash === true,
            workspaceIssues: info.registrationCapabilities?.workspaceIssues === true,
            findingWorkflow: info.registrationCapabilities?.findingWorkflow === true,
            issueWorkflow: info.registrationCapabilities?.issueWorkflow === true,
            auditSelfTest: info.registrationCapabilities?.auditSelfTest === true };
    }

    private async cycle(): Promise<void> {
        const { config, journal } = this.options;
        if (!this.initialized) {
            await this.options.initializeWorkspaces?.();
            for (const saved of journal.interrupted()) {
                const checkpoint = journal.recoveryData(saved.command.commandId);
                if (saved.command.operation === 'test') {
                    journal.emit(saved.command.commandId, 'result', undefined,
                        checkpoint?.result as ManagedResult | undefined ?? {
                            outcome: { status: 'ABORTED', reason: 'NODE_RESTARTED', step: checkpoint?.step ?? 'coordinator',
                                message: '节点在自检期间重启，请重新发起自检' },
                            delivery: { state: 'not_required' },
                        });
                    continue;
                }
                if (checkpoint?.timeoutStopping === true) {
                    journal.emit(saved.command.commandId, 'progress', ['节点重启，尚无本轮主会话和进程树的停止证据，保留执行中与审查占用。']);
                    continue;
                }
                const { sessionId, auditId } = checkpoint ?? {};
                journal.emit(saved.command.commandId, 'recovery_required', undefined, {
                    outcome: { status: 'RECOVERY_REQUIRED', reason: 'NODE_RESTARTED', detail: '节点中断过执行，必须核验 VCS 与工作副本，不能直接重跑',
                        ...(typeof sessionId === 'string' && typeof auditId === 'string' ? { sessionId, auditId } : {}) },
                    delivery: { state: 'unknown' },
                });
            }
            this.initialized = true;
        }
        await this.refreshCapabilities();
        const { workspaces } = config;
        const workspaceIssues = this.options.workspaceIssues?.() ?? [];
        const unavailable = new Map(workspaceIssues.map(issue => [issue.workspaceId, issue.message]));
        const declaredWorkspaces = workspaces.filter(workspace => !unavailable.has(workspace.workspaceId))
            .map(({ supportsScheduledAudit: _scheduled, executionConfigHash, auditSelfTest, ...workspace }) =>
                ({ ...workspace, ...(this.capabilities?.executionConfigHash === false ? {} : { executionConfigHash }),
                    ...(this.capabilities?.findingWorkflow ? { findingWorkflow: true } : {}),
                    ...(this.capabilities?.issueWorkflow ? { issueWorkflow: true } : {}),
                    ...(this.capabilities?.auditSelfTest && auditSelfTest ? { auditSelfTest: true } : {}) }));
        const registrationKey = JSON.stringify(declaredWorkspaces);
        if (!this.registered || this.registrationKey !== registrationKey) {
            await this.request('/node-api/v1/register', { protocolVersion: PROTOCOL_VERSION, instanceId: this.instanceId,
                pluginVersion: config.pluginVersion ?? '0.3.0', dshVersion: config.dshVersion ?? 'unknown',
                platform: process.platform, workspaces: declaredWorkspaces, ...(this.capabilities?.workspaceIssues ? { workspaceIssues } : {}) }).catch(error => {
                throw error instanceof NodeRegistrationError ? error : new NodeRegistrationError();
            });
            this.registered = true;
            this.registrationKey = registrationKey;
        }
        const scheduledAuditWorkspaces = this.active.size || this.background.size || config.pauseAdmission ? [] :
            workspaces.filter(workspace => workspace.supportsScheduledAudit && !unavailable.has(workspace.workspaceId)).map(workspace => workspace.workspaceId);
        const poll = await this.request<PollResult>('/node-api/v1/commands/poll', { instanceId: this.instanceId, scheduledAuditWorkspaces,
            supportsScheduledAuditNotes: true,
            ...(this.capabilities?.workspaceIssues ? { workspaceIssues } : {}) });
        if (this.stopping) return;
        if (this.options.refreshWorkspaceIssues && !this.workspaceCheck) {
            this.workspaceCheck = this.options.refreshWorkspaceIssues(poll.projects).finally(() => { this.workspaceCheck = undefined; });
        }
        for (const commandId of poll.cancellations) this.active.get(commandId)?.controller.abort();
        const unconfirmed = journal.awaitingAcknowledgement().filter(command => !poll.commands.some(value => value.commandId === command.commandId));
        for (const value of [...poll.commands, ...unconfirmed]) {
            const command = validateCommand(value, true);
            if (command.nodeId !== config.nodeId) throw new Error('拒绝不属于本节点的指令');
            if (this.active.has(command.commandId)) continue;
            if (this.active.size > 0) break;
            if ([...this.background.values()].some(task => task.projectId === command.projectId)) continue;
            const saved = journal.accept(command);
            if (saved.record.phase !== 'accepted') continue;
            const project = poll.projects.find(p => p.projectId === command.projectId);
            const workspace = project && workspaces.find(w => w.workspaceId === project.workspaceId);
            const valid = project && project.nodeId === config.nodeId && workspace && project.bindingGeneration === command.bindingGeneration
                && project.projectConfigRevision === command.projectConfigRevision && workspace.vcsType === project.vcsType && workspace.target === project.target
                && (!command.scheduledAudit || workspace.supportsScheduledAudit)
                && (command.operation !== 'test' || workspace.auditSelfTest);
            const { command: acknowledged } = await this.request<{ command?: CommandRecord }>(
                `/node-api/v1/commands/${command.commandId}/ack`, { instanceId: this.instanceId, ...(command.scheduledAudit && { supportsScheduledAuditNotes: true }) });
            if (acknowledged?.state === 'completed' && acknowledged.result) {
                journal.settleBeforeExecution(command.commandId, acknowledged.result);
                continue;
            }
            if (acknowledged ? acknowledged.state !== 'accepted' : command.scheduledAudit) continue;
            if (this.stopping) return;
            const issue = project && unavailable.get(project.workspaceId);
            if (issue) {
                journal.emit(command.commandId, 'result', undefined, { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: issue,
                    ...(command.operation === 'test' ? { step: 'workspace' } : {}) }, delivery: { state: 'not_required' } });
                continue;
            }
            if (!valid) {
                journal.emit(command.commandId, 'result', undefined, { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: '节点项目绑定或执行配置不一致',
                    ...(command.operation === 'test' ? { step: 'workspace' } : {}) }, delivery: { state: 'not_required' } });
                continue;
            }
            if (command.operation === RETIRED_MANUAL_REVISION) {
                journal.emit(command.commandId, 'result', undefined, retiredManualRevisionResult());
                continue;
            }
            this.launch(command, acknowledged?.cancelRequested === true || poll.cancellations.includes(command.commandId), project);
        }
        for (const id of poll.recoveries) {
            const saved = journal.get(id);
            if (!saved || this.active.size > 0 || !this.options.recover) continue;
            const project = poll.projects.find(p => p.projectId === saved.command.projectId);
            if (!project) continue;
            if ([...this.background.values()].some(task => task.projectId === project.projectId)) continue;
            const controller = new AbortController();
            const promise = Promise.resolve().then(async () => {
                let result: ManagedResult;
                try { result = await this.options.recover!(saved.command, saved.result, project); }
                catch (error) {
                    result = { outcome: saved.result?.outcome ?? { status: 'RECOVERY_REQUIRED', reason: 'RECOVERY_EXCEPTION' },
                        delivery: { ...saved.result?.delivery, state: 'unknown', reason: error instanceof Error ? error.message : '核验失败' } };
                }
                journal.emit(id, 'result', undefined, result);
                this.lastSync.delete(saved.command.projectId);
            }).finally(() => this.active.delete(id));
            this.active.set(id, { projectId: project.projectId, controller, promise });
        }
        for (const query of poll.queries) {
            if (poll.commands.some(command => command.projectId === query.projectId)) continue;
            if ([...this.active.values()].some(task => task.projectId === query.projectId)) continue;
            const project = poll.projects.find(p => p.projectId === query.projectId);
            if (!project) continue;
            this.track(query.projectId, `query:${query.queryId}`, async () => {
                let result: ManagedQueryResult;
                try {
                    if (unavailable.has(project.workspaceId)) throw new Error(unavailable.get(project.workspaceId));
                    result = await this.options.read(query, project);
                }
                catch (error) { result = { queryId: query.queryId, vcsSnapshot: query.vcsSnapshot, status: 'error', error: error instanceof Error ? error.message : '查询失败' }; }
                if (result.status === 'ready') {
                    const bytes = Buffer.from(JSON.stringify(result.data ?? null), 'utf8');
                    if (bytes.length > 8 * 1024 * 1024) result = { queryId: query.queryId, vcsSnapshot: query.vcsSnapshot, status: 'error', error: '详情超过 8 MiB，请缩小评审范围或拆分候选' };
                    else if (bytes.length > 256 * 1024) {
                        const hash = createHash('sha256').update(bytes).digest('hex');
                        const response = await this.transport(new URL(`node-api/v1/artifacts/${hash}`, config.centerUrl.replace(/\/?$/, '/')), {
                            method: 'PUT', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/octet-stream' }, body: bytes,
                            signal: AbortSignal.timeout(30000),
                        });
                        if (!response.ok) throw new Error(`详情附件上传失败（${response.status}）`);
                        result = { ...result, data: { type: 'central-artifact', hash, size: bytes.length } };
                    }
                }
                await this.request('/node-api/v1/queries/results', { instanceId: this.instanceId, results: [result] });
            });
        }
        if (this.options.snapshot) {
            for (const project of poll.projects.filter(p => p.enabled && !unavailable.has(p.workspaceId))) {
                if (poll.commands.some(command => command.projectId === project.projectId)) continue;
                if ([...this.active.values()].some(task => task.projectId === project.projectId)) continue;
                if (this.clock().getTime() - (this.lastSync.get(project.projectId) ?? 0) < 10000) continue;
                this.track(project.projectId, `snapshot:${project.projectId}`, async () => {
                    const content = await this.options.snapshot!(project);
                    if (!this.capabilities?.issueWorkflow && content.queue.some(item => Number(item['schemaVersion']) >= 3)) {
                        throw new Error('中央不支持 schema3 问题记录，拒绝降级同步，请升级中央服务');
                    }
                    const snapshot: ProjectSnapshot = { ...content, projectId: project.projectId, bindingGeneration: project.bindingGeneration,
                        projectConfigRevision: project.projectConfigRevision, snapshotSequence: journal.nextSnapshotSequence(project.projectId), collectedAt: this.clock().toISOString() };
                    await this.request('/node-api/v1/snapshots', { instanceId: this.instanceId, snapshot: {
                        ...snapshot, ...(this.capabilities?.findingWorkflow ? { findingWorkflow: true } : {}),
                    ...(this.capabilities?.issueWorkflow ? { issueWorkflow: true } : {}),
                    } });
                    this.lastSync.set(project.projectId, this.clock().getTime());
                });
            }
        }
        await this.flush();
    }

    private launch(command: ManagedCommand, cancelled: boolean, project: ProjectRecord): void {
        if (this.stopping) return;
        const controller = new AbortController();
        if (cancelled) controller.abort();
        this.options.journal.markExecuting(command.commandId);
        this.options.journal.emit(command.commandId, 'progress');
        const promise = Promise.resolve().then(async () => {
            let result: ManagedResult;
            try {
                if (controller.signal.aborted) result = { outcome: { status: 'ABORTED', reason: command.operation === 'approve' ? 'COMMIT_FAILED' : 'CANCELLED', message: '执行前已取消，没有产生副作用',
                    ...(command.operation === 'test' ? { step: 'coordinator' } : {}) }, delivery: { state: 'not_required' } };
                else result = await this.options.execute(command, controller.signal, line => { this.options.journal.emit(command.commandId, 'progress', [line]); },
                    project, async line => {
                        this.options.journal.checkpoint(command.commandId, { ...this.options.journal.recoveryData(command.commandId), timeoutStopping: true });
                        const { sequence } = this.options.journal.emit(command.commandId, 'progress', [line], undefined, true);
                        while (this.options.journal.hasPendingEvent(command.commandId, sequence)) {
                            this.shutdown.signal.throwIfAborted();
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }, this.shutdown.signal);
            } catch (error) {
                if (this.shutdown.signal.aborted && error === this.shutdown.signal.reason) return;
                result = command.operation === 'test'
                    ? { outcome: { status: 'ABORTED', reason: 'SELF_TEST_FAILED',
                        step: this.options.journal.recoveryData(command.commandId)?.step ?? 'workspace',
                        message: error instanceof Error ? error.message : '自检执行器异常' }, delivery: { state: 'not_required' } }
                    : { outcome: { status: 'RECOVERY_REQUIRED', reason: 'EXECUTION_EXCEPTION', detail: error instanceof Error ? error.message : '执行器异常，需要核验现场' }, delivery: { state: 'unknown' } };
            }
            this.options.journal.emit(command.commandId, 'result', undefined, result);
            this.lastSync.delete(command.projectId);
        }).finally(() => { this.active.delete(command.commandId); });
        this.active.set(command.commandId, { projectId: command.projectId, controller, promise });
    }

    private track(projectId: string, key: string, task: () => Promise<void>): void {
        if (this.background.has(key)) return;
        const promise = Promise.resolve().then(task).catch(error => {
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }).finally(() => { this.background.delete(key); });
        this.background.set(key, { projectId, promise });
    }

    private async flush(): Promise<void> {
        const events = this.options.journal.pending();
        if (!events.length) return;
        const result = await this.request<{ acks: Record<string, number> }>('/node-api/v1/events', { instanceId: this.instanceId, events });
        for (const [id, sequence] of Object.entries(result.acks)) this.options.journal.acknowledge(id, sequence);
    }

    async drain(): Promise<void> {
        await Promise.all([this.workspaceCheck, ...[...this.active.values(), ...this.background.values()].map(value => value.promise)]);
    }

    async stop(flushPending = true): Promise<void> {
        this.stopping = true;
        this.shutdown.abort();
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const value of this.active.values()) value.controller.abort();
        await this.ticking?.catch(() => {});
        for (const value of this.active.values()) value.controller.abort();
        await this.drain();
        if (flushPending) await this.flush().catch(() => {});
    }
}
