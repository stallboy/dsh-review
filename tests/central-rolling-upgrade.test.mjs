import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createGitFixture, runCommand } from './helpers.mjs';
import { createCentralApp } from '../apps/server/dist/app.js';
import { startManagedNode } from '../packages/dsh-plugin/dist/managed/managed-config.js';

const archives = [process.env.DSH_PREVIOUS_CENTRAL_PACKAGE, process.env.DSH_PREVIOUS_NODE_PACKAGE];

async function until(read, description) {
    const deadline = Date.now() + 25000;
    do {
        const value = await read();
        if (value) return value;
        await delay(100);
    } while (Date.now() < deadline);
    assert.fail(description);
}

for (const centralFirst of [true, false]) {
    test(centralFirst ? '旧包矩阵：Central 先升级，运行中的旧 Node 重连且能和新 Node 共存'
        : '旧包矩阵：Node 先升级，保留与旧 Central 的基础读写和既有任务', { skip: !archives.some(Boolean), timeout: 80000 }, async t => {
        assert.ok(archives.every(Boolean), '必须同时提供上一部署的两个原始包');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-rolling-upgrade-'));
        const applications = [];
        const workers = [];
        const roots = [];
        t.after(async () => {
            for (const worker of workers.reverse()) await worker.stop();
            for (const application of applications.reverse()) await application.close();
            for (const root of roots) await rm(root, { recursive: true, force: true });
            await rm(directory, { recursive: true, force: true });
        });
        const unpack = async (archive, location, entry) => {
            const destination = await mkdtemp(path.join(directory, location));
            const result = runCommand('tar', ['-xf', path.resolve(archive), '-C', destination], directory);
            assert.equal(result.status, 0, result.stderr);
            return import(pathToFileURL(path.join(destination, 'package', entry)).href);
        };
        const { createCentralApp: createPreviousCentral } = await unpack(archives[0], 'central-', 'dist/app.js');
        const { startManagedNode: startPreviousNode } = await unpack(archives[1], 'node-', 'dist/managed/managed-config.js');
        const workspace = async (workspaceId) => {
            const root = await createGitFixture();
            roots.push(root);
            const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
            const remote = path.join(directory, workspaceId + '.git');
            runCommand('git', ['init', '--bare', '-q', remote], root);
            runCommand('git', ['remote', 'add', 'origin', remote], root);
            runCommand('git', ['push', '-qu', 'origin', target], root);
            return { workspaceId, root, target, vcsType: 'git', label: workspaceId, settings: { runner: 'manual', syncBeforeApprove: false } };
        };

        const dataDir = path.join(directory, 'state');
        let app = await createPreviousCentral({ dataDir });
        applications.push(app);
        const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const oldCentralId = app.database.centralId;
        app.database.createUser({ username: 'reviewer', password: 'a-long-test-password', reviewIdentity: '混合版本验证' });
        const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'reviewer', password: 'a-long-test-password' } });
        assert.equal(login.statusCode, 200, login.body);
        const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
        const credential = app.database.createNode('上一部署节点');
        const firstWorkspace = await workspace('workspace-first');
        const firstNodeDir = path.join(directory, 'node-state');
        const config = { centerUrl, ...credential, workspaces: [firstWorkspace] };
        const onError = () => {};
        const resolveCredential = async () => undefined;
        let holdResult = false;
        let withheldCommand;
        const transport = globalThis.fetch;
        const interception = t.mock.method(globalThis, 'fetch', async (url, init) => {
            if (holdResult && new URL(url).pathname === '/node-api/v1/events') {
                const result = JSON.parse(init.body).events.find(event => event.type === 'result');
                if (result) {
                    withheldCommand = result.commandId;
                    return new Response('temporarily unavailable', { status: 503 });
                }
            }
            return transport(url, init);
        });
        const first = await startPreviousNode(config, firstNodeDir, resolveCredential, onError);
        interception.mock.restore();
        workers.push(first);
        const bind = async (nodeId, work) => {
            const reply = await app.inject({ method: 'POST', url: '/api/v1/projects', headers,
                payload: { name: work.label, nodeId, workspaceId: work.workspaceId } });
            assert.equal(reply.statusCode, 201, reply.body);
            return reply.json().project;
        };
        const firstProject = await bind(credential.nodeId, firstWorkspace);
        const detail = async (project) => {
            const reply = await app.inject({ url: '/api/v1/projects/' + project.projectId, headers });
            assert.equal(reply.statusCode, 200, reply.body);
            return reply.json();
        };
        await until(async () => (await detail(firstProject)).snapshotSequence, '上一部署未同步工作副本');

        const submit = async (project, key) => {
            const response = await app.inject({ method: 'POST', url: '/api/v1/projects/' + project.projectId + '/commands', headers,
                payload: { operation: 'sync', idempotencyKey: key, payload: {} } });
            assert.equal(response.statusCode, 202, response.body);
            return response.json().command;
        };
        const task = async (commandId) => {
            const response = await app.inject({ url: '/api/v1/commands/' + commandId, headers });
            assert.equal(response.statusCode, 200, response.body);
            return response.json().command;
        };
        const finished = async commandId => {
            const result = await until(async () => {
                const command = await task(commandId);
                return command.state === 'completed' && command;
            }, '混合版本未完成原同步任务');
            assert.equal(result.result.outcome.status, 'SUCCEEDED');
            const events = app.database.sql.prepare("SELECT COUNT(*) AS count FROM events WHERE command_id=? AND json_extract(payload,'$.event.type')='result'").get(commandId);
            assert.equal(events.count, 1);
        };

        holdResult = true;
        const pending = await submit(firstProject, 'before-upgrade');
        assert.equal(pending.state, 'queued');
        await until(() => withheldCommand === pending.commandId, '上一部署未产生待确认结果');
        assert.ok(['accepted', 'executing'].includes((await task(pending.commandId)).state));
        if (centralFirst) {
            const previous = app;
            await previous.close();
            applications.pop();
            app = await createCentralApp({ dataDir });
            applications.push(app);
            await app.listen({ host: '127.0.0.1', port: Number(new URL(centerUrl).port) });
            assert.equal(app.database.centralId, oldCentralId);
            holdResult = false;
            await finished(pending.commandId);
            assert.equal(app.database.getNode(credential.nodeId).instanceId, first.instanceId);
            const otherCredential = app.database.createNode('新版节点');
            const otherWorkspace = await workspace('workspace-second');
            const other = await startManagedNode({ centerUrl, ...otherCredential, workspaces: [otherWorkspace] },
                path.join(directory, 'other-node-state'), resolveCredential, onError);
            workers.push(other);
            const otherProject = await bind(otherCredential.nodeId, otherWorkspace);
            await finished((await submit(otherProject, 'mixed-node')).commandId);
            assert.equal(app.database.getNode(credential.nodeId).online, true);
        } else {
            await first.stop();
            workers.pop();
            const current = await startManagedNode(config, firstNodeDir, resolveCredential, onError);
            workers.push(current);
            await finished(pending.commandId);
            assert.equal(app.database.getNode(credential.nodeId).instanceId, current.instanceId);
        }
        assert.equal((await detail(firstProject)).project.bindingGeneration, firstProject.bindingGeneration);
        assert.equal((await submit(firstProject, 'before-upgrade')).commandId, pending.commandId);
        await finished((await submit(firstProject, 'after-upgrade')).commandId);
    });
}
