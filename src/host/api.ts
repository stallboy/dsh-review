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
import { ReviewStore } from './store.js';
import { detectVcs, suggestOwner, validateSettings } from './settings.js';
import type {
  AppSettings,
  ConcurrencyGuard,
  HealthInfo,
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
    if (method === 'POST' && route === '/audit') return this.audit(req, res, url);
    if (method === 'POST' && route === '/comments') return this.addComment(req, res, url);
    if (method === 'POST' && route === '/comment-status') return this.commentStatus(req, res, url);
    if (method === 'POST' && route === '/takeover') return this.takeover(req, res, url);
    if (method === 'POST' && route === '/reject') return this.reject(req, res, url);
    if (method === 'POST' && route === '/approve') return this.approve(req, res, url);
    if (method === 'POST' && route === '/ai-fix') return this.aiFix(req, res, url);
    if (method === 'POST' && route === '/sync') return this.sync(res, url);
    if (method === 'GET' && route === '/jobs') return this.jobsList(res);
    if (method === 'GET' && route.startsWith('/jobs/')) return this.jobGet(res, route.slice('/jobs/'.length), url);
    if (method === 'GET' && route === '/reviewers') return this.reviewers(res, url);
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
    };
    const saved = await this.deps.saveSettings(merged);
    await this.reconfigure(saved);
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
    const { items, errors } = await runtime.store.list(filter, base);
    const all = await runtime.store.list({ owner }, base);
    const counts: Record<ReviewStatus, number> = { pending: 0, changes_requested: 0, approved: 0, rejected: 0 };
    for (const item of all.items) counts[item.status] += 1;
    sendJson(res, 200, {
      configured: true,
      items,
      errors,
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
    const prompt = mode === 'session'
      ? [
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
        ].join('\n')
      : wrapAgentPrompt(systemPrompt, userPrompt);
    sendJson(res, 200, {
      prompt,
      mode,
      targetPath: target.targetPath,
      baseRevision,
      owner,
      reportPath,
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
    }, guard);
    const commit = await this.commitReviewOnly(`review(${id}): 审核意见 (rev ${String(candidate.meta.currentRevision)})`, candidate, runtime);
    sendJson(res, 200, { candidate, commit });
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

  private async reject(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const reason = stringField(body, 'reason');
    const detail = await store.get(id, null);
    await store.ensureWriteAllowed(detail.candidate, guard);
    const reviewBackup = await readFile(detail.candidate.reviewPath, 'utf8');
    const patchBackups: { name: string; text: string }[] = [];
    for (const revision of detail.candidate.meta.revisions) {
      const file = path.join(detail.candidate.dirPath, revision.patch);
      if (existsSync(file)) patchBackups.push({ name: revision.patch, text: await readFile(file, 'utf8') });
    }
    const candidate = await store.reject(id, reason, guard);
    const commit = await vcs.atomicCommit({
      message: `review(${id}): reject rev ${String(candidate.meta.currentRevision)}`,
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

  private async approve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    this.ensureNoAuditRunning();
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await store.get(id, null);
    const job = this.jobs.start('approve', async (log, jobId) => {
      const orchestrator = new ApprovalOrchestrator({
        store,
        vcs,
        settings: this.settings,
        makeRunner: (request) => new Runner(request),
        ...(this.deps.resolveCredential ? { resolveCredential: this.deps.resolveCredential } : {}),
      });
      const outcome = await orchestrator.approve(id, guard, jobId, log);
      log(`结果：${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} — ${outcome.message}`);
      return outcome;
    });
    sendJson(res, 202, { jobId: job.id, job });
  }

  private async aiFix(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { store, vcs } = await this.runtimeFor(url);
    this.ensureNoAuditRunning();
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const detail = await store.get(id, null);
    if (detail.candidate.meta.currentRevision !== guard.expectedRevision || detail.candidate.meta.owner !== guard.expectedOwner) {
      throw new ApiError(409, 'stale', '候选已被更新，请重新加载');
    }
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '已归档的候选不能再触发 AI 修复');
    }
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', clean.message);
    const job = this.jobs.start('ai_fix', async (log) => {
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
    sendJson(res, 202, { jobId: job.id, job });
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

