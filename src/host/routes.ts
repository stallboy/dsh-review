import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * §7.7/§12.1：路由的横切语义声明。
 *
 * 目的：repo 锁与审查互斥是“所有共享写都必须满足”的安全不变式，不能靠
 * 在命令式 `if` 链里逐个记着调用（历史缺陷 C1：`/comments` 等端点漏了
 * `ensureNoAuditRunning`，审查期间写请求被排队后放行）。路由在这里声明自己的
 * 语义，由 `dispatchRoute` 统一套用，新增端点默认继承安全默认值。
 */
export type RouteKind =
  /** 纯读：不加锁、不检查审查状态。 */
  | 'read'
  /** 全局只读状态（/health、/settings、/jobs…）：不需要仓库 runtime。 */
  | 'global-read'
  /** 会话/全局控制（/jobs/:id/cancel）：不触碰工作区，但也不得被审查互斥阻塞。 */
  | 'control'
  /** 设置写：不需要仓库 runtime，但必须串行（避免并发 reconfigure）。 */
  | 'settings-write'
  /** 候选/档案共享写：repo 锁 + 审查互斥 + runtime。 */
  | 'candidate-write'
  /** 工作区事务（含提交的 ai_fix/audit 入口）：repo 锁 + 审查互斥 + runtime。 */
  | 'workspace-txn'
  /** 审查启动/收尾/释放：repo 锁 + 自管理互斥（不能套用 ensureNoAuditRunning）。 */
  | 'audit-control'
  /** 长任务启动（approve/ai-fix）：handler 自行在 Job 内取锁，但受理前必须做审查互斥。 */
  | 'job-start';

/** 路由 handler：由 ReviewApi 提供，签名统一。 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** 路径参数（如 `/jobs/:id/cancel` 的 id）。 */
  params: Readonly<Record<string, string>>;
  route: string;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT';
  /** 支持 `:param` 段。 */
  path: string;
  kind: RouteKind;
  handler: RouteHandler;
}

/** 该路由类别是否要求存在可解析的仓库 runtime。 */
export function needsRuntime(kind: RouteKind): boolean {
  return kind === 'candidate-write' || kind === 'workspace-txn' || kind === 'audit-control' || kind === 'job-start'
    || kind === 'read';
}

/** 该路由类别是否在 handler 之前整体持 repo 锁。 */
export function holdsRepoLock(kind: RouteKind): boolean {
  // 记忆点：这里只能勾选“handler 自身绝不再取锁”的类别。
  // - candidate-write：handler 是同步共享写，全部工作都在锁内完成。
  // - settings-write：设置落盘串行化。
  // 审查控制（audit-control）与批准/修复（job-start）的 handler 会在内部用
  // withWriteLock 分阶段取锁（受理阶段写租约、Job 内跑 Runner），若在此整体持锁
  // 会与内部取锁形成自死锁；workspace-txn 同理；read 只做单快照读取，不持锁。
  return kind === 'candidate-write' || kind === 'settings-write';
}

/** 该路由类别是否受“审查运行中禁止共享写”约束（§7.7）。 */
export function blockedByRunningAudit(kind: RouteKind): boolean {
  // audit-control 也包含在内：新增审查在已有审查/未释放租约时必须立即 409，
  // 而不是先排到锁队列里等到对方结束后再被受理（§7.7 要求受理阶段拒绝）。
  return kind === 'candidate-write' || kind === 'workspace-txn' || kind === 'job-start' || kind === 'audit-control';
}

/**
 * 审查控制路由的“自管理”豁免：finalize / release 必须能在租约存在时执行，
 * 因此它们不走受理期的 ensureNoAuditRunning，而由 handler 内部按租约状态判定。
 */
export function isAuditSelfManaged(route: string): boolean {
  return route === '/audit/finalize' || route === '/audit/release';
}

interface CompiledRoute {
  method: string;
  segments: string[];
  spec: RouteSpec;
}

/** 声明式路由表：取代 dispatch 中的命令式 if 链。 */
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

  /** 精确段匹配优先于带参数的段；返回首个匹配。 */
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
