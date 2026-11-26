import assert from 'node:assert/strict';
import test from 'node:test';
import { setupCentral, registerNode, bindProject, approvePayload } from './central-helpers.mjs';

test('中央对 finding-decision 统一强制校验 ConcurrencyGuard 且拒绝伪造 owner', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const withoutGuard = await app.inject({
        method: 'POST', url, headers,
        payload: { operation: 'finding-decision', idempotencyKey: 'no-guard', payload: { id: '2026-11/fix-retry', action: 'human_takeover' } },
    });
    assert.equal(withoutGuard.statusCode, 422, withoutGuard.body);
    assert.match(withoutGuard.json().error.message, /guard/);

    const forgedOwner = await app.inject({
        method: 'POST', url, headers,
        payload: {
            operation: 'finding-decision',
            idempotencyKey: 'forged-owner',
            payload: { id: '2026-11/fix-retry', action: 'human_takeover', owner: 'other' },
            guard: { expectedRevision: 1, expectedOwner: '审核者甲', expectedUpdatedAt: '2026-11-16T06:00:00.000Z' },
        },
    });
    assert.equal(forgedOwner.statusCode, 422, forgedOwner.body);

    const valid = await app.inject({
        method: 'POST', url, headers,
        payload: {
            operation: 'finding-decision',
            idempotencyKey: 'valid-decision',
            payload: { id: '2026-11/fix-retry', action: 'human_takeover' },
            guard: { expectedRevision: 1, expectedOwner: '审核者甲', expectedUpdatedAt: '2026-11-16T06:00:00.000Z' },
        },
    });
    assert.equal(valid.statusCode, 202, valid.body);
});

test('中央拒绝已废止旧操作且节点不会收到非法指令', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const { payload, ...request } = approvePayload('retired');
    for (const op of ['manual-revision', 'reject', 'reopen', 'archive-stale', 'convert', 'dismiss-finding']) {
        const response = await app.inject({
            method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
            payload: { ...request, idempotencyKey: `retired-${op}`, operation: op, payload },
        });
        assert.equal(response.statusCode, 422, `${op}: ${response.body}`);
        assert.match(response.json().error.message, /operation/);
    }
    assert.deepEqual((await app.inject({
        method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers,
        payload: { instanceId: node.instanceId },
    })).json().commands, []);
});

test('中央支持 reviewers-init 与 schema_version 1 审查指令且无需旧版能力标志', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app, 'node-v1', 'workspace-v1', { auditSelfTest: true });
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const initResp = await app.inject({
        method: 'POST', url, headers,
        payload: { operation: 'reviewers-init', idempotencyKey: 'init-1', payload: { defaultOwner: '审核者甲' } },
    });
    assert.equal(initResp.statusCode, 202, initResp.body);
    assert.equal(initResp.json().command.operation, 'reviewers-init');
});

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

test('恢复回报不能抹掉已证明的提交或将待交付降为不需交付', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const url = `/api/v1/projects/${project.projectId}/commands`;
    const created = await app.inject({ method: 'POST', url, headers, payload: approvePayload() });
    const commandId = created.json().command.commandId;
    const outcome = { status: 'COMMITTED', commitRevision: 'abc', message: '已提交' };
    const report = (sequence, result) => app.inject({
        method: 'POST', url: '/node-api/v1/events', headers: node.headers,
        payload: { instanceId: node.instanceId, events: [{ commandId, sequence, type: 'result', result }] },
    });
    assert.equal((await report(1, { outcome, delivery: { state: 'pending', commitRevision: 'abc' } })).statusCode, 200);
    assert.equal((await report(2, { outcome: { status: 'ABORTED', commitRevision: 'abc' }, delivery: { state: 'not_required' } })).statusCode, 409);
    assert.equal((await report(2, { outcome, delivery: { state: 'not_required', commitRevision: 'abc' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: approvePayload('next') })).statusCode, 409);
    assert.equal((await report(2, { outcome, delivery: { state: 'delivered', commitRevision: 'abc' } })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.result.outcome, outcome);
});

test('恢复控制必须由用户明确请求，不因轮询自动重试交付', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app);
    const project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    const commandId = created.json().command.commandId;
    await app.inject({
        method: 'POST', url: '/node-api/v1/events', headers: node.headers,
        payload: {
            instanceId: node.instanceId,
            events: [{ commandId, sequence: 1, type: 'result', result: { outcome: { status: 'COMMITTED', commitRevision: 'abc' }, delivery: { state: 'pending', commitRevision: 'abc' } } }],
        },
    });
    const poll = () => app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.deepEqual((await poll()).json().recoveries, []);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/commands/${commandId}/recover`, headers, payload: { confirmStopped: true } })).statusCode, 200);
    assert.deepEqual((await poll()).json().recoveries, [commandId]);
});

test('中央审计指令不再注入旧版 findingWorkflow 或 issueWorkflow 兼容字段', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app, 'new-node', 'new-workspace');
    const project = await bindProject(app, headers, node);
    const started = await app.inject({
        method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
        payload: { operation: 'audit', idempotencyKey: 'native-v1', payload: { targetPath: '.' } },
    });
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().command.payload.issueWorkflow, undefined);
    assert.equal(started.json().command.payload.findingWorkflow, undefined);
});
