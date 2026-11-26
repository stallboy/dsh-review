/**
 * 评审 HTTP API 网关：串联声明式路由表、仓库解析、repo 锁、持久化租约/提案占用互斥与各子处理器。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  API_PREFIX,
  currentTrustedActor,
  internalRequest,
  RepoLock,
  sendError,
  sendJson,
  withTrustedActor,
  type ApiDeps,
  type ApiHost,
  type ApiInvocation,
  type ApiInvocationResult,
  type ApiRequest,
  type ApiResponse,
  type Runtime,
} from './api-context.js';
import {
  closeManualAuditChannels,
  handleAuditFinalize,
  handleAuditManual,
  handleAuditPrompt,
  handleAuditRelease,
  handleAuditSession,
  handleAuditStart,
  handleJobCancel,
  queryAuditHistoryForSession,
  publishAuditStagesForSession,
  runAuditStageForSession,
} from './api-audit.js';
import { FixSessionRegistry, handleCreateFixSession, handleReleaseFixSession } from './api-fix-session.js';
import {
  handleAudits,
  handleCandidate,
  handleDiff,
  handleFindings,
  handleFixPrompt,
  handleGetSettings,
  handleHealth,
  handlePatch,
  handleQueue,
  handleReviewers,
  ReadModelCaches,
} from './api-readmodels.js';
import {
  handleAiFix,
  handleApprove,
  handleCandidateFinalize,
  handleComment,
  handleCommentsBatch,
  handleCommentStatus,
  handleFindingDecision,
  handlePutSettings,
  handleRebase,
  handleResume,
  handleReviewersInit,
  handleSync,
  handleTakeover,
  runModeBJob,
} from './api-writers.js';
import { runAuditSelfTest, type AuditSelfTestOutcome } from './audit-self-test.js';
import { AuditLifecycle, type AuditLeaseRecord, type LeaseStore } from './audit-lifecycle.js';
import type { AuditStage } from './audit-prompts.js';
import type { AuditExecutor } from './audit-stage-runner.js';
import { JobManager } from './jobs.js';
import { matchRoute } from './routes.js';
import { detectVcsType, dshHome, validateSettings } from './settings.js';
import { ReviewStore } from './store.js';
import { ApiError, type AppSettings, type ConcurrencyGuard, type IssueSelection, type JobRecord, type VcsType } from './types.js';
import { createVcs } from './vcs.js';

export { API_PREFIX, APP_VERSION, currentTrustedActor, withSharedView, withTrustedActor } from './api-context.js';
export type { ApiDeps, ApiInvocation, ApiInvocationResult, ApiRequest, ApiResponse, SharedView, TrustedActor } from './api-context.js';

class FileLeaseStore implements LeaseStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AuditLeaseRecord[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
    const raw = JSON.parse(text) as unknown;
    if (Array.isArray(raw)) return raw as AuditLeaseRecord[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { leases?: unknown }).leases)) {
      return (raw as { leases: AuditLeaseRecord[] }).leases;
    }
    throw new Error(`持久化审查租约状态格式无效：${this.filePath}`);
  }

  async save(leases: AuditLeaseRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(temp, `${JSON.stringify({ leases }, null, 2)}\n`, 'utf8');
    await rename(temp, this.filePath);
  }
}

export class ReviewApi implements ApiHost {
  readonly jobManager = new JobManager();
  readonly auditLifecycle: AuditLifecycle;
  readonly auditJobFinishes = new Map<string, (result?: unknown) => void>();
  readonly auditJobLeases = new Map<string, string>();
  readonly fixSessionRegistry: FixSessionRegistry;
  private readonly repoLock = new RepoLock();
  private readonly caches = new ReadModelCaches();
  private readonly runtimeCache = new Map<string, Runtime>();
  private settings: AppSettings;
  private _lastConfigErrors: string[] = [];
  private _detectedVcsType: VcsType | null = null;
  private closed = false;
  private initPromise: Promise<void>;

  constructor(readonly deps: ApiDeps) {
    this.settings = { ...deps.settings };
    const stateFile = deps.statePath ?? path.join(dshHome(), 'dsh-code-review', 'runtime-state.json');
    this.auditLifecycle = new AuditLifecycle(new FileLeaseStore(stateFile));
    this.fixSessionRegistry = new FixSessionRegistry(stateFile);
    this.initPromise = Promise.all([
      this.auditLifecycle.load(),
      this.fixSessionRegistry.load(),
    ]).then(() => undefined);
  }

  get lastConfigErrors(): readonly string[] {
    return this._lastConfigErrors;
  }

  get detectedVcsType(): VcsType | null {
    return this._detectedVcsType;
  }

  currentSettings(): AppSettings {
    return this.settings;
  }

  updateSettings(next: AppSettings): void {
    this.settings = { ...next };
    this.runtimeCache.clear();
  }

  readonly fixSessionGuard = {
    activeFor: (root: string) => this.fixSessionRegistry.activeFor(root),
    releaseVerified: (root: string, runtime: Runtime) =>
      this.fixSessionRegistry.releaseVerified(root, runtime, this.deps.stopAuditSession),
  };

  async ready(): Promise<void> {
    await this.initPromise;
  }

  async init(): Promise<void> {
    await this.ready();
  }

  hasAuditStageSession(sessionId: string): boolean {
    return this.auditLifecycle.all().some((lease) => lease.state !== 'released' && lease.sessionId === sessionId);
  }

  isAuditStopping(_auditId: string): boolean {
    return false;
  }

  hasActiveAuditWork(auditId: string): boolean {
    const lease = this.auditLifecycle.find(auditId);
    return Boolean(lease?.stageProcessActive);
  }

  async closeAudit(): Promise<void> {
    this.closed = true;
    closeManualAuditChannels(this.auditLifecycle.all().map((l) => l.auditId));
    for (const job of this.jobManager.list()) {
      if (job.status === 'running') this.jobManager.abort(job.id);
    }
  }

  async runAuditSelfTest(
    signal: AbortSignal,
    onProgress?: (step: string, message: string) => void,
  ): Promise<AuditSelfTestOutcome> {
    const settings = this.currentSettings();
    return runAuditSelfTest({
      stageExecutors: settings.stageExecutors,
      ...(settings.dshCommand ? { dshCommand: settings.dshCommand } : {}),
      ...(this.deps.auditStageExecutor ? { executor: this.deps.auditStageExecutor } : {}),
      signal,
      log: (line) => onProgress?.('self-test', line),
    });
  }

  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return this.repoLock.withWriteLock(repoRoot, fn);
  }

  ensureNoAuditRunning(root?: string): void {
    const lease = root ? this.auditLifecycle.blockingLeaseFor(root) : this.auditLifecycle.anyBlocking();
    if (lease) {
      throw new ApiError(
        409,
        'conflict',
        `仓库存在未释放的审查租约（${lease.auditId}，状态 ${lease.state}），请先完成收尾或确认停止后释放`,
        { auditId: lease.auditId, leaseState: lease.state },
      );
    }
    if (root) {
      const fix = this.fixSessionRegistry.activeFor(root);
      if (fix) {
        throw new ApiError(
          409,
          'conflict',
          `工作副本正被交互式提案会话占用（${fix.candidateId} / session ${fix.sessionId || '启动中'}），请先收尾或停止会话`,
          { fixSession: fix },
        );
      }
    }
  }

  leaseLookup(auditId: string): AuditLeaseRecord | undefined {
    return this.auditLifecycle.find(auditId);
  }

  async leaseTransition(auditId: string, state: 'released' | 'releasable'): Promise<void> {
    if (this.closed) throw new Error('Host 已停止，禁止继续修改审查租约');
    await this.auditLifecycle.transition(auditId, state);
  }

  async ownerFor(_root: string): Promise<string> {
    const trusted = currentTrustedActor();
    if (trusted?.reviewIdentity) return trusted.reviewIdentity;
    return this.settings.owner.trim() || '';
  }

  async runtimeFor(url: URL): Promise<Runtime> {
    const sessionId = url.searchParams.get('sessionId')?.trim() || '';
    const sessionCwd = sessionId ? this.deps.resolveSessionCwd?.(sessionId) : undefined;
    const targetRoot = sessionCwd ? path.resolve(sessionCwd) : this.settings.repoRoot ? path.resolve(this.settings.repoRoot) : '';
    if (!targetRoot) {
      this._lastConfigErrors = ['未配置目标仓库路径（repoRoot）'];
      this._detectedVcsType = null;
      throw new ApiError(412, 'not_configured', '尚未配置目标仓库路径（repoRoot）');
    }

    const expectedRoot = url.searchParams.get('expectedRepoRoot')?.trim();
    if (expectedRoot && path.resolve(expectedRoot).toLowerCase() !== targetRoot.toLowerCase()) {
      throw new ApiError(409, 'conflict', `仓库上下文已切换（期望 ${expectedRoot}，当前 ${targetRoot}），请刷新页面`);
    }

    const detected = detectVcsType(targetRoot);
    this._detectedVcsType = detected;
    if (!detected) {
      this._lastConfigErrors = [`目录不在 Git 或 SVN 仓库内：${targetRoot}`];
      throw new ApiError(412, 'not_configured', `目录不受 Git 或 SVN 版本控制：${targetRoot}`);
    }
    if (this.settings.vcsType !== 'auto' && this.settings.vcsType !== detected) {
      this._lastConfigErrors = [`配置的 VCS 类型（${this.settings.vcsType}）与实际仓库（${detected}）不一致`];
      throw new ApiError(412, 'not_configured', this._lastConfigErrors[0]!);
    }

    const validation = await validateSettings({ ...this.settings, repoRoot: targetRoot });
    this._lastConfigErrors = validation.errors;

    const existing = this.runtimeCache.get(targetRoot);
    if (existing && existing.vcsType === detected) return existing;

    const rawVcs = createVcs(detected, targetRoot, this.settings.baseBranch);
    const vcs = this.deps.decorateVcs ? this.deps.decorateVcs(rawVcs) : rawVcs;
    const runtime: Runtime = {
      root: targetRoot,
      store: new ReviewStore(targetRoot),
      vcs,
      vcsType: detected,
    };
    if (this.runtimeCache.size >= 8) {
      const oldest = this.runtimeCache.keys().next().value;
      if (oldest) this.runtimeCache.delete(oldest);
    }
    this.runtimeCache.set(targetRoot, runtime);
    return runtime;
  }

  async startAiFixJob(
    runtime: Runtime,
    id: string,
    guard: ConcurrencyGuard,
    selection: IssueSelection,
    intent: 'revise' | 'rebase' = 'revise',
  ): Promise<JobRecord> {
    const actor = await this.ownerFor(runtime.root);
    return runModeBJob({ host: this, runtime, id, guard, selection, intent, actor });
  }

  async runAuditStage(sessionId: string, stage: AuditStage, runner: AuditExecutor, task: unknown, signal: AbortSignal): Promise<unknown> {
    await this.ready();
    return runAuditStageForSession(this, sessionId, stage, runner, task, signal);
  }

  async publishAuditStages(sessionId: string, publication: unknown, signal: AbortSignal): Promise<unknown> {
    await this.ready();
    return publishAuditStagesForSession(this, sessionId, publication, signal);
  }

  async queryAuditHistory(sessionId: string, disposition?: string): Promise<unknown> {
    await this.ready();
    return queryAuditHistoryForSession(this, sessionId, disposition);
  }

  /** 供中央托管节点与测试直接调用，不经 HTTP 传输层。 */
  async invoke(input: ApiInvocation): Promise<ApiInvocationResult> {
    await this.ready();
    const query = input.query
      ? `?${new URLSearchParams(Object.entries(input.query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
      : '';
    const urlPath = `${API_PREFIX}${input.path}${query}`;
    const req = internalRequest(input.method, urlPath, input.body ?? {});
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let responseBody = '';
    const res: ApiResponse = {
      get statusCode() { return statusCode; },
      set statusCode(code: number) { statusCode = code; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
      end(value?: string | Uint8Array) {
        if (value !== undefined) responseBody = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
      },
    };
    const execute = () => this.handle(req, res);
    if (input.actor) await withTrustedActor(input.actor, execute);
    else await execute();
    let parsed: unknown = null;
    try { parsed = responseBody ? JSON.parse(responseBody) : null; } catch { parsed = responseBody; }
    return { status: statusCode, body: parsed, headers };
  }

  async handle(req: ApiRequest, res: ApiResponse): Promise<boolean> {
    await this.ready();
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, 'http://localhost');
      const pathname = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length) || '/'
        : url.pathname;

      const matched = matchRoute(method, pathname);
      if (!matched) {
        throw new ApiError(404, 'not_found', `未找到接口：${method} ${pathname}`);
      }
      const { route, params } = matched;

      const dispatch = async (): Promise<void> => {
        if (route.blockedByActiveAudit) {
          const runtime = await this.runtimeFor(url);
          this.ensureNoAuditRunning(runtime.root);
        }

        switch (`${route.method} ${route.path}`) {
          case 'GET /health': return handleHealth(this, req, res, url);
          case 'GET /settings': return handleGetSettings(this, req, res, url);
          case 'PUT /settings': return handlePutSettings(this, req, res);
          case 'GET /queue': return handleQueue(this, req, res, url, this.caches);
          case 'GET /candidate': return handleCandidate(this, req, res, url, this.caches);
          case 'GET /patch': return handlePatch(this, req, res, url);
          case 'GET /diff': return handleDiff(this, req, res, url);
          case 'GET /fix-prompt': return handleFixPrompt(this, req, res, url);
          case 'GET /audit/prompt': return handleAuditPrompt(this, req, res, url);
          case 'GET /jobs': return sendJson(res, 200, { jobs: this.jobManager.list() });
          case 'GET /jobs/:id': {
            const jobId = decodeURIComponent(params[0] ?? '');
            const sinceRaw = url.searchParams.get('since');
            const since = sinceRaw !== null ? Number(sinceRaw) : undefined;
            const payload = this.jobManager.getIncremental(jobId, Number.isFinite(since) ? since : undefined);
            if (!payload) throw new ApiError(404, 'not_found', `Job 不存在：${jobId}`);
            return sendJson(res, 200, {
              ...payload.job,
              log: payload.log,
              logOffset: payload.logOffset,
              totalLogLines: payload.totalLogLines,
              earliestLogOffset: payload.earliestLogOffset,
              logResetRequired: payload.logResetRequired,
            });
          }
          case 'GET /reviewers': return handleReviewers(this, req, res, url);
          case 'GET /audits': return handleAudits(this, req, res, url);
          case 'GET /findings': return handleFindings(this, req, res, url);
          case 'GET /client-entry': return sendJson(res, 200, { entry: this.deps.clientEntry?.() ?? null });

          case 'POST /reviewers/init': return handleReviewersInit(this, req, res, url);
          case 'POST /comments': return handleComment(this, req, res, url);
          case 'POST /comments/batch': return handleCommentsBatch(this, req, res, url);
          case 'POST /comment-status': return handleCommentStatus(this, req, res, url);
          case 'POST /takeover': return handleTakeover(this, req, res, url);
          case 'POST /resume': return handleResume(this, req, res, url);
          case 'POST /finding/decision': return handleFindingDecision(this, req, res, url);
          case 'POST /approve': return handleApprove(this, req, res, url);
          case 'POST /ai-fix': return handleAiFix(this, req, res, url);
          case 'POST /rebase': return handleRebase(this, req, res, url);
          case 'POST /fix-session': return handleCreateFixSession(this, req, res, url, this.fixSessionRegistry);
          case 'POST /fix-session/release': return handleReleaseFixSession(this, req, res, url, this.fixSessionRegistry);
          case 'POST /candidate/finalize': return handleCandidateFinalize(this, req, res, url);
          case 'POST /sync': return handleSync(this, req, res, url);

          case 'POST /audit/session': return handleAuditSession(this, req, res, url);
          case 'POST /audit': return handleAuditStart(this, req, res, url);
          case 'POST /audit/manual': return handleAuditManual(this, req, res, url);
          case 'POST /audit/finalize': return handleAuditFinalize(this, req, res, url);
          case 'POST /audit/release': return handleAuditRelease(this, req, res, url);
          case 'POST /jobs/:id/cancel': return handleJobCancel(this, req, res, decodeURIComponent(params[0] ?? ''));
          default:
            throw new ApiError(404, 'not_found', `未实现的路由：${route.method} ${route.path}`);
        }
      };

      if (route.requiresRepoLock) {
        await this.repoLock.withRepoLock(url, (u) => this.runtimeFor(u), dispatch);
      } else {
        await dispatch();
      }
      return true;
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }
}
