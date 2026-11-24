import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';

test('停止期间返回的在途轮询不能启动新执行', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-stop-poll-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
    let release, entered, executions = 0;
    const waiting = new Promise(resolve => { entered = resolve; });
    const project = { projectId: 'project-a', nodeId: 'node-a', workspaceId: 'workspace-a', bindingGeneration: 1,
        projectConfigRevision: 1, vcsType: 'git', target: 'main', enabled: true };
    const command = { commandId: 'command-a', requestHash: 'a'.repeat(64), projectId: 'project-a', nodeId: 'node-a',
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: {},
        actor: { userId: 'user-a', reviewIdentity: '审核者' }, createdAt: new Date().toISOString() };
    const node = new ManagedNode({ config: { centerUrl: 'http://127.0.0.1:3081/', nodeId: 'node-a', token: 'test-token',
        workspaces: [{ workspaceId: 'workspace-a', label: '项目', vcsType: 'git', target: 'main' }] }, journal,
        execute: async () => { executions++; return { outcome: { status: 'ABORTED' }, delivery: { state: 'not_required' } }; },
        read: async () => { throw new Error('unused'); },
        fetch: async url => {
            if (new URL(url).pathname.endsWith('/commands/poll')) {
                entered();
                await new Promise(resolve => { release = resolve; });
                return Response.json({ commands: [command], projects: [project], cancellations: [], queries: [], recoveries: [] });
            }
            return Response.json({});
        },
    });
    const tick = node.tick();
    await waiting;
    const stopped = node.stop();
    release();
    await Promise.all([tick, stopped]);
    assert.equal(executions, 0);
    assert.equal(journal.get('command-a'), null);
});

test('首次配置完成后自动重注册不再暂停中央指令受理', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-reconnect-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
    const registrations = [];
    let conflict = false;
    const node = new ManagedNode({ config: { centerUrl: 'http://127.0.0.1:3081/', nodeId: 'node-a', token: 'test-token', pauseAdmission: true, workspaces: [] },
        journal, execute: async () => { throw new Error('unused'); }, read: async () => { throw new Error('unused'); },
        fetch: async (url, init) => {
            if (new URL(url).pathname.endsWith('/register')) registrations.push(init.headers['x-dsh-review-admission']);
            if (new URL(url).pathname.endsWith('/commands/poll')) {
                if (conflict) { conflict = false; return Response.json({ error: { message: '临时实例冲突' } }, { status: 409 }); }
                return Response.json({ commands: [], projects: [], cancellations: [], queries: [], recoveries: [] });
            }
            return Response.json({});
        },
    });
    await node.tick();
    assert.equal(registrations[0], 'paused');
    assert.equal(typeof node.completeConfiguration, 'function', '缺少首次配置完成标记');
    node.completeConfiguration();
    conflict = true;
    await assert.rejects(node.tick(), /临时实例冲突/);
    await node.tick();
    assert.equal(registrations.length, 2);
    assert.equal(registrations[1], undefined);
    await node.stop();
});

test('节点重启上报中断的 DSH 审查，保留定位信息且拒绝重跑', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-audit-restart-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const command = { commandId: 'audit-interrupted', requestHash: 'b'.repeat(64), projectId: 'project-a', nodeId: 'node-a',
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: {},
        actor: { userId: 'user-a', reviewIdentity: '审核者' }, createdAt: new Date().toISOString() };
    journal.accept(command);
    journal.markExecuting(command.commandId);
    journal.checkpoint(command.commandId, { phase: 'job', auditId: 'audit-original', sessionId: 'session-original' });
    const workspace = { workspaceId: 'workspace-a', label: '项目', vcsType: 'git', target: 'main' };
    const project = { projectId: command.projectId, nodeId: command.nodeId, workspaceId: workspace.workspaceId,
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: workspace.vcsType, target: workspace.target, enabled: true };
    const reported = [];
    let executions = 0;
    const node = new ManagedNode({
        config: { centerUrl: 'http://127.0.0.1:3081/', nodeId: 'node-a', token: 'test-token', workspaces: [workspace] },
        journal,
        execute: async () => { executions++; throw new Error('不应重复启动审查'); },
        read: async () => { throw new Error('不应读取项目'); },
        fetch: async (url, init) => {
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/commands/poll')) {
                return Response.json({ commands: [command], projects: [project], cancellations: [], queries: [], recoveries: [] });
            }
            if (pathname.endsWith('/events')) {
                const { events } = JSON.parse(init.body);
                reported.push(...events);
                return Response.json({ acks: Object.fromEntries(events.map(event => [event.commandId, event.sequence])) });
            }
            return Response.json({});
        },
    });
    t.after(async () => { await node.stop(); journal.close(); await rm(directory, { recursive: true, force: true }); });
    await node.tick();
    await node.tick();
    assert.equal(executions, 0);
    assert.equal(journal.hasUnsettled(), true);
    assert.equal(journal.get(command.commandId).phase, 'recovery_required');
    assert.equal(reported.length, 1);
    const [event] = reported;
    assert.equal(event.type, 'recovery_required');
    assert.equal(event.result.outcome.reason, 'NODE_RESTARTED');
    assert.equal(event.result.outcome.auditId, 'audit-original');
    assert.equal(event.result.outcome.sessionId, 'session-original');
});
