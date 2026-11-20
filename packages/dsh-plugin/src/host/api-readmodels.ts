import type { ApiResponse } from './api-context.js';
import path from 'node:path';
import { isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers } from './reviewers.js';
import { Runner, loadSystemPrompt, toSessionFixPrompt } from './runner.js';
import { AuditArchive, projectFindings } from './audit-archive.js';
import { matchesReviewFilter } from './store.js';
import type { ReviewStatus, ApprovalCommitLookup, PatchCheckDiagnostic } from './types.js';
import { ApiError } from './types.js';
import type { VcsAdapter } from './vcs.js';
import {
  filterFrom,
  idFrom,
  sendJson,
  sharedSourceFor,
  sharedViewFor,
  type ApiHost,
  type Runtime,
} from './api-context.js';

interface ReadModelState {
  approvalLookupCache: Map<string, ApprovalCommitLookup>;
  projectionCache: Map<string, { findings: ReturnType<typeof projectFindings>['findings']; errors: string[]; snapshot: string }>;
  patchCheckCache: Map<string, PatchCheckDiagnostic>;
  patchCheckPending: Set<string>;
  /** 两个不可变提交间可证明的结果可长期缓存。无法确定时跳过缓存，避免固化瞬时失败。 */
  baselineCache: Map<string, { state: 'unchanged' } | { state: 'changed'; paths: string[] }>;
}

const state: ReadModelState = {
  approvalLookupCache: new Map(),
  projectionCache: new Map(),
  patchCheckCache: new Map(),
  patchCheckPending: new Set(),
  baselineCache: new Map(),
};

export class ReadModels {
  constructor(private readonly host: ApiHost) {}

  private patchCheckKey(runtime: Runtime, id: string, revision: number, base: string): string {
    return `${runtime.root}|${id}|${String(revision)}|${base}`;
  }

  private async computePatchCheck(
    runtime: Runtime,
    id: string,
    revision: number,
    base: string,
    sharedText?: string,
  ): Promise<PatchCheckDiagnostic> {
    const checkedAt = new Date().toISOString();
    const unknown = (): PatchCheckDiagnostic => ({ state: 'unknown', checkedBase: base, checkedAt });
    const currentBase = await runtime.vcs.getCurrentBase().catch(() => null);
    if (currentBase !== base) return unknown();
    let text = sharedText;
    if (text === undefined) {
      const source = await sharedSourceFor(runtime);
      if (!source) return unknown();
      const { month, slug } = runtime.store.resolveCandidateDir(id);
      const detail = await runtime.store.get(id, null, source).catch(() => null);
      const revisionEntry = detail?.candidate.meta.revisions.find((entry) => entry.id === revision);
      if (!revisionEntry || detail?.candidate.meta.currentRevision !== revision) return unknown();
      text = (await source.readPatchText(month, slug, revisionEntry.patch)) ?? undefined;
    }
    if (text === undefined) return unknown();
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dcr-patch-check-'));
    try {
      const patchPath = path.join(dir, 'change.patch');
      await writeFile(patchPath, text, 'utf8');
      const checked = await runtime.vcs.checkPatch(patchPath).catch(() => null);
      return {
        state: checked === null ? 'unknown' : checked.ok ? 'clean' : checked.conflict ? 'conflicted' : 'unknown',
        checkedBase: base,
        checkedAt,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private storePatchCheck(key: string, value: PatchCheckDiagnostic): void {
    state.patchCheckCache.set(key, value);
    if (state.patchCheckCache.size > 256) {
      const first = state.patchCheckCache.keys().next().value;
      if (first !== undefined) state.patchCheckCache.delete(first);
    }
  }

  private schedulePatchCheck(runtime: Runtime, id: string, revision: number, base: string): void {
    const key = this.patchCheckKey(runtime, id, revision, base);
    if (state.patchCheckCache.has(key) || state.patchCheckPending.has(key)) return;
    state.patchCheckPending.add(key);
    setImmediate(() => {
      void this.computePatchCheck(runtime, id, revision, base)
        .then((result) => this.storePatchCheck(key, result))
        .catch(() => undefined)
        .finally(() => state.patchCheckPending.delete(key));
    });
  }

  async queue(res: ApiResponse, url: URL): Promise<void> {
    let runtime: Runtime;
    try {
      runtime = await this.host.runtimeFor(url);
    } catch (error) {
      sendJson(res, 200, {
        configured: false,
        items: [],
        errors: [error instanceof Error ? error.message : String(error)],
        currentBase: null,
        counts: { pending: 0, changes_requested: 0, approved: 0, rejected: 0 },
        owner: this.host.currentSettings().owner,
        me: this.host.currentSettings().owner,
        repoRoot: this.host.currentSettings().repoRoot,
      });
      return;
    }
    const ownerParam = url.searchParams.get('owner');
    const owner = ownerParam !== null ? ownerParam.trim() : await this.host.ownerFor(runtime.root);
    const filter = filterFrom(url, owner);
    const view = await sharedViewFor(runtime);
    const base = view?.snapshot ?? await runtime.vcs.getCurrentBase().catch(() => null);
    const reviewers = await loadReviewers(runtime.root, view?.source);
    // 同一次扫描可同时生成分页结果和 Owner 范围内的状态计数，避免重复枚举仓库。
    const all = await runtime.store.list({ owner }, base, reviewers.staleDays, reviewers.rejectionMemoryDays, view?.source);
    for (const item of all.items) {
      if (item.local || item.parseError || item.status === 'approved' || item.status === 'rejected' || !base || !item.baseRevision) continue;
      const business = await this.businessBaselineState(runtime.vcs, item.baseRevision, base);
      item.isBaseBehind = business.state === 'changed' || business.state === 'unknown';
    }
    const items = all.items.filter((item) => matchesReviewFilter(item, filter));
    for (const item of items) {
      if (item.local || item.parseError || item.status === 'approved' || item.status === 'rejected' || !base) continue;
      const key = this.patchCheckKey(runtime, item.id, item.currentRevision, base);
      const cached = state.patchCheckCache.get(key);
      if (cached) item.patchCheck = cached;
      else this.schedulePatchCheck(runtime, item.id, item.currentRevision, base);
    }
    const counts: Record<ReviewStatus, number> = { pending: 0, changes_requested: 0, approved: 0, rejected: 0 };
    for (const item of all.items) {
      if (!item.local) counts[item.status] += 1;
    }
    // 定位结果仅作诊断，无法定位业务提交仍保留队列项。
    for (const item of items) {
      if (item.status === 'approved' && !item.parseError) {
        const derived = await this.deriveApprovalInfo(runtime, item.id).catch(() => undefined);
        if (derived) Object.assign(item, derived);
      }
    }
    // 租约是宿主运行态，单独提供给面板的收尾和释放入口。
    let auditLease:
      | {
        auditId: string;
        state: 'active' | 'releasable';
        trigger: 'manual' | 'scheduled';
        createdAt: string;
        owner: string;
        baseRevision: string;
        targetPath: string;
        sessionId?: string;
        commitOutcomeUnknown?: true;
      }
      | undefined;
    try {
      const lease = this.host.auditLifecycle.blockingLeaseFor(runtime.root);
      if (lease) {
        auditLease = {
          auditId: lease.auditId,
          state: lease.state,
          trigger: lease.trigger,
          createdAt: lease.createdAt,
          owner: lease.owner,
          baseRevision: lease.baseRevision,
          targetPath: lease.targetPath,
          ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
          ...(lease.commitOutcomeUnknown ? { commitOutcomeUnknown: true as const } : {}),
        };
      }
    } catch {
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
      ...(auditLease ? { auditLease } : {}),
    });
  }

  async candidate(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store, vcs } = runtime;
    const me = await this.host.ownerFor(store.repoRoot);
    const id = idFrom(url);
    const view = await sharedViewFor(runtime);
    const currentBase = view?.snapshot ?? await vcs.getCurrentBase().catch(() => null);
    const detail = await store.get(id, currentBase, view?.source);
    const validation = await store.validateFullCandidate(detail.candidate, view?.source);
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
    // 补丁预检只对 checkedBase 有效，批准时仍须重新严格应用。
    let patchCheck: PatchCheckDiagnostic | undefined;
    if (!detail.candidate.parseError && detail.candidate.meta.status !== 'approved' && detail.candidate.meta.status !== 'rejected' && currentBase) {
      const revision = detail.candidate.meta.currentRevision;
      const key = this.patchCheckKey(runtime, id, revision, currentBase);
      const cached = state.patchCheckCache.get(key);
      if (cached) patchCheck = cached;
      else {
        patchCheck = await this.computePatchCheck(runtime, id, revision, currentBase, detail.patchText);
        this.storePatchCheck(key, patchCheck);
      }
    }
    const comments = [...detail.candidate.meta.comments].sort((left, right) => {
      const byRevision = left.revision - right.revision;
      return byRevision !== 0 ? byRevision : left.id.localeCompare(right.id);
    });
    let approvalCommitRevision: string | undefined;
    let approvalCommitLookup: 'found' | 'ambiguous' | 'unknown' | undefined;
    if (detail.candidate.meta.status === 'approved' && !detail.candidate.parseError) {
      const derived = await this.deriveApprovalInfo(runtime, id).catch(() => undefined);
      if (derived) {
        approvalCommitRevision = derived.approvalCommitRevision;
        approvalCommitLookup = derived.approvalCommitLookup;
      }
    }
    // 评论或状态变更也会推进 HEAD，须排除评审元数据变化以免误报基线落后。
    const currentRevisionEntry = detail.candidate.meta.revisions.find(
      (revision) => revision.id === detail.candidate.meta.currentRevision,
    );
    let isBaseBehind = detail.isBaseBehind;
    if (!detail.candidate.parseError
      && currentRevisionEntry
      && detail.currentBase !== null
      && currentRevisionEntry.baseRevision !== detail.currentBase) {
      const business = await this.businessBaselineState(runtime.vcs, currentRevisionEntry.baseRevision, detail.currentBase);
      // 无法证明业务基线时保留落后提示，供人工确认。
      if (business.state === 'unchanged' || business.state === 'same') isBaseBehind = false;
    }
    sendJson(res, 200, {
      candidate: detail.candidate,
      currentBase: detail.currentBase,
      isBaseBehind,
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
      jobs: this.host.jobManager.list().slice(0, 5),
    });
  }

  /** 派生结果只缓存于内存，供列表和详情共享，避免回写评审档案。 */
  private async deriveApprovalInfo(
    runtime: Runtime,
    id: string,
  ): Promise<{ approvalCommitRevision?: string; approvalCommitLookup: 'found' | 'ambiguous' | 'unknown' }> {
    const view = await sharedViewFor(runtime);
    const cacheKey = view?.snapshot ? `${runtime.root}|${id}|${view.snapshot}` : null;
    const cached = cacheKey ? state.approvalLookupCache.get(cacheKey) : undefined;
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
      state.approvalLookupCache.set(cacheKey, result);
      if (state.approvalLookupCache.size > 256) {
        const first = state.approvalLookupCache.keys().next().value;
        if (first !== undefined) state.approvalLookupCache.delete(first);
      }
    }
    return result.lookup === 'found' && result.revision
      ? { approvalCommitRevision: result.revision, approvalCommitLookup: 'found' }
      : { approvalCommitLookup: result.lookup };
  }

  async patch(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const id = idFrom(url);
    const name = url.searchParams.get('name') ?? '';
    if (!name) throw new ApiError(400, 'bad_request', '缺少补丁文件名');
    const text = await runtime.store.readPatch(id, name, await sharedSourceFor(runtime));
    sendJson(res, 200, { name, text });
  }

  async diff(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
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

  async reviewers(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const config = await loadReviewers(runtime.root, await sharedSourceFor(runtime));
    sendJson(res, 200, { config });
  }

  async auditsList(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
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

  /** 转换与忽略操作也要使用这份投影，免得以被后来观察覆盖的档案作判断。 */
  async findingProjection(runtime: Runtime): Promise<{
    records: Awaited<ReturnType<AuditArchive['list']>>;
    findings: ReturnType<typeof projectFindings>['findings'];
    errors: string[];
  }> {
    const view = await sharedViewFor(runtime);
    const snapshot = view?.snapshot ?? null;
    const archive = new AuditArchive(runtime.root);
    if (snapshot) {
      const cacheKey = `${runtime.root}|${snapshot}`;
      const cached = state.projectionCache.get(cacheKey);
      if (cached) {
        return { records: await archive.list(view?.source), findings: cached.findings, errors: cached.errors };
      }
    }
    const records = await archive.list(view?.source);
    const queue = await runtime.store.list({}, null, undefined, undefined, view?.source);
    const sharedItems = queue.items.filter((item) => !item.local);
    const infoById = new Map(sharedItems.map((item) => [item.id, {
      status: item.status,
      reopenedFrom: item.reopenedFrom ?? null,
      broken: item.parseError !== undefined,
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
      state.projectionCache.set(cacheKey, { findings: projected.findings, errors, snapshot });
      if (state.projectionCache.size > 32) {
        const first = state.projectionCache.keys().next().value;
        if (first !== undefined) state.projectionCache.delete(first);
      }
    }
    return { records, findings: projected.findings, errors };
  }

  async findings(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { findings, errors } = await this.findingProjection(runtime);
    sendJson(res, 200, { findings, errors });
  }

  async fixPrompt(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const id = idFrom(url);
    const detail = await runtime.store.get(id, null, await sharedSourceFor(runtime));
    const comments = detail.candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
    const runner = new Runner({
      kind: 'manual',
      settings: this.host.currentSettings(),
      store: runtime.store,
      candidate: detail.candidate,
      mode: 'ADDRESS_FEEDBACK',
      comments,
      log: () => undefined,
    });
    const result = await runner.run();
    const mode = url.searchParams.get('mode') === 'session' ? 'session' : 'headless';
    const rawPrompt = result.prompt ?? result.errorMessage ?? '';
    const prompt = mode === 'session' && rawPrompt ? toSessionFixPrompt(rawPrompt, await loadSystemPrompt()) : rawPrompt;
    sendJson(res, 200, { prompt, comments, mode, title: detail.candidate.meta.title, revision: detail.candidate.meta.currentRevision });
  }

  /** 排除评审元数据后，版本不同仍可能是同一业务基线。若历史不足以证明差异，调用方须保留未知状态。 */
  async businessBaselineState(
    vcs: VcsAdapter,
    fromRevision: string,
    toRevision: string,
  ): Promise<
    | { state: 'same' }
    | { state: 'unchanged' }
    | { state: 'changed'; paths: string[] }
    | { state: 'unknown'; detail: string }
  > {
    const from = fromRevision.trim();
    const to = toRevision.trim();
    if (!from || !to) return { state: 'unknown', detail: '候选基线或当前基线为空' };
    if (from === to) return { state: 'same' };
    const cacheKey = `${vcs.root}|${from}|${to}`;
    const cached = state.baselineCache.get(cacheKey);
    if (cached) return cached;
    const changes = await vcs.businessChangesBetween(from, to).catch(() => null);
    if (changes === null) return { state: 'unknown', detail: `无法比较 ${from.slice(0, 12)} 与 ${to.slice(0, 12)} 的业务变更` };
    const result = changes.length === 0 ? { state: 'unchanged' as const } : { state: 'changed' as const, paths: changes };
    state.baselineCache.set(cacheKey, result);
    if (state.baselineCache.size > 256) {
      const first = state.baselineCache.keys().next().value;
      if (first !== undefined) state.baselineCache.delete(first);
    }
    return result;
  }
}
