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
    const poll = async (app = setup.app, capable = true, supportsNotes = true) => {
        const reply = await app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers,
            payload: { instanceId: node.instanceId, ...(capable ? { scheduledAuditWorkspaces: [node.workspaceId], ...(supportsNotes ? { supportsScheduledAuditNotes: true } : {}) } : {}) } });
        assert.equal(reply.statusCode, 200, reply.body);
        return reply.json().commands;
    };
    const view = async () => (await setup.app.inject({ url: path, headers: setup.headers })).json().auditSchedule;
    const ackResponse = (commandId, caller = node, supportsNotes = false) => setup.app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`,
        headers: caller.headers, payload: { instanceId: caller.instanceId, ...(supportsNotes ? { supportsScheduledAuditNotes: true } : {}) } });
    const ack = async commandId => (await ackResponse(commandId)).json().command;
    const finish = async commandId => {
        const reply = await setup.app.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers, payload: { instanceId: node.instanceId,
            events: [{ commandId, sequence: 1, type: 'result', result: { outcome: { status: 'SUCCEEDED' }, delivery: { state: 'not_required' } } }] } });
        assert.equal(reply.statusCode, 200, reply.body);
    };
    return { ...setup, node, project, workspace, register, path, put, poll, view, ack, ackResponse, finish, clock, configured: configured.json().auditSchedule,
        moveClock: timestamp => { now = new Date(timestamp); } };
}

test('AC-CENTRAL-SCHEDULE-05：周计划可在同日分别派发，编辑另一条计划不撤回已派发任务', async t => {
    const { app, headers, path, poll, moveClock, ack, finish } = await scheduledProject(t);
    const url = `${path}/audit-plans`;
    const settings = { name: '周三权限审查', enabled: true, startTime: '02:01', timeZone: 'Asia/Shanghai',
        recurrence: { kind: 'weekly', weekdays: [7, 3] }, note: '重点检查权限回归' };
    const created = await app.inject({ method: 'POST', url, headers, payload: settings });
    assert.equal(created.statusCode, 201, created.body);
    const { planId, version, recurrence, nextRunAt } = created.json().auditPlan;
    assert.deepEqual(recurrence.weekdays, [3, 7]);
    assert.equal(nextRunAt, '2026-11-17T18:01:00.000Z');

    moveClock('2026-11-17T18:00:00Z');
    const [daily] = await poll();
    assert.equal(daily.payload.note, '');
    const updated = await app.inject({ method: 'PUT', url: `${url}/${planId}`, headers,
        payload: { ...settings, note: '重点检查角色权限变更', expectedVersion: version } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((await poll())[0].commandId, daily.commandId);
    assert.equal((await ack(daily.commandId)).state, 'accepted');
    await finish(daily.commandId);

    moveClock('2026-11-17T18:01:00Z');
    assert.deepEqual(await poll(app, true, false), [], '旧节点不得执行带补充要求的计划');
    const [weekly] = await poll();
    assert.notEqual(weekly.commandId, daily.commandId);
    assert.equal(weekly.payload.note, '重点检查角色权限变更');
    const plans = (await app.inject({ url: path, headers })).json().auditPlans;
    assert.equal(plans.find(plan => plan.planId === planId).lastRun.commandId, weekly.commandId);
    assert.equal(plans.find(plan => plan.planId === planId).nextRunAt, '2026-11-21T18:01:00.000Z');
    assert.equal(plans.find(plan => plan.planId !== planId).lastRun.commandId, daily.commandId);

    const deletion = await app.inject({ method: 'DELETE', url: `${url}/${planId}`, headers });
    assert.equal(deletion.statusCode, 200, deletion.body);
    assert.equal((await ack(weekly.commandId)).result.outcome.reason, 'SCHEDULE_CHANGED');
    assert.deepEqual(await poll(), []);
    assert.equal((await app.inject({ url: path, headers })).json().auditPlans.length, 1);
});

test('AC-CENTRAL-SCHEDULE-05：周末和自然日间隔跨月，未来起始日和非法日期有明确结果', async t => {
    const { app, headers, path, moveClock, poll } = await scheduledProject(t, '00:01', '2026-11-29T15:58:00Z');
    const url = `${path}/audit-plans`;
    const settings = { name: '定时复查', enabled: true, startTime: '00:02', timeZone: 'Asia/Shanghai', note: '' };
    const add = recurrence => app.inject({ method: 'POST', url, headers, payload: { ...settings, recurrence } });
    assert.equal((await add({ kind: 'weekly', weekdays: [6, 7] })).json().auditPlan.nextRunAt, '2026-12-04T16:02:00.000Z');
    assert.equal((await add({ kind: 'interval', days: 3, startDate: '2026-11-28' })).json().auditPlan.nextRunAt, '2026-11-30T16:02:00.000Z');
    assert.equal((await add({ kind: 'interval', days: 60, startDate: '2027-04-01' })).json().auditPlan.nextRunAt, '2027-03-31T16:02:00.000Z');
    assert.equal((await add({ kind: 'interval', days: 3, startDate: '2026-02-30' })).statusCode, 422);
    assert.equal((await add({ kind: 'weekly', weekdays: [] })).statusCode, 422);
    moveClock('2026-11-29T16:02:00Z');
    const [daily] = await poll();
    assert.equal(daily.scheduledAudit.scheduledAt, '2026-11-29T16:01:00.000Z');
});

test('旧每日计划数据库迁移保留原计划和已派发轮次的幂等记录', async t => {
    const { app, dataDir, headers, path, poll, moveClock, clock, createCentralApp } = await scheduledProject(t);
    moveClock('2026-11-17T18:00:00Z');
    const [command] = await poll();
    app.database.sql.exec(`CREATE TABLE IF NOT EXISTS audit_schedules (project_id TEXT PRIMARY KEY REFERENCES projects,
        enabled INTEGER NOT NULL, start_time TEXT NOT NULL, time_zone TEXT NOT NULL, effective_at TEXT NOT NULL,
        review_identity TEXT NOT NULL, last_missed_at TEXT);
        INSERT OR IGNORE INTO audit_schedules SELECT project_id,enabled,start_time,time_zone,effective_at,
            review_identity,last_missed_at FROM audit_plans; DROP TABLE audit_plans;`);
    await app.close();
    const restarted = await createCentralApp({ dataDir, clock });
    const view = (await restarted.inject({ url: path, headers })).json();
    assert.equal(view.auditPlans.length, 1);
    assert.deepEqual(view.auditPlans[0].recurrence, { kind: 'daily' });
    assert.equal(view.auditSchedule.lastRun.commandId, command.commandId);
    assert.equal((await poll(restarted))[0].commandId, command.commandId);
    assert.equal(restarted.database.sql.prepare('SELECT COUNT(*) AS count FROM commands').get().count, 1);
});

const dailyPlan = { name: '全仓复查', enabled: true, startTime: '02:00', timeZone: 'Asia/Shanghai', recurrence: { kind: 'daily' }, note: '' };

for (const phase of ['dispatched', 'accepted']) {
    test(`AC-CENTRAL-SCHEDULE-06：双端回退隔离 ${phase} 的定时要求，升级后保留原任务`, async t => {
        const { app, headers, path: url, dataDir, clock, createCentralApp, node, put, moveClock, poll, ackResponse } = await scheduledProject(t);
        await put({ enabled: false, startTime: '02:00', timeZone: 'Asia/Shanghai' });
        const created = await app.inject({ method: 'POST', url: `${url}/audit-plans`, headers, payload: { ...dailyPlan, note: '核对权限边界' } });
        assert.equal(created.statusCode, 201, created.body);
        moveClock('2026-11-17T18:00:00Z');
        const [original] = await poll();
        assert.equal(original.payload.note, '核对权限边界');
        if (phase === 'accepted') {
            assert.equal((await ackResponse(original.commandId, node, true)).json().command.state, 'accepted');
        }
        await app.close();

        const previous = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
        try {
            const legacyPoll = previous.prepare("SELECT command_id FROM commands WHERE node_id=? AND state IN ('queued','dispatched','accepted')").all(node.nodeId);
            assert.deepEqual(legacyPoll, []);
            previous.prepare("UPDATE commands SET state='accepted' WHERE command_id=? AND state IN ('queued','dispatched')").run(original.commandId);
            const replay = previous.prepare('SELECT state FROM commands WHERE command_id=?').get(original.commandId);
            assert.equal(replay.state, phase === 'accepted' ? 'recovery_required' : 'completed');
        } finally { previous.close(); }

        const restarted = await createCentralApp({ dataDir, clock });
        const [resumed] = await poll(restarted);
        assert.equal(resumed.commandId, original.commandId);
        assert.equal(resumed.payload.note, original.payload.note);
        assert.equal(resumed.state, phase);
        const accepted = await restarted.inject({ method: 'POST', url: `/node-api/v1/commands/${original.commandId}/ack`,
            headers: node.headers, payload: { instanceId: node.instanceId, supportsScheduledAuditNotes: true } });
        assert.equal(accepted.json().command.state, 'accepted');
        const result = { outcome: { status: 'SUCCEEDED' }, delivery: { state: 'not_required' } };
        const receipt = await restarted.inject({ method: 'POST', url: '/node-api/v1/events', headers: node.headers,
            payload: { instanceId: node.instanceId, events: [{ commandId: original.commandId, sequence: 1, type: 'result', result }] } });
        assert.equal(receipt.statusCode, 200, receipt.body);
        const legacyFinal = restarted.database.sql.prepare('SELECT state,result FROM commands WHERE command_id=?').get(original.commandId);
        assert.equal(legacyFinal.state, 'completed');
        assert.deepEqual(JSON.parse(legacyFinal.result), result);
    });
}

test('AC-CENTRAL-SCHEDULE-06：双端回退期间可手动写入，重新升级不会重新竞争同项目', async t => {
    const { app, headers, project, path: url, dataDir, clock, createCentralApp, node, moveClock, poll } = await scheduledProject(t);
    const created = await app.inject({ method: 'POST', url: `${url}/audit-plans`, headers,
        payload: { ...dailyPlan, startTime: '01:59', note: '核对权限边界' } });
    assert.equal(created.statusCode, 201, created.body);
    const [focus] = await poll();
    assert.equal(focus.payload.note, '核对权限边界');
    await app.close();
    const previous = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
    try {
        const manual = { ...focus, commandId: 'legacy-manual', operation: 'sync', payload: {} };
        delete manual.scheduledAudit;
        assert.doesNotThrow(() => previous.prepare(`INSERT INTO commands
            (command_id,project_id,node_id,idempotency_key,request_hash,envelope,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)`)
            .run(manual.commandId, project.projectId, node.nodeId, 'legacy-key', manual.requestHash, JSON.stringify(manual), focus.createdAt, focus.updatedAt));
    } finally { previous.close(); }
    moveClock('2026-11-17T18:00:00Z');
    const restarted = await createCentralApp({ dataDir, clock });
    const [manual] = await poll(restarted);
    assert.equal(manual.commandId, 'legacy-manual');
    const focused = (await restarted.inject({ url: `/api/v1/commands/${focus.commandId}`, headers })).json().command;
    assert.equal(focused.state, 'completed');
    assert.equal(focused.result.outcome.reason, 'SCHEDULE_ROLLBACK_CONFLICT');
});

test('AC-CENTRAL-SCHEDULE-06：升级隔离已有在途任务，并保留回退期间收到的正常收尾', async t => {
    const { app, headers, path: url, dataDir, clock, createCentralApp, moveClock, poll, ackResponse, node } = await scheduledProject(t);
    const created = await app.inject({ method: 'POST', url: `${url}/audit-plans`, headers,
        payload: { ...dailyPlan, startTime: '01:59', note: '核对既有任务' } });
    assert.equal(created.statusCode, 201, created.body);
    const [focus] = await poll();
    assert.equal(focus.payload.note, '核对既有任务');
    assert.equal((await ackResponse(focus.commandId, node, true)).json().command.state, 'accepted');
    await app.close();
    const writePrevious = action => {
        const previous = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
        try { action(previous); } finally { previous.close(); }
    };
    writePrevious(previous => {
        previous.exec('ALTER TABLE commands DROP COLUMN active_state; ALTER TABLE commands DROP COLUMN protected_state');
        previous.prepare("UPDATE commands SET state='accepted' WHERE command_id=?").run(focus.commandId);
    });
    const migrated = await createCentralApp({ dataDir, clock });
    assert.equal((await poll(migrated))[0].state, 'accepted');
    await migrated.close();
    const result = { outcome: { status: 'SUCCEEDED' }, delivery: { state: 'not_required' } };
    writePrevious(previous => {
        assert.equal(previous.prepare('SELECT state FROM commands WHERE command_id=?').get(focus.commandId).state, 'recovery_required');
        previous.prepare("UPDATE commands SET state='completed',result=? WHERE command_id=?").run(JSON.stringify(result), focus.commandId);
    });
    moveClock('2026-11-17T18:01:00Z');
    const restarted = await createCentralApp({ dataDir, clock });
    const detail = (await restarted.inject({ url: `/api/v1/commands/${focus.commandId}`, headers })).json().command;
    assert.equal(detail.state, 'completed');
    assert.deepEqual(detail.result, result);
    assert.equal((await poll(restarted)).some(command => command.commandId === focus.commandId), false);
});

test('AC-CENTRAL-SCHEDULE-06：回退期间修改每日配置，重新升级不会派发旧窗口的补充要求', async t => {
    const { app, headers, path: url, dataDir, clock, createCentralApp, moveClock, poll } = await scheduledProject(t);
    const { version } = (await app.inject({ url, headers })).json().auditPlans[0];
    const updated = await app.inject({ method: 'PUT', url: `${url}/audit-plans/legacy`, headers,
        payload: { ...dailyPlan, note: '核对旧窗口', expectedVersion: version } });
    assert.equal(updated.statusCode, 200, updated.body);
    moveClock('2026-11-17T18:00:00Z');
    const [focus] = await poll();
    assert.equal(focus.payload.note, '核对旧窗口');
    await app.close();
    const previous = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
    try {
        previous.prepare("UPDATE audit_schedules SET start_time='03:00'").run();
    } finally { previous.close(); }
    const restarted = await createCentralApp({ dataDir, clock });
    assert.deepEqual(await poll(restarted), []);
    const plan = (await restarted.inject({ url, headers })).json().auditPlans[0];
    assert.equal(plan.startTime, '03:00');
    assert.equal(plan.lastRun.commandId, focus.commandId);
    assert.equal(plan.lastRun.state, 'skipped');
});

test('定时审查兼容计划可经旧中央读取和修改，重新升级保留其他计划', async t => {
    const { app, dataDir, project, headers, path: url, clock, createCentralApp } = await scheduledProject(t);
    const created = await app.inject({ method: 'POST', url: `${url}/audit-plans`, headers,
        payload: { ...dailyPlan, name: '额外周计划', recurrence: { kind: 'weekly', weekdays: [3] } } });
    assert.equal(created.statusCode, 201, created.body);
    await app.close();
    const old = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
    try {
        const legacy = old.prepare('SELECT start_time,enabled FROM audit_schedules WHERE project_id=?').get(project.projectId);
        assert.equal(legacy.start_time, '02:00');
        assert.equal(legacy.enabled, 1);
        old.prepare('UPDATE audit_schedules SET start_time=?, effective_at=? WHERE project_id=?')
            .run('05:30', '2026-11-17T17:59:30.000Z', project.projectId);
    } finally { old.close(); }
    const restarted = await createCentralApp({ dataDir, clock });
    const detail = (await restarted.inject({ url, headers })).json();
    assert.equal(detail.auditSchedule.startTime, '05:30');
    assert.equal(detail.auditPlans.length, 2);
    assert.equal(detail.auditPlans.find(plan => plan.planId === created.json().auditPlan.planId).name, '额外周计划');
});

test('未声明能力的节点重放受理不能执行带要求的任务，也不会阻塞同窗普通计划', async t => {
    const { app, headers, path, moveClock, poll, ackResponse, put, node } = await scheduledProject(t);
    await put({ enabled: false, startTime: '02:00', timeZone: 'Asia/Shanghai' });
    const url = `${path}/audit-plans`;
    for (const note of ['核对权限要求', '']) {
        assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...dailyPlan, note } })).statusCode, 201);
    }
    moveClock('2026-11-17T18:00:00Z');
    const [focused] = await poll();
    assert.equal(focused.payload.note, '核对权限要求');
    const unsupported = await ackResponse(focused.commandId);
    assert.equal(unsupported.json().command?.state, 'completed', unsupported.body);
    assert.equal(unsupported.json().command.result.outcome.reason, 'SCHEDULE_NOTES_UNSUPPORTED');
    const [plain] = await poll(app, true, false);
    assert.equal(plain.payload.note, '');
    assert.equal((await ackResponse(plain.commandId, node)).json().command.state, 'accepted');
});

test('新建计划响应丢失后可使用同一键重试，独立创建仍可使用相同配置', async t => {
    const { app, headers, path, clock, dataDir, createCentralApp } = await scheduledProject(t);
    const url = `${path}/audit-plans`;
    const create = (server, key, payload = dailyPlan) => server.inject({ method: 'POST', url,
        headers: { ...headers, 'idempotency-key': key }, payload });
    const first = await create(app, 'save-intent');
    assert.equal(first.statusCode, 201, first.body);
    await app.close();
    const restarted = await createCentralApp({ dataDir, clock });
    const replay = await create(restarted, 'save-intent');
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().auditPlan.planId, first.json().auditPlan.planId);
    assert.equal((await create(restarted, 'save-intent', { ...dailyPlan, note: '其他配置' })).statusCode, 409);
    const independent = await create(restarted, 'another-intent');
    assert.equal(independent.statusCode, 201, independent.body);
    assert.notEqual(independent.json().auditPlan.planId, first.json().auditPlan.planId);
});

test('启停只变更启用状态，基于旧版本的全量编辑被拒绝', async t => {
    const { app, headers, path } = await scheduledProject(t);
    const base = `${path}/audit-plans`;
    const created = (await app.inject({ method: 'POST', url: base, headers, payload: dailyPlan })).json().auditPlan;
    const url = `${base}/${created.planId}`;
    const updated = await app.inject({ method: 'PUT', url, headers,
        payload: { ...dailyPlan, startTime: '03:00', note: '新要求', expectedVersion: created.version } });
    assert.equal(updated.statusCode, 200, updated.body);
    const paused = await app.inject({ method: 'PATCH', url, headers, payload: { enabled: false } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().auditPlan.startTime, '03:00');
    assert.equal(paused.json().auditPlan.note, '新要求');
    assert.equal(paused.json().auditPlan.enabled, false);
    const stale = await app.inject({ method: 'PUT', url, headers, payload: { ...dailyPlan, expectedVersion: created.version } });
    assert.equal(stale.statusCode, 409, stale.body);
});

test('四位年份最大日期可保存和计算下次计划', async t => {
    const { app, headers, path } = await scheduledProject(t);
    const response = await app.inject({ method: 'POST', url: `${path}/audit-plans`, headers, payload: {
        ...dailyPlan, timeZone: 'America/Los_Angeles', startTime: '23:30',
        recurrence: { kind: 'interval', days: 3, startDate: '9999-12-31' },
    } });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().auditPlan.nextRunAt, '+010000-01-01T07:30:00.000Z');
});

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
