import { realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RETIRED_MANUAL_REVISION, retiredManualRevisionResult, type JsonRecord, type ManagedCommand, type ManagedOperation, type ManagedQuery, type ManagedQueryResult, type ManagedResult, type ProjectRecord, type WorkspaceRegistration } from '@dsh-review/protocol';
import { ReviewApi } from '../host/api.js';
import { withSharedView } from '../host/api-context.js';
import type { ManagedAuditSessions } from './managed-config.js';
import { AuditArchive } from '../host/audit-archive.js';
import { ManagedDelivery, decorateManagedVcs } from './managed-delivery.js';
import { ManagedJournal } from './managed-journal.js';
import { managedSource } from './managed-source.js';
import { DEFAULT_SETTINGS } from '../host/settings.js';
import { scheduledReviewDataClean } from '../host/scheduled-audit-vcs.js';
import { readSvnAuditUrl } from '../host/audit-stage-artifacts.js';
import { runProcess } from '../host/shell.js';
import type { AppSettings } from '../host/types.js';

export interface ManagedWorkspace {
    workspaceId: string;
    label: string;
    root: string;
    enabled?: boolean;
    vcsType?: 'git' | 'svn';
    target?: string;
    settings?: Partial<Pick<AppSettings, 'runner' | 'dshCommand' | 'externalCommand' | 'gateTimeoutMs' | 'syncBeforeApprove' | 'autoFixOnFailure'>>;
}

const routes: Record<Exclude<ManagedOperation, 'test'>, string> = {
    approve: '/approve', comments: '/comments', 'comments-batch': '/comments/batch', 'comment-status': '/comment-status', takeover: '/takeover', reject: '/reject', resume: '/resume',
    'finding-decision': '/finding/decision',
    rebase: '/rebase', 'ai-fix': '/ai-fix', reopen: '/reopen', 'archive-stale': '/archive-stale', audit: '/audit',
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

function executionConfigHash(config: ManagedWorkspace): string {
    const settings = { ...DEFAULT_SETTINGS, ...config.settings };
    return createHash('sha256').update(JSON.stringify({
        runner: settings.runner,
        dshCommand: settings.dshCommand,
        externalCommand: settings.externalCommand,
        gateTimeoutMs: settings.gateTimeoutMs,
        syncBeforeApprove: settings.syncBeforeApprove,
        autoFixOnFailure: settings.autoFixOnFailure,
    })).digest('hex');
}

class WorkspaceConfigurationError extends Error {}

class WorkspaceTargetError extends WorkspaceConfigurationError {
    constructor(expected?: string, actual?: string) {
        const display = (value: string) => value.replace(/[\r\n\t]/g, ' ').replace(/[^\s/]+:\/\/[^\s]+/g, '[已隐藏]').slice(0, 180);
        super('工作副本的目标分支不匹配。期望 ' + (expected ? display(expected) : '明确目标')
            + '，实际 ' + (actual === undefined ? '读取失败' : actual ? display(actual) : '无明确目标'));
    }
}

export class ManagedOperations {
    private readonly runtimes = new Map<string, WorkspaceRuntime>();
    private readonly configs = new Map<string, ManagedWorkspace>();
    private readonly declarations = new Map<string, WorkspaceRegistration>();
    private readonly initializing = new Map<string, Promise<WorkspaceRuntime>>();
    private readonly roots = new Map<string, string>();
    private stopped = false;
    private readonly issues = new Map<string, string>();

    constructor(private readonly options: { dataDir: string; journal: ManagedJournal; workspaces: ManagedWorkspace[]; resolveCredential?: (reference: string) => Promise<string | undefined>;
        auditSessions?: ManagedAuditSessions }) {}

    auditStageApi(sessionId: string): ReviewApi | undefined {
        return [...this.runtimes.values()].find(runtime => runtime.api.hasAuditStageSession(sessionId))?.api;
    }

    async init(projects: ProjectRecord[] = []): Promise<void> {
        await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
        for (const config of this.options.workspaces) {
            if (!/^[\w-]+$/.test(config.workspaceId) || this.configs.has(config.workspaceId)) throw new Error('workspaceId 无效或重复');
            this.configs.set(config.workspaceId, config);
            await this.inspectWorkspace(config, config.enabled !== false, projects.find(project => project.workspaceId === config.workspaceId));
        }
    }

    private async inspectWorkspace(config: ManagedWorkspace, enabled: boolean, project?: ProjectRecord): Promise<void> {
        try {
            if (project && config.target && config.target !== project.target) throw new WorkspaceTargetError(project.target, config.target);
            if (project && config.vcsType && config.vcsType !== project.vcsType) throw new WorkspaceConfigurationError('工作副本的 VCS 类型与中央绑定不匹配');
            if (!enabled) {
                if (!this.declarations.has(config.workspaceId)) {
                    const vcsType = project?.vcsType ?? config.vcsType, target = project?.target ?? config.target;
                    if ((vcsType !== 'git' && vcsType !== 'svn') || !target) throw new WorkspaceConfigurationError('停用工作副本缺少已验证的 VCS 类型或目标');
                    this.declarations.set(config.workspaceId, { workspaceId: config.workspaceId, label: config.label,
                        vcsType, target, executionConfigHash: executionConfigHash(config) });
                }
                this.issues.delete(config.workspaceId);
                return;
            }
            const runtime = this.runtimes.get(config.workspaceId);
            const current = runtime ?? await this.runtimeForConfig(project ? { ...config, vcsType: project.vcsType, target: project.target } : config);
            if (project && current.registration.target !== project.target) {
                throw new WorkspaceTargetError(project.target, current.registration.target);
            }
            if (runtime) await this.checkTarget(runtime);
            this.issues.delete(config.workspaceId);
        } catch (error) {
            const message = error instanceof WorkspaceConfigurationError ? error.message
                : '无法初始化或读取工作副本，请在节点上核对目录和 VCS 配置';
            this.issues.set(config.workspaceId, message);
        }
    }

    workspaceIssue(workspaceId: string): string | undefined {
        return this.issues.get(workspaceId);
    }

    workspaceIssues(): { workspaceId: string; message: string }[] {
        return [...this.issues].map(([workspaceId, message]) => ({ workspaceId, message }));
    }

    async refreshWorkspaceIssues(projects: ProjectRecord[]): Promise<void> {
        const bound = new Map(projects.map(project => [project.workspaceId, project]));
        await Promise.all([...this.configs.values()].map(config => {
            const project = bound.get(config.workspaceId);
            return this.inspectWorkspace(config, project?.enabled ?? config.enabled !== false, project);
        }));
    }

    private async initializeWorkspace(config: ManagedWorkspace): Promise<WorkspaceRuntime> {
        if (this.stopped) throw new Error('托管执行器已停止');
        const root = await realpath(config.root);
        const identity = process.platform === 'win32' ? root.toLowerCase() : root;
        if (this.roots.has(identity)) throw new Error('多个 workspace 不能共享同一工作副本');
        this.roots.set(identity, config.workspaceId);
        let api: ReviewApi | undefined;
        try {
            const probe = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 10000 });
            const type = probe.code === 0 ? 'git' : 'svn';
            if (config.vcsType && config.vcsType !== type) throw new Error(`workspace ${config.workspaceId} 的 VCS 类型不匹配`);
            if (type === 'git' && await realpath(probe.stdout.trim()) !== root) throw new WorkspaceConfigurationError('workspace 必须是仓库根目录');
            if (type === 'svn') {
                const wcRoot = await runProcess('svn', ['info', '--show-item', 'wc-root', '.'], { cwd: root, timeoutMs: 30000 });
                if (wcRoot.code !== 0 || await realpath(wcRoot.stdout.trim()) !== root) throw new WorkspaceConfigurationError('SVN workspace 必须是工作副本根目录');
            }
            const targetResult = await runProcess(type, type === 'git' ? ['branch', '--show-current'] : ['info', '--show-item', 'relative-url', '.'], { cwd: root, timeoutMs: 30000 });
            const target = targetResult.stdout.trim();
            if (targetResult.code !== 0 || !target || (config.target && config.target !== target)) throw new WorkspaceTargetError(config.target, targetResult.code === 0 ? target : undefined);
            this.options.journal.bindWorkspace(config.workspaceId, JSON.stringify({ root: identity, type, target }));
            const settings: AppSettings = { ...DEFAULT_SETTINGS, ...config.settings, repoRoot: root, vcsType: type, baseBranch: target,
                owner: 'managed-node' };
            api = new ReviewApi({ settings, saveSettings: async () => { throw new Error('托管配置仅由节点本地文件管理'); },
                statePath: path.join(this.options.dataDir, `${config.workspaceId}-runtime.json`), decorateVcs: decorateManagedVcs,
                ...this.options.auditSessions,
                ...(this.options.resolveCredential ? { resolveCredential: this.options.resolveCredential } : {}) });
            await api.init();
            if (api.lastConfigErrors.length) throw new Error(api.lastConfigErrors.join('；'));
            if (this.stopped) throw new Error('托管执行器已停止');
            const registration: WorkspaceRegistration = {
                workspaceId: config.workspaceId, label: config.label, vcsType: type, target, executionConfigHash: executionConfigHash(config),
                ...(this.options.auditSessions?.auditStageExecutor ? { auditSelfTest: true } : {}),
                ...(settings.runner !== 'manual' && (settings.runner !== 'external' || settings.externalCommand.trim()) ? { supportsScheduledAudit: true } : {}),
            };
            const runtime = { root, api, registration, delivery: new ManagedDelivery({ root, type, target }) };
            this.runtimes.set(config.workspaceId, runtime);
            this.declarations.set(config.workspaceId, registration);
            return runtime;
        } catch (error) {
            this.roots.delete(identity);
            throw error;
        }
    }

    registrations(): WorkspaceRegistration[] { return [...this.declarations.values()].map(registration => ({ ...registration })); }

    private async runtime(project: ProjectRecord): Promise<WorkspaceRuntime> {
        const registration = this.declarations.get(project.workspaceId);
        if (!registration || registration.vcsType !== project.vcsType || registration.target !== project.target) throw new Error('项目与节点工作副本不匹配');
        if (project.executionConfigHash && project.executionConfigHash !== registration.executionConfigHash) throw new Error('本机执行配置与项目快照不一致');
        if (this.stopped) throw new Error('托管执行器已停止');
        const runtime = this.runtimes.get(project.workspaceId);
        if (runtime) return runtime;
        const config = this.configs.get(project.workspaceId)!;
        return this.runtimeForConfig({ ...config, vcsType: project.vcsType, target: project.target });
    }

    private runtimeForConfig(config: ManagedWorkspace): Promise<WorkspaceRuntime> {
        let pending = this.initializing.get(config.workspaceId);
        if (!pending) {
            pending = this.initializeWorkspace(config).finally(() => this.initializing.delete(config.workspaceId));
            this.initializing.set(config.workspaceId, pending);
        }
        return pending;
    }

    private async checkTarget(runtime: WorkspaceRuntime): Promise<void> {
        const result = await runProcess(runtime.registration.vcsType, runtime.registration.vcsType === 'git' ? ['branch', '--show-current'] : ['info', '--show-item', 'relative-url', '.'], { cwd: runtime.root, timeoutMs: 30000 });
        if (result.code !== 0 || result.stdout.trim() !== runtime.registration.target) throw new WorkspaceTargetError(runtime.registration.target, result.code === 0 ? result.stdout.trim() : undefined);
    }

    async execute(command: ManagedCommand, signal: AbortSignal, emit: (line: string) => void, project: ProjectRecord): Promise<ManagedResult> {
        if (command.operation === RETIRED_MANUAL_REVISION) return retiredManualRevisionResult();
        const runtime = await this.runtime(project);
        try { await this.checkTarget(runtime); }
        catch (error) {
            if (!(error instanceof WorkspaceTargetError)) throw error;
            return { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: error.message,
                ...(command.operation === 'test' ? { step: 'workspace' } : {}) }, delivery: { state: 'not_required' } };
        }
        if (command.projectId !== project.projectId || command.bindingGeneration !== project.bindingGeneration || command.projectConfigRevision !== project.projectConfigRevision) throw new Error('执行配置已过期');
        if (command.operation === 'test') {
            const result: ManagedResult = {
                outcome: await runtime.api.runAuditSelfTest(signal, (step, message) => {
                    this.options.journal.checkpoint(command.commandId, { phase: 'test', step });
                    emit(message);
                }),
                delivery: { state: 'not_required' },
            };
            this.options.journal.checkpoint(command.commandId, { phase: 'finished', result });
            return result;
        }
        if (command.payload.autoFix === true) return { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: '托管模式请先提交评论，再单独启动 AI 修复' }, delivery: { state: 'not_required' } };
        if (command.scheduledAudit && !runtime.registration.supportsScheduledAudit) {
            return { outcome: { status: 'ABORTED', reason: 'RUNNER_UNAVAILABLE', message: '此工作副本未配置进程型审查 Runner' }, delivery: { state: 'not_required' } };
        }
        this.options.journal.checkpoint(command.commandId, { phase: 'invoking', workspaceId: project.workspaceId });
        const inSession = command.operation === 'audit' && !command.scheduledAudit && Boolean(this.options.auditSessions?.createAuditSession);
        let session: { auditId: string; sessionId: string } | undefined;
        const response = await runtime.api.invoke({ method: 'POST', path: inSession ? '/audit/session' : routes[command.operation], body: { ...command.payload, ...command.guard,
            ...(command.operation === 'takeover' ? { owner: command.actor.reviewIdentity } : {}) },
        actor: { ...command.actor, commandId: command.commandId, findingWorkflow: command.payload.findingWorkflow === true,
            ...(inSession ? { managedAuditSession: { signal, onCreated: (auditId: string, sessionId: string) => {
                session = { auditId, sessionId };
                this.options.journal.checkpoint(command.commandId, { phase: 'session', workspaceId: project.workspaceId, ...session });
                emit(`已在 DSH 项目中创建审查会话：${sessionId}`);
            } } } : {}),
            ...(command.scheduledAudit ? { scheduledAudit: { ...command.scheduledAudit, target: runtime.registration.target, signal } } : {}) } });
        const data = object(response.body);
        let outcome: ManagedResult['outcome'];
        if (response.status >= 400) {
            const error = object(data.error), details = object(error.details);
            outcome = details.status === 'RECOVERY_REQUIRED' ? { ...details, status: 'RECOVERY_REQUIRED', message: error.message } : {
                status: response.status < 500 ? 'ABORTED' : 'RECOVERY_REQUIRED', reason: details.reason ?? error.code ?? 'EXECUTION_EXCEPTION', message: error.message, httpStatus: response.status,
            };
        } else if (typeof data.jobId === 'string') {
            this.options.journal.checkpoint(command.commandId, { phase: 'job', workspaceId: project.workspaceId, jobId: data.jobId, ...session });
            let offset = 0;
            const cancel = () => runtime.api.jobManager.abort(String(data.jobId));
            if (!inSession) {
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted) cancel();
            }
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
        if (session) outcome = { ...outcome, ...session };
        let commit = typeof outcome.commitRevision === 'string' ? outcome.commitRevision : null;
        if (!commit) commit = await runtime.delivery.findCommandCommit(command.commandId);
        const unverifiedAudit = command.operation === 'audit' && outcome.status === 'RECOVERY_REQUIRED';
        const result: ManagedResult = { outcome, delivery: unverifiedAudit
            ? { state: 'unknown', ...(commit ? { commitRevision: commit } : {}) }
            : commit ? { state: 'pending', commitRevision: commit } : { state: outcome.status === 'RECOVERY_REQUIRED' ? 'unknown' : 'not_required' } };
        this.options.journal.checkpoint(command.commandId, { phase: 'business_finished', result, ...session });
        if (commit && !unverifiedAudit) result.delivery = await runtime.api.withWriteLock(runtime.root, () => runtime.delivery.deliver(commit!));
        this.options.journal.checkpoint(command.commandId, { phase: 'finished', result, ...session });
        return result;
    }

    async recover(command: ManagedCommand, previous: ManagedResult | undefined, project: ProjectRecord): Promise<ManagedResult> {
        if (command.operation === 'test') {
            const checkpoint = this.options.journal.recoveryData(command.commandId);
            return checkpoint?.result as ManagedResult | undefined ?? {
                outcome: { status: 'ABORTED', reason: 'NODE_RESTARTED', step: checkpoint?.step ?? 'coordinator',
                    message: '自检执行中断，请重新发起自检' },
                delivery: { state: 'not_required' },
            };
        }
        const runtime = await this.runtime(project);
        return runtime.api.withWriteLock(runtime.root, async () => {
            let checkpoint = this.options.journal.recoveryData(command.commandId);
            if (!previous && !checkpoint && this.options.journal.get(command.commandId)?.phase === 'accepted') {
                checkpoint = { phase: 'not_started', workspaceId: project.workspaceId };
                this.options.journal.checkpoint(command.commandId, checkpoint);
            }
            await this.checkTarget(runtime);
            const saved = object(checkpoint?.result) as unknown as ManagedResult;
            const result = saved?.outcome ? structuredClone(saved) : previous?.outcome.status !== 'RECOVERY_REQUIRED' ? structuredClone(previous) : undefined;
            const commit = result?.delivery.commitRevision ?? await runtime.delivery.findCommandCommit(command.commandId);
            const blocking = runtime.api.auditLifecycle.blockingLeaseFor(runtime.root);
            const originalLease = blocking?.commandId === command.commandId ? blocking : undefined;
            const sessionId = result?.outcome.sessionId ?? checkpoint?.sessionId ?? previous?.outcome.sessionId ?? originalLease?.sessionId;
            const auditId = result?.outcome.auditId ?? checkpoint?.auditId ?? previous?.outcome.auditId ?? originalLease?.auditId;
            const session = typeof sessionId === 'string' && typeof auditId === 'string' ? { auditId, sessionId } : undefined;
            const lease = typeof auditId === 'string' ? runtime.api.leaseLookup(auditId) : undefined;
            const phasedRunner = command.operation === 'audit' && lease?.phased && !lease.sessionId
                && lease.commandId === command.commandId && lease.root === runtime.root
                && lease.trigger === (command.scheduledAudit ? 'scheduled' : 'manual') ? lease : undefined;
            if (!commit) {
                if (checkpoint?.phase === 'finished' && result?.delivery.state === 'not_required') return result;
                let diagnostic = '没有足够证据证明原执行结果；请保留现场并人工核验，不会重跑业务操作';
                if (phasedRunner) {
                    const releaseStarted = checkpoint?.phase === 'runner_releasing';
                    const current = await runtime.api.runtimeFor(new URL('http://managed/'));
                    if (!phasedRunner.commitOutcomeUnknown
                        && (phasedRunner.state === 'releasable' || (phasedRunner.state === 'released' && releaseStarted))
                        && await current.vcs.getCurrentBase() === phasedRunner.baseRevision
                        && (current.vcsType !== 'svn' || (phasedRunner.svnUrl && await readSvnAuditUrl(current.root) === phasedRunner.svnUrl
                            && (await (await managedSource(current.root, current.vcsType)).source.snapshotId())?.endsWith(`@${phasedRunner.baseRevision}`)))
                        && (await current.vcs.ensureCleanWorkspace()).clean && await scheduledReviewDataClean(current)) {
                        this.options.journal.checkpoint(command.commandId, { phase: 'runner_releasing', auditId: phasedRunner.auditId });
                        if (phasedRunner.state !== 'released') await runtime.api.leaseTransition(phasedRunner.auditId, 'released');
                        const recovered: ManagedResult = {
                            outcome: { status: 'ABORTED', reason: 'CANCELLED', auditId: phasedRunner.auditId,
                                baseRevision: phasedRunner.baseRevision, message: '已核验原 Runner 的工作副本安全并释放租约' },
                            delivery: { state: 'not_required' },
                        };
                        this.options.journal.checkpoint(command.commandId, { phase: 'finished', result: recovered });
                        return recovered;
                    }
                    return { outcome: { ...unknownResult(diagnostic).outcome, auditId: phasedRunner.auditId }, delivery: { state: 'unknown' } };
                }
                if (session && !command.scheduledAudit && command.operation === 'audit') {
                    const lease = runtime.api.leaseLookup(session.auditId);
                    const releaseStarted = checkpoint?.phase === 'session_releasing';
                    if (lease && lease.root === runtime.root && lease.trigger === 'manual' && lease.sessionId === session.sessionId
                        && !lease.commitOutcomeUnknown && (lease.state !== 'released' || releaseStarted)) {
                        const current = await runtime.api.runtimeFor(new URL('http://managed/'));
                        const revision = await current.vcs.getCurrentBase();
                        const shared = current.vcsType === 'svn' ? await (await managedSource(current.root, current.vcsType)).source.snapshotId() : null;
                        if (revision !== lease.baseRevision || (current.vcsType === 'svn' && !shared?.endsWith(`@${revision}`))) {
                            diagnostic = '工作副本的版本与原审查基线不一致，请核验变更后重试恢复。';
                        } else if (!(await current.vcs.ensureCleanWorkspace()).clean || !await scheduledReviewDataClean(current)) {
                            diagnostic = '工作副本仍有业务改动或 .ai-review 草稿。请在执行节点保留并处理这些改动，再重试恢复。';
                        } else {
                            this.options.journal.checkpoint(command.commandId, { phase: 'session_releasing', ...session });
                            if (lease.state !== 'released') await runtime.api.leaseTransition(lease.auditId, 'released');
                            const recovered: ManagedResult = {
                                outcome: { status: 'ABORTED', reason: 'CANCELLED', ...session,
                                    message: '已确认会话停止且工作副本无本轮遗留改动，审查占用已释放' },
                                delivery: { state: 'not_required' },
                            };
                            this.options.journal.checkpoint(command.commandId, { phase: 'finished', result: recovered });
                            return recovered;
                        }
                    }
                }
                if (command.scheduledAudit && (result?.outcome.reason === 'SCHEDULE_RECHECK_DIRTY' || result?.outcome.reason === 'SCHEDULE_SCAN_DIRTY')) {
                    const { auditId, baseRevision } = result.outcome;
                    const lease = typeof auditId === 'string' ? runtime.api.leaseLookup(auditId) : undefined;
                    const releaseStarted = checkpoint?.phase === 'recheck_releasing';
                    if (!lease || lease.commitOutcomeUnknown || lease.root !== runtime.root || lease.trigger !== 'scheduled' || lease.baseRevision !== baseRevision
                        || (lease.state !== 'releasable' && !(lease.state === 'released' && releaseStarted))) return result;
                    const current = await runtime.api.runtimeFor(new URL('http://managed/'));
                    if (await current.vcs.getCurrentBase() !== lease.baseRevision || !(await current.vcs.ensureCleanWorkspace()).clean
                        || !await scheduledReviewDataClean(current)) return result;
                    if (current.vcsType === 'svn') {
                        const { source } = await managedSource(current.root, current.vcsType);
                        if (!(await source.snapshotId())?.endsWith(`@${lease.baseRevision}`)) return result;
                    }
                    this.options.journal.checkpoint(command.commandId, { phase: 'recheck_releasing', result });
                    await runtime.api.leaseTransition(lease.auditId, 'released');
                    const recovered: ManagedResult = {
                        outcome: { status: 'ABORTED', reason: `${result.outcome.reason}_RECOVERED`, auditId, baseRevision,
                            message: '已确认本轮审查未产生提交，且绑定工作副本已还原，租约已释放' },
                        delivery: { state: 'not_required' },
                    };
                    this.options.journal.checkpoint(command.commandId, { phase: 'finished', result: recovered });
                    return recovered;
                }
                if (result?.delivery.state === 'not_required') return result;
                if (checkpoint?.phase === 'not_started' && (!previous || previous.outcome.status === 'RECOVERY_REQUIRED')
                    && !runtime.api.auditLifecycle.blockingLeaseFor(runtime.root)) {
                    const current = await runtime.api.runtimeFor(new URL('http://managed/'));
                    const clean = await current.vcs.ensureCleanWorkspace();
                    if (clean.clean) return { outcome: { status: 'ABORTED', reason: command.operation === 'approve' ? 'COMMIT_FAILED' : 'CANCELLED',
                        message: '原指令未进入业务执行，已核验工作副本安全；不会重跑业务操作' }, delivery: { state: 'not_required' } };
                }
                const unresolved = unknownResult(diagnostic);
                if (session) unresolved.outcome = { ...unresolved.outcome, ...session };
                return unresolved;
            }
            const restored = result ?? { outcome: { status: 'RECOVERY_REQUIRED', reason: 'EXECUTION_OUTCOME_UNKNOWN', commitRevision: commit,
                detail: '已找到原指令的提交，但缺少完整业务结果，不能仅据提交标记推断执行成功' }, delivery: { state: 'pending' as const, commitRevision: commit } };
            if (session) restored.outcome = { ...restored.outcome, ...session };
            if (command.operation === 'audit' && restored.outcome.status === 'RECOVERY_REQUIRED') {
                return { ...restored, delivery: { state: 'unknown', commitRevision: commit } };
            }
            restored.delivery = await runtime.delivery.deliver(commit);
            this.options.journal.checkpoint(command.commandId, { phase: 'finished', result: restored });
            return restored;
        });
    }

    async snapshot(project: ProjectRecord) {
        const runtime = await this.runtime(project);
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
        const runtime = await this.runtime(project);
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

    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.all([...this.runtimes.values()].map(({ api }) => api.closeAudit()));
    }
}
