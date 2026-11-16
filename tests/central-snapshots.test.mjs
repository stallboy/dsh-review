import assert from 'node:assert/strict';
import test from 'node:test';
import { setupCentral, registerNode, bindProject } from './central-helpers.mjs';

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
