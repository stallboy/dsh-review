import assert from 'node:assert/strict';
import test from 'node:test';
import { bindProject, registerNode, setupCentral } from './central-helpers.mjs';

async function scheduledProject(t, startTime = '02:00', initialTime = '2026-11-17T17:59:00Z', timeZone = 'Asia/Shanghai') {
    let now = new Date(initialTime);
    const clock = () => now;
    const setup = await setupCentral(t, { clock });
    const node = await registerNode(setup.app);
    const project = await bindProject(setup.app, setup.headers, node);
    const path = `/api/v1/projects/${project.projectId}`;
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
    const ack = async commandId => (await setup.app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`,
        headers: node.headers, payload: { instanceId: node.instanceId } })).json().command;
    const finish = async commandId => {
        const reply = await setup.app.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers, payload: { instanceId: node.instanceId,
            events: [{ commandId, sequence: 1, type: 'result', result: { outcome: { status: 'SUCCEEDED' }, delivery: { state: 'not_required' } } }] } });
        assert.equal(reply.statusCode, 200, reply.body);
    };
    return { ...setup, node, path, put, poll, view, ack, finish, clock, configured: configured.json().auditSchedule,
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
