import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { ApprovalOrchestrator } from './approval.js';
import { buildAuditPrompt, loadAuditSystemPrompt } from './auditor.js';
import type { AuditLifecycle, AuditLeaseRecord } from './audit-lifecycle.js';
import { JobManager } from './jobs.js';
import { RouteTable, blockedByRunningAudit, holdsRepoLock, isAuditSelfManaged } from './routes.js';
import { Runner } from './runner.js';
import { loadReviewers } from './reviewers.js';
import { ReviewStore } from './store.js';
import { detectVcs, suggestOwner, validateSettings } from './settings.js';
import type {
  AppSettings,
  AiFixOutcome,
  ConcurrencyGuard,
  HealthInfo,
  JobRecord,
  ReviewStatus,
  VcsType,
} from './types.js';
import { ApiError } from './types.js';
import { createVcs, type VcsAdapter } from './vcs.js';
import {
  API_PREFIX,
  APP_VERSION,
  RepoLock,
  composeSessionPrompt,
  guardFrom,
  readJson,
  relative,
  sendError,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiDeps,
  type ApiHost,
  type Runtime,
} from './api-context.js';
import { ReadModels } from './api-readmodels.js';
import { Writers } from './api-writers.js';
import { AuditRuntime } from './api-audit.js';

export { API_PREFIX };

export class ReviewApi implements ApiHost {
  private settings: AppSettings;
  private store: ReviewStore | null = null;
  private vcs: VcsAdapter | null = null;
  private vcsType: VcsType | null = null;
  private configErrors: string[] = [];
  private readonly runtimeCache = new Map<string, Runtime>();
  private readonly jobs = new JobManager();
  /** §12.1 repo 锁（不可重入，重入即抛可诊断错误）。 */
  private readonly repoLock = new RepoLock();

  /** 读模型与投影（queue/candidate/patch/diff/findings/audits/reviewers…）。 */
  private readonly readModels: ReadModels;
  /** 共享写事务（提交三分支、前置校验、候选/档案/工作区写端点）。 */
  private readonly writers: Writers;
  /** 审查生命周期装配（租约持久化、开始/收尾/释放、跟踪 Job、1 小时超时、/sync）。 */
  private readonly auditRuntime: AuditRuntime;

  constructor(readonly deps: ApiDeps) {
    this.settings = deps.settings;
    this.readModels = new ReadModels(this);
    this.writers = new Writers(this, this.readModels);
    this.auditRuntime = new AuditRuntime(this);
  }

  /** ApiHost：子模块（写事务/审查生命周期）共用的 Job 管理器。 */
  get jobManager(): JobManager {
    return this.jobs;
  }

  async init(): Promise<void> {
    await this.reconfigure(this.deps.settings);
    // §7.6：加载持久化审查租约——Host 重启后 active/releasable 租约继续阻塞自动写操作。
    await this.auditRuntime.loadAuditLeases();
    this.startScheduler();
  }

  /** ApiHost：`settings` 在 reconfigure 中被整体替换，子模块必须经此访问当前值。 */
  currentSettings(): AppSettings {
    return this.settings;
  }

  /** ApiHost：reconfigure 探测到的 VCS 类型。 */
  get detectedVcsType(): VcsType | null {
    return this.vcsType;
  }

  /** ApiHost：最近一次 reconfigure 的校验错误（readmodels 的 /settings 降级分支使用）。 */
  get lastConfigErrors(): readonly string[] {
    return this.configErrors;
  }

  /** ApiHost：按 auditId 查租约（不存在返回 undefined）。 */
  leaseLookup(auditId: string): AuditLeaseRecord | undefined {
    return this.auditLifecycle.find(auditId);
  }

  /** ApiHost：租约迁移的窄入口（供 /audit/release 与 finalize 使用）。 */
  async leaseTransition(auditId: string, state: 'released' | 'releasable'): Promise<void> {
    await this.auditLifecycle.transition(auditId, state);
  }

  /** ApiHost：§7.6 审查租约状态机（唯一迁移入口）。 */
  get auditLifecycle(): AuditLifecycle {
    return this.auditRuntime.auditLifecycle;
  }

  /** ApiHost：§7.7 运行中的审查 Job / 未释放租约一律阻止自动写。 */
  ensureNoAuditRunning(root?: string): void {
    this.auditRuntime.ensureNoAuditRunning(root);
  }

  /** ApiHost：会话/手动/定时审查跟踪 Job 的完成回调（仅内存；重启后由 finalize 直接新建 Job）。 */
  readonly auditJobFinishes = new Map<string, (result?: unknown) => void>();
  /** ApiHost：跟踪 Job id → auditId，供 /jobs/:id/cancel 把租约转为 releasable。 */
  readonly auditJobLeases = new Map<string, string>();

  // ---------- §6.1 定时审查（scheduled trigger） ----------

  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  private startScheduler(): void {
    this.stopScheduler();
    const minutes = this.settings.scheduleIntervalMinutes;
    if (!(minutes > 0) || !this.deps.createAuditSession) return;
    this.scheduleTimer = setInterval(() => {
      void this.runScheduledAudit().catch((error) => {
        console.error('[dsh-code-review] 定时审查失败：', error instanceof Error ? error.message : String(error));
      });
    }, minutes * 60_000);
    this.scheduleTimer.unref?.();
  }

  /** 停止定时审查调度（插件卸载 / 测试收尾时调用）。 */
  stopScheduler(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  /** §7.6：定时触发防重入——60ms 级间隔下多次 tick 可能在首个租约落盘前重叠进入。 */
  private scheduledAuditInFlight = false;

  private async runScheduledAudit(): Promise<void> {
    if (this.scheduledAuditInFlight) return;
    this.scheduledAuditInFlight = true;
    try {
      await this.runScheduledAuditOnce();
    } finally {
      this.scheduledAuditInFlight = false;
    }
  }

  private async runScheduledAuditOnce(): Promise<void> {
    const runtime = await this.runtimeFor(new URL('http://local/')).catch(() => null);
    if (!runtime || !this.deps.createAuditSession) return;
    await this.withWriteLock(runtime.root, async () => {
      if (this.jobs.list().some((job) => job.status === 'running')) return;
      if (this.auditLifecycle.blockingLeaseFor(runtime.root)) return;
      const baseRevision = await runtime.vcs.getCurrentBase().catch(() => null);
      if (!baseRevision) return;
      const clean = await runtime.vcs.ensureCleanWorkspace().catch(() => ({ clean: false, message: 'unknown' }));
      const owner = await this.ownerFor(runtime.root);
      const now = new Date();
      const { auditId, reportPath } = await this.auditRuntime.beginAuditLeaseUnderLock(
        runtime,
        { targetPath: '', baseRevision, owner, now, trigger: 'scheduled' },
        clean,
      );
      try {
        const sharedSource = await sharedSourceFor(runtime);
        const userPrompt = await buildAuditPrompt({
          repoRoot: runtime.root,
          vcsType: runtime.vcsType,
          owner,
          targetPath: '',
          note: '定时审查（trigger: scheduled）',
          baseRevision,
          reportPath,
          mode: 'session',
          now,
          ...(sharedSource ? { source: sharedSource } : {}),
        });
        const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.auditRuntime.ownerRoutingBlock(runtime.root, sharedSource)}`);
        const created = await this.deps.createAuditSession?.({ cwd: runtime.root, title: '定时仓库审查', prompt, ownerSessionId: '' });
        if (!created) throw new Error('定时审查会话创建未返回结果');
        this.auditRuntime.trackAuditSession(runtime, auditId, created.sessionId);
      } catch (error) {
        await this.auditRuntime.releaseLeaseById(auditId);
        throw error;
      }
    });
  }

  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return this.repoLock.withWriteLock(repoRoot, fn);
  }

  /** 共享写路由统一加锁（§12.1：同一检出的写操作串行化）。 */
  private withRepoLock<T>(url: URL, fn: () => Promise<T>): Promise<T> {
    return this.repoLock.withRepoLock(url, (target) => this.runtimeFor(target), fn);
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  private async reconfigure(settings: AppSettings): Promise<void> {
    this.settings = settings;
    this.store = null;
    this.vcs = null;
    this.vcsType = null;
    this.configErrors = [];
    this.runtimeCache.clear();
    if (!settings.repoRoot.trim()) {
      return;
    }
    let validation = await validateSettings(settings);
    if (!validation.vcsType && settings.repoRoot) {
      const detected = await detectVcs(path.resolve(settings.repoRoot)).catch(() => null);
      if (detected) {
        validation = { ok: false, errors: validation.errors, vcsType: detected };
      }
    }
    this.configErrors = validation.errors;
    this.vcsType = validation.vcsType;
    if (!validation.vcsType) return;
    const root = path.resolve(settings.repoRoot);
    this.store = new ReviewStore(root);
    this.vcs = createVcs(validation.vcsType, root, settings.baseBranch);
  }

  async runtimeFor(url: URL): Promise<Runtime> {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const sessionRoot = sessionId ? this.deps.resolveSessionCwd?.(sessionId) : undefined;
    const selected = (sessionRoot ?? '').trim() || this.settings.repoRoot.trim();
    if (!selected) {
      throw new ApiError(412, 'not_configured', '当前会话没有可用目录，且未配置产品仓库');
    }
    const root = path.resolve(selected);
    const cached = this.runtimeCache.get(root);
    if (cached) return cached;
    const vcsType = await detectVcs(root).catch(() => null);
    if (!vcsType) {
      throw new ApiError(412, 'not_configured', `${root} 不是 Git/SVN 仓库，评审需要产品仓库工作区`);
    }
    const runtime: Runtime = {
      root,
      vcsType,
      store: new ReviewStore(root),
      vcs: createVcs(vcsType, root, this.settings.baseBranch),
    };
    this.runtimeCache.set(root, runtime);
    if (this.runtimeCache.size > 8) {
      const first = this.runtimeCache.keys().next().value;
      if (first !== undefined) this.runtimeCache.delete(first);
    }
    return runtime;
  }

  async ownerFor(root: string): Promise<string> {
    if (this.settings.owner.trim()) return this.settings.owner;
    return suggestOwner(root).catch(() => '');
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    try {
      // §8.1：带 body 的请求必须声明 application/json（解析/Content-Type 错误 400）。
      if ((req.method === 'POST' || req.method === 'PUT') && (req.headers['content-length'] ?? '0') !== '0') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          throw new ApiError(400, 'bad_request', '带 body 的请求必须使用 Content-Type: application/json');
        }
      }
      await this.dispatch(req, res, route, url);
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  /**
   * §7.7/§12.1：声明式路由表。横切语义（repo 锁、审查互斥、runtime 解析）由
   * `dispatch` 依据 `RouteKind` 统一套用，不再依赖命令式 if 链手工登记
   * （历史缺陷 C1：`/comments` 等端点漏了审查互斥）。
   */
  private readonly routes = new RouteTable().addAll([
    // ---------- 全局只读状态 ----------
    { method: 'GET', path: '/', kind: 'global-read', handler: ({ res, url }) => this.health(res, url) },
    { method: 'GET', path: '/health', kind: 'global-read', handler: ({ res, url }) => this.health(res, url) },
    { method: 'GET', path: '/settings', kind: 'global-read', handler: ({ res, url }) => this.getSettingsResponse(res, url) },
    { method: 'PUT', path: '/settings', kind: 'settings-write', handler: ({ req, res }) => this.putSettings(req, res) },
    { method: 'GET', path: '/jobs', kind: 'global-read', handler: ({ res }) => this.jobsList(res) },
    { method: 'GET', path: '/jobs/:id', kind: 'global-read', handler: ({ res, url, params }) => this.jobGet(res, params['id'] ?? '', url) },
    { method: 'POST', path: '/jobs/:id/cancel', kind: 'control', handler: ({ req, res, params }) => this.jobCancel(req, res, params['id'] ?? '') },
    {
      method: 'GET',
      path: '/client-entry',
      kind: 'global-read',
      handler: ({ res }) => {
        let entry: unknown = null;
        try {
          entry = this.deps.clientEntry?.() ?? null;
        } catch (error) {
          entry = { error: error instanceof Error ? error.message : String(error) };
        }
        sendJson(res, 200, { entry });
      },
    },
    // ---------- 共享事实读 ----------
    { method: 'GET', path: '/queue', kind: 'read', handler: ({ res, url }) => this.readModels.queue(res, url) },
    { method: 'GET', path: '/candidate', kind: 'read', handler: ({ res, url }) => this.readModels.candidate(res, url) },
    { method: 'GET', path: '/patch', kind: 'read', handler: ({ res, url }) => this.readModels.patch(res, url) },
    { method: 'GET', path: '/diff', kind: 'read', handler: ({ res, url }) => this.readModels.diff(res, url) },
    { method: 'GET', path: '/fix-prompt', kind: 'read', handler: ({ res, url }) => this.readModels.fixPrompt(res, url) },
    { method: 'GET', path: '/reviewers', kind: 'read', handler: ({ res, url }) => this.readModels.reviewers(res, url) },
    { method: 'GET', path: '/audits', kind: 'read', handler: ({ res, url }) => this.readModels.auditsList(res, url) },
    { method: 'GET', path: '/findings', kind: 'read', handler: ({ res, url }) => this.readModels.findings(res, url) },
    { method: 'GET', path: '/audit/prompt', kind: 'read', handler: ({ res, url }) => this.auditRuntime.auditPrompt(res, url) },
    // ---------- 审查控制（handler 自管理互斥，不套 ensureNoAuditRunning；finalize/release 另有豁免） ----------
    { method: 'POST', path: '/audit/session', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditSession(req, res, url) },
    { method: 'POST', path: '/audit', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.audit(req, res, url) },
    { method: 'POST', path: '/audit/manual', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditManual(req, res, url) },
    { method: 'POST', path: '/audit/finalize', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditFinalize(req, res, url) },
    { method: 'POST', path: '/audit/release', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditRelease(req, res, url) },
    { method: 'POST', path: '/sync', kind: 'audit-control', handler: ({ res, url }) => this.auditRuntime.sync(res, url) },
    // ---------- 候选/档案共享写（repo 锁 + 审查互斥） ----------
    { method: 'POST', path: '/comments', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.addComment(req, res, url) },
    { method: 'POST', path: '/comments/batch', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.addCommentsBatch(req, res, url) },
    { method: 'POST', path: '/comment-status', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.commentStatus(req, res, url) },
    { method: 'POST', path: '/takeover', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.takeover(req, res, url) },
    { method: 'POST', path: '/resume', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.resume(req, res, url) },
    { method: 'POST', path: '/reject', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.reject(req, res, url) },
    { method: 'POST', path: '/archive-stale', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.reject(req, res, url, 'stale') },
    { method: 'POST', path: '/reopen', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.reopen(req, res, url) },
    { method: 'POST', path: '/convert', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.convert(req, res, url) },
    { method: 'POST', path: '/dismiss-finding', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.dismissFinding(req, res, url) },
    { method: 'POST', path: '/candidate/finalize', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.candidateFinalize(req, res, url) },
    // ---------- 工作区事务（handler 内部在 Job 中取锁） ----------
    { method: 'POST', path: '/rebase', kind: 'workspace-txn', handler: ({ req, res, url }) => this.writers.rebase(req, res, url) },
    { method: 'POST', path: '/manual-revision', kind: 'workspace-txn', handler: ({ req, res, url }) => this.writers.manualRevision(req, res, url) },
    // ---------- 长任务启动（受理前做审查互斥，Job 内取锁） ----------
    { method: 'POST', path: '/approve', kind: 'job-start', handler: ({ req, res, url }) => this.approve(req, res, url) },
    { method: 'POST', path: '/ai-fix', kind: 'job-start', handler: ({ req, res, url }) => this.aiFix(req, res, url) },
  ]);

  private async dispatch(req: IncomingMessage, res: ServerResponse, route: string, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const matched = this.routes.match(method, route);
    if (!matched) throw new ApiError(404, 'not_found', `未知接口：${method} ${route}`);
    const { spec, params } = matched;
    const run = (): void | Promise<void> => spec.handler({ req, res, url, params, route });
    const locked = (): Promise<void> => this.withRepoLock(url, async () => { await run(); });
    // §7.7：审查运行中禁止共享写/新审查/sync——必须在受理阶段拒绝，而不是排队到审查结束后放行。
    // 判定必须先于加锁，否则请求会先进入锁队列而不是得到 409。
    // 例外：/audit/finalize 与 /audit/release 必须能在租约存在时执行（由 handler 按租约状态判定）。
    if (blockedByRunningAudit(spec.kind) && !isAuditSelfManaged(route)) {
      const runtime = await this.runtimeFor(url);
      this.ensureNoAuditRunning(runtime.root);
      return holdsRepoLock(spec.kind) ? locked() : run();
    }
    return holdsRepoLock(spec.kind) ? locked() : run();
  }

  private async health(res: ServerResponse, url: URL): Promise<void> {
    const diagnostics: string[] = [];
    let currentBase: string | null = null;
    let counts: Record<ReviewStatus, number> = {
      pending: 0,
      changes_requested: 0,
      approved: 0,
      rejected: 0,
    };
    let runtime: Runtime | null = null;
    let owner = this.settings.owner;
    try {
      runtime = await this.runtimeFor(url);
      owner = await this.ownerFor(runtime.root);
      currentBase = await runtime.vcs.getCurrentBase().catch(() => null);
      if (!existsSync(path.join(runtime.root, '.ai-review'))) {
        diagnostics.push('仓库缺少 .ai-review 目录');
      }
      try {
        counts = await runtime.store.listStatusCounts(owner, await sharedSourceFor(runtime));
      } catch (error) {
        diagnostics.push(`无法统计队列：${error instanceof Error ? error.message : String(error)}`);
      }
      // §7.6/§10.1：阻塞租约进入诊断——避免只看 /health 的调用者漏掉"共享写被 409 阻塞"的原因。
      try {
        const lease = this.auditLifecycle.blockingLeaseFor(runtime.root);
        if (lease) {
          diagnostics.push(
            `审查租约 ${lease.auditId} 处于 ${lease.state}，共享写被阻塞：请收尾（/audit/finalize）提交候选，或确认外部执行已停止后释放（/audit/release）`,
          );
        }
      } catch {
        // 租约状态机未初始化：跳过该诊断。
      }
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    const info: HealthInfo & { counts: Record<ReviewStatus, number>; configured: boolean } = {
      app: 'dsh-code-review',
      version: APP_VERSION,
      configured: runtime !== null,
      repoRoot: runtime?.root ?? this.settings.repoRoot,
      owner,
      vcsType: runtime?.vcsType ?? this.vcsType,
      currentBase,
      diagnostics,
      counts,
    };
    sendJson(res, 200, info);
  }

  private async getSettingsResponse(res: ServerResponse, url: URL): Promise<void> {
    let validation: { ok: boolean; errors: string[]; vcsType: VcsType | null } = {
      ok: true,
      errors: [],
      vcsType: this.vcsType,
    };
    let suggestedRoot = this.settings.repoRoot;
    try {
      const runtime = await this.runtimeFor(url);
      suggestedRoot = runtime.root;
      validation = { ok: true, errors: [], vcsType: runtime.vcsType };
    } catch {
      try {
        validation = await validateSettings(this.settings);
      } catch {
        validation = { ok: !this.settings.repoRoot, errors: this.configErrors, vcsType: this.vcsType };
      }
    }
    const suggestedOwner = await suggestOwner(suggestedRoot || process.cwd()).catch(() => '');
    sendJson(res, 200, {
      settings: this.settings,
      validation,
      suggestedOwner,
      runners: [
        { value: 'dsh', label: 'DSH headless（默认）' },
        { value: 'manual', label: '手动修复（生成提示）' },
        { value: 'external', label: '外部命令' },
      ],
    });
  }

  private async putSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const merged: AppSettings = {
      ...this.settings,
      ...(typeof body['repoRoot'] === 'string' ? { repoRoot: body['repoRoot'] } : {}),
      ...(typeof body['owner'] === 'string' ? { owner: body['owner'] } : {}),
      ...(body['vcsType'] === 'git' || body['vcsType'] === 'svn' || body['vcsType'] === 'auto' ? { vcsType: body['vcsType'] } : {}),
      ...(typeof body['baseBranch'] === 'string' ? { baseBranch: body['baseBranch'] } : {}),
      ...(body['runner'] === 'dsh' || body['runner'] === 'manual' || body['runner'] === 'external' ? { runner: body['runner'] } : {}),
      ...(typeof body['dshCommand'] === 'string' ? { dshCommand: body['dshCommand'] } : {}),
      ...(typeof body['externalCommand'] === 'string' ? { externalCommand: body['externalCommand'] } : {}),
      ...(typeof body['autoFixOnFailure'] === 'boolean' ? { autoFixOnFailure: body['autoFixOnFailure'] } : {}),
      ...(typeof body['syncBeforeApprove'] === 'boolean' ? { syncBeforeApprove: body['syncBeforeApprove'] } : {}),
      ...(typeof body['gateTimeoutMs'] === 'number' ? { gateTimeoutMs: body['gateTimeoutMs'] } : {}),
      ...(typeof body['scheduleIntervalMinutes'] === 'number' ? { scheduleIntervalMinutes: body['scheduleIntervalMinutes'] } : {}),
    };
    // §9：owner 保存时校验非空；vcsType 必须与实际仓库一致。
    if (body['owner'] !== undefined && (typeof body['owner'] !== 'string' || !body['owner'].trim())) {
      throw new ApiError(422, 'bad_request', 'owner 不能为空');
    }
    if (merged.vcsType !== 'auto' && merged.repoRoot.trim()) {
      const detected = await detectVcs(path.resolve(merged.repoRoot)).catch(() => null);
      if (detected !== null && detected !== merged.vcsType) {
        throw new ApiError(422, 'bad_request', `vcsType=${merged.vcsType} 与实际仓库（${detected}）不一致`);
      }
    }
    const saved = await this.deps.saveSettings(merged);
    await this.reconfigure(saved);
    this.startScheduler(); // 调度间隔运行期可改，立即生效
    const validation = await validateSettings(saved).catch(() => ({ ok: false, errors: this.configErrors, vcsType: this.vcsType }));
    sendJson(res, 200, { settings: saved, validation });
  }

  private async approve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    // §7.7 审查互斥由 routes.ts（kind: job-start）在受理阶段统一检查。
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    // §4.7：人工判断项的确认/知悉记录随批准提交。
    const confirmed = Array.isArray(body['confirmedDecisions'])
      ? body['confirmedDecisions'].map((item) => String(item).trim()).filter(Boolean)
      : [];
    const waivedRaw = Array.isArray(body['waivedDecisions']) ? body['waivedDecisions'] : [];
    const waived = waivedRaw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ id: String(item['id'] ?? '').trim(), reason: String(item['reason'] ?? '') }))
      .filter((item) => item.id);
    for (const item of waived) {
      if (!item.reason.trim()) throw new ApiError(422, 'bad_request', `知悉项 ${item.id} 必须填写理由`);
    }
    // §8.3/§7.5：可选 commitMessage——提供时先替换候选 commit_message 再校验首行；
    // 校验通过的值在批准原子提交中一并写入 review.md，并作为业务提交说明。
    const commitMessage = body['commitMessage'] === undefined
      ? undefined
      : (typeof body['commitMessage'] === 'string' ? body['commitMessage'] : '');
    if (commitMessage !== undefined && !commitMessage.trim()) {
      throw new ApiError(422, 'bad_request', 'commitMessage 提供时必须非空');
    }
    // §12.2：非 Owner 403（takeover 除外）。
    await this.writers.requireOwnerOf(store, id);
    await this.writers.requireSharedCandidate(runtime, id); // §7.1
    // §7.5/G19：受理前完整 guard 预检（409 stale）与 pending-only 状态预检（409 conflict）。
    {
      const detail = await store.get(id, null, await sharedSourceFor(runtime));
      if (detail.candidate.meta.currentRevision !== guard.expectedRevision
        || detail.candidate.meta.owner !== guard.expectedOwner
        || new Date(guard.expectedUpdatedAt).getTime() !== new Date(detail.candidate.meta.updatedAt).getTime()) {
        throw new ApiError(409, 'stale', '候选已被更新，请刷新后重试', {
          currentRevision: detail.candidate.meta.currentRevision,
          currentOwner: detail.candidate.meta.owner,
          currentUpdatedAt: detail.candidate.meta.updatedAt,
        });
      }
      if (detail.candidate.meta.status !== 'pending') {
        throw new ApiError(409, 'conflict', `只有 pending 可批准（当前 ${detail.candidate.meta.status}）；changes_requested 需先产生新版本或由 Owner 显式转回`);
      }
    }
    // §7.4：窗口内与被拒候选完全重复的候选被阻止批准；人工重开（/reopen）可豁免。
    {
      const reviewersCfg = await loadReviewers(store.repoRoot, await sharedSourceFor(runtime));
      if (reviewersCfg.rejectionMemoryDays > 0) {
        const queue = await store.list({}, null, null, reviewersCfg.rejectionMemoryDays, await sharedSourceFor(runtime));
        const duplicate = queue.items.find((item) => item.id === id);
        if (duplicate?.duplicateOf) {
          throw new ApiError(409, 'conflict', `该候选与窗口内的被拒候选完全重复（${duplicate.duplicateOf}），不能批准；如确为误判请先人工重开（POST /reopen）`);
        }
      }
    }
    const job = this.jobs.start('approve', async (log, jobId, signal) => {
      // §6/§7.5 重复候选复检闭包：供受理后、同步后、门禁后三处复检（G35）。
      const checkDuplicate = async (): Promise<string | null> => {
        const reviewersCfg = await loadReviewers(store.repoRoot, await sharedSourceFor(runtime));
        if (reviewersCfg.rejectionMemoryDays <= 0) return null;
        const queue = await store.list({}, null, null, reviewersCfg.rejectionMemoryDays, await sharedSourceFor(runtime));
        return queue.items.find((item) => item.id === id && !item.local)?.duplicateOf ?? null;
      };
      const orchestrator = new ApprovalOrchestrator({
        store,
        vcs,
        settings: this.settings,
        makeRunner: (request) => new Runner(request),
        checkDuplicate,
        validateNewRevision: (previous, latest) => this.writers.validateNewRevision(runtime, previous, latest, 'ai'),
        // §7.1：批准流程内部重读候选必须绑定共享快照（每次重建，同步后重绑）。
        sharedSource: () => sharedSourceFor(runtime),
        // §7.7/G30：批准流程在安全检查点读取取消标志；Runner 由取消信号终止。
        shouldCancel: () => Boolean((job as { cancelRequested?: boolean }).cancelRequested),
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
        signal,
      });
      // §12.1：批准人使用实际操作者，不用 expectedOwner 冒充身份。
      const me = await this.ownerFor(store.repoRoot);
      const outcome = await this.withWriteLock(store.repoRoot, () => orchestrator.approve(id, guard, jobId, log, { confirmed, waived }, me, commitMessage));
      log(`结果：${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} — ${outcome.message}`);
      return outcome;
    });
    sendJson(res, 202, { jobId: job.id, job });
  }

  private async aiFix(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const job = await this.startAiFixJob(runtime, id, guard);
    sendJson(res, 202, { jobId: job.id, job });
  }

  /**
   * Start one AI-fix job from the candidate's unresolved feedback. Shared by
   * the explicit `/ai-fix` action and the auto-fix chain that follows an
   * overall opinion, so both paths validate and run identically.
   */
  async startAiFixJob(runtime: Runtime, id: string, guard: ConcurrencyGuard): Promise<JobRecord> {
    const { store, vcs } = runtime;
    const acceptedSource = await sharedSourceFor(runtime);
    if (!acceptedSource) throw new ApiError(409, 'conflict', '无法建立共享 VCS 快照，AI 修复已中止');
    const detail = await store.get(id, null, acceptedSource);
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', detail.candidate.parseError);
    const me = await this.ownerFor(store.repoRoot);
    if (detail.candidate.meta.owner !== me) throw new ApiError(403, 'forbidden', `当前操作者 ${me} 不是候选 Owner`);
    await this.writers.requireSharedCandidate(runtime, id);
    const actionable = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
    if (actionable.length === 0) {
      throw new ApiError(409, 'conflict', '没有未解决的评论可作为 AI 修复输入；请先提出具体意见');
    }
    if (detail.candidate.meta.currentRevision !== guard.expectedRevision || detail.candidate.meta.owner !== guard.expectedOwner
      || new Date(guard.expectedUpdatedAt).getTime() !== new Date(detail.candidate.meta.updatedAt).getTime()) {
      throw new ApiError(409, 'stale', '候选已被更新，请重新加载');
    }
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '已归档的候选不能再触发 AI 修复');
    }
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', clean.message);
    return this.jobs.start('ai_fix', (log, jobId, signal): Promise<AiFixOutcome> => this.withWriteLock(runtime.root, async () => {
      const source = await sharedSourceFor(runtime);
      if (!source) return this.writers.aborted('INVALID_CANDIDATE', '无法重新建立共享 VCS 快照', jobId);
      const { month, slug } = store.resolveCandidateDir(id);
      if (await source.hasLocalChanges(month, slug)) {
        return this.writers.aborted('CONCURRENCY_MISMATCH', '候选存在本地或暂存改动，共享/本地边界无法证明', jobId);
      }
      const fresh = await store.get(id, null, source);
      const candidate = fresh.candidate;
      if (candidate.parseError) return this.writers.aborted('INVALID_CANDIDATE', candidate.parseError, jobId);
      if (candidate.meta.currentRevision !== guard.expectedRevision || candidate.meta.owner !== guard.expectedOwner
        || new Date(candidate.meta.updatedAt).getTime() !== new Date(guard.expectedUpdatedAt).getTime()) {
        return this.writers.aborted('CONCURRENCY_MISMATCH', '候选已在排队期间更新，旧 guard 不得继续使用', jobId);
      }
      if (candidate.meta.status !== 'pending' && candidate.meta.status !== 'changes_requested') {
        return this.writers.aborted('STATE_CONFLICT', `当前状态 ${candidate.meta.status} 不允许 AI 修复`, jobId);
      }
      const comments = candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
      if (comments.length === 0) return this.writers.aborted('STATE_CONFLICT', '锁内复核时没有未解决评论', jobId);
      const cleanNow = await vcs.ensureCleanWorkspace();
      if (!cleanNow.clean) return this.writers.aborted('DIRTY_WORKSPACE', `锁内复核发现业务工作区不干净：${cleanNow.message}`, jobId);
      const patch = await store.currentPatch(candidate, source);
      const { readFile: readFs, readdir } = await import('node:fs/promises');
      const reviewBackup = await readFs(candidate.reviewPath, 'utf8');
      const entriesBefore = new Set(await readdir(candidate.dirPath).catch(() => [] as string[]));
      let workingTree: 'clean_base' | 'current_patch_applied' = 'clean_base';
      if (this.settings.runner !== 'manual') {
        const applied = await this.writers.applyPatchText(vcs, patch.text, false);
        if (!applied.ok) {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
          return this.writers.aborted('INVALID_CANDIDATE', `当前共享补丁无法严格应用：${applied.message}`, jobId);
        }
        workingTree = 'current_patch_applied';
        log(`已应用共享快照中的当前补丁 ${patch.path.split(/[\\/]/).pop() ?? ''}`);
      }
      const runner = new Runner({
        kind: this.settings.runner,
        settings: this.settings,
        store,
        candidate,
        mode: 'ADDRESS_FEEDBACK',
        comments,
        workingTree,
        log,
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
        signal,
      });
      let result;
      try {
        result = await runner.run();
      } finally {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
      }
      if (result.manual) return { status: 'MANUAL_REQUIRED', message: 'AI 修复生成了人工执行提示', manualPrompt: result.prompt ?? '', jobId } satisfies AiFixOutcome;
      if (!result.success) {
        await this.writers.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
        if (result.aborted) return this.writers.aborted('CANCELLED', 'AI 修复已取消（未产生共享提交）', jobId);
        return this.writers.aborted(
          'RUNNER_FAILED',
          `AI 修复失败：${result.errorMessage ?? '未知错误'}${result.outputTail ? `\n\n${result.outputTail.slice(-4000)}` : ''}`,
          jobId,
        );
      }
      const latest = await store.get(id, null);
      const validationErrors = await this.writers.validateNewRevision(runtime, candidate, latest.candidate, 'ai');
      if (validationErrors.length > 0) {
        await this.writers.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
        return this.writers.aborted('INVALID_CANDIDATE', `AI 新版本未通过提交前校验，已恢复：\n${validationErrors.join('\n')}`, jobId);
      }
      const currentSnapshot = await sharedSourceFor(runtime);
      const beforeSnapshot = await source.snapshotId();
      const afterSnapshot = await currentSnapshot?.snapshotId();
      if (beforeSnapshot !== null && afterSnapshot !== beforeSnapshot) {
        return this.writers.recoveryRequired('COMMIT_OUTCOME_UNKNOWN', 'Runner 期间 VCS 快照发生变化，禁止覆盖或猜测恢复', jobId, `before=${beforeSnapshot}; after=${afterSnapshot ?? 'unknown'}`);
      }
      const current = latest.candidate.meta.revisions.find((revision) => revision.id === latest.candidate.meta.currentRevision);
      const writtenReview = await readFs(latest.candidate.reviewPath, 'utf8').catch(() => null);
      const writtenPatch = current ? await readFs(path.join(latest.candidate.dirPath, current.patch), 'utf8').catch(() => null) : null;
      const expectedFiles = [
        ...(writtenReview !== null ? [{ relPath: relative(store.repoRoot, latest.candidate.reviewPath), text: writtenReview }] : []),
        ...(current && writtenPatch !== null ? [{ relPath: relative(store.repoRoot, path.join(latest.candidate.dirPath, current.patch)), text: writtenPatch }] : []),
      ];
      const outcome = await this.writers.commitAndClassify({
        runtime,
        message: `review(${id}): AI 修复生成版本 ${String(latest.candidate.meta.currentRevision)}`,
        paths: [relative(store.repoRoot, latest.candidate.dirPath)],
        probePaths: [relative(store.repoRoot, latest.candidate.reviewPath)],
        expectedFiles,
      });
      if (!outcome.landed) {
        if (outcome.outcome === 'RECOVERY_REQUIRED') {
          return this.writers.recoveryRequired('COMMIT_OUTCOME_UNKNOWN', `AI 修复新版本提交结果无法确定，现场保留待人工核对：${outcome.detail}`, jobId, outcome.detail);
        }
        await this.writers.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
        return this.writers.aborted('COMMIT_FAILED', `AI 已生成新版本，但提交 .ai-review 失败（已恢复）：${outcome.detail}`, jobId, outcome.detail);
      }
      return this.writers.committed(`AI 修复完成，版本 ${String(latest.candidate.meta.currentRevision)}`, jobId, {
        commitRevision: outcome.commitRevision,
        newRevision: latest.candidate.meta.currentRevision,
      });
    }));
  }

  /**
   * §7.7/G30 /jobs/:id/cancel：幂等取消——请求停止后续执行，不强行改写业务结果。
   * 已结束 Job 直接返回原结果；运行中的设置 cancelRequested 标志（批准流程在安全检查点
   * 读取并中止——此时已证明共享提交不存在，可安全 ABORTED）；租约不随取消自动释放。
   */
  private async jobCancel(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
    await readJson(req).catch(() => ({}));
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'not_found', '任务不存在');
    if (job.status !== 'running') {
      sendJson(res, 202, { jobId: job.id, job });
      return;
    }
    (job as { cancelRequested?: boolean }).cancelRequested = true;
    // §7.7：终止进程型 Runner（若该 Job 正在运行 dsh/external 命令）。
    this.jobs.abort(job.id);
    // §7.6/§7.7：取消审查 Job 只把租约置 releasable 并结束跟踪 Job；
    // 租约仍阻塞自动写，必须人工确认外部执行停止后 /audit/release。
    const auditId = this.auditJobLeases.get(job.id);
    if (auditId) {
      // §7.6：取消只迁到 releasable（仍阻塞），绝不自动释放；状态迁移走唯一入口。
      await this.auditLifecycle.markReleasable(auditId).catch(() => false);
      this.auditJobFinishes.get(auditId)?.({
        status: 'ABORTED',
        auditId,
        message: '审查 Job 已取消；租约保持占用，确认外部执行停止后调用 /audit/release',
      });
      this.auditJobFinishes.delete(auditId);
      this.auditJobLeases.delete(job.id);
    }
    sendJson(res, 202, { jobId: job.id, job });
  }

  private jobsList(res: ServerResponse): void {
    sendJson(res, 200, { jobs: this.jobs.list() });
  }

  private jobGet(res: ServerResponse, jobId: string, url: URL): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'not_found', '任务不存在');
    // §8.2/G36：since/logOffset/totalLogLines/earliestLogOffset 都是单调递增绝对行序号；
    // since 早于最早保留行时返回完整保留日志并置 logResetRequired=true。
    const earliest = job.logStartOffset ?? 0;
    const total = earliest + job.log.length;
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam !== null && Number.isFinite(Number(sinceParam)) ? Math.max(0, Number(sinceParam)) : null;
    let lines = job.log;
    let logResetRequired = false;
    if (since !== null) {
      if (since < earliest) {
        logResetRequired = true;
      } else {
        lines = job.log.slice(since - earliest);
      }
    }
    sendJson(res, 200, {
      ...job,
      log: lines,
      logOffset: total,
      totalLogLines: total,
      earliestLogOffset: earliest,
      logResetRequired,
    });
  }
}

