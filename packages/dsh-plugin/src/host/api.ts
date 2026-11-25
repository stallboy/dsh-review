import { existsSync } from 'node:fs';
import type { ApiRequest, ApiResponse } from './api-context.js';
import path from 'node:path';
import process from 'node:process';
import { ApprovalOrchestrator } from './approval.js';
import { FindingApprovalState } from './finding-approval-state.js';
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
  ApprovalOutcome,
  ConcurrencyGuard,
  HealthInfo,
  JobRecord,
  ReviewStatus,
  ReviewCandidate,
  VcsType,
} from './types.js';
import { ApiError } from './types.js';
import { createVcs, type VcsAdapter } from './vcs.js';
import {
  API_PREFIX,
  APP_VERSION,
  RepoLock,
  guardFrom,
  readJson,
  relative,
  sendError,
  sendJson,
  sharedSourceFor,
  stringField,
  currentTrustedActor,
  internalRequest,
  withTrustedActor,
  type ApiInvocation,
  type ApiInvocationResult,
  type ApiDeps,
  type ApiHost,
  type Runtime,
} from './api-context.js';
import { ReadModels } from './api-readmodels.js';
import { Writers } from './api-writers.js';
import { AuditRuntime } from './api-audit.js';
import { FixSessions } from './api-fix-session.js';
import { normalizeCommitDetail } from './commit-message.js';
import type { CommitMessageDetail } from './commit-message.js';

export { API_PREFIX };

export class ReviewApi implements ApiHost {
  private settings: AppSettings;
  private store: ReviewStore | null = null;
  private vcs: VcsAdapter | null = null;
  private vcsType: VcsType | null = null;
  private configErrors: string[] = [];
  private readonly runtimeCache = new Map<string, Runtime>();
  private readonly jobs = new JobManager();
  private readonly repoLock = new RepoLock();

  private readonly readModels: ReadModels;
  private readonly writers: Writers;
  private readonly auditRuntime: AuditRuntime;
  private readonly fixSessions: FixSessions;

  constructor(readonly deps: ApiDeps) {
    this.settings = deps.settings;
    this.readModels = new ReadModels(this);
    this.writers = new Writers(this, this.readModels);
    this.auditRuntime = new AuditRuntime(this);
    this.fixSessions = new FixSessions(this);
  }

  get jobManager(): JobManager {
    return this.jobs;
  }

  async init(): Promise<void> {
    await this.reconfigure(this.deps.settings);
    await this.auditRuntime.loadAuditLeases();
  }

  currentSettings(): AppSettings {
    return this.settings;
  }

  get detectedVcsType(): VcsType | null {
    return this.vcsType;
  }

  get lastConfigErrors(): readonly string[] {
    return this.configErrors;
  }

  closeAudit(): Promise<void> { return this.auditRuntime.close(); }

  runAuditSelfTest(signal: AbortSignal, progress: (step: string, message: string) => void) {
    return this.auditRuntime.runSelfTest(signal, progress);
  }

  hasAuditStageSession(sessionId: string): boolean {
    return this.auditRuntime.hasStageSession(sessionId);
  }

  runAuditStage(sessionId: string, stage: import('./audit-prompts.js').AuditStage, runner: import('./audit-stage-runner.js').AuditExecutor,
    task: unknown, signal: AbortSignal): Promise<unknown> {
    return this.auditRuntime.runStage(sessionId, stage, runner, task, signal);
  }

  publishAuditStages(sessionId: string, input: unknown, signal?: AbortSignal): ReturnType<AuditRuntime['publishStages']> {
    return this.auditRuntime.publishStages(sessionId, input, signal);
  }

  queryAuditHistory(sessionId: string, disposition?: string): Promise<unknown> {
    return this.auditRuntime.queryHistory(sessionId, disposition);
  }

  leaseLookup(auditId: string): AuditLeaseRecord | undefined {
    return this.auditLifecycle.find(auditId);
  }

  isAuditStopping(auditId: string): boolean { return this.auditRuntime.isAuditStopping(auditId); }

  hasActiveAuditWork(auditId: string): boolean {
    return this.auditRuntime.hasActiveAuditWork(auditId);
  }

  async leaseTransition(auditId: string, state: 'released' | 'releasable'): Promise<void> {
    await this.auditLifecycle.transition(auditId, state);
  }

  get auditLifecycle(): AuditLifecycle {
    return this.auditRuntime.auditLifecycle;
  }

  ensureNoAuditRunning(root?: string): void {
    this.auditRuntime.ensureNoAuditRunning(root);
  }

  get fixSessionGuard(): FixSessions {
    return this.fixSessions;
  }

  readonly auditJobFinishes = new Map<string, (result?: unknown) => void>();
  readonly auditJobLeases = new Map<string, string>();

  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return this.repoLock.withWriteLock(repoRoot, fn);
  }

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
    const adapter = createVcs(validation.vcsType, root, settings.baseBranch);
    this.vcs = this.deps.decorateVcs?.(adapter) ?? adapter;
  }

  async runtimeFor(url: URL): Promise<Runtime> {
    const settings = this.settings;
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const sessionRoot = sessionId ? this.deps.resolveSessionCwd?.(sessionId) : undefined;
    const selected = (sessionRoot ?? '').trim() || settings.repoRoot.trim();
    const root = selected ? path.resolve(selected) : '';
    const expectedRepoRoot = url.searchParams.get('expectedRepoRoot');
    if (expectedRepoRoot !== null && expectedRepoRoot !== root) {
      throw new ApiError(409, 'conflict', '评审仓库已切换，请刷新工作台后重试');
    }
    if (!root) {
      throw new ApiError(412, 'not_configured', '当前会话没有可用目录，且未配置产品仓库');
    }
    const cached = this.runtimeCache.get(root);
    if (cached) return cached;
    const vcsType = await detectVcs(root).catch(() => null);
    if (!vcsType) {
      throw new ApiError(412, 'not_configured', `${root} 不是 Git/SVN 仓库，评审需要产品仓库工作区`);
    }
    const adapter = createVcs(vcsType, root, settings.baseBranch);
    const runtime: Runtime = {
      root,
      vcsType,
      store: new ReviewStore(root),
      vcs: this.deps.decorateVcs?.(adapter) ?? adapter,
    };
    this.runtimeCache.set(root, runtime);
    if (this.runtimeCache.size > 8) {
      const first = this.runtimeCache.keys().next().value;
      if (first !== undefined) this.runtimeCache.delete(first);
    }
    return runtime;
  }

  async ownerFor(root: string): Promise<string> {
    const actor = currentTrustedActor();
    if (actor) return actor.reviewIdentity;
    if (this.settings.owner.trim()) return this.settings.owner;
    return suggestOwner(root).catch(() => '');
  }

  async invoke(input: ApiInvocation): Promise<ApiInvocationResult> {
    const url = new URL(input.path, 'http://internal');
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {};
    let payload = '';
    const response: ApiResponse = {
        statusCode: 200,
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        end(value) { payload += typeof value === 'string' ? value : value ? Buffer.from(value).toString('utf8') : ''; },
    };
    const execute = async (): Promise<ApiInvocationResult> => {
        try { await this.dispatch(internalRequest(input.method, url.href, input.body ?? {}), response, url.pathname, url); }
        catch (error) { sendError(response, error); }
        return { status: response.statusCode, body: headers['content-type']?.includes('application/json') ? JSON.parse(payload) : payload, headers };
    };
    return input.actor ? withTrustedActor(input.actor, execute) : execute();
  }

  async handle(req: ApiRequest, res: ApiResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    try {
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
   * 路由类别集中决定锁、审查互斥和运行时解析，避免新增共享写端点遗漏互斥检查。
   */
  private readonly routes = new RouteTable().addAll([
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
    { method: 'GET', path: '/queue', kind: 'read', handler: ({ res, url }) => this.readModels.queue(res, url) },
    { method: 'GET', path: '/candidate', kind: 'read', handler: ({ res, url }) => this.readModels.candidate(res, url) },
    { method: 'GET', path: '/patch', kind: 'read', handler: ({ res, url }) => this.readModels.patch(res, url) },
    { method: 'GET', path: '/diff', kind: 'read', handler: ({ res, url }) => this.readModels.diff(res, url) },
    { method: 'GET', path: '/fix-prompt', kind: 'read', handler: ({ res, url }) => this.readModels.fixPrompt(res, url) },
    { method: 'GET', path: '/reviewers', kind: 'read', handler: ({ res, url }) => this.readModels.reviewers(res, url) },
    { method: 'GET', path: '/audits', kind: 'read', handler: ({ res, url }) => this.readModels.auditsList(res, url) },
    { method: 'GET', path: '/findings', kind: 'read', handler: ({ res, url }) => this.readModels.findings(res, url) },
    { method: 'GET', path: '/audit/prompt', kind: 'read', handler: ({ res, url }) => this.auditRuntime.auditPrompt(res, url) },
    { method: 'POST', path: '/audit/session', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditSession(req, res, url) },
    { method: 'POST', path: '/audit', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.audit(req, res, url) },
    { method: 'POST', path: '/audit/manual', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditManual(req, res, url) },
    { method: 'POST', path: '/audit/finalize', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditFinalize(req, res, url) },
    { method: 'POST', path: '/audit/release', kind: 'audit-control', handler: ({ req, res, url }) => this.auditRuntime.auditRelease(req, res, url) },
    { method: 'POST', path: '/sync', kind: 'audit-control', handler: ({ res, url }) => this.auditRuntime.sync(res, url) },
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
    { method: 'POST', path: '/finding/decision', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.findingDecision(req, res, url) },
    { method: 'POST', path: '/candidate/finalize', kind: 'candidate-write', handler: ({ req, res, url }) => this.writers.candidateFinalize(req, res, url) },
    { method: 'POST', path: '/rebase', kind: 'workspace-txn', handler: ({ req, res, url }) => this.writers.rebase(req, res, url) },
    // 创建会话可能长时间等待。路由仍检查审查互斥，由 FixSessions 单独占用该仓库，避免阻塞其他写事务。
    { method: 'POST', path: '/fix-session', kind: 'workspace-txn', handler: ({ req, res, url }) => this.fixSessions.create(req, res, url) },
    { method: 'POST', path: '/approve', kind: 'job-start', handler: ({ req, res, url }) => this.approve(req, res, url) },
    { method: 'POST', path: '/ai-fix', kind: 'job-start', handler: ({ req, res, url }) => this.aiFix(req, res, url) },
  ]);

  private async dispatch(req: ApiRequest, res: ApiResponse, route: string, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const matched = this.routes.match(method, route);
    if (!matched) throw new ApiError(404, 'not_found', `未知接口：${method} ${route}`);
    const { spec, params } = matched;
    const run = (): void | Promise<void> => spec.handler({ req, res, url, params, route });
    const locked = (): Promise<void> => this.withRepoLock(url, async () => { await run(); });
    // 先检查互斥再排队加锁，否则审查期间提交的写请求会等到审查结束后执行。
    if (blockedByRunningAudit(spec.kind) && !isAuditSelfManaged(route)) {
      const runtime = await this.runtimeFor(url);
      this.ensureNoAuditRunning(runtime.root);
      return holdsRepoLock(spec.kind) ? locked() : run();
    }
    return holdsRepoLock(spec.kind) ? locked() : run();
  }

  private async health(res: ApiResponse, url: URL): Promise<void> {
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
      // 健康检查调用者需要知道共享写入返回冲突是否由持久化租约引起。
      try {
        const lease = this.auditLifecycle.blockingLeaseFor(runtime.root);
        if (lease) {
          diagnostics.push(
            `审查租约 ${lease.auditId} 处于 ${lease.state}，共享写被阻塞：请收尾（/audit/finalize）提交候选，或确认外部执行已停止后释放（/audit/release）`,
          );
        }
      } catch {
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

  private async getSettingsResponse(res: ApiResponse, url: URL): Promise<void> {
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

  private async putSettings(req: ApiRequest, res: ApiResponse): Promise<void> {
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
    };
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
    const validation = await validateSettings(saved).catch(() => ({ ok: false, errors: this.configErrors, vcsType: this.vcsType }));
    sendJson(res, 200, { settings: saved, validation });
  }

  private async approve(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
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
    const commitMessage = body['commitMessage'] === undefined
      ? undefined
      : (typeof body['commitMessage'] === 'string' ? body['commitMessage'] : '');
    if (commitMessage !== undefined && !commitMessage.trim()) {
      throw new ApiError(422, 'bad_request', 'commitMessage 提供时必须非空');
    }
    let commitDetail: CommitMessageDetail | undefined;
    if (body['commitDetail'] !== undefined) {
      const normalized = normalizeCommitDetail(body['commitDetail']);
      if (!normalized) throw new ApiError(422, 'bad_request', "commitDetail 只能是 'simple' 或 'detailed'");
      commitDetail = normalized;
    }
    const expectedFindingVersion = stringField(body, 'expectedFindingVersion');
    const findingState = (findingId: string) => new FindingApprovalState(runtime.root, findingId, this.deps.statePath);
    const checkFinding = async (candidate: ReviewCandidate, verifyRecovery: boolean) => {
      if (!candidate.meta.findingId) return null;
      const { findings } = await this.readModels.findingProjection(runtime);
      const finding = findings.find((item) => item.findingId === candidate.meta.findingId);
      if (finding?.disposition !== 'undecided' || !finding.options?.some(option => option.candidateId === id && option.status === 'pending')) {
        return { reason: 'STATE_CONFLICT' as const, message: '发现已处置、已有获批补丁或此候选已退出选项' };
      }
      if (finding.findingVersion !== expectedFindingVersion) {
        return { reason: 'CONCURRENCY_MISMATCH' as const, message: '发现版本已更新，请刷新后重新选择补丁' };
      }
      if (verifyRecovery && !await findingState(candidate.meta.findingId).canRetry(vcs).catch(() => false)) {
        return { reason: 'STATE_CONFLICT' as const, message: '该发现的上一次审批提交结果仍待核验' };
      }
      return null;
    };
    await this.writers.requireOwnerOf(store, id);
    await this.writers.requireSharedCandidate(runtime, id);
    const approvalCommitInput = commitDetail === undefined && commitMessage === undefined
      ? undefined
      : { ...(commitMessage !== undefined ? { commitMessage } : {}), ...(commitDetail ? { commitDetail } : {}) };
    let findingId: string | undefined;
    {
      const detail = await store.get(id, null, await sharedSourceFor(runtime));
      findingId = detail.candidate.meta.findingId;
      if (detail.candidate.meta.findingId) {
        if (!expectedFindingVersion) throw new ApiError(422, 'bad_request', '新版候选缺少 expectedFindingVersion');
        const conflict = await checkFinding(detail.candidate, false);
        if (conflict) throw new ApiError(409, conflict.reason === 'CONCURRENCY_MISMATCH' ? 'stale' : 'conflict', conflict.message);
      }
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
        checkFinding: candidate => checkFinding(candidate, true),
        beginFindingCommit: (candidate, paths, probe) => findingState(candidate.meta.findingId!).begin(paths, probe),
        finishFindingCommit: candidate => findingState(candidate.meta.findingId!).clear(),
        validateNewRevision: (previous, latest) => this.writers.validateNewRevision(runtime, previous, latest),
        sharedSource: () => sharedSourceFor(runtime),
        shouldCancel: () => Boolean((job as { cancelRequested?: boolean }).cancelRequested),
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
        signal,
      });
      const me = await this.ownerFor(store.repoRoot);
      const outcome = await this.withWriteLock(store.repoRoot, async (): Promise<ApprovalOutcome> => {
        try {
          return await orchestrator.approve(id, guard, jobId, log, { confirmed, waived }, me, commitMessage, approvalCommitInput);
        } catch (error) {
          if (!findingId || !await findingState(findingId).pending().catch(() => true)) throw error;
          return { status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', jobId,
            message: '发现审批提交未返回可核验结果，请保留现场',
            detail: error instanceof Error ? error.message : String(error) };
        }
      });
      log(`结果：${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} — ${outcome.message}`);
      return outcome;
    });
    sendJson(res, 202, { jobId: job.id, job });
  }

  private async aiFix(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const job = await this.startAiFixJob(runtime, id, guard);
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** 显式修复与总体意见触发的自动修复共用此入口，确保采用相同的校验和执行规则。 */
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
      const validationErrors = await this.writers.validateNewRevision(runtime, candidate, latest.candidate);
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

  /** 取消审查跟踪后仍保留租约，因为外部执行可能继续操作工作区。 */
  private async jobCancel(req: ApiRequest, res: ApiResponse, jobId: string): Promise<void> {
    await readJson(req).catch(() => ({}));
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'not_found', '任务不存在');
    if (job.status !== 'running') {
      sendJson(res, 202, { jobId: job.id, job });
      return;
    }
    (job as { cancelRequested?: boolean }).cancelRequested = true;
    this.jobs.abort(job.id);
    const auditId = this.auditJobLeases.get(job.id);
    if (auditId) this.auditRuntime.stopStages(auditId);
    if (auditId && !this.auditRuntime.isFinalizing(auditId)) {
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

  private jobsList(res: ApiResponse): void {
    sendJson(res, 200, { jobs: this.jobs.list() });
  }

  private jobGet(res: ApiResponse, jobId: string, url: URL): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'not_found', '任务不存在');
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

