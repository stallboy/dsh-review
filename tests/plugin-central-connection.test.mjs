import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
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

test('旧本机运行包仍由网关建立登录会话', async t => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'plugin-legacy-entry-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const localEntry = pathToFileURL(path.join(fixture, 'legacy.mjs'));
    const appEntry = new URL('../apps/server/dist/app.js', import.meta.url);
    await writeFile(localEntry, `
        import { createCentralApp } from ${JSON.stringify(appEntry.href)};
        let app;
        process.on('message', async input => {
            if (input.type === 'stop') {
                await app?.close();
                process.disconnect();
                return;
            }
            app = await createCentralApp({ dataDir: input.dataDir });
            const { node } = app.database.initializeOwned(input);
            const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
            process.send({ type: 'ready', centerUrl, centralId: app.database.centralId, ...node });
        });
    `);
    const { value } = await controller(t, { localEntry });
    await value.apply({ mode: 'local', reviewIdentity: '旧运行包审核者' });
    const status = await value.status();
    assert.equal((await fetch(new URL('api/v1/auth/session', status.centerUrl))).status, 401);
    const server = createServer((req, res) => { void value.handle(req, res); });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-code-review/central/api/v1/auth/session`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).user.reviewIdentity, '旧运行包审核者');
    } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
});

test('中央地址拒绝非回环HTTP、URL秘密和非HTTP协议', async t => {
    const { value } = await controller(t);
    for (const centerUrl of ['http://example.com/', 'https://u:p@example.com/', 'file:///etc/passwd', 'https://example.com/?token=secret']) {
        await assert.rejects(value.test({ centerUrl }));
    }
});

test('连接预检报告凭据与注册能力且不注册节点或保存配置', async t => {
    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('预检节点');
    const { value, directory } = await controller(t);
    assert.deepEqual(await value.test({ centerUrl }), {
        centralId: app.database.centralId, protocolVersion: 1, authenticated: false, registrationCompatibility: 'supported',
    });
    assert.equal((await value.test({ centerUrl, ...node })).authenticated, true);
    await assert.rejects(value.test({ centerUrl, nodeId: node.nodeId, token: 'wrong-credential-never-log' }),
        { stage: 'credentials', code: 'credential_rejected', registrationCompatibility: 'supported' });
    assert.equal(app.database.getNode(node.nodeId).instanceId, '');
    assert.equal(existsSync(path.join(directory, 'connection.json')), false);
    await value.apply({ mode: 'external', centerUrl, ...node });
    assert.equal((await value.test({ centerUrl, nodeId: node.nodeId })).authenticated, true);
    assert.equal((await value.test({ centerUrl, nodeId: 'unrelated-node-id' })).authenticated, false);
    let credentialSent = false;
    const otherAddress = createServer((req, res) => {
        credentialSent ||= Boolean(req.headers.authorization);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ centralId: app.database.centralId, protocolVersion: 1, nodeId: node.nodeId }));
    });
    await new Promise(resolve => otherAddress.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => otherAddress.close(resolve)));
    const unchecked = await value.test({ centerUrl: `http://127.0.0.1:${otherAddress.address().port}/`, nodeId: node.nodeId });
    assert.equal(unchecked.authenticated, false);
    assert.equal(credentialSent, false);
});

test('注册被活动实例阻止时保留可行动的诊断', async t => {
    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('独占节点');
    const first = await controller(t);
    const second = await controller(t);
    await first.value.apply({ mode: 'external', centerUrl, ...node });
    await assert.rejects(second.value.apply({ mode: 'external', centerUrl, ...node }),
        { stage: 'registration', code: 'instance_conflict', message: '相同节点已有活动实例' });
    assert.equal((await first.value.status()).nodeOnline, true);
    assert.match((await second.value.status()).logs.join('\n'), /相同节点已有活动实例/);
});

test('明确不兼容的中央在保存或切换前被拦截', async t => {
    const centralId = 'different-central-id';
    const nodeId = 'different-node-id';
    const token = 'different-credential-value';
    const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/v1/info'
            ? { centralId, protocolVersion: 1, registrationCapabilities: { executionConfigHash: false } }
            : { centralId, nodeId }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const centerUrl = `http://127.0.0.1:${server.address().port}/`;
    const { value, directory } = await controller(t);
    await value.apply({ mode: 'local', reviewIdentity: '当前审核者' });
    const original = await readFile(path.join(directory, 'connection.json'), 'utf8');
    assert.equal((await value.test({ centerUrl, nodeId, token })).registrationCompatibility, 'incompatible');
    await assert.rejects(value.apply({ mode: 'external', centerUrl, nodeId, token }),
        { stage: 'registration', code: 'registration_incompatible' });
    assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), original);
    assert.equal((await value.status()).nodeOnline, true);
});

test('旧中央拒绝新版工作副本字段时报告注册阶段且只记一条诊断', async t => {
    const centralId = 'legacy-central-id';
    const nodeId = 'legacy-workspace-node';
    const token = 'legacy-workspace-secret';
    let registration;
    let rejectedField = 'workspace';
    const server = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/info') return res.end(JSON.stringify({ centralId, protocolVersion: 1 }));
        if (req.url === '/node-api/v1/status') return res.end(JSON.stringify({ centralId, nodeId, projects: [], pending: 0 }));
        if (req.url === '/node-api/v1/register') {
            registration = await new Response(Readable.toWeb(req)).json();
            res.statusCode = 422;
            return res.end(JSON.stringify({ error: { code: 'bad_request', message: `无效协议字段：${rejectedField}` } }));
        }
        res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const centerUrl = `http://127.0.0.1:${server.address().port}/`;
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const [candidate] = await discoverCandidates([{ root }]);
    const { value, directory, ConnectionController } = await controller(t);
    await value.stop();
    await writeFile(path.join(directory, 'connection.json'), JSON.stringify({ version: 1, mode: 'external', enabled: false, centerUrl, centralId,
        reviewIdentity: '', profiles: { [centralId]: { nodeId, workspaces: [{ workspaceId: 'workspace-a', root, label: '项目',
            target: candidate.target, vcsType: 'git', enabled: true }] } } }));
    const runtime = new ConnectionController({ directory, candidates: async () => [] });
    t.after(() => runtime.stop());
    await runtime.init();
    assert.equal((await runtime.test({ centerUrl, nodeId, token })).registrationCompatibility, 'unknown');
    const plugin = createServer((req, res) => { void runtime.handle(req, res); });
    await new Promise(resolve => plugin.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => plugin.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${plugin.address().port}/dsh-code-review/connection/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-review-control': (await runtime.status()).controlToken },
        body: JSON.stringify({ mode: 'external', centerUrl, nodeId, token }),
    });
    assert.equal(response.status, 409);
    const { error } = await response.json();
    assert.equal(error.stage, 'registration');
    assert.equal(error.code, 'workspace_rejected');
    assert.equal(error.message, '中央服务器拒绝了工作副本信息');
    assert.equal(Object.hasOwn(registration.workspaces[0], 'executionConfigHash'), false);
    const status = await runtime.status();
    assert.equal(status.phase, 'error');
    assert.equal(status.issue.code, 'workspace_rejected');
    assert.equal(status.logs.filter(log => log.includes('无效协议字段：workspace')).length, 1);
    assert.equal(JSON.stringify(status).includes(token), false);
    rejectedField = 'workspace.target';
    await assert.rejects(runtime.apply({ mode: 'external', centerUrl, nodeId, token }),
        { stage: 'registration', code: 'registration_field_invalid', detail: 'HTTP 422 · 无效协议字段：workspace.target' });
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

test('已有中央离线时可启动本机中央，保留原连接和项目绑定', async t => {
    const { app, dataDir, createCentralApp } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(centerUrl).port);
    const node = app.database.createNode('离线切换节点');
    const root = await createGitFixture();
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates([{ root }]);
    const { value, directory } = await controller(t, { candidates });
    t.after(() => rm(root, { recursive: true, force: true }));
    await value.apply({ mode: 'external', centerUrl, ...node });
    await value.project({ candidateId: (await candidates())[0].id, enabled: true });
    const original = await value.status();
    const localInput = { mode: 'local', reviewIdentity: '本机审核者' };
    await app.close();
    const unavailable = createServer((_req, res) => res.writeHead(503).end());
    await new Promise(resolve => unavailable.listen(port, '127.0.0.1', resolve));
    try {
        await assert.rejects(value.apply(localInput), { code: 'server_unavailable', detail: 'HTTP 503' });
        assert.equal((await value.status()).centralId, original.centralId);
    } finally { await new Promise(resolve => unavailable.close(resolve)); }

    const journal = new DatabaseSync(path.join(directory, 'connections', original.centralId, 'journal.sqlite'));
    try {
        journal.exec("INSERT INTO outbox VALUES ('pending-event', 1, '{}')");
        await assert.rejects(value.apply(localInput), { code: 'connection_busy' });
        assert.equal((await value.status()).centralId, original.centralId);
        journal.exec("DELETE FROM outbox WHERE command_id='pending-event'");
    } finally { journal.close(); }

    await value.apply(localInput);
    const local = await value.status();
    assert.equal(local.mode, 'local');
    assert.equal(local.phase, 'ready');
    assert.equal(local.nodeOnline, true);
    assert.deepEqual(local.projects, []);
    assert.deepEqual(local.savedConnections.map(connection => connection.centralId), [original.centralId]);

    const restored = await createCentralApp({ dataDir, clock: () => new Date(Date.now() + 31_000) });
    await restored.listen({ host: '127.0.0.1', port });
    await value.apply({ savedCentralId: original.centralId });
    const back = await value.status();
    assert.equal(back.nodeId, node.nodeId);
    assert.equal(back.projects[0].projectId, original.projects[0].projectId);
});

test('旧配置升级后可按中央切换并恢复已保存地址、节点和工作副本', async t => {
    const first = (await setupCentral(t)).app;
    const second = (await setupCentral(t)).app;
    const firstUrl = await first.listen({ host: '127.0.0.1', port: 0 });
    const secondUrl = await second.listen({ host: '127.0.0.1', port: 0 });
    const firstNode = first.database.createNode('旧配置节点');
    const secondNode = second.database.createNode('团队节点');
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates([{ root }]);
    const { value, directory, ConnectionController } = await controller(t, { candidates });
    await value.apply({ mode: 'external', centerUrl: firstUrl, ...firstNode });
    await value.project({ candidateId: (await candidates())[0].id, enabled: true });
    const original = await value.status();
    await value.stop();
    const filename = path.join(directory, 'connection.json');
    const legacy = JSON.parse(await readFile(filename, 'utf8'));
    delete legacy.profiles[original.centralId].centerUrl;
    await writeFile(filename, JSON.stringify(legacy));

    const restored = new ConnectionController({ directory, candidates });
    t.after(() => restored.stop());
    await restored.init();
    const activeTarget = (await controller(t)).value;
    await activeTarget.apply({ mode: 'external', centerUrl: secondUrl, ...secondNode });
    await assert.rejects(restored.apply({ mode: 'external', centerUrl: secondUrl, ...secondNode }), { code: 'instance_conflict' });
    assert.equal((await restored.status()).nodeOnline, true);
    assert.equal((await restored.status()).centralId, original.centralId);
    await activeTarget.stop();
    await restored.apply({ mode: 'external', centerUrl: secondUrl, ...secondNode, label: '团队中央' });
    const other = await restored.status();
    assert.equal(other.projects.length, 0);
    assert.deepEqual(other.savedConnections.map(connection => [connection.centralId, connection.centerUrl, connection.label]), [
        [original.centralId, original.centerUrl, undefined], [second.database.centralId, other.centerUrl, '团队中央'],
    ]);
    assert.equal(JSON.stringify(other.savedConnections).includes(firstNode.token), false);
    assert.equal(JSON.stringify(other.savedConnections).includes(secondNode.token), false);
    await assert.rejects(restored.apply({ mode: 'external', centerUrl: secondUrl, expectedCentralId: original.centralId }),
        { code: 'central_identity_changed' });
    assert.equal((await restored.status()).centralId, second.database.centralId);
    const saved = { centerUrl: original.centerUrl, expectedCentralId: original.centralId };
    assert.equal((await restored.test(saved)).authenticated, true);
    await restored.apply({ savedCentralId: original.centralId, centerUrl: secondUrl });
    const back = await restored.status();
    assert.equal(back.nodeId, firstNode.nodeId);
    assert.equal(back.projects[0].workspaceId, original.projects[0].workspaceId);
    assert.equal(back.projects[0].projectId, original.projects[0].projectId);
    await restored.forget({ centralId: second.database.centralId, stopCurrent: false });
    assert.equal((await restored.status()).nodeOnline, true);
    assert.deepEqual((await restored.status()).savedConnections.map(connection => connection.centralId), [original.centralId]);
    await assert.rejects(restored.apply({ savedCentralId: second.database.centralId }), /已保存的连接不存在/);
    await assert.rejects(restored.forget({ centralId: original.centralId, stopCurrent: false }), /正在使用/);
    await restored.forget({ centralId: original.centralId, stopCurrent: true });
    const empty = await restored.status();
    assert.equal(empty.configured, true);
    assert.equal(empty.enabled, false);
    assert.equal(empty.centralId, '');
    assert.deepEqual(empty.savedConnections, []);
    const retained = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(retained.profiles[original.centralId].centerUrl, undefined);
    assert.equal(retained.profiles[original.centralId].workspaces[0].projectId, original.projects[0].projectId);
    const secrets = JSON.parse(await readFile(path.join(directory, 'connection-secrets.json'), 'utf8'));
    assert.equal(secrets.nodes[original.centralId], undefined);
    assert.equal(secrets.nodes[other.centralId], undefined);
    assert.equal((await fetch(new URL('api/v1/info', original.centerUrl))).status, 200);
    await assert.rejects(restored.apply({ mode: 'external', centerUrl: firstUrl, nodeId: firstNode.nodeId }), { code: 'invalid_token' });
    await restored.stop();
    const restarted = new ConnectionController({ directory, candidates });
    t.after(() => restarted.stop());
    await restarted.init();
    assert.equal((await restarted.status()).centralId, '');
    await restarted.apply({ mode: 'external', centerUrl: firstUrl, ...firstNode });
    assert.equal((await restarted.status()).projects[0].projectId, original.projects[0].projectId);
    await restarted.stop();
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
    await assert.rejects(value.disable(), error => {
        assert.equal(error.code, 'connection_busy');
        assert.deepEqual(error.blockers.map(({ projectId, operation, state }) => ({ projectId, operation, state })),
            [{ projectId: project.projectId, operation: 'audit', state: 'queued' }]);
        assert.equal(error.blockers[0].project, app.database.getProject(project.projectId).name);
        return true;
    });
    await assert.rejects(value.forget({ centralId: app.database.centralId, stopCurrent: true }), /未决|未核验|未确认/);
    await assert.rejects(value.apply({ mode: 'local', reviewIdentity: '其他中央审核者' }), /未决|未核验|未确认/);
    assert.equal((await value.status()).centralId, app.database.centralId);
    await assert.rejects(value.disable('another-central'), /重新确认/);
    await value.disable(app.database.centralId);
    const stopped = await value.status();
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.phase, 'stopped');
    assert.equal(app.database.pendingNodeCommands(node.nodeId), 1);
    assert.equal((await fetch(new URL('api/v1/info', centerUrl))).status, 200);
    await assert.rejects(value.apply({ mode: 'local', reviewIdentity: '其他中央审核者' }), /恢复强制退出/);
    await assert.rejects(value.forget({ centralId: app.database.centralId }), /恢复强制退出/);
    const activate = app.database.activateNode;
    try {
        app.database.activateNode = () => { throw new Error('无法激活节点'); };
        await assert.rejects(value.apply({ mode: 'external', centerUrl, ...node }));
        await assert.rejects(value.apply({ mode: 'local', reviewIdentity: '其他中央审核者' }), /恢复强制退出/);
        await assert.rejects(value.forget({ centralId: app.database.centralId }), /恢复强制退出/);
    } finally {
        app.database.activateNode = activate;
    }
    await value.apply({ mode: 'external', centerUrl, ...node });
    assert.equal((await value.status()).projects[0].projectId, project.projectId);
});

test('删除配置先校验原中央，凭据清理后中断仍可继续删除', async t => {
    const { value, directory } = await controller(t);
    const requests = [];
    const server = createServer((req, res) => {
        requests.push({ path: req.url, authorized: Boolean(req.headers.authorization) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ centralId: 'different-central-id', protocolVersion: 1 }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const centralId = 'original-central-id';
    const centerUrl = `http://127.0.0.1:${server.address().port}/`;
    const configFile = path.join(directory, 'connection.json');
    const secretsFile = path.join(directory, 'connection-secrets.json');
    const config = {
        version: 1, enabled: true, mode: 'external', centralId, centerUrl, reviewIdentity: '', profiles: {},
    };
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(secretsFile, JSON.stringify({
        password: 'fixture', nodes: { [centralId]: { nodeId: 'original-node-id', token: 'original-credential-value' } },
    }));
    await assert.rejects(value.forget({ centralId, stopCurrent: true }), { code: 'central_identity_changed' });
    assert.deepEqual(requests, [{ path: '/api/v1/info', authorized: false }]);
    assert.equal((await value.status()).centralId, centralId);

    await writeFile(configFile, JSON.stringify({ ...config, enabled: false }));
    await writeFile(secretsFile, JSON.stringify({ password: 'fixture', nodes: {} }));
    await value.forget({ centralId, stopCurrent: false });
    assert.equal((await value.status()).centralId, '');
    assert.equal(requests.length, 1);
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
    const previousSequence = app.database.sql.prepare('SELECT sequence FROM snapshots WHERE project_id=?').get(project.projectId)?.sequence ?? 0;
    const enabled = await app.inject({ method: 'PUT', url: `/api/v1/projects/${project.projectId}`, headers, payload: { enabled: true } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    let sequence = previousSequence;
    for (let attempt = 0; attempt < 30 && sequence <= previousSequence; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        sequence = app.database.sql.prepare('SELECT sequence FROM snapshots WHERE project_id=?').get(project.projectId)?.sequence ?? 0;
    }
    assert.ok(sequence > previousSequence, '中央重新启用后应恢复快照采集，不要求重启插件');
    await restored.stop();
});

test('已停用工作副本目录消失不影响其他项目恢复并保留历史', async t => {
    const roots = [await createGitFixture(), await createGitFixture()];
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates(roots.map(root => ({ root })));
    let restored;
    t.after(() => restored?.stop());
    const { value, directory, ConnectionController } = await controller(t, { candidates });
    t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
    await value.apply({ mode: 'local', reviewIdentity: '停用目录审核者' });
    for (const candidate of await candidates()) await value.project({ candidateId: candidate.id, enabled: true });
    const previous = (await value.status()).projects;
    await value.project({ workspaceId: previous[0].workspaceId, enabled: false });
    await value.stop();
    await rm(roots[0], { recursive: true, force: true });
    restored = new ConnectionController({ directory, candidates, localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    await restored.init();
    const status = await restored.status();
    assert.equal(status.phase, 'ready', status.error);
    assert.equal(status.nodeOnline, true);
    assert.equal(status.projects.length, 2);
    assert.equal(status.projects[0].enabled, false);
    assert.equal(status.projects[0].projectId, previous[0].projectId);
    assert.equal(status.projects[1].enabled, true);
    const secrets = JSON.parse(await readFile(path.join(directory, 'connection-secrets.json'), 'utf8'));
    const reply = await fetch(new URL('node-api/v1/status', status.centerUrl), { method: 'POST',
        headers: { authorization: `Bearer ${secrets.nodes[status.centralId].token}`, 'content-type': 'application/json' }, body: '{}' });
    const central = await reply.json();
    assert.equal(central.projects.find(project => project.projectId === previous[0].projectId).enabled, false);
});

test('缺失工作副本时连接和其他项目继续运行，故障项目仍可停用', async t => {
    const roots = [await createGitFixture(), await createGitFixture()];
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates(roots.map(root => ({ root })));
    let restored;
    t.after(() => restored?.stop());
    const { value, directory, ConnectionController } = await controller(t, { candidates });
    t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
    await value.apply({ mode: 'local', reviewIdentity: '故障修复审核者' });
    for (const candidate of await candidates()) await value.project({ candidateId: candidate.id, enabled: true });
    const project = (await value.status()).projects[0];
    await value.stop();
    await rm(roots[0], { recursive: true, force: true });
    restored = new ConnectionController({ directory, candidates, localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    await restored.init();
    assert.equal((await restored.status()).phase, 'ready');
    assert.equal((await restored.status()).nodeOnline, true);
    await restored.project({ workspaceId: project.workspaceId, enabled: false });
    const status = await restored.status();
    assert.equal(status.phase, 'ready', status.error);
    assert.equal(status.projects[0].enabled, false);
    assert.equal(status.projects[1].enabled, true);
    assert.equal(status.error, '');
    const server = createServer((req, res) => { void restored.handle(req, res); });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-code-review/central/api/v1/auth/session`);
        assert.equal(response.status, 200);
        const session = await response.json();
        assert.equal(session.user.username, 'local');
        assert.equal(session.localAccess, true);
        const database = new DatabaseSync(path.join(directory, 'central', 'central.sqlite'), { readOnly: true });
        try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0); }
        finally { database.close(); }
    } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
});

test('旧托管状态只返回安全中央地址与节点标识而不暴露凭据引用', async t => {
    const { value, directory, ConnectionController } = await controller(t);
    await value.stop();
    await writeFile(path.join(directory, 'managed-node.json'), JSON.stringify({ centerUrl: 'https://legacy.example.test/', nodeId: 'legacy-node', tokenReference: 'LEGACY_PRIVATE_REFERENCE', workspaces: [] }));
    const legacy = new ConnectionController({ directory, candidates: async () => [] });
    t.after(() => legacy.stop());
    await legacy.init();
    const status = await legacy.status();
    assert.equal(status.legacy, true);
    assert.equal(status.phase, 'stopped');
    assert.equal(status.centerUrl, 'https://legacy.example.test/');
    assert.equal(status.nodeId, 'legacy-node');
    assert.equal(JSON.stringify(status).includes('LEGACY_PRIVATE_REFERENCE'), false);
    await assert.rejects(legacy.apply({ mode: 'local', reviewIdentity: '新身份' }), /旧 managed-node/);
});

test('故障修复不能停用或接管仍有活动执行实例的项目', async t => {
    const root = await createGitFixture();
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates([{ root }]);
    const { value, directory } = await controller(t, { candidates });
    t.after(() => rm(root, { recursive: true, force: true }));
    await value.apply({ mode: 'local', reviewIdentity: '活动实例审核者' });
    await value.project({ candidateId: (await candidates())[0].id, enabled: true });
    const before = await value.status();
    const node = value.node;
    value.node = null;
    value.phase = 'error';
    try {
        await assert.rejects(value.project({ workspaceId: before.projects[0].workspaceId, enabled: false }), /原节点仍有活动实例/);
        const secrets = JSON.parse(await readFile(path.join(directory, 'connection-secrets.json'), 'utf8'));
        const response = await fetch(new URL('node-api/v1/status', before.centerUrl), { method: 'POST',
            headers: { authorization: `Bearer ${secrets.nodes[before.centralId].token}`, 'content-type': 'application/json' }, body: '{}' });
        const status = await response.json();
        assert.equal(status.activeInstance, true);
        assert.equal(status.projects[0].enabled, true);
    } finally { value.node = node; value.phase = 'ready'; }
});

test('故障项目停用遇到断开响应丢失时进入错误态并允许安全重试', async t => {
    const root = await createGitFixture();
    const { discoverCandidates } = await import('../packages/dsh-plugin/dist/connection/config.js');
    const candidates = () => discoverCandidates([{ root }]);
    let restored;
    t.after(() => restored?.stop());
    const { value, directory, ConnectionController } = await controller(t, { candidates });
    t.after(() => rm(root, { recursive: true, force: true }));
    await value.apply({ mode: 'local', reviewIdentity: '断开重试审核者' });
    await value.project({ candidateId: (await candidates())[0].id, enabled: true });
    const workspaceId = (await value.status()).projects[0].workspaceId;
    await value.stop();
    await rm(root, { recursive: true, force: true });
    restored = new ConnectionController({ directory, candidates, localEntry: new URL('../apps/server/dist/owned.js', import.meta.url) });
    await restored.init();
    const node = restored.node;
    assert.ok(node);
    await node.stop();
    restored.node = null;
    restored.phase = 'error';
    const request = restored.request.bind(restored);
    let lose = true;
    restored.request = async (...args) => {
        const response = await request(...args);
        if (args[1] === 'node-api/v1/disconnect' && lose) { lose = false; throw new Error('断开响应丢失'); }
        return response;
    };
    await assert.rejects(restored.project({ workspaceId, enabled: false }), /断开响应丢失/);
    assert.equal((await restored.status()).phase, 'error');
    await restored.project({ workspaceId, enabled: false });
    assert.equal((await restored.status()).phase, 'ready');
    assert.equal((await restored.status()).projects[0].enabled, false);
});
