import assert from 'node:assert/strict';
import test from 'node:test';
import { setupCentral, registerNode, bindProject, approvePayload } from './central-helpers.mjs';

test('指令幂等、项目写互斥，节点只能领取自己的项目', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app, 'a', 'repo-a');
    const b = await registerNode(app, 'b', 'repo-b');
    const project = await bindProject(app, headers, a);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const first = await app.inject({ method: 'POST', url, headers, payload: approvePayload() });
    assert.equal(first.statusCode, 202, first.body);
    const repeated = await app.inject({ method: 'POST', url, headers, payload: approvePayload() });
    assert.equal(repeated.json().command.commandId, first.json().command.commandId);
    const conflict = await app.inject({ method: 'POST', url, headers, payload: { ...approvePayload(), payload: { id: 'other' } } });
    assert.equal(conflict.statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: approvePayload('different-key') })).statusCode, 409);
    const poll = n => app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: n.headers, payload: { instanceId: n.instanceId } });
    assert.equal((await poll(b)).json().commands.length, 0);
    assert.equal((await poll(a)).json().commands[0].commandId, first.json().command.commandId);
    assert.equal((await poll(a)).json().commands[0].commandId, first.json().command.commandId);
});

test('终态事件去重且未决交付继续阻塞，中心重开不丢占用', async t => {
    const { app, headers, dataDir, createCentralApp } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const created = await app.inject({ method: 'POST', url, headers, payload: approvePayload() });
    const id = created.json().command.commandId;
    await app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers, payload: { instanceId: node.instanceId } });
    const event = { commandId: id, sequence: 1, type: 'result', result: { outcome: { status: 'COMMITTED', commitRevision: 'abc' }, delivery: { state: 'pending', commitRevision: 'abc' } } };
    const post = () => app.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers, payload: { instanceId: node.instanceId, events: [event] } });
    assert.equal((await post()).statusCode, 200);
    assert.equal((await post()).json().acks[id], 1);
    const second = await createCentralApp({ dataDir });
    t.after(() => second.close());
    assert.equal((await second.inject({ method: 'POST', url, headers, payload: approvePayload('next') })).statusCode, 409);
    const record = await second.inject({ url: `/api/v1/commands/${id}`, headers });
    assert.equal(record.json().command.result.delivery.state, 'pending');
});

test('离线状态禁止新写，取消请求不清空占用', async t => {
    let now = new Date('2026-11-16T06:00:00.000Z');
    const { app, headers } = await setupCentral(t, { clock: () => now });
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const created = await app.inject({ method: 'POST', url, headers, payload: approvePayload() });
    const id = created.json().command.commandId;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/commands/${id}/cancel`, headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: approvePayload('next') })).statusCode, 409);
    now = new Date(now.getTime() + 31000);
    const other = await registerNode(app, 'other', 'other-repo');
    const otherProject = await bindProject(app, headers, other);
    now = new Date(now.getTime() + 31000);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/projects/${otherProject.projectId}/commands`, headers, payload: approvePayload() })).statusCode, 503);
});
