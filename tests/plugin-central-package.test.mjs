import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupCentral } from './central-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function npm(command, cwd) {
    const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 180000,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

async function install(t, artifact) {
    const scratch = os.tmpdir();
    const directory = await mkdtemp(path.join(scratch, 'plugin-central-package-'));
    t.after(async () => {
        assert.ok(path.resolve(directory).startsWith(path.resolve(scratch) + path.sep));
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
    await copyFile(path.join(root, 'dist', artifact), path.join(directory, 'artifact.tgz'));
    npm('npm install ./artifact.tgz --offline --omit=dev --ignore-scripts --no-audit --no-fund --cache ./cache', directory);
    return directory;
}

async function startOwned(t, entry, directory) {
    const child = fork(entry, [], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' } });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
    });
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`安装包中央未通过 IPC 就绪：${output}`)); }, 10000);
        child.once('message', value => { clearTimeout(timer); resolve(value); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`安装包中央就绪前退出（${code}）：${output}`)); });
    });
    child.send({ type: 'start', dataDir: path.join(directory, 'data'), reviewIdentity: '整合包审核者', password: 'isolated-local-package-password' });
    const value = await ready;
    assert.equal(value.type, 'ready', JSON.stringify(value));
    assert.match(value.centerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(value.centralId);
    assert.ok(value.nodeId);
    assert.ok(value.token);
    return { child, exit, ready: value };
}

async function stopped(owned, reason) {
    let timer;
    try {
        const result = await Promise.race([owned.exit, new Promise((_, reject) => {
            timer = setTimeout(() => { owned.child.kill(); reject(new Error(`安装包中央${reason}后仍有进程残留`)); }, 7000);
        })]);
        assert.equal(result.code, 0);
    } finally { clearTimeout(timer); }
}

test('本机整合插件离线隔离安装后保留 DSH 身份并实际完成中央 IPC 启停', async t => {
    npm('npm run pack:plugin', root);
    const ordinary = await readFile(path.join(root, 'dist/dsh-code-review-0.3.0.tgz'));
    npm('npm run pack:local', root);
    assert.deepEqual(await readFile(path.join(root, 'dist/dsh-code-review-0.3.0.tgz')), ordinary);
    const directory = await install(t, 'dsh-code-review-local-0.3.0.tgz');
    const pluginRoot = path.join(directory, 'node_modules/dsh-code-review');
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-code-review');
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.equal(Object.hasOwn(manifest, 'private'), false, '整合包应可由 npm 仓库分发');
    const expected = await realpath(path.join(pluginRoot, 'central-runtime/server/dist/owned.js'));
    const script = `
        import assert from 'node:assert/strict';
        import { realpath } from 'node:fs/promises';
        import { LocalCentralProcess } from './node_modules/dsh-code-review/dist/connection/local-process.js';
        const process = new LocalCentralProcess();
        assert.equal(await process.available(), true);
        assert.ok(process.entry instanceof URL);
        assert.equal(await realpath(process.entry), ${JSON.stringify(expected)});
    `;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(probe.status, 0, probe.stderr);
    const owned = await startOwned(t, expected, directory);
    const health = await fetch(`${owned.ready.centerUrl}/health`);
    assert.equal((await health.json()).service, 'dsh-review-central');
    const page = await fetch(owned.ready.centerUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    const asset = /src="([^"<>]+\.js)"/.exec(html)?.[1];
    assert.ok(asset);
    const resource = await fetch(new URL(asset, owned.ready.centerUrl));
    assert.equal(resource.status, 200);
    assert.equal((await resource.arrayBuffer()).byteLength > 100, true);
    owned.child.send({ type: 'stop' });
    await stopped(owned, '收到停止消息');
    const restarted = await startOwned(t, expected, directory);
    assert.equal(restarted.ready.centralId, owned.ready.centralId);
    restarted.child.disconnect();
    await stopped(restarted, '父 IPC 断开');

    await t.test('从开发市场索引按包名和版本安装后能启动中央', async t => {
        const { servePreviewMarket } = await import('../scripts/preview-market.mjs');
        const archive = await readFile(path.join(root, 'dist', `dsh-code-review-local-${manifest.version}.tgz`));
        const { server, origin } = await servePreviewMarket(manifest, archive);
        t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
        assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
        const indexUrl = new URL('/index.json', origin);
        const response = await fetch(indexUrl);
        assert.equal(response.status, 200);
        const index = await response.json();
        assert.equal(index.format, 1);
        const [plugin] = index.plugins;
        const [version] = plugin.versions;
        assert.equal(plugin.name, 'dsh-code-review');
        assert.equal(version.version, manifest.version);
        assert.deepEqual(version.source, { type: 'npm', registry: origin });
        assert.equal(Number.isInteger(version.publishTimestamp), true);
        assert.equal((await fetch(indexUrl, { method: 'PUT' })).status, 405);

        const installRoot = path.join(directory, 'registry-install');
        await mkdir(installRoot);
        await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ private: true,
            dependencies: { [plugin.name]: version.version } }));
        const installer = spawn('npm install --ignore-scripts --no-audit --no-fund --cache ./cache', {
            cwd: installRoot, shell: true, windowsHide: true, timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_registry: version.source.registry,
                npm_config_fetch_retries: '0' },
        });
        let output = '';
        installer.stdout.on('data', bytes => { output += bytes; });
        installer.stderr.on('data', bytes => { output += bytes; });
        assert.equal((await once(installer, 'close'))[0], 0, output);

        const installedRoot = path.join(installRoot, 'node_modules', plugin.name);
        const { apply } = await import(pathToFileURL(path.join(installedRoot, 'dist', 'index.js')).href);
        assert.equal(typeof apply, 'function');
        const installedCentral = await startOwned(t, path.join(installedRoot, 'central-runtime', 'server', 'dist', 'owned.js'), installRoot);
        const health = await fetch(new URL('/health', installedCentral.ready.centerUrl));
        assert.equal((await health.json()).service, 'dsh-review-central');
        assert.equal((await fetch(installedCentral.ready.centerUrl)).status, 200);
        installedCentral.child.send({ type: 'stop' });
        await stopped(installedCentral, '完成市场安装后停止');
    });
});

test('普通插件离线安装仍不携带中央运行目录或 fastify，源码 manifest 不受整合打包修改', async t => {
    npm('npm run pack:plugin', root);
    const directory = await install(t, 'dsh-code-review-0.3.0.tgz');
    const script = `
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { LocalCentralProcess } from './node_modules/dsh-code-review/dist/connection/local-process.js';
        const plugin = await import('dsh-code-review');
        assert.equal(typeof plugin.apply, 'function');
        assert.equal(existsSync('./node_modules/dsh-code-review/central-runtime'), false);
        assert.equal(existsSync('./node_modules/fastify'), false);
        assert.equal(await new LocalCentralProcess().available(), false);
    `;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(probe.status, 0, probe.stderr);
    const manifest = JSON.parse(await readFile(path.join(root, 'packages/dsh-plugin/package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    const installed = JSON.parse(await readFile(path.join(directory, 'node_modules/dsh-code-review/package.json'), 'utf8'));
    assert.equal(installed.private, true);
    assert.equal(manifest.files.includes('central-runtime'), false);
});

test('可下载插件隔离安装后须明确确认，校验失败保留原连接，成功后可离线恢复', async t => {
    npm('npm run pack:downloadable -- https://example.test/releases/download/v0.1.0 https://example.test/releases/latest/download/dsh-review-central-version.json', root);
    let controller;
    let repair;
    let offline;
    t.after(async () => { await offline?.stop(); await repair?.stop(); await controller?.stop(); });
    const directory = await install(t, 'dsh-code-review-downloadable-0.3.0.tgz');
    const runtimeArchive = await readFile(path.join(root, 'dist/dsh-review-server-0.1.0.tgz'));
    const versionFile = JSON.parse(await readFile(path.join(root, 'dist/dsh-review-central-version.json'), 'utf8'));
    const pluginRoot = path.join(directory, 'node_modules', 'dsh-code-review');
    const sourceFile = path.join(pluginRoot, 'assets/central-runtime-source.json');
    const source = JSON.parse(await readFile(sourceFile, 'utf8'));
    assert.deepEqual(source, {
        version: versionFile.version, size: runtimeArchive.length, sha256: createHash('sha256').update(runtimeArchive).digest('hex'),
        url: 'https://example.test/releases/download/v0.1.0/dsh-review-server-0.1.0.tgz',
        versionUrl: 'https://example.test/releases/latest/download/dsh-review-central-version.json',
    });
    assert.equal(existsSync(path.join(pluginRoot, 'central-runtime')), false);
    assert.equal(existsSync(path.join(pluginRoot, 'node_modules', 'tar', 'package.json')), true);

    const corrupted = Buffer.from(runtimeArchive);
    corrupted[corrupted.length - 1] ^= 1;
    let corrupt = true;
    let count = 0;
    let versionResponse;
    const server = createServer((request, response) => {
        if (request.url === '/central.tgz') {
            count++;
            response.end(corrupt ? corrupted : runtimeArchive);
        } else if (request.url === '/latest.json') {
            versionResponse = response;
        } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const closeSource = async () => {
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    t.after(closeSource);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(sourceFile, JSON.stringify({ ...source, url: `${origin}/central.tgz`, versionUrl: `${origin}/latest.json` }));

    const { app } = await setupCentral(t);
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = app.database.createNode('安装包下载测试');
    const { ConnectionController } = await import(pathToFileURL(path.join(pluginRoot, 'dist/connection/controller.js')).href);
    const data = path.join(directory, 'dsh-state');
    controller = new ConnectionController({ directory: data, candidates: async () => [] });
    await controller.init();
    const status = await controller.status();
    assert.equal(status.localAvailable, false);
    assert.equal(status.localRuntimeDownload.sha256, source.sha256);
    await controller.apply({ mode: 'external', centerUrl, ...node });
    const configFile = path.join(data, 'connection.json');
    const previous = await readFile(configFile, 'utf8');
    const local = { mode: 'local', reviewIdentity: '按需启动审核者' };
    await assert.rejects(controller.apply(local), /确认下载/);
    await assert.rejects(controller.apply({ ...local, confirmRuntimeDownload: '0'.repeat(64) }), /确认下载/);
    assert.equal(count, 0);
    const confirmed = { ...local, confirmRuntimeDownload: source.sha256 };
    await assert.rejects(controller.apply(confirmed), /SHA-256 校验失败/);
    assert.equal(count, 1);
    assert.equal(await readFile(configFile, 'utf8'), previous);
    const preserved = await controller.status();
    assert.equal(preserved.mode, 'external');
    assert.equal(preserved.phase, 'ready');
    assert.equal(preserved.nodeOnline, true);

    corrupt = false;
    await controller.apply(confirmed);
    const ready = await controller.status();
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.nodeOnline, true);
    assert.equal(ready.localAvailable, true);
    assert.equal(ready.localRuntimeDownload, undefined);
    assert.equal(ready.localRuntimeUpdate, undefined);
    assert.equal((await fetch(new URL('/', ready.centerUrl))).status, 200);
    for (let attempt = 0; !versionResponse && attempt < 20; attempt++) await delay(25);
    assert.ok(versionResponse, '中央已就绪后应检查版本');
    versionResponse.end(JSON.stringify({ version: '0.2.0' }));
    let update;
    for (let attempt = 0; !update && attempt < 20; attempt++) {
        update = (await controller.status()).localRuntimeUpdate;
        if (!update) await delay(25);
    }
    assert.deepEqual(update, { currentVersion: source.version, latestVersion: '0.2.0' });
    assert.equal(count, 2);

    await controller.stop();
    const cacheRoot = path.join(data, 'central-runtimes');
    const { folder } = JSON.parse(await readFile(path.join(cacheRoot, 'installed.json'), 'utf8'));
    await writeFile(path.join(cacheRoot, folder, 'package/node_modules/fastify/package.json'), '{}');
    repair = new ConnectionController({ directory: data, candidates: async () => [] });
    await repair.init();
    const damaged = await repair.status();
    assert.equal(damaged.phase, 'error');
    assert.equal(damaged.localAvailable, false);
    assert.equal(damaged.localRuntimeDownload.sha256, source.sha256);
    assert.equal(count, 2, '自动恢复不能下载损坏的运行包');
    await repair.apply(confirmed);
    assert.equal((await repair.status()).centralId, ready.centralId);
    assert.equal(count, 3);
    await repair.stop();

    await closeSource();
    await writeFile(sourceFile, JSON.stringify({
        ...source, version: '0.2.0', sha256: '0'.repeat(64), url: `${origin}/new-central.tgz`, versionUrl: `${origin}/latest.json`,
    }));
    offline = new ConnectionController({ directory: data, candidates: async () => [] });
    await offline.init();
    const restored = await offline.status();
    assert.equal(restored.phase, 'ready');
    assert.equal(restored.centralId, ready.centralId);
    assert.equal(restored.nodeId, ready.nodeId);
    assert.equal(restored.localAvailable, true);
});
