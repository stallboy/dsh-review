import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvePayload, bindProject, registerNode, setupCentral } from './central-helpers.mjs';

const password = 'private-local-test-password';
const reviewIdentity = '本机审核者';

async function ownedDirectory(t) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'owned-central-test-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    return dataDir;
}

function ownedProcess(t, input) {
    const child = fork(new URL('../apps/server/dist/owned.js', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
    });
    const message = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('中央没有按时通过 IPC 就绪')); }, 10000);
        child.once('message', value => { clearTimeout(timer); resolve(value); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`中央在 IPC 就绪前退出：${code}`)); });
    });
    child.send(input, () => {});
    return { child, message, exit, output: () => output };
}

async function boundedExit(owned) {
    let timer;
    try {
        return await Promise.race([owned.exit, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('中央退出后仍有进程或事件循环残留')), 7000);
        })]);
    } finally { clearTimeout(timer); }
}

test('中央公开身份在重启后持久且不暴露用户或节点秘密', async t => {
    const { app, dataDir, createCentralApp } = await setupCentral(t);
    const node = await registerNode(app);
    const info = await app.inject('/api/v1/info');
    assert.equal(info.statusCode, 200, info.body);
    const identity = info.json();
    assert.deepEqual(Object.keys(identity).sort(), ['centralId', 'protocolVersion']);
    assert.match(identity.centralId, /^[a-zA-Z0-9-]+$/);
    assert.equal(identity.protocolVersion, 1);
    assert.equal(info.body.includes(node.token), false);
    assert.equal(info.body.includes('a-long-test-password'), false);
    await app.close();
    const restarted = await createCentralApp({ dataDir });
    assert.deepEqual((await restarted.inject('/api/v1/info')).json(), identity);
});

test('节点状态只包含自己的项目和未决数量且与用户鉴权隔离', async t => {
    const { app, headers } = await setupCentral(t);
    const own = await registerNode(app), other = await registerNode(app, 'node-b', 'workspace-b');
    const project = await bindProject(app, headers, own);
    await bindProject(app, headers, other, '他人项目');
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const status = await app.inject({ method: 'POST', url: '/node-api/v1/status', headers: own.headers, payload: {} });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().centralId, (await app.inject('/api/v1/info')).json().centralId);
    assert.equal(status.json().nodeId, own.nodeId);
    assert.equal(status.json().instanceId, own.instanceId);
    assert.deepEqual(status.json().projects.map(item => item.projectId), [project.projectId]);
    assert.equal(status.json().pending, 1);
    assert.equal(status.body.includes(own.token), false);
    const otherStatus = await app.inject({ method: 'POST', url: '/node-api/v1/status', headers: other.headers, payload: { nodeId: own.nodeId } });
    assert.equal(otherStatus.statusCode, 200, otherStatus.body);
    assert.equal(otherStatus.json().nodeId, other.nodeId);
    assert.equal(otherStatus.json().instanceId, other.instanceId);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/status', headers, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/projects', headers: own.headers })).statusCode, 401);
});

test('节点状态的活动实例租约独立于暂停接入并在断开或超时后失效', async t => {
    let now = new Date('2026-11-17T00:00:00.000Z');
    const { app } = await setupCentral(t, { clock: () => now });
    const own = await registerNode(app), other = await registerNode(app, 'node-b', 'workspace-b');
    const status = headers => app.inject({ method: 'POST', url: '/node-api/v1/status', headers, payload: { nodeId: other.nodeId } });
    assert.equal((await status(own.headers)).json().activeInstance, true);
    const paused = await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: own.headers, payload: { instanceId: own.instanceId } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(app.database.getNode(own.nodeId).online, false);
    assert.equal((await status(own.headers)).json().activeInstance, true);
    now = new Date('2026-11-17T00:00:30.000Z');
    assert.equal((await status(own.headers)).json().activeInstance, true);
    now = new Date('2026-11-17T00:00:30.001Z');
    assert.equal((await status(own.headers)).json().activeInstance, false);
    const otherHeartbeat = await app.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: other.headers, payload: { instanceId: other.instanceId } });
    assert.equal(otherHeartbeat.statusCode, 200, otherHeartbeat.body);
    const heartbeat = await app.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: own.headers, payload: { instanceId: own.instanceId } });
    assert.equal(heartbeat.statusCode, 200, heartbeat.body);
    assert.equal((await status(own.headers)).json().activeInstance, true);
    const disconnected = await app.inject({ method: 'POST', url: '/node-api/v1/disconnect', headers: own.headers, payload: { instanceId: own.instanceId } });
    assert.equal(disconnected.statusCode, 200, disconnected.body);
    assert.equal((await status(own.headers)).json().activeInstance, false);
    const otherStatus = await status(other.headers);
    assert.equal(otherStatus.json().nodeId, other.nodeId);
    assert.equal(otherStatus.json().instanceId, other.instanceId);
    assert.equal(otherStatus.json().activeInstance, true);
});

test('节点接入自身声明工作副本幂等创建并保留停用历史', async t => {
    const { app } = await setupCentral(t);
    const node = await registerNode(app);
    const payload = { instanceId: node.instanceId, workspaceId: node.workspaceId, name: '插件项目', enabled: true };
    const ensure = value => app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: node.headers, payload: value });
    const initial = await ensure(payload);
    assert.equal(initial.statusCode, 200, initial.body);
    const project = initial.json().project;
    assert.deepEqual((await ensure(payload)).json().project, project);
    const disabled = await ensure({ ...payload, enabled: false });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().project.projectId, project.projectId);
    assert.equal(disabled.json().project.enabled, false);
    const enabled = await ensure({ ...payload, name: '新名称' });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().project.projectId, project.projectId);
    assert.equal(enabled.json().project.name, '新名称');
    assert.equal(app.database.listProjects(node.nodeId).length, 1);
});

test('移除注册声明后仍能停用自身历史项目但不能启用新建或操作其他节点', async t => {
    const { app, headers } = await setupCentral(t);
    const own = await registerNode(app), other = await registerNode(app, 'node-b', 'workspace-b');
    const project = await bindProject(app, headers, own), otherProject = await bindProject(app, headers, other);
    const registration = {
        protocolVersion: 1, instanceId: own.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux', workspaces: [],
    };
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: own.headers, payload: registration });
    assert.equal(registered.statusCode, 200, registered.body);
    const ensure = payload => app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: own.headers, payload });
    const input = { instanceId: own.instanceId, workspaceId: own.workspaceId, name: project.name, enabled: false };
    assert.equal((await ensure({ ...input, instanceId: other.instanceId })).statusCode, 409);
    const disabled = await ensure(input);
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().project.projectId, project.projectId);
    assert.equal(disabled.json().project.enabled, false);
    const restored = await ensure({ ...input, restore: true });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().project.enabled, false);
    for (const restore of [undefined, true]) {
        for (const payload of [
            { ...input, enabled: true },
            { ...input, workspaceId: 'missing-workspace', enabled: true },
            { ...input, workspaceId: 'missing-workspace' },
            { ...input, workspaceId: other.workspaceId },
        ]) {
            const rejected = await ensure({ ...payload, restore });
            assert.equal(rejected.statusCode, 409, rejected.body);
            assert.equal(rejected.json().error.code, 'workspace_unavailable');
        }
    }
    assert.equal(app.database.listProjects(own.nodeId).length, 1);
    assert.equal(app.database.getProject(project.projectId).enabled, false);
    assert.equal(app.database.getProject(otherProject.projectId).enabled, true);
    const incompatible = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: own.headers, payload: { ...registration, protocolVersion: 2 } });
    assert.equal(incompatible.statusCode, 200, incompatible.body);
    const rejected = await ensure(input);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error.code, 'workspace_unavailable');
});

test('移除注册声明后未决写操作仍阻止停用历史项目', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: {
        protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux', workspaces: [],
    } });
    assert.equal(registered.statusCode, 200, registered.body);
    const disabled = await app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: node.headers, payload: {
        instanceId: node.instanceId, workspaceId: node.workspaceId, name: project.name, enabled: false,
    } });
    assert.equal(disabled.statusCode, 409, disabled.body);
    assert.equal(disabled.json().error.code, 'project_busy');
    assert.equal(app.database.getProject(project.projectId).enabled, true);
    assert.equal(app.database.pendingNodeCommands(node.nodeId), 1);
});

test('恢复接入尊重中央已改名和停用的项目，显式配置仍可修改', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node, '原项目名称');
    const changed = await app.inject({ method: 'PUT', url: `/api/v1/projects/${project.projectId}`, headers, payload: { name: '中央修改的名称', enabled: false } });
    assert.equal(changed.statusCode, 200, changed.body);
    const input = { instanceId: node.instanceId, workspaceId: node.workspaceId, name: '原项目名称', enabled: true };
    const ensure = payload => app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: node.headers, payload });
    const restored = await ensure({ ...input, restore: true });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().project.projectId, project.projectId);
    assert.equal(restored.json().project.name, '中央修改的名称');
    assert.equal(restored.json().project.enabled, false);
    assert.equal(app.database.getProject(project.projectId).name, '中央修改的名称');
    assert.equal(app.database.getProject(project.projectId).enabled, false);
    assert.equal((await ensure({ ...input, restore: 'true' })).statusCode, 422);
    const explicit = await ensure({ ...input, restore: false });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(explicit.json().project.name, '原项目名称');
    assert.equal(explicit.json().project.enabled, true);
    const omitted = await ensure({ ...input, name: '明确修改', enabled: false });
    assert.equal(omitted.statusCode, 200, omitted.body);
    assert.equal(omitted.json().project.name, '明确修改');
    assert.equal(omitted.json().project.enabled, false);
});

test('节点接入拒绝其他节点工作副本、无效实例和未声明路径', async t => {
    const { app, headers } = await setupCentral(t);
    const own = await registerNode(app), other = await registerNode(app, 'node-b', 'workspace-b');
    const otherProject = await bindProject(app, headers, other);
    const ensure = payload => app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: own.headers, payload });
    const input = { instanceId: own.instanceId, workspaceId: own.workspaceId, name: '本机项目', enabled: true };
    assert.equal((await ensure({ ...input, instanceId: other.instanceId })).statusCode, 409);
    assert.equal((await ensure({ ...input, workspaceId: other.workspaceId })).statusCode, 409);
    assert.equal((await ensure({ ...input, workspaceId: '/arbitrary/path' })).statusCode, 422);
    assert.equal((await ensure({ ...input, enabled: false })).statusCode, 409);
    assert.equal((await ensure({ ...input, enabled: false, restore: true })).statusCode, 409);
    assert.equal((await ensure({ ...input, enabled: 'true' })).statusCode, 422);
    assert.equal((await ensure({ ...input, nodeId: other.nodeId })).statusCode, 422);
    assert.equal(app.database.getProject(otherProject.projectId).enabled, true);
    assert.equal(app.database.listProjects(own.nodeId).length, 0);
});

test('未决写操作拒绝项目配置变化但允许幂等接入重试', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const input = { instanceId: node.instanceId, workspaceId: node.workspaceId, name: project.name, enabled: true };
    const ensure = payload => app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: node.headers, payload });
    assert.equal((await ensure(input)).statusCode, 200);
    const restored = await ensure({ ...input, name: '缓存的旧名称', enabled: false, restore: true });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().project.name, project.name);
    assert.equal(restored.json().project.enabled, true);
    for (const payload of [{ ...input, enabled: false }, { ...input, name: '未审核变化' }]) {
        const response = await ensure(payload);
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error.code, 'project_busy');
    }
    assert.equal(app.database.getProject(project.projectId).enabled, true);
    assert.equal(app.database.getProject(project.projectId).name, project.name);
});

test('节点断开只清除自身在线标记且保留中断指令恢复状态', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), other = await registerNode(app, 'node-b', 'workspace-b');
    const project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const commandId = created.json().command.commandId;
    assert.equal((await app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`, headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    const disconnect = payload => app.inject({ method: 'POST', url: '/node-api/v1/disconnect', headers: node.headers, payload });
    assert.equal((await disconnect({ instanceId: other.instanceId })).statusCode, 409);
    assert.equal(app.database.getNode(node.nodeId).online, true);
    const response = await disconnect({ instanceId: node.instanceId });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(app.database.getNode(node.nodeId).online, false);
    assert.equal(app.database.getNode(other.nodeId).online, true);
    assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'recovery_required');
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/status', headers: node.headers, payload: {} })).json().pending, 1);
});

test('节点静默暂停原子阻止新指令，心跳和续注册不能恢复受理，显式激活才能恢复', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    const quiesced = await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.equal(quiesced.statusCode, 200, quiesced.body);
    const create = () => app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal((await create()).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    assert.equal((await create()).statusCode, 503);
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: node.headers, payload: {
        protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' }],
    } });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().node.online, false);
    assert.equal((await create()).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/activate', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    assert.equal((await create()).statusCode, 202);
});

test('节点有未决指令时暂停失败且不改变在线或受理状态', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const paused = await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.equal(paused.statusCode, 409, paused.body);
    assert.equal(app.database.getNode(node.nodeId).online, true);
    const polled = await app.inject({ method: 'POST', url: '/node-api/v1/commands/poll', headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.equal(polled.statusCode, 200, polled.body);
    assert.equal(polled.json().commands[0].commandId, created.json().command.commandId);
});

test('暂停注册保持配置握手隔离，项目接入和心跳后仍须显式激活', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    const registration = {
        protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' }],
    };
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: { ...node.headers, 'x-dsh-review-admission': 'paused' }, payload: registration });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().node.online, false);
    const create = () => app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal((await create()).statusCode, 503);
    const heartbeat = await app.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: node.headers, payload: { instanceId: node.instanceId } });
    assert.equal(heartbeat.statusCode, 200, heartbeat.body);
    assert.equal(heartbeat.json().node.online, false);
    const ensured = await app.inject({ method: 'POST', url: '/node-api/v1/projects/ensure', headers: node.headers, payload: {
        instanceId: node.instanceId, workspaceId: node.workspaceId, name: '配置后项目', enabled: true,
    } });
    assert.equal(ensured.statusCode, 200, ensured.body);
    assert.equal(ensured.json().project.projectId, project.projectId);
    assert.equal((await create()).statusCode, 503);
    const activate = payload => app.inject({ method: 'POST', url: '/node-api/v1/activate', headers: node.headers, payload });
    assert.equal((await activate({ instanceId: 'stale-instance' })).statusCode, 409);
    assert.equal(app.database.getNode(node.nodeId).online, false);
    assert.equal((await activate({ instanceId: node.instanceId })).statusCode, 200);
    assert.equal(app.database.getNode(node.nodeId).online, true);
    assert.equal((await create()).statusCode, 202);
});

test('同实例在途续注册保持已有暂停状态，激活后的暂停请求头也不能重开配置握手', async t => {
    const { app } = await setupCentral(t);
    const node = await registerNode(app);
    const registration = {
        protocolVersion: 1, instanceId: node.instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' }],
    };
    const register = admission => app.inject({ method: 'POST', url: '/node-api/v1/register', headers: { ...node.headers, ...admission }, payload: registration });
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    for (const admission of [{}, { 'x-dsh-review-admission': 'paused' }]) {
        const resumed = await register(admission);
        assert.equal(resumed.statusCode, 200, resumed.body);
        assert.equal(resumed.json().node.online, false);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/activate', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    for (const admission of [{ 'x-dsh-review-admission': 'paused' }, {}]) {
        const resumed = await register(admission);
        assert.equal(resumed.statusCode, 200, resumed.body);
        assert.equal(resumed.json().node.online, true);
    }
});

test('恢复未决任务时允许暂停注册后激活且不清除待恢复指令', async t => {
    const { app, headers } = await setupCentral(t);
    const node = await registerNode(app), project = await bindProject(app, headers, node);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers, payload: approvePayload() });
    assert.equal(created.statusCode, 202, created.body);
    const commandId = created.json().command.commandId;
    assert.equal((await app.inject({ method: 'POST', url: `/node-api/v1/commands/${commandId}/ack`, headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/disconnect', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    const nextInstance = 'restored-instance';
    const registered = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: { ...node.headers, 'x-dsh-review-admission': 'paused' }, payload: {
        protocolVersion: 1, instanceId: nextInstance, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' }],
    } });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().node.online, false);
    const activated = await app.inject({ method: 'POST', url: '/node-api/v1/activate', headers: node.headers, payload: { instanceId: nextInstance } });
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal(app.database.getNode(node.nodeId).online, true);
    assert.equal((await app.inject({ url: `/api/v1/commands/${commandId}`, headers })).json().command.state, 'recovery_required');
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/status', headers: node.headers, payload: {} })).json().pending, 1);
});

test('暂停节点仍保留活动实例租约，明确断开后其他实例才能注册', async t => {
    const { app } = await setupCentral(t);
    const node = await registerNode(app);
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/quiesce', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    const registration = {
        protocolVersion: 1, instanceId: 'competing-instance', pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId: node.workspaceId, label: node.workspaceId, vcsType: 'git', target: 'main' }],
    };
    for (const admission of [{}, { 'x-dsh-review-admission': 'paused' }]) {
        const competing = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: { ...node.headers, ...admission }, payload: registration });
        assert.equal(competing.statusCode, 409, competing.body);
        assert.equal(app.database.getNode(node.nodeId).instanceId, node.instanceId);
        assert.equal(app.database.getNode(node.nodeId).online, false);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/node-api/v1/disconnect', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 200);
    const next = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: { ...node.headers, 'x-dsh-review-admission': 'paused' }, payload: registration });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().node.instanceId, 'competing-instance');
    assert.equal(next.json().node.online, false);
});

test('本机中央经 IPC 零项目启动并在父 IPC 断开后退出', async t => {
    const dataDir = await ownedDirectory(t);
    const owned = ownedProcess(t, { type: 'start', dataDir, password, reviewIdentity });
    const ready = await owned.message;
    assert.equal(ready.type, 'ready');
    assert.match(ready.centerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(typeof ready.token, 'string');
    const info = await fetch(`${ready.centerUrl}/api/v1/info`).then(response => response.json());
    assert.equal(info.centralId, ready.centralId);
    const response = await fetch(`${ready.centerUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'local', password }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.reviewIdentity, reviewIdentity);
    owned.child.disconnect();
    assert.deepEqual(await boundedExit(owned), { code: 0, signal: null });
    assert.equal(owned.output().includes(password), false);
    assert.equal(owned.output().includes(ready.token), false);
    await assert.rejects(fetch(`${ready.centerUrl}/health`));
});

test('本机中央重启核验已有身份和节点，停止消息释放进程', async t => {
    const dataDir = await ownedDirectory(t);
    const first = ownedProcess(t, { type: 'start', dataDir, password, reviewIdentity });
    const original = await first.message;
    assert.equal(original.type, 'ready');
    first.child.send({ type: 'stop' });
    assert.deepEqual(await boundedExit(first), { code: 0, signal: null });
    const second = ownedProcess(t, { type: 'start', dataDir, password, reviewIdentity, node: { nodeId: original.nodeId, token: original.token } });
    const restored = await second.message;
    assert.equal(restored.type, 'ready');
    assert.equal(restored.centralId, original.centralId);
    assert.equal(restored.nodeId, original.nodeId);
    assert.equal(restored.token, original.token);
    second.child.send({ type: 'stop' });
    assert.deepEqual(await boundedExit(second), { code: 0, signal: null });
});

test('本机中央拒绝既有账号、节点身份变化并只通过 IPC 报告脱敏错误', async t => {
    const dataDir = await ownedDirectory(t);
    const first = ownedProcess(t, { type: 'start', dataDir, password, reviewIdentity });
    const ready = await first.message;
    assert.equal(ready.type, 'ready');
    first.child.send({ type: 'stop' });
    await boundedExit(first);
    for (const changed of [{ password: 'incorrect-password-123' }, { reviewIdentity: '另一个审核者' }, { node: { nodeId: ready.nodeId, token: 'incorrect-private-node-token' } }]) {
        const owned = ownedProcess(t, { type: 'start', dataDir, password, reviewIdentity, ...changed });
        const result = await owned.message;
        assert.equal(result.type, 'error');
        assert.equal((await boundedExit(owned)).code, 1);
        const exposed = JSON.stringify(result) + owned.output();
        for (const value of [password, ready.token, 'incorrect-private-node-token']) assert.equal(exposed.includes(value), false);
    }
});
