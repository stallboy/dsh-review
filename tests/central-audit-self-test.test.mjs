import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAuditSelfTest } from '../packages/dsh-plugin/dist/host/audit-self-test.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { bindProject, registerNode, setupCentral } from './central-helpers.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

test('自检到达五分钟预算时返回超时', async t => {
    t.mock.method(AbortSignal, 'timeout', delay => {
        assert.equal(delay, 5 * 60_000);
        return AbortSignal.abort();
    });
    const result = await runAuditSelfTest({
        stageExecutors: ['codex', 'claude'],
        signal: new AbortController().signal,
        log() {},
    });
    assert.equal(result.status, 'ABORTED');
    assert.equal(result.step, 'coordinator');
    assert.equal(result.message, '自检超过 5 分钟');
});

test('中央 /api/v1/test 受登录和 CSRF 保护，拒绝旧节点和自带参数', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app, 'node-no-selftest', 'workspace-a', {});
    const project = await bindProject(app, headers, node);
    const payload = { projectId: project.projectId, idempotencyKey: 'check' };
    const request = { method: 'POST', url: '/api/v1/test', payload };
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: { cookie: headers.cookie } })).statusCode, 403);
    assert.equal((await app.inject({ ...request, headers })).statusCode, 409);
    assert.equal((await app.inject({ ...request, headers, payload: { ...payload, prompt: 'override' } })).statusCode, 422);
    assert.equal((await app.inject({
        method: 'POST',
        url: '/api/v1/projects/' + project.projectId + '/commands',
        headers,
        payload: { operation: 'audit-self-test', idempotencyKey: 'generic', payload: {} },
    })).statusCode, 422);
});

test('中央自检通过 /api/v1/test 验证多执行器降级与本 Harness 子代理五项必验并清理临时目录', { timeout: 60_000 }, async t => {
    const { app, headers } = await setupCentral(t);
    const registration = await registerNode(app, 'node-self', 'workspace-a', { auditSelfTest: true });
    const root = await createGitFixture();
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'node-self-test-journal-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const calls = [];
    let observedTempDir = '';
    let mode = 'all-pass';

    const operations = new ManagedOperations({
        dataDir: directory,
        journal,
        workspaces: [{
            workspaceId: registration.workspaceId,
            label: '示例项目',
            root,
            target,
            settings: { stageExecutors: ['codex', 'claude'] },
        }],
        auditSessions: {
            async auditStageExecutor({ runner, cwd, prompt, signal }) {
                signal.throwIfAborted();
                observedTempDir = cwd;
                assert.notEqual(cwd, root);
                assert.doesNotMatch(prompt, /SELFTEST-TAIL-[a-f0-9]+/);
                calls.push(runner);

                if (mode === 'external-degraded' && runner !== 'dsh-subagent') {
                    return { ok: false, reason: 'unavailable', diagnostic: `${runner} 未登录` };
                }
                if (mode === 'subagent-bad' && runner === 'dsh-subagent') {
                    return { ok: true, output: { tailToken: 'WRONG', writtenPath: '.ai-review/self-test-probe.txt' }, executorUsed: 'dsh-subagent' };
                }
                const sample = await readFile(path.join(cwd, 'large-sample.txt'), 'utf8');
                assert.ok(sample.length > 50_000);
                const tailToken = sample.trim().split('\n').at(-1);
                if (runner === 'dsh-subagent') {
                    await writeFile(path.join(cwd, '.ai-review', 'self-test-probe.txt'), `${tailToken}\n`, 'utf8');
                }
                return {
                    ok: true,
                    output: { tailToken, writtenPath: '.ai-review/self-test-probe.txt' },
                    executorUsed: runner,
                };
            },
        },
    });
    await operations.init();
    const node = new ManagedNode({
        config: {
            centerUrl: 'http://127.0.0.1:3081',
            nodeId: registration.nodeId,
            instanceId: registration.instanceId,
            token: registration.token,
            workspaces: operations.registrations(),
        },
        journal,
        execute: (...args) => operations.execute(...args),
        workspaceIssues: () => [],
        read: () => { throw new Error('未预期的查询'); },
        fetch: async (url, options = {}) => {
            const response = await app.inject({
                method: options.method ?? 'GET',
                url: new URL(url).pathname,
                headers: options.headers,
                ...(options.body ? { payload: options.body } : {}),
            });
            return new Response(response.body, { status: response.statusCode, headers: response.headers });
        },
    });
    t.after(async () => {
        await node.stop();
        await operations.stop();
        journal.close();
        await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    await node.tick();
    const project = await bindProject(app, headers, registration);
    const submit = key => app.inject({ method: 'POST', url: '/api/v1/test', headers, payload: { projectId: project.projectId, idempotencyKey: key } });
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
        await assert.rejects(stat(observedTempDir), { code: 'ENOENT' });
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
        assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
        return command.result.outcome;
    };

    const full = await run('all-pass');
    assert.equal(full.status, 'SUCCEEDED', JSON.stringify(full));
    assert.deepEqual(full.checks, {
        largeFileTailRead: true,
        aiReviewWriteReadback: true,
        forensicRestoreCleanup: true,
        schemaV1PublishReadback: true,
        tempDirCleaned: true,
    });
    assert.deepEqual(calls, ['codex', 'claude', 'dsh-subagent']);

    // 外部执行器全部不可用时，不作为硬阻断：只要 dsh-subagent 五项必验通过仍返回 SUCCEEDED 且如实记录降级
    mode = 'external-degraded';
    const degraded = await run('external-degraded');
    assert.equal(degraded.status, 'SUCCEEDED', JSON.stringify(degraded));
    assert.equal(degraded.executors.find(e => e.name === 'codex').passed, false);
    assert.equal(degraded.executors.find(e => e.name === 'dsh-subagent').passed, true);

    // 本 Harness 子代理未读到未预注入大文件尾部令牌时必须 ABORTED
    mode = 'subagent-bad';
    const failed = await run('subagent-bad');
    assert.equal(failed.status, 'ABORTED', JSON.stringify(failed));
    assert.equal(failed.step, 'largeFileTailRead');
    assert.equal(journal.hasUnsettled(), false);
});
