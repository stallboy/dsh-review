import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedWorkspace } from './managed-operations.js';
import { dshHome } from './settings.js';

export interface ManagedHandle {
    centerUrl: string;
    nodeId: string;
    stop(): Promise<void>;
}

export async function loadManagedNode(resolveCredential: (reference: string) => Promise<string | undefined>, onError: (error: Error) => void): Promise<ManagedHandle | null> {
    const directory = path.join(dshHome(), 'dsh-code-review');
    let input: Record<string, unknown>;
    try { input = JSON.parse(await readFile(path.join(directory, 'managed-node.json'), 'utf8')); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('无法读取 managed-node.json，请检查 JSON 格式与文件权限');
    }
    if (typeof input.centerUrl !== 'string' || typeof input.nodeId !== 'string' || typeof input.tokenReference !== 'string'
        || !Array.isArray(input.workspaces) || !input.workspaces.length) throw new Error('托管节点配置缺少中央地址、节点标识、凭据引用或工作副本');
    const token = process.env[input.tokenReference] ?? await resolveCredential(input.tokenReference);
    if (!token) throw new Error('托管节点凭据引用无法解析');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('托管节点需要 Node.js 24 或更新版本');
    const { ManagedJournal } = await import('./managed-journal.js');
    const { ManagedNode } = await import('./managed-node.js');
    const { ManagedOperations } = await import('./managed-operations.js');
    const journal = new ManagedJournal(path.join(directory, 'managed', 'journal.sqlite'));
    const operations = new ManagedOperations({ dataDir: path.join(directory, 'managed'), journal, workspaces: input.workspaces as ManagedWorkspace[], resolveCredential });
    try {
        await operations.init();
        const node = new ManagedNode({ config: { centerUrl: input.centerUrl, nodeId: input.nodeId, token, workspaces: operations.registrations() }, journal,
            execute: (...args) => operations.execute(...args), read: (...args) => operations.read(...args), snapshot: project => operations.snapshot(project),
            recover: (...args) => operations.recover(...args), onError });
        await node.start();
        return { centerUrl: input.centerUrl, nodeId: input.nodeId, stop: async () => { await node.stop(); operations.stop(); journal.close(); } };
    } catch (error) { operations.stop(); journal.close(); throw error; }
}
