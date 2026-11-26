import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stopDshAuditSession } from './audit-session-idle.js';

interface Session {
    id: string;
    header?: { id?: string; cwd?: string; parentSession?: string };
}

interface Policy {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access';
    workspaceRoot: string;
    additionalWritableRoots?: string[];
    sessionId?: string;
}

interface Host {
    get(name: string): unknown;
    on?(event: string, listener: (...args: any[]) => void): (() => void) | void;
}

interface AuditAgent {
    session: Session;
    ctx?: { get(name: string, required?: boolean): unknown };
}

interface PolicyRequest { session?: Session; mode?: Policy['mode'] }

const sameDirectory = (left: string, right: string): boolean => {
    const normalized = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    return normalized(left) === normalized(right);
};

const bridges = new WeakMap<object, { bind(sessionId: string, root: string): void; shutdown(): Promise<boolean> }>();

export async function releaseAuditSessionRestrictions(host: Host): Promise<boolean> {
    return await bridges.get(host)?.shutdown() ?? true;
}

export async function restrictAuditSession(host: Host, sessionId: string, cwd: string): Promise<void> {
    const project = await realpath(cwd);
    const directory = path.join(project, '.ai-review');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('审查目录必须是项目内的普通目录');
    const root = await realpath(directory);
    const sessionStore = host.get('sessions') as { get?(id: string): Session | undefined } | undefined;
    const current = sessionStore?.get?.(sessionId);
    const actual = current?.header?.cwd ? await realpath(current.header.cwd) : null;
    if (actual !== project) throw new Error('审查会话工作目录必须严格等于项目根目录');
    let bridge = bridges.get(host);
    if (!bridge) {
        const service = host.get('sandboxPolicy') as { resolve?: (input?: PolicyRequest) => Policy } | undefined;
        const sessions = host.get('sessions') as { get?(id: string): Session | undefined } | undefined;
        const agents = host.get('agents') as { get?(id: string): AuditAgent | undefined } | undefined;
        const approval = host.get('approval') as { setPolicy?(agent: unknown, policy: 'never'): void } | undefined;
        const tools = host.get('tools') as { guard?(guard: (execution: { name: string; agent?: { session: Session } }) => string | undefined): () => void } | undefined;
        const supportsSandbox = (name: string) => {
            const provider = host.get(name) as { sandboxMode?: string } | undefined;
            return provider?.sandboxMode !== undefined && ['read-only', 'workspace-write', 'danger-full-access'].includes(provider.sandboxMode);
        };
        if (!supportsSandbox('fs') || !supportsSandbox('shell')) throw new Error('审查要求 DSH 文件与 shell 服务提供原生沙箱，不能使用无约束的本地后端');
        if (!service?.resolve || !sessions?.get || !agents?.get || !approval?.setPolicy || !tools?.guard || !host.on) throw new Error('DSH 缺少逐会话沙箱、工具准入或生命周期能力，无法执行受限审查');
        const own = Object.getOwnPropertyDescriptor(service, 'resolve');
        let prototype: object | null = service;
        let descriptor = own;
        while (!descriptor && prototype) {
            prototype = Object.getPrototypeOf(prototype);
            descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'resolve') : undefined;
        }
        const original = descriptor?.value as typeof service.resolve;
        if (typeof original !== 'function') throw new Error('DSH 沙箱策略解析器不支持适配');
        const roots = new Map<string, string>();
        const reviewRoot = (session?: Session): string | undefined => {
            const visited = new Set<string>();
            let current: Session | undefined = session;
            while (current && !visited.has(current.id)) {
                visited.add(current.id);
                const root = roots.get(current.id);
                if (root) return root;
                const parent: string | undefined = current.header?.parentSession;
                if (parent && roots.has(parent)) return roots.get(parent);
                current = parent ? sessions.get!(parent) : undefined;
            }
            return undefined;
        };
        const wrapped = function(this: unknown, input?: PolicyRequest): Policy {
            const root = reviewRoot(input?.session);
            const result = Reflect.apply(original!, this, root ? [{ ...input, mode: 'workspace-write' }] : arguments);
            if (!root) return result;
            if (!input?.session?.header?.cwd || !sameDirectory(input.session.header.cwd, path.dirname(root))) throw new Error('审查子会话工作目录已变化');
            if (!result || !['read-only', 'workspace-write', 'danger-full-access'].includes(result.mode)) throw new Error('DSH 沙箱策略结果不兼容');
            return { ...result, mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [], sessionId: input.session.id };
        };
        Object.defineProperty(service, 'resolve', { configurable: true, enumerable: own?.enumerable ?? false, writable: true, value: wrapped });
        const toolGuards = new Map<AuditAgent, () => void>();
        const restrictTools = (agent: AuditAgent) => {
            if (toolGuards.has(agent)) return;
            const service = agent.ctx?.get('tools', false) as typeof tools;
            if (!service?.guard) throw new Error('审查 Agent 缺少独立生命周期的工具准入能力');
            toolGuards.set(agent, service.guard(execution => reviewRoot(execution.agent?.session)
                && (execution.name === 'subagent_oar' || execution.name.startsWith('worktree_') && execution.name !== 'worktree_status')
                ? '审查 Agent 必须继承工作目录和写权限；外部委派请使用受控 runAuditStage' : undefined));
        };
        const off = host.on('agent/created', ({ agent }: { agent: AuditAgent }) => {
            const root = reviewRoot(agent.session);
            if (root) {
                if (!agent.session.header?.cwd || !sameDirectory(agent.session.header.cwd, path.dirname(root))) throw new Error('审查子会话必须沿用项目工作目录');
                roots.set(agent.session.id, root);
                restrictTools(agent);
                approval.setPolicy!(agent, 'never');
            }
        });
        const offDisposed = host.on('agent/disposed', ({ agent }: { agent: AuditAgent }) => {
            toolGuards.get(agent)?.();
            toolGuards.delete(agent);
        });
        const cleanup = () => {
            if (Object.getOwnPropertyDescriptor(service, 'resolve')?.value === wrapped) {
                if (own) Object.defineProperty(service, 'resolve', own);
                else Reflect.deleteProperty(service, 'resolve');
            }
            off?.();
            offDisposed?.();
            for (const dispose of toolGuards.values()) dispose();
            toolGuards.clear();
            roots.clear();
            bridges.delete(host);
        };
        bridge = { bind(id, root) {
            const session = sessions.get!(id);
            const agent = agents.get!(id);
            if (!session || !agent) throw new Error('无法绑定审查会话的 Agent 权限');
            roots.set(id, root);
            restrictTools(agent);
            approval.setPolicy!(agent, 'never');
        }, async shutdown() {
            const outcomes = await Promise.all([...roots.keys()].map(async id => {
                if (!agents.get!(id)) return true;
                return stopDshAuditSession(host, id, AbortSignal.timeout(10_000), Promise.resolve(true)).catch(() => false);
            }));
            if (!outcomes.every(Boolean)) return false;
            cleanup();
            return true;
        } };
        bridges.set(host, bridge);
    }
    bridge.bind(sessionId, root);
}
