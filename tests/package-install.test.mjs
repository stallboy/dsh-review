import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd, env = {}) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
        env: { ...process.env, ...env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

function npm(command, cwd) {
    const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

async function install(t, artifact) {
    const scratch = os.tmpdir();
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, 'package-install-'));
    t.after(async () => {
        assert.ok(path.resolve(directory).startsWith(path.resolve(scratch) + path.sep));
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
    await copyFile(path.join(root, 'dist', artifact), path.join(directory, 'artifact.tgz'));
    npm('npm install ./artifact.tgz --offline --omit=dev --ignore-scripts --no-audit --no-fund --cache ./cache', directory);
    return directory;
}

test('独立插件包离线安装后可加载宿主、界面和资源，不携带中央应用', async t => {
    npm('npm run pack:plugin', root);
    const directory = await install(t, 'dsh-code-review-0.3.0.tgz');
    run(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { existsSync, readFileSync } from 'node:fs';
        import { createRequire } from 'node:module';
        import path from 'node:path';
        const require = createRequire(import.meta.url);
        const plugin = await import('dsh-code-review');
        assert.equal(typeof plugin.apply, 'function');
        const manifest = require('dsh-code-review/package.json');
        assert.equal(manifest.dsh.client.platform, 'web');
        const packageRoot = path.dirname(require.resolve('dsh-code-review/package.json'));
        const { loadAuditSystemPrompt } = await import('./node_modules/dsh-code-review/dist/host/auditor.js');
        const { loadSystemPrompt } = await import('./node_modules/dsh-code-review/dist/host/runner.js');
        assert.ok((await loadAuditSystemPrompt()).length > 100);
        assert.ok((await loadSystemPrompt()).length > 100);
        assert.match(readFileSync(require.resolve('dsh-code-review/client'), 'utf8'), /__ModuleLoader__/);
        assert.ok(existsSync(require.resolve('dsh-code-review/locale/zh.json')));
        assert.ok(existsSync(require.resolve('dsh-code-review/icon')));
        assert.ok(existsSync(path.join(packageRoot, manifest.dsh.bundle.patch)));
        assert.equal(existsSync(path.join(packageRoot, 'apps')), false);
        assert.equal(existsSync('./node_modules/fastify'), false);
    `], directory);
});

test('独立中央服务包离线安装后提供 API、Web 静态资源和 CLI', async t => {
    await writeFile(path.join(root, 'apps/server/dist/public/obsolete.js'), 'obsolete');
    npm('npm run pack:central', root);
    const directory = await install(t, 'dsh-review-server-0.1.0.tgz');
    const manifest = JSON.parse(await readFile(path.join(directory, 'node_modules/@dsh-review/server/package.json'), 'utf8'));
    assert.equal(manifest.bin['dsh-review-central'], 'dist/cli.js');
    run(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { createCentralApp } from './node_modules/@dsh-review/server/dist/app.js';
        const app = await createCentralApp({ dataDir: './data' });
        try {
            assert.equal((await app.inject('/health')).json().service, 'dsh-review-central');
            const page = await app.inject('/');
            assert.equal(page.statusCode, 200);
            const asset = /src="([^\"]+\.js)"/.exec(page.body)?.[1];
            assert.ok(asset);
            assert.equal((await app.inject(asset)).statusCode, 200);
            assert.equal((await app.inject('/projects/test')).statusCode, 200);
            assert.equal((await app.inject('/obsolete.js')).statusCode, 404);
            assert.equal(existsSync('./node_modules/dsh-code-review'), false);
        } finally { await app.close(); }
    `], directory);
    const output = run(process.execPath, ['node_modules/@dsh-review/server/dist/cli.js', 'user-add', '--data-dir', './cli-data',
        '--username', 'package-reviewer', '--review-identity', '审核者'], directory, { DSH_REVIEW_PASSWORD: 'isolated-package-password' });
    assert.equal(JSON.parse(output).username, 'package-reviewer');
});
