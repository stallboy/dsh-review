import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConnectionController } from '../packages/dsh-plugin/dist/connection/controller.js';
import { apply } from '../packages/dsh-plugin/dist/host/index.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { startManagedNode } from '../packages/dsh-plugin/dist/managed/managed-config.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { bindProject, setupCentral } from './central-helpers.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

test('AC-PLUGIN-CENTRAL-02 ACK 迟到时停止节点保留 accepted，恢复后才能执行一次', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-stop-ack-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const project = { projectId: 'project-a', nodeId: 'node-a', workspaceId: 'workspace-a', bindingGeneration: 1,
        projectConfigRevision: 1, vcsType: 'git', target: 'main', enabled: true };
    const command = { commandId: 'command-a', requestHash: 'a'.repeat(64), projectId: 'project-a', nodeId: 'node-a',
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: {},
        actor: { userId: 'user-a', reviewIdentity: '审核者' }, createdAt: new Date().toISOString() };
    let releaseAck, enteredAck, executions = 0, delayAck = true;
    const waiting = new Promise(resolve => { enteredAck = resolve; });
    const options = {
        config: { centerUrl: 'http://127.0.0.1:3081/', nodeId: 'node-a', token: 'test-token',
            workspaces: [{ workspaceId: 'workspace-a', label: '项目', vcsType: 'git', target: 'main' }] }, journal,
        execute: async () => { executions++; return { outcome: { status: 'ABORTED', reason: 'CANCELLED' }, delivery: { state: 'not_required' } }; },
        read: async () => { throw new Error('不应读取详情'); },
        fetch: async (url, init) => {
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/commands/poll')) return Response.json({ commands: [command], projects: [project], cancellations: [], queries: [], recoveries: [] });
            if (pathname.endsWith('/ack') && delayAck) {
                enteredAck();
                await new Promise(resolve => { releaseAck = resolve; });
            }
            if (pathname.endsWith('/events')) {
                const { events } = JSON.parse(init.body);
                return Response.json({ acks: Object.fromEntries(events.map(event => [event.commandId, event.sequence])) });
            }
            return Response.json({});
        },
    };
    const node = new ManagedNode(options);
    let restored;
    t.after(async () => {
        releaseAck?.();
        await node.stop();
        await restored?.stop();
        journal.close();
        await rm(directory, { recursive: true, force: true });
    });
    const tick = node.tick();
    await waiting;
    const stopped = node.stop();
    releaseAck();
    await Promise.all([tick, stopped]);
    assert.equal(executions, 0);
    assert.equal(journal.get(command.commandId).phase, 'accepted');
    assert.deepEqual(journal.pending(), []);
    delayAck = false;
    restored = new ManagedNode(options);
    await restored.tick();
    await restored.drain();
    assert.equal(executions, 1);
    assert.equal(journal.get(command.commandId).phase, 'completed');
});

async function host(directory, root) {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = directory;
    const routes = [], cleanups = [];
    apply({
        webServer: { register: route => { routes.push(route); return () => {}; } },
        effect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
        get: name => name === 'workspaceRegistry' ? { list: () => [{ id: 'workspace-a', path: root }] } : undefined,
    });
    const server = createServer((req, res) => {
        const route = routes.filter(route => new URL(req.url, 'http://local').pathname.startsWith(route.path)).sort((a, b) => b.path.length - a.path.length)[0];
        if (route) void Promise.resolve(route.handler(req, res)).catch(error => { res.statusCode = 500; res.end(error.message); });
        else { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const stop = async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    };
    return { base: `http://127.0.0.1:${server.address().port}/dsh-code-review`, stop };
}

for (const leaseState of ['active', 'releasable']) {
    test(`AC-SCHEDULE-01 Host 重启恢复的 ${leaseState} 租约阻止启用中央`, async t => {
        let runtime;
        t.after(() => runtime?.stop());
        const { app } = await setupCentral(t);
        const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const credential = app.database.createNode('接入节点');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'review-local-lease-'));
        const root = await createGitFixture();
        t.after(() => Promise.all([directory, root].map(target => rm(target, { recursive: true, force: true }))));
        const stateDirectory = path.join(directory, 'dsh-code-review');
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(path.join(stateDirectory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, repoRoot: root, owner: '审核者', runner: 'manual', vcsType: 'git' }));
        const lease = { auditId: 'audit-before-restart', root, targetPath: '', trigger: 'manual', baseRevision: 'before', owner: '审核者',
            createdAt: new Date().toISOString(), candidateIdsBefore: [], state: leaseState };
        const stateFile = path.join(stateDirectory, 'runtime-state.json');
        await writeFile(stateFile, JSON.stringify({ leases: [lease] }));
        runtime = await host(directory, root);
        const { base } = runtime;
        assert.deepEqual((await (await fetch(`${base}/api/jobs`)).json()).jobs, []);
        const state = await (await fetch(`${base}/connection`)).json();
        const request = () => fetch(`${base}/connection/apply`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-review-control': state.controlToken },
            body: JSON.stringify({ mode: 'external', centerUrl, ...credential }) });
        const response = await request();
        assert.equal(response.status, 409, await response.text());
        assert.equal((await (await fetch(`${base}/connection`)).json()).configured, false);
        assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).leases[0].state, leaseState);
        if (leaseState === 'releasable') {
            const release = await fetch(`${base}/api/audit/release`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ auditId: lease.auditId, confirmStopped: true }) });
            assert.equal(release.status, 200, await release.text());
            const enabled = await request();
            assert.equal(enabled.status, 200, await enabled.text());
        }
    });
}

test('AC-SCHEDULE-01 本地持久租约无法恢复时不得通过启用中央绕过', async t => {
    let runtime;
    t.after(() => runtime?.stop());
    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const credential = app.database.createNode('恢复检查节点');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-local-recovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'dsh-code-review'), { recursive: true });
    await writeFile(path.join(directory, 'dsh-code-review', 'runtime-state.json'), '{broken');
    runtime = await host(directory, directory);
    const { base } = runtime;
    const state = await (await fetch(`${base}/connection`)).json();
    const response = await fetch(`${base}/connection/apply`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-review-control': state.controlToken },
        body: JSON.stringify({ mode: 'external', centerUrl, ...credential }) });
    assert.equal(response.status, 409, await response.text());
    assert.equal((await (await fetch(`${base}/connection`)).json()).configured, false);
});

test('AC-PLUGIN-CENTRAL-07 节点在线状态要求中央仍接纳当前活动实例', async t => {
    let value;
    t.after(() => value?.stop());
    let now = Date.now();
    const { app } = await setupCentral(t, { clock: () => new Date(now) });
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const credential = app.database.createNode('在线检查节点');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-node-online-'));
    value = new ConnectionController({ directory, candidates: async () => [] });
    t.after(() => rm(directory, { recursive: true, force: true }));
    await value.init();
    await value.apply({ mode: 'external', centerUrl, ...credential });
    assert.equal((await value.status()).nodeOnline, true);
    const registered = app.database.getNode(credential.nodeId);
    app.database.quiesceNode(credential.nodeId, registered.instanceId);
    assert.equal((await value.status()).nodeOnline, false, '暂停受理的节点不能显示在线');
    app.database.activateNode(credential.nodeId, registered.instanceId);
    now += 31000;
    assert.equal((await value.status()).nodeOnline, false, '心跳超时不能显示在线');
    app.database.registerNode(credential.nodeId, { ...registered, instanceId: 'replacement-instance' });
    assert.equal(app.database.getNode(credential.nodeId).online, true);
    assert.equal((await value.status()).nodeOnline, false, '另一活动实例不能冒充本插件节点在线');
});

for (const dirtyFirst of [false, true]) {
    test(`AC-CENTRAL-04 真实 Handle 在 ACK 迟到后停止并重启，${dirtyFirst ? '清理现场后再次' : '人工'}核验可结束未启动指令`, { timeout: 25000 }, async t => {
        let handle, releaseAck, enteredAck;
        const originalFetch = globalThis.fetch;
        t.after(async () => {
            releaseAck?.();
            await handle?.stop();
            globalThis.fetch = originalFetch;
        });
        const { app, headers } = await setupCentral(t);
        const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const credential = app.database.createNode('停止恢复节点');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'review-handle-recovery-'));
        const root = await createGitFixture();
        t.after(() => Promise.all([directory, root].map(target => rm(target, { recursive: true, force: true }))));
        const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
        const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
        const waiting = new Promise(resolve => { enteredAck = resolve; });
        globalThis.fetch = async (url, init) => {
            const response = await originalFetch(url, init);
            if (new URL(url).pathname.endsWith('/ack')) {
                enteredAck();
                await new Promise(resolve => { releaseAck = resolve; });
            }
            return response;
        };
        const config = { centerUrl, ...credential,
            workspaces: [{ workspaceId: 'workspace-a', label: '项目', root, target, settings: { runner: 'manual', syncBeforeApprove: false } }] };
        handle = await startManagedNode(config, directory, async () => undefined, () => {});
        const project = await bindProject(app, headers, { ...credential, workspaceId: 'workspace-a' });
        const accepted = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
            payload: { operation: 'sync', idempotencyKey: 'stop-ack-real', payload: {} } });
        assert.equal(accepted.statusCode, 202, accepted.body);
        const commandId = accepted.json().command.commandId;
        await waiting;
        const stopped = handle.stop();
        handle = undefined;
        releaseAck();
        await stopped;
        globalThis.fetch = originalFetch;
        const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
        assert.equal(journal.get(commandId).phase, 'accepted');
        assert.equal(journal.recoveryData(commandId), null);
        journal.close();
        assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'recovery_required');
        if (dirtyFirst) await writeFile(path.join(root, 'src/math.js'), '外部执行中的现场\n');
        handle = await startManagedNode(config, directory, async () => undefined, () => {});
        assert.equal(handle.hasUnsettled(), true);
        const requested = await app.inject({ method: 'POST', url: `/api/v1/commands/${commandId}/recover`, headers, payload: { confirmStopped: true } });
        assert.equal(requested.statusCode, 200, requested.body);
        const waitForResult = async status => {
            let current;
            for (let attempt = 0; attempt < 120; attempt++) {
                current = (await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command;
                if (current.result?.outcome.status === status && (status === 'RECOVERY_REQUIRED' || !handle.hasUnsettled())) return current;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return current;
        };
        if (dirtyFirst) {
            const blocked = await waitForResult('RECOVERY_REQUIRED');
            assert.equal(blocked.state, 'recovery_required');
            assert.equal(blocked.result.delivery.state, 'unknown');
            assert.equal(await readFile(path.join(root, 'src/math.js'), 'utf8'), '外部执行中的现场\n');
            await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a - b;\n');
            const retry = await app.inject({ method: 'POST', url: `/api/v1/commands/${commandId}/recover`, headers, payload: { confirmStopped: true } });
            assert.equal(retry.statusCode, 200, retry.body);
        }
        const recovered = await waitForResult('ABORTED');
        assert.equal(recovered.state, 'completed', JSON.stringify(recovered));
        assert.equal(recovered.result.outcome.status, 'ABORTED');
        assert.equal(recovered.result.delivery.state, 'not_required');
        assert.equal(handle.hasUnsettled(), false);
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
        assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout, '');
    });
}

for (const state of ['dirty', 'lease', 'executing', 'checkpoint']) {
    test(`AC-CENTRAL-04 未启动恢复遇到 ${state} 证据时继续要求核验且不修改现场`, async t => {
        const root = await createGitFixture();
        const directory = await mkdtemp(path.join(os.tmpdir(), 'review-unsafe-recovery-'));
        const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
        let operations;
        t.after(async () => {
            operations?.stop();
            journal.close();
            await Promise.all([directory, root].map(target => rm(target, { recursive: true, force: true })));
        });
        const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
        const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
        const command = { commandId: `unsafe-${state}`, requestHash: 'b'.repeat(64), projectId: 'project-a', nodeId: 'node-a',
            bindingGeneration: 1, projectConfigRevision: 1, operation: 'sync', payload: {},
            actor: { userId: 'user-a', reviewIdentity: '审核者' }, createdAt: new Date().toISOString() };
        journal.accept(command);
        if (state === 'executing') journal.markExecuting(command.commandId);
        if (state === 'checkpoint') journal.checkpoint(command.commandId, { phase: 'invoking', workspaceId: 'workspace-a' });
        if (state === 'dirty') await writeFile(path.join(root, 'src/math.js'), '外部执行中的现场\n');
        if (state === 'lease') await writeFile(path.join(directory, 'workspace-a-runtime.json'), JSON.stringify({ leases: [{
            auditId: 'blocking-audit', root, targetPath: '', trigger: 'manual', baseRevision: head, owner: '审核者',
            createdAt: new Date().toISOString(), candidateIdsBefore: [], state: 'releasable',
        }] }));
        operations = new ManagedOperations({ dataDir: directory, journal, workspaces: [{ workspaceId: 'workspace-a', label: '项目', root, target }] });
        await operations.init();
        const before = runCommand('git', ['status', '--porcelain'], root).stdout;
        const result = await operations.recover(command, undefined, { projectId: 'project-a', nodeId: 'node-a', workspaceId: 'workspace-a',
            bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true });
        assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
        assert.equal(result.delivery.state, 'unknown');
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
        assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout, before);
    });
}
