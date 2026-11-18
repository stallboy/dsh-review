import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupCentral, registerNode, bindProject, approvePayload } from './central-helpers.mjs';
import { validateRegistration } from '../packages/protocol/dist/index.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { digest, stableJson } from '../apps/server/dist/auth.js';

test('AC-CENTRAL-01 不兼容节点不能通过 ACK 首次受理写指令', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    const commandId = created.json().command.commandId;
    const registration = { ...app.database.getNode(node.nodeId), protocolVersion: 2 };
    for (const key of ['nodeId', 'name', 'enabled', 'lastSeenAt', 'compatible', 'online']) delete registration[key];
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: registration })).statusCode, 200);
    const ack = await app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`, headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.equal(ack.statusCode, 409);
    assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'queued');
});

test('AC-CENTRAL-05 snapshot_moved 可重试，旧回报不能污染恢复到相同版本的新查询', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const send = sequence => app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers, payload: { instanceId: node.instanceId,
        snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: sequence,
            vcsSnapshot: 'A', collectedAt: new Date().toISOString(), queue: [], findings: [], audits: [], errors: [] } } });
    await send(1);
    const url = `/api/v1/projects/${project.projectId}/candidate?id=2026-11/fix`;
    const first = (await app.inject({ url, headers })).json();
    const report = result => app.inject({ method: 'POST', url: '/node-api/v1/queries/results', headers: node.headers, payload: { instanceId: node.instanceId, results: [result] } });
    const moved = { queryId: first.queryId, status: 'snapshot_moved', vcsSnapshot: 'B' };
    assert.equal((await report(moved)).statusCode, 200);
    await send(2);
    const retry = await app.inject({ url, headers });
    assert.equal(retry.statusCode, 202);
    assert.notEqual(retry.json().queryId, first.queryId);
    assert.equal((await report({ queryId: retry.json().queryId, status: 'ready', vcsSnapshot: 'A', data: { title: '恢复成功' } })).statusCode, 200);
    await report(moved);
    assert.equal((await app.inject({ url, headers })).json().data.title, '恢复成功');
});

test('AC-CENTRAL-07 本机执行配置摘要随设置变化，未决指令阻止换配置，空闲变更推进版本', async t => {
    const { app, headers } = await setupCentral(t);
    const root = await createGitFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-config-fix-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const instances = [];
    t.after(async () => {
        for (const instance of instances) instance.stop();
        journal.close();
        await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const registrations = async runner => {
        const operations = new ManagedOperations({ dataDir: directory, journal, workspaces: [{ workspaceId: 'workspace-a', label: 'A', root, target, settings: { runner } }] });
        instances.push(operations);
        await operations.init();
        return operations.registrations();
    };
    const manual = await registrations('manual');
    const external = await registrations('external');
    assert.match(manual[0].executionConfigHash ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(manual[0].executionConfigHash, external[0].executionConfigHash);
    const node = app.database.createNode('config-node');
    node.headers = { authorization: `Bearer ${node.token}` };
    node.workspaceId = 'workspace-a';
    node.instanceId = 'config-instance';
    const register = workspaces => app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers,
        payload: { protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: 'test', platform: process.platform, workspaces } });
    assert.equal((await register(manual)).statusCode, 200);
    const project = await bindProject(app, headers, node);
    assert.equal(project.executionConfigHash, manual[0].executionConfigHash);
    const queued = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
        payload: { operation: 'audit', idempotencyKey: 'old-config', payload: {} } });
    assert.equal(queued.statusCode, 202);
    assert.equal((await register(external)).statusCode, 409);
    assert.equal(app.database.getProject(project.projectId).projectConfigRevision, 1);
    assert.equal(app.database.getNode(node.nodeId).workspaces[0].executionConfigHash, manual[0].executionConfigHash);
    await app.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers, payload: { instanceId: node.instanceId,
        events: [{ commandId: queued.json().command.commandId, sequence: 1, type: 'result', result: { outcome: { status: 'ABORTED', reason: 'CANCELLED' }, delivery: { state: 'not_required' } } }] } });
    assert.equal((await register(external)).statusCode, 200);
    assert.equal(app.database.getProject(project.projectId).projectConfigRevision, 2);
    assert.equal((await register(external)).statusCode, 200);
    assert.equal(app.database.getProject(project.projectId).projectConfigRevision, 2);
});

test('AC-CENTRAL-07 空闲执行配置变更持久化版本，并隔离旧配置快照和详情缓存', async t => {
    const { app, headers, dataDir, createCentralApp } = await setupCentral(t);
    const node = await registerNode(app);
    const initialRegistration = { protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: 'test', platform: process.platform,
        workspaces: [{ workspaceId: node.workspaceId, label: 'A', vcsType: 'git', target: 'main', executionConfigHash: 'b'.repeat(64) }] };
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: initialRegistration })).statusCode, 200);
    const project = await bindProject(app, headers, node);
    const publish = (sequence, revision) => app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers,
        payload: { instanceId: node.instanceId, snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: revision,
            snapshotSequence: sequence, vcsSnapshot: 'same-vcs', collectedAt: new Date().toISOString(), queue: [], findings: [], audits: [], errors: [] } } });
    assert.equal((await publish(1, 1)).statusCode, 200);
    const url = `/api/v1/projects/${project.projectId}/candidate?id=2026-11/fix`;
    const query = (await app.inject({ url, headers })).json();
    await app.inject({ method: 'POST', url: '/node-api/v1/queries/results', headers: node.headers,
        payload: { instanceId: node.instanceId, results: [{ queryId: query.queryId, status: 'ready', vcsSnapshot: 'same-vcs', data: { marker: 'old-config' } }] } });
    const upgrade = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: {
        protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: 'test', platform: process.platform,
        workspaces: [{ workspaceId: node.workspaceId, label: 'A', vcsType: 'git', target: 'main', executionConfigHash: 'a'.repeat(64) }],
    } });
    assert.equal(upgrade.statusCode, 200);
    assert.equal((await app.inject({ url: `/api/v1/projects/${project.projectId}`, headers })).json().writable, false);
    assert.equal((await app.inject({ url, headers })).statusCode, 503);
    assert.equal((await publish(2, 1)).statusCode, 409);
    assert.equal((await publish(2, 2)).statusCode, 200);
    const fresh = await app.inject({ url, headers });
    assert.equal(fresh.statusCode, 202);
    assert.notEqual(fresh.json().queryId, query.queryId);
    await app.close();
    const reopened = await createCentralApp({ dataDir });
    assert.equal(reopened.database.getProject(project.projectId).projectConfigRevision, 2);
    assert.equal(reopened.database.getProject(project.projectId).executionConfigHash, 'a'.repeat(64));
});

test('AC-CENTRAL-01 配置摘要校验保留旧登记格式并拒绝无效摘要', () => {
    const registration = { protocolVersion: 1, instanceId: 'instance', pluginVersion: '0.3.0', dshVersion: 'test', platform: 'test',
        workspaces: [{ workspaceId: 'workspace', label: 'A', vcsType: 'git', target: 'main' }] };
    assert.deepEqual(validateRegistration(registration), registration);
    for (const executionConfigHash of ['', 1, 'a'.repeat(63), 'G'.repeat(64)]) {
        assert.throws(() => validateRegistration({ ...registration, workspaces: [{ ...registration.workspaces[0], executionConfigHash }] }), /executionConfigHash/);
    }
});

test('AC-CENTRAL-04 首次摘要登记可恢复旧任务，并通过原事件链结束未执行任务', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'review-config-migration-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload('legacy') });
    const oldCommand = created.json().command;
    journal.accept(oldCommand);
    const registration = { protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: 'test', platform: process.platform,
        workspaces: [{ workspaceId: node.workspaceId, label: 'A', vcsType: 'git', target: 'main', executionConfigHash: 'a'.repeat(64) }] };
    let executions = 0;
    const runtime = new ManagedNode({ config: { ...node, centerUrl: 'http://127.0.0.1/', workspaces: registration.workspaces }, journal,
        execute: async () => { executions++; throw new Error('旧配置未核验，不得执行'); }, read: async () => { throw new Error('unused'); },
        fetch: async (url, options) => {
            const response = await app.inject({ method: options.method, url: new URL(url).pathname, headers: options.headers, payload: options.body });
            return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
        } });
    t.after(async () => { await runtime.stop(); journal.close(); await rm(directory, { recursive: true, force: true }); });
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: registration });
    assert.equal(registered.statusCode, 200);
    assert.equal(app.database.getProject(project.projectId).projectConfigRevision, 1);
    await runtime.tick();
    await runtime.drain();
    await runtime.tick();
    assert.equal(executions, 0);
    assert.equal(journal.get(oldCommand.commandId).phase, 'completed');
    assert.equal(journal.hasUnsettled(), false);
    const finished = (await app.inject({ url: `/api/v1/commands/${oldCommand.commandId}`, headers })).json().command;
    assert.equal(finished.state, 'completed');
    assert.equal(finished.result.outcome.status, 'ABORTED');
});

test('AC-CENTRAL-05 升级前已缓存详情在节点离线时继续可读', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers, payload: { instanceId: node.instanceId,
        snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: 1,
            vcsSnapshot: 'legacy', collectedAt: new Date().toISOString(), queue: [], findings: [], audits: [], errors: [] } } });
    const url = `/api/v1/projects/${project.projectId}/candidate?id=2026-11/fix`;
    const query = (await app.inject({ url, headers })).json();
    await app.inject({ method: 'POST', url: '/node-api/v1/queries/results', headers: node.headers, payload: { instanceId: node.instanceId,
        results: [{ queryId: query.queryId, status: 'ready', vcsSnapshot: 'legacy', data: { title: '旧版离线缓存' } }] } });
    const oldKey = digest(stableJson({ projectId: project.projectId, generation: 1, snapshot: 'legacy', kind: 'candidate', params: { id: '2026-11/fix' } }));
    app.database.sql.prepare('UPDATE queries SET cache_key=? WHERE query_id=?').run(oldKey, query.queryId);
    await app.inject({ method: 'POST', url: '/node-api/v1/disconnect', headers: node.headers, payload: { instanceId: node.instanceId } });
    const cached = await app.inject({ url, headers });
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().data.title, '旧版离线缓存');
    assert.equal(cached.json().freshness, 'offline');
});
