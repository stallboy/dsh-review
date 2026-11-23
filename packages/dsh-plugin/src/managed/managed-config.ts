import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '@dsh-review/protocol';
import type { ManagedWorkspace } from './managed-operations.js';
import type { ApiDeps } from '../host/api-context.js';
import { dshHome } from '../host/settings.js';

export interface ManagedHandle {
    centerUrl: string;
    nodeId: string;
    instanceId: string;
    hasUnsettled(): boolean;
    workspaceIssue(workspaceId: string): string | undefined;
    completeConfiguration(): void;
    stop(disconnect?: boolean): Promise<void>;
}

export interface ManagedConfiguration {
    centerUrl: string;
    nodeId: string;
    token: string;
    workspaces: ManagedWorkspace[];
    pauseAdmission?: boolean;
    boundProjects?: ProjectRecord[];
    auditSessions?: Pick<ApiDeps, 'createAuditSession' | 'withAuditSessionIdle'>;
}

export async function startManagedNode(input: ManagedConfiguration, directory: string,
    resolveCredential: (reference: string) => Promise<string | undefined>, onError: (error: Error) => void,
    waitReady = true): Promise<ManagedHandle> {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('托管节点需要 Node.js 24 或更新版本');
    const { ManagedJournal } = await import('./managed-journal.js');
    const { ManagedNode, managedCenterUrl } = await import('./managed-node.js');
    const centerUrl = managedCenterUrl(input.centerUrl);
    const { ManagedOperations } = await import('./managed-operations.js');
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const operations = new ManagedOperations({ dataDir: directory, journal, workspaces: input.workspaces, resolveCredential,
        ...(input.auditSessions ? { auditSessions: input.auditSessions } : {}) });
    try {
        const initializeWorkspaces = async () => {
            const projects = input.boundProjects ?? await fetch(new URL('node-api/v1/status', centerUrl), {
                method: 'POST', headers: { authorization: 'Bearer ' + input.token, 'content-type': 'application/json' },
                body: '{}', signal: AbortSignal.timeout(3000), redirect: 'error',
            }).then(async response => {
                if (!response.ok) throw new Error('暂时无法核验中央保存的项目绑定（HTTP ' + response.status + '）');
                const status = await response.json() as { nodeId?: string; projects?: ProjectRecord[] };
                if (status.nodeId !== input.nodeId || !Array.isArray(status.projects)) throw new Error('无法确认中央保存的节点身份或项目绑定');
                return status.projects;
            });
            await operations.init(projects);
        };
        const node = new ManagedNode({ config: { centerUrl: input.centerUrl, nodeId: input.nodeId, token: input.token,
            get workspaces() { return operations.registrations(); }, pauseAdmission: input.pauseAdmission }, journal,
            execute: (...args) => operations.execute(...args), read: (...args) => operations.read(...args), snapshot: project => operations.snapshot(project),
            recover: (...args) => operations.recover(...args), workspaceIssues: () => operations.workspaceIssues(),
            refreshWorkspaceIssues: projects => operations.refreshWorkspaceIssues(projects), initializeWorkspaces, onError });
        await node.start();
        try { if (waitReady) await node.tick(); }
        catch (error) { await node.stop(); throw error; }
        return { centerUrl: input.centerUrl, nodeId: input.nodeId, instanceId: node.instanceId,
            hasUnsettled: () => journal.hasUnsettled(),
            workspaceIssue: workspaceId => operations.workspaceIssue(workspaceId),
            completeConfiguration: () => node.completeConfiguration(), stop: async (disconnect = true) => {
                await node.stop(disconnect);
                if (disconnect) await fetch(new URL('node-api/v1/disconnect', input.centerUrl), { method: 'POST',
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
