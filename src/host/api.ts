import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { ApprovalOrchestrator } from './approval.js';
import {
  Auditor,
  buildAuditPrompt,
  loadAuditSystemPrompt,
  resolveAuditTarget,
} from './auditor.js';
import { JobManager } from './jobs.js';
import { parsePatch, isAiReviewPath } from './patch.js';
import { Runner, wrapAgentPrompt } from './runner.js';
import { loadReviewers, resolveOwner } from './reviewers.js';
import { AuditArchive, projectFindings } from './audit-archive.js';
import { runGateChecks } from './validator.js';
import { matchesReviewFilter, ReviewStore, type CandidateSource } from './store.js';
import { GitHeadCandidateSource, SvnBaseCandidateSource } from './shared-facts.js';
import { dshHome } from './settings.js';
import { detectVcs, suggestOwner, validateSettings } from './settings.js';
import type {
  AppSettings,
  ConcurrencyGuard,
  HealthInfo,
  JobRecord,
  ReviewCandidate,
  ReviewFilter,
  ReviewStatus,
  VcsType,
} from './types.js';
import { ApiError } from './types.js';
import { createVcs, patchTouchesReviewData, gitBlobHash, type VcsAdapter } from './vcs.js';

export const API_PREFIX = '/dsh-code-review/api';
const APP_VERSION = '0.3.0';
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
  /** Diagnostic: the live client-module graph entry for this package, if any. */
  clientEntry?: () => unknown;
  /** §7.6 审查租约持久化文件；缺省为 DSH_HOME/dsh-code-review/runtime-state.json（测试可注入临时路径）。 */
  statePath?: string;
}

interface Runtime {
  root: string;
  store: ReviewStore;
  vcs: VcsAdapter;
  vcsType: VcsType;
}

/** §7.6 手动/会话审查执行租约：参与全部互斥；持久化在 DSH_HOME 运行时状态中。 */
interface AuditLease {
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
}

/** §7.1：为一次共享读取创建绑定共享快照的数据源；每次请求重建，不跨快照复用（Git=HEAD、SVN=BASE）。 */
interface SharedView {
  source: import('./shared-facts.js').SharedCandidateSource;
  /** 该源实际绑定的快照标识（SVN 根 revision 不可证明快照，返回 null → 不缓存）。 */
  snapshot: string | null;
}

async function sharedViewFor(runtime: Runtime): Promise<SharedView | undefined> {
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

async function sharedSourceFor(runtime: Runtime): Promise<CandidateSource | undefined> {
  return (await sharedViewFor(runtime))?.source;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? {} } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: { code: 'internal', message, details: {} } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function guardFrom(body: Record<string, unknown>): ConcurrencyGuard {
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

function isAnchor(value: unknown): value is { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['snippet'] === 'string' && record['snippet'].trim().length > 0
    && (record['before'] === undefined || typeof record['before'] === 'string')
    && (record['after'] === undefined || typeof record['after'] === 'string');
}

function splitId(id: string): [string, string] {
  const parts = id.replaceAll('\\', '/').split('/');
  if (parts.length !== 2) throw new ApiError(400, 'bad_request', '候选 id 必须是 YYYY-MM/slug');
  return [parts[0] ?? '', parts[1] ?? ''];
}

function idFrom(url: URL): string {
  const id = url.searchParams.get('id') ?? '';
  if (!id) throw new ApiError(400, 'bad_request', '缺少候选 id');
  return id;
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

function composeSessionPrompt(systemPrompt: string, userPrompt: string): string {
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

function filterFrom(url: URL, owner: string): ReviewFilter {
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

export class ReviewApi {
  private settings: AppSettings;
  private store: ReviewStore | null = null;
  private vcs: VcsAdapter | null = null;
  private vcsType: VcsType | null = null;
  private configErrors: string[] = [];
  private readonly runtimeCache = new Map<string, Runtime>();
  private readonly jobs = new JobManager();

  constructor(private readonly deps: ApiDeps) {
    this.settings = deps.settings;
  }

  async init(): Promise<void> {
    await this.reconfigure(this.deps.settings);
    // §7.6：加载持久化审查租约——Host 重启后 active/releasable 租约继续阻塞自动写操作。
    await this.loadAuditLeases();
    this.startScheduler();
  }

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
    const running = this.jobs.list().find((job) => job.status === 'running');
    if (running) return;
    // §7.6/§7.7：执行租约参与全部互斥——有未释放租约时跳过本次定时审查。
    if (this.auditLeases.some((lease) => lease.state !== 'released' && lease.root === runtime.root)) return;
    const baseRevision = await runtime.vcs.getCurrentBase().catch(() => null);
    if (!baseRevision) return;
    const clean = await runtime.vcs.ensureCleanWorkspace().catch(() => ({ clean: false, message: 'unknown' }));
    if (!clean.clean) return;
    const owner = await this.ownerFor(runtime.root);
    const now = new Date();
    // §4.7：定時审查同样由 Host 生成 audit_id 与报告路径，并创建可追踪 Job + 执行租约。
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId('', now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
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
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    const candidateIdsBefore = await runtime.store.listCandidateIds();
    const created = await this.deps.createAuditSession({ cwd: runtime.root, title: '定时仓库审查', prompt, ownerSessionId: '' });
    await this.upsertLease({
      auditId,
      root: runtime.root,
      targetPath: '',
      trigger: 'scheduled',
      baseRevision,
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
    });
    // 跟踪 Job 保持 running，直到 /audit/finalize（或 release / 取消）完成它。
    this.startAuditTrackingJob(auditId);
    this.armAuditLeaseTimeout(auditId);
    void created;
  }

  /** §7.6：审查执行超时上限 1 小时；超时只把租约置 releasable，不自动解除互斥。 */
  private armAuditLeaseTimeout(auditId: string): void {
    const timer = setTimeout(() => {
      const lease = this.auditLeases.find((entry) => entry.auditId === auditId);
      if (!lease || lease.state !== 'active') return;
      lease.state = 'releasable';
      void this.saveAuditLeases().catch(() => undefined);
      this.auditJobFinishes.get(auditId)?.({
        status: 'RECOVERY_REQUIRED',
        reason: 'SYNC_STATE_UNKNOWN',
        detail: '审查执行超过 1 小时上限，租约已置为 releasable，请人工确认后 /audit/release',
      });
      this.auditJobFinishes.delete(auditId);
    }, 60 * 60 * 1000);
    timer.unref?.();
  }

  /** §7.7：创建 audit 跟踪 Job；取消/超时只把租约置 releasable，不自动释放。 */
  private startAuditTrackingJob(auditId: string): JobRecord {
    const job = this.jobs.start('audit', () => new Promise<unknown>((resolve) => {
      this.auditJobFinishes.set(auditId, (result) => { resolve(result); });
    }));
    this.auditJobLeases.set(job.id, auditId);
    return job;
  }

  /** §18.2：把 reviewers.yml 解析结果作为提示词参数传入审查会话。 */
  private async ownerRoutingBlock(repoRoot: string): Promise<string> {
    const config = await loadReviewers(repoRoot);
    const lines = [
      '## Owner 路由（reviewers.yml 解析结果，创建候选时按此写 owner）',
      `- default_owner: ${config.defaultOwner || '(未配置，由当前操作者兜底)'}`,
    ];
    for (const rule of config.rules) {
      lines.push(`- owner ${rule.owner}：paths ${JSON.stringify(rule.paths)} tags ${JSON.stringify(rule.tags)}`);
    }
    lines.push('- 匹配顺序：路径命中数 > tag 命中数 > 配置顺序；无命中用 default_owner。');
    return lines.join('\n');
  }

  // ---------- §8/§18.8 检出级写互斥（进程内串行化共享写操作） ----------

  private writeLocks = new Map<string, Promise<unknown>>();

  /** §5.5：派生定位内存缓存（repoRoot|candidateId|VCS 快照 → 结果）；不持久化。 */
  private approvalLookupCache = new Map<string, import('./types.js').ApprovalCommitLookup>();

  // ---------- §7.6 手动审查执行租约（Host 重启后仍阻塞自动写操作） ----------

  private auditLeases: AuditLease[] = [];
  /** 会话/手动/定时审查跟踪 Job 的完成回调（仅内存；重启后由 finalize 直接新建 Job）。 */
  private auditJobFinishes = new Map<string, (result?: unknown) => void>();
  /** 跟踪 Job id → auditId，供 /jobs/:id/cancel 把租约转为 releasable。 */
  private auditJobLeases = new Map<string, string>();

  private get leaseStatePath(): string {
    return this.deps.statePath ?? path.join(dshHome(), 'dsh-code-review', 'runtime-state.json');
  }

  /** Host 启动时加载持久化租约：active/releasable 租约继续参与互斥，直到 finalize 或 release。 */
  private async loadAuditLeases(): Promise<void> {
    try {
      const text = await readFile(this.leaseStatePath, 'utf8');
      const parsed = JSON.parse(text) as { leases?: AuditLease[] };
      this.auditLeases = Array.isArray(parsed.leases) ? parsed.leases : [];
    } catch {
      this.auditLeases = [];
    }
  }

  private async saveAuditLeases(): Promise<void> {
    const file = this.leaseStatePath;
    await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
    const temp = `${file}.tmp-${String(process.pid)}`;
    const { writeFile: writeState, rename: renameState } = await import('node:fs/promises');
    await writeState(temp, JSON.stringify({ leases: this.auditLeases }, null, 2), 'utf8');
    await renameState(temp, file).catch(() => undefined);
  }

  private activeLeaseFor(root: string): AuditLease | undefined {
    return this.auditLeases.find((lease) => lease.root === root && lease.state !== 'released');
  }

  private async upsertLease(lease: AuditLease): Promise<void> {
    const index = this.auditLeases.findIndex((entry) => entry.auditId === lease.auditId);
    if (index >= 0) this.auditLeases[index] = lease;
    else this.auditLeases.push(lease);
    await this.saveAuditLeases();
  }

  private withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(repoRoot) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.writeLocks.set(repoRoot, next.catch(() => undefined));
    return next;
  }

  /** 共享写路由统一加锁（§8/§18.8：同一检出的写操作串行化）。 */
  private withRepoLock<T>(url: URL, fn: () => Promise<T>): Promise<T> {
    return this.runtimeFor(url).then(
      (runtime) => this.withWriteLock(runtime.root, fn),
      () => fn(),
    );
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

  private async runtimeFor(url: URL): Promise<Runtime> {
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

  private async ownerFor(root: string): Promise<string> {
    if (this.settings.owner.trim()) return this.settings.owner;
    return suggestOwner(root).catch(() => '');
  }

  /**
   * §12.2 操作隔离：Owner 是本地协作约定（非安全身份）。非 Owner 的候选共享写
   * 返回 403 forbidden；唯一例外是 /takeover。不得用 expectedOwner 冒充身份校验。
   */
  /**
   * §7.1：候选共享写只能作用于共享事实。
   * 本地草稿（HEAD 中不存在）与存在本地改动的候选必须拒绝，避免把本地视图提交为共享事实。
   */
  private async requireSharedCandidate(runtime: Runtime, id: string): Promise<void> {
    const view = await sharedViewFor(runtime);
    if (!view?.source) return; // 空仓库/无 HEAD：沿用既有错误路径
    const { month, slug } = runtime.store.resolveCandidateDir(id);
    const text = await view.source.readReviewText(month, slug).catch(() => null);
    if (text === null) {
      throw new ApiError(409, 'conflict', `候选 ${id} 不是共享事实（当前 VCS 快照中不存在），不能执行共享写；请先完成 /candidate/finalize 或审查收尾`);
    }
    if (await view.source.hasLocalChanges(month, slug).catch(() => false)) {
      throw new ApiError(409, 'conflict', `候选 ${id} 存在本地未提交改动，不能执行共享写；请先还原工作区后重试`);
    }
  }

  /** §7.1：审查档案写入（convert/dismiss）只能修改共享快照中的档案。 */
  private async requireSharedAudit(runtime: Runtime, auditId: string, localPath: string): Promise<void> {
    const view = await sharedViewFor(runtime);
    if (!view?.source) return;
    const sharedText = await view.source.readAuditText(auditId).catch(() => null);
    if (sharedText === null) {
      throw new ApiError(409, 'conflict', `审查档案 ${auditId} 不是共享事实，不能修改`);
    }
    const localText = await readFile(localPath, 'utf8').catch(() => null);
    if (localText !== null && localText !== sharedText) {
      throw new ApiError(409, 'conflict', `审查档案 ${auditId} 存在本地未提交改动，不能执行共享写`);
    }
  }

  private async requireOwnerOf(store: ReviewStore, id: string): Promise<void> {
    const me = await this.ownerFor(store.repoRoot);
    const detail = await store.get(id, null);
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', detail.candidate.parseError);
    if (detail.candidate.meta.owner !== me) {
      throw new ApiError(403, 'forbidden', `当前操作者 ${me} 不是该候选 Owner（${detail.candidate.meta.owner}）；如需接手请先接管（POST /takeover）`);
    }
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

  private async dispatch(req: IncomingMessage, res: ServerResponse, route: string, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'GET' && (route === '/health' || route === '/')) return this.health(res, url);
    if (method === 'GET' && route === '/settings') return this.getSettingsResponse(res, url);
    if (method === 'PUT' && route === '/settings') return this.putSettings(req, res);
    if (method === 'GET' && route === '/queue') return this.queue(res, url);
    if (method === 'GET' && route === '/candidate') return this.candidate(res, url);
    if (method === 'GET' && route === '/patch') return this.patch(res, url);
    if (method === 'GET' && route === '/diff') return this.diff(res, url);
    if (method === 'GET' && route === '/fix-prompt') return this.fixPrompt(res, url);
    if (method === 'GET' && route === '/audit/prompt') return this.auditPrompt(res, url);
    if (method === 'POST' && route === '/audit/session') return this.auditSession(req, res, url);
    if (method === 'POST' && route === '/audit') return this.audit(req, res, url);
    if (method === 'POST' && route === '/audit/manual') return this.auditManual(req, res, url);
    if (method === 'POST' && route === '/audit/finalize') return this.auditFinalize(req, res, url);
    if (method === 'POST' && route === '/audit/release') return this.auditRelease(req, res, url);
    if (method === 'POST' && route === '/comments') return this.withRepoLock(url, () => this.addComment(req, res, url));
    if (method === 'POST' && route === '/comments/batch') return this.withRepoLock(url, () => this.addCommentsBatch(req, res, url));
    if (method === 'POST' && route === '/resume') return this.withRepoLock(url, () => this.resume(req, res, url));
    if (method === 'POST' && route === '/comment-status') return this.withRepoLock(url, () => this.commentStatus(req, res, url));
    if (method === 'POST' && route === '/takeover') return this.withRepoLock(url, () => this.takeover(req, res, url));
    if (method === 'POST' && route === '/reject') return this.withRepoLock(url, () => this.reject(req, res, url));
    if (method === 'POST' && route === '/archive-stale') return this.withRepoLock(url, () => this.reject(req, res, url, 'stale'));
    if (method === 'POST' && route === '/reopen') return this.withRepoLock(url, () => this.reopen(req, res, url));
    if (method === 'POST' && route === '/convert') return this.withRepoLock(url, () => this.convert(req, res, url));
    if (method === 'POST' && route === '/dismiss-finding') return this.withRepoLock(url, () => this.dismissFinding(req, res, url));
    if (method === 'POST' && route === '/rebase') return this.withRepoLock(url, () => this.rebase(req, res, url));
    if (method === 'POST' && route === '/manual-revision') return this.withRepoLock(url, () => this.manualRevision(req, res, url));
    if (method === 'POST' && route === '/approve') return this.approve(req, res, url);
    if (method === 'POST' && route === '/ai-fix') return this.aiFix(req, res, url);
    if (method === 'POST' && route === '/candidate/finalize') return this.withRepoLock(url, () => this.candidateFinalize(req, res, url));
    if (method === 'POST' && route.startsWith('/jobs/') && route.endsWith('/cancel')) return this.jobCancel(req, res, route.slice('/jobs/'.length, -'/cancel'.length));
    if (method === 'POST' && route === '/sync') return this.sync(res, url);
    if (method === 'GET' && route === '/jobs') return this.jobsList(res);
    if (method === 'GET' && route.startsWith('/jobs/')) return this.jobGet(res, route.slice('/jobs/'.length), url);
    if (method === 'GET' && route === '/reviewers') return this.reviewers(res, url);
    if (method === 'GET' && route === '/audits') return this.auditsList(res, url);
    if (method === 'GET' && route === '/findings') return this.findings(res, url);
    if (method === 'GET' && route === '/client-entry') {
      let entry: unknown = null;
      try {
        entry = this.deps.clientEntry?.() ?? null;
      } catch (error) {
        entry = { error: error instanceof Error ? error.message : String(error) };
      }
      sendJson(res, 200, { entry });
      return;
    }
    throw new ApiError(404, 'not_found', `未知接口：${method} ${route}`);
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
        counts = await runtime.store.listStatusCounts(owner);
      } catch (error) {
        diagnostics.push(`无法统计队列：${error instanceof Error ? error.message : String(error)}`);
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

  private async queue(res: ServerResponse, url: URL): Promise<void> {
    let runtime: Runtime;
    try {
      runtime = await this.runtimeFor(url);
    } catch (error) {
      sendJson(res, 200, {
        configured: false,
        items: [],
        errors: [error instanceof Error ? error.message : String(error)],
        currentBase: null,
        counts: { pending: 0, changes_requested: 0, approved: 0, rejected: 0 },
        owner: this.settings.owner,
        me: this.settings.owner,
        repoRoot: this.settings.repoRoot,
      });
      return;
    }
    const ownerParam = url.searchParams.get('owner');
    const owner = ownerParam !== null ? ownerParam.trim() : await this.ownerFor(runtime.root);
    const filter = filterFrom(url, owner);
    // §7.1：一次队列计算的 base 与候选事实必须来自同一共享快照（Git=HEAD）。
    const view = await sharedViewFor(runtime);
    const base = view?.snapshot ?? await runtime.vcs.getCurrentBase().catch(() => null);
    // §18.1：stale_days 决定队列的过期提示（只读，不产生共享写入）。
    const reviewers = await loadReviewers(runtime.root);
    // One scan for both the filtered page and the owner-wide status counts: the
    // filtered items are always a subset of the owner's candidates.
    // §7.1：共享读取绑定同一 HEAD 快照（Git），本地视图只作 local 诊断。
    const all = await runtime.store.list({ owner }, base, reviewers.staleDays, reviewers.rejectionMemoryDays, view?.source);
    const items = all.items.filter((item) => matchesReviewFilter(item, filter));
    const counts: Record<ReviewStatus, number> = { pending: 0, changes_requested: 0, approved: 0, rejected: 0 };
    // §10.1：local 候选不计入共享 KPI。
    for (const item of all.items) {
      if (!item.local) counts[item.status] += 1;
    }
    // §5.5：approved 项附带派生业务提交版本与三态诊断（仅诊断，不阻塞队列）。
    for (const item of items) {
      if (item.status === 'approved' && !item.parseError) {
        const derived = await this.deriveApprovalInfo(runtime, item.id).catch(() => undefined);
        if (derived) Object.assign(item, derived);
      }
    }
    sendJson(res, 200, {
      configured: true,
      items,
      errors: all.errors,
      currentBase: base,
      counts,
      owner,
      me: owner,
      repoRoot: runtime.root,
    });
  }

  private async candidate(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    const me = await this.ownerFor(store.repoRoot);
    const id = idFrom(url);
    // §7.1：详情读取绑定同一共享快照（Git=HEAD）；本地视图只作 local 诊断。
    const view = await sharedViewFor(runtime);
    const currentBase = view?.snapshot ?? await vcs.getCurrentBase().catch(() => null);
    const detail = await store.get(id, currentBase, view?.source);
    const validation = await store.validateFullCandidate(detail.candidate);
    const revisionStats: Record<number, unknown> = {};
    for (const revision of detail.candidate.meta.revisions) {
      try {
        const text = await store.readPatch(id, revision.patch, view?.source);
        revisionStats[revision.id] = { patch: revision.patch, baseRevision: revision.baseRevision, stats: parsePatch(text).stats };
      } catch {
        revisionStats[revision.id] = { patch: revision.patch, baseRevision: revision.baseRevision, stats: null };
      }
    }
    const patchText = detail.patchText;
    const patchPaths = parsePatch(patchText).paths.filter((file) => !isAiReviewPath(file));
    // §8.2/G40：patchCheck 派生预检——clean/conflicted 只表示补丁能否应用到 checkedBase，
    // 不构成批准证据；批准 Job 仍会重新严格应用。
    let patchCheck: { state: 'clean' | 'conflicted' | 'unknown'; checkedBase: string; checkedAt: string } | undefined;
    if (!detail.candidate.parseError && detail.candidate.meta.status !== 'approved' && detail.candidate.meta.status !== 'rejected' && currentBase) {
      const currentPatchName = detail.candidate.meta.revisions.find(
        (revision) => revision.id === detail.candidate.meta.currentRevision,
      )?.patch;
      if (currentPatchName) {
        const checked = await vcs.checkPatch(path.join(detail.candidate.dirPath, currentPatchName)).catch(() => null);
        patchCheck = {
          state: checked === null ? 'unknown' : checked.ok ? 'clean' : 'conflicted',
          checkedBase: currentBase,
          checkedAt: new Date().toISOString(),
        };
      }
    }
    const comments = [...detail.candidate.meta.comments].sort((left, right) => {
      const byRevision = left.revision - right.revision;
      return byRevision !== 0 ? byRevision : left.id.localeCompare(right.id);
    });
    // §5.5：approved 候选附带派生业务提交版本与三态诊断。
    let approvalCommitRevision: string | undefined;
    let approvalCommitLookup: 'found' | 'ambiguous' | 'unknown' | undefined;
    if (detail.candidate.meta.status === 'approved' && !detail.candidate.parseError) {
      const derived = await this.deriveApprovalInfo(runtime, id).catch(() => undefined);
      if (derived) {
        approvalCommitRevision = derived.approvalCommitRevision;
        approvalCommitLookup = derived.approvalCommitLookup;
      }
    }
    sendJson(res, 200, {
      candidate: detail.candidate,
      currentBase: detail.currentBase,
      isBaseBehind: detail.isBaseBehind,
      patchText,
      patchStats: detail.patchStats,
      patchPaths,
      comments,
      validation,
      revisionStats,
      ...(approvalCommitRevision !== undefined || approvalCommitLookup !== undefined
        ? { approvalCommitRevision, approvalCommitLookup }
        : {}),
      ...(patchCheck ? { patchCheck } : {}),
      canAct: detail.candidate.meta.owner === me,
      me,
      jobs: this.jobs.list().slice(0, 5),
    });
  }

  /**
   * §5.5：从 VCS 历史派生批准业务提交版本。结果缓存在内存中，
   * 键为 (repoRoot, candidateId, VCS 快照)，不持久化、不写入 review.md。
   */
  private async deriveApprovalInfo(
    runtime: Runtime,
    id: string,
  ): Promise<{ approvalCommitRevision?: string; approvalCommitLookup: 'found' | 'ambiguous' | 'unknown' }> {
    // §7.1：派生读取与缓存键必须绑定同一共享快照；SVN 无法证明快照时不缓存（避免子路径提交后的陈旧结果）。
    const view = await sharedViewFor(runtime);
    const cacheKey = view?.snapshot ? `${runtime.root}|${id}|${view.snapshot}` : null;
    const cached = cacheKey ? this.approvalLookupCache.get(cacheKey) : undefined;
    if (cached) {
      return cached.lookup === 'found' && cached.revision
        ? { approvalCommitRevision: cached.revision, approvalCommitLookup: 'found' }
        : { approvalCommitLookup: cached.lookup };
    }
    const detail = await runtime.store.get(id, null, view?.source);
    const meta = detail.candidate.meta;
    if (meta.status !== 'approved') return { approvalCommitLookup: 'found' };
    const rel = (absolute: string) => path.relative(runtime.root, absolute).replaceAll('\\', '/');
    const result = await runtime.vcs.deriveApprovalCommit({
      reviewPath: rel(detail.candidate.reviewPath),
      patchPaths: meta.revisions.map((revision) => `${rel(detail.candidate.dirPath)}/${revision.patch}`),
      targetFiles: meta.targetFiles,
    });
    if (cacheKey) {
      this.approvalLookupCache.set(cacheKey, result);
      if (this.approvalLookupCache.size > 256) {
        const first = this.approvalLookupCache.keys().next().value;
        if (first !== undefined) this.approvalLookupCache.delete(first);
      }
    }
    return result.lookup === 'found' && result.revision
      ? { approvalCommitRevision: result.revision, approvalCommitLookup: 'found' }
      : { approvalCommitLookup: result.lookup };
  }

  private async patch(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const id = idFrom(url);
    const name = url.searchParams.get('name') ?? '';
    if (!name) throw new ApiError(400, 'bad_request', '缺少补丁文件名');
    const text = await runtime.store.readPatch(id, name, await sharedSourceFor(runtime));
    sendJson(res, 200, { name, text });
  }

  private async diff(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    const sharedSource = await sharedSourceFor(runtime);
    const id = idFrom(url);
    const detail = await store.get(id, null, sharedSource);
    const current = detail.candidate.meta.currentRevision;
    const to = Number(url.searchParams.get('to') ?? String(current));
    const from = Number(url.searchParams.get('from') ?? '0');
    const toRevision = detail.candidate.meta.revisions.find((revision) => revision.id === to);
    if (!toRevision) throw new ApiError(404, 'not_found', `版本 ${String(to)} 不存在`);
    if (!from || from === to) {
      sendJson(res, 200, {
        mode: 'full',
        fromRevision: null,
        toRevision: to,
        unifiedDiff: await store.readPatch(id, toRevision.patch, sharedSource),
        fromBase: null,
        toBase: toRevision.baseRevision,
        resolutionMode: null,
        notes: ['显示该版本相对基线的全量补丁。'],
      });
      return;
    }
    const fromRevision = detail.candidate.meta.revisions.find((revision) => revision.id === from);
    if (!fromRevision) throw new ApiError(404, 'not_found', `版本 ${String(from)} 不存在`);
    const fromText = await store.readPatch(id, fromRevision.patch, sharedSource);
    const toText = await store.readPatch(id, toRevision.patch, sharedSource);
    const inter = await vcs.computeInterRevisionDiff({
      fromRevision: from,
      toRevision: to,
      fromBase: fromRevision.baseRevision,
      toBase: toRevision.baseRevision,
      fromPatchPath: path.join(detail.candidate.dirPath, fromRevision.patch),
      toPatchPath: path.join(detail.candidate.dirPath, toRevision.patch),
      fromPatchText: fromText,
      toPatchText: toText,
    });
    sendJson(res, 200, { mode: 'incremental', ...inter });
  }

  private async reviewers(res: ServerResponse, url: URL): Promise<void> {
    const { store } = await this.runtimeFor(url);
    const config = await loadReviewers(store.repoRoot);
    sendJson(res, 200, { config });
  }

  /** §3：目录式审查档案列表（旧扁平报告不参与；§7.1 只列共享快照中的档案）。 */
  private async auditsList(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const archive = new AuditArchive(runtime.root);
    const view = await sharedViewFor(runtime);
    const records = await archive.list(view?.source);
    sendJson(res, 200, {
      audits: records
        .filter((record) => !record.parseError)
        .sort((left, right) => new Date(right.meta.createdAt).getTime() - new Date(left.meta.createdAt).getTime())
        .map((record) => ({
          auditId: record.meta.auditId,
          createdAt: record.meta.createdAt,
          scope: record.meta.scope,
          trigger: record.meta.trigger,
          previousAudit: record.meta.previousAudit,
          candidates: record.meta.candidates,
          itemCount: record.meta.items.length,
          path: `.ai-review/audits/${record.dirName}/audit.md`,
        })),
      errors: records.filter((record) => record.parseError).map((record) => `${record.dirName}: ${record.parseError}`),
    });
  }

  /** §4.8/G41：投影内存缓存（键 repoRoot|VCS 快照）；不持久化、不跨快照复用。 */
  private projectionCache = new Map<string, { findings: ReturnType<typeof projectFindings>['findings']; errors: string[]; snapshot: string }>();

  /** §4.8：finding 投影（共享候选事实 + 重开链判定），供 /findings、/convert、/dismiss-finding 复用。 */
  private async findingProjection(runtime: Runtime): Promise<{
    records: Awaited<ReturnType<AuditArchive['list']>>;
    findings: ReturnType<typeof projectFindings>['findings'];
    errors: string[];
  }> {
    // §7.1：一次投影计算内的档案与候选事实必须绑定同一个共享快照；缓存键也取自同一个源对象。
    const view = await sharedViewFor(runtime);
    const snapshot = view?.snapshot ?? null;
    const archive = new AuditArchive(runtime.root);
    if (snapshot) {
      const cacheKey = `${runtime.root}|${snapshot}`;
      const cached = this.projectionCache.get(cacheKey);
      if (cached) {
        return { records: await archive.list(view?.source), findings: cached.findings, errors: cached.errors };
      }
    }
    const records = await archive.list(view?.source);
    const queue = await runtime.store.list({}, null, undefined, undefined, view?.source);
    // §7.1/§4.8：投影只使用共享事实；local/broken 候选不进入重开链。
    const sharedItems = queue.items.filter((item) => !item.local && !item.parseError);
    const infoById = new Map(sharedItems.map((item) => [item.id, {
      status: item.status,
      reopenedFrom: item.reopenedFrom ?? null,
    } as import('./audit-archive.js').CandidateChainInfo]));
    const projected = projectFindings(
      records,
      (candidateId) => infoById.get(candidateId) ?? null,
      sharedItems.map((item) => item.id),
    );
    const errors = [
      ...records.filter((record) => record.parseError).map((record) => `${record.dirName}: ${record.parseError}`),
      ...projected.errors,
    ];
    if (snapshot) {
      const cacheKey = `${runtime.root}|${snapshot}`;
      this.projectionCache.set(cacheKey, { findings: projected.findings, errors, snapshot });
      if (this.projectionCache.size > 32) {
        const first = this.projectionCache.keys().next().value;
        if (first !== undefined) this.projectionCache.delete(first);
      }
    }
    return { records, findings: projected.findings, errors };
  }

  /** §3.4：finding 投影（覆盖判定 → 最新观察 → 当前状态 → 可见性）。 */
  private async findings(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { findings, errors } = await this.findingProjection(runtime);
    sendJson(res, 200, { findings, errors });
  }

  private async fixPrompt(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const id = idFrom(url);
    const detail = await runtime.store.get(id, null, await sharedSourceFor(runtime));
    const comments = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
    const runner = new Runner({
      kind: 'manual',
      settings: this.settings,
      store: runtime.store,
      candidate: detail.candidate,
      mode: 'ADDRESS_FEEDBACK',
      comments,
      log: () => undefined,
    });
    const result = await runner.run();
    sendJson(res, 200, { prompt: result.prompt ?? result.errorMessage ?? '', comments });
  }

  private async auditPrompt(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const owner = await this.ownerFor(runtime.root);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法生成仓库审查提示词。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const target = await resolveAuditTarget(runtime.root, url.searchParams.get('targetPath') ?? '');
    const note = url.searchParams.get('note') ?? '';
    const mode = url.searchParams.get('mode') === 'headless' ? 'headless' : 'session';
    const now = new Date();
    const auditId = await new AuditArchive(runtime.root).nextAuditId(target.targetPath, now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode,
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const systemPrompt = await loadAuditSystemPrompt();
    const promptWithRouting = `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`;
    const prompt = mode === 'session'
      ? composeSessionPrompt(systemPrompt, promptWithRouting)
      : wrapAgentPrompt(systemPrompt, promptWithRouting);
    sendJson(res, 200, {
      prompt,
      auditId,
      mode,
      targetPath: target.targetPath,
      baseRevision,
      owner,
      reportPath,
    });
  }

  private async auditSession(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const ownerSessionId = url.searchParams.get('sessionId') ?? '';
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const running = this.jobs.list().find((job) => job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再开始仓库审查。`);
    }
    // §7.6/§7.7：任何未释放的执行租约（手动/会话/定时）都必须阻止新的工作区事务。
    this.ensureNoAuditRunning(runtime.root);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    if (!this.deps.createAuditSession) {
      throw new ApiError(500, 'internal', '当前 Host 不支持创建 DSH 审查会话（sessionController 未挂载）。');
    }
    const owner = await this.ownerFor(runtime.root);
    const now = new Date();
    // §7.6：会话审查同样持有执行租约 + 跟踪 audit Job；turn 结束后由 /audit/finalize 收尾。
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode: 'session',
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    const title = `仓库审查 · ${target.targetPath || '全仓库'}`.slice(0, 60);
    const created = await this.deps.createAuditSession({ cwd: runtime.root, title, prompt, ownerSessionId });
    const candidateIdsBefore = await runtime.store.listCandidateIds();
    await this.upsertLease({
      auditId,
      root: runtime.root,
      targetPath: target.targetPath,
      trigger: 'manual',
      baseRevision,
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
    });
    // 跟踪 Job 保持 running，直到 /audit/finalize（或 release / 取消）完成它。
    const job = this.startAuditTrackingJob(auditId);
    this.armAuditLeaseTimeout(auditId);
    sendJson(res, 202, {
      sessionId: created.sessionId,
      jobId: job.id,
      job,
      auditId,
      targetPath: target.targetPath,
      reportPath,
      baseRevision,
      owner,
    });
  }

  private async audit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const running = this.jobs.list().find((job) => job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再开始仓库审查。`);
    }
    // §7.6/§7.7：未释放的执行租约同样阻塞新的 headless 审查。
    this.ensureNoAuditRunning(runtime.root);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const owner = await this.ownerFor(runtime.root);
    // §7.7：headless Runner 的工作区事务必须与其他共享写经同一 repo 锁串行。
    const job = this.jobs.start('audit', (log, _jobId, signal) => this.withWriteLock(runtime.root, async () => {
      const sharedSource = await sharedSourceFor(runtime);
      const auditor = new Auditor({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: this.settings,
        owner,
        targetPath: target.targetPath,
        note,
        log,
        ...(sharedSource ? { candidateSource: sharedSource } : {}),
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
        signal,
      });
      const outcome = await auditor.run();
      log(`结果：${outcome.status} — ${outcome.message}`);
      return outcome;
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /**
   * §7.6 手动提示词模式：创建持久化执行租约并返回完整提示词。
   * 外部 Agent 执行期间租约参与全部互斥；只有 /audit/finalize 正常完成才释放，
   * 取消或超时只能由人确认停止后经 /audit/release 释放。
   */
  private async auditManual(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const running = this.jobs.list().find((job) => job.status === 'running');
    if (running) throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再开始仓库审查。`);
    this.ensureNoAuditRunning(runtime.root);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交，无法开始仓库审查。');
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    const owner = await this.ownerFor(runtime.root);
    const now = new Date();
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode: 'headless',
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const prompt = wrapAgentPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    const candidateIdsBefore = await runtime.store.listCandidateIds();
    await this.upsertLease({
      auditId,
      root: runtime.root,
      targetPath: target.targetPath,
      trigger: 'manual',
      baseRevision,
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
    });
    // §7.6/§8.3：手动模式同样创建可追踪的 audit Job，并受 1 小时执行上限约束。
    const job = this.startAuditTrackingJob(auditId);
    this.armAuditLeaseTimeout(auditId);
    sendJson(res, 202, {
      jobId: job.id,
      job,
      auditId,
      prompt,
      targetPath: target.targetPath,
      reportPath,
      baseRevision,
      owner,
    });
  }

  /**
   * §7.6 手动/会话审查收尾：以 lease 中保存的开始快照执行 Host 收尾与共享提交，
   * 正常完成后释放租约。外部写入的候选按全部校验（含 owner 路由复核）验收。
   */
  private async auditFinalize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
    const lease = this.auditLeases.find((entry) => entry.auditId === auditId);
    if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
    if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
    if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放，不能重复收尾`);
    const running = this.jobs.list().find((job) => job.status === 'running' && job.type !== 'audit');
    if (running) throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再收尾。`);
    const job = this.jobs.start('audit', async (log) => this.withWriteLock(runtime.root, async () => {
      // §7.7：收尾提交与全部共享写/工作区事务经同一 repo 锁串行。
      // 锁内重新检查租约状态：并发 finalize 的第二个请求不得重复提交。
      if (lease.state === 'released') {
        log(`租约 ${lease.auditId} 已被另一次收尾释放，跳过重复收尾`);
        return {
          status: 'ABORTED',
          auditId: lease.auditId,
          commitRevision: null,
          created: [],
          reportPath: `.ai-review/audits/${lease.auditId}/audit.md`,
          message: '租约已释放，未重复收尾',
        };
      }
      const auditor = new Auditor({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: this.settings,
        owner: lease.owner,
        targetPath: lease.targetPath,
        note: '',
        log,
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      });
      const result = await auditor.finalize({
        auditId: lease.auditId,
        beforeIds: new Set(lease.candidateIdsBefore),
        baseRevision: lease.baseRevision,
        targetPath: lease.targetPath,
        trigger: lease.trigger,
        runError: null,
        startedAt: new Date(lease.createdAt).getTime(),
        now: new Date(),
      });
      // §7.6：只有收尾正常完成（COMMITTED / VALIDATION_FAILED）才释放租约；
      // ABORTED 或结果不明（RECOVERY_REQUIRED）必须保留租约，让仓库继续处于互斥状态，
      // 等待人工核对后重试 finalize 或显式 release。
      if (result.status === 'COMMITTED' || result.status === 'VALIDATION_FAILED') {
        lease.state = 'released';
        await this.saveAuditLeases();
        this.auditJobFinishes.get(lease.auditId)?.({
          status: result.status,
          auditId: lease.auditId,
          commitRevision: result.commitRevision,
          message: result.message,
        });
        this.auditJobFinishes.delete(lease.auditId);
      } else {
        log(`收尾未完成（${result.status}），租约 ${lease.auditId} 保持占用，请核对后重试 finalize 或 /audit/release`);
      }
      log(`结果：${result.status} — ${result.message}`);
      return {
        status: result.status,
        auditId: lease.auditId,
        commitRevision: result.commitRevision,
        created: result.created,
        reportPath: result.reportPath,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        message: result.message,
      };
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** §7.6 释放租约：仅在租约已取消/超时（releasable）或人工确认外部执行已停止后使用。 */
  private async auditRelease(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const confirmStopped = body['confirmStopped'] === true;
    if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
    if (!confirmStopped) throw new ApiError(409, 'conflict', '必须显式确认外部执行已停止（confirmStopped: true）');
    const lease = this.auditLeases.find((entry) => entry.auditId === auditId);
    if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
    if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
    if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放`);
    // §8.3：仅在租约已取消/超时（releasable）后可用；仍活跃的租约必须 409。
    if (lease.state === 'active') {
      throw new ApiError(409, 'conflict', `租约 ${auditId} 仍处于活跃状态；请先取消审查 Job 或等待超时（releasable）后再释放`);
    }
    // 复核工作区：外部执行可能残留未还原改动。
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `工作区仍有未还原改动，不能释放租约。\n${clean.message}`);
    }
    lease.state = 'released';
    await this.saveAuditLeases();
    this.auditJobFinishes.get(lease.auditId)?.({
      status: 'ABORTED',
      auditId: lease.auditId,
      message: '租约已由人工确认停止后释放',
    });
    this.auditJobFinishes.delete(lease.auditId);
    sendJson(res, 200, { released: true });
  }

  /**
   * §5.6（G17）提交结果三分支：以“路径级提交探针”判定，而不是工作副本根 revision。
   * - 命令成功：直接返回本次提交版本；
   * - 命令失败且探针前进：读取该版本中的预期内容核对——匹配按成功继续，否则保留现场；
   * - 探针不可读：结果不明，保留现场；
   * - 探针未前进：已证明提交不存在，调用方恢复操作前文件并返回失败。
   * Git 探针为 HEAD；SVN 为相关路径的 last-changed-revision（H1：根 revision 不随子路径提交前进）。
   */
  private async commitAndClassify(input: {
    runtime: Runtime;
    message: string;
    paths: string[];
    /** 探针路径（默认同提交路径）。SVN 下目录的 last-changed-revision 不随子文件修改前进，必须探到具体文件。 */
    probePaths?: string[];
    deletePaths?: string[];
    /** 提交成功应能在该版本中读到的仓库相对文件（用于失败后的内容核对）。 */
    expectedFiles?: { relPath: string; text: string }[];
  }): Promise<
    | { landed: true; commitRevision: string | null }
    | { landed: false; outcome: 'ABORTED' | 'RECOVERY_REQUIRED'; detail: string }
  > {
    const { runtime } = input;
    const paths = [...new Set(input.paths.filter((item) => item.trim().length > 0))];
    const probePaths = [...new Set((input.probePaths ?? paths).filter((item) => item.trim().length > 0))];
    const probeBefore = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
    const commit = await runtime.vcs.atomicCommit({
      message: input.message,
      paths,
      ...(input.deletePaths && input.deletePaths.length > 0 ? { deletePaths: input.deletePaths } : {}),
      // §7.5 步骤 9：内容核对——暂存 blob 必须等于调用方写入/核对过的文本。
      ...((input.expectedFiles?.length ?? 0) > 0
        ? { verifyEntries: input.expectedFiles?.map((expected) => ({ path: expected.relPath, blobHash: gitBlobHash(expected.text) })) }
        : {}),
      ...(input.deletePaths && input.deletePaths.length > 0 ? { verifyDeletions: input.deletePaths } : {}),
    });
    if (commit.success) {
      if (commit.commitRevision) return { landed: true, commitRevision: commit.commitRevision };
      const fallbackProbe = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
      return { landed: true, commitRevision: fallbackProbe !== null && fallbackProbe !== probeBefore ? fallbackProbe : null };
    }
    const probeAfter = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
    if (probeBefore === null || probeAfter === null) {
      return { landed: false, outcome: 'RECOVERY_REQUIRED', detail: `${commit.errorOutput}（提交探针不可读，无法判定提交是否存在）` };
    }
    if (probeAfter !== probeBefore) {
      // 探针前进：核对提交内容确实包含本次写入（防止把并发提交误判为本次提交）。
      for (const expected of input.expectedFiles ?? []) {
        const actual = await runtime.vcs.readFileAt(probeAfter, expected.relPath).catch(() => null);
        if (actual !== null && actual === expected.text) {
          return { landed: true, commitRevision: probeAfter };
        }
      }
      return {
        landed: false,
        outcome: 'RECOVERY_REQUIRED',
        detail: `${commit.errorOutput}（提交探针已前进但提交内容与本次写入不一致，禁止恢复）`,
      };
    }
    return { landed: false, outcome: 'ABORTED', detail: commit.errorOutput };
  }

  /** §5.6：追加版本写入后提交失败且已证明提交不存在时，恢复 review.md 并删除本次新增的补丁文件。 */
  private async restoreAppendedRevision(
    candidate: ReviewCandidate,
    reviewBackup: string,
    entriesBefore: Set<string>,
  ): Promise<void> {
    const { writeFile: writeRestored, rm, readdir } = await import('node:fs/promises');
    await writeRestored(candidate.reviewPath, reviewBackup, 'utf8').catch(() => undefined);
    const after = await readdir(candidate.dirPath).catch(() => [] as string[]);
    for (const name of after) {
      if (!entriesBefore.has(name)) await rm(path.join(candidate.dirPath, name), { force: true }).catch(() => undefined);
    }
  }

  /** §5.6 共享写端点的统一三分支失败处理：恢复只允许发生在“已证明提交不存在”分支。 */
  private async commitSharedWrite(
    message: string,
    candidate: ReviewCandidate,
    runtime: Runtime,
    backupText?: string | null,
    expectedText?: string | null,
  ): Promise<{ commitRevision: string | null }> {
    const { store } = runtime;
    const relReview = relative(store.repoRoot, candidate.reviewPath);
    // 未显式提供备份时兜底读取当前内容（注意：这已是写入后的内容，仅作最后手段）。
    const restore = backupText !== undefined ? backupText : await readFile(candidate.reviewPath, 'utf8').catch(() => null);
    const written = expectedText !== undefined ? expectedText : await readFile(candidate.reviewPath, 'utf8').catch(() => null);
    const result = await this.commitAndClassify({
      runtime,
      message,
      paths: [relative(store.repoRoot, candidate.dirPath)],
      probePaths: [relReview],
      ...(written !== null ? { expectedFiles: [{ relPath: relReview, text: written }] } : {}),
    });
    if (result.landed) return { commitRevision: result.commitRevision };
    if (result.outcome === 'RECOVERY_REQUIRED') {
      throw new ApiError(409, 'conflict', `提交结果无法确定，写入保留在本地待人工核对：${result.detail}`, {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: result.detail,
      });
    }
    if (restore !== null) {
      const { writeFile: restoreWrite } = await import('node:fs/promises');
      await restoreWrite(candidate.reviewPath, restore, 'utf8');
    }
    throw new ApiError(500, 'internal', `提交 .ai-review 失败，已回滚本次写入：${result.detail}`);
  }

  /** 在执行共享写入前捕获 review.md 备份（供 commitSharedWrite 三分支恢复）。 */
  private async reviewBackup(store: ReviewStore, id: string): Promise<string | null> {
    try {
      const detail = await store.get(id, null);
      return await readFile(detail.candidate.reviewPath, 'utf8');
    } catch {
      return null;
    }
  }

  private async addComment(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const author = await this.ownerFor(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1：共享写只能来自共享事实
    // §8.1：字段类型错误 400（不得静默降级为总体评论/当前版本）。
    if (body['file'] !== undefined && typeof body['file'] !== 'string') throw new ApiError(400, 'bad_request', 'file 必须是 string');
    if (body['side'] !== undefined && typeof body['side'] !== 'string') throw new ApiError(400, 'bad_request', 'side 必须是 LEFT/RIGHT');
    if (body['line'] !== undefined && typeof body['line'] !== 'number') throw new ApiError(400, 'bad_request', 'line 必须是 number');
    if (body['revision'] !== undefined && typeof body['revision'] !== 'number') throw new ApiError(400, 'bad_request', 'revision 必须是 number');
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    if (body['anchor'] !== undefined && !isAnchor(body['anchor'])) {
      throw new ApiError(422, 'bad_request', 'anchor 必须是 {snippet: 非空 string, before?, after?}');
    }
    const candidate = await store.addComment(id, author, {
      content: stringField(body, 'content'),
      ...(typeof body['file'] === 'string' ? { file: body['file'] } : {}),
      ...(typeof body['line'] === 'number' ? { line: body['line'] } : {}),
      ...(typeof body['revision'] === 'number' ? { revision: body['revision'] } : {}),
      // §4.3/I11：行内评论必须带 LEFT/RIGHT。
      ...(body['side'] === 'LEFT' || body['side'] === 'RIGHT' ? { side: body['side'] } : {}),
      // §4.3/G39：可选锚点 {snippet, before?, after?}；Host 在缺失时兜底提取。
      ...(isAnchor(body['anchor']) ? { anchor: body['anchor'] } : {}),
    }, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 审核意见 (rev ${String(candidate.meta.currentRevision)})`, candidate, runtime, backupText);
    let job: JobRecord | undefined;
    let autoFixError: string | undefined;
    if (body['autoFix'] === true) {
      try {
        // Chain from the just-committed opinion: the fixer reads every unresolved
        // comment from review.md, including this one.
        job = await this.startAiFixJob(runtime, id, {
          expectedRevision: candidate.meta.currentRevision,
          expectedOwner: candidate.meta.owner,
          expectedUpdatedAt: candidate.meta.updatedAt,
        });
      } catch (error) {
        autoFixError = error instanceof Error ? error.message : String(error);
      }
    }
    sendJson(res, 200, {
      candidate,
      commit,
      ...(job ? { job } : {}),
      ...(autoFixError ? { autoFixError } : {}),
    });
  }

  private async commentStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const commentId = stringField(body, 'commentId');
    const status = stringField(body, 'status');
    if (status !== 'unresolved' && status !== 'partial' && status !== 'resolved') {
      throw new ApiError(422, 'bad_request', '非法意见状态');
    }
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    const candidate = await store.setCommentStatus(id, commentId, status, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 更新意见状态`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  private async takeover(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const owner = stringField(body, 'owner') || await this.ownerFor(store.repoRoot);
    await this.requireSharedCandidate(runtime, id); // §7.1
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    const candidate = await store.transferOwner(id, owner, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 接管审核 (owner ${owner})`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  /** §5.1/G12 /resume：仅 Owner 把 changes_requested 转回 pending，不产生新版本。 */
  private async resume(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id); // §7.1
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    const candidate = await store.resume(id, guard);
    const commit = await this.commitSharedWrite(`review(${id}): resume to pending`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  /** §8.3/G37 /comments/batch：全有或全无，一次共享写入与一次提交；状态只在批次内转换一次。 */
  private async addCommentsBatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const author = await this.ownerFor(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id); // §7.1
    const rawComments = body['comments'];
    if (!Array.isArray(rawComments) || rawComments.length === 0) {
      throw new ApiError(422, 'bad_request', 'comments 必须是非空数组');
    }
    // §8.3：任一条非法整批 422，不静默过滤或部分写入。
    const inputs = rawComments.map((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new ApiError(422, 'bad_request', `comments[${String(index)}] 必须是对象`);
      }
      const record = item as Record<string, unknown>;
      if (record['content'] !== undefined && typeof record['content'] !== 'string') {
        throw new ApiError(400, 'bad_request', `comments[${String(index)}].content 必须是 string`);
      }
      if (record['file'] !== undefined && typeof record['file'] !== 'string') {
        throw new ApiError(400, 'bad_request', `comments[${String(index)}].file 必须是 string`);
      }
      if (record['side'] !== undefined && typeof record['side'] !== 'string') {
        throw new ApiError(400, 'bad_request', `comments[${String(index)}].side 必须是 LEFT/RIGHT`);
      }
      if (record['line'] !== undefined && typeof record['line'] !== 'number') {
        throw new ApiError(400, 'bad_request', `comments[${String(index)}].line 必须是 number`);
      }
      if (record['revision'] !== undefined && typeof record['revision'] !== 'number') {
        throw new ApiError(400, 'bad_request', `comments[${String(index)}].revision 必须是 number`);
      }
      if (record['anchor'] !== undefined && !isAnchor(record['anchor'])) {
        throw new ApiError(422, 'bad_request', `comments[${String(index)}].anchor 必须是 {snippet: 非空 string, before?, after?}`);
      }
      return {
        content: typeof record['content'] === 'string' ? record['content'] : '',
        ...(typeof record['file'] === 'string' ? { file: record['file'] } : {}),
        ...(typeof record['line'] === 'number' ? { line: record['line'] } : {}),
        ...(typeof record['revision'] === 'number' ? { revision: record['revision'] } : {}),
        ...(record['side'] === 'LEFT' || record['side'] === 'RIGHT' ? { side: record['side'] as 'LEFT' | 'RIGHT' } : {}),
        ...(isAnchor(record['anchor']) ? { anchor: record['anchor'] } : {}),
      };
    });
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    const candidate = await store.addComments(id, author, inputs, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 批量审核意见 (${String(inputs.length)} 条)`, candidate, runtime, backupText);
    let job: JobRecord | undefined;
    let autoFixError: string | undefined;
    if (body['autoFix'] === true) {
      try {
        job = await this.startAiFixJob(runtime, id, {
          expectedRevision: candidate.meta.currentRevision,
          expectedOwner: candidate.meta.owner,
          expectedUpdatedAt: candidate.meta.updatedAt,
        });
      } catch (error) {
        autoFixError = error instanceof Error ? error.message : String(error);
      }
    }
    sendJson(res, 200, { candidate, commit, ...(job ? { job } : {}), ...(autoFixError ? { autoFixError } : {}) });
  }

  private async reject(req: IncomingMessage, res: ServerResponse, url: URL, mode: 'manual' | 'stale' = 'manual'): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const reason = mode === 'stale'
      ? '超过 stale_days 未审核，按超时废弃处理'
      : stringField(body, 'reason');
    const category = mode === 'stale' ? 'stale' : stringField(body, 'category') || undefined;
    if (category === 'stale' && mode === 'manual') {
      throw new ApiError(422, 'bad_request', '人工拒绝不得使用 stale 分类（stale 仅由超时归档写入）');
    }
    const detail = await store.get(id, null);
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1
    await store.ensureWriteAllowed(detail.candidate, guard);
    // §4.3/G38：Host 在删除补丁前从当前补丁 hunk header 提取函数/结构体名。
    const relatedSymbols = [...new Set(
      [...detail.patchText.matchAll(/^@@[^\n]*@@\s*(\S[^\n]*)$/gm)]
        .map((match) => (match[1] ?? '').trim())
        .filter((symbol) => symbol.length > 0)
        .map((symbol) => symbol.slice(0, 120)),
    )].slice(0, 16);
    const reviewers = await loadReviewers(store.repoRoot);
    if (mode === 'stale' && reviewers.staleDays === null) {
      throw new ApiError(409, 'conflict', 'reviewers.yml 未配置 stale_days，不能按超时归档');
    }
    const reviewBackup = await readFile(detail.candidate.reviewPath, 'utf8');
    const patchBackups: { name: string; text: string }[] = [];
    for (const revision of detail.candidate.meta.revisions) {
      const file = path.join(detail.candidate.dirPath, revision.patch);
      if (existsSync(file)) patchBackups.push({ name: revision.patch, text: await readFile(file, 'utf8') });
    }
    const candidate = await store.reject(id, reason, guard, mode === 'stale'
      ? { rejectedBy: 'system:stale', requireStaleDays: reviewers.staleDays ?? undefined, category: 'stale', relatedSymbols }
      : { ...(category !== undefined ? { category } : {}), relatedSymbols });
    const writtenReview = await readFile(candidate.reviewPath, 'utf8').catch(() => null);
    const patchRelPaths = candidate.meta.revisions.map((revision) => relative(store.repoRoot, path.join(candidate.dirPath, revision.patch)));
    const result = await this.commitAndClassify({
      runtime,
      message: `review(${id}): ${mode === 'stale' ? 'archive stale' : 'reject'} rev ${String(candidate.meta.currentRevision)}`,
      paths: [relative(store.repoRoot, candidate.dirPath)],
      // SVN 下目录 revision 不随文件内容修改前进：探针必须指向 review.md 与被删除的补丁文件。
      probePaths: [relative(store.repoRoot, candidate.reviewPath), ...patchRelPaths],
      deletePaths: patchRelPaths,
      ...(writtenReview !== null
        ? { expectedFiles: [{ relPath: relative(store.repoRoot, candidate.reviewPath), text: writtenReview }] }
        : {}),
    });
    if (!result.landed) {
      // §5.6 三分支：只有“已证明提交不存在”才恢复操作前文件；结果不明保留现场。
      if (result.outcome === 'RECOVERY_REQUIRED') {
        throw new ApiError(409, 'conflict', `拒绝已写入但提交结果无法确定，现场保留待人工核对：${result.detail}`, {
          status: 'RECOVERY_REQUIRED',
          reason: 'COMMIT_OUTCOME_UNKNOWN',
          detail: result.detail,
        });
      }
      const { writeFile } = await import('node:fs/promises');
      await writeFile(candidate.reviewPath, reviewBackup, 'utf8');
      for (const backup of patchBackups) await writeFile(path.join(candidate.dirPath, backup.name), backup.text, 'utf8');
      throw new ApiError(500, 'internal', `已放弃，但提交 .ai-review 失败（已回滚）：${result.detail}`);
    }
    sendJson(res, 200, { candidate, commitRevision: result.commitRevision });
  }

  /**
   * §6.5 Rebase：在最新基线上重建当前补丁——干净工作区 → 应用补丁（失败即冲突）
   * → 重跑门禁 → 追加新版本（author: ai，基线=最新）→ 回 pending → 只提交候选目录。
   */
  private async rebase(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    this.ensureNoAuditRunning(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1
    const detail = await store.get(id, null);
    await store.ensureWriteAllowed(detail.candidate, guard);
    const job = this.jobs.start('ai_fix', (log, jobId) => this.withWriteLock(store.repoRoot, async () => {
      const candidate = detail.candidate;
      const base = await vcs.getCurrentBase().catch(() => null);
      if (!base) return { status: 'ABORTED', message: '无法读取最新基线', jobId };
      const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
      if (!current) return { status: 'ABORTED', message: '当前版本缺失', jobId };
      if (current.baseRevision === base) {
        return { status: 'ABORTED', message: '基线已是最新，无需 Rebase', jobId };
      }
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) return { status: 'ABORTED', message: `工作区不干净：${clean.message}`, jobId };
      log(`在最新基线 ${base.slice(0, 12)} 上应用补丁`);
      const patchPath = path.join(store.repoRoot, '.ai-review', id, current.patch);
      const oldPatchText = await readFile(patchPath, 'utf8');
      const touchedPaths = parsePatch(oldPatchText).paths.filter((file) => !isAiReviewPath(file));
      const applied = await vcs.applyPatch(patchPath, true);
      if (!applied.ok) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', message: `Rebase 冲突：${applied.message}`, jobId };
      }
      log('重跑门禁');
      const report = await runGateChecks(candidate.meta.gateChecks, {
        cwd: store.repoRoot, baseRevision: base, timeoutMs: this.settings.gateTimeoutMs,
        onLine: (line) => { if (line.trim()) log(`  ${line.slice(0, 300)}`); },
      });
      if (!report.allPassed) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', message: `门禁未通过，Rebase 未产生新版本：\n${report.formattedEvidenceMarkdown}`, jobId };
      }
      // §7.7：门禁通过后必须基于新基线导出包含实际冲突解决结果的完整 diff，不得复用旧补丁文本。
      let newPatchText = '';
      try {
        newPatchText = await vcs.exportWorkingTreeDiff(base, touchedPaths);
      } catch (error) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', message: `Rebase 无法导出新基线补丁：${error instanceof Error ? error.message : String(error)}`, jobId };
      }
      await vcs.revertBusinessWorkspace().catch(() => undefined);
      if (!newPatchText.trim() || patchTouchesReviewData(newPatchText)) {
        return { status: 'ABORTED', message: 'Rebase 导出的新补丁为空或包含禁止路径，未产生新版本', jobId };
      }
      // 新补丁必须能在新基线干净应用，验证后立即还原。
      const { writeFile: writeTmp, rm: rmTmp, readFile: readFs, readdir } = await import('node:fs/promises');
      const os = await import('node:os');
      const tmpNewPatch = path.join(os.tmpdir(), `dcr-rebase-${String(process.pid)}-${String(Date.now())}.patch`);
      await writeTmp(tmpNewPatch, newPatchText, 'utf8');
      let verifyApply;
      try {
        verifyApply = await vcs.applyPatch(tmpNewPatch, false);
      } finally {
        await rmTmp(tmpNewPatch, { force: true }).catch(() => undefined);
      }
      await vcs.revertBusinessWorkspace().catch(() => undefined);
      if (!verifyApply.ok) {
        return { status: 'ABORTED', message: `Rebase 新补丁无法在新基线干净应用：${verifyApply.message}`, jobId };
      }
      const reviewBackup = await readFs(candidate.reviewPath, 'utf8');
      const entriesBefore = new Set(await readdir(candidate.dirPath).catch(() => [] as string[]));
      const updated = await store.appendRevision(id, {
        author: 'ai', baseRevision: base, patchText: newPatchText,
      }, guard);
      const writtenReview = await readFs(updated.reviewPath, 'utf8').catch(() => null);
      const result = await this.commitAndClassify({
        runtime,
        message: `review(${id}): rebase to ${base.slice(0, 12)} (rev ${String(updated.meta.currentRevision)})`,
        paths: [relative(store.repoRoot, updated.dirPath)],
        probePaths: [relative(store.repoRoot, updated.reviewPath)],
        ...(writtenReview !== null
          ? { expectedFiles: [{ relPath: relative(store.repoRoot, updated.reviewPath), text: writtenReview }] }
          : {}),
      });
      if (!result.landed) {
        if (result.outcome === 'RECOVERY_REQUIRED') {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            detail: result.detail,
            commitRevision: null,
            message: `Rebase 新版本提交结果无法确定，现场保留待人工核对：${result.detail}`,
            jobId,
          };
        }
        await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
        return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: `提交失败，已恢复操作前版本：${result.detail}`, jobId };
      }
      return { status: 'COMMITTED', newRevision: updated.meta.currentRevision, commitRevision: result.commitRevision, message: `已 Rebase 到基线 ${base.slice(0, 12)}，新版本 ${String(updated.meta.currentRevision)}`, jobId };
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /**
   * §6.4 人工微调（收尾）：外部提供的全量补丁文本在当前基线上验证 + 重跑门禁后
   * 追加新版本（author: human）→ 回 pending → 只提交候选目录。
   */
  private async manualRevision(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    this.ensureNoAuditRunning(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const patchText = stringField(body, 'patchText');
    if (!patchText.trim()) throw new ApiError(422, 'bad_request', 'patchText 不能为空');
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1
    const detail = await store.get(id, null);
    await store.ensureWriteAllowed(detail.candidate, guard);
    const job = this.jobs.start('ai_fix', (log, jobId) => this.withWriteLock(store.repoRoot, async () => {
      const candidate = detail.candidate;
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) return { status: 'ABORTED', message: `工作区不干净：${clean.message}`, jobId };
      const base = await vcs.getCurrentBase().catch(() => null);
      if (!base) return { status: 'ABORTED', message: '无法读取当前基线', jobId };
      const { writeFile: writeTmp, rm: rmTmp } = await import('node:fs/promises');
      const os = await import('node:os');
      const tmpPath = path.join(os.tmpdir(), `dcr-tweak-${String(process.pid)}.patch`);
      await writeTmp(tmpPath, patchText, 'utf8');
      try {
        const applied = await vcs.applyPatch(tmpPath, false);
        if (!applied.ok) {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
          return { status: 'ABORTED', message: `补丁无法应用：${applied.message}`, jobId };
        }
        log('重跑门禁');
        const report = await runGateChecks(candidate.meta.gateChecks, {
          cwd: store.repoRoot, baseRevision: base, timeoutMs: this.settings.gateTimeoutMs,
          onLine: (line) => { if (line.trim()) log(`  ${line.slice(0, 300)}`); },
        });
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        if (!report.allPassed) {
          return { status: 'ABORTED', message: `门禁未通过，未产生新版本：\n${report.formattedEvidenceMarkdown}`, jobId };
        }
        const { readFile: readFs, readdir } = await import('node:fs/promises');
        const reviewBackup = await readFs(candidate.reviewPath, 'utf8');
        const entriesBefore = new Set(await readdir(candidate.dirPath).catch(() => [] as string[]));
        const updated = await store.appendRevision(id, { author: 'human', baseRevision: base, patchText }, guard);
        const writtenReview = await readFs(updated.reviewPath, 'utf8').catch(() => null);
        const result = await this.commitAndClassify({
          runtime,
          message: `review(${id}): manual tweak (rev ${String(updated.meta.currentRevision)})`,
          paths: [relative(store.repoRoot, updated.dirPath)],
          probePaths: [relative(store.repoRoot, updated.reviewPath)],
          ...(writtenReview !== null
            ? { expectedFiles: [{ relPath: relative(store.repoRoot, updated.reviewPath), text: writtenReview }] }
            : {}),
        });
        if (!result.landed) {
          if (result.outcome === 'RECOVERY_REQUIRED') {
            return {
              status: 'RECOVERY_REQUIRED',
              reason: 'COMMIT_OUTCOME_UNKNOWN',
              detail: result.detail,
              commitRevision: null,
              message: `人工微调新版本提交结果无法确定，现场保留待人工核对：${result.detail}`,
              jobId,
            };
          }
          await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
          return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: `提交失败，已恢复操作前版本：${result.detail}`, jobId };
        }
        return { status: 'COMMITTED', newRevision: updated.meta.currentRevision, commitRevision: result.commitRevision, message: `人工微调完成，新版本 ${String(updated.meta.currentRevision)}`, jobId };
      } finally {
        await rmTmp(tmpPath, { force: true }).catch(() => undefined);
      }
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** §7.6/G22 /dismiss-finding：带理由、仅最新有效观察中的 pending item、独立提交。 */
  private async dismissFinding(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const findingId = stringField(body, 'findingId');
    const reason = stringField(body, 'reason').trim();
    if (!auditId || !findingId) throw new ApiError(400, 'bad_request', '缺少 auditId / findingId');
    if (!reason) throw new ApiError(422, 'bad_request', '忽略理由不能为空');
    const archive = new AuditArchive(runtime.root);
    const record = await archive.read(auditId);
    if (record.parseError) throw new ApiError(422, 'bad_request', `审查档案无效：${record.parseError}`);
    await this.requireSharedAudit(runtime, auditId, record.reviewPath); // §7.1
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new ApiError(404, 'not_found', `finding 不存在：${findingId}`);
    if (item.status !== 'pending') {
      throw new ApiError(409, 'conflict', `审查项状态为 ${item.status}，只有 pending 可忽略`);
    }
    // §7.6：只能修改该 finding 的最新有效观察——旧档案 pending item 会被更新观察覆盖，拒绝。
    const { findings: projections } = await this.findingProjection(runtime);
    const projection = projections.find((entry) => entry.findingId === findingId);
    if (!projection || projection.lastObservedAudit !== auditId) {
      throw new ApiError(409, 'conflict', `该 finding 的最新有效观察不在档案 ${auditId} 中（当前 ${projection?.lastObservedAudit ?? '无观察'}），不能修改旧观察`);
    }
    const operator = await this.ownerFor(runtime.root);
    const { readFile: readAuditBackup, writeFile: writeAuditBackup } = await import('node:fs/promises');
    const auditBackup = await readAuditBackup(record.reviewPath, 'utf8');
    const updated = await archive.updateItem(
      auditId,
      findingId,
      'dismissed',
      null,
      `${new Date().toISOString()} · ${operator} · dismiss ${findingId}：${reason}`,
    );
    const writtenAudit = await readAuditBackup(record.reviewPath, 'utf8').catch(() => null);
    const result = await this.commitAndClassify({
      runtime,
      message: `audit(${auditId}): dismiss finding ${findingId}`,
      paths: [`.ai-review/audits/${auditId}`],
      probePaths: [`.ai-review/audits/${auditId}/audit.md`],
      ...(writtenAudit !== null
        ? { expectedFiles: [{ relPath: `.ai-review/audits/${auditId}/audit.md`, text: writtenAudit }] }
        : {}),
    });
    if (!result.landed) {
      // §5.6 三分支：只有“已证明提交不存在”才恢复档案；结果不明保留现场。
      if (result.outcome === 'RECOVERY_REQUIRED') {
        throw new ApiError(409, 'conflict', `忽略操作已写入但提交结果无法确定，现场保留待人工核对：${result.detail}`, {
          status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: result.detail,
        });
      }
      await writeAuditBackup(record.reviewPath, auditBackup, 'utf8');
      throw new ApiError(500, 'internal', `忽略已写入但提交失败（已恢复档案）：${result.detail}`);
    }
    sendJson(res, 200, { audit: updated.meta, commitRevision: result.commitRevision });
  }

  /**
   * §6.2 B/Deferred 转候选：把一个已存在的候选与审查项绑定。
   * Deferred 必须先确认 depends_on 满足（前置 finding resolved，或其 converted 候选 approved）；
   * 审查档案与候选目录两侧必须在同一个共享提交中完成，失败恢复档案文件。
   */
  private async convert(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const findingId = stringField(body, 'findingId');
    const candidateId = stringField(body, 'candidateId');
    if (!auditId || !findingId || !candidateId) {
      throw new ApiError(400, 'bad_request', '缺少 auditId / findingId / candidateId');
    }
    const archive = new AuditArchive(runtime.root);
    const record = await archive.read(auditId);
    if (record.parseError) throw new ApiError(422, 'bad_request', `审查档案无效：${record.parseError}`);
    await this.requireSharedAudit(runtime, auditId, record.reviewPath); // §7.1
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new ApiError(404, 'not_found', `finding 不存在：${findingId}`);
    if (item.status !== 'pending') {
      throw new ApiError(409, 'conflict', `审查项状态为 ${item.status}，只有 pending 可转换`);
    }
    // §7.6：只能修改该 finding 的最新有效观察——旧档案 pending item 会被更新观察覆盖，拒绝。
    const { findings: projections } = await this.findingProjection(runtime);
    const currentObservation = projections.find((entry) => entry.findingId === findingId);
    if (!currentObservation || currentObservation.lastObservedAudit !== auditId) {
      throw new ApiError(409, 'conflict', `该 finding 的最新有效观察不在档案 ${auditId} 中（当前 ${currentObservation?.lastObservedAudit ?? '无观察'}），不能修改旧观察`);
    }
    if (item.kind === 'deferred') {
      const prerequisite = projections.find((projection) => projection.findingId === item.dependsOn);
      const satisfied = prerequisite !== undefined
        && (prerequisite.lastStatus === 'resolved'
          || (prerequisite.lastStatus === 'converted' && prerequisite.candidateStatus === 'approved'));
      if (!satisfied) {
        const blocker = prerequisite
          ? `前置 finding 状态：${prerequisite.lastStatus}${prerequisite.candidateStatus ? `（候选 ${prerequisite.candidateStatus}）` : ''}`
          : `前置 finding 无有效观察：${item.dependsOn ?? '(空)'}`;
        throw new ApiError(409, 'conflict', `depends_on 未满足，阻塞转换——${blocker}`);
      }
    }
    const detail = await (async () => {
      const view = await sharedViewFor(runtime);
      if (view?.source) {
        const { month, slug } = store.resolveCandidateDir(candidateId);
        const sharedText = await view.source.readReviewText(month, slug).catch(() => null);
        if (sharedText !== null) {
          if (await view.source.hasLocalChanges(month, slug).catch(() => false)) {
            throw new ApiError(409, 'conflict', `候选 ${candidateId} 存在本地未提交改动，不能作为转换目标；请先还原工作区`);
          }
          return store.get(candidateId, null, view.source);
        }
      }
      return store.get(candidateId, null);
    })();
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', `候选数据无效：${detail.candidate.parseError}`);
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', `候选 ${candidateId} 已归档，不能作为转换目标`);
    }
    // §7.6：只有当目标候选是本地新生成（尚未共享）时才把候选目录纳入同一提交。
    const sharedView = await sharedViewFor(runtime);
    const targetIsShared = sharedView?.source
      ? (await sharedView.source.readReviewText(detail.candidate.month, detail.candidate.slug).catch(() => null)) !== null
      : false;
    const commitPaths = [`.ai-review/audits/${auditId}`, ...(targetIsShared ? [] : [`.ai-review/${candidateId}`])];
    // 两侧同一提交：先备份档案，更新 item，再连同候选目录一起原子提交；失败恢复档案。
    const { readFile, writeFile } = await import('node:fs/promises');
    const auditBackup = await readFile(record.reviewPath, 'utf8');
    await archive.updateItem(auditId, findingId, 'converted', candidateId);
    const writtenAudit = await readFile(record.reviewPath, 'utf8').catch(() => null);
    const result = await this.commitAndClassify({
      runtime,
      message: `audit(${auditId}): convert ${findingId} -> ${candidateId}`,
      paths: commitPaths,
      probePaths: [`.ai-review/audits/${auditId}/audit.md`],
      ...(writtenAudit !== null
        ? { expectedFiles: [{ relPath: `.ai-review/audits/${auditId}/audit.md`, text: writtenAudit }] }
        : {}),
    });
    if (!result.landed) {
      // §5.6 三分支：HEAD 不可读或已前进 → 保留现场，不回写备份。
      if (result.outcome === 'RECOVERY_REQUIRED') {
        throw new ApiError(409, 'conflict', `转换提交结果无法确定，现场保留待人工核对：${result.detail}`, {
          status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: result.detail,
        });
      }
      await writeFile(record.reviewPath, auditBackup, 'utf8');
      throw new ApiError(500, 'internal', `转换提交失败，已恢复审查档案：${result.detail}`);
    }
    const updated = await archive.read(auditId);
    sendJson(res, 200, { audit: updated.meta, candidateId, commitRevision: result.commitRevision });
  }

  private async reopen(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const from = stringField(body, 'from');
    const reason = stringField(body, 'reason');
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1
    const backupText = await this.reviewBackup(store, id); // §5.6：写入前备份
    const candidate = await store.reopen(id, from, reason, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 人工重开（来自 ${from}）`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  private async approve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    this.ensureNoAuditRunning(store.repoRoot);
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
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id); // §7.1
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
      const reviewersCfg = await loadReviewers(store.repoRoot);
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
        const reviewersCfg = await loadReviewers(store.repoRoot);
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
  private async startAiFixJob(runtime: Runtime, id: string, guard: ConcurrencyGuard): Promise<JobRecord> {
    this.ensureNoAuditRunning(runtime.root);
    const { store, vcs } = runtime;
    const detail = await store.get(id, null);
    await this.requireOwnerOf(store, id); // §12.2：非 Owner 403（takeover 除外）
    await this.requireSharedCandidate(runtime, id); // §7.1：AI 修复只能作用于共享事实
    // §7.4/G23：显式 ai-fix 必须至少有一条 unresolved/partial 评论作为输入。
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
    return this.jobs.start('ai_fix', (log, _jobId, signal) => this.withWriteLock(runtime.root, async () => {
      const comments = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
      const patch = await store.currentPatch(detail.candidate);
      const { readFile: readFs, readdir } = await import('node:fs/promises');
      // §5.6：提交前快照候选目录，AI 修复失败或提交被证明不存在时恢复。
      const reviewBackup = await readFs(detail.candidate.reviewPath, 'utf8');
      const entriesBefore = new Set(await readdir(detail.candidate.dirPath).catch(() => [] as string[]));
      let workingTree: 'clean_base' | 'current_patch_applied' = 'clean_base';
      if (this.settings.runner !== 'manual') {
        const applied = await vcs.applyPatch(patch.path, false);
        if (!applied.ok) throw new Error(`当前版本补丁无法应用到工作区，无法继续 AI 修复：${applied.message}`);
        workingTree = 'current_patch_applied';
        log(`已把当前版本补丁 ${patch.path.split(/[\\/]/).pop() ?? ''} 应用到工作区`);
      }
      const runner = new Runner({
        kind: this.settings.runner,
        settings: this.settings,
        store,
        candidate: detail.candidate,
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
      if (result.manual) return { manual: true, prompt: result.prompt ?? '' };
      if (!result.success) {
        await this.restoreAppendedRevision(detail.candidate, reviewBackup, entriesBefore);
        if (result.aborted) {
          return {
            status: 'ABORTED',
            reason: 'RUNNER_FAILED',
            message: 'AI 修复已取消（未产生共享提交）',
          };
        }
        throw new Error(result.errorMessage ?? 'AI 修复失败');
      }
      const latest = await store.get(id, null);
      const writtenReview = await readFs(latest.candidate.reviewPath, 'utf8').catch(() => null);
      const outcome = await this.commitAndClassify({
        runtime,
        message: `review(${id}): AI 修复生成版本 ${String(result.newRevisionId ?? latest.candidate.meta.currentRevision)}`,
        paths: [relative(store.repoRoot, latest.candidate.dirPath)],
        probePaths: [relative(store.repoRoot, latest.candidate.reviewPath)],
        ...(writtenReview !== null
          ? { expectedFiles: [{ relPath: relative(store.repoRoot, latest.candidate.reviewPath), text: writtenReview }] }
          : {}),
      });
      if (!outcome.landed) {
        if (outcome.outcome === 'RECOVERY_REQUIRED') {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            detail: outcome.detail,
            commitRevision: null,
            message: `AI 修复新版本提交结果无法确定，现场保留待人工核对：${outcome.detail}`,
          };
        }
        await this.restoreAppendedRevision(detail.candidate, reviewBackup, entriesBefore);
        return {
          status: 'ABORTED',
          reason: 'COMMIT_FAILED',
          commitRevision: null,
          message: `AI 已生成新版本，但提交 .ai-review 失败（已恢复）：${outcome.detail}`,
        };
      }
      return { manual: false, result, status: 'COMMITTED', commitRevision: outcome.commitRevision };
    }));
  }

  /**
   * §7.6/G29 /candidate/finalize：独立 Fixer Mode A 候选（无 auditId）的收尾入口。
   * 不使用共享 guard：通过 repo 锁、本地候选完整性与目标共享目录冲突检查串行收尾，
   * 以 ai_fix Job 执行同一套完整校验（含 owner 路由），成功后仅提交该新候选目录。
   */
  private async candidateFinalize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    this.ensureNoAuditRunning(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    if (!id) throw new ApiError(400, 'bad_request', '缺少候选 id');
    // 目标必须是尚未共享的本地候选（review.md 不在 HEAD 中）。
    const sharedSource = await sharedSourceFor(runtime);
    const shared = sharedSource ? await sharedSource.readReviewText(...splitId(id)) : null;
    if (shared !== null) throw new ApiError(409, 'conflict', `候选 ${id} 已是共享事实，独立收尾仅适用于本地候选`);
    const job = this.jobs.start('ai_fix', (log, jobId) => this.withWriteLock(store.repoRoot, async () => {
      const detail = await store.get(id, null);
      const meta = detail.candidate.meta;
      const errors: string[] = [];
      if (detail.candidate.parseError) errors.push(detail.candidate.parseError);
      if (meta.status !== 'pending') errors.push(`独立候选状态必须是 pending，当前为 ${meta.status}`);
      if (meta.currentRevision !== 1) errors.push(`独立候选 current_revision 必须为 1，当前为 ${String(meta.currentRevision)}`);
      if (meta.approval !== null) errors.push('独立候选的 approval 必须为 null');
      errors.push(...await store.validateFullCandidate(detail.candidate));
      if (patchTouchesReviewData(detail.patchText)) errors.push('补丁包含禁止路径（.ai-review/.tmp/node_modules/.git/.svn）');
      // §4.2：owner 路由复核。
      const reviewers = await loadReviewers(store.repoRoot);
      const routing = resolveOwner(reviewers, { paths: meta.targetFiles, tags: meta.tags });
      if (!routing.owner) {
        errors.push('reviewers.yml 未配置 default_owner，无法完成 owner 路由复核');
      } else if (meta.owner !== routing.owner) {
        errors.push(`owner 应为 ${routing.owner}（${routing.reason}），实际为 ${meta.owner || '(空)'}`);
      }
      // 补丁可在当前基线干净应用。
      const base = await vcs.getCurrentBase().catch(() => null);
      const current = meta.revisions.find((revision) => revision.id === meta.currentRevision);
      if (base && current && current.baseRevision === base) {
        const applied = await vcs.applyPatch(path.join(detail.candidate.dirPath, current.patch), false);
        if (!applied.ok) errors.push(`补丁无法应用到当前基线：${applied.message}`);
      } else if (current) {
        errors.push(`候选基线 ${current.baseRevision || '(空)'} 与当前基线 ${base ?? '(不可读)'} 不一致`);
      }
      await vcs.revertBusinessWorkspace().catch(() => undefined);
      if (errors.length > 0) {
        return { status: 'VALIDATION_FAILED', errors, message: `候选 ${id} 未通过收尾校验`, jobId };
      }
      // §4.3：提交前规范化序列化（tags trim/小写/去重、键序、未知键保留），不改 updated_at。
      const { readFile: readFs } = await import('node:fs/promises');
      const reviewBackup = await readFs(detail.candidate.reviewPath, 'utf8');
      await store.write(detail.candidate, { touchUpdatedAt: false });
      const writtenReview = await readFs(detail.candidate.reviewPath, 'utf8').catch(() => null);
      const outcome = await this.commitAndClassify({
        runtime,
        message: `review(${id}): finalize standalone candidate [skip ci]`,
        paths: [`.ai-review/${id}`],
        probePaths: [`.ai-review/${id}/review.md`],
        ...(writtenReview !== null
          ? { expectedFiles: [{ relPath: `.ai-review/${id}/review.md`, text: writtenReview }] }
          : {}),
      });
      if (!outcome.landed) {
        if (outcome.outcome === 'RECOVERY_REQUIRED') {
          return {
            status: 'RECOVERY_REQUIRED',
            reason: 'COMMIT_OUTCOME_UNKNOWN',
            detail: outcome.detail,
            message: `独立候选 ${id} 提交结果无法确定，现场保留待人工核对：${outcome.detail}`,
            jobId,
          };
        }
        const { writeFile: restoreWrite } = await import('node:fs/promises');
        await restoreWrite(detail.candidate.reviewPath, reviewBackup, 'utf8').catch(() => undefined);
        return { status: 'ABORTED', reason: 'COMMIT_FAILED', message: `提交候选目录失败（已恢复）：${outcome.detail}`, jobId };
      }
      log(`独立候选 ${id} 已提交：${outcome.commitRevision?.slice(0, 12) ?? ''}`);
      return { status: 'COMMITTED', commitRevision: outcome.commitRevision, message: `独立候选 ${id} 已完成收尾提交`, jobId };
    }));
    sendJson(res, 202, { jobId: job.id, job });
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
      const lease = this.auditLeases.find((entry) => entry.auditId === auditId);
      if (lease && lease.state === 'active') {
        lease.state = 'releasable';
        await this.saveAuditLeases();
      }
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

  private async sync(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { vcs } = runtime;
    this.ensureNoAuditRunning(runtime.root);
    // §7.7：/sync 与其他工作区事务在同一 repo 锁内串行，不得改变其基线。
    const result = await this.withWriteLock(runtime.root, () => vcs.syncAndGetLatestBase());
    sendJson(res, 200, result);
  }

  private ensureNoAuditRunning(root?: string): void {
    const running = this.jobs.list().find((job) => job.type === 'audit' && job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', '仓库审查正在运行，请等待完成后再执行该操作。');
    }
    const lease = root !== undefined
      ? this.activeLeaseFor(root)
      : this.auditLeases.find((entry) => entry.state !== 'released');
    if (lease) {
      throw new ApiError(409, 'conflict', `审查执行租约 ${lease.auditId}（${lease.state}）仍在占用仓库；请先 /audit/finalize 收尾，或确认外部执行已停止后 /audit/release。`);
    }
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

