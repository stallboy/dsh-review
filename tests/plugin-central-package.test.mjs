import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        import { LocalCentralProcess } from './node_modules/dsh-code-review/dist/connection/local-process.js';
        const process = new LocalCentralProcess();
        assert.equal(await process.available(), true);
        assert.equal(process.entry.href, ${JSON.stringify(pathToFileURL(expected).href)});
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
