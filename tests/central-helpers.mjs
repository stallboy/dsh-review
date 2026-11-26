import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function setupCentral(t, options = {}) {
    const entry = new URL('../apps/server/dist/app.js', import.meta.url);
    assert.equal(existsSync(entry), true, '中央服务必须先实现并构建');
    const { createCentralApp: create } = await import(entry.href);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'central-review-test-'));
    const applications = [];
    const createCentralApp = async settings => {
        const application = await create(settings);
        applications.push(application);
        return application;
    };
    const app = await createCentralApp({ dataDir, ...options });
    t.after(async () => {
        for (const application of applications.reverse()) await application.close();
        await rm(dataDir, { recursive: true, force: true });
    });
    app.database.createUser({ username: 'reviewer', password: 'a-long-test-password', reviewIdentity: '审核者甲' });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'reviewer', password: 'a-long-test-password' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const headers = { cookie, 'x-csrf-token': login.json().csrfToken };
    return { app, dataDir, headers, createCentralApp };
}

export async function registerNode(app, name = 'node-a', workspaceId = 'workspace-a', capabilities = { auditSelfTest: true }) {
    const credential = app.database.createNode(name);
    const headers = { authorization: `Bearer ${credential.token}` };
    const instanceId = `instance-${name}`;
    const reply = await app.inject({ method: 'POST', url: '/node-api/v1/register', headers, payload: {
        protocolVersion: 1, instanceId, pluginVersion: '0.3.0', dshVersion: '0.2.1', platform: 'linux',
        workspaces: [{ workspaceId, label: workspaceId, vcsType: 'git', target: 'main', ...capabilities }],
    } });
    assert.equal(reply.statusCode, 200, reply.body);
    return { ...credential, headers, instanceId, workspaceId };
}

export async function bindProject(app, headers, node, name = '示例项目') {
    const reply = await app.inject({ method: 'POST', url: '/api/v1/projects', headers,
        payload: { name, nodeId: node.nodeId, workspaceId: node.workspaceId } });
    assert.equal(reply.statusCode, 201, reply.body);
    return reply.json().project;
}

export function approvePayload(key = 'approve-1') {
    return { operation: 'approve', idempotencyKey: key, payload: { id: '2026-11/fix-retry', optionId: 'opt-a', patchId: 1 },
        guard: { expectedRevision: 1, expectedOwner: '审核者甲', expectedUpdatedAt: '2026-11-16T06:00:00.000Z' } };
}
