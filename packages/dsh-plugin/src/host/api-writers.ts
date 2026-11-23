import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ApiRequest, ApiResponse } from './api-context.js';
import path from 'node:path';
import { AuditArchive } from './audit-archive.js';
import { auditFiles } from './audit-files.js';
import { findingDecisionFromRequest, findingRecordPath, parseFindingEvents, serializeFindingEvents } from './finding-decisions.js';
import { FindingApprovalState } from './finding-approval-state.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers, resolveOwner } from './reviewers.js';
import { runGateChecks } from './validator.js';
import { Runner } from './runner.js';
import type { ReviewStore } from './store.js';
import type { AiFixAbortReason, AiFixOutcome, AiFixRecoveryReason, JobRecord, ReviewCandidate } from './types.js';
import { ApiError } from './types.js';
import { patchTouchesReviewData, gitBlobHash, collectCommitEntries, type VcsAdapter } from './vcs.js';
import {
  guardFrom,
  isAnchor,
  readJson,
  relative,
  sendJson,
  sharedSourceFor,
  sharedViewFor,
  splitId,
  stringField,
  type ApiHost,
  type Runtime,
} from './api-context.js';
import type { ReadModels } from './api-readmodels.js';

/** 候选与档案的共享写入层。审查互斥由路由统一判断，长事务由后台 Job 在执行时取仓库锁。 */
export class Writers {
  constructor(
    private readonly host: ApiHost,
    private readonly readModels: ReadModels,
  ) {}

  aborted(
    reason: AiFixAbortReason,
    message: string,
    jobId: string,
    detail?: string,
    manualPrompt?: string,
  ): AiFixOutcome {
    return {
      status: 'ABORTED',
      reason,
      message,
      jobId,
      ...(detail !== undefined ? { detail } : {}),
      ...(manualPrompt !== undefined && manualPrompt.length > 0 ? { manualPrompt } : {}),
    };
  }

  /** 人工恢复需要用 detail 保留可诊断的现场信息。 */
  recoveryRequired(reason: AiFixRecoveryReason, message: string, jobId: string, detail: string): AiFixOutcome {
    return { status: 'RECOVERY_REQUIRED', reason, message, detail, jobId };
  }

  /** 版本号必须能归属于本次写入。 */
  committed(
    message: string,
    jobId: string,
    input: { commitRevision: string | null; newRevision?: number },
  ): AiFixOutcome {
    return {
      status: 'COMMITTED',
      message,
      commitRevision: input.commitRevision,
      ...(input.newRevision !== undefined ? { newRevision: input.newRevision } : {}),
      jobId,
    };
  }

  validationFailed(message: string, jobId: string, errors: string[]): AiFixOutcome {
    return { status: 'VALIDATION_FAILED', message, errors, jobId };
  }

  /** VCS 应用补丁需要文件输入，临时目录独立分配以免并发申请冲突。 */
  async applyPatchText(vcs: VcsAdapter, text: string, threeWay: boolean): Promise<{ ok: boolean; message: string }> {
    const { mkdtemp, writeFile: writeTmp, rm: rmTmp } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dcr-patch-'));
    try {
      const file = path.join(dir, 'change.patch');
      await writeTmp(file, text, 'utf8');
      return await vcs.applyPatch(file, threeWay);
    } finally {
      await rmTmp(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async validateNewRevision(
    runtime: Runtime,
    previous: ReviewCandidate,
    latest: ReviewCandidate,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (latest.parseError) errors.push(latest.parseError);
    const expectedRevision = previous.meta.currentRevision + 1;
    if (latest.meta.currentRevision !== expectedRevision) {
      errors.push(`版本必须恰好推进到 ${String(expectedRevision)}，实际为 ${String(latest.meta.currentRevision)}`);
    }
    if (latest.meta.revisions.length !== previous.meta.revisions.length + 1) {
      errors.push('revisions 必须恰好追加一个版本，不得覆盖或删除历史版本');
    }
    const preserves = (before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean =>
      Object.entries(before ?? {}).every(([key, value]) => JSON.stringify(after?.[key]) === JSON.stringify(value));
    if (latest.meta.createdAt !== previous.meta.createdAt) errors.push('created_at 在迭代中必须保持不变');
    if (latest.meta.schemaVersion !== previous.meta.schemaVersion || latest.meta.findingId !== previous.meta.findingId) {
      errors.push('候选的发现归属和格式版本在迭代中必须保持不变');
    }
    previous.meta.revisions.forEach((oldRevision, index) => {
      if (latest.meta.revisions[index]?.id !== oldRevision.id) errors.push('历史 revisions 顺序必须保持，只能在末尾追加');
    });
    if (latest.meta.reopenedFrom !== previous.meta.reopenedFrom
      || latest.meta.reopenedReason !== previous.meta.reopenedReason) {
      errors.push('reopened_from/reopen_reason 只能由人工 /reopen 写入，Runner 不得改写');
    }
    for (const oldDecision of previous.meta.humanDecisions) {
      const nextDecision = latest.meta.humanDecisions.find((decision) => decision.id === oldDecision.id);
      if (!nextDecision || !preserves(oldDecision.extra, nextDecision.extra)) {
        errors.push(`human_decisions[${oldDecision.id}] 的既有未知嵌套键被删除或改写`);
      }
    }
    const sharedSource = await sharedSourceFor(runtime);
    if (!sharedSource) errors.push('无法建立历史共享快照，不能证明历史补丁未被改写');
    for (const oldRevision of previous.meta.revisions) {
      const currentRevision = latest.meta.revisions.find((revision) => revision.id === oldRevision.id);
      if (!currentRevision
        || currentRevision.baseRevision !== oldRevision.baseRevision
        || currentRevision.patch !== oldRevision.patch
        || currentRevision.author !== oldRevision.author
        || !preserves(oldRevision.extra, currentRevision.extra)) {
        errors.push(`历史 revision ${String(oldRevision.id)} 的元数据被改写`);
      }
      if (sharedSource) {
        const oldText = await sharedSource.readPatchText(previous.month, previous.slug, oldRevision.patch);
        const localText = await readFile(path.join(latest.dirPath, oldRevision.patch), 'utf8').catch(() => null);
        if (oldText === null || localText !== oldText) errors.push(`历史补丁 ${oldRevision.patch} 被改写或不可证明`);
      }
    }
    const oldHistory = previous.sections.history.trim();
    if (oldHistory && !latest.sections.history.trimStart().startsWith(oldHistory)) {
      errors.push('历史审核记录被删改');
    }
    for (const oldComment of previous.meta.comments) {
      const nextComment = latest.meta.comments.find((comment) => comment.id === oldComment.id);
      if (!nextComment
        || nextComment.author !== oldComment.author
        || nextComment.content !== oldComment.content
        || nextComment.revision !== oldComment.revision
        || nextComment.file !== oldComment.file
        || nextComment.line !== oldComment.line
        || nextComment.side !== oldComment.side
        || JSON.stringify(nextComment.anchor) !== JSON.stringify(oldComment.anchor)
        || !preserves(oldComment.extra, nextComment.extra)) {
        errors.push(`历史评论 ${oldComment.id} 被删除或篡改`);
      }
    }
    if (!preserves(previous.meta.extra, latest.meta.extra)) {
      errors.push('未知顶层 Frontmatter 键被删改');
    }
    if (latest.meta.status !== 'pending') errors.push(`新版本状态必须是 pending，实际为 ${latest.meta.status}`);
    if (latest.meta.approval !== null) errors.push('新版本 approval 必须为 null');
    if (latest.meta.rejection !== null) errors.push('新版本 rejection 必须为 null');
    if (new Date(latest.meta.updatedAt).getTime() <= new Date(previous.meta.updatedAt).getTime()) {
      errors.push('updated_at 必须严格大于上一共享版本');
    }
    if (latest.meta.commitMessage.split(/\r?\n/, 1)[0] !== latest.meta.title) {
      errors.push('commit_message 首行必须与 title 完全一致');
    }
    const current = latest.meta.revisions.find((revision) => revision.id === latest.meta.currentRevision);
    if (!current) {
      errors.push('新版本缺少当前 revision 条目');
      return errors;
    }
    if (current.author !== 'ai') errors.push('新版本 author 必须为 ai');
    if (!current.baseRevision.trim()) errors.push('新版本 base_revision 不能为空');
    errors.push(...await runtime.store.validateFullCandidate(latest, undefined, sharedSource));
    let patchText: string | null = null;
    try {
      patchText = await readFile(path.join(latest.dirPath, current.patch), 'utf8');
    } catch {
      errors.push(`新补丁不存在或不可读：${current.patch}`);
    }
    if (patchText !== null) {
      const paths = parsePatch(patchText).paths;
      if (paths.length === 0) errors.push('新补丁没有业务文件');
      if (patchTouchesReviewData(patchText)) errors.push('新补丁包含禁止路径');
      if (errors.length === 0) {
        const applied = await this.applyPatchText(runtime.vcs, patchText, false);
        await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
        if (!applied.ok) errors.push(`新补丁无法在基线上严格应用：${applied.message}`);
      }
    }
    return [...new Set(errors)];
  }

  /** G17：命令报错后用路径级探针核实提交结果。只在已证明没有提交时允许调用方恢复备份。 */
  async commitAndClassify(input: {
    runtime: Runtime;
    message: string;
    paths: string[];
    /** SVN 目录的最后修改修订号不随子文件更新，探针须包含具体文件。 */
    probePaths?: string[];
    deletePaths?: string[];
    expectedFiles?: { relPath: string; text: string }[];
  }): Promise<
    | { landed: true; commitRevision: string | null }
    | { landed: false; outcome: 'ABORTED' | 'RECOVERY_REQUIRED'; detail: string }
  > {
    const { runtime } = input;
    const paths = [...new Set(input.paths.filter((item) => item.trim().length > 0))];
    const probePaths = [...new Set((input.probePaths ?? paths).filter((item) => item.trim().length > 0))];
    const probeBefore = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
    // 目录路径会展开为全部文件，须逐一核对，防止夹带未经验证的文件。
    const { entries: collected } = await collectCommitEntries(runtime.store.repoRoot, paths);
    // 删除项不会出现在提交树，若当作待核验的 blob 会误报缺失。
    const deleting = new Set((input.deletePaths ?? []).map((item) => item.replaceAll('\\', '/')));
    const auditedTexts = new Map((input.expectedFiles ?? []).map((file) => [file.relPath, file.text]));
    const verifyEntries = collected
      .filter((entry) => !deleting.has(entry.path))
      .map((entry) => ({
        ...entry,
        blobHash: auditedTexts.has(entry.path) ? gitBlobHash(auditedTexts.get(entry.path) ?? '') : entry.blobHash,
      }));
    const commit = await runtime.vcs.atomicCommit({
      message: input.message,
      paths,
      ...(input.deletePaths && input.deletePaths.length > 0 ? { deletePaths: input.deletePaths } : {}),
      verifyEntries,
      ...(input.deletePaths && input.deletePaths.length > 0 ? { verifyDeletions: input.deletePaths } : {}),
    });
    if (commit.verificationFailed) return { landed: false, outcome: 'RECOVERY_REQUIRED', detail: commit.errorOutput };
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
      let complete = true;
      for (const expected of input.expectedFiles ?? []) {
        const actual = await runtime.vcs.readFileAt(probeAfter, expected.relPath).catch(() => null);
        if (actual !== expected.text) complete = false;
      }
      if (complete && (input.expectedFiles?.length ?? 0) > 0) {
        return { landed: true, commitRevision: probeAfter };
      }
      return {
        landed: false,
        outcome: 'RECOVERY_REQUIRED',
        detail: `${commit.errorOutput}（提交探针已前进但提交内容与本次写入不一致，禁止恢复）`,
      };
    }
    try {
      await commit.restorePreparation?.();
    } catch (error) {
      return {
        landed: false,
        outcome: 'RECOVERY_REQUIRED',
        detail: `${commit.errorOutput}（无法撤销本次提交准备：${String(error)}）`,
      };
    }
    return { landed: false, outcome: 'ABORTED', detail: commit.errorOutput };
  }

  async restoreAppendedRevision(
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

  private async commitSharedWrite(
    message: string,
    candidate: ReviewCandidate,
    runtime: Runtime,
    backupText?: string | null,
    expectedText?: string | null,
  ): Promise<{ commitRevision: string | null }> {
    const { store } = runtime;
    const relReview = relative(store.repoRoot, candidate.reviewPath);
    // 此处读到的是写入后内容，只能作为缺少操作前备份时的兜底。
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

  /** 备份只能用于已证明本次共享提交不存在的恢复路径。 */
  private async reviewBackup(store: ReviewStore, id: string): Promise<string | null> {
    try {
      const detail = await store.get(id, null);
      return await readFile(detail.candidate.reviewPath, 'utf8');
    } catch {
      return null;
    }
  }

  async requireSharedCandidate(runtime: Runtime, id: string): Promise<void> {
    const view = await sharedViewFor(runtime);
    if (!view?.source) throw new ApiError(409, 'conflict', '无法建立共享 VCS 快照，共享写已中止');
    const { month, slug } = runtime.store.resolveCandidateDir(id);
    const text = await view.source.readReviewText(month, slug);
    if (text === null) {
      throw new ApiError(409, 'conflict', `候选 ${id} 不是共享事实（当前 VCS 快照中不存在），不能执行共享写；请先完成 /candidate/finalize 或审查收尾`);
    }
    if (await view.source.hasLocalChanges(month, slug)) {
      throw new ApiError(409, 'conflict', `候选 ${id} 存在本地未提交改动，不能执行共享写；请先还原工作区后重试`);
    }
  }

  private async requireSharedAudit(runtime: Runtime, auditId: string, localPath: string): Promise<void> {
    const view = await sharedViewFor(runtime);
    if (!view?.source) throw new ApiError(409, 'conflict', '无法建立共享 VCS 快照，档案写已中止');
    const sharedText = await view.source.readAuditText(auditId);
    if (sharedText === null) {
      throw new ApiError(409, 'conflict', `审查档案 ${auditId} 不是共享事实，不能修改`);
    }
    const localText = await readFile(localPath, 'utf8').catch(() => null);
    if (localText !== null && localText !== sharedText) {
      throw new ApiError(409, 'conflict', `审查档案 ${auditId} 存在本地未提交改动，不能执行共享写`);
    }
  }

  /** Owner 以宿主推断或配置的操作者为准，客户端提交的并发字段不能用来证明身份。 */
  async requireOwnerOf(store: ReviewStore, id: string): Promise<void> {
    const me = await this.host.ownerFor(store.repoRoot);
    const detail = await store.get(id, null);
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', detail.candidate.parseError);
    if (detail.candidate.meta.owner !== me) {
      throw new ApiError(403, 'forbidden', `当前操作者 ${me} 不是该候选 Owner（${detail.candidate.meta.owner}）；如需接手请先接管（POST /takeover）`);
    }
  }

  async addComment(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const author = await this.host.ownerFor(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    // 把非法行内字段降级为总体评论会悄悄丢掉定位信息。
    if (body['file'] !== undefined && typeof body['file'] !== 'string') throw new ApiError(400, 'bad_request', 'file 必须是 string');
    if (body['side'] !== undefined && typeof body['side'] !== 'string') throw new ApiError(400, 'bad_request', 'side 必须是 LEFT/RIGHT');
    if (body['line'] !== undefined && typeof body['line'] !== 'number') throw new ApiError(400, 'bad_request', 'line 必须是 number');
    if (body['revision'] !== undefined && typeof body['revision'] !== 'number') throw new ApiError(400, 'bad_request', 'revision 必须是 number');
    const backupText = await this.reviewBackup(store, id);
    if (body['anchor'] !== undefined && !isAnchor(body['anchor'])) {
      throw new ApiError(422, 'bad_request', 'anchor 必须是 {snippet: 非空 string, before?, after?}');
    }
    const candidate = await store.addComment(id, author, {
      content: stringField(body, 'content'),
      ...(typeof body['file'] === 'string' ? { file: body['file'] } : {}),
      ...(typeof body['line'] === 'number' ? { line: body['line'] } : {}),
      ...(typeof body['revision'] === 'number' ? { revision: body['revision'] } : {}),
      ...(body['side'] === 'LEFT' || body['side'] === 'RIGHT' ? { side: body['side'] } : {}),
      ...(isAnchor(body['anchor']) ? { anchor: body['anchor'] } : {}),
    }, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 审核意见 (rev ${String(candidate.meta.currentRevision)})`, candidate, runtime, backupText);
    let job: JobRecord | undefined;
    let autoFixError: string | undefined;
    if (body['autoFix'] === true) {
      try {
        // 须等意见进入共享提交后再启动修复，保证修复器能读到本次意见。
        job = await this.host.startAiFixJob(runtime, id, {
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

  async commentStatus(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const commentId = stringField(body, 'commentId');
    const status = stringField(body, 'status');
    if (status !== 'unresolved' && status !== 'partial' && status !== 'resolved') {
      throw new ApiError(422, 'bad_request', '非法意见状态');
    }
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    const backupText = await this.reviewBackup(store, id);
    const candidate = await store.setCommentStatus(id, commentId, status, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 更新意见状态`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  async takeover(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const owner = stringField(body, 'owner') || await this.host.ownerFor(store.repoRoot);
    await this.requireSharedCandidate(runtime, id);
    const backupText = await this.reviewBackup(store, id);
    const candidate = await store.transferOwner(id, owner, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 接管审核 (owner ${owner})`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  async resume(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    const backupText = await this.reviewBackup(store, id);
    const candidate = await store.resume(id, guard);
    const commit = await this.commitSharedWrite(`review(${id}): resume to pending`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  async addCommentsBatch(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const author = await this.host.ownerFor(store.repoRoot);
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    const rawComments = body['comments'];
    if (!Array.isArray(rawComments) || rawComments.length === 0) {
      throw new ApiError(422, 'bad_request', 'comments 必须是非空数组');
    }
    // 在任何写入之前验证整批评论，保证输入非法时没有部分写入。
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
    const backupText = await this.reviewBackup(store, id);
    const candidate = await store.addComments(id, author, inputs, guard);
    const commit = await this.commitSharedWrite(`review(${id}): 批量审核意见 (${String(inputs.length)} 条)`, candidate, runtime, backupText);
    let job: JobRecord | undefined;
    let autoFixError: string | undefined;
    if (body['autoFix'] === true) {
      try {
        job = await this.host.startAiFixJob(runtime, id, {
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

  async reject(req: ApiRequest, res: ApiResponse, url: URL, mode: 'manual' | 'stale' = 'manual'): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
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
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    await store.ensureWriteAllowed(detail.candidate, guard);
    // 补丁随后会被删除，需先提取符号供拒绝记录和后续复查使用。
    const relatedSymbols = [...new Set(
      [...detail.patchText.matchAll(/^@@[^\n]*@@\s*(\S[^\n]*)$/gm)]
        .map((match) => (match[1] ?? '').trim())
        .filter((symbol) => symbol.length > 0)
        .map((symbol) => symbol.slice(0, 120)),
    )].slice(0, 16);
    const reviewers = await loadReviewers(store.repoRoot, await sharedSourceFor(runtime));
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
      probePaths: [relative(store.repoRoot, candidate.reviewPath), ...patchRelPaths],
      deletePaths: patchRelPaths,
      ...(writtenReview !== null
        ? { expectedFiles: [{ relPath: relative(store.repoRoot, candidate.reviewPath), text: writtenReview }] }
        : {}),
    });
    if (!result.landed) {
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

  async reopen(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const from = stringField(body, 'from');
    const reason = stringField(body, 'reason');
    await this.requireOwnerOf(store, id);
    await this.requireSharedCandidate(runtime, id);
    const source = await sharedSourceFor(runtime);
    if (!source) throw new ApiError(409, 'conflict', '无法建立重开共享快照');
    const { month: fromMonth, slug: fromSlug } = store.resolveCandidateDir(from);
    if (await source.hasLocalChanges(fromMonth, fromSlug)) {
      throw new ApiError(409, 'conflict', `重开来源 ${from} 存在本地修改，必须先恢复为干净的共享快照`);
    }
    const backupText = await this.reviewBackup(store, id);
    const candidate = await store.reopen(id, from, reason, guard, source);
    const commit = await this.commitSharedWrite(`review(${id}): 人工重开（来自 ${from}）`, candidate, runtime, backupText);
    sendJson(res, 200, { candidate, commit });
  }

  async findingDecision(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const id = stringField(body, 'findingId');
    const version = stringField(body, 'expectedFindingVersion');
    let decision;
    let file;
    try {
      file = findingRecordPath(id);
      decision = findingDecisionFromRequest(body);
    } catch (error) {
      throw new ApiError(422, 'bad_request', error instanceof Error ? error.message : String(error));
    }
    if (!version) throw new ApiError(422, 'bad_request', '缺少发现版本');
    const view = await sharedViewFor(runtime);
    if (!view?.source) throw new ApiError(409, 'conflict', '无法建立共享 VCS 快照');
    const { findings } = await this.readModels.findingProjection(runtime, view);
    const finding = findings.find((item) => item.findingId === id);
    if (!finding?.findingVersion) throw new ApiError(409, 'conflict', '找不到可处理的新版发现');
    if (finding.findingVersion !== version) throw new ApiError(409, 'stale', '发现已更新，请刷新');
    if (finding.disposition === 'applied' || finding.disposition === 'resolved'
      || (decision.action === 'add_repair_hint' && finding.disposition !== 'human_takeover')
      || (decision.action === 'resume_review' && finding.disposition === 'undecided')) {
      throw new ApiError(409, 'conflict', '当前发现状态不允许此操作');
    }
    const actor = await this.host.ownerFor(runtime.root);
    const reviewers = await loadReviewers(runtime.root, view.source);
    if (resolveOwner(reviewers, { paths: finding.targetFiles, tags: [] }).owner !== actor) {
      throw new ApiError(403, 'forbidden', '只有发现负责人可以记录处置');
    }
    const state = new FindingApprovalState(runtime.root, id, this.host.deps.statePath);
    if (!await state.canRetry(runtime.vcs).catch(() => false)) {
      throw new ApiError(409, 'conflict', '该发现的上一次审批提交结果仍待核验');
    }
    const before = await view.source.readFindingText(id);
    const local = (await auditFiles(runtime.root, { op: 'read', paths: [file] })).bytes?.toString('utf8') ?? null;
    if (local !== before) throw new ApiError(409, 'conflict', '处置记录存在本地修改');
    const events = before === null ? [] : parseFindingEvents(before, id);
    const removeEmptyParent = before === null
      && !(await auditFiles(runtime.root, { op: 'list', paths: ['.ai-review'] })).names?.includes('findings');
    const text = serializeFindingEvents(id, [...events, {
      ...decision, revision: events.length + 1, auditId: finding.lastObservedAudit, actor, at: new Date().toISOString(),
    }]);
    await auditFiles(runtime.root, { op: 'write', paths: [file], text, expectedText: before });
    const commit = await this.commitAndClassify({
      runtime, message: `review(${id}): ${decision.action}`, paths: [file], expectedFiles: [{ relPath: file, text }],
    });
    if (!commit.landed) {
      if (commit.outcome === 'RECOVERY_REQUIRED') {
        throw new ApiError(409, 'conflict', '处置提交结果待核验', {
          status: commit.outcome, reason: 'COMMIT_OUTCOME_UNKNOWN', detail: commit.detail,
        });
      }
      try {
        await auditFiles(runtime.root, before === null
          ? { op: 'remove', paths: [file], entries: [{ path: file, blobHash: gitBlobHash(text), mode: '100644' }], removeEmptyParent }
          : { op: 'write', paths: [file], text: before, expectedText: text });
      } catch (error) {
        throw new ApiError(409, 'conflict', '处置未提交，但工作区未能完整恢复', {
          status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: String(error),
        });
      }
      throw new ApiError(409, 'conflict', '处置提交已失败并恢复', { reason: 'COMMIT_FAILED', detail: commit.detail });
    }
    const updated = await this.readModels.findingProjection(runtime);
    sendJson(res, 200, { finding: updated.findings.find((item) => item.findingId === id), commitRevision: commit.commitRevision });
  }

  async dismissFinding(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const findingId = stringField(body, 'findingId');
    const reason = stringField(body, 'reason').trim();
    if (!auditId || !findingId) throw new ApiError(400, 'bad_request', '缺少 auditId / findingId');
    if (!reason) throw new ApiError(422, 'bad_request', '忽略理由不能为空');
    const archive = new AuditArchive(runtime.root);
    const record = await archive.read(auditId);
    if (record.parseError) throw new ApiError(422, 'bad_request', `审查档案无效：${record.parseError}`);
    if (record.meta.schemaVersion === 2) throw new ApiError(409, 'conflict', '新版发现应使用发现处置入口');
    await this.requireSharedAudit(runtime, auditId, record.reviewPath);
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new ApiError(404, 'not_found', `finding 不存在：${findingId}`);
    if (item.status !== 'pending') {
      throw new ApiError(409, 'conflict', `审查项状态为 ${item.status}，只有 pending 可忽略`);
    }
    const { findings: projections } = await this.readModels.findingProjection(runtime);
    const projection = projections.find((entry) => entry.findingId === findingId);
    if (!projection || projection.lastObservedAudit !== auditId) {
      throw new ApiError(409, 'conflict', `该 finding 的最新有效观察不在档案 ${auditId} 中（当前 ${projection?.lastObservedAudit ?? '无观察'}），不能修改旧观察`);
    }
    const operator = await this.host.ownerFor(runtime.root);
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

  /** 新生成的转换目标随档案一起提交，避免共享快照看到档案却找不到对应候选。 */
  async convert(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
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
    if (record.meta.schemaVersion === 2) throw new ApiError(409, 'conflict', '新版发现应使用发现处置入口');
    await this.requireSharedAudit(runtime, auditId, record.reviewPath);
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new ApiError(404, 'not_found', `finding 不存在：${findingId}`);
    if (item.status !== 'pending') {
      throw new ApiError(409, 'conflict', `审查项状态为 ${item.status}，只有 pending 可转换`);
    }
    const { findings: projections } = await this.readModels.findingProjection(runtime);
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
        const sharedText = await view.source.readReviewText(month, slug);
        if (sharedText !== null) {
          if (await view.source.hasLocalChanges(month, slug)) {
            throw new ApiError(409, 'conflict', `候选 ${candidateId} 存在本地未提交改动，不能作为转换目标；请先还原工作区`);
          }
          return store.get(candidateId, null, view.source);
        }
      }
      return store.get(candidateId, null);
    })();
    if (detail.candidate.parseError) throw new ApiError(422, 'bad_request', `候选数据无效：${detail.candidate.parseError}`);
    if (detail.candidate.meta.schemaVersion === 2) {
      throw new ApiError(409, 'conflict', '新版候选必须在关联的发现中审核');
    }
    if (detail.candidate.meta.status === 'approved' || detail.candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', `候选 ${candidateId} 已归档，不能作为转换目标`);
    }
    const sharedView = await sharedViewFor(runtime);
    const targetIsShared = sharedView?.source
      ? (await sharedView.source.readReviewText(detail.candidate.month, detail.candidate.slug)) !== null
      : false;
    const targetErrors = await store.validateFullCandidate(
      detail.candidate,
      targetIsShared ? sharedView?.source : undefined,
      sharedView?.source,
    );
    if (targetErrors.length > 0) {
      throw new ApiError(422, 'bad_request', `转换目标未通过完整校验：${targetErrors.join('；')}`);
    }
    const commitPaths = [`.ai-review/audits/${auditId}`, ...(targetIsShared ? [] : [`.ai-review/${candidateId}`])];
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

  async rebase(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store, vcs } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    const guard = guardFrom(body);
    const acceptedSource = await sharedSourceFor(runtime);
    if (!acceptedSource) throw new ApiError(409, 'conflict', '无法建立共享快照，不能 Rebase');
    const detail = await store.get(id, null, acceptedSource);
    const me = await this.host.ownerFor(store.repoRoot);
    if (detail.candidate.meta.owner !== me) throw new ApiError(403, 'forbidden', '只有候选 Owner 可以 Rebase');
    await this.requireSharedCandidate(runtime, id);
    await store.ensureWriteAllowed(detail.candidate, guard);
    const job = this.host.jobManager.start('ai_fix', (log, jobId, signal): Promise<AiFixOutcome> => this.host.withWriteLock(store.repoRoot, async () => {
      const source = await sharedSourceFor(runtime);
      if (!source) return this.aborted('INVALID_CANDIDATE', '当前仓库没有可用的共享快照，无法 Rebase', jobId);
      const fresh = await store.get(id, null, source);
      if (fresh.candidate.parseError) return this.aborted('INVALID_CANDIDATE', fresh.candidate.parseError, jobId);
      if (fresh.candidate.meta.currentRevision !== guard.expectedRevision
        || fresh.candidate.meta.owner !== guard.expectedOwner
        || new Date(fresh.candidate.meta.updatedAt).getTime() !== new Date(guard.expectedUpdatedAt).getTime()) {
        return this.aborted('CONCURRENCY_MISMATCH', '候选已在排队期间被更新，请重新加载后再 Rebase', jobId);
      }
      const candidate = fresh.candidate;
      if (candidate.meta.status !== 'pending') {
        return this.aborted('STATE_CONFLICT', `候选状态不是 pending（当前 ${candidate.meta.status}），不能 Rebase`, jobId);
      }
      const base = await vcs.getCurrentBase().catch(() => null);
      if (!base) return this.aborted('SYNC_FAILED', '无法读取最新基线', jobId);
      const current = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision);
      if (!current) return this.aborted('INVALID_CANDIDATE', '当前版本缺失', jobId);
      const business = await this.readModels.businessBaselineState(vcs, current.baseRevision, base);
      if (business.state === 'same' || business.state === 'unchanged') {
        return this.aborted('BASE_UNCHANGED', '有效业务基线未变，无需 Rebase', jobId);
      }
      if (business.state === 'unknown') {
        return this.aborted('SYNC_FAILED', `无法判定业务基线是否变化，已中止：${business.detail}`, jobId);
      }
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) return this.aborted('DIRTY_WORKSPACE', `工作区不干净：${clean.message}`, jobId);
      const sharedPatch = await store.readSharedPatch(candidate, source);
      const touchedPaths = parsePatch(sharedPatch.text).paths.filter((file) => !isAiReviewPath(file));
      if (touchedPaths.length === 0) return this.aborted('INVALID_CANDIDATE', '当前补丁没有业务文件路径', jobId);
      const { readFile: readFs, readdir } = await import('node:fs/promises');
      const reviewBackup = await readFs(candidate.reviewPath, 'utf8');
      const entriesBefore = new Set(await readdir(candidate.dirPath).catch(() => [] as string[]));
      let updated: ReviewCandidate;
      let failureReason: 'REBASE_CONFLICT' | 'GATE_CHECK_FAILED' = 'REBASE_CONFLICT';
      let failureDetail = '';
      let deterministicPatch: string | null = null;
      log(`在最新基线 ${base.slice(0, 12)} 上三方应用 ${sharedPatch.patchName}`);
      const applied = await this.applyPatchText(vcs, sharedPatch.text, true);
      if (!applied.ok) {
        failureDetail = applied.message;
      } else {
        log('三方应用成功，重跑门禁');
        const report = await runGateChecks(candidate.meta.gateChecks, {
          cwd: store.repoRoot,
          baseRevision: base,
          timeoutMs: this.host.currentSettings().gateTimeoutMs,
          onLine: (line) => { if (line.trim()) log(`  ${line.slice(0, 300)}`); },
          signal,
        });
        if (signal.aborted) {
          await vcs.revertBusinessWorkspace().catch(() => undefined);
          return this.aborted('CANCELLED', 'Rebase 门禁已取消，未产生共享提交', jobId);
        }
        if (!report.allPassed) {
          failureReason = 'GATE_CHECK_FAILED';
          failureDetail = report.formattedEvidenceMarkdown;
        } else {
          deterministicPatch = await vcs.exportWorkingTreeDiff(base, touchedPaths);
        }
      }
      if (deterministicPatch === null) {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        const runner = new Runner({
          kind: this.host.currentSettings().runner,
          settings: this.host.currentSettings(),
          store,
          candidate,
          mode: 'RESOLVE_CONFLICT',
          comments: candidate.meta.comments.filter((comment) => comment.status !== 'resolved'),
          failureDetail,
          baseRevision: base,
          workingTree: 'clean_base',
          log,
          ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
          signal,
        });
        const result = await runner.run();
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        if (result.manual) {
          return this.aborted(failureReason, 'Rebase 需要人工解决冲突或门禁失败', jobId, failureDetail, result.prompt ?? '');
        }
        if (!result.success) {
          await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
          return result.aborted
            ? this.aborted('CANCELLED', 'Rebase Runner 已取消，未产生共享提交', jobId)
            : this.aborted('RUNNER_FAILED', `Rebase Runner 失败：${result.errorMessage ?? '未知错误'}`, jobId, result.outputTail);
        }
        const latest = await store.get(id, null);
        const latestBase = latest.candidate.meta.revisions.find(
          (revision) => revision.id === latest.candidate.meta.currentRevision,
        )?.baseRevision;
        const errors = await this.validateNewRevision(runtime, candidate, latest.candidate);
        if (latestBase !== base) errors.push(`Mode C 新版本必须使用最新基线 ${base}，实际为 ${latestBase ?? '(缺失)'}`);
        if (errors.length > 0) {
          await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
          return this.aborted('INVALID_CANDIDATE', `Mode C 新版本未通过提交前校验：\n${errors.join('\n')}`, jobId);
        }
        updated = latest.candidate;
      } else {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        if (!deterministicPatch.trim() || patchTouchesReviewData(deterministicPatch)) {
          return this.aborted('INVALID_CANDIDATE', 'Rebase 导出的新补丁为空或包含禁止路径', jobId);
        }
        const verifyApply = await this.applyPatchText(vcs, deterministicPatch, false);
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        if (!verifyApply.ok) return this.aborted('INVALID_CANDIDATE', `新补丁无法在新基线严格应用：${verifyApply.message}`, jobId);
        updated = await store.appendRevision(id, {
          baseRevision: base, patchText: deterministicPatch,
        }, guard);
        const errors = await this.validateNewRevision(runtime, candidate, updated);
        if (errors.length > 0) {
          await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
          return this.aborted('INVALID_CANDIDATE', `Rebase 新版本未通过提交前校验：\n${errors.join('\n')}`, jobId);
        }
      }
      const writtenReview = await readFs(updated.reviewPath, 'utf8').catch(() => null);
      const updatedCurrent = updated.meta.revisions.find((revision) => revision.id === updated.meta.currentRevision);
      const writtenPatch = updatedCurrent
        ? await readFs(path.join(updated.dirPath, updatedCurrent.patch), 'utf8').catch(() => null)
        : null;
      const result = await this.commitAndClassify({
        runtime,
        message: `review(${id}): rebase to ${base.slice(0, 12)} (rev ${String(updated.meta.currentRevision)})`,
        paths: [relative(store.repoRoot, updated.dirPath)],
        probePaths: [relative(store.repoRoot, updated.reviewPath)],
        expectedFiles: [
          ...(writtenReview !== null ? [{ relPath: relative(store.repoRoot, updated.reviewPath), text: writtenReview }] : []),
          ...(updatedCurrent && writtenPatch !== null
            ? [{ relPath: relative(store.repoRoot, path.join(updated.dirPath, updatedCurrent.patch)), text: writtenPatch }]
            : []),
        ],
      });
      if (!result.landed) {
        if (result.outcome === 'RECOVERY_REQUIRED') {
          return this.recoveryRequired('COMMIT_OUTCOME_UNKNOWN', `Rebase 提交结果无法确定，现场保留：${result.detail}`, jobId, result.detail);
        }
        await this.restoreAppendedRevision(candidate, reviewBackup, entriesBefore);
        return this.aborted('COMMIT_FAILED', `提交失败，已恢复操作前版本：${result.detail}`, jobId, result.detail);
      }
      return this.committed(`已 Rebase 到基线 ${base.slice(0, 12)}，新版本 ${String(updated.meta.currentRevision)}`, jobId, {
        commitRevision: result.commitRevision,
        newRevision: updated.meta.currentRevision,
      });
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** 独立 Fixer 产出的候选此前未进入共享快照，因此收尾依赖本地候选校验与目标路径冲突检查。 */
  async candidateFinalize(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { store, vcs } = runtime;
    const body = await readJson(req);
    const id = stringField(body, 'id');
    if (!id) throw new ApiError(400, 'bad_request', '缺少候选 id');
    const sharedSource = await sharedSourceFor(runtime);
    const shared = sharedSource ? await sharedSource.readReviewText(...splitId(id)) : null;
    if (shared !== null) throw new ApiError(409, 'conflict', `候选 ${id} 已是共享事实，独立收尾仅适用于本地候选`);
    const job = this.host.jobManager.start('ai_fix', (log, jobId): Promise<AiFixOutcome> => this.host.withWriteLock(store.repoRoot, async () => {
      const clean = await vcs.ensureCleanWorkspace();
      if (!clean.clean) return this.aborted('DIRTY_WORKSPACE', `独立候选收尾要求业务工作区干净：${clean.message}`, jobId);
      const detail = await store.get(id, null);
      const meta = detail.candidate.meta;
      const errors: string[] = [];
      if (detail.candidate.parseError) errors.push(detail.candidate.parseError);
      if (meta.schemaVersion === 2) errors.push('发现候选必须随关联档案收尾');
      if (meta.status !== 'pending') errors.push(`独立候选状态必须是 pending，当前为 ${meta.status}`);
      if (meta.currentRevision !== 1) errors.push(`独立候选 current_revision 必须为 1，当前为 ${String(meta.currentRevision)}`);
      if (meta.approval !== null) errors.push('独立候选的 approval 必须为 null');
      errors.push(...await store.validateFullCandidate(detail.candidate));
      if (patchTouchesReviewData(detail.patchText)) errors.push('补丁包含禁止路径（.ai-review/.tmp/node_modules/.git/.svn）');
      const reviewers = await loadReviewers(store.repoRoot, await sharedSourceFor(runtime));
      const routing = resolveOwner(reviewers, { paths: meta.targetFiles, tags: meta.tags });
      if (!routing.owner) {
        errors.push('reviewers.yml 未配置 default_owner，无法完成 owner 路由复核');
      } else if (meta.owner !== routing.owner) {
        errors.push(`owner 应为 ${routing.owner}（${routing.reason}），实际为 ${meta.owner || '(空)'}`);
      }
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
        return this.validationFailed(`候选 ${id} 未通过收尾校验`, jobId, errors);
      }
      // 收尾归一化不代表候选内容再次变更，因此保留原 updated_at。
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
          return this.recoveryRequired(
            'COMMIT_OUTCOME_UNKNOWN',
            `独立候选 ${id} 提交结果无法确定，现场保留待人工核对：${outcome.detail}`,
            jobId,
            outcome.detail,
          );
        }
        const { writeFile: restoreWrite } = await import('node:fs/promises');
        await restoreWrite(detail.candidate.reviewPath, reviewBackup, 'utf8').catch(() => undefined);
        return this.aborted('COMMIT_FAILED', `提交候选目录失败（已恢复）：${outcome.detail}`, jobId, outcome.detail);
      }
      log(`独立候选 ${id} 已提交：${outcome.commitRevision?.slice(0, 12) ?? ''}`);
      return this.committed(`独立候选 ${id} 已完成收尾提交`, jobId, { commitRevision: outcome.commitRevision });
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }
}
