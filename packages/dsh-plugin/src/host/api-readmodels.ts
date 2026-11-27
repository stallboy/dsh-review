/** 只读接口处理器（SPEC §6.2）：/health /settings /queue /candidate /patch /diff /fix-prompt /reviewers /audits /findings。 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APP_VERSION,
  filterFrom,
  idFrom,
  sendJson,
  sharedViewFor,
  type ApiHost,
  type ApiRequest,
  type ApiResponse,
  type Runtime,
} from './api-context.js';
import { AuditArchive, scopeCovers } from './audit-archive.js';
import { buildFindingView, isPatchBanned, resolveOptionSelection } from './issue-review.js';
import { parsePatch } from './patch.js';
import { buildModeBPrompt, loadProposalSystemPrompt, wrapAgentPrompt } from './runner.js';
import { loadReviewers } from './reviewers.js';
import { validateSettings } from './settings.js';
import type { SharedCandidateSource } from './shared-facts.js';
import { emptyStatusCounts } from './store.js';
import {
  ApiError,
  type ApprovalCommitLookup,
  type FindingDisposition,
  type OptionPatchCheck,
  type ReviewCandidate,
} from './types.js';

/**
 * 内存只读缓存（不落盘）：
 * 1) patchCheck 按 (root, candidateId, recordRevision, optionId, patchId, base) 独立缓存；
 * 2) approvalCommit 按 (root, candidateId, snapshotKey, approvalKey) 独立缓存。
 */
export class ReadModelCaches {
  private readonly patchChecks = new Map<string, OptionPatchCheck>();
  private readonly inflightChecks = new Set<string>();
  private readonly approvalCommits = new Map<string, ApprovalCommitLookup>();

  private patchKey(root: string, id: string, recordRevision: number, optionId: string, patchId: number, base: string): string {
    return `${root}\0${id}\0${String(recordRevision)}\0${optionId}\0${String(patchId)}\0${base}`;
  }

  getPatchCheck(root: string, id: string, recordRevision: number, optionId: string, patchId: number, base: string): OptionPatchCheck | undefined {
    return this.patchChecks.get(this.patchKey(root, id, recordRevision, optionId, patchId, base));
  }

  setPatchCheck(root: string, id: string, recordRevision: number, check: OptionPatchCheck): void {
    const key = this.patchKey(root, id, recordRevision, check.optionId, check.patchId, check.checkedBase);
    if (this.patchChecks.size > 2000) this.patchChecks.clear();
    this.patchChecks.set(key, check);
  }

  /** /queue 未命中缓存时调用：低优先级后台异步预检，绝不阻塞 /queue 响应。 */
  schedulePatchCheck(params: {
    runtime: Runtime;
    candidateId: string;
    recordRevision: number;
    optionId: string;
    patchId: number;
    patchPath: string;
    base: string;
  }): void {
    const key = this.patchKey(params.runtime.root, params.candidateId, params.recordRevision, params.optionId, params.patchId, params.base);
    if (this.patchChecks.has(key) || this.inflightChecks.has(key)) return;
    this.inflightChecks.add(key);
    setImmediate(() => {
      void (async () => {
        try {
          const check = await params.runtime.vcs.checkPatch(params.patchPath);
          this.setPatchCheck(params.runtime.root, params.candidateId, params.recordRevision, {
            optionId: params.optionId,
            patchId: params.patchId,
            state: check.ok ? 'clean' : check.conflict ? 'conflicted' : 'unknown',
            checkedBase: params.base,
            checkedAt: new Date().toISOString(),
          });
        } catch {
          this.setPatchCheck(params.runtime.root, params.candidateId, params.recordRevision, {
            optionId: params.optionId,
            patchId: params.patchId,
            state: 'unknown',
            checkedBase: params.base,
            checkedAt: new Date().toISOString(),
          });
        } finally {
          this.inflightChecks.delete(key);
        }
      })();
    });
  }

  async resolveApprovalCommit(
    runtime: Runtime,
    candidate: ReviewCandidate,
    snapshotKey: string | null,
    source?: SharedCandidateSource,
  ): Promise<ApprovalCommitLookup | undefined> {
    if (candidate.meta.status !== 'approved' || !candidate.meta.approval) return undefined;
    const approval = candidate.meta.approval;
    const cacheKey = [
      runtime.root,
      candidate.id,
      snapshotKey ?? 'live',
      approval.optionId,
      String(approval.patchId),
      String(approval.recordRevision),
      approval.patchSha256,
      String(approval.repairAttemptId),
      approval.baseRevision,
      approval.approvedAt,
      approval.businessCommit ?? '',
    ].join('\0');
    const cached = this.approvalCommits.get(cacheKey);
    if (cached) return cached;

    const patchPaths = candidate.meta.patches.map((p) => `.ai-review/${candidate.id}/${p.patch}`);
    const approvedEntry = candidate.meta.patches.find((p) => p.id === approval.patchId && p.optionId === approval.optionId);
    const approvedPatchText = approvedEntry
      ? await runtime.store.readPatch(candidate.id, approvedEntry.patch, source).catch(() => null)
      : null;
    const approvedPatchPaths = approvedPatchText ? parsePatch(approvedPatchText).paths : undefined;
    const lookup = await runtime.vcs.deriveApprovalCommit({
      reviewPath: `.ai-review/${candidate.id}/review.md`,
      patchPaths,
      targetFiles: candidate.meta.targetFiles,
      ...(approvedPatchPaths && approvedPatchPaths.length > 0 ? { approvedPatchPaths } : {}),
      approval,
    }).catch((error: unknown): ApprovalCommitLookup => ({
      revision: null,
      lookup: 'unknown',
      diagnostic: error instanceof Error ? error.message : String(error),
    }));
    if (this.approvalCommits.size > 1000) this.approvalCommits.clear();
    this.approvalCommits.set(cacheKey, lookup);
    return lookup;
  }
}

async function businessBehindChecker(runtime: Runtime): Promise<(fromBase: string, currentBase: string) => Promise<boolean>> {
  const memo = new Map<string, boolean>();
  return async (fromBase: string, currentBase: string): Promise<boolean> => {
    if (fromBase === currentBase) return false;
    const key = `${fromBase}..${currentBase}`;
    if (memo.has(key)) return memo.get(key)!;
    const changed = await runtime.vcs.businessChangesBetween(fromBase, currentBase).catch(() => null);
    // SPEC §5.7：历史不可读/浅克隆返回 null 时保守判 isBaseBehind = true。
    const behind = changed === null ? true : changed.length > 0;
    memo.set(key, behind);
    return behind;
  };
}

export async function handleHealth(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const settings = host.currentSettings();
  try {
    const runtime = await host.runtimeFor(url);
    const view = await sharedViewFor(runtime);
    const currentBase = await runtime.vcs.getCurrentBase();
    const owner = await host.ownerFor(runtime.root);
    const counts = await runtime.store.listStatusCounts(undefined, view?.source);
    const reviewers = await loadReviewers(runtime.root, view?.source).catch(() => null);
    const lease = host.auditLifecycle.blockingLeaseFor(runtime.root);
    const recoveryBlocker = host.recoveryStore.blockerFor(runtime.root);
    const diagnostics = [
      ...host.lastConfigErrors,
      ...(reviewers && !reviewers.valid ? reviewers.errors : []),
      ...(lease ? [`审查租约阻塞中：${lease.auditId}（${lease.state}）`] : []),
      ...(recoveryBlocker ? [`仓库待恢复阻塞（${recoveryBlocker.reason}）：${recoveryBlocker.detail}`] : []),
    ];
    sendJson(res, 200, {
      app: 'dsh-code-review',
      version: APP_VERSION,
      configured: true,
      repoRoot: runtime.root,
      owner,
      vcsType: runtime.vcsType,
      currentBase,
      diagnostics,
      counts,
      ...(recoveryBlocker ? { recoveryBlocker } : {}),
    });
  } catch {
    sendJson(res, 200, {
      app: 'dsh-code-review',
      version: APP_VERSION,
      configured: false,
      repoRoot: settings.repoRoot,
      owner: settings.owner,
      vcsType: host.detectedVcsType,
      currentBase: null,
      diagnostics: [...host.lastConfigErrors],
      counts: emptyStatusCounts(),
    });
  }
}

export async function handleGetSettings(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const settings = host.currentSettings();
  const validation = await validateSettings(settings);
  let suggestedOwner = settings.owner;
  if (!suggestedOwner && settings.repoRoot) {
    try {
      const runtime = await host.runtimeFor(url);
      suggestedOwner = await host.ownerFor(runtime.root);
    } catch {
    }
  }
  sendJson(res, 200, {
    settings,
    validation,
    suggestedOwner,
    runners: [
      { value: 'dsh', label: 'DSH Headless（默认）' },
      { value: 'external', label: '外部命令行执行器' },
      { value: 'manual', label: '手动提示词模式' },
    ],
  });
}

export async function handleQueue(
  host: ApiHost,
  _req: ApiRequest,
  res: ApiResponse,
  url: URL,
  caches: ReadModelCaches,
): Promise<void> {
  const settings = host.currentSettings();
  let runtime: Runtime;
  try {
    runtime = await host.runtimeFor(url);
  } catch (error) {
    if (error instanceof ApiError && error.status !== 412) throw error;
    sendJson(res, 200, {
      configured: false,
      items: [],
      errors: [...host.lastConfigErrors],
      currentBase: null,
      counts: emptyStatusCounts(),
      owner: settings.owner,
      me: settings.owner,
      repoRoot: settings.repoRoot,
    });
    return;
  }

  const me = await host.ownerFor(runtime.root);
  const ownerParam = url.searchParams.has('owner') ? (url.searchParams.get('owner') ?? '') : me;
  const filter = filterFrom(url, ownerParam);
  const view = await sharedViewFor(runtime);
  const currentBase = await runtime.vcs.getCurrentBase();
  const isBehind = await businessBehindChecker(runtime);

  const { items, errors, counts } = await runtime.store.list(
    filter,
    currentBase,
    isBehind,
    Date.now(),
    view?.source,
    view?.source,
  );

  // 填充 approved 派生提交与分方案 patchCheck 缓存（/queue 仅读缓存并异步调度未命中项，绝不同步阻塞！）
  for (const item of items) {
    if (item.local || item.status === 'broken') continue;
    if (item.status === 'approved') {
      const [month, slug] = item.id.split('/');
      if (month && slug) {
        const loaded = await runtime.store.loadCandidate(month, slug, view?.source);
        if (loaded && !loaded.parseError) {
          const derived = await caches.resolveApprovalCommit(runtime, loaded, view?.snapshot ?? null);
          if (derived) {
            if (derived.revision) item.approvalCommitRevision = derived.revision;
            item.approvalCommitLookup = derived.lookup;
          }
        }
      }
    }
    if (currentBase && item.options.length > 0 && ['pending', 'changes_requested', 'repair_failed'].includes(item.status)) {
      for (const opt of item.options) {
        const cached = caches.getPatchCheck(runtime.root, item.id, item.recordRevision, opt.id, opt.currentPatch, currentBase);
        if (cached) {
          opt.patchCheck = cached;
        } else {
          opt.patchCheck = {
            optionId: opt.id,
            patchId: opt.currentPatch,
            state: 'unknown',
            checkedBase: currentBase,
            checkedAt: new Date().toISOString(),
          };
          const [month, slug] = item.id.split('/');
          if (month && slug) {
            const patchFile = `${String(opt.currentPatch).padStart(3, '0')}.patch`;
            caches.schedulePatchCheck({
              runtime,
              candidateId: item.id,
              recordRevision: item.recordRevision,
              optionId: opt.id,
              patchId: opt.currentPatch,
              patchPath: path.join(runtime.store.dirOf(month, slug), patchFile),
              base: currentBase,
            });
          }
        }
      }
      if (item.options[0]?.patchCheck) {
        item.patchCheck = item.options[0].patchCheck;
      }
    }
  }

  const lease = host.auditLifecycle.blockingLeaseFor(runtime.root);
  const fixOccupancy = host.fixSessionGuard.activeFor(runtime.root);

  sendJson(res, 200, {
    configured: true,
    items,
    errors,
    currentBase,
    counts,
    owner: ownerParam,
    me,
    repoRoot: runtime.root,
    ...(lease
      ? {
        auditLease: {
          auditId: lease.auditId,
          state: lease.state,
          trigger: lease.trigger,
          createdAt: lease.createdAt,
          owner: lease.owner,
          baseRevision: lease.baseRevision,
          targetPath: lease.targetPath,
          ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
          ...(lease.commitOutcomeUnknown ? { commitOutcomeUnknown: true } : {}),
        },
      }
      : {}),
    ...(fixOccupancy ? { fixSession: fixOccupancy } : {}),
  });
}

export async function handleCandidate(
  host: ApiHost,
  _req: ApiRequest,
  res: ApiResponse,
  url: URL,
  caches: ReadModelCaches,
): Promise<void> {
  const id = idFrom(url);
  const optionId = url.searchParams.get('optionId')?.trim() || undefined;
  const rawPatchId = url.searchParams.get('patchId')?.trim();
  const patchId = rawPatchId ? Number(rawPatchId) : undefined;
  if (rawPatchId && (!Number.isInteger(patchId) || (patchId ?? 0) <= 0)) {
    throw new ApiError(400, 'bad_request', 'patchId 必须是正整数');
  }

  const runtime = await host.runtimeFor(url);
  const me = await host.ownerFor(runtime.root);
  const view = await sharedViewFor(runtime);
  const currentBase = await runtime.vcs.getCurrentBase();
  const isBehind = await businessBehindChecker(runtime);

  const detail = await runtime.store.get(
    id,
    currentBase,
    view?.source,
    isBehind,
    optionId || patchId !== undefined ? { ...(optionId ? { optionId } : {}), ...(patchId !== undefined ? { patchId } : {}) } : undefined,
  );

  // 未命中 patchCheck 缓存时，/candidate 可同步预检所选补丁并写回缓存（SPEC §6.2）。
  let patchCheck: OptionPatchCheck | undefined;
  if (!detail.candidate.parseError && detail.selection && detail.patchEntry && currentBase) {
    patchCheck = caches.getPatchCheck(
      runtime.root,
      id,
      detail.candidate.meta.recordRevision,
      detail.selection.optionId,
      detail.selection.patchId,
      currentBase,
    );
    if (!patchCheck) {
      let check = null;
      const diskPatchPath = path.join(detail.candidate.dirPath, detail.patchEntry.patch);
      // 仅对共享快照的 patchText 执行预检，避免本地未提交草稿污染共享详情的 patchCheck 口径
      if (detail.patchText) {
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-patch-check-')).catch(() => null);
        if (tmpDir) {
          try {
            const tmpPatch = path.join(tmpDir, detail.patchEntry.patch);
            await writeFile(tmpPatch, detail.patchText, 'utf8');
            check = await runtime.vcs.checkPatch(tmpPatch).catch(() => null);
          } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
          }
        } else {
          check = await runtime.vcs.checkPatch(diskPatchPath).catch(() => null);
        }
      }
      patchCheck = {
        optionId: detail.selection.optionId,
        patchId: detail.selection.patchId,
        state: check ? (check.ok ? 'clean' : check.conflict ? 'conflicted' : 'unknown') : 'unknown',
        checkedBase: currentBase,
        checkedAt: new Date().toISOString(),
      };
      caches.setPatchCheck(runtime.root, id, detail.candidate.meta.recordRevision, patchCheck);
    }
  }

  const derived = !detail.candidate.parseError
    ? await caches.resolveApprovalCommit(runtime, detail.candidate, view?.snapshot ?? null, view?.source)
    : undefined;

  const canAct = !detail.candidate.parseError && !detail.local && detail.candidate.meta.owner === me;
  const finding = !detail.candidate.parseError ? buildFindingView(detail.candidate) : undefined;
  const selectedPatchBanned = !detail.candidate.parseError && detail.selection
    ? isPatchBanned(detail.candidate.meta, detail.selection.optionId, detail.selection.patchId)
    : false;

  sendJson(res, 200, {
    candidate: detail.candidate,
    ...(detail.selection ? { selection: detail.selection } : {}),
    ...(detail.option ? { selectedOption: detail.option } : {}),
    ...(detail.patchEntry ? { selectedPatch: detail.patchEntry } : {}),
    selectedPatchBanned,
    ...(finding ? { finding } : {}),
    currentBase: detail.currentBase,
    isBaseBehind: detail.isBaseBehind,
    ...(patchCheck ? { patchCheck } : {}),
    ...(derived?.revision ? { approvalCommitRevision: derived.revision } : {}),
    ...(derived ? { approvalCommitLookup: derived.lookup } : {}),
    patchText: detail.patchText,
    patchStats: detail.patchStats,
    patchPaths: detail.patchPaths,
    comments: detail.comments,
    validation: detail.validation,
    revisionStats: detail.revisionStats,
    ...(detail.local ? { local: true } : {}),
    canAct,
    me,
    jobs: host.jobManager.list(),
  });
}

export async function handlePatch(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const id = idFrom(url);
  const name = url.searchParams.get('name')?.trim() ?? '';
  if (!name) throw new ApiError(400, 'bad_request', '缺少补丁文件名 name');
  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const text = await runtime.store.readPatch(id, name, view?.source);
  sendJson(res, 200, { name, text });
}

/** SPEC §6.2：/diff 按 optionId 与 patchId/to/from 比较同方案补丁，严禁用 record_revision 推算补丁号。 */
export async function handleDiff(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const id = idFrom(url);
  const optionId = url.searchParams.get('optionId')?.trim() || undefined;
  const rawPatchId = url.searchParams.get('patchId')?.trim();
  const rawTo = url.searchParams.get('to')?.trim();
  const rawFrom = url.searchParams.get('from')?.trim();

  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const detail = await runtime.store.get(id, null, view?.source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  const meta = detail.candidate.meta;

  const resolved = resolveOptionSelection(meta, optionId ? { optionId } : undefined);
  if (!resolved) {
    sendJson(res, 200, {
      mode: 'full',
      unifiedDiff: '',
      fromRevision: null,
      toRevision: 0,
      fromBase: null,
      toBase: meta.baseRevision,
      resolutionMode: null,
      notes: ['该问题为纯文字方案，无补丁差异。'],
    });
    return;
  }

  const targetOption = resolved.option;
  const toId = rawTo ? Number(rawTo) : rawPatchId ? Number(rawPatchId) : targetOption.currentPatch;
  if (!Number.isInteger(toId) || toId <= 0) throw new ApiError(400, 'bad_request', 'to / patchId 必须是正整数');
  const toEntry = meta.patches.find((p) => p.id === toId && p.optionId === targetOption.id);
  if (!toEntry) throw new ApiError(404, 'not_found', `方案 ${targetOption.id} 不存在补丁 #${String(toId)}`);

  const toText = await runtime.store.readPatch(id, toEntry.patch, view?.source);
  const fromId = rawFrom ? Number(rawFrom) : 0;
  if (rawFrom && (!Number.isInteger(fromId) || fromId < 0)) {
    throw new ApiError(400, 'bad_request', 'from 必须是非负整数');
  }

  if (!fromId || fromId === toId) {
    sendJson(res, 200, {
      mode: 'full',
      optionId: targetOption.id,
      unifiedDiff: toText,
      fromRevision: null,
      toRevision: toId,
      fromBase: null,
      toBase: toEntry.baseRevision,
      resolutionMode: null,
      notes: [],
    });
    return;
  }

  const fromEntry = meta.patches.find((p) => p.id === fromId && p.optionId === targetOption.id);
  if (!fromEntry) {
    throw new ApiError(404, 'not_found', `方案 ${targetOption.id} 不存在对比基线补丁 #${String(fromId)}`);
  }
  const fromText = await runtime.store.readPatch(id, fromEntry.patch, view?.source);
  const diff = await runtime.vcs.computeInterRevisionDiff({
    fromRevision: fromId,
    toRevision: toId,
    fromBase: fromEntry.baseRevision,
    toBase: toEntry.baseRevision,
    fromPatchPath: path.join(detail.candidate.dirPath, fromEntry.patch),
    toPatchPath: path.join(detail.candidate.dirPath, toEntry.patch),
    fromPatchText: fromText,
    toPatchText: toText,
  });
  sendJson(res, 200, {
    mode: 'incremental',
    optionId: targetOption.id,
    ...diff,
  });
}

export async function handleFixPrompt(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const id = idFrom(url);
  const optionId = url.searchParams.get('optionId')?.trim() || '';
  const rawPatchId = url.searchParams.get('patchId')?.trim() || '';
  const patchId = rawPatchId ? Number(rawPatchId) : 0;
  if (!optionId || !Number.isInteger(patchId) || patchId <= 0) {
    throw new ApiError(400, 'bad_request', '导出修订提示词必须显式提供合法的 optionId 与正整数 patchId');
  }
  const mode = url.searchParams.get('mode') === 'session' ? 'session' : 'headless';

  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const base = (await runtime.vcs.getCurrentBase()) ?? '';
  const detail = await runtime.store.get(
    id,
    base || null,
    view?.source,
    undefined,
    { optionId, patchId },
  );
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  if (!detail.option || !detail.patchEntry) {
    throw new ApiError(409, 'conflict', '纯文字问题没有可修订的补丁方案');
  }

  const systemPrompt = await loadProposalSystemPrompt();
  const userPrompt = buildModeBPrompt({
    candidate: detail.candidate,
    option: detail.option,
    patchEntry: detail.patchEntry,
    patchText: detail.patchText,
    targetBase: base || detail.patchEntry.baseRevision,
    vcsType: runtime.vcsType,
    intent: 'revise',
    mode,
  });
  sendJson(res, 200, {
    id,
    optionId: detail.option.id,
    patchId: detail.patchEntry.id,
    mode,
    prompt: wrapAgentPrompt(systemPrompt, userPrompt),
  });
}

export async function handleReviewers(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const config = await loadReviewers(runtime.root, view?.source);
  sendJson(res, 200, {
    config,
    valid: config.valid,
    errors: config.errors,
  });
}

export async function handleAudits(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const archive = new AuditArchive(runtime.root);
  const records = await archive.list(view?.source);
  const errors = records.filter((r) => r.parseError).map((r) => `${r.auditId}: ${r.parseError!}`);
  const audits = records
    .filter((r) => !r.parseError)
    .map((r) => ({
      auditId: r.auditId,
      createdAt: r.meta.createdAt,
      baseRevision: r.meta.baseRevision,
      scope: r.meta.scope,
      trigger: r.meta.trigger,
      previousAudit: r.meta.previousAudit,
      issues: r.meta.issues,
      issueCount: r.meta.issues.length,
    }));
  sendJson(res, 200, { audits, errors });
}

/** SPEC §6.2：GET /findings 直接从同一共享快照的 review.md 派生，返回 id/findingId/recordRevision/owner/updatedAt/issueStatus/issueKind/dependsOn/deferred 等。 */
export async function handleFindings(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const scope = url.searchParams.get('scope')?.trim() || '.';
  const findingIdFilter = url.searchParams.get('findingId')?.trim() || '';
  const dispositionsParam = url.searchParams.get('dispositions')?.trim() || '';
  const wantedDispositions = dispositionsParam
    ? new Set(dispositionsParam.split(',').map((s) => s.trim()).filter(Boolean) as FindingDisposition[])
    : null;

  const runtime = await host.runtimeFor(url);
  const view = await sharedViewFor(runtime);
  const { candidates, errors } = await runtime.store.listSharedCandidates(view?.source);

  const findings = candidates
    .filter((c) => !c.parseError)
    .filter((c) => !findingIdFilter || c.meta.findingId === findingIdFilter)
    .filter((c) => scopeCovers(scope, c.meta.targetFiles))
    .map((c) => buildFindingView(c))
    .filter((item) => !wantedDispositions || wantedDispositions.has(item.disposition))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));

  sendJson(res, 200, { findings, errors });
}
