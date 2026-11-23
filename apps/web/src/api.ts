import type { AuditPlanSettings, CommandRecord, ProjectRecord, ProjectSnapshot, NodeRecord } from '@dsh-review/protocol';
import type { CandidateSummary } from '@dsh-review/protocol';
import type { QueryClient } from '@tanstack/react-query';

export interface Session { user: { userId: string; username: string; reviewIdentity: string }; csrfToken: string; localAccess?: true }
export interface ProjectView { project: ProjectRecord; online: boolean; compatible: boolean; freshness: 'not_synced' | 'synced' | 'offline' | 'stale'; writable: boolean; workspaceIssue?: string; lastSyncedAt: string | null; vcsSnapshot: string | null; snapshot?: ProjectSnapshot }
export interface AuditScheduleSettings { enabled: boolean; startTime: string; timeZone: string }
export interface AuditSchedule extends AuditScheduleSettings {
    nextRunAt: string | null;
    lastRun: { scheduledAt: string; state: CommandRecord['state'] | 'waiting' | 'skipped'; reason: string | null; commandId: string | null } | null;
}
export interface AuditPlan extends AuditPlanSettings, Pick<AuditSchedule, 'nextRunAt' | 'lastRun'> { planId: string }
export interface ProjectDetail extends ProjectView { auditSchedule: AuditSchedule | null; auditPlans: AuditPlan[] }
export type QueueItem = CandidateSummary & { projectId: string; projectName: string };
export type { CommandRecord, NodeRecord };

let csrfToken = '';
const intents = new Map<string, string>();
export function setSession(value: Session | null) { csrfToken = value?.csrfToken ?? ''; }

export function clearSession(client: QueryClient): void {
    void client.cancelQueries({ queryKey: ['session'] });
    setSession(null);
    intents.clear();
    client.setQueryData(['session'], null);
    client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' });
    client.getMutationCache().clear();
}

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const basePath = typeof document === 'undefined' ? '' : new URL(document.baseURI).pathname.replace(/\/$/, '');
    const response = await fetch(`${basePath}/api/v1${path}`, { method, credentials: 'same-origin', signal,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new ApiError(response.status, value.error?.code ?? 'http_error', value.error?.message ?? `请求失败（${response.status}）`);
    return value;
}

export function saveAuditSchedule(projectId: string, settings: AuditScheduleSettings) {
    return request<{ auditSchedule: AuditSchedule }>(`/projects/${projectId}/audit-schedule`, 'PUT', settings);
}

export function saveAuditPlan(projectId: string, settings: AuditPlanSettings, planId?: string) {
    const base = `/projects/${projectId}/audit-plans`;
    return request<{ auditPlan: AuditPlan }>(planId ? `${base}/${planId}` : base, planId ? 'PUT' : 'POST', settings);
}

export function deleteAuditPlan(projectId: string, planId: string) {
    return request<{ deleted: true }>(`/projects/${projectId}/audit-plans/${planId}`, 'DELETE');
}

export async function detail<T>(projectId: string, kind: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
    const unpack = async (data: unknown): Promise<T> => {
        const value = data as { type?: string; hash?: string };
        return value?.type === 'central-artifact' && /^[a-f0-9]{64}$/.test(value.hash ?? '')
            ? request<T>(`/artifacts/${value.hash}`, 'GET', undefined, signal) : data as T;
    };
    const value = await request<{ data?: T; queryId?: string }>(`/projects/${projectId}/${kind}?${new URLSearchParams(params)}`, 'GET', undefined, signal);
    if (value.data !== undefined) return unpack(value.data);
    for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
            const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
        const result = await request<{ state: string; data?: T & { error?: string } }>(`/queries/${value.queryId}`, 'GET', undefined, signal);
        if (result.state === 'ready') return unpack(result.data);
        if (result.state === 'snapshot_moved') throw new ApiError(409, 'snapshot_moved', '仓库版本已变化，请刷新后查看');
        if (result.state === 'error' || result.state === 'retired') throw new ApiError(502, 'query_failed', result.data?.error ?? '节点读取失败，请重试');
    }
    throw new ApiError(504, 'query_timeout', '节点读取尚未完成，请稍后重试');
}

export async function command(projectId: string, operation: string, payload: unknown, guard?: unknown) {
    const intent = JSON.stringify({ projectId, operation, payload, guard });
    const idempotencyKey = intents.get(intent) ?? crypto.randomUUID();
    intents.set(intent, idempotencyKey);
    try {
        const result = await request<{ command: CommandRecord }>(`/projects/${projectId}/commands`, 'POST', { operation, payload, guard, idempotencyKey });
        intents.delete(intent);
        return result;
    } catch (error) {
        if (error instanceof ApiError && error.status < 500) intents.delete(intent);
        throw error;
    }
}
