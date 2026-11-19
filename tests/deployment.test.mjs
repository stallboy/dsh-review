import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitFixture, runCommand } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const deploy = path.join(root, 'scripts/deploy.mjs');
const start = path.join(root, 'scripts/start.mjs');
const password = 'deployment-test-password';
let artifacts;
const processes = new WeakMap();

function run(file, args, options = {}) {
    return spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', timeout: 180000,
        ...options, env: { ...process.env, DSH_REVIEW_PASSWORD: password, ...options.env } });
}

function successful(result) {
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result;
}

async function fixture(t) {
    const temporaryRoot = await realpath(os.tmpdir());
    const directory = await mkdtemp(path.join(temporaryRoot, 'dsh-deploy-test-'));
    t.after(async () => {
        for (const { child, target } of processes.get(t) ?? []) {
            let record;
            try { record = JSON.parse(await readFile(path.join(target, '.running.json'), 'utf8')); } catch {}
            if (record?.childPid) {
                try { process.kill(record.childPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
            if (child.exitCode === null && child.signalCode === null) {
                const timer = setTimeout(() => child.kill(), 5000);
                try { await once(child, 'exit'); } finally { clearTimeout(timer); }
            }
        }
        assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep));
        await rm(directory, { recursive: true, force: true });
    });
    return directory;
}

async function packages() {
    if (!artifacts) {
        artifacts = (async () => {
            for (const role of ['central', 'plugin']) {
                const result = spawnSync(`npm run pack:${role}`, { cwd: root, shell: true, encoding: 'utf8', timeout: 180000 });
                successful(result);
            }
            return { central: path.join(root, 'dist/dsh-review-server-0.1.0.tgz'), node: path.join(root, 'dist/dsh-code-review-0.3.0.tgz') };
        })();
    }
    return artifacts;
}

async function deployCentral(t, extra = []) {
    const directory = await fixture(t);
    const target = path.join(directory, '部署 & space');
    const archive = (await packages()).central;
    successful(run(deploy, ['--role', 'central', '--target', target, '--package', archive, '--port', '0', ...extra]));
    return { directory, target, archive };
}

async function launch(t, target) {
    const command = process.platform === 'win32' ? 'cmd.exe' : path.join(target, 'start.sh');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `""${path.join(target, 'start.cmd')}""`] : [];
    const child = spawn(command, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: process.platform === 'win32' });
    processes.set(t, [...(processes.get(t) ?? []), { child, target }]);
    const listening = await new Promise((resolve, reject) => {
        let stderr = '', stdout = '';
        const timer = setTimeout(() => reject(new Error('启动超时')), 15000);
        child.once('error', reject);
        child.stderr.on('data', data => { stderr += data; });
        child.stdout.on('data', data => {
            stdout += data;
            const match = /(?:http:\/\/|监听地址：)(127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/.exec(stdout);
            if (match) { clearTimeout(timer); resolve({ child, host: match[1], url: `http://127.0.0.1:${match[2]}` }); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`启动提前结束：${code}\n${stderr}`)); });
    });
    const marker = path.join(target, '.running.json');
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
        assert.ok(Date.now() < deadline && child.exitCode === null && child.signalCode === null, '启动脚本未发布运行标记');
        await delay(25);
    }
    return listening;
}

test('部署和启动是不同入口，启动拒绝 Git 更新参数，Node 低版本被拒绝', async () => {
    assert.ok(existsSync(deploy), '需要独立的一键部署脚本');
    assert.ok(existsSync(start), '需要独立的一键启动脚本');
    successful(run(deploy, ['--help']));
    successful(run(start, ['--help']));
    assert.notEqual(run(start, ['--git']).status, 0);
    const { assertNodeVersion } = await import('../scripts/deployment-common.mjs');
    assert.throws(() => assertNodeVersion('22.15.0'), /24/);
    assert.doesNotThrow(() => assertNodeVersion('24.15.0'));
});

test('程序目录短暂占用结束后仍可完成替换', async t => {
    const directory = await fixture(t), source = path.join(directory, 'source'), target = path.join(directory, 'target');
    await mkdir(source);
    const child = spawn(process.execPath, ['-e', 'console.log("ready");setTimeout(()=>{},300)'], { cwd: source });
    const stopped = once(child, 'exit');
    try {
        await once(child.stdout, 'data');
        const { moveDirectory } = await import('../scripts/deployment-common.mjs');
        await moveDirectory(source, target);
        assert.equal(existsSync(source), false);
        assert.ok(existsSync(target));
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await stopped;
    }
});

test('启动在获得操作锁后读取最新部署配置', async t => {
    const directory = await fixture(t), target = path.join(directory, 'node');
    await mkdir(target);
    const fake = path.join(directory, 'fake-dsh.mjs'), preload = path.join(directory, 'schedule.mjs');
    await writeFile(fake, 'console.log(process.argv[2]);');
    const configFile = path.join(target, 'deployment.json');
    const config = { schemaVersion: 1, role: 'node', dshHome: directory, dshCommand: process.execPath, dshArgs: [fake, 'old-configuration'] };
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';const original=fs.promises.mkdir;let changed=false;fs.promises.mkdir=async function(file,...args){if(!changed&&path.resolve(file)===${JSON.stringify(target)}){changed=true;fs.writeFileSync(${JSON.stringify(configFile)},${JSON.stringify(JSON.stringify({ ...config, dshArgs: [fake, 'new-configuration'] }))});}return original.call(this,file,...args);};syncBuiltinESMExports();`);
    const result = successful(spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, start, '--target', target], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 15000 }));
    assert.match(result.stdout, /new-configuration/);
    assert.doesNotMatch(result.stdout, /old-configuration/);
});

test('平台入口实际调用不同脚本并传递退出状态', () => {
    if (process.platform === 'win32') {
        for (const name of ['deploy.cmd', 'start.cmd']) {
            const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `${name} --help`], { cwd: root, encoding: 'utf8' });
            successful(result);
            assert.match(result.stdout, name === 'deploy.cmd' ? /部署：/ : /启动已部署/);
        }
    }
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
    if (existsSync(shell)) {
        for (const name of ['deploy.sh', 'start.sh', 'deploy.command', 'start.command']) {
            const result = process.platform === 'win32'
                ? spawnSync(shell, [path.join(root, name), '--help'], { cwd: os.tmpdir(), encoding: 'utf8' })
                : spawnSync(path.join(root, name), ['--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
            successful(result);
            assert.match(result.stdout, name.startsWith('deploy') ? /部署：/ : /启动已部署/);
        }
    }
});

test('中央重复部署替换全部程序但保留数据库、账号和配置，启动不依赖源码', async t => {
    const { target, archive } = await deployCentral(t);
    const manifest = path.join(target, 'deployment.json');
    const config = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 0);
    await writeFile(path.join(target, 'app/obsolete.txt'), 'old program');
    await writeFile(path.join(config.dataDir, 'keep.txt'), '业务数据');
    successful(run(deploy, ['--role', 'central', '--target', target, '--package', archive], { env: { DSH_REVIEW_PASSWORD: '' } }));
    assert.equal(existsSync(path.join(target, 'app/obsolete.txt')), false);
    assert.equal(await readFile(path.join(config.dataDir, 'keep.txt'), 'utf8'), '业务数据');
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).port, 0);
    assert.doesNotMatch(await readFile(manifest, 'utf8'), /deployment-test-password/);
    const { url } = await launch(t, target);
    assert.equal((await (await fetch(`${url}/health`)).json()).service, 'dsh-review-central');
    assert.equal((await fetch(`${url}/api/v1/auth/session`)).status, 401);
    const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reviewer', password }) });
    assert.equal(login.status, 200);
    assert.equal((await fetch(url)).status, 200);
    assert.notEqual(run(start, ['--target', target]).status, 0);
    assert.notEqual(run(deploy, ['--role', 'central', '--target', target, '--package', archive]).status, 0);
});

test('独立中央以 HTTPS 公开地址默认监听外部网卡，缺省监听配置时仍须登录', async t => {
    const publicUrl = 'https://review.example.test';
    const { target } = await deployCentral(t, ['--public-url', publicUrl]);
    const manifest = path.join(target, 'deployment.json');
    const config = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(config.host, '0.0.0.0');
    await t.test('显式回环监听优先并继续要求登录', async t => {
        const { target: explicitTarget, archive } = await deployCentral(t, ['--public-url', publicUrl]);
        successful(run(deploy, ['--target', explicitTarget, '--package', archive, '--host', '127.0.0.1']));
        assert.equal(JSON.parse(await readFile(path.join(explicitTarget, 'deployment.json'), 'utf8')).host, '127.0.0.1');
        const explicit = await launch(t, explicitTarget);
        assert.equal(explicit.host, '127.0.0.1');
        assert.equal((await fetch(`${explicit.url}/api/v1/workbench`)).status, 401);
    });
    delete config.host;
    await writeFile(manifest, JSON.stringify(config));
    const { host, url } = await launch(t, target);
    assert.equal(host, '0.0.0.0');
    assert.equal((await fetch(`${url}/api/v1/workbench`)).status, 401);
    const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reviewer', password }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${url}/api/v1/workbench`, { headers: { cookie } })).status, 200);
});

test('安装失败不破坏旧部署，数据目录与程序重叠时拒绝', async t => {
    const { target, directory } = await deployCentral(t);
    const before = await readFile(path.join(target, 'deployment.json'), 'utf8');
    const invalid = path.join(directory, 'invalid.tgz');
    await writeFile(invalid, 'not a package');
    assert.notEqual(run(deploy, ['--target', target, '--package', invalid]).status, 0);
    assert.equal(await readFile(path.join(target, 'deployment.json'), 'utf8'), before);
    assert.ok(existsSync(path.join(target, 'app/node_modules/@dsh-review/server/dist/cli.js')));
    assert.notEqual(run(deploy, ['--target', target, '--data-dir', path.join(target, 'app/data'), '--package', invalid]).status, 0);
    assert.equal(existsSync(path.join(target, '.deploy.lock')), false);
    assert.notEqual(run(deploy, ['--target', root, '--package', invalid]).status, 0);
});

test('发布配置失败时恢复旧程序和全部启动文件', async t => {
    const { target, directory, archive } = await deployCentral(t);
    const files = ['scripts/start.mjs', 'scripts/deployment-common.mjs', 'start.cmd', 'start.sh', 'start.command'];
    const before = new Map();
    for (const name of files) {
        const file = path.join(target, name), marker = name.endsWith('.cmd') ? '\r\nrem old-version\r\n' : '\n';
        const content = (await readFile(file, 'utf8')) + marker;
        await writeFile(file, content);
        before.set(name, content);
    }
    const configFile = path.join(target, 'deployment.json'), config = await readFile(configFile, 'utf8');
    const sentinel = path.join(target, 'app/old-version.txt');
    await writeFile(sentinel, 'old app');
    const preload = path.join(directory, 'fail-publish.mjs');
    await writeFile(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';const original=fs.promises.rename;fs.promises.rename=async function(source,dest){if(path.resolve(dest)===${JSON.stringify(configFile)})throw Object.assign(new Error('test-publication-failure'),{code:'EACCES'});return original.call(this,source,dest);};syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, deploy, '--target', target, '--package', archive], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 180000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test-publication-failure/);
    for (const [name, content] of before) assert.equal(await readFile(path.join(target, name), 'utf8'), content);
    assert.equal(await readFile(sentinel, 'utf8'), 'old app');
    assert.equal(await readFile(configFile, 'utf8'), config);
    assert.equal(existsSync(path.join(target, '.deploy.lock')), false);
});

test('节点覆盖部署保留连接与执行记录，独立启动传递 DSH_HOME 和凭据环境', async t => {
    const directory = await fixture(t);
    const workspace = await createGitFixture();
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const target = path.join(directory, 'node'), home = path.join(directory, 'dsh-home');
    const fake = path.join(directory, 'fake-dsh.mjs'), output = path.join(directory, 'node-start.json');
    await writeFile(fake, `import fs from 'node:fs';fs.writeFileSync(process.argv[2],JSON.stringify({home:process.env.DSH_HOME,token:process.env.DSH_REVIEW_NODE_TOKEN}));`);
    const archive = (await packages()).node;
    successful(run(deploy, ['--role', 'node', '--target', target, '--package', archive, '--dsh-home', home, '--dsh', process.execPath,
        '--dsh-args', JSON.stringify([fake, output]), '--center-url', 'http://127.0.0.1:3081', '--node-id', 'node-a', '--workspace', workspace]));
    const managed = path.join(home, 'dsh-code-review/managed-node.json');
    const before = await readFile(managed, 'utf8');
    await mkdir(path.join(home, 'dsh-code-review/managed'), { recursive: true });
    await writeFile(path.join(home, 'dsh-code-review/managed/journal.sqlite'), '持久执行记录');
    successful(run(deploy, ['--role', 'node', '--target', target, '--package', archive]));
    assert.equal(await readFile(managed, 'utf8'), before);
    assert.equal(await readFile(path.join(home, 'dsh-code-review/managed/journal.sqlite'), 'utf8'), '持久执行记录');
    successful(run(path.join(target, 'scripts/start.mjs'), [], { cwd: os.tmpdir(), env: { DSH_REVIEW_NODE_TOKEN: 'test-node-token' } }));
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { home, token: 'test-node-token' });
    assert.doesNotMatch(await readFile(path.join(target, 'deployment.json'), 'utf8'), /test-node-token/);
});

test('沿用节点配置时拒绝覆盖 app 内的业务工作副本', async t => {
    const directory = await fixture(t), target = path.join(directory, 'node'), home = path.join(directory, 'home');
    const workspace = path.join(target, 'app/workspace');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(home, 'dsh-code-review'), { recursive: true });
    const sentinel = path.join(workspace, 'business.txt');
    await writeFile(sentinel, '必须保留');
    const managedFile = path.join(home, 'dsh-code-review/managed-node.json');
    const managed = JSON.stringify({ centerUrl: 'http://127.0.0.1:3081', nodeId: 'node-a', tokenReference: 'DSH_REVIEW_NODE_TOKEN',
        workspaces: [{ workspaceId: 'existing', root: workspace }] });
    await writeFile(managedFile, managed);
    const configFile = path.join(target, 'deployment.json');
    const config = JSON.stringify({ schemaVersion: 1, role: 'node', dshHome: home, dshCommand: process.execPath, dshArgs: [] });
    await writeFile(configFile, config);
    const result = run(deploy, ['--target', target, '--package', path.join(directory, 'not-needed.tgz')]);
    assert.notEqual(result.status, 0, '既有工作副本也必须通过覆盖路径检查');
    assert.match(result.stderr, /不能.*app/);
    assert.equal(await readFile(sentinel, 'utf8'), '必须保留');
    assert.equal(await readFile(managedFile, 'utf8'), managed);
    assert.equal(await readFile(configFile, 'utf8'), config);
});

test('--git 每次获取仓库最新提交并部署新产物', async t => {
    const directory = await fixture(t), repository = path.join(directory, 'remote'), target = path.join(directory, 'git-deploy');
    await mkdir(path.join(repository, 'apps/server'), { recursive: true });
    await mkdir(path.join(repository, 'scripts'), { recursive: true });
    for (const name of ['start.cmd', 'start.sh', 'start.command', 'scripts/start.mjs', 'scripts/deployment-common.mjs']) {
        await copyFile(path.join(root, name), path.join(repository, name));
    }
    const remoteStart = path.join(repository, 'scripts/start.mjs'), launcher = await readFile(remoteStart, 'utf8');
    await writeFile(remoteStart, `${launcher}\nexport const launcherGeneration = '0.1.1';\n`);
    await copyFile((await packages()).central, path.join(repository, 'payload.tgz'));
    const manifest = { name: 'deploy-git-fixture', version: '1.0.0', private: true, type: 'module', scripts: { 'pack:central': 'node build.mjs' } };
    await writeFile(path.join(repository, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(repository, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version } } }));
    await writeFile(path.join(repository, 'build.mjs'), `import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.mkdirSync('build',{recursive:true});fs.mkdirSync('dist',{recursive:true});execFileSync('tar',['-xzf','payload.tgz','-C','build']);const p=JSON.parse(fs.readFileSync('build/package/package.json'));p.version=JSON.parse(fs.readFileSync('apps/server/package.json')).version;fs.writeFileSync('build/package/package.json',JSON.stringify(p));fs.writeFileSync('build/package/dist/generation.txt',p.version);execFileSync(process.execPath,[process.env.npm_execpath,'pack','--ignore-scripts','--workspaces=false','--pack-destination','../../dist'],{cwd:'build/package'});`);
    await writeFile(path.join(repository, 'apps/server/package.json'), JSON.stringify({ name: '@dsh-review/server', version: '0.1.1' }));
    runCommand('git', ['init', '-q', '-b', 'master'], repository);
    runCommand('git', ['add', '.'], repository);
    runCommand('git', ['commit', '-qm', 'first'], repository);
    successful(run(deploy, ['--git', '--repository', repository, '--target', target, '--port', '0']));
    const generation = path.join(target, 'app/node_modules/@dsh-review/server/dist/generation.txt');
    assert.equal(await readFile(generation, 'utf8'), '0.1.1');
    assert.match(await readFile(path.join(target, 'scripts/start.mjs'), 'utf8'), /launcherGeneration = '0.1.1'/);
    await writeFile(path.join(repository, 'apps/server/package.json'), JSON.stringify({ name: '@dsh-review/server', version: '0.1.2' }));
    await writeFile(remoteStart, `${launcher}\nexport const launcherGeneration = '0.1.2';\n`);
    runCommand('git', ['add', '.'], repository);
    runCommand('git', ['commit', '-qm', 'second'], repository);
    const head = runCommand('git', ['rev-parse', 'HEAD'], repository).stdout.trim();
    successful(run(deploy, ['--git', '--repository', repository, '--target', target], { env: { DSH_REVIEW_PASSWORD: '' } }));
    assert.equal(await readFile(generation, 'utf8'), '0.1.2');
    assert.match(await readFile(path.join(target, 'scripts/start.mjs'), 'utf8'), /launcherGeneration = '0.1.2'/);
    assert.equal(JSON.parse(await readFile(path.join(target, 'deployment.json'), 'utf8')).sourceRevision, head);
});
