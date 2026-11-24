import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAuditSelfTest } from '../packages/dsh-plugin/dist/host/audit-self-test.js';
import { registerAuditStageTools } from '../packages/dsh-plugin/dist/host/audit-stage-tools.js';
import { parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { bindProject, registerNode, setupCentral } from './central-helpers.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

const stage = { stage: 'scan', task: JSON.stringify({ taskScope: [], scenarios: [], questions: [], constraints: [] }) };

test('自检到达五分钟预算时返回超时', async t => {
    t.mock.method(AbortSignal, 'timeout', delay => {
        assert.equal(delay, 5 * 60_000);
        return AbortSignal.abort();
    });
    const result = await runAuditSelfTest({
        deps: {}, settings: {}, signal: new AbortController().signal, progress() {}, sessions: new Map(),
    });
    assert.equal(result.status, 'ABORTED');
    assert.equal(result.step, 'coordinator');
    assert.equal(result.message, '自检超过 5 分钟');
});

test('中央 /test 受登录和 CSRF 保护，拒绝旧节点和自带参数', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const payload = { projectId: project.projectId, idempotencyKey: 'check' };
    const request = { method: 'POST', url: '/test', payload };
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode, 403);
    assert.equal((await app.inject({ ...request, headers })).statusCode, 409);
    assert.equal((await app.inject({ ...request, headers, payload: { ...payload, prompt: 'override' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/projects/' + project.projectId + '/commands',
        headers, payload: { operation: 'test', idempotencyKey: 'generic', payload: {} } })).statusCode, 422);
});

test('中央自检通过 DSH 阶段工具调用两种代理，校验后删除临时记录', { timeout: 60_000 }, async t => {
    const { app, headers } = await setupCentral(t);
    const registration = await registerNode(app);
    const root = await createGitFixture();
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'node-self-test-journal-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const tools = new Map();
    const calls = [];
    let checkDir, mode = 'success', sessionSequence = 0, finish;
    const operations = new ManagedOperations({
        dataDir: directory, journal,
        workspaces: [{ workspaceId: registration.workspaceId, label: '示例项目', root, target }],
        auditSessions: {
            auditSessionTools: true,
            async auditStageExecutor({ executor, location, prompt, timeoutMs, signal }) {
                assert.equal(path.dirname(location), path.dirname(checkDir));
                assert.ok(timeoutMs <= 40_000);
                signal.throwIfAborted();
                calls.push(executor);
                if (mode === 'bad-claude' && executor === 'claude-code') return { value: 'INCORRECT' };
                return { value: /样本：(test-[a-f0-9]+)$/.exec(prompt)[1].toUpperCase() };
            },
            async createAuditSession(input) {
                const id = 'self-test-' + (++sessionSequence);
                checkDir = input.cwd;
                assert.equal(input.cwdOnly, true);
                assert.notEqual(checkDir, root);
                assert.match(input.prompt, /runAuditStage/);
                await input.onCreated(id);
                const execute = (name, args) => tools.get(name).execute(args, {
                    agent: { session: { id } }, signal: input.signal,
                }).then(output => JSON.parse(output.json));
                finish = async () => {
                    if (mode === 'no-tools') return;
                    const codex = await execute('runAuditStage', { ...stage, runner: 'codex' });
                    const claude = await execute('runAuditStage', { ...stage, runner: 'claude-code' });
                    const publication = JSON.stringify({
                        findings: [], requirements: [], history: [],
                        coverage: ['codex=' + codex.value, 'claude-code=' + claude.value],
                    });
                    const [first, duplicate] = await Promise.allSettled([
                        execute('publishAuditArtifacts', { publication }),
                        execute('publishAuditArtifacts', { publication }),
                    ]);
                    assert.equal(duplicate.status, 'rejected');
                    assert.equal(first.status, 'fulfilled');
                    const report = parseAuditMarkdown(await readFile(path.join(path.dirname(checkDir), first.value.reportPath), 'utf8'));
                    assert.match(report.body, /codex=TEST-[0-9A-F]+/);
                    assert.match(report.body, /claude-code=TEST-[0-9A-F]+/);
                    assert.deepEqual(report.meta.items, []);
                };
                return { sessionId: id };
            },
            async withAuditSessionIdle(_id, _request, signal, completed) {
                await finish();
                await completed(signal);
                return true;
            },
        },
    });
    const unregister = registerAuditStageTools({
        register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    }, id => operations.auditStageApi(id));
    await operations.init();
    const node = new ManagedNode({
        config: { centerUrl: 'http://127.0.0.1:3081', nodeId: registration.nodeId, instanceId: registration.instanceId,
            token: registration.token, workspaces: operations.registrations() },
        journal, execute: (...args) => operations.execute(...args), workspaceIssues: () => [],
        read: () => { throw new Error('未预期的查询'); },
        fetch: async (url, options = {}) => {
            const response = await app.inject({ method: options.method ?? 'GET', url: new URL(url).pathname,
                headers: options.headers, ...(options.body ? { payload: options.body } : {}) });
            return new Response(response.body, { status: response.statusCode, headers: response.headers });
        },
    });
    t.after(async () => {
        await node.stop();
        unregister();
        await operations.stop();
        journal.close();
        await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    await node.tick();
    const project = await bindProject(app, headers, registration);
    const submit = key => app.inject({ method: 'POST', url: '/test', headers, payload: { projectId: project.projectId, idempotencyKey: key } });
    const run = async key => {
        const start = await submit(key);
        assert.equal(start.statusCode, 202, start.body);
        const id = start.json().command.commandId;
        assert.equal((await submit(key)).json().command.commandId, id);
        await node.tick();
        await node.drain();
        await node.tick();
        const status = await app.inject({ url: '/api/v1/commands/' + id, headers });
        const command = status.json().command;
        assert.equal(command.state, 'completed', status.body);
        assert.equal(command.result.delivery.state, 'not_required');
        await assert.rejects(stat(checkDir), { code: 'ENOENT' });
        assert.equal(operations.auditStageApi('self-test-' + sessionSequence), undefined);
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
        assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
        return command.result.outcome;
    };
    assert.deepEqual(await run('success'), { status: 'SUCCEEDED', steps: ['codex', 'claude-code', 'publish', 'validate', 'coordinator'] });
    assert.deepEqual(calls, ['codex', 'claude-code']);
    mode = 'bad-claude';
    const error = await run('bad-claude');
    assert.equal(error.status, 'ABORTED');
    assert.equal(error.step, 'claude-code');
    assert.match(error.message, /样本值与预期不符/);
    mode = 'no-tools';
    const skipped = await run('no-tools');
    assert.equal(skipped.status, 'ABORTED');
    assert.equal(skipped.step, 'coordinator');
    assert.match(skipped.message, /未调用/);
    assert.equal(journal.hasUnsettled(), false);

    const queued = (await submit('rolling-downgrade')).json().command;
    journal.accept(queued);
    const downgrade = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: registration.headers, payload: {
        protocolVersion: 1, instanceId: registration.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: registration.workspaceId, label: '示例项目', vcsType: 'git', target, executionConfigHash: operations.registrations()[0].executionConfigHash }],
    } });
    assert.equal(downgrade.statusCode, 200, downgrade.body);
    await node.tick();
    await node.drain();
    assert.equal(journal.get(queued.commandId).phase, 'completed');
    assert.equal(journal.get(queued.commandId).result.outcome.step, 'workspace');
    assert.equal(journal.hasUnsettled(), false);
});
