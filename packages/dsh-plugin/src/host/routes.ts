import type { ApiRequest, ApiResponse } from './api-context.js';

/** API 路由在此声明锁和审查互斥要求，由分派统一执行，避免新增共享写入口时漏掉检查。 */
export type RouteKind =
  | 'read'
  /** 即使仓库未配置也可读取宿主状态。 */
  | 'global-read'
  /** 取消控制必须在审查运行时依然可达。 */
  | 'control'
  /** 仓库配置可能尚未建立，重配置仍须串行。 */
  | 'settings-write'
  | 'candidate-write'
  | 'workspace-txn'
  | 'audit-control'
  | 'job-start';

export interface RouteContext {
  req: ApiRequest;
  res: ApiResponse;
  url: URL;
  params: Readonly<Record<string, string>>;
  route: string;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT';
  /** 路径允许用 :param 捕获单个段。 */
  path: string;
  kind: RouteKind;
  handler: RouteHandler;
}

export function needsRuntime(kind: RouteKind): boolean {
  return kind === 'candidate-write' || kind === 'workspace-txn' || kind === 'audit-control' || kind === 'job-start'
    || kind === 'read';
}

/** 由处理器或 Job 分阶段取锁的路由不能在外层持锁，否则会重入。 */
export function holdsRepoLock(kind: RouteKind): boolean {
  return kind === 'candidate-write' || kind === 'settings-write';
}

/** 这些路由须在入锁队列前检查冲突，避免本应拒绝的请求排队后被误受理。 */
export function blockedByRunningAudit(kind: RouteKind): boolean {
  return kind === 'candidate-write' || kind === 'workspace-txn' || kind === 'job-start' || kind === 'audit-control';
}

/** 收尾与释放依赖现有租约，须由处理器按租约状态判断。 */
export function isAuditSelfManaged(route: string): boolean {
  return route === '/audit/finalize' || route === '/audit/release';
}

interface CompiledRoute {
  method: string;
  segments: string[];
  spec: RouteSpec;
}

export class RouteTable {
  private readonly compiled: CompiledRoute[] = [];

  add(spec: RouteSpec): this {
    this.compiled.push({ method: spec.method, segments: segmentOf(spec.path), spec });
    return this;
  }

  addAll(specs: RouteSpec[]): this {
    for (const spec of specs) this.add(spec);
    return this;
  }

  /** 固定路径优先于同形参数路径，避免后者遮蔽特定入口。 */
  match(method: string, route: string): { spec: RouteSpec; params: Record<string, string> } | null {
    const segments = segmentOf(route);
    let fallback: { spec: RouteSpec; params: Record<string, string> } | null = null;
    for (const entry of this.compiled) {
      if (entry.method !== method) continue;
      const params = matchSegments(entry.segments, segments);
      if (params === null) continue;
      if (entry.segments.every((segment) => !segment.startsWith(':'))) {
        return { spec: entry.spec, params };
      }
      fallback ??= { spec: entry.spec, params };
    }
    return fallback;
  }

  specs(): RouteSpec[] {
    return this.compiled.map((entry) => entry.spec);
  }
}

function segmentOf(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? '';
    const got = actual[index] ?? '';
    if (expected.startsWith(':')) {
      if (!got) return null;
      params[expected.slice(1)] = got;
      continue;
    }
    if (expected !== got) return null;
  }
  return params;
}
