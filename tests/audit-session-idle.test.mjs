import assert from 'node:assert/strict';
import test from 'node:test';
import { withDshAuditSessionIdle } from '../packages/dsh-plugin/dist/host/audit-session-idle.js';

const requestId = 'audit-prompt';
const userEvent = { type: 'user/message', data: { source: { rpcId: requestId } } };
const turnEnd = kind => ({ type: 'turn/end', data: { reason: { kind } } });

function fixture() {
    const events = [userEvent, turnEnd('completed')];
    let goal;
    let maintenance = false;
    let queuedAfterMaintenance = false;
    const agent = {
        status: 'idle',
        inbox: { nextTurn: [], nextStep: [] },
        session: { get seq() { return events.length; }, snapshotEvents: () => events },
        async runMaintenance(task) {
            assert.equal(maintenance, false);
            maintenance = true;
            try { return await task(new AbortController().signal); }
            finally {
                maintenance = false;
                if (agent.inbox.nextTurn.length) queuedAfterMaintenance = true;
            }
        },
    };
    const getState = () => ({
        cursor: agent.session.seq - 1, active: true, running: agent.status !== 'idle',
        queue: [...agent.inbox.nextTurn, ...agent.inbox.nextStep], pendingInput: [],
    });
    const controller = {
        wait: async () => ({ reason: 'idle', state: getState() }),
        state: async () => getState(),
    };
    const services = { sessionController: controller, agents: { get: () => agent }, goals: { get: () => goal } };
    return {
        agent, controller, events, services, getState, setGoal: value => { goal = value; },
        get maintenance() { return maintenance; },
        get queuedAfterMaintenance() { return queuedAfterMaintenance; },
        run: (finalize, signal = AbortSignal.timeout(7000)) =>
            withDshAuditSessionIdle({ get: name => services[name] }, 'audit-session', requestId, signal, finalize),
    };
}

test('单轮审查确认结束后进入维护窗口，新输入在收尾期间保持排队', async () => {
    const f = fixture();
    let calls = 0;
    assert.equal(await f.run(async () => {
        calls += 1;
        assert.equal(f.maintenance, true);
        f.agent.inbox.nextTurn.push({ id: 'follow-up' });
        await Promise.resolve();
        assert.equal(f.queuedAfterMaintenance, false);
    }), true);
    assert.equal(f.queuedAfterMaintenance, true);
    assert.equal(calls, 1);
});

test('排队续轮、待确认输入和尚未入队的 goal 续轮都阻止自动收尾', async () => {
    const f = fixture();
    let samples = 0;
    f.controller.wait = async () => {
        samples += 1;
        switch (samples) {
            case 1:
                f.agent.inbox.nextTurn.push({ id: 'follow-up' });
                break;
            case 2:
                f.agent.inbox.nextTurn.length = 0;
                return { reason: 'input-required', state: { ...f.getState(), pendingInput: ['approval'] } };
            case 3:
                f.setGoal({ phase: 'active' });
                break;
            case 4:
                f.events.push({ type: 'turn/start' }, { type: 'user/message', data: { source: {} } }, turnEnd('completed'));
                f.setGoal({ phase: 'complete' });
                break;
        }
        return { reason: 'idle', state: f.getState() };
    };
    assert.equal(await f.run(async () => { assert.equal(samples, 4); }), true);
});

test('进入维护窗口后检查新快照和原始请求身份，未确认状态保持手动入口', async () => {
    const f = fixture();
    f.controller.state = async () => ({ ...f.getState(), pendingInput: ['question'] });
    await assert.rejects(f.run(async () => assert.fail('已进入待确认状态'), AbortSignal.timeout(120)), { name: 'AbortError' });
    f.controller.state = async () => f.getState();
    f.events[0] = { type: 'user/message', data: { source: { rpcId: 'different' } } };
    await assert.rejects(f.run(async () => assert.fail('请求身份不匹配'), AbortSignal.timeout(120)), { name: 'AbortError' });
    f.events[0] = userEvent;
    f.events[1] = turnEnd('aborted');
    await assert.rejects(f.run(async () => assert.fail('审查已取消'), AbortSignal.timeout(120)), { name: 'AbortError' });
    delete f.services.goals;
    assert.equal(await f.run(async () => assert.fail('宿主能力缺失')), false);
});
