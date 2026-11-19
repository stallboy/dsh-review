import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTRAL_ARCHIVE_PATH, CENTRAL_VERSION_PATH, servePreviewMarket } from './preview-market.mjs';

const workspaces = {
    plugin: { name: 'dsh-code-review', directory: 'packages/dsh-plugin' },
    central: { name: '@dsh-review/server', directory: 'apps/server' },
};
const mode = process.argv[2];
const args = process.argv.slice(3);
const preview = mode === 'plugin-local-preview';
const lightweight = preview && args.length === 1 && args[0] === '--lightweight';
const downloadable = mode === 'plugin-downloadable';
const local = (preview && !lightweight) || mode === 'plugin-local';
const workspace = workspaces[local || lightweight || downloadable ? 'plugin' : mode];
if (!workspace || !process.env.npm_execpath) throw new Error('请通过 npm run pack:plugin、npm run pack:central、npm run pack:local、npm run pack:downloadable 或 npm run preview:market 打包');
if (preview && args.length && !lightweight) throw new Error('用法：npm run preview:market -- --lightweight，省略参数则预览整合包');

function releaseUrl(input) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
        throw new Error('下载版须使用公开的 HTTPS 附件目录和版本文件地址');
    }
    return url;
}

if (downloadable && args.length !== 2) throw new Error('用法：npm run pack:downloadable -- <HTTPS 附件目录> <HTTPS 版本文件 URL>');
const releaseBase = downloadable ? releaseUrl(args[0]) : null;
const releaseVersion = downloadable ? releaseUrl(args[1]) : null;
if (releaseBase && !releaseBase.pathname.endsWith('/')) releaseBase.pathname += '/';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const destination = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(destination, { recursive: true });

function npm(args, cwd) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout;
}

async function stageWorkspace(workspace, stage) {
    const source = path.join(root, workspace.directory);
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    for (const entry of ['package.json', ...manifest.files]) {
        await cp(path.join(source, entry), path.join(stage, entry), { recursive: true });
    }
    const modules = path.join(root, 'node_modules');
    const dependencies = npm(['ls', '--all', '--omit=dev', '--parseable', '--workspace', workspace.name], root).trim().split(/\r?\n/);
    for (const directory of dependencies) {
        if (directory === root || directory === path.join(modules, workspace.name)) continue;
        const relative = path.relative(modules, directory);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`运行依赖不在 node_modules 内：${directory}`);
        await cp(directory, path.join(stage, 'node_modules', relative), { recursive: true, dereference: true });
    }
    return manifest;
}

const scratch = path.join(root, '.tmp');
await mkdir(scratch, { recursive: true });
const stage = await mkdtemp(path.join(scratch, 'pack-'));

function pack(directory, output) {
    return npm(['pack', '--workspaces=false', '--pack-destination', output,
        '--ignore-scripts', '--json', '--cache', path.join(root, '.npm-cache')], directory);
}

async function packWithRuntimeSource(plugin, manifest) {
    const central = path.join(stage, 'central');
    const { version } = await stageWorkspace(workspaces.central, central);
    const [centralPackage] = JSON.parse(pack(central, destination));
    const archive = await readFile(path.join(destination, centralPackage.filename));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    delete manifest.private;
    await writeFile(path.join(plugin, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);

    async function packPlugin(url, versionUrl) {
        const source = { version, size: archive.length, sha256, url, versionUrl };
        await writeFile(path.join(plugin, 'assets', 'central-runtime-source.json'), `${JSON.stringify(source, null, 4)}\n`);
        const [packed] = JSON.parse(pack(plugin, stage));
        return packed.filename;
    }

    if (lightweight) {
        const { origin } = await servePreviewMarket(manifest, async origin => {
            const filename = await packPlugin(origin + CENTRAL_ARCHIVE_PATH, origin + CENTRAL_VERSION_PATH);
            return readFile(path.join(stage, filename));
        }, { version, archive });
        console.log(`DSH 市场预览索引：${origin}/index.json`);
        return;
    }

    const filename = await packPlugin(new URL(centralPackage.filename, releaseBase).href, releaseVersion.href);
    const artifact = `dsh-code-review-downloadable-${manifest.version}.tgz`;
    await rename(path.join(stage, filename), path.join(destination, artifact));
    const versionFile = 'dsh-review-central-version.json';
    await writeFile(path.join(destination, versionFile), `${JSON.stringify({ version }, null, 4)}\n`);
    console.log([artifact, centralPackage.filename, versionFile].map(name => path.join(destination, name)).join('\n'));
}

let previewPackage;
try {
    const directory = path.join(stage, 'package');
    const manifest = await stageWorkspace(workspace, directory);
    if (lightweight || downloadable) {
        await packWithRuntimeSource(directory, manifest);
    } else {
        if (local) {
            await stageWorkspace(workspaces.central, path.join(directory, 'central-runtime', 'server'));
            delete manifest.private;
            manifest.files = [...manifest.files, 'central-runtime'];
            await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
        }
        const packDestination = local ? stage : destination;
        let output = pack(directory, packDestination);
        if (local) {
            const packed = JSON.parse(output);
            const filename = `dsh-code-review-local-${manifest.version}.tgz`;
            const archivePath = path.join(packDestination, packed[0].filename);
            if (preview) previewPackage = { manifest, archive: await readFile(archivePath) };
            await rename(archivePath, path.join(destination, filename));
            packed[0].filename = filename;
            output = `${JSON.stringify(packed, null, 4)}\n`;
        }
        process.stdout.write(output);
    }
} finally {
    await rm(stage, { recursive: true, force: true });
}
if (previewPackage) {
    const { origin } = await servePreviewMarket(previewPackage.manifest, previewPackage.archive);
    console.log(`DSH 市场预览索引：${origin}/index.json`);
}
