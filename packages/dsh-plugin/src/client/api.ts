import type { ConnectionIssue, PatchStats } from './types.js';

export const API_ROOT = '/dsh-code-review/api';

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  dispose(): void;
}

export class ApiResponseError extends Error {
  constructor(message: string, readonly issue?: ConnectionIssue) {
    super(message);
  }
}

/** 释放时取消在途请求，避免卸载后再更新视图。 */
export function createApi(
  apiRoot = API_ROOT,
  controlToken?: () => string,
  expectedRepoRoot?: () => string | null,
): ApiClient {
  const inflight = new Set<AbortController>();
  let disposed = false;

  const request = async <T>(path: string, method: string, body: unknown): Promise<T> => {
    if (disposed) throw new Error('评审面板已卸载');
    const controller = new AbortController();
    inflight.add(controller);
    try {
      const base = typeof document === 'undefined' ? '/' : document.baseURI;
      const url = new URL(`${apiRoot}${path}`, base);
      const repoRoot = expectedRepoRoot?.();
      if (repoRoot && path !== '/health' && path !== '/settings') {
        url.searchParams.set('expectedRepoRoot', repoRoot);
      }
      const response = await fetch(url.toString(), {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method !== 'GET' && controlToken ? { 'x-dsh-review-control': controlToken() } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload: { error?: ConnectionIssue & { message?: string } } | null = null;
      try {
        payload = text ? (JSON.parse(text) as { error?: ConnectionIssue & { message?: string } }) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = payload?.error;
        throw new ApiResponseError(error?.message ?? `HTTP ${String(response.status)}`, error?.stage ? error : undefined);
      }
      return payload as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('评审面板已卸载');
      throw error;
    } finally {
      inflight.delete(controller);
    }
  };

  return {
    get: <T>(path: string): Promise<T> => request<T>(path, 'GET', undefined),
    post: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, 'POST', body),
    put: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, 'PUT', body),
    dispose: (): void => {
      disposed = true;
      for (const controller of inflight) controller.abort();
      inflight.clear();
    },
  };
}

export function short(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function runtimeBytes(bytes: number, total: number): string {
  return total < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function statusText(status: string): string {
  const map: Record<string, string> = {
    pending: '待审核',
    changes_requested: '待修订',
    repair_failed: '修复失败',
    human_takeover: '人工接手',
    awaiting_verification: '待复查验证',
    approved: '已批准',
    rejected: '已接受现状',
    resolved: '已解决',
  };
  return map[status] ?? status;
}

export function statsText(stats: PatchStats | null | undefined): string {
  if (!stats) return '—';
  return `+${String(stats.additions)} / -${String(stats.deletions)} · ${String(stats.files)} files`;
}

export function commentText(status: string): string {
  return status === 'resolved' ? '已处理' : status === 'partial' ? '部分处理' : '未处理';
}
