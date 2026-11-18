import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture, runCommand } from './helpers.mjs';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { managedSource } from '../packages/dsh-plugin/dist/managed/managed-source.js';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-central-workspaces-'));
    const roots = [];
    const operations = [];
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    t.after(async () => {
        for (const operation of operations) operation.stop();
        journal.close();
        for (const root of roots) await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    return {
        directory,
        async workspace(workspaceId, enabled) {
            const root = await createGitFixture();
            roots.push(root);
            return { workspaceId, label: workspaceId, root, vcsType: 'git', target: runCommand('git', ['branch', '--show-current'], root).stdout.trim(),
                ...(enabled === undefined ? {} : { enabled }), settings: { runner: 'manual', syncBeforeApprove: false } };
        },
        operations(workspaces) {
            const operation = new ManagedOperations({ dataDir: directory, journal, workspaces });
            operations.push(operation);
            return operation;
        },
    };
}

function project(workspace) {
    return { projectId: `project-${workspace.workspaceId}`, name: workspace.label, nodeId: 'node-a', workspaceId: workspace.workspaceId,
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: workspace.vcsType, target: workspace.target, enabled: true };
}

function query(workspace, vcsSnapshot) {
    return { queryId: `query-${workspace.workspaceId}`, projectId: `project-${workspace.workspaceId}`, bindingGeneration: 1,
        vcsSnapshot, kind: 'reviewers', params: {} };
}

test('停用目录缺失仍声明历史工作副本，旧配置项目继续立即初始化', async t => {
    const state = await fixture(t);
    const active = await state.workspace('workspace-b');
    const inactive = { ...active, workspaceId: 'workspace-a', label: '历史项目 A', root: path.join(state.directory, 'missing'), enabled: false };
    const original = ReviewApi.prototype.init;
    let initialized = 0;
    t.mock.method(ReviewApi.prototype, 'init', async function () { initialized++; await original.call(this); });
    const operations = state.operations([inactive, active]);
    await operations.init();
    assert.equal(initialized, 1);
    assert.deepEqual(operations.registrations(), [inactive, active].map(({ workspaceId, label, vcsType, target }) => ({
        workspaceId, label, vcsType, target,
        executionConfigHash: 'e83155e251ecaf2b9c7eb8b7202a3df891091cdb32d38be46e4c266ff8e0383d',
    })));
    assert.deepEqual((await operations.snapshot(project(active))).queue, []);
    await assert.rejects(operations.snapshot({ ...project(active), workspaceId: 'unconfigured', root: active.root }), /项目与节点工作副本不匹配/);
});

test('停用目录恢复后中央可直接重新启用并读取快照与详情', async t => {
    const state = await fixture(t);
    const inactive = await state.workspace('workspace-a', false);
    const hidden = path.join(state.directory, 'hidden');
    await rename(inactive.root, hidden);
    const operations = state.operations([inactive]);
    await operations.init();
    await assert.rejects(operations.snapshot(project(inactive)), /ENOENT/);
    await rename(hidden, inactive.root);
    const snapshot = await operations.snapshot(project(inactive));
    assert.deepEqual(snapshot.queue, []);
    const detail = await operations.read(query(inactive, snapshot.vcsSnapshot), project(inactive));
    assert.equal(detail.status, 'ready');
    assert.ok(detail.data);
});

test('同一停用工作副本并发首次读取只初始化一个真实 ReviewApi', async t => {
    const state = await fixture(t);
    const inactive = await state.workspace('workspace-a', false);
    const original = ReviewApi.prototype.init;
    let initialized = 0;
    t.mock.method(ReviewApi.prototype, 'init', async function () { initialized++; await original.call(this); });
    const operations = state.operations([inactive]);
    await operations.init();
    assert.equal(initialized, 0);
    const source = await managedSource(inactive.root, 'git');
    const [first, second, detail] = await Promise.all([
        operations.snapshot(project(inactive)), operations.snapshot(project(inactive)), operations.read(query(inactive, source.identity), project(inactive)),
    ]);
    assert.equal(initialized, 1);
    assert.equal(first.vcsSnapshot, second.vcsSnapshot);
    assert.equal(detail.status, 'ready');
});

test('懒初始化仍拒绝本地目标与实际分支不符', async t => {
    const state = await fixture(t);
    const inactive = { ...await state.workspace('workspace-a', false), target: 'unavailable-branch' };
    const operations = state.operations([inactive]);
    await operations.init();
    await assert.rejects(operations.snapshot(project(inactive)), /目标分支不匹配/);
});

test('懒初始化仍拒绝同一真实工作副本的目录别名', async t => {
    const state = await fixture(t);
    const active = await state.workspace('workspace-b');
    const alias = path.join(state.directory, 'alias');
    await symlink(active.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const inactive = { ...active, workspaceId: 'workspace-a', root: alias, enabled: false };
    const operations = state.operations([inactive, active]);
    await operations.init();
    await assert.rejects(operations.snapshot(project(inactive)), /多个 workspace 不能共享同一工作副本/);
    assert.deepEqual((await operations.snapshot(project(active))).queue, []);
});

test('两个停用声明并发恢复不能绕过真实工作副本隔离', async t => {
    const state = await fixture(t);
    const first = await state.workspace('workspace-a', false);
    const second = { ...first, workspaceId: 'workspace-b' };
    const operations = state.operations([first, second]);
    await operations.init();
    const results = await Promise.allSettled([operations.snapshot(project(first)), operations.snapshot(project(second))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /多个 workspace 不能共享同一工作副本/);
});

test('懒初始化仍拒绝持久 workspaceId 改绑另一真实工作副本', async t => {
    const state = await fixture(t);
    const original = await state.workspace('workspace-a');
    const first = state.operations([original]);
    await first.init();
    first.stop();
    const changed = await state.workspace('workspace-a', false);
    const second = state.operations([changed]);
    await second.init();
    await assert.rejects(second.snapshot(project(changed)), /同一 workspaceId 不能指向不同工作副本或目标/);
});
