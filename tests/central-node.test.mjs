import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupCentral, registerNode, bindProject, approvePayload } from './central-helpers.mjs';

async function nodeRuntime(t, app, registration, execute, extra = {}) {
    const entry = new URL('../packages/dsh-plugin/dist/managed/managed-node.js', import.meta.url);
    assert.equal(existsSync(entry), true, 'DSH 托管节点尚未实现');
    const { ManagedNode } = await import(entry.href);
    const { ManagedJournal } = await import(new URL('../packages/dsh-plugin/dist/managed/managed-journal.js', import.meta.url));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-node-test-'));
    const journal = new ManagedJournal(path.join(directory, 'node.sqlite'));
    const transport = async (url, options = {}) => {
        const reply = await app.inject({ method: options.method ?? 'GET', url: new URL(url).pathname,
            headers: options.headers, ...(options.body ? { payload: options.body } : {}) });
        return new Response(reply.body, { status: reply.statusCode, headers: reply.headers });
    };
    const node = new ManagedNode({ config: { centerUrl: 'http://127.0.0.1:3081', nodeId: registration.nodeId,
        token: registration.token, instanceId: registration.instanceId,
        workspaces: [{ workspaceId: registration.workspaceId, label: '工作副本', vcsType: 'git', target: 'main' }] },
        journal, execute, read: async query => ({ queryId: query.queryId, vcsSnapshot: query.vcsSnapshot, status: 'ready', data: {} }), fetch: transport, ...extra });
    t.after(async () => { await node.stop(); journal.close(); await rm(directory, { recursive: true, force: true }); });
    return { node, journal, transport };
}

test('ACK 已落库但响应丢失后可继续执行，受理记录不会永久卡住或重复启动', async t => {
    const { app, headers } = await setupCentral(t);
    const registration = await registerNode(app);
    const project = await bindProject(app, headers, registration);
    let executions = 0, loseAck = true;
    const runtime = await nodeRuntime(t, app, registration, async () => {
        executions++;
        return { outcome: { status: 'ABORTED', reason: 'CANCELLED' }, delivery: { state: 'not_required' } };
    });
    const transport = runtime.transport;
    const { ManagedNode } = await import('../packages/dsh-plugin/dist/managed/managed-node.js');
    const node = new ManagedNode({ config: { centerUrl: 'http://127.0.0.1:3081', nodeId: registration.nodeId, token: registration.token,
        instanceId: registration.instanceId, workspaces: [{ workspaceId: registration.workspaceId, label: 'repo', vcsType: 'git', target: 'main' }] },
        journal: runtime.journal, execute: async () => { executions++; return { outcome: { status: 'ABORTED' }, delivery: { state: 'not_required' } }; },
        read: async () => { throw new Error('unused'); }, fetch: async (url, options) => {
            const response = await transport(url, options);
            if (loseAck && new URL(url).pathname.endsWith('/ack')) { loseAck = false; throw new Error('ACK response lost'); }
            return response;
        } });
    t.after(() => node.stop());
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload('lost-ack') });
    const commandId = accepted.json().command.commandId;
    await assert.rejects(node.tick(), /ACK response lost/);
    assert.equal(runtime.journal.get(commandId).phase, 'accepted');
    for (let index = 0; index < 3; index++) { await node.tick(); await node.drain(); }
    assert.equal(executions, 1);
    assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'completed');
});

test('同节点独立工作副本可并行读取，慢详情不阻止取消控制', async t => {
    const { app, headers } = await setupCentral(t);
    const registration = await registerNode(app);
    const workspaces = [registration.workspaceId, 'workspace-b'].map(workspaceId => ({ workspaceId, label: workspaceId, vcsType: 'git', target: 'main' }));
    await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: registration.headers, payload: {
        protocolVersion: 1, instanceId: registration.instanceId, pluginVersion: '0.3.0', dshVersion: 'unknown', platform: 'linux', workspaces,
    } });
    const a = await bindProject(app, headers, registration), b = await bindProject(app, headers, { ...registration, workspaceId: 'workspace-b' }, '项目 B');
    await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: registration.headers, payload: { instanceId: registration.instanceId,
        snapshot: { projectId: b.projectId, bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: 1, vcsSnapshot: 'head-b', collectedAt: new Date().toISOString(), queue: [], findings: [], audits: [], errors: [] } } });
    await app.inject({ url: `/api/v1/projects/${b.projectId}/candidate?id=2026-11/test`, headers });
    let reads = 0, cancelled = false, releaseRead;
    const runtime = await nodeRuntime(t, app, registration, async (_command, signal) => {
        await new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
        return { outcome: { status: 'ABORTED', reason: 'CANCELLED' }, delivery: { state: 'not_required' } };
    }, { config: { centerUrl: 'http://127.0.0.1:3081', nodeId: registration.nodeId, token: registration.token, instanceId: registration.instanceId, workspaces },
        read: async query => { reads++; await new Promise(resolve => { releaseRead = resolve; }); return { queryId: query.queryId, vcsSnapshot: query.vcsSnapshot, status: 'ready', data: { candidate: 'b' } }; } });
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/projects/${a.projectId}/commands`, headers, payload: approvePayload('parallel-read') });
    const commandId = accepted.json().command.commandId;
    await runtime.node.tick();
    assert.equal(reads, 1);
    await app.inject({ method: 'POST', url: `/api/v1/commands/${commandId}/cancel`, headers, payload: {} });
    await runtime.node.tick();
    assert.equal(cancelled, true);
    releaseRead();
    await runtime.node.drain();
    await runtime.node.tick();
    assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'completed');
});

test('大型详情先上传内容寻址附件再发布引用，补丁换行完整保留', async t => {
    const { app, headers } = await setupCentral(t);
    const registration = await registerNode(app), project = await bindProject(app, headers, registration);
    await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: registration.headers, payload: { instanceId: registration.instanceId,
        snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: 1, vcsSnapshot: 'large-head', collectedAt: new Date().toISOString(), queue: [], findings: [], audits: [], errors: [] } } });
    const queryUrl = `/api/v1/projects/${project.projectId}/patch?id=2026-11/large&name=001.patch`;
    assert.equal((await app.inject({ url: queryUrl, headers })).statusCode, 202);
    const text = '+完整保留 UTF-8 与 CRLF\r\n'.repeat(20000);
    const runtime = await nodeRuntime(t, app, registration, async () => { throw new Error('unused'); }, {
        read: async query => ({ queryId: query.queryId, vcsSnapshot: query.vcsSnapshot, status: 'ready', data: { name: '001.patch', text } }),
    });
    await runtime.node.tick();
    await runtime.node.drain();
    const cached = (await app.inject({ url: queryUrl, headers })).json();
    assert.equal(cached.data.type, 'central-artifact');
    const artifact = await app.inject({ url: `/api/v1/artifacts/${cached.data.hash}`, headers });
    assert.equal(artifact.statusCode, 200);
    assert.equal(JSON.parse(artifact.body).text, text);
});

test('两个托管节点独立领取指令，重复投递不会重复执行', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app, 'a', 'repo-a'), b = await registerNode(app, 'b', 'repo-b');
    const project = await bindProject(app, headers, a);
    let countA = 0, countB = 0;
    const result = { outcome: { status: 'COMMITTED', commitRevision: 'commit-a' }, delivery: { state: 'delivered', commitRevision: 'commit-a' } };
    const first = await nodeRuntime(t, app, a, async () => { countA++; return result; });
    const second = await nodeRuntime(t, app, b, async () => { countB++; return result; });
    const reply = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    const command = reply.json().command;
    await second.node.tick();
    await first.node.tick();
    await first.node.drain();
    await first.node.tick();
    assert.equal(countA, 1);
    assert.equal(countB, 0);
    assert.equal(first.journal.accept(command).fresh, false);
    const stored = await app.inject({ url: `/api/v1/commands/${command.commandId}`, headers });
    assert.equal(stored.json().command.state, 'completed');
});

test('节点执行期间仍处理取消，结果和日志可靠回报', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app);
    const project = await bindProject(app, headers, a);
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const { node } = await nodeRuntime(t, app, a, async (_command, signal, emit) => {
        emit('开始执行'); started();
        return new Promise(resolve => signal.addEventListener('abort', () => resolve({
            outcome: { status: 'ABORTED', reason: 'CANCELLED' }, delivery: { state: 'not_required' },
        }), { once: true }));
    });
    const reply = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
        payload: { ...approvePayload(), operation: 'ai-fix' } });
    const id = reply.json().command.commandId;
    await node.tick(); await running;
    await app.inject({ method: 'POST', url: `/api/v1/commands/${id}/cancel`, headers, payload: {} });
    await node.tick(); await node.drain(); await node.tick();
    assert.equal((await app.inject({ url: `/api/v1/commands/${id}`, headers })).json().command.result.outcome.status, 'ABORTED');
    assert.deepEqual((await app.inject({ url: `/api/v1/tasks/${id}/logs`, headers })).json().log, ['开始执行']);
});

test('本地已进入执行阶段的指令在恢复握手时不重跑', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app);
    const project = await bindProject(app, headers, a);
    const reply = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    let executions = 0;
    const { node, journal } = await nodeRuntime(t, app, a, async () => { executions++; throw new Error('不应执行'); });
    journal.accept(reply.json().command);
    journal.markExecuting(reply.json().command.commandId);
    await node.tick();
    assert.equal(executions, 0);
    const stored = await app.inject({ url: `/api/v1/commands/${reply.json().command.commandId}`, headers });
    assert.equal(stored.json().command.state, 'recovery_required');
    assert.equal(stored.json().command.result.outcome.status, 'RECOVERY_REQUIRED');
});
