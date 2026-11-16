import { realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { JsonRecord, ManagedCommand, ManagedOperation, ManagedQuery, ManagedQueryResult, ManagedResult, ProjectRecord, WorkspaceRegistration } from '@dsh-review/protocol';
import { ReviewApi } from './api.js';
import { withSharedView } from './api-context.js';
import { AuditArchive } from './audit-archive.js';
import { ManagedDelivery, decorateManagedVcs } from './managed-delivery.js';
import { ManagedJournal } from './managed-journal.js';
import { managedSource } from './managed-source.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { runProcess } from './shell.js';
import type { AppSettings } from './types.js';

export interface ManagedWorkspace {
    workspaceId: string;
    label: string;
    root: string;
    target?: string;
    settings?: Partial<Pick<AppSettings, 'runner' | 'dshCommand' | 'externalCommand' | 'gateTimeoutMs' | 'syncBeforeApprove' | 'autoFixOnFailure'>>;
}

const routes: Record<ManagedOperation, string> = {
    approve: '/approve', comments: '/comments', 'comments-batch': '/comments/batch', 'comment-status': '/comment-status', takeover: '/takeover', reject: '/reject', resume: '/resume',
    rebase: '/rebase', 'ai-fix': '/ai-fix', 'manual-revision': '/manual-revision', reopen: '/reopen', 'archive-stale': '/archive-stale', audit: '/audit',
    'audit-finalize': '/audit/finalize', 'audit-release': '/audit/release', 'candidate-finalize': '/candidate/finalize', convert: '/convert', 'dismiss-finding': '/dismiss-finding', sync: '/sync',
};

interface WorkspaceRuntime {
    registration: WorkspaceRegistration;
    root: string;
    api: ReviewApi;
    delivery: ManagedDelivery;
}

const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const unknownResult = (detail: string): ManagedResult => ({ outcome: { status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail }, delivery: { state: 'unknown' } });

export class ManagedOperations {
    private readonly runtimes = new Map<string, WorkspaceRuntime>();

    constructor(private readonly options: { dataDir: string; journal: ManagedJournal; workspaces: ManagedWorkspace[]; resolveCredential?: (reference: string) => Promise<string | undefined> }) {}

    async init(): Promise<void> {
        await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
        const roots = new Set<string>();
        for (const config of this.options.workspaces) {
            if (!/^[\w-]+$/.test(config.workspaceId) || this.runtimes.has(config.workspaceId)) throw new Error('workspaceId 无效或重复');
            const root = await realpath(config.root);
            const identity = process.platform === 'win32' ? root.toLowerCase() : root;
            if (roots.has(identity)) throw new Error('多个 workspace 不能共享同一工作副本');
            roots.add(identity);
            const probe = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 10000 });
            const type = probe.code === 0 ? 'git' : 'svn';
            if (type === 'git' && await realpath(probe.stdout.trim()) !== root) throw new Error('workspace 必须是仓库根目录');
            if (type === 'svn') {
                const wcRoot = await runProcess('svn', ['info', '--show-item', 'wc-root', '.'], { cwd: root, timeoutMs: 30000 });
                if (wcRoot.code !== 0 || await realpath(wcRoot.stdout.trim()) !== root) throw new Error('SVN workspace 必须是工作副本根目录');
            }
            const targetResult = await runProcess(type, type === 'git' ? ['branch', '--show-current'] : ['info', '--show-item', 'relative-url', '.'], { cwd: root, timeoutMs: 30000 });
            const target = targetResult.stdout.trim();
            if (targetResult.code !== 0 || !target || (config.target && config.target !== target)) throw new Error(`workspace ${config.workspaceId} 的目标分支不匹配`);
            this.options.journal.bindWorkspace(config.workspaceId, JSON.stringify({ root: identity, type, target }));
            const settings: AppSettings = { ...DEFAULT_SETTINGS, ...config.settings, repoRoot: root, vcsType: type, baseBranch: target,
                owner: 'managed-node', scheduleIntervalMinutes: 0 };
            const api = new ReviewApi({ settings, saveSettings: async () => { throw new Error('托管配置仅由节点本地文件管理'); },
                statePath: path.join(this.options.dataDir, `${config.workspaceId}-runtime.json`), decorateVcs: decorateManagedVcs,
                ...(this.options.resolveCredential ? { resolveCredential: this.options.resolveCredential } : {}) });
            await api.init();
            if (api.lastConfigErrors.length) throw new Error(api.lastConfigErrors.join('；'));
            this.runtimes.set(config.workspaceId, { root, api, registration: { workspaceId: config.workspaceId, label: config.label, vcsType: type, target }, delivery: new ManagedDelivery({ root, type, target }) });
        }
    }

    registrations(): WorkspaceRegistration[] { return [...this.runtimes.values()].map(runtime => ({ ...runtime.registration })); }

    private runtime(project: ProjectRecord): WorkspaceRuntime {
        const runtime = this.runtimes.get(project.workspaceId);
        if (!runtime || runtime.registration.vcsType !== project.vcsType || runtime.registration.target !== project.target) throw new Error('项目与节点工作副本不匹配');
        return runtime;
    }

    private async checkTarget(runtime: WorkspaceRuntime): Promise<void> {
        const result = await runProcess(runtime.registration.vcsType, runtime.registration.vcsType === 'git' ? ['branch', '--show-current'] : ['info', '--show-item', 'relative-url', '.'], { cwd: runtime.root, timeoutMs: 30000 });
        if (result.code !== 0 || result.stdout.trim() !== runtime.registration.target) throw new Error('工作副本目标已变化，拒绝执行');
    }

    async execute(command: ManagedCommand, signal: AbortSignal, emit: (line: string) => void, project: ProjectRecord): Promise<ManagedResult> {
        const runtime = this.runtime(project);
        await this.checkTarget(runtime);
        if (command.projectId !== project.projectId || command.bindingGeneration !== project.bindingGeneration || command.projectConfigRevision !== project.projectConfigRevision) throw new Error('执行配置已过期');
        if (command.payload.autoFix === true) return { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: '托管模式请先提交评论，再单独启动 AI 修复' }, delivery: { state: 'not_required' } };
        this.options.journal.checkpoint(command.commandId, { phase: 'invoking', workspaceId: project.workspaceId });
        const response = await runtime.api.invoke({ method: 'POST', path: routes[command.operation], body: { ...command.payload, ...command.guard,
            ...(command.operation === 'takeover' ? { owner: command.actor.reviewIdentity } : {}) }, actor: { ...command.actor, commandId: command.commandId } });
        const data = object(response.body);
        let outcome: ManagedResult['outcome'];
        if (response.status >= 400) {
            const error = object(data.error), details = object(error.details);
            outcome = details.status === 'RECOVERY_REQUIRED' ? { ...details, status: 'RECOVERY_REQUIRED', message: error.message } : {
                status: response.status < 500 ? 'ABORTED' : 'RECOVERY_REQUIRED', reason: error.code ?? 'EXECUTION_EXCEPTION', message: error.message, httpStatus: response.status,
            };
        } else if (typeof data.jobId === 'string') {
            this.options.journal.checkpoint(command.commandId, { phase: 'job', workspaceId: project.workspaceId, jobId: data.jobId });
            let offset = 0;
            const cancel = () => runtime.api.jobManager.abort(String(data.jobId));
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            try {
                for (;;) {
                    const job = runtime.api.jobManager.get(data.jobId);
                    if (!job) throw new Error('执行 Job 记录丢失，需要核验现场');
                    const start = job.logStartOffset ?? 0;
                    for (const line of job.log.slice(Math.max(0, offset - start))) emit(line);
                    offset = start + job.log.length;
                    if (job.status !== 'running') {
                        outcome = job.status === 'succeeded' && typeof object(job.result).status === 'string' ? object(job.result) as ManagedResult['outcome'] : unknownResult(job.error ?? '任务没有可证明的结果').outcome;
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } finally { signal.removeEventListener('abort', cancel); }
        } else {
            const commitRevision = data.commitRevision ?? object(data.commit).commitRevision;
            outcome = { ...data, status: typeof commitRevision === 'string' ? 'COMMITTED' : 'SUCCEEDED', ...(typeof commitRevision === 'string' ? { commitRevision } : {}) };
        }
        let commit = typeof outcome.commitRevision === 'string' ? outcome.commitRevision : null;
        if (!commit) commit = await runtime.delivery.findCommandCommit(command.commandId);
        const result: ManagedResult = { outcome, delivery: commit ? { state: 'pending', commitRevision: commit } : { state: outcome.status === 'RECOVERY_REQUIRED' ? 'unknown' : 'not_required' } };
        this.options.journal.checkpoint(command.commandId, { phase: 'business_finished', result });
        if (commit) result.delivery = await runtime.api.withWriteLock(runtime.root, () => runtime.delivery.deliver(commit!));
        this.options.journal.checkpoint(command.commandId, { phase: 'finished', result });
        return result;
    }

    async recover(command: ManagedCommand, previous: ManagedResult | undefined, project: ProjectRecord): Promise<ManagedResult> {
        const runtime = this.runtime(project);
        await this.checkTarget(runtime);
        const checkpoint = this.options.journal.recoveryData(command.commandId);
        const saved = object(checkpoint?.result) as unknown as ManagedResult;
        const result = saved?.outcome ? structuredClone(saved) : previous?.outcome.status !== 'RECOVERY_REQUIRED' ? structuredClone(previous) : undefined;
        const commit = result?.delivery.commitRevision ?? await runtime.delivery.findCommandCommit(command.commandId);
        if (!commit) return result?.delivery.state === 'not_required' ? result : unknownResult('没有足够证据证明原执行结果；请保留现场并人工核验，不会重跑业务操作');
        const restored = result ?? { outcome: { status: 'RECOVERY_REQUIRED', reason: 'EXECUTION_OUTCOME_UNKNOWN', commitRevision: commit,
            detail: '已找到原指令的提交，但缺少完整业务结果，不能仅据提交标记推断批准成功' }, delivery: { state: 'pending' as const, commitRevision: commit } };
        restored.delivery = await runtime.api.withWriteLock(runtime.root, () => runtime.delivery.deliver(commit));
        this.options.journal.checkpoint(command.commandId, { phase: 'finished', result: restored });
        return restored;
    }

    async snapshot(project: ProjectRecord) {
        const runtime = this.runtime(project);
        await this.checkTarget(runtime);
        const pinned = await managedSource(runtime.root, runtime.registration.vcsType);
        const view = { source: pinned.source, snapshot: runtime.registration.vcsType === 'git' ? await pinned.source.snapshotId() : null };
        return withSharedView(runtime.root, view, async () => {
            const read = async (route: string) => {
                const response = await runtime.api.invoke({ method: 'GET', path: route, query: { owner: '' } });
                if (response.status !== 200) throw new Error(`读取 ${route} 失败`);
                return object(response.body);
            };
            const queue = await read('/queue'), findings = await read('/findings'), audits = await read('/audits');
            const after = await managedSource(runtime.root, runtime.registration.vcsType);
            if (after.identity !== pinned.identity) throw new Error('采集期间快照发生变化，将在下次重试');
            return { vcsSnapshot: pinned.identity, queue: (queue.items ?? []) as JsonRecord[], findings: (findings.findings ?? []) as JsonRecord[],
                audits: (audits.audits ?? []) as JsonRecord[], errors: [...(queue.errors as string[] ?? []), ...(findings.errors as string[] ?? []), ...(audits.errors as string[] ?? [])] };
        });
    }

    async read(query: ManagedQuery, project: ProjectRecord): Promise<ManagedQueryResult> {
        const runtime = this.runtime(project);
        await this.checkTarget(runtime);
        const pinned = await managedSource(runtime.root, runtime.registration.vcsType);
        const moved = (): ManagedQueryResult => ({ queryId: query.queryId, vcsSnapshot: pinned.identity, status: 'snapshot_moved' });
        if (query.bindingGeneration !== project.bindingGeneration || pinned.identity !== query.vcsSnapshot) return moved();
        const data = await withSharedView(runtime.root, { source: pinned.source, snapshot: runtime.registration.vcsType === 'git' ? await pinned.source.snapshotId() : null }, async () => {
            if (query.kind === 'audit') {
                const id = String(query.params.id ?? '');
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('审查档案标识无效');
                return new AuditArchive(runtime.root).read(id, pinned.source);
            }
            const params: Record<string, string> = {};
            for (const name of ['id', 'name', 'from', 'to', 'mode']) if (query.params[name] !== undefined) params[name] = String(query.params[name]);
            const response = await runtime.api.invoke({ method: 'GET', path: `/${query.kind}`, query: params });
            if (response.status !== 200) throw new Error(String(object(object(response.body).error).message ?? '详情读取失败'));
            const value = object(response.body);
            delete value.me;
            delete value.canAct;
            delete value.jobs;
            return value;
        });
        if ((await managedSource(runtime.root, runtime.registration.vcsType)).identity !== pinned.identity) return moved();
        return { queryId: query.queryId, vcsSnapshot: pinned.identity, status: 'ready', data };
    }

    stop(): void { for (const runtime of this.runtimes.values()) runtime.api.stopScheduler(); }
}
