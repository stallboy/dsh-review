import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedWorkspace } from './managed-operations.js';
import { dshHome } from '../host/settings.js';

export interface ManagedHandle {
    centerUrl: string;
    nodeId: string;
    instanceId: string;
    hasUnsettled(): boolean;
    completeConfiguration(): void;
    stop(): Promise<void>;
}

export interface ManagedConfiguration {
    centerUrl: string;
    nodeId: string;
    token: string;
    workspaces: ManagedWorkspace[];
    pauseAdmission?: boolean;
}

export async function startManagedNode(input: ManagedConfiguration, directory: string,
    resolveCredential: (reference: string) => Promise<string | undefined>, onError: (error: Error) => void,
    waitReady = true): Promise<ManagedHandle> {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('托管节点需要 Node.js 24 或更新版本');
    const { ManagedJournal } = await import('./managed-journal.js');
    const { ManagedNode } = await import('./managed-node.js');
    const { ManagedOperations } = await import('./managed-operations.js');
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const operations = new ManagedOperations({ dataDir: directory, journal, workspaces: input.workspaces, resolveCredential });
    try {
        await operations.init();
        const node = new ManagedNode({ config: { centerUrl: input.centerUrl, nodeId: input.nodeId, token: input.token,
            get workspaces() { return operations.registrations(); }, pauseAdmission: input.pauseAdmission }, journal,
            execute: (...args) => operations.execute(...args), read: (...args) => operations.read(...args), snapshot: project => operations.snapshot(project),
            recover: (...args) => operations.recover(...args), onError });
        await node.start();
        try { if (waitReady) await node.tick(); }
        catch (error) { await node.stop(); throw error; }
        return { centerUrl: input.centerUrl, nodeId: input.nodeId, instanceId: node.instanceId,
            hasUnsettled: () => journal.hasUnsettled(), completeConfiguration: () => node.completeConfiguration(), stop: async () => {
                await node.stop();
                await fetch(new URL('node-api/v1/disconnect', input.centerUrl), { method: 'POST',
                    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ instanceId: node.instanceId }), signal: AbortSignal.timeout(2000) }).catch(() => {});
                operations.stop();
                journal.close();
            } };
    } catch (error) { operations.stop(); journal.close(); throw error; }
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
    return startManagedNode({ centerUrl: input.centerUrl, nodeId: input.nodeId, token, workspaces: input.workspaces as ManagedWorkspace[] },
        path.join(directory, 'managed'), resolveCredential, onError, false);
}
