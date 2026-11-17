import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ask, assertNodeVersion, assertStopped, canonical, contains, defaultTarget, execute, moveDirectory, npm, operationLock, readJson, writeJson } from './deployment-common.mjs';

const scriptRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const stringOptions = ['role', 'target', 'package', 'repository', 'branch', 'data-dir', 'host', 'port', 'public-url', 'username', 'review-identity',
    'dsh-home', 'dsh', 'dsh-args', 'center-url', 'node-id', 'workspace', 'workspace-id', 'token-reference'];

function independentData(target, directory) {
    const app = canonical(path.join(target, 'app'));
    const data = canonical(directory);
    if (contains(app, data) || contains(data, app)) throw new Error('数据/状态目录不能与被覆盖的 app 程序目录重叠');
    return data;
}

async function centralConfig(values, previous, target) {
    const host = values.host ?? previous?.host ?? '127.0.0.1';
    const port = Number(values.port ?? previous?.port ?? 3081);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口须为 0～65535 的整数');
    const publicUrl = values['public-url'] ?? previous?.publicUrl ?? '';
    if (publicUrl && new URL(publicUrl).protocol !== 'https:') throw new Error('public-url 必须使用 HTTPS');
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !publicUrl) throw new Error('非回环地址必须配置 --public-url https://... 和 TLS 反向代理');
    return { schemaVersion: 1, role: 'central', dataDir: independentData(target, values['data-dir'] ?? previous?.dataDir ?? path.join(target, 'data')),
        host, port, publicUrl };
}

async function nodeConfig(values, previous, target) {
    const dshHome = independentData(target, values['dsh-home'] ?? previous?.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
    const managedFile = path.join(dshHome, 'dsh-code-review/managed-node.json');
    const existing = await readJson(managedFile);
    const centerUrl = values['center-url'] ?? existing?.centerUrl ?? await ask('中央服务地址');
    const url = new URL(centerUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
        throw new Error('中央地址须为 HTTPS，回环开发地址可用 HTTP，不能包含凭据、查询或片段');
    }
    const nodeId = values['node-id'] ?? existing?.nodeId ?? await ask('中央生成的节点 ID');
    if (!/^[\w-]+$/.test(nodeId)) throw new Error('节点 ID 无效');
    if (existing && (existing.nodeId !== nodeId || new URL(existing.centerUrl).href !== url.href)) throw new Error('不能在覆盖部署时替换既有节点身份，请先处理原执行记录并使用独立 DSH_HOME');
    const managed = structuredClone(existing ?? { centerUrl, nodeId, tokenReference: 'DSH_REVIEW_NODE_TOKEN', workspaces: [] });
    if (values['token-reference']) managed.tokenReference = values['token-reference'];
    if (values.workspace || !managed.workspaces?.length) {
        const root = canonical(values.workspace ?? await ask('业务工作副本根目录'));
        if (!(await stat(root)).isDirectory()) throw new Error('工作副本不是目录');
        independentData(target, root);
        const workspaceId = values['workspace-id'] ?? managed.workspaces?.[0]?.workspaceId ?? 'workspace-1';
        if (!/^[\w-]+$/.test(workspaceId)) throw new Error('workspace-id 无效');
        const old = managed.workspaces.find(workspace => workspace.workspaceId === workspaceId);
        if (old && canonical(old.root) !== root) throw new Error('既有 workspaceId 不能改指其他目录，请使用新的 --workspace-id');
        if (!old) managed.workspaces.push({ workspaceId, label: path.basename(root), root, settings: { runner: 'dsh' } });
    }
    for (const workspace of managed.workspaces) independentData(target, workspace.root);
    const dshCommand = values.dsh ?? previous?.dshCommand ?? await ask('DSH 原生启动程序或 Node.js CLI 路径');
    const dshArgs = values['dsh-args'] ? JSON.parse(values['dsh-args']) : previous?.dshArgs ?? [];
    if (!Array.isArray(dshArgs) || dshArgs.some(value => typeof value !== 'string')) throw new Error('dsh-args 须为 JSON 字符串数组');
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(dshCommand)) throw new Error('DSH 须使用原生 .exe 或 Node.js .js 入口');
    const config = { schemaVersion: 1, role: 'node', dshHome, dshCommand: path.resolve(dshCommand), dshArgs };
    if (!existsSync(config.dshCommand)) throw new Error('DSH 启动程序不存在');
    return { config, managed, managedFile, existing };
}

async function bootstrap(app, config, values) {
    const { CentralDatabase } = await import(pathToFileURL(path.join(app, 'node_modules/@dsh-review/server/dist/database.js')).href);
    const database = new CentralDatabase(config.dataDir);
    try {
        if (database.sql.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
        const password = process.env.DSH_REVIEW_PASSWORD || await ask('首次部署登录密码（12～256 字符，可用 DSH_REVIEW_PASSWORD）', '', true);
        database.createUser({ username: values.username ?? 'reviewer', reviewIdentity: values['review-identity'] ?? values.username ?? 'reviewer', password });
        console.log(`已初始化账号 ${values.username ?? 'reviewer'}，密码不保存到部署配置。`);
    } finally { database.close(); }
}

async function sourcePackage(values, role) {
    let source = scriptRoot, temporary;
    try {
        if (values.git) {
            const repository = values.repository ?? 'https://github.com/stallboy/dsh-review.git';
            if (/^https?:\/\//i.test(repository)) {
                const url = new URL(repository);
                if (url.username || url.password) throw new Error('仓库 URL 不能内嵌凭据，请使用 Git 凭据管理器');
            }
            temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-source-'));
            source = path.join(temporary, 'source');
            console.log('正在获取仓库最新源码…');
            execute('git', ['clone', '--depth', '1', '--branch', values.branch ?? 'master', '--', repository, source], temporary);
        }
        if (values.package) return { archive: canonical(values.package), launcherRoot: scriptRoot, cleanup: async () => {} };
        console.log('正在安装构建依赖并构建部署包…');
        npm(['ci', '--no-audit', '--no-fund', '--cache', '.npm-cache'], source);
        npm(['run', role === 'central' ? 'pack:central' : 'pack:plugin'], source);
        const manifest = await readJson(path.join(source, role === 'central' ? 'apps/server/package.json' : 'packages/dsh-plugin/package.json'));
        const name = `${manifest.name.replace('@', '').replaceAll('/', '-')}-${manifest.version}.tgz`;
        const sourceRevision = values.git ? execute('git', ['rev-parse', 'HEAD'], source).trim() : null;
        return { archive: path.join(source, 'dist', name), launcherRoot: source, sourceRevision, cleanup: async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); } };
    } catch (error) { if (temporary) await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function prepareLaunchers(source, target) {
    const directory = await mkdtemp(path.join(target, '.launchers-stage-'));
    const entries = [];
    let preserve = false;
    try {
        for (const name of ['scripts/start.mjs', 'scripts/deployment-common.mjs', 'start.cmd', 'start.sh', 'start.command']) {
            const file = path.join(target, name), next = path.join(directory, 'new', name), previous = path.join(directory, 'old', name);
            const existed = existsSync(file);
            if (existed && !(await stat(file)).isFile()) throw new Error(`启动文件不是普通文件：${file}`);
            await mkdir(path.dirname(next), { recursive: true });
            await cp(path.join(source, name), next);
            if (existed) { await mkdir(path.dirname(previous), { recursive: true }); await cp(file, previous); }
            entries.push({ file, next, previous, existed, changed: false });
        }
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return {
        async publish() {
            for (const entry of entries) {
                await mkdir(path.dirname(entry.file), { recursive: true });
                entry.changed = true;
                await cp(entry.next, entry.file);
            }
        },
        async restore() {
            const results = await Promise.allSettled(entries.filter(entry => entry.changed).map(entry => entry.existed
                ? cp(entry.previous, entry.file) : rm(entry.file, { force: true })));
            const failures = results.filter(result => result.status === 'rejected');
            if (failures.length) {
                preserve = true;
                throw new Error(`启动文件恢复不完整，备份保留在 ${directory}：${failures.map(result => result.reason.message).join('；')}`);
            }
        },
        async cleanup() { if (!preserve) await rm(directory, { recursive: true, force: true }); },
    };
}

async function main() {
    assertNodeVersion();
    const options = Object.fromEntries(stringOptions.map(name => [name, { type: 'string' }]));
    const { values } = parseArgs({ options: { ...options, git: { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('部署：deploy --role central|node [--target <目录>] [--git [--repository <仓库> --branch <分支>] | --package <tgz>]');
        console.log('中央：--data-dir --host --port --public-url --username --review-identity；密码从 DSH_REVIEW_PASSWORD 或交互输入读取。');
        console.log('节点：--dsh-home --dsh --dsh-args <JSON数组> --center-url --node-id --workspace --workspace-id --token-reference。');
        console.log('部署只替换程序，保留数据和配置；启动请单独运行 start。需要 Node.js >=24。');
        return;
    }
    if (values.git && values.package) throw new Error('--git 与 --package 不能同时使用');
    if (!values.git && (values.repository || values.branch)) throw new Error('--repository/--branch 只能与 --git 一起使用');
    const guessedTarget = values.target ? canonical(values.target) : null;
    const previous = guessedTarget ? await readJson(path.join(guessedTarget, 'deployment.json')) : null;
    const role = values.role ?? previous?.role ?? (process.stdin.isTTY ? await ask('部署类型 central/node', 'central') : 'central');
    if (!['central', 'node'].includes(role)) throw new Error('role 须为 central 或 node');
    const target = guessedTarget ?? canonical(defaultTarget(role));
    let old = previous ?? await readJson(path.join(target, 'deployment.json'));
    if (path.dirname(target) === target || contains(scriptRoot, target) || contains(target, scriptRoot)) throw new Error('部署目标不能是源码目录、其父子目录或磁盘根目录');
    if (old && (old.schemaVersion !== 1 || old.role !== role)) throw new Error('已有部署的角色或配置版本不兼容');
    if (!old && existsSync(path.join(target, 'app'))) throw new Error('目标含有未识别的 app 目录，不能覆盖');
    const release = await operationLock(target);
    let source, stage, backup, launchers, published = false, node;
    const app = path.join(target, 'app');
    try {
        await assertStopped(target);
        old = await readJson(path.join(target, 'deployment.json'));
        if (old && (old.schemaVersion !== 1 || old.role !== role)) throw new Error('已有部署的角色或配置版本不兼容');
        const config = role === 'central' ? await centralConfig(values, old, target) : (node = await nodeConfig(values, old, target)).config;
        source = await sourcePackage(values, role);
        if (!(await stat(source.archive)).isFile()) throw new Error('安装包不存在或不是文件');
        stage = await mkdtemp(path.join(target, '.deploy-stage-'));
        await writeFile(path.join(stage, 'package.json'), '{"private":true,"type":"module"}\n');
        npm(['install', source.archive, '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(stage, '.npm-cache')], stage);
        const installed = role === 'central' ? '@dsh-review/server' : 'dsh-code-review';
        const manifest = await readJson(path.join(stage, 'node_modules', installed, 'package.json'));
        if (!manifest || manifest.name !== installed) throw new Error('安装包与所选部署角色不匹配');
        launchers = await prepareLaunchers(source.launcherRoot, target);
        if (role === 'central') await bootstrap(stage, config, values);
        await rm(path.join(stage, '.npm-cache'), { recursive: true, force: true });
        if (existsSync(app)) { backup = path.join(target, `.app-previous-${randomUUID()}`); await moveDirectory(app, backup); }
        try {
            await moveDirectory(stage, app);
            stage = null;
            published = true;
            await launchers.publish();
            if (node && JSON.stringify(node.managed) !== JSON.stringify(node.existing)) await writeJson(node.managedFile, node.managed);
            await writeJson(path.join(target, 'deployment.json'), { ...config, packageVersion: manifest.version, sourceRevision: source.sourceRevision ?? null });
        } catch (error) {
            try {
                try {
                    if (published) await rm(app, { recursive: true, force: true });
                    if (backup) { await moveDirectory(backup, app); backup = null; }
                } finally {
                    try { await launchers.restore(); }
                    finally {
                        if (node && JSON.stringify(node.managed) !== JSON.stringify(node.existing)) {
                            if (node.existing) await writeJson(node.managedFile, node.existing);
                            else await rm(node.managedFile, { force: true });
                        }
                    }
                }
            } catch (recoveryError) {
                throw new Error(`部署发布失败：${error.message}；恢复未完成：${recoveryError.message}；请保留备份 ${backup ?? target}`);
            }
            throw error;
        }
        if (backup) { await rm(backup, { recursive: true, force: true }); backup = null; }
        console.log(`部署完成：${target}\n启动请单独运行该目录下的 start.cmd / start.sh / start.command。`);
        if (role === 'node') console.log(`首次请在 DSH 插件管理器启用：${path.join(app, 'node_modules/dsh-code-review')}\n连接凭据由 tokenReference 解析；部署完成不代表节点已在线。`);
    } finally {
        try {
            const results = await Promise.allSettled([stage ? rm(stage, { recursive: true, force: true }) : undefined, launchers?.cleanup(), source?.cleanup()]);
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        } finally { await release(); }
    }
}

main().catch(error => { console.error(`部署失败：${error.message}`); process.exitCode = 1; });
