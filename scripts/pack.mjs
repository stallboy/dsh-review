import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = {
    plugin: { name: 'dsh-code-review', directory: 'packages/dsh-plugin' },
    central: { name: '@dsh-review/server', directory: 'apps/server' },
}[process.argv[2]];
if (!workspace || !process.env.npm_execpath) throw new Error('请通过 npm run pack:plugin 或 npm run pack:central 打包');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const destination = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(destination, { recursive: true });

function npm(args, cwd) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout;
}

const scratch = path.join(root, '.tmp');
await mkdir(scratch, { recursive: true });
const stage = await mkdtemp(path.join(scratch, 'pack-'));
try {
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
    process.stdout.write(npm(['pack', '--workspaces=false', '--pack-destination', destination,
        '--ignore-scripts', '--json', '--cache', path.join(root, '.npm-cache')], stage));
} finally {
    await rm(stage, { recursive: true, force: true });
}
