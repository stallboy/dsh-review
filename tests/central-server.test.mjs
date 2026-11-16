import assert from 'node:assert/strict';
import test from 'node:test';
import { setupCentral, registerNode, bindProject } from './central-helpers.mjs';

test('编码后的 API 路径仍依据匹配路由执行身份与 CSRF 校验', async t => {
    const { app, headers } = await setupCentral(t);
    assert.equal((await app.inject('/%61pi/v1/nodes')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/%61pi/v1/nodes', payload: { name: '不能创建' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/%61pi/v1/nodes', headers: { cookie: headers.cookie }, payload: { name: '不能创建' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/node-%61pi/v1/heartbeat', payload: { instanceId: 'untrusted' } })).statusCode, 401);
});

test('中央服务要求用户登录及写请求 CSRF，节点凭据不用于用户接口', async t => {
    const { app, headers } = await setupCentral(t);
    assert.equal((await app.inject('/api/v1/projects')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/nodes', headers: { cookie: headers.cookie }, payload: { name: '机器 A' } })).statusCode, 403);
    const node = await registerNode(app);
    assert.equal((await app.inject({ url: '/api/v1/nodes', headers: node.headers })).statusCode, 401);
    const listed = await app.inject({ url: '/api/v1/nodes', headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.includes(node.token), false);
    assert.equal(listed.body.includes('token_hash'), false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/projects', headers })).statusCode, 401);
});

test('节点身份与工作副本绑定隔离，活动 instanceId 冲突被拒绝', async t => {
    const { app, headers } = await setupCentral(t);
    const a = await registerNode(app, 'node-a', 'repo-a');
    const b = await registerNode(app, 'node-b', 'repo-b');
    const project = await bindProject(app, headers, a);
    assert.equal(project.nodeId, a.nodeId);
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: '错误绑定', nodeId: b.nodeId, workspaceId: a.workspaceId } });
    assert.equal(wrong.statusCode, 409);
    const collision = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers: a.headers, payload: {
        protocolVersion: 1, instanceId: 'another-process', pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux', workspaces: [],
    } });
    assert.equal(collision.statusCode, 409);
});

test('中心重启后配置持久化，节点凭据可吊销', async t => {
    const { app, headers, dataDir, createCentralApp } = await setupCentral(t);
    const node = await registerNode(app);
    await bindProject(app, headers, node);
    const second = await createCentralApp({ dataDir });
    t.after(() => second.close());
    assert.equal((await second.inject({ url: '/api/v1/projects', headers })).json().projects.length, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/nodes/${node.nodeId}/revoke`, headers, payload: {} })).statusCode, 200);
    assert.equal((await second.inject({ method: 'POST', url: '/node-api/v1/heartbeat', headers: node.headers, payload: { instanceId: node.instanceId } })).statusCode, 401);
});
