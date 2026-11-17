import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { setupCentral } from './central-helpers.mjs';

async function listen(t, handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('同源网关固定目标、改写base、隔离浏览器Cookie且禁止节点API', async t => {
    const entry = new URL('../packages/dsh-plugin/dist/connection/gateway.js', import.meta.url);
    assert.equal(existsSync(entry), true, '中央同源网关尚未实现');
    const { CentralGateway } = await import(entry);
    const received = [];
    const centerUrl = await listen(t, (req, res) => {
        received.push({ url: req.url, cookie: req.headers.cookie, auth: req.headers.authorization });
        if (req.url === '/api/v1/auth/login') {
            res.setHeader('set-cookie', 'dsh_review_session=central-user; HttpOnly; Secure; Path=/');
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
        } else if (req.url === '/') {
            res.setHeader('content-type', 'text/html');
            res.end('<html><head><base href="/"></head><body>中央</body></html>');
        } else { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
    });
    const gateway = new CentralGateway();
    gateway.connect(`${centerUrl}/`, 'central-a');
    const local = await listen(t, (req, res) => { void gateway.handle(req, res).catch(error => { res.statusCode = 502; res.end(error.message); }); });
    const document = await fetch(`${local}/dsh-code-review/central/`, { headers: { cookie: 'dsh_secret=private', authorization: 'Bearer dsh-secret' } });
    assert.match(await document.text(), /<base href="\/dsh-code-review\/central\/">/);
    let cookie = document.headers.get('set-cookie').split(';')[0];
    await fetch(`${local}/dsh-code-review/central/api/v1/auth/login`, { method: 'POST', headers: { cookie }, body: '{}' });
    await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`, { headers: { cookie } });
    assert.equal(received.at(-1).cookie, 'dsh_review_session=central-user');
    assert.equal(received.at(-1).auth, undefined);
    await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`);
    assert.equal(received.at(-1).cookie, undefined);
    const before = received.length;
    assert.equal((await fetch(`${local}/dsh-code-review/central/node-api/v1/status`, { method: 'POST' })).status, 403);
    assert.equal(received.length, before);
    gateway.connect(`${centerUrl}/`, 'central-b');
    await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`, { headers: { cookie } });
    assert.equal(received.at(-1).cookie, undefined);
});

test('本地登录等待期间切换中央不会将旧会话写入新中央的网关', async t => {
    const { CentralGateway } = await import('../packages/dsh-plugin/dist/connection/gateway.js');
    const received = [];
    const upstream = await listen(t, (req, res) => { received.push(req.headers.cookie); res.end('ok'); });
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const gateway = new CentralGateway();
    gateway.connect(`${upstream}/`, 'old-central', () => { started(); return new Promise(resolve => { release = resolve; }); });
    const local = await listen(t, (req, res) => { void gateway.handle(req, res).catch(() => { res.statusCode = 502; res.end('连接已更换'); }); });
    const pending = fetch(`${local}/dsh-code-review/central/`);
    await waiting;
    gateway.connect(`${upstream}/`, 'new-central');
    release('dsh_review_session=old-secret');
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('set-cookie'), null);
    await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`);
    assert.equal(received.at(-1), undefined);
});

test('本机会话退出与过期后只重建会话读取，不重放业务写请求', async t => {
    const { CentralGateway } = await import('../packages/dsh-plugin/dist/connection/gateway.js');
    let logins = 0, expired = false, writes = 0;
    const upstream = await listen(t, (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/auth/logout') { res.setHeader('set-cookie', 'dsh_review_session=; Path=/; Max-Age=0'); res.end('{"ok":true}'); return; }
        if (req.method === 'POST') writes++;
        if (expired || !req.headers.cookie) res.statusCode = 401;
        res.end('{"ok":true}');
    });
    const gateway = new CentralGateway();
    gateway.connect(`${upstream}/`, 'local-central', async () => { logins++; expired = false; return `dsh_review_session=local-${logins}`; });
    const local = await listen(t, (req, res) => { void gateway.handle(req, res).catch(() => { res.statusCode = 502; res.end(); }); });
    let response = await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`);
    let cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    response = await fetch(`${local}/dsh-code-review/central/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    await response.arrayBuffer();
    response = await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(logins, 2);
    cookie = response.headers.get('set-cookie').split(';')[0];
    await response.arrayBuffer();
    expired = true;
    response = await fetch(`${local}/dsh-code-review/central/api/v1/projects`, { method: 'POST', headers: { cookie }, body: '{}' });
    assert.equal(response.status, 401);
    assert.equal(writes, 1);
    assert.equal(logins, 2);
    await response.arrayBuffer();
    response = await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(logins, 3);
    await response.arrayBuffer();
});

test('真实中央内嵌子路径支持Web资源、用户登录与CSRF写入', async t => {
    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { CentralGateway } = await import('../packages/dsh-plugin/dist/connection/gateway.js');
    const gateway = new CentralGateway();
    gateway.connect(`${centerUrl}/`, app.database.centralId, async () => {
        const response = await fetch(`${centerUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'reviewer', password: 'a-long-test-password' }) });
        await response.arrayBuffer();
        return response.headers.getSetCookie()[0].split(';')[0];
    });
    const local = await listen(t, (req, res) => { void gateway.handle(req, res).catch(error => { res.statusCode = 502; res.end(error.message); }); });
    let response = await fetch(`${local}/dsh-code-review/central/projects/example`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<base href="\/dsh-code-review\/central\/">/);
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const script = /src="([^"]+\.js)"/.exec(html)[1];
    response = await fetch(new URL(script, `${local}/dsh-code-review/central/`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    await response.arrayBuffer();
    response = await fetch(`${local}/dsh-code-review/central/api/v1/auth/session`, { headers: { cookie } });
    const session = await response.json();
    assert.equal(session.user.username, 'reviewer');
    const url = `${local}/dsh-code-review/central/api/v1/nodes`;
    response = await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"name":"CSRF验证"}' });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    response = await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: '{"name":"CSRF验证"}' });
    assert.equal(response.status, 201);
    assert.ok((await response.json()).nodeId);
});
