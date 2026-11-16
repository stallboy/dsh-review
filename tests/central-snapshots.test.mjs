import assert from 'node:assert/strict';
import test from 'node:test';
import { setupCentral, registerNode, bindProject } from './central-helpers.mjs';

test('心跳不能把过期快照标为已同步，时效以中央接收时间为准', async t => {
    let now = new Date('2026-11-16T10:00:00Z');
    const { app, headers } = await setupCentral(t, { clock: () => now });
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}`;
    await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers, payload: { instanceId: node.instanceId,
        snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: 1, vcsSnapshot: 'head',
            collectedAt: '2099-01-01T00:00:00Z', queue: [], findings: [], audits: [], errors: [] } } });
    assert.equal((await app.inject({ url, headers })).json().freshness, 'synced');
    now = new Date(now.getTime() + 31000);
    await app.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: node.headers, payload: { instanceId: node.instanceId } });
    const stale = (await app.inject({ url, headers })).json();
    assert.equal(stale.online, true);
    assert.equal(stale.freshness, 'stale');
    assert.equal(stale.writable, false);
});

test('快照按项目与单调序号同步，旧快照和其他节点不能覆盖', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app, 'a', 'repo-a');
    const b = await registerNode(app, 'b', 'repo-b');
    const p = await bindProject(app, headers, a);
    const snapshot = { projectId: p.projectId, bindingGeneration: 1, projectConfigRevision: 1,
        snapshotSequence: 2, vcsSnapshot: 'commit-2', collectedAt: '2026-11-16T06:00:00.000Z',
        queue: [{ id: '2026-11/fix', title: '已同步候选', owner: '审核者甲', status: 'pending' }], findings: [], audits: [], errors: [] };
    const send = (node, data) => app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers, payload: { instanceId: node.instanceId, snapshot: data } });
    assert.equal((await send(a, snapshot)).statusCode, 200);
    assert.equal((await send(a, { ...snapshot, snapshotSequence: 1, vcsSnapshot: 'older' })).statusCode, 409);
    assert.equal((await send(b, { ...snapshot, snapshotSequence: 3 })).statusCode, 403);
    const queue = await app.inject({ url: `/api/v1/projects/${p.projectId}/queue`, headers });
    assert.equal(queue.json().vcsSnapshot, 'commit-2');
    assert.equal(queue.json().items[0].title, '已同步候选');
});

test('缺附件时不发布快照，详情未缓存通过只读请求异步加载', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app);
    const p = await bindProject(app, headers, a);
    const snapshot = { projectId: p.projectId, bindingGeneration: 1, projectConfigRevision: 1,
        snapshotSequence: 1, vcsSnapshot: 'base', collectedAt: '2026-11-16T06:00:00.000Z', queue: [], findings: [], audits: [], errors: [] };
    const send = data => app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: a.headers, payload: { instanceId: a.instanceId, snapshot: data } });
    assert.equal((await send({ ...snapshot, artifacts: [{ hash: 'a'.repeat(64), size: 2 }] })).statusCode, 409);
    assert.equal((await send(snapshot)).statusCode, 200);
    const query = await app.inject({ url: `/api/v1/projects/${p.projectId}/candidate?id=2026-11/fix`, headers });
    assert.equal(query.statusCode, 202);
    const polled = await app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: a.headers, payload: { instanceId: a.instanceId } });
    assert.equal(polled.json().queries[0].queryId, query.json().queryId);
});

test('失败详情可以重试，迟到的旧查询回报不能覆盖新的结果', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers,
        payload: { instanceId: node.instanceId, snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1,
            snapshotSequence: 1, vcsSnapshot: 'base', collectedAt: '2026-11-16T06:00:00.000Z', queue: [], findings: [], audits: [], errors: [] } } });
    const url = `/api/v1/projects/${project.projectId}/candidate?id=2026-11/fix`;
    const first = (await app.inject({ url, headers })).json();
    const report = result => app.inject({ method: 'POST', url: '/node-api/v1/queries/results', headers: node.headers,
        payload: { instanceId: node.instanceId, results: [result] } });
    const failed = { queryId: first.queryId, vcsSnapshot: 'base', status: 'error', error: '临时读取失败' };
    assert.equal((await report(failed)).statusCode, 200);
    const retry = await app.inject({ url, headers });
    assert.equal(retry.statusCode, 202);
    assert.notEqual(retry.json().queryId, first.queryId);
    const fresh = { queryId: retry.json().queryId, vcsSnapshot: 'base', status: 'ready', data: { title: '读取成功' } };
    assert.equal((await report(fresh)).statusCode, 200);
    assert.equal((await report(failed)).statusCode, 200);
    assert.equal((await app.inject({ url, headers })).json().data.title, '读取成功');
});
