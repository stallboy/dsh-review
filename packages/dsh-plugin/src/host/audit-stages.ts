import { readFile, realpath, writeFile, rm, rmdir, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { AUDIT_TIMEOUT_MS, type AuditLeaseRecord } from './audit-lifecycle.js';
import type { AuditItem } from './audit-archive.js';
import { FINDING_ID_PATTERN } from './invariants.js';
import { renderAuditTemplate, type AuditStage } from './audit-prompts.js';
import { compatibleAuditBase, createArtifactDirectory, validSourcePath, withinScope, type StageCandidate } from './audit-stage-artifacts.js';
import { parsePatch, isAiReviewPath } from './patch.js';
import { prepareIssuePublication } from './issue-publication.js';
import {
    arraySchema, AUDIT_EXECUTORS, auditObject, AuditExecutorAuthenticationError, AuditStageTimedOut, AuditStopUnknown, enumSchema, integerSchema,
    objectSchema, stringSchema, validateAuditValue, type AuditExecutor, type ExecuteAuditStage,
} from './audit-stage-runner.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewersConfig } from './reviewers.js';
import type { VcsAdapter } from './vcs.js';
import { AUDIT_TYPES, type AuditType } from './types.js';

const strings = arraySchema(stringSchema);
const navigation = { path: stringSchema, line: integerSchema };
const evidence = objectSchema({ ...navigation, excerpt: stringSchema, reason: stringSchema });
const neutralQuestions = {
    retry_after_response_timeout: '首次写入成功但响应超时后，从导航处用同一请求 ID 重试时，实际会持久化写入几次？调用链上有哪些限制或保护？',
    repeated_request: '从导航处重复提交同一请求时，会发生哪些状态变化或产生哪些副作用？在什么条件下会不同？',
    concurrent_requests: '从导航处并发处理相关请求时，哪些操作可能交错？各自的状态与可观察结果是什么？',
    state_transition: '从导航处触发状态转换时，满足哪些条件才允许变更？各分支最终会进入什么状态？',
    error_path: '从导航处遇到异常或部分失败时，调用方会看到什么结果，已经产生的状态或副作用如何处理？',
    reference_usage: '导航处的实现在哪些入口、配置、测试和动态调用中被引用？目前的视图能覆盖哪些引用类型？',
    reachable_behavior: '导航处可从哪些实际入口到达，各自需要满足什么条件？实际行为和限制该行为的逻辑是什么？',
} as const;
const taskSchemas = {
    scan: objectSchema({ taskScope: strings, scenarios: strings, questions: strings, constraints: strings }),
    verify: objectSchema({ subjectId: stringSchema, scenario: enumSchema(...Object.keys(neutralQuestions)),
        navigation: arraySchema(objectSchema(navigation)), expectationIndexes: arraySchema(integerSchema) }),
    patch: objectSchema({ subjectId: stringSchema, auditType: enumSchema(...AUDIT_TYPES),
        allowedPaths: strings, acceptance: strings, gateCommands: strings }),
};
const resultSchemas = {
    scan: objectSchema({
        leads: arraySchema(objectSchema({
            leadId: stringSchema, entry: stringSchema, navigation: arraySchema(objectSchema(navigation)),
            preconditions: strings, expectedBehavior: stringSchema, suspectedImpact: stringSchema,
        })),
        coverage: strings, limits: strings,
    }),
    verify: objectSchema({
        verdict: enumSchema('confirmed', 'refuted', 'insufficient_evidence'), reason: stringSchema, preconditions: strings,
        observedBehavior: stringSchema, impact: stringSchema, evidence: arraySchema(evidence), limits: strings,
    }),
    patch: objectSchema({
        status: enumSchema('ready', 'blocked'), patchPath: stringSchema, confidence: integerSchema,
        summary: stringSchema, reason: stringSchema, tradeoff: stringSchema, humanDecisions: strings,
    }),
};
const priorityValues = ['P0', 'P1', 'P2', 'P3'] as const;
const publicationSchema = objectSchema({
    findings: arraySchema(objectSchema({
        subjectId: stringSchema, title: stringSchema, priority: enumSchema(...priorityValues),
        kind: enumSchema('A', 'B', 'Deferred'), decision: stringSchema, dependsOn: stringSchema,
    })),
    coverage: strings, requirements: strings, history: strings,
});

interface Anchor { path: string; line: number; excerpt: string; reason: string }
interface Verification {
    verdict: 'confirmed' | 'refuted' | 'insufficient_evidence';
    reason: string;
    preconditions: string[];
    observedBehavior: string;
    impact: string;
    evidence: Anchor[];
    limits: string[];
}
export interface AuditPriorityEntry {
    title: string;
    priority: typeof priorityValues[number];
    kind: 'A' | 'B' | 'Deferred';
}

interface Finding extends AuditPriorityEntry {
    subjectId: string;
    decision: string;
    dependsOn: string;
    repairPlan?: string;
    findingId?: string;
}

const SUBJECT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const common = (lease: AuditLeaseRecord, vcsType: VcsAdapter['type']) => ({
    auditId: lease.auditId, baseRevision: lease.baseRevision, scope: lease.targetPath || '.', vcsType,
});
const reportPath = (lease: AuditLeaseRecord) => '.ai-review/audits/' + lease.auditId + '/audit.md';

export function auditUserFields(input: Readonly<Record<string, unknown>>): { focus: string[]; extraRequirements: string[] } {
    const read = (name: string) => {
        const value = input[name];
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || item.length > 1600)) {
            throw new Error('审查附加字段非法：' + name);
        }
        return (value as string[]).map(item => item.trim()).filter(Boolean);
    };
    return { focus: read('focus'), extraRequirements: read('extraRequirements') };
}

export async function renderAuditCoordinator(input: {
    lease: AuditLeaseRecord; vcsType: VcsAdapter['type']; reviewers: ReviewersConfig;
    history: { activeCandidates: string; negativeMemory: string };
    executionMode: 'dsh-session' | 'host-channel'; findingWorkflow: boolean;
    focus: string[]; extraRequirements: string[]; automaticCandidates?: boolean;
}): Promise<string> {
    const { lease, reviewers } = input;
    return renderAuditTemplate('orchestrator', {
        ...common(lease, input.vcsType), deadlineAt: new Date(Date.parse(lease.createdAt) + AUDIT_TIMEOUT_MS).toISOString(),
        reportPath: reportPath(lease), executionMode: input.executionMode, availableRunners: AUDIT_EXECUTORS,
        ownerRouting: {
            allowedGateCommands: reviewers.allowedGateCommands,
            automaticCandidates: input.automaticCandidates === true, findingWorkflow: input.findingWorkflow,
        }, history: input.history, focus: input.focus, extraRequirements: input.extraRequirements,
    });
}

export interface AuditStageExecution {
    stage: AuditStage;
    runner: AuditExecutor;
}

export class AuditStages {
    private readonly abort = new AbortController();
    private readonly leads = new Map<string, { token: string; navigation: Array<{ path: string; line: number }> }>();
    private readonly reviews = new Map<string, Verification>();
    private readonly candidates = new Map<string, StageCandidate[]>();
    private readonly coverage: string[] = [];
    private readonly authenticationFailures = new Set<AuditExecutor>();
    private readonly failedScans = new Set<AuditExecutor>();
    private taskCounter = 0;
    private scanned = false;
    private execution?: AuditStageExecution & ({ state: 'running' } | { state: 'uncertain'; detail: string; timedOut?: AuditStageTimedOut });
    busy = false;
    stageStopConfirmed = Promise.resolve(true);

    get runningStage() { return this.execution?.state === 'running' ? this.execution : undefined; }
    get interruptedStage() { return this.execution?.state === 'uncertain' ? this.execution : undefined; }
    get uncertain(): boolean { return this.interruptedStage !== undefined; }
    get allScanExecutorsFailed(): boolean { return !this.scanned && this.failedScans.size === AUDIT_EXECUTORS.length; }

    constructor(
        readonly lease: AuditLeaseRecord,
        readonly vcs: VcsAdapter,
        private readonly reviewers: ReviewersConfig,
        private readonly execute: ExecuteAuditStage,
        private readonly userExpectations: string[] = [],
        readonly historySource?: SharedCandidateSource,
        readonly findingWorkflow?: boolean,
        private readonly log?: (line: string) => void,
    ) {}

    cancel(): void { this.abort.abort(); }

    private async source(file: string): Promise<string | null> {
        if (!validSourcePath(file)) return null;
        const absolute = await realpath(path.join(this.lease.root, file)).catch(() => null);
        const root = await realpath(this.lease.root);
        if (!absolute || !absolute.startsWith(root + path.sep)) return null;
        return readFile(absolute, 'utf8').catch(() => null);
    }

    private async verify(value: Record<string, unknown>, signal: AbortSignal): Promise<Verification> {
        const verdict = value as unknown as Verification;
        if (verdict.verdict === 'insufficient_evidence') return verdict;
        const evidenceValid = verdict.evidence.length > 0 && (await Promise.all(verdict.evidence.map(async item => {
            signal.throwIfAborted();
            if (!validSourcePath(item.path)
                || item.line < 1 || !item.excerpt.trim() || item.excerpt.length > 1000 || !item.reason.trim()) return false;
            const text = await this.source(item.path);
            return text?.split(/\r?\n/)[item.line - 1]?.includes(item.excerpt) === true;
        }))).every(Boolean);
        if (evidenceValid && verdict.reason.trim() && (verdict.verdict !== 'confirmed'
            || (verdict.preconditions.some(text => text.trim()) && verdict.observedBehavior.trim() && verdict.impact.trim()))) return verdict;
        return { ...verdict, verdict: 'insufficient_evidence', reason: 'Host 无法核验复核证据或因果结论', evidence: [] };
    }

    async run(stage: AuditStage, executor: AuditExecutor, task: unknown, outerSignal: AbortSignal, onTimeout?: () => void): Promise<unknown> {
        if (this.busy || this.uncertain || this.abort.signal.aborted || this.lease.stageSeal || this.lease.state !== 'active') {
            throw new Error('此轮不能启动阶段任务');
        }
        const schema = taskSchemas[stage];
        if (!schema || !AUDIT_EXECUTORS.includes(executor)) throw new Error('未知审查阶段或执行器');
        if (this.authenticationFailures.has(executor)) {
            const alternative = AUDIT_EXECUTORS.find(runner => runner !== executor && !this.authenticationFailures.has(runner));
            throw new Error(executor + ' 认证失败，本轮已停止派发' + (alternative ? '，可独立启动 ' + alternative : '，当前没有可用执行器'));
        }
        const raw = auditObject(task);
        const { approach, optionId, forensicPaths: requestedForensics, ...patchTask } = raw;
        if (optionId !== undefined && (stage !== 'patch' || typeof optionId !== 'string' || !SUBJECT.test(optionId))) throw new Error('修订方案编号无效');
        const forensicPaths = requestedForensics === undefined ? [] : requestedForensics;
        if (!Array.isArray(forensicPaths) || forensicPaths.length > 10 || forensicPaths.some(file => typeof file !== 'string' || !validSourcePath(file))) {
            throw new Error('临时取证路径须为不超过十个项目内具体文件');
        }
        if (stage === 'patch' && approach !== undefined && (typeof approach !== 'string' || !approach.trim())) {
            throw new Error('备选补丁必须说明修复方法');
        }
        validateAuditValue(schema, patchTask, 'task');
        let input = patchTask;
        const subject = String(input['subjectId'] ?? '');
        const existingCandidates = this.candidates.get(subject) ?? [];
        if (stage !== 'scan' && !this.leads.has(subject)) throw new Error('请使用本轮已登记的线索 ID');
        if ((stage === 'verify' && existingCandidates.length > 0)
            || (stage === 'patch' && (existingCandidates.length >= 2 || (existingCandidates.length > 0 && !approach)))) {
            throw new Error('同一发现最多生成两个独立补丁；备选补丁需要说明方法');
        }
        if (stage === 'patch' && this.reviews.get(subject)?.verdict !== 'confirmed') throw new Error('候选需要 Host 核验通过的复核');
        if (stage === 'verify') {
            const registered = this.leads.get(subject)!;
            const requested = input['navigation'] as Array<{ path: string; line: number }>;
            if (!requested.length || requested.some(item => !registered.navigation.some(anchor => anchor.path === item.path && anchor.line === item.line))) {
                throw new Error('复核导航需要对应已登记线索的路径和行号');
            }
            const indexes = input['expectationIndexes'] as number[];
            if (indexes.some(index => index < 0 || index >= this.userExpectations.length)) {
                throw new Error('业务预期需要引用本轮额外要求');
            }
            const scenario = input['scenario'] as keyof typeof neutralQuestions;
            input = {
                subjectId: registered.token,
                question: neutralQuestions[scenario],
                navigation: registered.navigation.filter(anchor => requested.some(item => anchor.path === item.path && anchor.line === item.line)),
                expectedBehavior: [...new Set(indexes)].map(index => ({
                    text: this.userExpectations[index], source: '本轮用户附加要求',
                })),
            };
        }
        const preferred = stage === 'verify'
            ? (input['navigation'] as Array<{ path: string }>).map(item => item.path)
            : input[stage === 'scan' ? 'taskScope' : 'allowedPaths'] as string[];
        if (preferred.some(file => (file !== '.' && !validSourcePath(file)) || (stage !== 'verify' && !withinScope(this.lease.targetPath, file)))
            || (stage === 'patch' && (!preferred.length || preferred.includes('.')))) throw new Error('阶段路径超出审查范围');
        const commands = stage === 'patch' ? input['gateCommands'] as string[] : [];
        if (stage === 'patch' && (!commands.length || commands.some(command => !this.reviewers.allowedGateCommands.includes(command)))) {
            throw new Error('候选门禁需要命中本轮共享快照的允许列表');
        }
        const remaining = Date.parse(this.lease.createdAt) + AUDIT_TIMEOUT_MS - Date.now();
        if (remaining <= 0) throw new Error('审查租约已到期');
        const signal = AbortSignal.any([outerSignal, this.abort.signal, AbortSignal.timeout(remaining)]);
        this.busy = true;
        this.execution = { state: 'running', stage, runner: executor };
        const taskId = stage + '-' + String(++this.taskCounter);
        const log = (line: string) => this.log?.(taskId + ' ' + executor + ' ' + line);
        let scratch: string | undefined;
        let evidenceDir: string | undefined;
        const forensics = new Map<string, { bytes: Buffer | null; mode?: number }>();
        let executorInvoked = false;
        let processTreeStopped = true;
        let recordStop!: (confirmed: boolean) => void;
        this.stageStopConfirmed = new Promise(resolve => { recordStop = resolve; });
        let restored = false;
        const restoreForensics = async (): Promise<void> => {
            if (restored || this.uncertain || !scratch) return;
            restored = true;
            if (!this.uncertain && scratch) {
                for (const [file, before] of forensics) {
                    try {
                        const absolute = path.join(this.lease.root, file);
                        const info = await lstat(absolute).catch(() => null);
                        if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('取证文件已被替换为链接或目录');
                        const bytes = await readFile(absolute).catch(() => null);
                        if (bytes) {
                            const archived = path.join(evidenceDir!, 'forensics', file);
                            await createArtifactDirectory(this.lease.root, path.relative(this.lease.root, path.dirname(archived)).split(path.sep).join('/'));
                            await writeFile(archived, bytes, { flag: 'wx' });
                        }
                        if (before.bytes) {
                            await writeFile(absolute, before.bytes);
                            if (before.mode !== undefined) await chmod(absolute, before.mode);
                        }
                        else await rm(absolute, { force: true });
                    } catch {
                        this.execution = { state: 'uncertain', stage, runner: executor, detail: '取证文件归档或还原失败，请核验工作副本。' };
                    }
                }
                if (!(await this.vcs.ensureCleanWorkspace()).clean) this.execution = { state: 'uncertain', stage, runner: executor, detail: '阶段结束后业务工作区未还原，现场保留待核验。' };
                if (!this.uncertain) {
                    await rm(scratch, { recursive: true, force: true });
                    await rmdir(path.dirname(scratch)).catch(() => undefined);
                    await rmdir(path.dirname(path.dirname(scratch))).catch(() => undefined);
                    if (evidenceDir) {
                        await rmdir(evidenceDir).catch(() => undefined);
                        await rmdir(path.dirname(evidenceDir)).catch(() => undefined);
                    }
                }
            }
        };
        try {
            if (!await compatibleAuditBase(this.vcs, this.lease.baseRevision, this.lease.svnUrl)) throw new AuditStopUnknown('阶段执行前业务基线已变化');
            const verification = this.reviews.get(subject);
            const id = this.lease.createdAt.slice(0, 7) + '/' + this.lease.auditId.slice(0, 15) + '-' + subject
                + (existingCandidates.length > 0 ? '-option-' + String(existingCandidates.length + 1) : '');
            const stageData = {
                ...common(this.lease, this.vcs.type), taskId, ...input,
                ...(stage === 'patch' ? {
                    confirmedFact: verification!.observedBehavior, evidence: verification!.evidence,
                    ownerRouting: { rules: this.reviewers.rules, defaultOwner: this.reviewers.defaultOwner },
                    candidate: { id, createdAt: this.lease.createdAt,
                        artifactDir: '.ai-review/audits/' + this.lease.auditId + '/evidence/' + taskId,
                        ...(typeof optionId === 'string' ? { optionId } : {}),
                        ...(typeof approach === 'string' ? { approach } : {}) },
                } : {}),
            };
            const template = await renderAuditTemplate(stage, stageData);
            const executionDir = await createArtifactDirectory(this.lease.root, '.ai-review/audits/' + this.lease.auditId + '/evidence/' + taskId);
            evidenceDir = executionDir;
            scratch = await createArtifactDirectory(this.lease.root, '.ai-review/.runtime/' + this.lease.auditId + '/' + taskId);
            for (const file of forensicPaths as string[]) {
                const parent = await realpath(path.dirname(path.join(this.lease.root, file)));
                const root = await realpath(this.lease.root);
                if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('取证文件越出工作目录');
                const absolute = path.join(this.lease.root, file);
                const info = await lstat(absolute).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    return null;
                });
                if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('取证路径必须为项目内普通文件');
                const bytes = await readFile(absolute).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    return null;
                });
                forensics.set(file, { bytes, ...(info ? { mode: info.mode } : {}) });
            }
            log('启动执行器');
            executorInvoked = true;
            processTreeStopped = false;
            const result = await this.execute({
                executor, location: scratch, repoRoot: this.lease.root, forensicPaths: forensicPaths as string[], logProcessExit: log, ...(onTimeout ? { onTimeout } : {}),
                onProcessTreeStopped: stopped => { processTreeStopped = stopped; },
                prompt: template + '\n\n工作目录：' + this.lease.root + '\n所有项目文件均可通过 Harness 工具自主读取。默认仅写 .ai-review。'
                    + '\n本阶段取证产物目录：' + executionDir + '\n获准临时取证文件：' + JSON.stringify(forensicPaths)
                    + '\n禁止应用修复补丁、提交或切换分支；不得以修复后测试冒充审查证据。',
                schema: resultSchemas[stage], signal, timeoutMs: Math.min(60 * 60_000, remaining),
            });
            if (!processTreeStopped) throw new AuditStopUnknown('阶段进程树停止状态无法核验');
            await restoreForensics();
            if (this.uncertain) throw new AuditStopUnknown('阶段取证文件还原或业务工作区核验失败', true);
            validateAuditValue(resultSchemas[stage], result);
            const value = auditObject(result);
            signal.throwIfAborted();
            if (!await compatibleAuditBase(this.vcs, this.lease.baseRevision, this.lease.svnUrl)) throw new AuditStopUnknown('阶段执行期间业务基线已变化');
            log('执行器结果已校验');
            if (stage === 'scan') {
                const leads = value['leads'] as Array<{ leadId: string; navigation: Array<{ path: string; line: number }> }>;
                const seen = new Set<string>();
                for (const lead of leads) {
                    if (!SUBJECT.test(lead.leadId) || seen.has(lead.leadId) || this.leads.has(lead.leadId)
                        || !lead.navigation.length || lead.navigation.some(item => !validSourcePath(item.path)
                            || !withinScope(this.lease.targetPath, item.path) || item.line < 1
                            )) throw new Error('初审线索 ID 或导航非法');
                    for (const anchor of lead.navigation) {
                        if (anchor.line > ((await this.source(anchor.path))?.split(/\r?\n/).length ?? 0)) throw new Error('初审导航不存在');
                    }
                    seen.add(lead.leadId);
                }
                for (const lead of leads) this.leads.set(lead.leadId, {
                    token: 'lead-' + String(this.leads.size + 1), navigation: lead.navigation,
                });
                this.scanned = true;
                this.coverage.push(...(value['coverage'] as string[]).map(line => taskId + ' 覆盖：' + line));
                this.coverage.push(...(value['limits'] as string[]).map(line => taskId + ' 限制：' + line));
                return value;
            }
            if (stage === 'verify') {
                const checked = await this.verify(value, signal);
                this.reviews.set(subject, checked);
                this.coverage.push(...checked.limits.map(line => taskId + ' 限制：' + line));
                return checked;
            }
            if (value['status'] === 'blocked') return { status: 'blocked', reason: value['reason'] };
            if (!String(value['summary']).trim()) throw new Error('候选方案缺少修复说明');
            const proposed = String(value['patchPath']);
            const absolute = await realpath(path.resolve(this.lease.root, proposed));
            if (!absolute.startsWith((await realpath(executionDir)) + path.sep)) throw new Error('补丁必须写在本阶段产物目录');
            const patch = await readFile(absolute, 'utf8');
            const paths = parsePatch(patch).paths;
            if (!paths.length || paths.some(file => !preferred.includes(file) || isAiReviewPath(file)) || Number(value['confidence']) < 0 || Number(value['confidence']) > 100) throw new Error('提案补丁路径或置信度无效');
            const checked = await this.vcs.checkPatch(absolute);
            if (!checked.ok) throw new Error('提案补丁未通过原生只读预检：' + checked.message);
            const candidate: StageCandidate = { id, title: String(value['summary']), patch, review: '',
                proposal: { ...(typeof optionId === 'string' ? { optionId } : {}), auditType: input['auditType'] as AuditType, commands, confidence: Number(value['confidence']) / 100,
                    tradeoff: String(value['tradeoff']), humanDecisions: value['humanDecisions'] as string[] } };
            if (existingCandidates.some(option => option.patch === candidate.patch)) throw new Error('备选补丁与先前方案相同');
            this.candidates.set(subject, [...existingCandidates, candidate]);
            return { status: 'ready', candidateId: candidate.id };
        } catch (error) {
            if (error instanceof AuditExecutorAuthenticationError) {
                this.authenticationFailures.add(executor);
                this.coverage.push(taskId + ' ' + executor + ' 认证失败，本轮停止派发');
                log('认证失败，本轮停止派发');
            } else {
                this.coverage.push(taskId + ' 未完成');
                log(signal.aborted ? '阶段已取消或超时' : '阶段未完成');
            }
            if (error instanceof AuditStopUnknown && error.processTreeStopped) processTreeStopped = true;
            if (error instanceof AuditStopUnknown || signal.aborted || executorInvoked && !processTreeStopped) {
                this.execution = { state: 'uncertain', stage, runner: executor,
                    detail: error instanceof AuditStopUnknown ? error.message : '无法确认审查阶段已安全停止，请核验执行器与工作副本。',
                    ...(error instanceof AuditStageTimedOut ? { timedOut: error } : {}) };
            } else if (stage === 'scan' && executorInvoked) {
                this.failedScans.add(executor);
            }
            throw error;
        } finally {
            await restoreForensics();
            if (!this.uncertain) delete this.execution;
            this.busy = false;
            recordStop(processTreeStopped);
        }
    }

    async publication(input: unknown, recheck?: import('./audit-history.js').AuditRecheck, recheckEvidence?: unknown[]): Promise<{ path: string; body: string; candidates: StageCandidate[]; items: AuditItem[]; overview: AuditPriorityEntry[] }> {
        if (this.busy || this.uncertain || this.abort.signal.aborted || this.lease.state !== 'active' || this.lease.stageSeal || !this.scanned) {
            throw new Error('发布需要完成初审、停止阶段执行并且没有恢复事项');
        }
        const value = auditObject(input);
        if (!Array.isArray(value['findings'])) throw new Error('findings 必须为数组');
        const rawFindings = value['findings'].map(auditObject);
        validateAuditValue(publicationSchema, { ...value, findings: rawFindings.map(({ repairPlan, findingId, ...item }) => item) }, 'publication');
        const findings = value['findings'] as Finding[];
        const versioned = true;
        if (versioned && this.findingWorkflow === false) throw new Error('报告须使用当前节点与中央共同支持的档案格式');
        const selected = new Set<string>();
        for (const finding of findings) {
            const { subjectId } = finding;
            if (!SUBJECT.test(subjectId)) throw new Error('报告发现的 subjectId 无效');
            if (selected.has(subjectId)) throw new Error('报告包含重复发现：' + subjectId);
            const verdict = this.reviews.get(subjectId)?.verdict;
            if (verdict !== 'confirmed') throw new Error('报告发现 ' + subjectId + ' 未核实（' + (verdict ?? '未复核') + '），请计入覆盖说明');
            if (!finding.title.trim()) throw new Error('报告发现缺少标题：' + subjectId);
            selected.add(subjectId);
            if (finding.kind === 'A' && !this.candidates.has(finding.subjectId)) throw new Error('A 类必须绑定本轮合格候选');
            if (versioned && (typeof finding.repairPlan !== 'string' || !finding.repairPlan.trim())) {
                throw new Error('新版发现需要包含证据、步骤和验收条件的修复方案');
            }
            if (finding.findingId !== undefined && (!versioned || typeof finding.findingId !== 'string' || !FINDING_ID_PATTERN.test(finding.findingId))) {
                throw new Error('发现编号无效');
            }
            if (finding.kind === 'B' && !finding.decision.trim()) throw new Error('B 类缺少待决定事项');
            if (finding.kind === 'Deferred' && (!SUBJECT.test(finding.dependsOn) || finding.dependsOn === finding.subjectId)) {
                throw new Error('Deferred 缺少有效的前置问题 ID');
            }
        }
        const missing = [...this.reviews].filter(([id, result]) => result.verdict === 'confirmed' && !selected.has(id));
        if (missing.length) throw new Error('正式报告遗漏了已确认的问题：' + missing.map(([id]) => id).join('、'));
        const sorted = findings.map((finding, index) => ({ finding, index })).sort((left, right) =>
            priorityValues.indexOf(left.finding.priority) - priorityValues.indexOf(right.finding.priority)
            || left.index - right.index || left.finding.subjectId.localeCompare(right.finding.subjectId)).map(item => item.finding);
        this.busy = true;
        try { return await prepareIssuePublication({
            lease: this.lease, findings: sorted, reviews: this.reviews, proposals: this.candidates,
            reviewers: this.reviewers, source: this.historySource, vcs: this.vcs,
            recheck, recheckEvidence,
            coverage: [...value['coverage'] as string[], ...this.coverage, ...value['requirements'] as string[],
                ...[...this.leads.keys()].filter(id => !this.reviews.has(id)).map(id => id + ' 未复核'),
                ...[...this.reviews].filter(([, result]) => result.verdict !== 'confirmed').map(([id, result]) => id + '：'
                    + (result.verdict === 'refuted' ? '已排除。' : '证据不足。') + result.reason)],
            history: value['history'] as string[],
        }); } finally { this.busy = false; }
    }
}
