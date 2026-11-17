import { entityId, record, textValue } from '@dsh-review/protocol';
import { createCentralApp, type CentralApp } from './app.js';
import { CentralError } from './database.js';

let app: CentralApp | undefined;
let startup: Promise<void> | undefined;
let stopping = false;

async function send(message: Record<string, unknown>): Promise<void> {
    if (!process.connected || !process.send) return;
    await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
}

async function stop(code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const deadline = setTimeout(() => process.exit(code), 5000);
    deadline.unref();
    try {
        await startup?.catch(() => {});
        await app?.close();
    } catch { process.exitCode = 1; }
    finally {
        if (process.connected) process.disconnect();
        clearTimeout(deadline);
    }
}

async function start(value: unknown): Promise<void> {
    const input = record(value, 'start');
    if (input.type !== 'start') throw new CentralError(422, 'bad_request', '启动消息无效');
    const dataDir = textValue(input.dataDir, 'dataDir', 4096);
    const reviewIdentity = textValue(input.reviewIdentity, 'reviewIdentity', 160);
    const password = textValue(input.password, 'password', 256);
    let node: { nodeId: string; token: string } | undefined;
    if (input.node !== undefined) {
        const credential = record(input.node, 'node');
        node = { nodeId: entityId(credential.nodeId, 'nodeId'), token: textValue(credential.token, 'token', 256) };
    }
    app = await createCentralApp({ dataDir });
    if (stopping) return;
    const credential = app.database.initializeOwned({ reviewIdentity, password, node });
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    if (!stopping) await send({ type: 'ready', centerUrl, centralId: app.database.centralId, ...credential });
}

if (!process.connected || !process.send) process.exitCode = 1;
else {
    process.once('disconnect', () => { void stop(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
    process.on('message', value => {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'stop') { void stop(); return; }
        if (startup || stopping) return;
        startup = start(value);
        void startup.catch(async error => {
            try { await send({ type: 'error', code: error instanceof CentralError ? error.code : 'startup_failed', message: '本机中央启动失败，请检查配置与本机数据' }); }
            finally { await stop(1); }
        }).catch(() => { process.exitCode = 1; });
    });
}
