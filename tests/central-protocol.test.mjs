import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const entry = new URL('../packages/protocol/dist/index.js', import.meta.url);

async function protocol() {
    assert.equal(existsSync(entry), true, '中央协议模块必须先实现并构建');
    return import(entry.href);
}

function command() {
    return {
        commandId: 'cmd-1', requestHash: 'a'.repeat(64), projectId: 'project-a', nodeId: 'node-a',
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'approve',
        actor: { userId: 'user-a', reviewIdentity: '审核者甲' },
        payload: { id: '2026-11/fix-retry', confirmedDecisions: ['cancel'], waivedDecisions: [] },
        guard: { expectedRevision: 2, expectedOwner: '审核者甲', expectedUpdatedAt: '2026-11-16T06:00:00.000Z' },
        createdAt: '2026-11-16T06:10:00.000Z',
    };
}

test('中央协议保留受信身份、绑定、配置和批准 guard', async () => {
    const { validateCommand, PROTOCOL_VERSION } = await protocol();
    assert.equal(PROTOCOL_VERSION, 1);
    assert.deepEqual(validateCommand(command()), command());
});

test('批准缺少 guard 或非正版本号时拒绝', async () => {
    const { validateCommand } = await protocol();
    const missing = command();
    delete missing.guard;
    assert.throws(() => validateCommand(missing), /guard/);
    assert.throws(() => validateCommand({ ...command(), guard: { ...command().guard, expectedRevision: 0 } }), /expectedRevision/);
});

test('中央协议拒绝未知操作和路径注入式实体编号', async () => {
    const { validateCommand } = await protocol();
    assert.throws(() => validateCommand({ ...command(), operation: 'shell' }), /operation/);
    assert.throws(() => validateCommand({ ...command(), projectId: '../other' }), /projectId/);
    assert.throws(() => validateCommand({ ...command(), bindingGeneration: Number.NaN }), /bindingGeneration/);
    assert.throws(() => validateCommand({ ...command(), payload: { id: '2026-11/fix-retry', owner: 'forged' } }), /payload.owner/);
    assert.throws(() => validateCommand({ ...command(), operation: 'dismiss-finding', payload: { auditId: '../secret', findingId: 'f1', reason: 'test' } }), /auditId/);
    assert.doesNotThrow(() => validateCommand({ ...command(), operation: 'comments', payload: { id: '2026-11/fix-retry', file: '', line: 0, revision: 1, content: '总体意见' } }));
    assert.throws(() => validateCommand({ ...command(), operation: 'comments', payload: { id: '2026-11/fix-retry', file: 'src/main.ts', line: 0, revision: 1, content: '行内意见' } }), /payload.line/);
});

test('快照要求正序号与完整独立的项目版本', async () => {
    const { validateSnapshot } = await protocol();
    const snapshot = {
        projectId: 'project-a', bindingGeneration: 1, projectConfigRevision: 1, snapshotSequence: 3,
        vcsSnapshot: 'commit-a', collectedAt: '2026-11-16T06:00:00.000Z',
        queue: [], findings: [], audits: [], errors: [],
    };
    assert.deepEqual(validateSnapshot(snapshot), snapshot);
    assert.throws(() => validateSnapshot({ ...snapshot, snapshotSequence: -1 }), /snapshotSequence/);
    assert.throws(() => validateSnapshot({ ...snapshot, queue: {} }), /queue/);
});
