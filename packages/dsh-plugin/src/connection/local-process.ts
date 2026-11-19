import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface LocalReady {
    centerUrl: string;
    centralId: string;
    nodeId: string;
    token: string;
    localAccess?: true;
}

export class LocalCentralProcess {
    private child: ChildProcess | null = null;
    private exited: Promise<void> | null = null;

    constructor(readonly entry: URL = new URL('../../central-runtime/server/dist/owned.js', import.meta.url),
        private readonly onExit: () => void = () => {}) {}

    get running(): boolean { return this.child !== null; }

    async available(entry = this.entry): Promise<boolean> {
        try { await access(entry); return true; } catch { return false; }
    }

    async start(input: { dataDir: string; reviewIdentity: string; password: string; node?: { nodeId: string; token: string } }, entry = this.entry): Promise<LocalReady> {
        if (this.child) throw new Error('本机中央已经启动');
        if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('本机中央需要 Node.js 24 或更新运行时');
        if (!await this.available(entry)) throw new Error('当前插件未包含中央运行包，请安装本机整合插件包，或连接已有中央');
        const child = spawn(process.execPath, [fileURLToPath(entry)], { windowsHide: true, shell: false,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        this.child = child;
        this.exited = new Promise(resolve => child.once('exit', () => {
            this.child = null;
            resolve();
            this.onExit();
        }));
        try {
            return await new Promise<LocalReady>((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('本机中央启动超时')), 20000);
                const onError = () => finish(new Error('无法启动本机中央进程'));
                const onExit = () => finish(new Error('本机中央在就绪前退出，请检查运行包和本地审核身份'));
                const onMessage = (message: unknown) => {
                    const value = message as Partial<LocalReady> & { type?: string };
                    if (value?.type === 'error') finish(new Error('本机中央初始化失败，请检查运行包、数据目录和审核身份'));
                    if (value?.type === 'ready' && typeof value.centerUrl === 'string' && typeof value.centralId === 'string'
                        && typeof value.nodeId === 'string' && typeof value.token === 'string') finish(undefined, value as LocalReady);
                };
                const finish = (error?: Error, value?: LocalReady) => {
                    clearTimeout(timer);
                    child.off('error', onError);
                    child.off('exit', onExit);
                    child.off('message', onMessage);
                    if (error) reject(error); else resolve(value!);
                };
                child.once('error', onError);
                child.once('exit', onExit);
                child.on('message', onMessage);
                child.send({ type: 'start', ...input }, error => { if (error) onError(); });
            });
        } catch (error) { await this.stop(); throw error; }
    }

    async stop(): Promise<void> {
        const child = this.child;
        if (!child) return;
        if (child.connected) child.send({ type: 'stop' }, () => {});
        else child.kill();
        const timer = setTimeout(() => child.kill(), 5000);
        try { await this.exited; } finally { clearTimeout(timer); }
    }
}
