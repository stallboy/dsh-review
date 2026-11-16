#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createCentralApp } from './app.js';
import { CentralDatabase } from './database.js';

async function main(): Promise<void> {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
        'data-dir': { type: 'string' }, username: { type: 'string' }, 'review-identity': { type: 'string' },
        name: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '3081' }, 'public-url': { type: 'string' },
    } });
    const command = positionals[0] ?? 'serve';
    const dataDir = path.resolve(values['data-dir'] ?? process.env['DSH_REVIEW_DATA_DIR'] ?? path.join(os.homedir(), '.dsh-review-central'));
    if (command === 'user-add' || command === 'node-add') {
        const database = new CentralDatabase(dataDir);
        try {
            if (command === 'user-add') {
                const password = process.env['DSH_REVIEW_PASSWORD'];
                if (!password || !values.username || !values['review-identity']) throw new Error('需要 --username、--review-identity 及环境变量 DSH_REVIEW_PASSWORD');
                console.log(JSON.stringify(database.createUser({ username: values.username, reviewIdentity: values['review-identity'], password })));
            } else {
                if (!values.name) throw new Error('需要 --name 节点名称');
                console.log(JSON.stringify(database.createNode(values.name)));
            }
        } finally { database.close(); }
        return;
    }
    if (command !== 'serve') throw new Error('命令须为 serve、user-add 或 node-add');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
    const host = values.host!;
    const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const publicUrl = values['public-url'] ? new URL(values['public-url']) : undefined;
    if (!local && publicUrl?.protocol !== 'https:') throw new Error('跨机器部署需要 --public-url https://...，并配置 TLS 反向代理');
    const app = await createCentralApp({ dataDir, secureCookies: publicUrl?.protocol === 'https:' });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
    const address = await app.listen({ host, port });
    console.log(`DSH 评审中央服务：${publicUrl?.href ?? address}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : '中央服务启动失败');
    process.exitCode = 1;
});
