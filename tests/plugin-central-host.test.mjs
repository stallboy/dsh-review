import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture } from './helpers.mjs';

test('Host注册实例级管理入口，按会话项目发现候选且管理写操作需要令牌', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-host-'));
    const roots = [await createGitFixture(), await createGitFixture()];
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = directory;
    const routes = [], cleanups = [];
    let server;
    t.after(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
        await Promise.all([directory, ...roots].map(root => rm(root, { recursive: true, force: true })));
    });
    const { apply } = await import('../packages/dsh-plugin/dist/host/index.js');
    apply({
        webServer: { register: route => { routes.push(route); return () => {}; } },
        effect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
        get: name => name === 'workspaceRegistry' ? { list: () => roots.map((root, index) => ({ id: `project-${index}`, path: root })) }
            : name === 'sessions' ? { get: id => ({ header: { cwd: id === 'session-b' ? roots[1] : path.join(roots[0], 'src') } }) } : undefined,
    });
    server = createServer((req, res) => {
        const route = routes.filter(route => new URL(req.url, 'http://local').pathname.startsWith(route.path)).sort((a, b) => b.path.length - a.path.length)[0];
        if (route) void Promise.resolve(route.handler(req, res)).catch(error => { res.statusCode = 500; res.end(error.message); });
        else { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async id => (await fetch(`${base}/dsh-code-review/connection?sessionId=${id}`)).json();
    const a = await read('session-a'), b = await read('session-b');
    assert.equal(a.candidates.length, 2);
    assert.notEqual(a.candidates.find(item => item.current).id, b.candidates.find(item => item.current).id);
    assert.equal(a.phase, 'stopped');
    assert.equal((await fetch(`${base}/dsh-code-review/connection/apply`, { method: 'POST', body: '{"mode":"local"}' })).status, 403);
    assert.equal((await read('session-a')).configured, false);
});
