import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture } from './helpers.mjs';
import { setupCentral } from './central-helpers.mjs';

const entry = new URL('../packages/dsh-plugin/dist/connection/controller.js', import.meta.url);

async function controller(t, options = {}) {
    assert.equal(existsSync(entry), true, '插件中央连接控制器尚未实现');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-connection-'));
    const { ConnectionController } = await import(entry);
    const value = new ConnectionController({ directory, candidates: async () => [],
        localEntry: new URL('../apps/server/dist/owned.js', import.meta.url), ...options });
    t.after(async () => { await value.stop(); await rm(directory, { recursive: true, force: true }); });
    await value.init();
    return { value, directory, ConnectionController };
}

test('读取和编辑前的状态不启动中央，显式启用支持零项目并停止自身进程', async t => {
    const { value, directory } = await controller(t);
    assert.equal((await value.status()).phase, 'stopped');
    assert.equal((await value.status()).configured, false);
    await value.apply({ mode: 'local', reviewIdentity: '本机审核者' });
    const status = await value.status();
    assert.equal(status.phase, 'ready');
    assert.equal(status.nodeOnline, true);
    assert.equal(status.projects.length, 0);
    assert.ok(status.centralId);
    assert.ok(status.centerUrl.startsWith('http://127.0.0.1:'));
    const info = await fetch(new URL('api/v1/info', status.centerUrl));
    assert.equal(info.status, 200);
    const settings = await readFile(path.join(directory, 'connection.json'), 'utf8');
    assert.equal(/"token"|"password"/.test(settings), false);
    assert.equal(/"token"|"password"/.test(JSON.stringify(status)), false);
    await value.stop();
    await assert.rejects(fetch(new URL('api/v1/info', status.centerUrl)));
});

test('已启用配置随插件恢复，手动停用持久保存且不会恢复', async t => {
    const { value, directory, ConnectionController } = await controller(t);
    await value.apply({ mode: 'local', reviewIdentity: '恢复审核者' });
    const previous = await value.status();
    await value.stop();
    const restored = new ConnectionController({ directory, candidates: async () => [], localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    t.after(() => restored.stop());
    await restored.init();
    const status = await restored.status();
    assert.equal(status.phase, 'ready');
    assert.equal(status.centralId, previous.centralId);
    assert.equal(status.nodeId, previous.nodeId);
    await restored.disable();
    await restored.stop();
    const disabled = new ConnectionController({ directory, candidates: async () => [], localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    t.after(() => disabled.stop());
    await disabled.init();
    assert.equal((await disabled.status()).phase, 'stopped');
    assert.equal((await disabled.status()).enabled, false);
});

test('中央地址拒绝非回环HTTP、URL秘密和非HTTP协议', async t => {
    const { value } = await controller(t);
    for (const centerUrl of ['http://example.com/', 'https://u:p@example.com/', 'file:///etc/passwd', 'https://example.com/?token=secret']) {
        await assert.rejects(value.test({ centerUrl }));
    }
});

test('不同项目分别接入，同目录会话合并，项目变化保持同一中央进程且接入幂等', async t => {
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const roots = [await createGitFixture(), await createGitFixture()];
    const candidates = () => discoverCandidates([{ root: roots[0] }, { root: path.join(roots[0], 'src'), current: true }, { root: roots[1] }]);
    const discovered = await candidates();
    assert.equal(discovered.length, 2);
    assert.equal(discovered[0].current, true);
    const { value } = await controller(t, { candidates });
    t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
    await value.apply({ mode: 'local', reviewIdentity: '项目审核者' });
    const before = await value.status();
    for (const candidate of discovered) await value.project({ candidateId: candidate.id, enabled: true });
    const status = await value.status();
    assert.equal(status.projects.length, 2);
    assert.equal(new Set(status.projects.map(project => project.projectId)).size, 2);
    assert.equal(status.centerUrl, before.centerUrl);
    assert.equal(status.centralId, before.centralId);
    assert.equal(status.nodeId, before.nodeId);
    const projectId = status.projects[0].projectId;
    await value.project({ candidateId: discovered[0].id, enabled: true });
    assert.equal((await value.status()).projects[0].projectId, projectId);
    await value.project({ workspaceId: status.projects[0].workspaceId, enabled: false });
    const disabled = (await value.status()).projects[0];
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.projectId, projectId);
    assert.equal(existsSync(roots[0]), true);
});

test('切换已有中央后停止插件不停止已有服务，切回本机保留原节点身份', async t => {
    let runtime;
    t.after(() => runtime?.stop());
    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('长期运行节点');
    const { value } = await controller(t);
    runtime = value;
    await value.apply({ mode: 'local', reviewIdentity: '切换审核者' });
    const local = await value.status();
    await value.apply({ mode: 'external', centerUrl, ...node });
    assert.equal((await value.status()).nodeId, node.nodeId);
    await assert.rejects(fetch(new URL('api/v1/info', local.centerUrl)));
    await value.apply({ mode: 'local', reviewIdentity: '切换审核者' });
    const back = await value.status();
    assert.equal(back.centralId, local.centralId);
    assert.equal(back.nodeId, local.nodeId);
    await value.disable();
    await value.apply({ mode: 'external', centerUrl, ...node });
    await value.stop();
    assert.equal((await fetch(new URL('/api/v1/info', centerUrl))).status, 200);
});

test('未决中央任务阻止停用和更换中央，节点凭据与用户身份分别保存', async t => {
    let runtime;
    t.after(() => runtime?.stop());
    const { app, headers } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('未决节点');
    const root = await createGitFixture();
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates([{ root }]);
    const { value } = await controller(t, { candidates });
    runtime = value;
    t.after(() => rm(root, { recursive: true, force: true }));
    await value.apply({ mode: 'external', centerUrl, ...node });
    await value.project({ candidateId: (await candidates())[0].id, enabled: true });
    const project = (await value.status()).projects[0];
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/commands`, headers,
        payload: { operation: 'audit', idempotencyKey: 'pending-switch', payload: { note: '验证' } } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    await assert.rejects(value.disable(), /未决|未核验|未确认/);
    await assert.rejects(value.apply({ mode: 'local', reviewIdentity: '其他中央审核者' }), /未决|未核验|未确认/);
    assert.equal((await value.status()).centralId, app.database.centralId);
});

test('两个首次配置实例不能在取得锁之前覆盖活动实例的设置和秘密', async t => {
    const { value, directory, ConnectionController } = await controller(t);
    const other = new ConnectionController({ directory, candidates: async () => [], localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    t.after(() => other.stop());
    await other.init();
    await value.apply({ mode: 'local', reviewIdentity: '锁持有者' });
    const settings = await readFile(path.join(directory, 'connection.json'), 'utf8');
    const secrets = await readFile(path.join(directory, 'connection-secrets.json'), 'utf8');
    await assert.rejects(other.apply({ mode: 'local', reviewIdentity: '第二实例' }), /已有活动中央连接/);
    assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), settings);
    assert.equal(await readFile(path.join(directory, 'connection-secrets.json'), 'utf8'), secrets);
});

test('恢复启动等待实例锁期间发生的手动停用不会被旧配置撤销', async t => {
    const { value, directory, ConnectionController } = await controller(t);
    await value.apply({ mode: 'local', reviewIdentity: '停用审核者' });
    const other = new ConnectionController({ directory, candidates: async () => [], localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    t.after(() => other.stop());
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const acquire = other.acquire.bind(other);
    other.acquire = async () => { entered(); await new Promise(resolve => { release = resolve; }); await acquire(); };
    const restoring = other.init();
    await waiting;
    await value.disable();
    release();
    await restoring;
    const status = await other.status();
    assert.equal(status.phase, 'stopped');
    assert.equal(status.enabled, false);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'connection.json'), 'utf8')).enabled, false);
});

test('新增其他项目与插件重启保留中央页面修改的名称及停用状态', async t => {
    let runtime;
    t.after(() => runtime?.stop());
    const { app, headers } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('中央配置节点');
    const roots = [await createGitFixture(), await createGitFixture()];
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates(roots.map(root => ({ root })));
    const { value, directory, ConnectionController } = await controller(t, { candidates });
    runtime = value;
    t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
    const found = await candidates();
    await value.apply({ mode: 'external', centerUrl, ...node });
    await value.project({ candidateId: found[0].id, enabled: true });
    const project = (await value.status()).projects[0];
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/projects/${project.projectId}`, headers,
        payload: { name: '中央已命名项目', enabled: false } });
    assert.equal(updated.statusCode, 200, updated.body);
    await value.project({ candidateId: found[1].id, enabled: true });
    assert.equal(app.database.getProject(project.projectId).enabled, false);
    assert.equal(app.database.getProject(project.projectId).name, '中央已命名项目');
    await value.stop();
    const restored = new ConnectionController({ directory, candidates });
    runtime = restored;
    await restored.init();
    const after = (await restored.status()).projects.find(value => value.projectId === project.projectId);
    assert.equal(after.enabled, false);
    assert.equal(after.label, '中央已命名项目');
    await restored.stop();
});
