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
