import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture, runCommand } from './helpers.mjs';
import { reviewFixture, patchFixture } from './fixtures/contract.mjs';
import { registerAuditStageTools } from '../packages/dsh-plugin/dist/host/audit-stage-tools.js';
import { AuditExecutorAuthenticationError, AuditStageTimedOut, AuditStopUnknown } from '../packages/dsh-plugin/dist/host/audit-stage-runner.js';
import { runProcess } from '../packages/dsh-plugin/dist/host/shell.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedDelivery } from '../packages/dsh-plugin/dist/managed/managed-delivery.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { bindProject, setupCentral } from './central-helpers.mjs';

async function fixture(t, auditSessions) {
    const root = await createGitFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), 'central-operations-'));
    const remote = path.join(state, 'remote.git');
    runCommand('git', ['init', '--bare', '-q', remote], root);
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const directory = path.join(root, '.ai-review/2026-11/fix-retry');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'review.md'), reviewFixture('fix-retry', { baseRevision: JSON.stringify(base), bodyLines: ['修正加法计算。', '', '# 需人工判断项', '', '无。'] }));
    await writeFile(path.join(directory, '001.patch'), patchFixture());
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'candidate'], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    runCommand('git', ['push', '-qu', 'origin', target], root);
    runCommand('git', ['config', 'user.name', 'review-node'], root);
    runCommand('git', ['config', 'user.email', 'review-node@example.com'], root);
    const journal = new ManagedJournal(path.join(state, 'journal.sqlite'));
    t.after(async () => { journal.close(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
    const { ManagedOperations } = await import('../packages/dsh-plugin/dist/managed/managed-operations.js');
    const operations = new ManagedOperations({ dataDir: state, journal, auditSessions, workspaces: [{ workspaceId: 'workspace-a', label: '项目 A', root, target, settings: { runner: 'manual', syncBeforeApprove: false } }] });
    await operations.init();
    t.after(() => operations.stop());
    const project = { projectId: 'project-a', name: '项目 A', nodeId: 'node-a', workspaceId: 'workspace-a', bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true };
    return { operations, project, journal, root, remote, target };
}

test('托管真实候选评论由登录身份提交并交付，旧 guard 拒绝且不重做', async t => {
    const { operations, project, journal, root, remote, target } = await fixture(t);
    const snapshot = await operations.snapshot(project);
    assert.equal(snapshot.queue.length, 1);
    const detail = await operations.read({ queryId: 'detail-a', projectId: project.projectId, bindingGeneration: 1,
        vcsSnapshot: snapshot.vcsSnapshot, kind: 'candidate', params: { id: snapshot.queue[0].id } }, project);
    const meta = detail.data.candidate.meta;
    const command = { commandId: 'comment-a', requestHash: 'a'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'comments', actor: { userId: 'user-a', reviewIdentity: 'tester' },
        payload: { id: snapshot.queue[0].id, content: '补充边界验证', revision: 1 }, guard: { expectedRevision: meta.currentRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt }, createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'COMMITTED');
    assert.equal(result.delivery.state, 'delivered');
    const commit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), commit);
    assert.match(runCommand('git', ['log', '-1', '--format=%B'], root).stdout, /Dsh-Command: comment-a/);
    const recover = await operations.recover(command, result, project);
    assert.equal(recover.outcome.status, 'COMMITTED');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), commit);
    const stale = { ...command, commandId: 'comment-b' };
    journal.accept(stale);
    const rejected = await operations.execute(stale, new AbortController().signal, () => {}, project);
    assert.equal(rejected.outcome.status, 'ABORTED');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), commit);
});

test('托管详情绑定版本，仓库推进后返回 snapshot_moved', async t => {
    const { operations, project, root } = await fixture(t);
    const snapshot = await operations.snapshot(project);
    const query = { queryId: 'query-a', projectId: project.projectId, bindingGeneration: 1, vcsSnapshot: snapshot.vcsSnapshot,
        kind: 'candidate', params: { id: '2026-11/fix-retry' } };
    const detail = await operations.read(query, project);
    assert.equal(detail.status, 'ready');
    assert.equal(detail.data.candidate.meta.owner, 'tester');
    await writeFile(path.join(root, 'other.txt'), 'new');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'advance'], root);
    assert.equal((await operations.read(query, project)).status, 'snapshot_moved');
});

test('仅有指令提交标记不能推断批准成功，原业务结果丢失时继续要求核验', async t => {
    const { operations, project, journal, root } = await fixture(t);
    runCommand('git', ['commit', '--allow-empty', '-qm', 'AI fallback version\n\nDsh-Command: fallback-a'], root);
    const command = { commandId: 'fallback-a', requestHash: 'b'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'approve', actor: { userId: 'user-a', reviewIdentity: 'tester' },
        payload: { id: '2026-11/fix-retry' }, guard: { expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T02:00:00Z' }, createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.recover(command, undefined, project);
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.delivery.state, 'delivered');
});

function auditCommand(project) {
    return {
        commandId: 'audit-desktop', requestHash: 'b'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit',
        actor: { userId: 'user-a', reviewIdentity: 'tester' }, payload: { issueWorkflow: true, findingWorkflow: true, targetPath: '.', note: '复核绑定项目' },
        createdAt: new Date().toISOString(),
    };
}

test('桌面托管手动审查使用绑定工作副本的 DSH 会话并自动收尾交付', async t => {
    const completedTurn = Promise.withResolvers();
    const calls = [];
    const auditSessions = {
        async createAuditSession(input) {
            calls.push(input);
            await input.onCreated('desktop-audit');
            return { sessionId: 'desktop-audit' };
        },
        async withAuditSessionIdle(sessionId, requestId, signal, finalize) {
            assert.equal(sessionId, 'desktop-audit');
            assert.equal(requestId, calls[0].requestId);
            await completedTurn.promise;
            await finalize(signal);
            return true;
        },
    };
    const { operations, project, journal, root, remote, target } = await fixture(t, auditSessions);
    const command = auditCommand(project);
    journal.accept(command);
    const started = Promise.withResolvers();
    const logs = [];
    const running = operations.execute(command, new AbortController().signal, line => {
        logs.push(line);
        started.resolve();
    }, project);
    await started.promise;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requireWorkspace, true);
    assert.equal(calls[0].cwd, await realpath(root));
    assert.match(calls[0].prompt, /复核绑定项目/);
    assert.equal(journal.recoveryData(command.commandId).sessionId, 'desktop-audit');
    completedTurn.resolve();
    const result = await running;
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(result.outcome.sessionId, 'desktop-audit');
    assert.equal(result.delivery.state, 'delivered');
    assert.match(logs[0], /desktop-audit/);
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), result.delivery.commitRevision);
    assert.match(runCommand('git', ['log', '-1', '--format=%B'], root).stdout, /Dsh-Command: audit-desktop/);
});

test('中央桌面节点使用绑定会话访问共享阶段工具', async t => {
    const created = Promise.withResolvers();
    const completed = Promise.withResolvers();
    const sessionId = 'desktop-phased';
    const capabilities = {
        auditStageExecutor: async ({ prompt, onProcessTreeStopped }) => {
            onProcessTreeStopped?.(true);
            assert.doesNotMatch(prompt, /固定基线只读视图/);
            assert.match(prompt, /Harness.*自主读取/);
            return { leads: [], coverage: ['确认走共享阶段'], limits: [] };
        },
        async createAuditSession(input) {
            assert.match(input.prompt, /仓库审查总调度/);
            await input.onCreated(sessionId);
            created.resolve();
            return { sessionId };
        },
        async withAuditSessionIdle(_sessionId, _requestId, signal, finalize) {
            await completed.promise;
            return (await finalize(signal)) !== false;
        },
    };
    const { operations, project, journal, root } = await fixture(t, capabilities);
    const command = auditCommand(project);
    journal.accept(command);
    const running = operations.execute(command, new AbortController().signal, () => {}, project);
    await created.promise;
    const tools = new Map();
    t.after(registerAuditStageTools({ register: item => { tools.set(item.name, item); return () => tools.delete(item.name); } },
        id => operations.auditStageApi(id)));
    const invoke = (name, args, id = sessionId) => tools.get(name).execute(args, {
        agent: { session: { id } }, signal: new AbortController().signal,
    });
    const scan = { stage: 'scan', runner: 'codex', task: JSON.stringify({ taskScope: ['src'], scenarios: [], questions: [], constraints: [] }) };
    await assert.rejects(invoke('runAuditStage', scan, 'other-session'), /有效租约/);
    await invoke('runAuditStage', scan);
    await invoke('publishAuditArtifacts', { publication: JSON.stringify({ findings: [], coverage: [], requirements: [], history: [] }) });
    completed.resolve();
    const result = await running;
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(result.outcome.sessionId, sessionId);
    assert.equal(result.delivery.state, 'delivered');
    assert.match(runCommand('git', ['show', 'HEAD:' + result.outcome.reportPath], root).stdout, /确认走共享阶段/);
});

test('桌面审查会话结束且两个执行器均初审失败时回报待核验', { timeout: 30_000 }, async t => {
    const sessionId = 'desktop-scan-failed';
    const idle = Promise.withResolvers();
    const firstScanFinished = Promise.withResolvers();
    const firstIdleResult = Promise.withResolvers();
    const bothScansFinished = Promise.withResolvers();
    const finalIdleResult = Promise.withResolvers();
    const signal = new AbortController().signal;
    const { operations, project, journal, root, remote, target } = await fixture(t, {
        auditStageExecutor: async ({ executor, onProcessTreeStopped }) => {
            onProcessTreeStopped?.(true);
            if (executor === 'codex') throw new Error('codex 无法启动');
            throw new AuditExecutorAuthenticationError(executor, 1);
        },
        async createAuditSession(input) {
            await input.onCreated(sessionId);
            return { sessionId };
        },
        async withAuditSessionIdle(_id, _requestId, watchingSignal, finalize) {
            idle.resolve();
            await firstScanFinished.promise;
            firstIdleResult.resolve(await finalize(watchingSignal));
            await bothScansFinished.promise;
            const result = await finalize(watchingSignal);
            finalIdleResult.resolve(result);
            return result !== false;
        },
    });
    const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const logs = [];
    const command = auditCommand(project);
    journal.accept(command);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const running = operations.execute(command, controller.signal, line => logs.push(line), project);
    await idle.promise;
    const stageApi = operations.auditStageApi(sessionId);
    assert.ok(stageApi);
    const scan = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
    await assert.rejects(stageApi.runAuditStage(sessionId, 'scan', 'codex', scan, signal), /无法启动/);
    firstScanFinished.resolve();
    assert.equal(await firstIdleResult.promise, false);
    await assert.rejects(stageApi.runAuditStage(sessionId, 'scan', 'claude-code', scan, signal), /认证失败/);
    bothScansFinished.resolve();
    assert.notEqual(await finalIdleResult.promise, false, '两个执行器均失败后会话应结束跟踪');
    const result = await running;
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.outcome.sessionId, sessionId);
    assert.match(result.outcome.detail, /Codex 和 Claude Code 均未完成初审/);
    assert.equal(result.delivery.state, 'unknown');
    assert.ok(logs.some(line => line.includes('均未完成初审')));
    assert.equal(stageApi.leaseLookup(result.outcome.auditId).state, 'releasable');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), head);
});

for (const processTreeStopped of [true, false]) {
    test(`桌面审查超时先收到日志回执再停止主会话（进程树已确认=${processTreeStopped}）`, { timeout: 30_000 }, async t => {
        const sessionId = 'desktop-timeout-order';
        const watching = Promise.withResolvers();
        const reporting = Promise.withResolvers();
        const logReceipt = Promise.withResolvers();
        const stopping = Promise.withResolvers();
        const sessionStopped = Promise.withResolvers();
        const executorStopped = Promise.withResolvers();
        let stopRequested = false;
        const setup = await fixture(t, {
            auditStageExecutor: async ({ onTimeout }) => {
                onTimeout();
                return executorStopped.promise;
            },
            async createAuditSession(input) {
                await input.onCreated(sessionId);
                return { sessionId };
            },
            withAuditSessionIdle(_sessionId, _requestId, signal) {
                watching.resolve();
                return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
            },
            async stopAuditSession(id) {
                assert.equal(id, sessionId);
                stopRequested = true;
                stopping.resolve();
                return sessionStopped.promise;
            },
        });
        const { operations, project, journal } = setup;
        const command = auditCommand(project);
        journal.accept(command);
        const controller = new AbortController();
        t.after(() => controller.abort());
        let finished = false;
        const messages = [];
        const running = operations.execute(command, controller.signal, line => messages.push(line), project, async line => {
            assert.match(line, /codex.*超时/);
            reporting.resolve();
            await logReceipt.promise;
        }).then(result => { finished = true; return result; });
        await watching.promise;
        const api = operations.auditStageApi(sessionId);
        const scan = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
        const stageResult = assert.rejects(api.runAuditStage(sessionId, 'scan', 'codex', scan, controller.signal), /执行器超时/);
        await reporting.promise;
        assert.equal(finished, false);
        assert.equal(stopRequested, false);
        logReceipt.resolve();
        await stopping.promise;
        assert.equal(finished, false);
        sessionStopped.resolve(true);
        assert.equal(finished, false);
        executorStopped.reject(new AuditStageTimedOut('codex', processTreeStopped));
        await stageResult;
        if (processTreeStopped) {
            const result = await running;
            assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
            assert.equal(result.outcome.sessionId, sessionId);
        } else {
            while (!messages.some(line => line.includes('仍无法确认执行器进程树已经停止'))) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(finished, false);
            assert.equal(api.auditLifecycle.blockingLeaseFor(await realpath(setup.root)).state, 'active');
            await operations.stop();
            await running;
        }
    });
}

test('本机中央先收到真实子进程的超时日志，再等待主会话停止后结算', { timeout: 30_000 }, async t => {
    const sessionId = 'desktop-timeout-central';
    const watching = Promise.withResolvers();
    const deadline = Promise.withResolvers();
    const delivered = Promise.withResolvers();
    const ack = Promise.withResolvers();
    const cancelling = Promise.withResolvers();
    const sessionStopped = Promise.withResolvers();
    let cancellationRequested = false;
    const { operations, project, journal } = await fixture(t, {
        async auditStageExecutor({ executor, location, onTimeout, signal }) {
            const execution = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                cwd: location, timeoutMs: 1200, signal, killTreeOnExit: true,
                onTimeout() { onTimeout(); deadline.resolve(); },
            });
            assert.equal(execution.timedOut, true);
            assert.equal(execution.processTreeStopped, true);
            throw new AuditStageTimedOut(executor, execution.processTreeStopped);
        },
        async createAuditSession(input) {
            await input.onCreated(sessionId);
            return { sessionId };
        },
        withAuditSessionIdle(_sessionId, _requestId, signal) {
            watching.resolve();
            return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
        },
        async stopAuditSession(id) {
            assert.equal(id, sessionId);
            cancellationRequested = true;
            cancelling.resolve();
            return sessionStopped.promise;
        },
    });
    const { app, headers } = await setupCentral(t);
    const credential = app.database.createNode('本机超时回执节点');
    const node = new ManagedNode({
        workspaceIssues: () => operations.workspaceIssues(),
        config: { centerUrl: 'http://127.0.0.1:3081', ...credential, workspaces: operations.registrations() },
        journal, execute: (...args) => operations.execute(...args),
        read: () => { throw new Error('未预期的查询'); },
        fetch: async (url, options) => {
            const pathname = new URL(url).pathname;
            const response = await app.inject({ method: options.method, url: pathname, headers: options.headers, payload: options.body });
            if (pathname.endsWith('/events') && JSON.parse(options.body).events.some(event => event.logs?.some(line => /正在停止 DSH 主审查/.test(line)))) {
                delivered.resolve();
                await ack.promise;
            }
            return new Response(response.body, { status: response.statusCode, headers: response.headers });
        },
    });
    t.after(() => { ack.resolve(); sessionStopped.resolve(true); });
    await node.tick();
    const binding = await bindProject(app, headers, { ...credential, workspaceId: project.workspaceId });
    const started = await app.inject({ method: 'POST', url: '/api/v1/projects/' + binding.projectId + '/commands', headers,
        payload: { operation: 'audit', idempotencyKey: 'real-timeout-order', payload: { targetPath: '.' } } });
    assert.equal(started.statusCode, 202, started.body);
    const id = started.json().command.commandId;
    const centralTask = async () => (await app.inject({ url: '/api/v1/commands/' + id, headers })).json().command;
    await node.tick();
    await watching.promise;
    const api = operations.auditStageApi(sessionId);
    const scan = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
    const phase = assert.rejects(api.runAuditStage(sessionId, 'scan', 'codex', scan, new AbortController().signal), /执行器超时/);
    await deadline.promise;
    const flush = node.tick();
    await delivered.promise;
    const lines = (await app.inject({ url: '/api/v1/tasks/' + id + '/logs', headers })).json().log;
    assert.ok(lines.some(line => /codex 执行器超时/.test(line)));
    assert.equal((await centralTask()).state, 'executing');
    assert.equal(cancellationRequested, false);
    app.database.disconnectNode(credential.nodeId, node.instanceId);
    assert.equal((await centralTask()).state, 'executing');
    ack.resolve();
    await flush;
    await cancelling.promise;
    await phase;
    assert.equal((await centralTask()).state, 'executing');
    sessionStopped.resolve(true);
    await node.drain();
    await node.tick();
    assert.equal((await centralTask()).state, 'recovery_required');
});

for (const timing of ['已注册 Job', '尚未注册 Job', '租约保存失败', '整轮时限与阶段重合']) {
    test(`桌面审查阶段超时及时回报待核验（${timing}）`, { timeout: 30_000 }, async t => {
        const watching = Promise.withResolvers();
        const sessionId = 'desktop-stage-timeout';
        const signal = new AbortController().signal;
        const scan = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
        const executorStarted = Promise.withResolvers();
        const executorResult = Promise.withResolvers();
        let operations, stageApi, expire, phaseFailure;
        const stopRequested = Promise.withResolvers();
        if (timing === '整轮时限与阶段重合') {
            const schedule = globalThis.setTimeout;
            t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
                if (delay <= 10_000_000) return schedule(callback, delay, ...args);
                expire = () => callback(...args);
                return schedule(() => {}, delay);
            });
        }
        const runStage = async () => {
            stageApi = operations.auditStageApi(sessionId);
            assert.ok(stageApi);
            await stageApi.runAuditStage(sessionId, 'scan', 'codex', scan, signal);
            if (timing === '租约保存失败') {
                t.mock.method(stageApi.auditLifecycle, 'markReleasable', async () => { throw new Error('无法保存'); });
            }
            phaseFailure = assert.rejects(stageApi.runAuditStage(sessionId, 'scan', 'claude-code', scan, signal), /执行器超时/);
            await executorStarted.promise;
            if (timing === '整轮时限与阶段重合') {
                assert.equal(typeof expire, 'function');
                expire();
                return;
            }
            executorResult.reject(new AuditStopUnknown('claude-code 执行器超时，需确认子进程已经停止'));
            if (timing === '已注册 Job') {
                await assert.rejects(stageApi.runAuditStage(sessionId, 'verify', 'codex', {}, signal));
            }
            await phaseFailure;
        };
        const setup = await fixture(t, {
            auditStageExecutor: async ({ executor, location, onProcessTreeStopped }) => {
                if (executor !== 'claude-code') onProcessTreeStopped?.(true);
                if (executor === 'claude-code') {
                    t.after(() => rm(location, { recursive: true, force: true }));
                    executorStarted.resolve();
                    return executorResult.promise;
                }
                return { leads: [], coverage: [], limits: [] };
            },
            async createAuditSession(input) {
                await input.onCreated(sessionId);
                if (timing === '尚未注册 Job') await runStage();
                return { sessionId };
            },
            async stopAuditSession() { stopRequested.resolve(); return true; },
            withAuditSessionIdle(_id, _requestId, watchingSignal) {
                watching.resolve();
                return new Promise(resolve => watchingSignal.addEventListener('abort', () => resolve(false), { once: true }));
            },
        });
        ({ operations } = setup);
        const { project, journal, root, remote, target } = setup;
        const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
        const findCommit = t.mock.method(ManagedDelivery.prototype, 'findCommandCommit', async () => { throw new Error('阶段恢复回报不应等待提交查询'); });
        const withinBudget = pending => Promise.race([pending, new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('会话未结束时中央未收到恢复结果')), 6000);
            timer.unref();
        })]);
        let result;
        if (timing === '已注册 Job') {
            const { app, headers } = await setupCentral(t);
            const credential = app.database.createNode('超时恢复节点');
            let dropReceipt = true;
            const node = new ManagedNode({
                workspaceIssues: () => operations.workspaceIssues(),
                config: { centerUrl: 'http://127.0.0.1:3081', ...credential, workspaces: operations.registrations() },
                journal, execute: (...args) => operations.execute(...args),
                read: () => { throw new Error('未预期的查询'); },
                fetch: async (url, options) => {
                    const pathname = new URL(url).pathname;
                    const response = await app.inject({ method: options.method, url: pathname, headers: options.headers, payload: options.body });
                    if (dropReceipt && response.statusCode === 200 && pathname.endsWith('/events')
                        && JSON.parse(options.body).events.some(event => event.result?.outcome.status === 'RECOVERY_REQUIRED')) {
                        dropReceipt = false;
                        throw new Error('模拟中央回执丢失');
                    }
                    return new Response(response.body, { status: response.statusCode, headers: response.headers });
                },
            });
            await node.tick();
            const binding = await bindProject(app, headers, { ...credential, workspaceId: project.workspaceId });
            const start = await app.inject({ method: 'POST', url: '/api/v1/projects/' + binding.projectId + '/commands', headers,
                payload: { operation: 'audit', idempotencyKey: 'review-stage-timeout', payload: { targetPath: '.' } } });
            assert.equal(start.statusCode, 202, start.body);
            const id = start.json().command.commandId;
            await node.tick();
            await withinBudget(watching.promise);
            await runStage();
            await withinBudget(node.drain());
            await assert.rejects(node.tick(), /中央回执丢失/);
            const readCommand = async () => (await app.inject({ url: '/api/v1/commands/' + id, headers })).json().command;
            const interrupted = await readCommand();
            assert.equal(interrupted.state, 'recovery_required');
            assert.equal(journal.pending().filter(event => event.result).length, 1);
            await node.tick();
            assert.deepEqual((await readCommand()).result, interrupted.result);
            assert.deepEqual(journal.pending(), []);
            result = interrupted.result;
        } else {
            const command = auditCommand(project);
            journal.accept(command);
            let settled = false;
            const running = operations.execute(command, signal, () => {}, project).then(value => { settled = true; return value; });
            if (timing !== '尚未注册 Job') {
                await withinBudget(watching.promise);
                await runStage();
            }
            if (timing === '整轮时限与阶段重合') {
                try {
                    await withinBudget(stopRequested.promise);
                    assert.equal(settled, false);
                    assert.equal(stageApi.auditLifecycle.blockingLeaseFor(await realpath(root)).state, 'active');
                } finally {
                    executorResult.reject(new AuditStageTimedOut('claude-code', true));
                    await phaseFailure;
                }
            }
            result = await withinBudget(running);
        }
        const auditId = result.outcome.auditId;
        assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
        assert.equal(result.outcome.reason, 'SYNC_STATE_UNKNOWN');
        assert.equal(result.outcome.sessionId, sessionId);
        assert.deepEqual(result.outcome.stageFailure, { stage: 'scan', runner: 'claude-code' });
        const detail = timing === '整轮时限与阶段重合' ? /审查达到总时限/ : /执行器超时/;
        assert.match(result.outcome.detail, detail);
        if (timing === '租约保存失败') assert.match(result.outcome.detail, /租约.*保存失败/);
        assert.equal(result.delivery.state, 'unknown');
        assert.equal(stageApi.auditLifecycle.blockingLeaseFor(await realpath(root))?.auditId, auditId);
        assert.equal(stageApi.leaseLookup(auditId).state, timing === '租约保存失败' ? 'active' : 'releasable');
        await assert.rejects(stageApi.runAuditStage(sessionId, 'scan', 'codex', scan, signal));
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
        assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), head);
    });
}

test('桌面审查取消跟踪保留会话和未决记录，恢复不重新创建会话', async t => {
    const watching = Promise.withResolvers();
    let created = 0;
    const { operations, project, journal, root } = await fixture(t, {
        async createAuditSession(input) {
            created++;
            await input.onCreated('desktop-audit-cancelled');
            return { sessionId: 'desktop-audit-cancelled' };
        },
        withAuditSessionIdle(_sessionId, _requestId, signal) {
            watching.resolve();
            return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
        },
    });
    const command = auditCommand(project);
    journal.accept(command);
    const abort = new AbortController();
    const running = operations.execute(command, abort.signal, () => {}, project);
    await watching.promise;
    abort.abort();
    const result = await running;
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.outcome.sessionId, 'desktop-audit-cancelled');
    assert.equal(result.delivery.state, 'unknown');
    const draft = path.join(root, '.ai-review', 'unfinished.md');
    await writeFile(draft, '# 草稿');
    const blocked = await operations.recover(command, result, project);
    assert.equal(blocked.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(blocked.outcome.sessionId, 'desktop-audit-cancelled');
    assert.match(blocked.outcome.detail, /\.ai-review\/unfinished\.md/);
    await rm(draft);
    const recovered = await operations.recover(command, blocked, project);
    assert.equal(recovered.outcome.status, 'ABORTED');
    assert.equal(recovered.outcome.sessionId, 'desktop-audit-cancelled');
    assert.equal(recovered.delivery.state, 'not_required');
    assert.deepEqual(await operations.recover(command, recovered, project), recovered);
    assert.equal(created, 1);
});

test('后台托管节点仍通过进程审查入口处理手动指令', async t => {
    const { operations, project, journal } = await fixture(t);
    const command = auditCommand(project);
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'MANUAL_REQUIRED');
    assert.equal(result.outcome.sessionId, undefined);
});
