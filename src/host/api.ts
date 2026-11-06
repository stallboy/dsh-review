import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { ApprovalOrchestrator } from './approval.js';
import {
  Auditor,
  auditReportPath,
  buildAuditPrompt,
  loadAuditSystemPrompt,
  resolveAuditTarget,
} from './auditor.js';
import { JobManager } from './jobs.js';
import { parsePatch, isAiReviewPath } from './patch.js';
import { Runner, wrapAgentPrompt } from './runner.js';
import { loadReviewers } from './reviewers.js';
import { AuditArchive, projectFindings } from './audit-archive.js';
import { runGateChecks } from './validator.js';
import { matchesReviewFilter, ReviewStore } from './store.js';
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
import { createVcs, type VcsAdapter } from './vcs.js';

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
}

interface Runtime {
  root: string;
  store: ReviewStore;
  vcs: VcsAdapter;
  vcsType: VcsType;
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
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: { code: 'internal', message } });
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
  if (expectedRevision <= 0 || !expectedOwner) {
    throw new ApiError(400, 'bad_request', '缺少并发校验信息（expectedRevision / expectedOwner）');
  }
  return { expectedRevision, expectedOwner };
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

  private async runScheduledAudit(): Promise<void> {
    const runtime = await this.runtimeFor(new URL('http://local/')).catch(() => null);
    if (!runtime || !this.deps.createAuditSession) return;
    const running = this.jobs.list().find((job) => job.status === 'running');
    if (running) return;
    const baseRevision = await runtime.vcs.getCurrentBase().catch(() => null);
    if (!baseRevision) return;
    const clean = await runtime.vcs.ensureCleanWorkspace().catch(() => ({ clean: false, message: 'unknown' }));
    if (!clean.clean) return;
    const owner = await this.ownerFor(runtime.root);
    const now = new Date();
    const reportPath = auditReportPath('', now);
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
    });
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    await this.deps.createAuditSession({ cwd: runtime.root, title: '定时仓库审查', prompt, ownerSessionId: '' });
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
    this.vcs = createVcs(validation.vcsType, root);
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
      vcs: createVcs(vcsType, root),
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

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    try {
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
    if (method === 'POST' && route === '/comments') return this.withRepoLock(url, () => this.addComment(req, res, url));
    if (method === 'POST' && route === '/comment-status') return this.withRepoLock(url, () => this.commentStatus(req, res, url));
    if (method === 'POST' && route === '/takeover') return this.withRepoLock(url, () => this.takeover(req, res, url));
    if (method === 'POST' && route === '/reject') return this.withRepoLock(url, () => this.reject(req, res, url));
    if (method === 'POST' && route === '/archive-stale') return this.withRepoLock(url, () => this.reject(req, res, url, 'stale'));
    if (method === 'POST' && route === '/reopen') return this.withRepoLock(url, () => this.reopen(req, res, url));
    if (method === 'POST' && route === '/convert') return this.withRepoLock(url, () => this.convert(req, res, url));
    if (method === 'POST' && route === '/rebase') return this.withRepoLock(url, () => this.rebase(req, res, url));
    if (method === 'POST' && route === '/manual-revision') return this.withRepoLock(url, () => this.manualRevision(req, res, url));
    if (method === 'POST' && route === '/backfill') return this.withRepoLock(url, () => this.backfill(req, res, url));
    if (method === 'POST' && route === '/approve') return this.approve(req, res, url);
    if (method === 'POST' && route === '/ai-fix') return this.aiFix(req, res, url);
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
      });
      return;
    }
    const ownerParam = url.searchParams.get('owner');
    const owner = ownerParam !== null ? ownerParam.trim() : await this.ownerFor(runtime.root);
    const filter = filterFrom(url, owner);
    const base = await runtime.vcs.getCurrentBase().catch(() => null);
    // §18.1：stale_days 决定队列的过期提示（只读，不产生共享写入）。
    const reviewers = await loadReviewers(runtime.root);
    // One scan for both the filtered page and the owner-wide status counts: the
    // filtered items are always a subset of the owner's candidates.
    const all = await runtime.store.list({ owner }, base, reviewers.staleDays, reviewers.rejectionMemoryDays);
    const items = all.items.filter((item) => matchesReviewFilter(item, filter));
    const counts: Record<ReviewStatus, number> = { pending: 0, changes_requested: 0, approved: 0, rejected: 0 };
    for (const item of all.items) counts[item.status] += 1;
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
    const { store, vcs } = await this.runtimeFor(url);
    const me = await this.ownerFor(store.repoRoot);
    const id = idFrom(url);
    const currentBase = await vcs.getCurrentBase().catch(() => null);
    const detail = await store.get(id, currentBase);
    const validation = await store.validateCandidate(detail.candidate);
    const revisionStats: Record<number, unknown> = {};
    for (const revision of detail.candidate.meta.revisions) {
      try {
        const text = await store.readPatch(id, revision.patch);
        revisionStats[revision.id] = { patch: revision.patch, baseRevision: revision.baseRevision, stats: parsePatch(text).stats };
      } catch {
        revisionStats[revision.id] = { patch: revision.patch, baseRevision: revision.baseRevision, stats: null };
      }
    }
    const patchText = detail.patchText;
    const patchPaths = parsePatch(patchText).paths.filter((file) => !isAiReviewPath(file));
    const comments = [...detail.candidate.meta.comments].sort((left, right) => {
      const byRevision = left.revision - right.revision;
      return byRevision !== 0 ? byRevision : left.id.localeCompare(right.id);
    });
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
      canAct: detail.candidate.meta.owner === me,
      me,
      jobs: this.jobs.list().slice(0, 5),
    });
  }

  private async patch(res: ServerResponse, url: URL): Promise<void> {
    const { store } = await this.runtimeFor(url);
    const id = idFrom(url);
    const name = url.searchParams.get('name') ?? '';
    if (!name) throw new ApiError(400, 'bad_request', '缺少补丁文件名');
    const text = await store.readPatch(id, name);
    sendJson(res, 200, { name, text });
  }

  private async diff(res: ServerResponse, url: URL): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    const id = idFrom(url);
    const detail = await store.get(id, null);
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
        unifiedDiff: await store.readPatch(id, toRevision.patch),
        fromBase: null,
        toBase: toRevision.baseRevision,
        resolutionMode: null,
        notes: ['显示该版本相对基线的全量补丁。'],
      });
      return;
    }
    const fromRevision = detail.candidate.meta.revisions.find((revision) => revision.id === from);
    if (!fromRevision) throw new ApiError(404, 'not_found', `版本 ${String(from)} 不存在`);
    const fromText = await store.readPatch(id, fromRevision.patch);
    const toText = await store.readPatch(id, toRevision.patch);
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

  /** §3：目录式审查档案列表（旧扁平报告不参与）。 */
  private async auditsList(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const archive = new AuditArchive(runtime.root);
    const records = await archive.list();
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

  /** §3.4：finding 投影（覆盖判定 → 最新观察 → 当前状态 → 可见性）。 */
  private async findings(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const archive = new AuditArchive(runtime.root);
    const records = await archive.list();
    const queue = await runtime.store.list({}, null);
    const statusById = new Map(queue.items.map((item) => [item.id, item.status]));
    const projections = projectFindings(records, (candidateId) => statusById.get(candidateId) ?? null);
    sendJson(res, 200, { findings: projections, errors: records.filter((r) => r.parseError).map((r) => `${r.dirName}: ${r.parseError}`) });
  }

  private async fixPrompt(res: ServerResponse, url: URL): Promise<void> {
    const { store } = await this.runtimeFor(url);
    const id = idFrom(url);
    const detail = await store.get(id, null);
    const comments = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
    const runner = new Runner({
      kind: 'manual',
      settings: this.settings,
      store,
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
    const reportPath = auditReportPath(target.targetPath, now);
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
    });
    const systemPrompt = await loadAuditSystemPrompt();
    const promptWithRouting = `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`;
    const prompt = mode === 'session'
      ? composeSessionPrompt(systemPrompt, promptWithRouting)
      : wrapAgentPrompt(systemPrompt, promptWithRouting);
    sendJson(res, 200, {
      prompt,
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
    const reportPath = auditReportPath(target.targetPath, now);
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
    });
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    const title = `仓库审查 · ${target.targetPath || '全仓库'}`.slice(0, 60);
    const created = await this.deps.createAuditSession({ cwd: runtime.root, title, prompt, ownerSessionId });
    sendJson(res, 202, {
      sessionId: created.sessionId,
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
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const owner = await this.ownerFor(runtime.root);
    const job = this.jobs.start('audit', async (log) => {
      const auditor = new Auditor({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: this.settings,
        owner,
        targetPath: target.targetPath,
        note,
        log,
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      });
      const outcome = await auditor.run();
      log(`结果：${outcome.message}`);
      return outcome;
    });
    sendJson(res, 202, { jobId: job.id, job });
  }

  private async commitReviewOnly(
    message: string,
    candidate: ReviewCandidate,
    runtime: Runtime,
  ): Promise<{ success: boolean; message: string; commitRevision: string | null }> {
    const { store, vcs } = runtime;
    const result = await vcs.atomicCommit({
      message,
      paths: [relative(store.repoRoot, candidate.dirPath)],
    });
    return {
      success: result.success,
      message: result.success ? '已提交 .ai-review 变更' : result.errorOutput,
      commitRevision: result.commitRevision,
    };
  }

  private async addComment(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const author = await this.ownerFor(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const candidate = await store.addComment(id, author, {
      content: stringField(body, 'content'),
      ...(typeof body['file'] === 'string' ? { file: body['file'] } : {}),
      ...(typeof body['line'] === 'number' ? { line: body['line'] } : {}),
      ...(typeof body['revision'] === 'number' ? { revision: body['revision'] } : {}),
      // §4.6/I11：行内评论必须带 LEFT/RIGHT；UI 侧按行类型传 RIGHT（补丁新代码）。
      ...(body['side'] === 'LEFT' || body['side'] === 'RIGHT' ? { side: body['side'] } : {}),
    }, guard);
    const commit = await this.commitReviewOnly(`review(${id}): 审核意见 (rev ${String(candidate.meta.currentRevision)})`, candidate, runtime);
    let job: JobRecord | undefined;
    let autoFixError: string | undefined;
    if (body['autoFix'] === true) {
      try {
        // Chain from the just-committed opinion: the fixer reads every unresolved
        // comment from review.md, including this one.
        job = await this.startAiFixJob(runtime, id, {
          expectedRevision: candidate.meta.currentRevision,
          expectedOwner: candidate.meta.owner,
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
      throw new ApiError(400, 'bad_request', '非法意见状态');
    }
    const candidate = await store.setCommentStatus(id, commentId, status, guard);
    const commit = await this.commitReviewOnly(`review(${id}): 更新意见状态`, candidate, runtime);
    sendJson(res, 200, { candidate, commit });
  }

  private async takeover(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const owner = stringField(body, 'owner') || await this.ownerFor(store.repoRoot);
    const candidate = await store.transferOwner(id, owner, guard);
    const commit = await this.commitReviewOnly(`review(${id}): 接管审核 (owner ${owner})`, candidate, runtime);
    sendJson(res, 200, { candidate, commit });
  }

  private async reject(req: IncomingMessage, res: ServerResponse, url: URL, mode: 'manual' | 'stale' = 'manual'): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const reason = mode === 'stale'
      ? '超过 stale_days 未审核，按超时废弃处理'
      : stringField(body, 'reason');
    const detail = await store.get(id, null);
    await store.ensureWriteAllowed(detail.candidate, guard);
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
      ? { rejectedBy: 'system:stale', requireStaleDays: reviewers.staleDays ?? undefined }
      : {});
    const commit = await vcs.atomicCommit({
      message: `review(${id}): ${mode === 'stale' ? 'archive stale' : 'reject'} rev ${String(candidate.meta.currentRevision)}`,
      paths: [relative(store.repoRoot, candidate.dirPath)],
      deletePaths: candidate.meta.revisions.map((revision) => relative(store.repoRoot, path.join(candidate.dirPath, revision.patch))),
    });
    if (!commit.success) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(candidate.reviewPath, reviewBackup, 'utf8');
      for (const backup of patchBackups) await writeFile(path.join(candidate.dirPath, backup.name), backup.text, 'utf8');
      throw new ApiError(500, 'internal', `已放弃，但提交 .ai-review 失败：${commit.errorOutput}`);
    }
    sendJson(res, 200, { candidate, commitRevision: commit.commitRevision });
  }

  /**
   * §6.5 Rebase：在最新基线上重建当前补丁——干净工作区 → 应用补丁（失败即冲突）
   * → 重跑门禁 → 追加新版本（author: ai，基线=最新）→ 回 pending → 只提交候选目录。
   */
  private async rebase(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    this.ensureNoAuditRunning();
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
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
      await vcs.revertBusinessWorkspace().catch(() => undefined);
      if (!report.allPassed) {
        return { status: 'ABORTED', message: `门禁未通过，Rebase 未产生新版本：\n${report.formattedEvidenceMarkdown}`, jobId };
      }
      const updated = await store.appendRevision(id, {
        author: 'ai', baseRevision: base, patchText: await (await import('node:fs/promises')).readFile(patchPath, 'utf8'),
      }, guard);
      const commit = await this.commitReviewOnly(`review(${id}): rebase to ${base.slice(0, 12)} (rev ${String(updated.meta.currentRevision)})`, updated, runtime);
      if (!commit.success) return { status: 'ABORTED', message: `提交失败：${commit.message}`, jobId };
      return { status: 'COMMITTED', newRevision: updated.meta.currentRevision, commitRevision: commit.commitRevision, message: `已 Rebase 到基线 ${base.slice(0, 12)}，新版本 ${String(updated.meta.currentRevision)}`, jobId };
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
    this.ensureNoAuditRunning();
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const patchText = stringField(body, 'patchText');
    if (!patchText.trim()) throw new ApiError(400, 'bad_request', 'patchText 不能为空');
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
        const applied = await vcs.applyPatch(tmpPath, true);
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
        const updated = await store.appendRevision(id, { author: 'human', baseRevision: base, patchText }, guard);
        const commit = await this.commitReviewOnly(`review(${id}): manual tweak (rev ${String(updated.meta.currentRevision)})`, updated, runtime);
        if (!commit.success) return { status: 'ABORTED', message: `提交失败：${commit.message}`, jobId };
        return { status: 'COMMITTED', newRevision: updated.meta.currentRevision, commitRevision: commit.commitRevision, message: `人工微调完成，新版本 ${String(updated.meta.currentRevision)}`, jobId };
      } finally {
        await rmTmp(tmpPath, { force: true }).catch(() => undefined);
      }
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /**
   * §4.7/§18.8：commit_revision 回填的幂等恢复入口——只改 approval.commit_revision，
   * 不改 updated_at、不动业务代码；可安全重试直至成功。
   */
  private async backfill(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const commitRevision = stringField(body, 'commitRevision');
    if (!commitRevision.trim()) throw new ApiError(400, 'bad_request', 'commitRevision 不能为空');
    const detail = await store.get(id, null);
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', detail.candidate.parseError);
    if (detail.candidate.meta.status !== 'approved' || !detail.candidate.meta.approval) {
      throw new ApiError(409, 'conflict', '只有 approved 候选可以回填 commit_revision');
    }
    if (detail.candidate.meta.approval.commitRevision === commitRevision) {
      sendJson(res, 200, { candidate: detail.candidate, message: '已是最新，无需回填' });
      return;
    }
    const candidate = detail.candidate;
    const approval = candidate.meta.approval;
    if (!approval) throw new ApiError(409, 'conflict', 'approval 缺失，无法回填');
    approval.commitRevision = commitRevision;
    await store.write(candidate, { touchUpdatedAt: false });
    const commit = await this.commitReviewOnly(`review(${id}): record commit_revision ${commitRevision}`, candidate, runtime);
    if (!commit.success) throw new ApiError(500, 'internal', `回填提交失败：${commit.message}`);
    sendJson(res, 200, { candidate, commitRevision: commit.commitRevision });
  }

  /**
   * §6.2 B/Deferred 转候选：把一个已存在的候选与审查项绑定。
   * Deferred 必须先确认 depends_on 满足（前置 finding resolved，或其 converted 候选 approved）；
   * 审查档案与候选目录两侧必须在同一个共享提交中完成，失败恢复档案文件。
   */
  private async convert(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store, vcs } = runtime;
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const findingId = stringField(body, 'findingId');
    const candidateId = stringField(body, 'candidateId');
    const archive = new AuditArchive(runtime.root);
    const record = await archive.read(auditId);
    if (record.parseError) throw new ApiError(422, 'bad_request', `审查档案无效：${record.parseError}`);
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new ApiError(404, 'not_found', `finding 不存在：${findingId}`);
    if (item.status !== 'pending') {
      throw new ApiError(409, 'conflict', `审查项状态为 ${item.status}，只有 pending 可转换`);
    }
    if (item.kind === 'deferred') {
      const records = await archive.list();
      const queue = await store.list({}, null);
      const statusById = new Map(queue.items.map((entry) => [entry.id, entry.status]));
      const projections = projectFindings(records, (id) => statusById.get(id) ?? null);
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
    const detail = await store.get(candidateId, null);
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', `候选数据无效：${detail.candidate.parseError}`);
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', `候选 ${candidateId} 已归档，不能作为转换目标`);
    }
    // 两侧同一提交：先备份档案，更新 item，再连同候选目录一起原子提交；失败恢复档案。
    const { readFile, writeFile } = await import('node:fs/promises');
    const auditBackup = await readFile(record.reviewPath, 'utf8');
    await archive.updateItem(auditId, findingId, 'converted', candidateId);
    const commit = await vcs.atomicCommit({
      message: `audit(${auditId}): convert ${findingId} -> ${candidateId}`,
      paths: [`.ai-review/audits/${auditId}`, `.ai-review/${candidateId}`],
    });
    if (!commit.success) {
      await writeFile(record.reviewPath, auditBackup, 'utf8');
      throw new ApiError(500, 'internal', `转换提交失败，已恢复审查档案：${commit.errorOutput}`);
    }
    const updated = await archive.read(auditId);
    sendJson(res, 200, { audit: updated.meta, candidateId, commitRevision: commit.commitRevision });
  }

  private async reopen(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const from = stringField(body, 'from');
    const reason = stringField(body, 'reason');
    const candidate = await store.reopen(id, from, reason, guard);
    const commit = await this.commitReviewOnly(`review(${id}): 人工重开（来自 ${from}）`, candidate, runtime);
    sendJson(res, 200, { candidate, commit });
  }

  private async approve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    this.ensureNoAuditRunning();
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    // §4.7：人工判断项的确认/知悉记录随批准提交。
    const confirmed = Array.isArray(body['confirmedDecisions'])
      ? body['confirmedDecisions'].map((item) => String(item)).filter(Boolean)
      : [];
    const waivedRaw = Array.isArray(body['waivedDecisions']) ? body['waivedDecisions'] : [];
    const waived = waivedRaw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ id: String(item['id'] ?? ''), reason: String(item['reason'] ?? '') }))
      .filter((item) => item.id);
    for (const item of waived) {
      if (!item.reason.trim()) throw new ApiError(400, 'bad_request', `知悉项 ${item.id} 必须填写理由`);
    }
    await store.get(id, null);
    // §7.4：窗口内与被拒候选完全重复的候选被阻止批准；人工重开（/reopen）可豁免。
    {
      const reviewersCfg = await loadReviewers(store.repoRoot);
      if (reviewersCfg.rejectionMemoryDays > 0) {
        const queue = await store.list({}, null, null, reviewersCfg.rejectionMemoryDays);
        const duplicate = queue.items.find((item) => item.id === id);
        if (duplicate?.duplicateOf) {
          throw new ApiError(409, 'conflict', `该候选与窗口内的被拒候选完全重复（${duplicate.duplicateOf}），不能批准；如确为误判请先人工重开（POST /reopen）`);
        }
      }
    }
    const job = this.jobs.start('approve', async (log, jobId) => {
      const orchestrator = new ApprovalOrchestrator({
        store,
        vcs,
        settings: this.settings,
        makeRunner: (request) => new Runner(request),
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      });
      const outcome = await this.withWriteLock(store.repoRoot, () => orchestrator.approve(id, guard, jobId, log, { confirmed, waived }));
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
    this.ensureNoAuditRunning();
    const { store, vcs } = runtime;
    const detail = await store.get(id, null);
    if (detail.candidate.meta.currentRevision !== guard.expectedRevision || detail.candidate.meta.owner !== guard.expectedOwner) {
      throw new ApiError(409, 'stale', '候选已被更新，请重新加载');
    }
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '已归档的候选不能再触发 AI 修复');
    }
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', clean.message);
    return this.jobs.start('ai_fix', async (log) => {
      const comments = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
      const patch = await store.currentPatch(detail.candidate);
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
      });
      let result;
      try {
        result = await runner.run();
      } finally {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
      }
      if (result.manual) return { manual: true, prompt: result.prompt ?? '' };
      if (!result.success) throw new Error(result.errorMessage ?? 'AI 修复失败');
      const latest = await store.get(id, null);
      const commit = await vcs.atomicCommit({
        message: `review(${id}): AI 修复生成版本 ${String(result.newRevisionId ?? latest.candidate.meta.currentRevision)}`,
        paths: [relative(store.repoRoot, latest.candidate.dirPath)],
      });
      if (!commit.success) throw new Error(`AI 已生成新版本，但提交 .ai-review 失败：${commit.errorOutput}`);
      return { manual: false, result, commitRevision: commit.commitRevision };
    });
  }

  private async sync(res: ServerResponse, url: URL): Promise<void> {
    const { vcs } = await this.runtimeFor(url);
    this.ensureNoAuditRunning();
    const result = await vcs.syncAndGetLatestBase();
    sendJson(res, 200, result);
  }

  private ensureNoAuditRunning(): void {
    const running = this.jobs.list().find((job) => job.type === 'audit' && job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', '仓库审查正在运行，请等待完成后再执行该操作。');
    }
  }

  private jobsList(res: ServerResponse): void {
    sendJson(res, 200, { jobs: this.jobs.list() });
  }

  private jobGet(res: ServerResponse, jobId: string, url: URL): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'not_found', '任务不存在');
    const since = Number(url.searchParams.get('since') ?? '0');
    sendJson(res, 200, {
      ...job,
      log: job.log.slice(Number.isFinite(since) ? Math.max(0, since) : 0),
      logOffset: Number.isFinite(since) ? Math.max(0, since) : 0,
      totalLogLines: job.log.length,
    });
  }
}

