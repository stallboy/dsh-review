import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bindProject, registerNode, setupCentral } from './central-helpers.mjs';

async function scheduledProject(t, startTime = '02:00', initialTime = '2026-11-17T17:59:00Z', timeZone = 'Asia/Shanghai') {
    let now = new Date(initialTime);
    const clock = () => now;
    const setup = await setupCentral(t, { clock });
    const node = await registerNode(setup.app);
    const project = await bindProject(setup.app, setup.headers, node);
    const path = `/api/v1/projects/${project.projectId}`;
    const register = (workspaces) => setup.app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers,
        payload: { protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux', workspaces } });
    const workspace = { workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' };
    const put = (payload) => setup.app.inject({ method: 'PUT', url: `${path}/audit-schedule`, headers: setup.headers, payload });
    const configured = await put({ enabled: true, startTime, timeZone });
    assert.equal(configured.statusCode, 200, configured.body);
    const poll = async (app = setup.app, capable = true) => {
        const reply = await app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers,
            payload: { instanceId: node.instanceId, ...(capable ? { scheduledAuditWorkspaces: [node.workspaceId] } : {}) } });
        assert.equal(reply.statusCode, 200, reply.body);
        return reply.json().commands;
    };
    const view = async () => (await setup.app.inject({ url: path, headers: setup.headers })).json().auditSchedule;
    const ackResponse = (commandId, caller = node) => setup.app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`,
        headers: caller.headers, payload: { instanceId: caller.instanceId } });
    const ack = async commandId => (await ackResponse(commandId)).json().command;
    const finish = async commandId => {
        const reply = await setup.app.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers, payload: { instanceId: node.instanceId,
            events: [{ commandId, sequence: 1, type: 'result', result: { outcome: { status: 'SUCCEEDED' }, delivery: { state: 'not_required' } } }] } });
        assert.equal(reply.statusCode, 200, reply.body);
    };
    return { ...setup, node, project, workspace, register, path, put, poll, view, ack, ackResponse, finish, clock, configured: configured.json().auditSchedule,
        moveClock: timestamp => { now = new Date(timestamp); } };
}

test('AC-CENTRAL-SCHEDULE-01：手动任务优先，30 分钟内空闲可派发，重启不重复发起', async t => {
    const fixture = await scheduledProject(t);
    const { app, headers, path, moveClock, poll, ack, finish, view } = fixture;
    assert.equal(fixture.configured.nextRunAt, '2026-11-17T18:00:00.000Z');
    assert.deepEqual(await poll(), []);
    const manual = await app.inject({ method: 'POST', url: `${path}/commands`, headers,
        payload: { idempotencyKey: 'manual-audit', operation: 'audit', payload: { targetPath: '.', note: '' } } });
    assert.equal(manual.statusCode, 202, manual.body);
    moveClock('2026-11-17T18:00:00Z');
    const [manualCommand] = await poll();
    assert.equal(manualCommand.commandId, manual.json().command.commandId);
    assert.equal(manualCommand.scheduledAudit, undefined);
    await ack(manualCommand.commandId);
    moveClock('2026-11-17T18:12:00Z');
    assert.deepEqual((await poll()).map(command => command.commandId), [manualCommand.commandId]);
    assert.equal((await view()).lastRun.state, 'waiting');
    await finish(manualCommand.commandId);
    const [scheduled] = await poll();
    assert.equal(scheduled.operation, 'audit');
    assert.equal(scheduled.payload.targetPath, '.');
    assert.deepEqual(scheduled.scheduledAudit, { scheduledAt: '2026-11-17T18:00:00.000Z', expiresAt: '2026-11-17T18:30:00.000Z' });
    assert.equal(scheduled.actor.userId, 'system-scheduled-audit');
    assert.equal(scheduled.actor.reviewIdentity, '审核者甲');
    assert.equal((await poll())[0].commandId, scheduled.commandId);
    assert.deepEqual(await poll(app, false), [], '旧节点不得领取已经派发的定时指令');
    assert.equal((await ack(scheduled.commandId)).state, 'accepted');
    await finish(scheduled.commandId);
    await app.close();
    const restarted = await fixture.createCentralApp({ dataDir: fixture.dataDir, clock: fixture.clock });
    assert.deepEqual(await poll(restarted), []);
});

test('AC-CENTRAL-SCHEDULE-02：跨午夜按计划日期发起，过期未受理时阻止启动', async t => {
    const { moveClock, poll, ack, view } = await scheduledProject(t, '23:50', '2026-11-18T15:49:00Z');
    moveClock('2026-11-18T16:01:00Z');
    const [scheduled] = await poll();
    assert.deepEqual(scheduled.scheduledAudit, { scheduledAt: '2026-11-18T15:50:00.000Z', expiresAt: '2026-11-18T16:20:00.000Z' });
    moveClock('2026-11-18T16:20:00Z');
    const expired = await ack(scheduled.commandId);
    assert.equal(expired.state, 'completed');
    assert.equal(expired.result.outcome.reason, 'SCHEDULE_WINDOW_EXPIRED');
    assert.deepEqual(await poll(), []);
    const schedule = await view();
    assert.equal(schedule.lastRun.state, 'skipped');
    assert.equal(schedule.nextRunAt, '2026-11-19T15:50:00.000Z');
});

test('AC-CENTRAL-SCHEDULE-02：夏令时缺失的时刻跳过，重复时刻按首次计算', async t => {
    const spring = await scheduledProject(t, '02:15', '2026-03-08T08:00:00Z', 'America/Los_Angeles');
    assert.equal(spring.configured.nextRunAt, '2026-03-09T09:15:00.000Z');
    spring.moveClock('2026-03-08T10:15:00Z');
    assert.deepEqual(await spring.poll(), []);

    const autumn = await scheduledProject(t, '01:15', '2026-11-01T08:00:00Z', 'America/Los_Angeles');
    assert.equal(autumn.configured.nextRunAt, '2026-11-01T08:15:00.000Z');
    autumn.moveClock('2026-11-01T09:15:00Z');
    assert.deepEqual(await autumn.poll(), []);
    assert.equal((await autumn.view()).nextRunAt, '2026-11-02T09:15:00.000Z');
});

test('AC-CENTRAL-SCHEDULE-03：节点错过开始时限后跳过当天，关闭计划保留结果', async t => {
    const { app, moveClock, poll, put, view } = await scheduledProject(t);
    moveClock('2026-11-17T18:00:00Z');
    assert.deepEqual(await poll(app, false), []);
    moveClock('2026-11-17T18:30:00Z');
    assert.deepEqual(await poll(), []);
    const schedule = await view();
    assert.equal(schedule.lastRun.state, 'skipped');
    assert.ok(schedule.lastRun.reason);
    assert.equal(schedule.lastRun.commandId, null);
    assert.equal((await put({ enabled: false, startTime: '02:00', timeZone: 'Asia/Shanghai' })).statusCode, 200);
    assert.deepEqual((await view()).lastRun, schedule.lastRun);
});

test('AC-CENTRAL-SCHEDULE-03：受理后的审查跨过截止时间仍可正常收尾', async t => {
    const { moveClock, poll, ack, finish, view } = await scheduledProject(t);
    moveClock('2026-11-17T18:29:00Z');
    const [command] = await poll();
    assert.equal((await ack(command.commandId)).state, 'accepted');
    moveClock('2026-11-17T18:31:00Z');
    assert.equal((await poll())[0].commandId, command.commandId);
    assert.equal((await view()).lastRun.state, 'accepted');
    await finish(command.commandId);
    assert.equal((await view()).lastRun.state, 'completed');
});

test('停用项目保留到期但从未派发的一轮定时审查', async t => {
    const { app, headers, path, moveClock, view } = await scheduledProject(t);
    moveClock('2026-11-17T18:31:00Z');
    const missed = (await view()).lastRun;
    assert.equal(missed.state, 'skipped');
    const response = await app.inject({ method: 'PUT', url: path, headers, payload: { enabled: false } });
    assert.equal(response.statusCode, 200, response.body);
    const schedule = await view();
    assert.equal(schedule.nextRunAt, null);
    assert.deepEqual(schedule.lastRun, missed);
});

test('没有到期任务时认证读取仍可在 SQLite 写事务期间继续', async t => {
    const { app, headers, path: projectPath, dataDir } = await scheduledProject(t);
    const writer = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
    writer.exec('BEGIN IMMEDIATE');
    try {
        for (const url of ['/api/v1/auth/session', projectPath]) {
            const response = await app.inject({ url, headers });
            assert.equal(response.statusCode, 200, response.body);
        }
    } finally {
        writer.exec('ROLLBACK');
        writer.close();
    }
});

test('AC-CENTRAL-SCHEDULE-03：派发后离线的指令到期释放项目与节点占用', async t => {
    const { app, headers, node, path, moveClock, poll } = await scheduledProject(t);
    moveClock('2026-11-17T18:01:00Z');
    const [command] = await poll();
    moveClock('2026-11-17T18:30:00Z');
    const detail = await app.inject({ url: `/api/v1/commands/${command.commandId}`, headers });
    assert.equal(detail.json().command.state, 'completed');
    const quiesce = await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers,
        payload: { instanceId: node.instanceId } });
    assert.equal(quiesce.statusCode, 200, quiesce.body);
    const disabled = await app.inject({ method: 'PUT', url: path, headers, payload: { enabled: false } });
    assert.equal(disabled.statusCode, 200, disabled.body);
});

test('AC-CENTRAL-SCHEDULE-04：用户指令不能伪造定时信封，关闭后撤回未受理任务', async t => {
    const { app, headers, path, put, moveClock, poll, ack, view } = await scheduledProject(t);
    assert.equal((await put({ enabled: true, startTime: '25:00', timeZone: 'Asia/Shanghai' })).statusCode, 422);
    assert.equal((await put({ enabled: true, startTime: '02:00', timeZone: '+08:00' })).statusCode, 422);
    const forged = await app.inject({ method: 'POST', url: `${path}/commands`, headers,
        payload: { idempotencyKey: 'forged', operation: 'audit', payload: { targetPath: '.' }, scheduledAudit: { scheduledAt: '2026-11-17T18:00:00Z', expiresAt: '2026-11-17T18:30:00Z' } } });
    assert.equal(forged.statusCode, 422);
    moveClock('2026-11-17T18:01:00Z');
    const [command] = await poll();
    assert.equal((await put({ enabled: false, startTime: '02:00', timeZone: 'Asia/Shanghai' })).statusCode, 200);
    assert.equal((await ack(command.commandId)).state, 'completed');
    assert.deepEqual(await poll(), []);
    assert.equal((await view()).nextRunAt, null);
});

test('同节点新入队的手动指令优先于其他项目已派发但未受理的定时审查', async t => {
    const { app, headers, node, workspace, register, moveClock, poll, ack, finish } = await scheduledProject(t);
    const otherWorkspace = 'workspace-b';
    const registration = await register([workspace, { ...workspace, workspaceId: otherWorkspace }]);
    assert.equal(registration.statusCode, 200, registration.body);
    const other = await bindProject(app, headers, { ...node, workspaceId: otherWorkspace }, '项目 B');
    moveClock('2026-11-17T18:00:00Z');
    const [scheduled] = await poll();
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${other.projectId}/commands`, headers,
        payload: { idempotencyKey: 'manual-first', operation: 'sync', payload: {} } });
    assert.equal(created.statusCode, 202, created.body);
    const manualId = created.json().command.commandId;

    assert.equal((await ack(scheduled.commandId)).state, 'dispatched');
    assert.deepEqual((await poll()).map(command => command.commandId), [manualId]);
    assert.equal((await ack(manualId)).state, 'accepted');
    assert.equal((await ack(scheduled.commandId)).state, 'dispatched');
    await finish(manualId);
    assert.deepEqual((await poll()).map(command => command.commandId), [scheduled.commandId]);
    assert.equal((await ack(scheduled.commandId)).state, 'accepted');
});

test('同项目手动指令可替换未受理的定时审查，手动结束后可在原窗口补跑', async t => {
    const { app, headers, node, project, path, clock, moveClock, poll, ack, finish, view } = await scheduledProject(t);
    moveClock('2026-11-17T18:00:00Z');
    const [first] = await poll();
    const snapshot = await app.inject({ method: 'POST', url: '/node-api/v1/snapshots', headers: node.headers,
        payload: { instanceId: node.instanceId, snapshot: { projectId: project.projectId, bindingGeneration: 1, projectConfigRevision: 1,
            collectedAt: clock().toISOString(), snapshotSequence: 1, vcsSnapshot: 'base', queue: [], findings: [], audits: [], errors: [] } } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const projectView = async () => (await app.inject({ url: path, headers })).json();
    const createManual = (idempotencyKey, operation) => app.inject({ method: 'POST', url: `${path}/commands`, headers,
        payload: { idempotencyKey, operation, payload: {} } });

    assert.equal((await projectView()).writable, true);
    assert.equal((await createManual('invalid-op', 'unknown')).statusCode, 422);
    assert.deepEqual((await poll()).map(command => command.commandId), [first.commandId]);
    const created = await createManual('manual-replacement', 'sync');
    assert.equal(created.statusCode, 202, created.body);
    const manualId = created.json().command.commandId;
    const replaced = await ack(first.commandId);
    assert.equal(replaced.state, 'completed');
    assert.equal(replaced.result.delivery.state, 'not_required');
    assert.equal((await view()).lastRun.state, 'waiting');
    assert.deepEqual((await poll()).map(command => command.commandId), [manualId]);
    assert.equal((await ack(manualId)).state, 'accepted');
    await finish(manualId);

    const [retry] = await poll();
    assert.notEqual(retry.commandId, first.commandId);
    assert.deepEqual(retry.scheduledAudit, first.scheduledAudit);
    assert.equal((await ack(retry.commandId)).state, 'accepted');
    assert.equal((await projectView()).writable, false);
    assert.equal((await createManual('manual-late', 'sync')).statusCode, 409);
    await finish(retry.commandId);
    assert.deepEqual(await poll(), []);
});

test('执行配置变更后只有所属节点能确认已经到期的定时指令', async t => {
    const { app, headers, path, workspace, register, moveClock, poll, ackResponse } = await scheduledProject(t);
    const first = await register([{ ...workspace, executionConfigHash: 'a'.repeat(64) }]);
    assert.equal(first.statusCode, 200, first.body);
    moveClock('2026-11-17T18:00:00Z');
    const [scheduled] = await poll();
    assert.equal(scheduled.projectConfigRevision, 1);
    moveClock('2026-11-17T18:30:00Z');
    const changed = await register([{ ...workspace, executionConfigHash: 'b'.repeat(64) }]);
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await app.inject({ url: path, headers })).json().project.projectConfigRevision, 2);

    const other = await registerNode(app, 'node-b');
    assert.equal((await ackResponse(scheduled.commandId, other)).statusCode, 403);
    const receipt = await ackResponse(scheduled.commandId);
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().command.state, 'completed');
    assert.equal(receipt.json().command.result.outcome.reason, 'SCHEDULE_WINDOW_EXPIRED');
});
