import { createHash, randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, validateCommand, type JsonRecord, type ManagedCommand, type ManagedQuery,
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
    execute(command: ManagedCommand, signal: AbortSignal, emit: (line: string) => void, project: ProjectRecord): Promise<ManagedResult>;
    read(query: ManagedQuery, project: ProjectRecord): Promise<ManagedQueryResult>;
    snapshot?: (project: ProjectRecord) => Promise<Pick<ProjectSnapshot, 'vcsSnapshot' | 'queue' | 'findings' | 'audits' | 'errors'>>;
    recover?: (command: ManagedCommand, previous: ManagedResult | undefined, project: ProjectRecord) => Promise<ManagedResult>;
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

export class ManagedNode {
    readonly instanceId: string;
    private readonly transport: typeof globalThis.fetch;
    private readonly clock: () => Date;
    private readonly active = new Map<string, { projectId: string; controller: AbortController; promise: Promise<void> }>();
    private readonly background = new Map<string, { projectId: string; promise: Promise<void> }>();
    private readonly lastSync = new Map<string, number>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private registered = false;
    private initialized = false;
    private ticking: Promise<void> | null = null;
    private stopping = false;

    constructor(private readonly options: ManagedNodeOptions) {
        const url = new URL(options.config.centerUrl);
        if (url.username || url.password || url.search || url.hash) throw new Error('中央地址不能包含凭据、查询参数或片段');
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('跨机器节点通信必须使用 HTTPS');
        this.instanceId = options.config.instanceId ?? randomUUID();
        this.transport = options.fetch ?? globalThis.fetch;
        this.clock = options.clock ?? (() => new Date());
    }

    private async request<T>(pathname: string, payload: unknown): Promise<T> {
        const url = new URL(pathname.replace(/^\//, ''), this.options.config.centerUrl.replace(/\/?$/, '/'));
        const response = await this.transport(url, {
            method: 'POST', headers: { authorization: `Bearer ${this.options.config.token}`, 'content-type': 'application/json',
                ...(pathname === '/node-api/v1/register' && this.options.config.pauseAdmission ? { 'x-dsh-review-admission': 'paused' } : {}) },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
        });
        const result = await response.json() as { error?: { message?: string } };
        if (!response.ok) {
            if (response.status === 401 || response.status === 409) this.registered = false;
            throw new Error(result.error?.message ?? `中央通信失败（${response.status}）`);
        }
        return result as T;
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

    private async cycle(): Promise<void> {
        const { config, journal } = this.options;
        if (!this.initialized) {
            for (const saved of journal.interrupted()) {
                journal.emit(saved.command.commandId, 'recovery_required', undefined, {
                    outcome: { status: 'RECOVERY_REQUIRED', reason: 'NODE_RESTARTED', detail: '节点中断过执行，必须核验 VCS 与工作副本，不能直接重跑' },
                    delivery: { state: 'unknown' },
                });
            }
            this.initialized = true;
        }
        if (!this.registered) {
            await this.request('/node-api/v1/register', { protocolVersion: PROTOCOL_VERSION, instanceId: this.instanceId,
                pluginVersion: config.pluginVersion ?? '0.3.0', dshVersion: config.dshVersion ?? 'unknown',
                platform: process.platform, workspaces: config.workspaces });
            this.registered = true;
        }
        const poll = await this.request<PollResult>('/node-api/v1/commands/poll', { instanceId: this.instanceId });
        if (this.stopping) return;
        for (const commandId of poll.cancellations) this.active.get(commandId)?.controller.abort();
        for (const value of poll.commands) {
            const command = validateCommand(value);
            if (command.nodeId !== config.nodeId) throw new Error('拒绝不属于本节点的指令');
            const saved = journal.accept(command);
            if (this.active.has(command.commandId)) continue;
            if (!saved.fresh && saved.record.phase !== 'accepted') continue;
            if (this.active.size > 0) break;
            if ([...this.background.values()].some(task => task.projectId === command.projectId)) continue;
            const project = poll.projects.find(p => p.projectId === command.projectId);
            const workspace = project && config.workspaces.find(w => w.workspaceId === project.workspaceId);
            const valid = project && project.nodeId === config.nodeId && workspace && project.bindingGeneration === command.bindingGeneration
                && project.projectConfigRevision === command.projectConfigRevision && workspace.vcsType === project.vcsType && workspace.target === project.target;
            await this.request(`/node-api/v1/commands/${command.commandId}/ack`, { instanceId: this.instanceId });
            if (!valid) {
                journal.emit(command.commandId, 'result', undefined, { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: '节点项目绑定或执行配置不一致' }, delivery: { state: 'not_required' } });
                continue;
            }
            this.launch(command, poll.cancellations.includes(command.commandId), project);
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
                try { result = await this.options.read(query, project); }
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
            for (const project of poll.projects.filter(p => p.enabled)) {
                if (poll.commands.some(command => command.projectId === project.projectId)) continue;
                if ([...this.active.values()].some(task => task.projectId === project.projectId)) continue;
                if (this.clock().getTime() - (this.lastSync.get(project.projectId) ?? 0) < 10000) continue;
                this.track(project.projectId, `snapshot:${project.projectId}`, async () => {
                    const content = await this.options.snapshot!(project);
                    const snapshot: ProjectSnapshot = { ...content, projectId: project.projectId, bindingGeneration: project.bindingGeneration,
                        projectConfigRevision: project.projectConfigRevision, snapshotSequence: journal.nextSnapshotSequence(project.projectId), collectedAt: this.clock().toISOString() };
                    await this.request('/node-api/v1/snapshots', { instanceId: this.instanceId, snapshot });
                    this.lastSync.set(project.projectId, this.clock().getTime());
                });
            }
        }
        await this.flush();
    }

    private launch(command: ManagedCommand, cancelled: boolean, project: ProjectRecord): void {
        const controller = new AbortController();
        if (cancelled) controller.abort();
        this.options.journal.markExecuting(command.commandId);
        this.options.journal.emit(command.commandId, 'progress');
        const promise = Promise.resolve().then(async () => {
            let result: ManagedResult;
            try {
                if (controller.signal.aborted) result = { outcome: { status: 'ABORTED', reason: command.operation === 'approve' ? 'COMMIT_FAILED' : 'CANCELLED', message: '执行前已取消，没有产生副作用' }, delivery: { state: 'not_required' } };
                else result = await this.options.execute(command, controller.signal, line => { this.options.journal.emit(command.commandId, 'progress', [line]); }, project);
            } catch (error) {
                result = { outcome: { status: 'RECOVERY_REQUIRED', reason: 'EXECUTION_EXCEPTION', detail: error instanceof Error ? error.message : '执行器异常，需要核验现场' }, delivery: { state: 'unknown' } };
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
        await Promise.all([...this.active.values(), ...this.background.values()].map(value => value.promise));
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const value of this.active.values()) value.controller.abort();
        await this.ticking?.catch(() => {});
        for (const value of this.active.values()) value.controller.abort();
        await this.drain();
        await this.flush().catch(() => {});
    }
}
