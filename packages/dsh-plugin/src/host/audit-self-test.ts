import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiDeps } from './api-context.js';
import { serializeAuditMarkdown } from './audit-archive.js';
import { publishStageArtifacts } from './audit-stage-artifacts.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import { AUDIT_EXECUTORS, auditCliDiagnostic, auditObject, objectSchema, stringSchema, validateAuditValue, type AuditExecutor } from './audit-stage-runner.js';
import type { AuditStage } from './audit-prompts.js';
import type { AuditPriorityEntry } from './audit-stages.js';
import { validateReviewData } from './review-data-validation.js';
import { runAgent, wrapAgentPrompt } from './runner.js';

const TIMEOUT_MS = 5 * 60_000;
const STAGE_TIMEOUT_MS = 40_000;
const schema = objectSchema({ value: stringSchema });
const stageTask = { taskScope: [], scenarios: [], questions: [], constraints: [] };
const publishFields = ['findings', 'coverage', 'requirements', 'history'];

type Step = 'coordinator' | AuditExecutor | 'publish' | 'validate' | 'cleanup';
type Outcome = { status: 'SUCCEEDED'; steps: Step[] } | {
    status: 'ABORTED'; reason: 'CANCELLED' | 'SELF_TEST_FAILED'; step: Step; message: string; steps: Step[];
};
export interface AuditSelfTestTools {
    run(stage: AuditStage, runner: AuditExecutor, task: unknown, signal: AbortSignal): Promise<unknown>;
    publish(input: unknown, signal?: AbortSignal): Promise<{ reportPath: string; overview: AuditPriorityEntry[] }>;
}

export async function runAuditSelfTest({ deps, settings, signal: commandSignal, progress, sessions }: {
    deps: ApiDeps;
    settings: ApiDeps['settings'];
    signal: AbortSignal;
    progress: (step: Step, message: string) => void;
    sessions: Map<string, AuditSelfTestTools>;
}): Promise<Outcome> {
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = AbortSignal.any([commandSignal, timeout, abort.signal]);
    const steps: Step[] = [];
    const samples = new Map(AUDIT_EXECUTORS.map(runner => [runner, 'test-' + randomBytes(5).toString('hex')]));
    const values = new Map<AuditExecutor, string>();
    const invoked = new Set<AuditExecutor>();
    const pending: Promise<unknown>[] = [];
    let publicationStarted = false;
    let publicationAttempted = false;
    const running = new Set<Step>();
    let failure: { step: Step; message: string } | undefined;
    let scratch: string | undefined;
    let sessionId: string | undefined;
    let channel: Awaited<ReturnType<typeof openAuditStageChannel>> | undefined;

    function track<T>(step: Step, message: string, action: () => Promise<T>): Promise<T> {
        running.add(step);
        progress(step, message);
        const task = action().catch(error => {
            failure ??= { step, message: error instanceof Error ? error.message : String(error) };
            abort.abort();
            throw error;
        }).finally(() => { running.delete(step); });
        pending.push(task);
        return task;
    }

    let outcome: Outcome;
    try {
        progress('coordinator', '正在启动自检主代理');
        signal.throwIfAborted();
        const execute = deps.auditStageExecutor;
        if (!execute) throw new Error('节点缺少审查子代理执行能力');
        const directory = await mkdtemp(path.join(tmpdir(), 'dsh-audit-test-'));
        scratch = directory;
        const cwd = path.join(directory, 'workspace');
        await mkdir(cwd);
        const tools: AuditSelfTestTools = {
            async run(stage, runner, task, requestSignal) {
                const active = AbortSignal.any([signal, requestSignal]);
                active.throwIfAborted();
                const sample = samples.get(runner);
                if (stage !== 'scan' || !sample || invoked.has(runner)) throw new Error('自检只允许每个子代理执行一次固定任务');
                const input = auditObject(task);
                if (Object.keys(input).length !== Object.keys(stageTask).length || Object.keys(stageTask).some(key => {
                    const value = input[key];
                    return !Array.isArray(value) || value.length !== 0;
                })) throw new Error('自检阶段参数必须使用固定空数组');
                invoked.add(runner);
                return track(runner, '正在调用 ' + runner, async () => {
                    const location = path.join(cwd, '.ai-review', 'runtime', runner);
                    await mkdir(location, { recursive: true });
                    const samplePath = path.join(cwd, runner + '-sample.txt');
                    await writeFile(samplePath, 'x'.repeat(150_000) + '\n' + sample + '\n');
                    const result = await execute({
                        executor: runner, location, repoRoot: cwd, schema, signal: active, timeoutMs: STAGE_TIMEOUT_MS,
                        prompt: '使用 Harness 文件读取工具或 shell 读取工作目录文件 ' + samplePath
                            + ' 的最后一个非空行，把其中的小写字母改成大写，保持数字和顺序不变，按给定 JSON 格式返回 value。不得改写该文件。',
                    });
                    active.throwIfAborted();
                    validateAuditValue(schema, result);
                    const { value } = auditObject(result);
                    if (value !== sample.toUpperCase()) throw new Error('子代理返回的样本值与预期不符');
                    values.set(runner, value as string);
                    steps.push(runner);
                    progress(runner, runner + ' 已返回正确结果');
                    return result;
                });
            },
            async publish(input, requestSignal) {
                const active = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
                active.throwIfAborted();
                publicationAttempted = true;
                if (values.size !== AUDIT_EXECUTORS.length || publicationStarted) throw new Error('必须先取得两个子代理的结果，而且只能发布一次');
                const publication = auditObject(input);
                const summary = AUDIT_EXECUTORS.map(runner => runner + '=' + values.get(runner));
                const coverage = publication['coverage'];
                if (Object.keys(publication).length !== publishFields.length || publishFields.some(key => !Array.isArray(publication[key]))
                    || !Array.isArray(coverage) || coverage.length !== summary.length || summary.some((line, i) => coverage[i] !== line)
                    || ['findings', 'requirements', 'history'].some(key => (publication[key] as unknown[]).length !== 0)) {
                    throw new Error('模拟报告汇总与两个子代理的实际结果不符');
                }
                publicationStarted = true;
                const createdAt = new Date().toISOString();
                const auditId = createdAt.slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-') + '-node-test';
                const reportPath = '.ai-review/audits/' + auditId + '/audit.md';
                await track('publish', '正在写出模拟审查记录', async () => {
                    await publishStageArtifacts(directory, reportPath, serializeAuditMarkdown({
                        schemaVersion: 2, auditId, createdAt, baseRevision: 'node-self-test', scope: '.',
                        trigger: 'manual', previousAudit: null, candidates: [], items: [],
                    }, '# 节点自检模拟记录\n\n' + summary.map(line => '- ' + line).join('\n')), [], async () => {
                        active.throwIfAborted();
                    });
                    steps.push('publish');
                });
                await track('validate', '正在读回并校验模拟审查记录', async () => {
                    active.throwIfAborted();
                    const file = path.join(directory, reportPath);
                    const errors = validateReviewData(file, await readFile(file));
                    if (errors.length) throw new Error(errors.join('；'));
                    steps.push('validate');
                    progress('validate', '模拟审查记录格式校验通过');
                });
                return { reportPath, overview: [] };
            },
        };
        const prompt = [
            '这是节点自检。请只调用下面列出的插件工具，不读取项目文件，不执行审查或修改项目。',
            '分别用 codex 和 claude-code 调用 runAuditStage，stage 都填 scan，task 都填 ' + JSON.stringify(stageTask) + '。',
            '拿到两个结果的 value 后调用 publishAuditArtifacts，publication 填 JSON 对象：',
            '{"findings":[],"coverage":["codex=第一个value","claude-code=第二个value"],"requirements":[],"history":[]}',
            '把 coverage 中的占位文字替换为实际返回值。DSH 工具的 task 和 publication 要传 JSON 字符串，本机 HTTP 入口要传 JSON 对象。',
            '发布后简要汇总。如有步骤失败，结束本轮并说明失败步骤。',
        ].join('\n');

        if (deps.createAuditSession) {
            if (deps.auditSessionTools === false || !deps.withAuditSessionIdle) throw new Error('节点缺少 DSH 阶段工具或会话完成检测');
            const requestId = 'dsh-audit-test-' + randomUUID();
            const created = await deps.createAuditSession({
                cwd, title: '审查流程自检', prompt, requestId, cwdOnly: true, signal,
                onCreated: async id => {
                    signal.throwIfAborted();
                    sessionId = id;
                    sessions.set(id, tools);
                },
            });
            if (created.sessionId !== sessionId) throw new Error('自检会话未绑定插件工具');
            if (!await deps.withAuditSessionIdle(created.sessionId, requestId, signal, async () => {})) {
                throw new Error('无法确认自检主代理已结束');
            }
        } else {
            if (settings.runner === 'manual') throw new Error('节点未配置可自动运行的主代理');
            channel = await openAuditStageChannel(async (input, active) => {
                if (input['operation'] === 'runAuditStage') return tools.run(input['stage'] as AuditStage, input['runner'] as AuditExecutor, input['task'], active);
                if (input['operation'] === 'publishAuditArtifacts') return tools.publish(input['publication'], active);
                throw new Error('自检不支持此工具');
            });
            const result = await runAgent({
                kind: settings.runner, settings, cwd, prompt: wrapAgentPrompt('', prompt + '\n\n' + channel.instructions),
                timeoutMs: TIMEOUT_MS, signal, label: '审查流程自检', resolveCredential: deps.resolveCredential,
                log: () => {},
            });
            if (!result.ok) {
                const hint = auditCliDiagnostic(result.outputTail);
                throw new Error((result.errorMessage ?? '自检主代理执行失败') + (hint ? '。' + hint : ''));
            }
        }
        signal.throwIfAborted();
        const missing = AUDIT_EXECUTORS.filter(runner => !invoked.has(runner));
        if (missing.length) throw new Error('主代理未调用阶段工具启动 ' + missing.join('、'));
        if (!steps.includes('validate')) {
            failure = { step: publicationAttempted ? 'publish' : 'coordinator',
                message: publicationAttempted ? '主代理调用发布工具后未完成记录校验' : '主代理未调用发布工具' };
            throw new Error(failure.message);
        }
        steps.push('coordinator');
        outcome = { status: 'SUCCEEDED', steps };
    } catch (error) {
        outcome = {
            status: 'ABORTED', steps, reason: commandSignal.aborted ? 'CANCELLED' : 'SELF_TEST_FAILED',
            step: failure?.step ?? running.values().next().value ?? 'coordinator',
            message: commandSignal.aborted ? '自检已取消'
                : timeout.aborted ? '自检超过 ' + TIMEOUT_MS / 60_000 + ' 分钟'
                : failure?.message ?? (error instanceof Error ? error.message : String(error)),
        };
    } finally {
        abort.abort();
        channel?.close();
        if (sessionId) sessions.delete(sessionId);
        await Promise.allSettled(pending);
    }
    if (scratch) {
        try {
            await rm(scratch, { recursive: true, force: true });
        } catch {
            if (outcome.status === 'SUCCEEDED') {
                outcome = { status: 'ABORTED', reason: 'SELF_TEST_FAILED', step: 'cleanup', message: '无法清理自检临时目录', steps };
            }
        }
    }
    if (outcome.status === 'ABORTED') progress(outcome.step, outcome.message);
    return outcome;
}
