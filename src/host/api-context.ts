import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppSettings, ConcurrencyGuard, JobRecord, ReviewFilter, ReviewStatus, VcsType } from './types.js';
import { ApiError } from './types.js';
import type { JobManager } from './jobs.js';
import type { AuditLifecycle, AuditLeaseRecord } from './audit-lifecycle.js';
import type { CandidateSource, ReviewStore } from './store.js';
import type { SharedCandidateSource } from './shared-facts.js';
import { GitHeadCandidateSource, SvnBaseCandidateSource } from './shared-facts.js';
import type { VcsAdapter } from './vcs.js';

/**
 * 本模块是拆分后的**叶子**：只依赖 `./types.js` 等既有模块，不 import 任何 `api-*` 模块。
 * 所有反向依赖都通过下面的 `ApiHost` 窄接口注入，保证 import 图无环。
 */

export const API_PREFIX = '/dsh-code-review/api';
export const APP_VERSION = '0.3.0';
const BODY_LIMIT = 2 * 1024 * 1024;
const STATUSES: ReviewStatus[] = ['pending', 'changes_requested', 'approved', 'rejected'];

export interface ApiDeps {
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  /** Resolve the working directory of the Session that owns the review tab. */
  resolveSessionCwd?: (sessionId: string) => string | undefined;
  /** Create a real DSH session (through the host `sessionController`) and send the audit prompt into it. */
  createAuditSession?: (input: {
    cwd: string;
    title: string;
    prompt: string;
    /** Session that owns the review tab; its permission/approval policy is inherited. */
    ownerSessionId?: string;
  }) => Promise<{ sessionId: string }>;
  /**
   * §7.4（2026-11-12）：创建承载「AI 修复」任务的独立会话。
   *
   * 与 `createAuditSession` 走同一条 sessionController 序列，但没有审查租约：修复会话
   * 产出的是候选新版本，`.ai-review/` 的提交仍由 Host 在用户点「提交并让 AI 修复」时完成。
   * 为空表示当前 Host 不支持会话执行器，`/fix-session` 返回 500 诊断。
   */
  createFixSession?: (input: {
    cwd: string;
    title: string;
    prompt: string;
    ownerSessionId?: string;
  }) => Promise<{ sessionId: string }>;
  /** Host 的真实 turn 结束通知；不得用文件/状态轮询模拟。 */
  onAuditTurnEnd?: (sessionId: string, callback: () => void) => () => void;
  /** Diagnostic: the live client-module graph entry for this package, if any. */
  clientEntry?: () => unknown;
  /** §7.6 审查租约持久化文件；缺省为 DSH_HOME/dsh-code-review/runtime-state.json（测试可注入临时路径）。 */
  statePath?: string;
}

export interface Runtime {
  root: string;
  store: ReviewStore;
  vcs: VcsAdapter;
  vcsType: VcsType;
}

/** §7.6 手动/会话审查执行租约：参与全部互斥；持久化在 DSH_HOME 运行时状态中。 */
export interface AuditLease {
  auditId: string;
  root: string;
  targetPath: string;
  trigger: 'manual' | 'scheduled';
  baseRevision: string;
  owner: string;
  createdAt: string;
  /** 开始执行时的候选快照：finalize 只校验此后新增的候选。 */
  candidateIdsBefore: string[];
  state: 'active' | 'releasable' | 'released';
  /** 会话模式创建的 DSH 审查会话 id（其余模式缺省）。 */
  sessionId?: string;
}

/** §7.1：为一次共享读取创建绑定共享快照的数据源；每次请求重建，不跨快照复用（Git=HEAD、SVN=BASE）。 */
export interface SharedView {
  source: SharedCandidateSource;
  /** 该源实际绑定的快照标识（SVN 根 revision 不可证明快照，返回 null → 不缓存）。 */
  snapshot: string | null;
}

/**
 * §7.1 共享快照的**唯一**读取入口。
 *
 * 拆分后的所有模块（读模型、写事务、审查生命周期）都必须经由此函数获取共享事实源，
 * 不允许各自重建 —— 否则「一次计算内的档案与候选事实来自同一快照」的语义会被破坏。
 */
export async function sharedViewFor(runtime: Runtime): Promise<SharedView | undefined> {
  if (runtime.vcsType === 'git') {
    const source = await GitHeadCandidateSource.create(runtime.root).catch(() => null);
    return source ? { source, snapshot: await source.snapshotId() } : undefined;
  }
  if (runtime.vcsType === 'svn') {
    const source = new SvnBaseCandidateSource(runtime.root);
    return { source, snapshot: await source.snapshotId() };
  }
  return undefined;
}

export async function sharedSourceFor(runtime: Runtime): Promise<SharedCandidateSource | undefined> {
  return (await sharedViewFor(runtime))?.source;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? {} } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: { code: 'internal', message, details: {} } });
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'bad_request', '请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApiError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request', '请求体不是合法 JSON');
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function guardFrom(body: Record<string, unknown>): ConcurrencyGuard {
  const expectedRevision = numberField(body, 'expectedRevision');
  const expectedOwner = stringField(body, 'expectedOwner');
  const expectedUpdatedAt = stringField(body, 'expectedUpdatedAt');
  if (expectedRevision <= 0 || !expectedOwner) {
    throw new ApiError(400, 'bad_request', '缺少并发校验信息（expectedRevision / expectedOwner）');
  }
  // §8.1：完整 guard 必含 expectedUpdatedAt，且必须是可解析的 ISO-8601 时间点。
  if (!expectedUpdatedAt || Number.isNaN(new Date(expectedUpdatedAt).getTime())) {
    throw new ApiError(400, 'bad_request', '缺少或非法的并发校验信息（expectedUpdatedAt）');
  }
  return { expectedRevision, expectedOwner, expectedUpdatedAt };
}

export function isAnchor(value: unknown): value is { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['snippet'] === 'string' && record['snippet'].trim().length > 0
    && (record['before'] === undefined || typeof record['before'] === 'string')
    && (record['after'] === undefined || typeof record['after'] === 'string');
}

export function splitId(id: string): [string, string] {
  const parts = id.replaceAll('\\', '/').split('/');
  if (parts.length !== 2) throw new ApiError(400, 'bad_request', '候选 id 必须是 YYYY-MM/slug');
  return [parts[0] ?? '', parts[1] ?? ''];
}

export function idFrom(url: URL): string {
  const id = url.searchParams.get('id') ?? '';
  if (!id) throw new ApiError(400, 'bad_request', '缺少候选 id');
  return id;
}

export function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

export function composeSessionPrompt(systemPrompt: string, userPrompt: string): string {
  return [
    '# 仓库审查任务（独立 DSH 会话）',
    '',
    '下面是本次仓库审查的完整准则与任务上下文。请完整遵守，并在当前仓库中直接执行；不要只输出计划。',
    '',
    '---',
    '',
    systemPrompt,
    '',
    '---',
    '',
    userPrompt,
  ].join('\n');
}

export function filterFrom(url: URL, owner: string): ReviewFilter {
  const statusParam = url.searchParams.get('statuses') ?? '';
  const statuses = statusParam
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is ReviewStatus => STATUSES.includes(item as ReviewStatus));
  const tag = url.searchParams.get('tag')?.trim();
  const dir = url.searchParams.get('dir')?.trim();
  const text = url.searchParams.get('text')?.trim();
  const createdAfter = url.searchParams.get('createdAfter')?.trim();
  const createdBefore = url.searchParams.get('createdBefore')?.trim();
  const filter: ReviewFilter = { owner };
  if (statuses.length > 0) filter.statuses = statuses;
  if (tag) filter.tag = tag;
  if (dir) filter.dir = dir;
  if (text) filter.text = text;
  if (createdAfter) filter.createdAfter = createdAfter;
  if (createdBefore) filter.createdBefore = createdBefore;
  return filter;
}

/**
 * §12.1 进程内 repo 级锁：同一检出的共享写与工作区事务串行化。
 *
 * 该锁**不可重入**：handler 在同一临界区内再次取锁会永久等待（历史缺陷：`/audit`
 * 被路由整体持锁后又在 handler 内 withWriteLock）。为避免这种自死锁，
 * `withRepoLock` 用 AsyncLocalStorage 标记“当前异步上下文中是否已持锁”，
 * 重入时直接抛出可诊断错误。
 *
 * 注意：不能用全局 Set 记录“已持锁”——并发请求会在第一个成功获取锁期间
 * 被误判为重入（真实回归：P10 并发归档 500）。
 */
export class RepoLock {
  private writeLocks = new Map<string, Promise<unknown>>();
  /** §12.1：标记“当前异步上下文已持有该仓库的 repo 锁”，用于把锁重入变成可诊断错误而不是死锁。 */
  private readonly lockContext = new AsyncLocalStorage<string>();

  /** 按仓库根串行化；被串行化的函数本身抛错不影响后续排队者继续执行。 */
  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(repoRoot) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.writeLocks.set(repoRoot, next.catch(() => undefined));
    return next;
  }

  /** 共享写路由统一加锁（§12.1：同一检出的写操作串行化）。 */
  async withRepoLock<T>(url: URL, runtimeFor: (url: URL) => Promise<Runtime>, fn: () => Promise<T>): Promise<T> {
    return runtimeFor(url).then(
      (runtime) => {
        if (this.lockContext.getStore() === runtime.root) {
          throw new ApiError(500, 'internal', 'repo 锁重入：该路由已在锁定临界区内再次取锁（路由类别与 handler 取锁策略冲突）');
        }
        return this.lockContext.run(runtime.root, () => this.withWriteLock(runtime.root, fn));
      },
      () => fn(),
    );
  }
}

/**
 * 拆分后各子模块对 `ReviewApi` 的**唯一**反向依赖面。
 *
 * 子模块只拿得到这里声明的窄接口；`api.ts` 实现它，并在构造时把 `this` 传给各
 * `setup*()` 装配函数。这样 `api-readmodels.ts` / `api-writers.ts` / `api-audit.ts`
 * 都不需要 import `api.ts`，import 图保持单向（context ← readmodels ← writers ← audit ← api）。
 */
export interface ApiHost {
  /** 当前副作用的宿主依赖（设置、会话解析、凭据、租约状态文件路径…）。 */
  readonly deps: ApiDeps;
  /** 当前生效的设置（reconfigure 会整体替换，因此必须经 getter 读取而非快照）。 */
  currentSettings(): AppSettings;
  readonly jobManager: JobManager;
  /** 最近一次 reconfigure 的校验错误（/settings 降级返回时使用）。 */
  readonly lastConfigErrors: readonly string[];
  /** reconfigure 时探测到的 VCS 类型（未配置仓库时可为 null）。 */
  readonly detectedVcsType: VcsType | null;

  /** 按请求解析仓库 runtime（带缓存）；未配置/非仓库时抛 412。 */
  runtimeFor(url: URL): Promise<Runtime>;
  /** §12.2 当前操作者（owner）：设置里显式配置优先，否则按仓库推断。 */
  ownerFor(root: string): Promise<string>;
  /** §12.1 进程内 repo 锁。 */
  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;

  /** §7.6 审查租约状态机（唯一迁移入口）；未初始化时抛 500。 */
  readonly auditLifecycle: AuditLifecycle;
  /** §7.7 运行中的审查 Job / 未释放租约一律阻止自动写。 */
  ensureNoAuditRunning(root?: string): void;
  /** §7.6 只读或迁移单个租约的窄接口（读模型与写事务共用）。 */
  leaseLookup(auditId: string): AuditLeaseRecord | undefined;
  leaseTransition(auditId: string, state: 'released' | 'releasable'): Promise<void>;
  /** 会话/手动/定时审查跟踪 Job 的完成回调（仅内存；重启后由 finalize 直接新建 Job）。 */
  readonly auditJobFinishes: Map<string, (result?: unknown) => void>;
  /** 跟踪 Job id → auditId，供 /jobs/:id/cancel 把租约转为 releasable。 */
  readonly auditJobLeases: Map<string, string>;

  /** 启动一个 ai_fix Job（/ai-fix 与 /comments 的 autoFix 链共用同一次受理结论）。 */
  startAiFixJob(runtime: Runtime, id: string, guard: ConcurrencyGuard): Promise<JobRecord>;
  /** §7.4：同仓修复会话的占用记录（`/fix-session` 的并发控制与诊断入口）。 */
  readonly fixSessionGuard: { activeFor(root: string): { candidateId: string; sessionId: string } | undefined };
}
