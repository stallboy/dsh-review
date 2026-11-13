import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers } from './reviewers.js';
import { Runner } from './runner.js';
import { AuditArchive, projectFindings } from './audit-archive.js';
import { matchesReviewFilter } from './store.js';
import type { ReviewStatus } from './types.js';
import { ApiError } from './types.js';
import type { ApprovalCommitLookup } from './types.js';
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

/** 本模块持有的缓存（原 ReviewApi 私有字段），迁移后由同一个实例共享。 */
interface ReadModelState {
  /** §5.5：派生定位内存缓存（repoRoot|candidateId|VCS 快照 → 结果）；不持久化。 */
  approvalLookupCache: Map<string, ApprovalCommitLookup>;
  /** §4.8/G41：投影内存缓存（键 repoRoot|VCS 快照）；不持久化、不跨快照复用。 */
  projectionCache: Map<string, { findings: ReturnType<typeof projectFindings>['findings']; errors: string[]; snapshot: string }>;
}

const state: ReadModelState = {
  approvalLookupCache: new Map(),
  projectionCache: new Map(),
};

/** 属主类：只持有 ApiHost，不再反向 import api.ts。 */
export class ReadModels {
  constructor(private readonly host: ApiHost) {}

  async queue(res: ServerResponse, url: URL): Promise<void> {
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

  async candidate(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store, vcs } = runtime;
    const me = await this.host.ownerFor(store.repoRoot);
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
    // §8.2（2026-11-10 澄清）：isBaseBehind 指“业务代码基线是否变化”，不是比较顶层 VCS
    // 版本号——否则每次评论/状态变更推进 HEAD 都会让候选错误显示为“基线落后”。
    const currentRevisionEntry = detail.candidate.meta.revisions.find(
      (revision) => revision.id === detail.candidate.meta.currentRevision,
    );
    let isBaseBehind = detail.isBaseBehind;
    if (!detail.candidate.parseError
      && currentRevisionEntry
      && detail.currentBase !== null
      && currentRevisionEntry.baseRevision !== detail.currentBase) {
      const business = await this.businessBaselineState(runtime.vcs, currentRevisionEntry.baseRevision, detail.currentBase);
      // 只有能证明业务代码确有变化才算落后；无法证明时保守地沿用“落后”（提示人工确认）。
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

  async patch(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const id = idFrom(url);
    const name = url.searchParams.get('name') ?? '';
    if (!name) throw new ApiError(400, 'bad_request', '缺少补丁文件名');
    const text = await runtime.store.readPatch(id, name, await sharedSourceFor(runtime));
    sendJson(res, 200, { name, text });
  }

  async diff(res: ServerResponse, url: URL): Promise<void> {
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

  async reviewers(res: ServerResponse, url: URL): Promise<void> {
    const { store } = await this.host.runtimeFor(url);
    const config = await loadReviewers(store.repoRoot);
    sendJson(res, 200, { config });
  }

  /** §3：目录式审查档案列表（旧扁平报告不参与；§7.1 只列共享快照中的档案）。 */
  async auditsList(res: ServerResponse, url: URL): Promise<void> {
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

  /** §4.8：finding 投影（共享候选事实 + 重开链判定），供 /findings、/convert、/dismiss-finding 复用。 */
  async findingProjection(runtime: Runtime): Promise<{
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
      const cached = state.projectionCache.get(cacheKey);
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
      state.projectionCache.set(cacheKey, { findings: projected.findings, errors, snapshot });
      if (state.projectionCache.size > 32) {
        const first = state.projectionCache.keys().next().value;
        if (first !== undefined) state.projectionCache.delete(first);
      }
    }
    return { records, findings: projected.findings, errors };
  }

  /** §3.4：finding 投影（覆盖判定 → 最新观察 → 当前状态 → 可见性）。 */
  async findings(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { findings, errors } = await this.findingProjection(runtime);
    sendJson(res, 200, { findings, errors });
  }

  async fixPrompt(res: ServerResponse, url: URL): Promise<void> {
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
    sendJson(res, 200, { prompt: result.prompt ?? result.errorMessage ?? '', comments });
  }

  /**
   * §7.7/§8.2：判定“有效业务基线”是否变化（排除 `.ai-review/` 评审元数据）。
   *
   * - `same`：两个版本号相同；
   * - `unchanged`：版本号不同，但业务代码零变化（只有 .ai-review/ 提交）——**等同于基线未变**；
   * - `changed`：业务代码确有变化（附带变化路径）；
   * - `unknown`：无法证明（浅克隆/非法版本/日志不可读），调用方必须按“无法确定”处理。
   */
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
    const changes = await vcs.businessChangesBetween(from, to).catch(() => null);
    if (changes === null) return { state: 'unknown', detail: `无法比较 ${from.slice(0, 12)} 与 ${to.slice(0, 12)} 的业务变更` };
    return changes.length === 0 ? { state: 'unchanged' } : { state: 'changed', paths: changes };
  }
}
