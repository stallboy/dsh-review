import { existsSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export function assertNodeVersion(version = process.versions.node) {
    if (Number(version.split('.')[0]) < 24) throw new Error(`需要 Node.js 24 或更新版本，当前为 ${version}`);
}

export const defaultTarget = role => path.join(os.homedir(), 'dsh-review', role);

export async function readJson(file, fallback = null) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
}

export async function moveDirectory(source, target) {
    for (let attempt = 0; ; attempt++) {
        try { await rename(source, target); return; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 5) throw error;
            await delay(100 * (attempt + 1));
        }
    }
}

export function contains(parent, child) {
    const relative = path.relative(parent, child);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function canonical(file) {
    const resolved = path.resolve(file);
    return existsSync(resolved) ? realpathSync(resolved) : path.join(canonical(path.dirname(resolved)), path.basename(resolved));
}

export function execute(command, args, cwd, env = process.env) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw new Error(`无法执行 ${path.basename(command)}：${result.error.message}`);
    if (result.status !== 0) throw new Error(`${path.basename(command)} 执行失败（${result.status}）\n${result.stderr || result.stdout}`);
    return result.stdout;
}

export function npm(args, cwd) {
    const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        const file = path.join(directory, 'npm');
        if (existsSync(file)) candidates.push(realpathSync(file));
    }
    const cli = candidates.find(file => file && /\.(?:c?js|mjs)$/.test(file) && existsSync(file));
    if (!cli) throw new Error('未找到 npm CLI，请确认 Node.js/npm 已完整安装');
    return execute(process.execPath, [cli, ...args], cwd);
}

export async function ask(question, fallback = '', secret = false) {
    if (!process.stdin.isTTY) {
        if (fallback) return fallback;
        throw new Error(`缺少配置：${question}，请通过命令参数或环境变量提供`);
    }
    const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
    if (secret) process.stdout.write(`${question}：`);
    const reader = createInterface({ input: process.stdin, output, terminal: true });
    try {
        const value = await reader.question(secret ? '' : `${question}${fallback ? ` [${fallback}]` : ''}：`);
        return (secret ? value : value.trim()) || fallback;
    }
    finally { reader.close(); if (secret) process.stdout.write('\n'); }
}

export async function operationLock(target) {
    await mkdir(target, { recursive: true });
    let handle;
    const file = path.join(target, '.deploy.lock');
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error(`另一次部署或启动正在操作该目录；若曾中断，请先确认旧进程停止，再移除 ${file}`);
        throw error;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return async () => { await handle.close(); await rm(file, { force: true }); };
}

export async function assertStopped(target) {
    const file = path.join(target, '.running.json');
    const record = await readJson(file);
    if (!record) return;
    for (const pid of [record.pid, record.childPid]) {
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('启动记录无效，请核验旧进程');
        try { process.kill(pid, 0); throw new Error('程序仍在运行，请先停止后再启动或部署'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(file);
}
