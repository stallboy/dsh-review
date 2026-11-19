import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type ProjectRecord } from '@dsh-review/protocol';
import { startManagedNode, type ManagedHandle } from '../managed/managed-config.js';
import { ManagedJournal } from '../managed/managed-journal.js';
import { NodeRegistrationError } from '../managed/managed-node.js';
import { normalizeCenterUrl, readJson, saveJson, type Candidate, type ConnectionConfig, type ConnectionSecrets } from './config.js';
import { CentralGateway, CENTRAL_PREFIX, requestBody } from './gateway.js';
import { LocalCentralProcess } from './local-process.js';
import { LocalCentralRuntime } from './local-runtime.js';

export const CONNECTION_PREFIX = '/dsh-code-review/connection';

interface ControllerOptions {
    directory: string;
    candidates(sessionId?: string): Promise<Candidate[]>;
    resolveCredential?: (reference: string) => Promise<string | undefined>;
    localEntry?: URL;
    beforeConfigure?: () => void;
}

interface NodeStatus {
    centralId: string;
    nodeId: string;
    instanceId: string;
    activeInstance: boolean;
    online: boolean;
    projects: ProjectRecord[];
    pending: number;
}

type RegistrationCompatibility = 'supported' | 'unknown' | 'incompatible';

interface CentralCheck {
    centralId: string;
    protocolVersion: number;
    registrationCompatibility: RegistrationCompatibility;
}

interface ConnectionIssue {
    stage: 'address' | 'server' | 'credentials' | 'registration' | 'startup';
    code: string;
    detail?: string;
    registrationCompatibility?: RegistrationCompatibility;
}

class ConnectionIssueError extends Error implements ConnectionIssue {
    constructor(readonly stage: ConnectionIssue['stage'], readonly code: string, message: string, readonly detail?: string,
        readonly registrationCompatibility?: RegistrationCompatibility) {
        super(message);
    }
}

class CentralRequestError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

function registrationIssue(error: NodeRegistrationError): ConnectionIssueError {
    const message = error.code === 'workspace_rejected' ? '中央服务器拒绝了工作副本信息'
        : error.code === 'registration_field_invalid' ? '中央服务器拒绝了节点注册信息' : error.message;
    const detail = error.protocolField ? `HTTP ${error.status} · ${error.message}` : error.status ? `HTTP ${error.status}` : undefined;
    return new ConnectionIssueError('registration', error.code, message, detail);
}

export class ConnectionController {
    private config: ConnectionConfig | null = null;
    private secrets: ConnectionSecrets = { password: randomBytes(32).toString('base64url'), nodes: {} };
    private node: ManagedHandle | null = null;
    private readonly local: LocalCentralProcess;
    private localAccess = false;
    private readonly runtime: LocalCentralRuntime;
    private runtimeUpdate: Awaited<ReturnType<LocalCentralRuntime['newerVersion']>>;
    private readonly gateway: CentralGateway;
    private readonly controlToken = randomBytes(32).toString('base64url');
    private phase: 'stopped' | 'starting' | 'ready' | 'error' = 'stopped';
    private error = '';
    private issue?: ConnectionIssue;
    private generation = 0;
    private queue: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private locked = false;
    private ownership: DatabaseSync | null = null;
    private legacy = false;
    private legacyConnection: { centerUrl: string; nodeId: string } | null = null;
    private claimed = false;
    private readonly logs: string[] = [];

    constructor(private readonly options: ControllerOptions) {
        this.gateway = new CentralGateway(options.directory);
        this.runtime = new LocalCentralRuntime(options.directory);
        this.local = new LocalCentralProcess(options.localEntry, () => {
            if (this.phase === 'ready' && !this.disposed) {
                this.phase = 'error';
                this.fail(new ConnectionIssueError('startup', 'local_exited', '本机中央已退出，请点击重试；未决任务须核验后恢复'), '本机中央已退出');
                this.gateway.close();
            }
        });
    }

    get configured(): boolean { return this.config !== null || this.claimed; }

    private redact(message: string, extraSecret?: string): string {
        for (const secret of [extraSecret, this.controlToken, this.secrets.password, ...Object.values(this.secrets.nodes).map(node => node.token)]) {
            if (secret) message = message.split(secret).join('[已隐藏]');
        }
        return message;
    }

    private record(message: string, detail?: string): void {
        const entry = this.redact(detail ? `${message}（${detail}）` : message);
        if (this.logs.at(-1) === entry) return;
        this.logs.push(entry);
        if (this.logs.length > 80) this.logs.shift();
    }

    private describe(error: unknown, fallback: string, extraSecret?: string): { message: string; issue?: ConnectionIssue } {
        const problem = error instanceof NodeRegistrationError ? registrationIssue(error) : error;
        const message = this.redact(problem instanceof Error ? problem.message : fallback, extraSecret);
        return problem instanceof ConnectionIssueError
            ? { message, issue: { stage: problem.stage, code: problem.code, detail: problem.detail ? this.redact(problem.detail, extraSecret) : undefined,
                registrationCompatibility: problem.registrationCompatibility } }
            : { message };
    }

    private fail(error: unknown, fallback: string): void {
        const failure = this.describe(error, fallback);
        this.error = failure.message;
        this.issue = failure.issue;
        this.record(this.error, this.issue?.detail);
    }

    private run<T>(task: () => Promise<T>): Promise<T> {
        const operation = this.queue.then(() => {
            if (this.disposed) throw new Error('插件正在停止');
            return task();
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    async init(): Promise<void> {
        this.config = await readJson<ConnectionConfig>(path.join(this.options.directory, 'connection.json'));
        this.secrets = await readJson<ConnectionSecrets>(path.join(this.options.directory, 'connection-secrets.json')) ?? this.secrets;
        this.legacy = !this.config && existsSync(path.join(this.options.directory, 'managed-node.json'));
        if (this.legacy) {
            const saved = await readJson<{ centerUrl?: unknown; nodeId?: unknown }>(path.join(this.options.directory, 'managed-node.json'));
            try {
                if (saved && typeof saved.nodeId === 'string') this.legacyConnection = { centerUrl: normalizeCenterUrl(saved.centerUrl), nodeId: saved.nodeId };
            } catch { this.record('旧托管中央地址无效，请检查 managed-node.json'); }
        }
        if (this.config && (this.config.version !== 1 || !['local', 'external'].includes(this.config.mode) || !this.config.profiles)) {
            throw new Error('中央连接配置格式不受支持，请检查 connection.json');
        }
        if (this.config?.enabled) await this.run(() => this.withOwnership(async () => {
            if (this.config?.enabled) await this.resume();
        })).catch(error => {
            this.phase = 'error';
            this.fail(error, '恢复连接失败');
        });
    }

    private async request(centerUrl: string, pathname: string, token?: string, payload?: unknown): Promise<any> {
        const response = await fetch(new URL(pathname.replace(/^\//, ''), centerUrl), {
            method: payload === undefined ? 'GET' : 'POST', headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            const value = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
            const message = value?.error?.message;
            throw new CentralRequestError(response.status, typeof message === 'string'
                ? this.redact(message, token) : `中央请求失败（HTTP ${response.status}）`);
        }
        return await response.json();
    }

    private address(value: unknown): string {
        try { return normalizeCenterUrl(value); }
        catch (error) {
            throw new ConnectionIssueError('address', 'invalid_address', error instanceof TypeError
                ? '中央地址格式无效，请填写完整的服务地址' : (error as Error).message);
        }
    }

    private async inspectCentral(centerUrl: string): Promise<CentralCheck> {
        const info = await this.request(centerUrl, 'api/v1/info').catch(error => {
            throw new ConnectionIssueError('server', 'server_unavailable', '无法读取中央服务器信息',
                error instanceof CentralRequestError ? `HTTP ${error.status}` : undefined);
        });
        if (!info || typeof info.protocolVersion !== 'number' || typeof info.centralId !== 'string' || !/^[\w-]{16,128}$/.test(info.centralId)) {
            throw new ConnectionIssueError('server', 'invalid_central_info', '此地址未返回有效的中央服务信息');
        }
        if (info.protocolVersion !== PROTOCOL_VERSION) throw new ConnectionIssueError('server', 'protocol_mismatch', '中央协议版本不兼容',
            `中央协议 ${info.protocolVersion} · 插件协议 ${PROTOCOL_VERSION}`);
        const support = info.registrationCapabilities?.executionConfigHash;
        return { centralId: info.centralId, protocolVersion: info.protocolVersion,
            registrationCompatibility: support === true ? 'supported' : support === false ? 'incompatible' : 'unknown' };
    }

    private async verifyCredentials(centerUrl: string, info: CentralCheck, token: string, nodeId?: string): Promise<void> {
        const status = await this.request(centerUrl, 'node-api/v1/status', token, {}).catch(error => {
            const httpStatus = error instanceof CentralRequestError ? error.status : undefined;
            const rejected = httpStatus === 401 || httpStatus === 403;
            throw new ConnectionIssueError('credentials', rejected ? 'credential_rejected' : 'credential_check_failed',
                rejected ? '中央服务器拒绝了节点凭据' : '暂时无法验证节点凭据', httpStatus ? `HTTP ${httpStatus}` : undefined, info.registrationCompatibility);
        });
        if (status?.centralId !== info.centralId) throw new ConnectionIssueError('server', 'central_identity_changed', '中央身份发生变化，请重新核对地址');
        if (typeof status.nodeId !== 'string' || !status.nodeId || (nodeId && status.nodeId !== nodeId)) {
            throw new ConnectionIssueError('credentials', 'node_id_mismatch', '节点 ID 与接入凭据不匹配', undefined, info.registrationCompatibility);
        }
    }

    async test(input: Record<string, unknown>): Promise<CentralCheck & { authenticated: boolean }> {
        const centerUrl = this.address(input.centerUrl);
        const info = await this.inspectCentral(centerUrl);
        const nodeId = typeof input.nodeId === 'string' ? input.nodeId.trim() : '';
        const saved = this.config?.mode === 'external' && this.config.centerUrl === centerUrl && this.config.centralId === info.centralId
            ? this.secrets.nodes[info.centralId] : undefined;
        const supplied = typeof input.token === 'string' ? input.token.trim() : '';
        const token = supplied || (saved && (!nodeId || nodeId === saved.nodeId) ? saved.token : '');
        if (token) await this.verifyCredentials(centerUrl, info, token, nodeId || (supplied ? undefined : saved?.nodeId));
        return { ...info, authenticated: Boolean(token) };
    }

    private async acquire(): Promise<void> {
        if (this.locked) return;
        await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        let ownership: DatabaseSync | undefined;
        try {
            ownership = new DatabaseSync(path.join(this.options.directory, 'connection-owner.sqlite'));
            ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
            const previous = await readJson<{ pid: number }>(path.join(this.options.directory, 'connection.lock'));
            if (previous) {
                if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('旧中央连接锁损坏，请核对旧插件进程');
                let active = true;
                try { process.kill(previous.pid, 0); }
                catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') active = false; }
                if (active) throw new Error('此 DSH 数据目录已有活动中央连接，请先停止旧插件实例');
            }
            this.ownership = ownership;
            this.locked = true;
        } catch (error) {
            ownership?.close();
            if ((Number((error as { errcode?: number }).errcode) & 255) === 5) throw new Error('此 DSH 数据目录已有活动中央连接，请先停止旧插件实例');
            throw error;
        }
    }

    private async release(): Promise<void> {
        if (!this.locked) return;
        this.locked = false;
        const ownership = this.ownership;
        this.ownership = null;
        ownership?.close();
    }

    private async persist(): Promise<void> {
        await saveJson(path.join(this.options.directory, 'connection-secrets.json'), this.secrets);
        await saveJson(path.join(this.options.directory, 'connection.json'), this.config);
    }

    private async withOwnership<T>(task: () => Promise<T>): Promise<T> {
        const owned = this.locked;
        await this.acquire();
        try {
            if (this.disposed) throw new Error('插件正在停止');
            if (!owned) {
                this.config = await readJson<ConnectionConfig>(path.join(this.options.directory, 'connection.json')) ?? this.config;
                this.secrets = await readJson<ConnectionSecrets>(path.join(this.options.directory, 'connection-secrets.json')) ?? this.secrets;
            }
            return await task();
        } finally {
            if (!this.node && !this.local.running && this.phase !== 'ready' && this.phase !== 'starting') await this.release();
        }
    }

    private async localEntry(verifyCache: boolean): Promise<URL | undefined> {
        return await this.local.available() ? this.local.entry : this.runtime.cached(verifyCache);
    }

    private async resume(entry?: URL): Promise<void> {
        const config = this.config!;
        let centralReady = false;
        this.phase = 'starting';
        this.error = '';
        this.issue = undefined;
        this.runtimeUpdate = undefined;
        try {
            await this.acquire();
            if (config.mode === 'local') {
                entry ??= await this.localEntry(true);
                if (!entry && await this.runtime.offer()) throw new Error('缺少已校验的中央运行包，请在中央连接中启动并确认下载');
                const ready = await this.local.start({ dataDir: path.join(this.options.directory, 'central'), reviewIdentity: config.reviewIdentity,
                    password: this.secrets.password, ...(config.centralId && this.secrets.nodes[config.centralId] ? { node: this.secrets.nodes[config.centralId] } : {}) }, entry).catch(error => {
                    throw new ConnectionIssueError('startup', 'local_start_failed', '本机中央启动失败', this.describe(error, '无法启动本机中央').message);
                });
                if (config.centralId && config.centralId !== ready.centralId) throw new Error('本机中央数据身份已变化，拒绝复用旧节点和执行记录');
                this.localAccess = ready.localAccess === true;
                config.centerUrl = normalizeCenterUrl(ready.centerUrl);
                config.centralId = ready.centralId;
                this.secrets.localCentralId = ready.centralId;
                this.secrets.localReviewIdentity = config.reviewIdentity;
                this.secrets.nodes[ready.centralId] = { nodeId: ready.nodeId, token: ready.token };
            }
            const credentials = this.secrets.nodes[config.centralId];
            if (!credentials) throw new ConnectionIssueError('credentials', 'credentials_missing', '中央节点凭据缺失，请重新配置接入');
            const verified = await this.inspectCentral(config.centerUrl);
            if (verified.centralId !== config.centralId) throw new ConnectionIssueError('server', 'central_identity_changed', '该地址现在属于另一中央，请核对原中央地址');
            await this.verifyCredentials(config.centerUrl, verified, credentials.token, credentials.nodeId);
            this.requireRegistrationSupport(verified);
            const profile = config.profiles[config.centralId] ??= { nodeId: credentials.nodeId, workspaces: [] };
            if (profile.nodeId !== credentials.nodeId) throw new Error('节点身份不匹配，拒绝复用原工作副本绑定');
            await this.persist();
            centralReady = true;
            await this.connectNode();
            await this.persist();
            this.connectGateway();
            this.phase = 'ready';
            this.generation++;
            this.record(config.mode === 'local' ? '本机中央已就绪，节点已连接' : '已有中央已连接，节点已注册');
            if (entry) {
                const generation = this.generation;
                void this.runtime.newerVersion(entry).then(update => {
                    if (!this.disposed && this.phase === 'ready' && this.generation === generation) this.runtimeUpdate = update;
                });
            }
        } catch (error) {
            this.phase = 'error';
            this.fail(error, '中央连接失败');
            if (centralReady && this.local.running) {
                const node = this.node;
                this.node = null;
                await node?.stop();
                this.gateway.close();
            } else {
                await this.shutdown();
                this.phase = 'error';
            }
            throw error;
        }
    }

    private connectGateway(): void {
        const config = this.config!;
        // 已缓存的旧版运行包仍依赖网关代登录。
        this.gateway.connect(config.centerUrl, config.centralId, config.mode === 'local' && !this.localAccess ? async () => {
            const response = await fetch(new URL('api/v1/auth/login', config.centerUrl), { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'local', password: this.secrets.password }),
                redirect: 'error', signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error('本机审核会话初始化失败');
            return response.headers.getSetCookie().find(value => value.startsWith('dsh_review_session='))?.split(';')[0] ?? '';
        } : undefined);
    }

    private async connectNode(change?: { workspaceId: string; enabled: boolean }): Promise<void> {
        const config = this.config!;
        const credentials = this.secrets.nodes[config.centralId]!;
        const profile = config.profiles[config.centralId]!;
        const state = await this.request(config.centerUrl, 'node-api/v1/status', credentials.token, {}) as NodeStatus;
        if (state.centralId !== config.centralId || state.nodeId !== credentials.nodeId) throw new Error('中央或节点身份不匹配');
        for (const workspace of profile.workspaces) {
            const project = state.projects.find(project => project.workspaceId === workspace.workspaceId);
            if (project && change?.workspaceId !== workspace.workspaceId) {
                workspace.label = project.name;
                workspace.enabled = project.enabled;
                workspace.projectId = project.projectId;
            }
        }
        const active = profile.workspaces.filter(workspace => workspace.enabled);
        this.node = await startManagedNode({ centerUrl: config.centerUrl, ...credentials, pauseAdmission: true,
            workspaces: profile.workspaces.map(workspace => ({ ...workspace })), boundProjects: state.projects }, path.join(this.options.directory, 'connections', config.centralId),
            this.options.resolveCredential ?? (async () => undefined), error => {
                if (this.phase === 'starting') return;
                const failure = this.describe(error, '节点连接异常');
                this.record(failure.message, failure.issue?.detail);
            }).catch(error => { throw error instanceof NodeRegistrationError ? registrationIssue(error) : error; });
        for (const workspace of active) {
            if (this.node.workspaceIssue(workspace.workspaceId)) continue;
            let result = await this.request(config.centerUrl, 'node-api/v1/projects/ensure', credentials.token, {
                instanceId: this.node.instanceId, workspaceId: workspace.workspaceId, name: workspace.label, enabled: workspace.enabled, restore: true,
            });
            if (change?.workspaceId === workspace.workspaceId && change.enabled !== result.project.enabled) {
                result = await this.request(config.centerUrl, 'node-api/v1/projects/ensure', credentials.token, {
                    instanceId: this.node.instanceId, workspaceId: workspace.workspaceId, name: result.project.name, enabled: change.enabled,
                });
            }
            workspace.projectId = result.project.projectId;
            workspace.label = result.project.name;
            workspace.enabled = result.project.enabled;
        }
        await this.request(config.centerUrl, 'node-api/v1/activate', credentials.token, { instanceId: this.node.instanceId });
        this.node.completeConfiguration();
    }

    private async idle(): Promise<NodeStatus | null> {
        if (this.legacy) throw new Error('检测到旧 managed-node.json；请先在原中央处理未决任务，停用旧托管配置并重启插件，再应用新连接。旧执行记录不会自动迁移');
        if (!this.config?.centralId) return null;
        const journalFile = path.join(this.options.directory, 'connections', this.config.centralId, 'journal.sqlite');
        if (this.node?.hasUnsettled()) throw new Error('节点存在未核验执行或未确认事件，请先处理原任务');
        if (!this.node && existsSync(journalFile)) {
            const journal = new ManagedJournal(journalFile);
            try { if (journal.hasUnsettled()) throw new Error('节点存在未核验执行或未确认事件，请先恢复原连接'); }
            finally { journal.close(); }
        }
        if (!this.config.enabled) return null;
        const credentials = this.secrets.nodes[this.config.centralId];
        if (!credentials) throw new Error('无法核验原中央节点状态，请恢复原连接');
        const status = await this.request(this.config.centerUrl, 'node-api/v1/status', credentials.token, {}) as NodeStatus;
        if (status.centralId !== this.config.centralId || status.nodeId !== credentials.nodeId || status.pending) throw new Error('原中央身份变化或仍有未决任务，不能更换或停用连接');
        if (!this.node) {
            if (typeof status.activeInstance !== 'boolean' || typeof status.instanceId !== 'string') throw new Error('中央缺少实例恢复状态，请升级后重试');
            if (status.activeInstance) throw new Error('原节点仍有活动实例，请先确认旧节点已停止');
        }
        const instanceId = this.node?.instanceId ?? status.instanceId;
        if (instanceId) await this.request(this.config.centerUrl, 'node-api/v1/quiesce', credentials.token, { instanceId });
        return status;
    }

    private requireRegistrationSupport(info: CentralCheck): void {
        if (info.registrationCompatibility === 'incompatible') {
            throw new ConnectionIssueError('registration', 'registration_incompatible', '中央服务器不支持工作副本执行配置摘要');
        }
    }

    async apply(input: Record<string, unknown>): Promise<void> {
        return this.run(() => this.withOwnership(async () => {
            if (input.mode !== 'local' && input.mode !== 'external') throw new Error('请选择中央连接方式');
            if (this.legacy) await this.idle();
            const mode = input.mode;
            const reviewIdentity = typeof input.reviewIdentity === 'string' ? input.reviewIdentity.trim() : this.config?.reviewIdentity ?? '';
            if (mode === 'local' && (!reviewIdentity || reviewIdentity.length > 160)) throw new Error('请填写有效的本机审核身份');
            if (mode === 'local' && this.secrets.localReviewIdentity && reviewIdentity !== this.secrets.localReviewIdentity) {
                throw new Error('本机审核身份已初始化，不能通过修改连接配置更换操作者');
            }
            const centerUrl = mode === 'external' ? this.address(input.centerUrl ?? this.config?.centerUrl) : '';
            let centralId = mode === 'local' ? this.secrets.localCentralId ?? (this.config?.mode === 'local' ? this.config.centralId : '') : '';
            let credentials: { nodeId: string; token: string } | undefined;
            if (mode === 'external') {
                const info = await this.inspectCentral(centerUrl);
                centralId = info.centralId;
                const previous = this.secrets.nodes[centralId];
                const nodeId = (typeof input.nodeId === 'string' ? input.nodeId.trim() : '') || previous?.nodeId || '';
                const token = (typeof input.token === 'string' ? input.token.trim() : '') || (nodeId === previous?.nodeId ? previous.token : '');
                if (!/^[\w-]{16,128}$/.test(nodeId)) throw new ConnectionIssueError('credentials', 'invalid_node_id', '请填写中央签发的节点 ID', undefined, info.registrationCompatibility);
                if (!/^[\w-]{20,256}$/.test(token)) throw new ConnectionIssueError('credentials', 'invalid_token', '请填写中央签发的节点 Token', undefined, info.registrationCompatibility);
                credentials = { nodeId, token };
                await this.verifyCredentials(centerUrl, info, token, nodeId);
                this.requireRegistrationSupport(info);
                const saved = this.config?.profiles[centralId];
                if (saved && saved.nodeId !== credentials.nodeId) throw new Error('该中央已有另一节点绑定，拒绝替换现有节点身份');
            }
            const same = Boolean(this.config && this.config.mode === mode && (mode === 'local' || this.config.centralId === centralId));
            if (same && this.phase === 'ready' && (mode === 'local' || this.config!.centerUrl === centerUrl)) return;
            const entry = mode === 'local' ? await this.localEntry(true) ?? await this.runtime.download(input.confirmRuntimeDownload) : undefined;
            if (this.disposed) throw new Error('插件正在停止');
            if (!same || this.phase === 'ready') await this.idle();
            const profiles = this.config?.profiles ?? {};
            this.options.beforeConfigure?.();
            this.claimed = true;
            await this.shutdown(false);
            await this.runtime.discardReplaced();
            this.config = { version: 1, enabled: true, mode, centerUrl, centralId, reviewIdentity, profiles };
            if (credentials) this.secrets.nodes[centralId] = credentials;
            await this.persist();
            await this.resume(entry);
        }));
    }

    async disable(): Promise<void> {
        return this.run(() => this.withOwnership(async () => {
            if (!this.config) return;
            await this.idle();
            await this.shutdown(false);
            this.config.enabled = false;
            await this.persist();
            this.phase = 'stopped';
            this.error = '';
            this.issue = undefined;
            this.generation++;
        }));
    }

    async project(input: Record<string, unknown>, sessionId?: string): Promise<void> {
        return this.run(() => this.withOwnership(async () => {
            if (!this.config?.enabled || (this.phase !== 'ready' && !(this.phase === 'error' && input.enabled === false && typeof input.workspaceId === 'string'))) throw new Error('请先启用中央连接');
            if (typeof input.enabled !== 'boolean') throw new Error('项目接入状态无效');
            const profile = this.config.profiles[this.config.centralId]!;
            const workspaces = structuredClone(profile.workspaces);
            let workspace = workspaces.find(value => value.workspaceId === input.workspaceId);
            if (!workspace && typeof input.candidateId === 'string') {
                const candidate = (await this.options.candidates(sessionId)).find(value => value.id === input.candidateId);
                if (!candidate || candidate.error || !candidate.vcsType || !candidate.target) throw new Error(candidate?.error ?? '项目候选已变化，请刷新后重新选择');
                workspace = workspaces.find(value => value.root === candidate.root);
                if (!workspace) {
                    workspace = { workspaceId: `ws-${candidate.id}`, root: candidate.root, label: candidate.label,
                        vcsType: candidate.vcsType, target: candidate.target, enabled: true };
                    workspaces.push(workspace);
                }
            }
            if (!workspace) throw new Error('项目接入记录不存在');
            workspace.enabled = input.enabled;
            const state = await this.idle();
            this.phase = 'starting';
            try {
                const project = state?.projects.find(project => project.workspaceId === workspace.workspaceId);
                if (!input.enabled && project?.enabled) {
                    await this.request(this.config.centerUrl, 'node-api/v1/projects/ensure', this.secrets.nodes[this.config.centralId]!.token, {
                        instanceId: this.node?.instanceId ?? state!.instanceId, workspaceId: workspace.workspaceId, name: project.name, enabled: false,
                    });
                }
                const node = this.node;
                this.node = null;
                if (node) await node.stop();
                else if (state?.instanceId) await this.request(this.config.centerUrl, 'node-api/v1/disconnect', this.secrets.nodes[this.config.centralId]!.token, { instanceId: state.instanceId });
                profile.workspaces = workspaces;
                await this.persist();
                await this.connectNode({ workspaceId: workspace.workspaceId, enabled: input.enabled });
                await this.persist();
                this.connectGateway();
                this.phase = 'ready';
                this.error = '';
                this.issue = undefined;
            } catch (error) {
                this.phase = 'error';
                this.fail(error, '项目接入失败');
                throw error;
            }
        }));
    }

    async status(sessionId?: string): Promise<Record<string, unknown>> {
        const config = this.config;
        const profile = config?.profiles[config.centralId];
        const projects = structuredClone(profile?.workspaces ?? []);
        let serverReachable: boolean | undefined;
        let nodeOnline = false;
        if (this.phase === 'ready' && this.node && config) {
            const credentials = this.secrets.nodes[config.centralId];
            try {
                const status = await this.request(config.centerUrl, 'node-api/v1/status', credentials?.token, {});
                serverReachable = status?.centralId === config.centralId;
                nodeOnline = serverReachable && status.nodeId === credentials?.nodeId
                    && status.online === true && status.activeInstance === true && status.instanceId === this.node.instanceId;
                if (nodeOnline) for (const workspace of projects) {
                    const project = status.projects.find((value: { workspaceId: string }) => value.workspaceId === workspace.workspaceId);
                    if (project) { workspace.enabled = project.enabled; workspace.label = project.name; }
                }
            } catch { serverReachable = false; }
        }
        const localAvailable = Boolean(await this.localEntry(false));
        const localRuntimeDownload = localAvailable ? undefined : await this.runtime.offer();
        return { controlToken: this.controlToken, configured: this.configured, legacy: this.legacy,
            enabled: config?.enabled ?? false, mode: config?.mode ?? (this.legacy ? 'external' : 'local'), centerUrl: config?.centerUrl ?? this.legacyConnection?.centerUrl ?? '',
            centralId: config?.centralId ?? '', nodeId: profile?.nodeId ?? this.legacyConnection?.nodeId ?? '', reviewIdentity: config?.reviewIdentity ?? '',
            phase: this.phase, serverReachable, nodeOnline, error: this.error, issue: this.issue, generation: this.generation,
            candidates: await this.options.candidates(sessionId), projects: projects.map(workspace => {
                const workspaceIssue = this.node?.workspaceIssue(workspace.workspaceId);
                return workspaceIssue ? { ...workspace, workspaceIssue } : workspace;
            }),
            logs: [...this.logs], hasCredentials: Boolean(config && this.secrets.nodes[config.centralId]), localAvailable,
            localRuntimeDownload, localRuntimeUpdate: config?.mode === 'local' && this.phase === 'ready' ? this.runtimeUpdate : undefined };
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://local');
        let draftToken: string | undefined;
        try {
            if (url.pathname.startsWith(`${CENTRAL_PREFIX}/`)) {
                if (this.phase !== 'ready') throw new Error('中央尚未就绪，请先检查连接');
                await this.gateway.handle(req, res);
                return;
            }
            const endpoint = url.pathname.slice(CONNECTION_PREFIX.length).replace(/\/$/, '');
            if (req.method === 'GET' && !endpoint) {
                res.setHeader('cache-control', 'no-store');
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify(await this.status(url.searchParams.get('sessionId') ?? undefined)));
                return;
            }
            if (req.method !== 'POST' || req.headers['x-dsh-review-control'] !== this.controlToken) {
                res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '插件管理请求校验失败，请刷新页面' } })); return;
            }
            const input = JSON.parse((await requestBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
            draftToken = typeof input?.token === 'string' ? input.token.trim() : undefined;
            let result: unknown = { ok: true };
            if (endpoint === '/test') result = await this.test(input);
            else if (endpoint === '/apply') await this.apply(input);
            else if (endpoint === '/stop') await this.disable();
            else if (endpoint === '/projects') await this.project(input, url.searchParams.get('sessionId') ?? undefined);
            else { res.writeHead(404); res.end(); return; }
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(result));
        } catch (error) {
            if (res.headersSent) { res.end(); return; }
            const { message, issue } = this.describe(error, '插件中央操作失败', draftToken);
            this.record(message, issue?.detail);
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: { message, ...issue } }));
        }
    }

    private async shutdown(releaseLock = true): Promise<void> {
        this.phase = 'stopped';
        this.localAccess = false;
        this.gateway.close();
        const node = this.node;
        this.node = null;
        try { await node?.stop(); }
        finally { await this.local.stop(); if (releaseLock) await this.release(); }
    }

    async stop(): Promise<void> {
        this.disposed = true;
        this.runtime.stop();
        await this.queue.catch(() => {});
        await this.shutdown();
    }
}
