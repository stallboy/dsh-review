import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertNodeVersion, assertStopped, defaultTarget, operationLock, readJson, writeJson } from './deployment-common.mjs';

async function main() {
    assertNodeVersion();
    const { values } = parseArgs({ options: { help: { type: 'boolean' }, target: { type: 'string' }, role: { type: 'string' } } });
    if (values.help) {
        console.log('启动已部署程序：start --target <部署目录> [--role central|node]。启动不会部署、构建或更新 Git。');
        return;
    }
    const ownRoot = fileURLToPath(new URL('../', import.meta.url));
    const target = path.resolve(values.target ?? (existsSync(path.join(ownRoot, 'deployment.json')) ? ownRoot : defaultTarget(values.role ?? 'central')));
    if (!existsSync(path.join(target, 'deployment.json'))) throw new Error('尚未找到有效部署，请先执行 deploy 脚本');
    const release = await operationLock(target);
    let running = false, locked = true;
    try {
        const config = await readJson(path.join(target, 'deployment.json'));
        if (!config || config.schemaVersion !== 1 || !['central', 'node'].includes(config.role)) throw new Error('尚未找到有效部署，请先执行 deploy 脚本');
        if (values.role && values.role !== config.role) throw new Error('指定角色与部署配置不一致');
        await assertStopped(target);
        const cli = path.join(target, 'app/node_modules/@dsh-review/server/dist/cli.js');
        let command = process.execPath;
        let args = ['serve', '--data-dir', config.dataDir, '--port', String(config.port)];
        if (config.host !== undefined) args.push('--host', config.host);
        if (config.publicUrl) args.push('--public-url', config.publicUrl);
        if (config.role === 'central') {
            if (!existsSync(cli)) throw new Error('中央程序不完整，请重新部署');
            args.unshift(cli);
        } else {
            command = config.dshCommand;
            args = config.dshArgs ?? [];
            if (!command || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('DSH 启动配置无效');
            if (/\.(?:c?js|mjs)$/i.test(command)) { args = [command, ...args]; command = process.execPath; }
            else if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error('请将 DSH 启动程序配置为原生 .exe 或 Node.js .js 入口，不通过 shell 拼接参数');
        }
        const child = spawn(command, args, { cwd: target, stdio: 'inherit', windowsHide: config.role === 'central',
            env: { ...process.env, ...(config.role === 'node' ? { DSH_HOME: config.dshHome } : {}) } });
        const forward = signal => { if (child.exitCode === null) child.kill(signal); };
        const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1))); });
        finished.catch(() => {});
        try {
            if (!child.pid) return await finished;
            await writeJson(path.join(target, '.running.json'), { pid: process.pid, childPid: child.pid });
            running = true;
            await release();
            locked = false;
            process.exitCode = await finished;
        } finally {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            if (child.exitCode === null) child.kill();
            if (running) await rm(path.join(target, '.running.json'), { force: true });
        }
    } finally { if (locked) await release(); }
}

main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
