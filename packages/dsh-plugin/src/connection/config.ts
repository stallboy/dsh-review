import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../host/shell.js';

export interface Candidate {
    id: string;
    label: string;
    root: string;
    current: boolean;
    vcsType?: 'git' | 'svn';
    target?: string;
    error?: string;
}

export interface SelectedWorkspace {
    workspaceId: string;
    root: string;
    label: string;
    enabled: boolean;
    vcsType: 'git' | 'svn';
    target: string;
    projectId?: string;
}

export interface ConnectionProfile {
    nodeId: string;
    workspaces: SelectedWorkspace[];
    centerUrl?: string;
    label?: string;
}

export interface ConnectionConfig {
    version: 1;
    mode: 'local' | 'external';
    enabled: boolean;
    centerUrl: string;
    centralId: string;
    reviewIdentity: string;
    profiles: Record<string, ConnectionProfile>;
}

export interface ConnectionSecrets {
    password: string;
    localCentralId?: string;
    localReviewIdentity?: string;
    nodes: Record<string, { nodeId: string; token: string }>;
}

export function normalizeCenterUrl(input: unknown): string {
    if (typeof input !== 'string' || !input.trim()) throw new Error('请填写中央服务地址');
    const url = new URL(input.trim());
    if (url.username || url.password || url.search || url.hash) throw new Error('中央地址不能包含凭据、查询参数或片段');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('已有中央须使用 HTTPS，本机回环地址可使用 HTTP');
    }
    url.pathname = url.pathname.replace(/\/*$/, '/');
    return url.href;
}

export async function readJson<T>(filename: string): Promise<T | null> {
    try { return JSON.parse(await readFile(filename, 'utf8')) as T; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`无法读取插件配置 ${path.basename(filename)}，请检查内容和权限`);
    }
}

export async function saveJson(filename: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 4), { mode: 0o600 });
    await rename(temporary, filename);
}

export async function resolveWorktree(directory: string): Promise<{ root: string; vcsType: 'git' | 'svn' }> {
    const git = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: directory, timeoutMs: 10000 });
    if (git.code === 0) return { root: await realpath(git.stdout.trim()), vcsType: 'git' };
    const svn = await runProcess('svn', ['info', '--show-item', 'wc-root', '.'], { cwd: directory, timeoutMs: 10000 });
    if (svn.code !== 0) throw new Error('不是有效的 Git/SVN 工作副本，或所需工具不可用');
    return { root: await realpath(svn.stdout.trim()), vcsType: 'svn' };
}

export async function discoverCandidates(inputs: Array<{ root: string; label?: string; current?: boolean }>): Promise<Candidate[]> {
    const candidates = new Map<string, Candidate>();
    for (const input of inputs) {
        let root = input.root;
        let vcsType: 'git' | 'svn' | undefined;
        let target: string | undefined;
        let error: string | undefined;
        try {
            root = await realpath(root);
            const worktree = await resolveWorktree(root);
            root = worktree.root;
            vcsType = worktree.vcsType;
            const branch = await runProcess(vcsType, vcsType === 'git' ? ['branch', '--show-current'] : ['info', '--show-item', 'relative-url', '.'], { cwd: root, timeoutMs: 10000 });
            target = branch.stdout.trim();
            if (branch.code !== 0 || !target) throw new Error('无法确定目标分支，请先检出明确的目标');
        } catch (caught) { error = caught instanceof Error ? caught.message : '无法读取工作副本'; }
        const identity = process.platform === 'win32' ? root.toLowerCase() : root;
        const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
        const existing = candidates.get(id);
        if (existing) { existing.current ||= Boolean(input.current); continue; }
        candidates.set(id, { id, root, label: input.label || path.basename(root), current: Boolean(input.current),
            ...(vcsType ? { vcsType } : {}), ...(target ? { target } : {}), ...(error ? { error } : {}) });
    }
    return [...candidates.values()];
}
