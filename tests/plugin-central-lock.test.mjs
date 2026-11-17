import assert from 'node:assert/strict';
import fs from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConnectionController } from '../packages/dsh-plugin/dist/connection/controller.js';

test('同时恢复失效锁时至多一个实例取得配置所有权', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-stale-lock-'));
    const filename = path.join(directory, 'connection.lock');
    const originalUnlink = fs.promises.unlink, originalKill = process.kill;
    const context = new AsyncLocalStorage();
    let a, b, releaseB, releaseA;
    const waitB = new Promise(resolve => { releaseB = resolve; });
    const waitA = new Promise(resolve => { releaseA = resolve; });
    try {
        await writeFile(filename, JSON.stringify({ pid: 2147483647 }));
        process.kill = function (pid, signal) {
            if (pid === 2147483647 && signal === 0) throw Object.assign(new Error('fixture process exited'), { code: 'ESRCH' });
            return originalKill.call(process, pid, signal);
        };
        fs.promises.unlink = async function (file) {
            if (file === filename && context.getStore() === 'A') await waitB;
            if (file === filename && context.getStore() === 'B') { releaseB(); await waitA; }
            return originalUnlink(file);
        };
        syncBuiltinESMExports();
        a = new ConnectionController({ directory, candidates: async () => [] });
        b = new ConnectionController({ directory, candidates: async () => [] });
        const outcomes = await Promise.allSettled([
            context.run('A', () => a.acquire()).finally(() => releaseA()),
            context.run('B', () => b.acquire()),
        ]);
        assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    } finally {
        fs.promises.unlink = originalUnlink;
        process.kill = originalKill;
        syncBuiltinESMExports();
        await a?.stop();
        await b?.stop();
        await rm(directory, { recursive: true, force: true });
    }
});

test('活动进程互斥且进程异常退出后自动释放所有权', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-owner-process-'));
    const filename = path.join(directory, 'connection-owner.sqlite');
    const source = "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.on('message',()=>{}); process.send({ready:true});";
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, filename], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const contender = new ConnectionController({ directory, candidates: async () => [] });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('锁进程未就绪')), 5000);
            child.once('message', () => { clearTimeout(timer); resolve(); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
        });
        await assert.rejects(contender.acquire(), /已有活动中央连接/);
        child.kill();
        await exited;
        await contender.acquire();
        const other = new ConnectionController({ directory, candidates: async () => [] });
        try { await assert.rejects(other.acquire(), /已有活动中央连接/); }
        finally { await other.stop(); }
        await access(filename);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        await contender.stop();
        await rm(directory, { recursive: true, force: true });
    }
});
