/**
 * 共享写接口处理器（SPEC §6.3）：
 * 统一全部 11 个问题写端点为 {id, ...guard}，支持 /reviewers/init、/finding/decision、
 * 3 分支提交恢复、Mode B 提案修订/Rebase/收尾与 Mode C 批准编排。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  currentTrustedActor,
  guardFrom,
  isAnchor,
  numberField,
  readJson,
  requireSelectionFrom,
  selectionFrom,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type ApiRequest,
  type ApiResponse,
  type Runtime,
} from './api-context.js';
import { runApprovalTransaction, validateHumanDecisionsCoverage } from './approval.js';
import { normalizeCommitDetail } from './commit-message.js';
import {
  buildFindingView,
  COMMENTABLE_STATUSES,
  isDeferred,
  isPatchBanned,
  parseDecisionRequest,
  requireExplicitSelection,
  sha256Hex,
} from './issue-review.js';
import { anchorFromPatch, isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers, reviewersPath, serializeInitialReviewers } from './reviewers.js';
import {
  buildModeBPrompt,
  loadProposalSystemPrompt,
  runAgent,
  unresolvedCommentsForOption,
  wrapAgentPrompt,
} from './runner.js';
import { validateSettings } from './settings.js';
import type { AddCommentInput } from './store.js';
import { gitBlobHash } from './vcs.js';
import {
  ApiError,
  type AiFixOutcome,
  type CommentAnchor,
  type CommentSide,
  type CommentStatus,
  type ConcurrencyGuard,
  type IssueSelection,
  type JobRecord,
  type ReviewCandidate,
  type WaivedDecision,
} from './types.js';

function assertOwner(metaOwner: string, actor: string, actionLabel: string): void {
  if (metaOwner !== actor) {
    throw new ApiError(403, 'forbidden', `仅当前共享负责人 ${metaOwner} 可执行${actionLabel}（当前操作者：${actor}）`);
  }
}

/** SPEC §8.3 同步写操作三分支提交恢复。 */
async function commitSingleReviewWithRecovery(
  runtime: Runtime,
  candidate: ReviewCandidate,
  backupText: string,
  commitMessage: string,
): Promise<string> {
  const relReview = `.ai-review/${candidate.id}/review.md`;
  const expectedBlob = gitBlobHash(await readFile(candidate.reviewPath));
  const probeBefore = await runtime.vcs.getCommitProbe([relReview]).catch(() => null);

  const commit = await runtime.vcs.atomicCommit({
    message: commitMessage,
    paths: [relReview],
    verifyEntries: [{ path: relReview, blobHash: expectedBlob }],
  });

  if (commit.success && commit.commitRevision) {
    return commit.commitRevision;
  }

  if (commit.verificationFailed) {
    throw new ApiError(409, 'conflict', `提交核验失败，现场保留待人工恢复：${commit.errorOutput}`, {
      status: 'RECOVERY_REQUIRED',
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail: commit.errorOutput,
    });
  }

  const probeAfter = await runtime.vcs.getCommitProbe([relReview]).catch(() => null);
  if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
    const committedText = await runtime.vcs.readFileAt(probeAfter, relReview).catch(() => null);
    if (committedText !== null && gitBlobHash(committedText) === expectedBlob) {
      return probeAfter;
    }
    throw new ApiError(409, 'conflict', `提交结果不明，现场保留待人工恢复：${commit.errorOutput}`, {
      status: 'RECOVERY_REQUIRED',
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail: commit.errorOutput,
    });
  }

  if (probeBefore === null || probeAfter === null) {
    throw new ApiError(409, 'conflict', `无法确认提交是否落地，现场保留待人工恢复：${commit.errorOutput}`, {
      status: 'RECOVERY_REQUIRED',
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail: commit.errorOutput,
    });
  }

  // 证明未提交：先撤销暂存再恢复备份
  try {
    await commit.restorePreparation?.();
    await writeFile(candidate.reviewPath, backupText, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(409, 'conflict', `提交失败且无法完整恢复备份，请人工核对：${detail}`, {
      status: 'RECOVERY_REQUIRED',
      reason: 'RESTORE_INCOMPLETE',
      detail,
    });
  }

  throw new ApiError(409, 'conflict', `提交 .ai-review 失败并已还原：${commit.errorOutput}`);
}

async function resolveAnchorForInlineComment(
  runtime: Runtime,
  patchText: string,
  baseRevision: string,
  file: string,
  line: number,
  side: CommentSide,
  providedAnchor?: CommentAnchor,
): Promise<CommentAnchor | undefined> {
  if (providedAnchor) return providedAnchor;
  const fromPatch = anchorFromPatch(patchText, file, line, side);
  if (fromPatch && fromPatch.snippet.trim().length > 0) return fromPatch;
  if (side === 'LEFT' && baseRevision) {
    const baseText = await runtime.vcs.readFileAt(baseRevision, file).catch(() => null);
    if (baseText !== null) {
      const lines = baseText.replace(/\r\n/g, '\n').split('\n');
      const snippet = lines[line - 1];
      if (snippet && snippet.trim().length > 0) {
        return {
          snippet,
          ...(line > 1 && lines[line - 2] !== undefined ? { before: lines[line - 2] } : {}),
          ...(lines[line] !== undefined ? { after: lines[line] } : {}),
        };
      }
    }
  }
  return undefined;
}

export async function handlePutSettings(host: ApiHost, req: ApiRequest, res: ApiResponse): Promise<void> {
  const body = await readJson(req);
  const saved = await host.deps.saveSettings({ ...host.currentSettings(), ...body });
  host.updateSettings(saved);
  const validation = await validateSettings(saved);
  sendJson(res, 200, { settings: saved, validation });
}

/** SPEC §6.3：POST /reviewers/init — 工作区干净且 reviewers.yml 不存在时初始化并原子提交。 */
export async function handleReviewersInit(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const requestedOwner = stringField(body, 'defaultOwner').trim() || actor;
  if (!requestedOwner) {
    throw new ApiError(422, 'bad_request', '无法确定默认负责人，请传入非空 defaultOwner 或先配置 owner');
  }

  const source = await sharedSourceFor(runtime);
  const sharedText = source ? await source.readReviewersText().catch(() => null) : null;
  const diskPath = reviewersPath(runtime.root);
  if (sharedText !== null || existsSync(diskPath)) {
    throw new ApiError(409, 'conflict', '.ai-review/reviewers.yml 已存在，不能重复初始化');
  }

  const clean = await runtime.vcs.ensureCleanWorkspace();
  if (!clean.clean) {
    throw new ApiError(409, 'conflict', `初始化 reviewers.yml 前业务工作区必须干净：${clean.message}`);
  }

  const content = serializeInitialReviewers(requestedOwner);
  await mkdir(path.dirname(diskPath), { recursive: true });
  await writeFile(diskPath, content, { encoding: 'utf8', flag: 'wx' });

  const relPath = '.ai-review/reviewers.yml';
  const expectedBlob = gitBlobHash(Buffer.from(content, 'utf8'));
  const probeBefore = await runtime.vcs.getCommitProbe([relPath]).catch(() => null);
  let commit;
  let commitThrew = false;
  try {
    commit = await runtime.vcs.atomicCommit({
      message: `review: 初始化 reviewers.yml（default_owner: ${requestedOwner}） [skip ci]`,
      paths: [relPath],
      verifyEntries: [{ path: relPath, blobHash: expectedBlob }],
    });
  } catch (error) {
    commitThrew = true;
    commit = {
      success: false,
      commitRevision: null,
      outOfDate: false,
      errorOutput: error instanceof Error ? error.message : String(error),
    };
  }

  let commitRevision: string | null = commit.success && commit.commitRevision ? commit.commitRevision : null;
  if (!commitRevision) {
    if (commit.verificationFailed) {
      throw new ApiError(409, 'conflict', `提交 reviewers.yml 核验失败，现场保留：${commit.errorOutput}`, {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: commit.errorOutput,
      });
    }
    // SPEC §8.3 三分支探针：确认未产生共享提交后才允许清理本地文件
    const probeAfter = await runtime.vcs.getCommitProbe([relPath]).catch(() => null);
    if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
      const committedText = await runtime.vcs.readFileAt(probeAfter, relPath).catch(() => null);
      if (committedText !== null && gitBlobHash(committedText) === expectedBlob) {
        commitRevision = probeAfter;
      } else {
        throw new ApiError(409, 'conflict', `提交 reviewers.yml 探针变化但内容不符，现场保留：${commit.errorOutput}`, {
          status: 'RECOVERY_REQUIRED',
          reason: 'COMMIT_OUTCOME_UNKNOWN',
          detail: commit.errorOutput,
        });
      }
    } else if (commitThrew || probeBefore === null || probeAfter === null) {
      throw new ApiError(409, 'conflict', `提交 reviewers.yml 结果不明，现场保留：${commit.errorOutput}`, {
        status: 'RECOVERY_REQUIRED',
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: commit.errorOutput,
      });
    } else {
      await commit.restorePreparation?.().catch(() => undefined);
      await rm(diskPath, { force: true }).catch(() => undefined);
      throw new ApiError(409, 'conflict', `提交 reviewers.yml 失败：${commit.errorOutput}`);
    }
  }

  const config = await loadReviewers(runtime.root);
  sendJson(res, 200, { config, commitRevision });
}

export async function handleComment(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const content = stringField(body, 'content').trim();
  if (!content) throw new ApiError(422, 'bad_request', '评论内容不能为空');

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '提交审核意见');

  const file = stringField(body, 'file').trim();
  const line = numberField(body, 'line');
  const rawSide = stringField(body, 'side').trim();
  const side = rawSide ? (rawSide as CommentSide) : undefined;
  const rawRevision = body['revision'] === undefined ? undefined : numberField(body, 'revision');
  const selection = selectionFrom(body);
  const providedAnchor = body['anchor'] === undefined ? undefined : isAnchor(body['anchor']) ? body['anchor'] : (() => {
    throw new ApiError(422, 'bad_request', 'anchor 格式无效');
  })();

  let anchor = providedAnchor;
  if (file && line > 0 && (side === 'LEFT' || side === 'RIGHT') && selection) {
    const patchEntry = detail.candidate.meta.patches.find((p) => p.id === selection.patchId && p.optionId === selection.optionId);
    if (patchEntry) {
      const patchText = await runtime.store.readPatch(id, patchEntry.patch, source).catch(() => '');
      anchor = await resolveAnchorForInlineComment(runtime, patchText, patchEntry.baseRevision, file, line, side, providedAnchor);
    }
  }

  const isGeneral = !file && line === 0;
  // 总体评论启用 autoFix 时允许在请求顶层指定目标方案（仅用于触发修订，不绑定到总体评论本身）
  const commentSelection = isGeneral && body['autoFix'] === true ? undefined : selection;
  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const { candidate: updated, comment } = await runtime.store.addComment(
    id,
    guard,
    {
      author: actor,
      content,
      ...(rawRevision !== undefined ? { revision: rawRevision } : {}),
      ...(commentSelection ? { optionId: commentSelection.optionId, patchId: commentSelection.patchId } : {}),
      ...(file ? { file } : {}),
      ...(line > 0 ? { line } : {}),
      ...(side ? { side } : {}),
      ...(anchor ? { anchor } : {}),
    },
    source,
  );

  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 新增审核意见 ${comment.id} [skip ci]`,
  );

  let job: JobRecord | undefined;
  let autoFixError: string | undefined;
  if (body['autoFix'] === true) {
    const targetSelection = selection ?? (updated.meta.options.length === 1
      ? { optionId: updated.meta.options[0]!.id, patchId: updated.meta.options[0]!.currentPatch }
      : undefined);
    if (!targetSelection) {
      autoFixError = 'autoFix 必须显式指定 optionId 与 patchId';
    } else {
      try {
        job = await host.startAiFixJob(
          runtime,
          id,
          {
            expectedRevision: updated.meta.recordRevision,
            expectedOwner: updated.meta.owner,
            expectedUpdatedAt: updated.meta.updatedAt,
          },
          targetSelection,
          'revise',
        );
      } catch (error) {
        autoFixError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  sendJson(res, 200, {
    candidate: updated,
    comment,
    commit: { success: true, commitRevision },
    ...(job ? { job } : {}),
    ...(autoFixError ? { autoFixError } : {}),
  });
}

export async function handleCommentsBatch(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  if (!Array.isArray(body['comments']) || body['comments'].length === 0) {
    throw new ApiError(400, 'bad_request', 'comments 必须是非空数组');
  }
  const topSelection = selectionFrom(body);
  if (body['autoFix'] === true && !topSelection) {
    throw new ApiError(400, 'bad_request', '批量评论启用 autoFix 时顶层必须显式提供 optionId 与 patchId');
  }

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '批量提交审核意见');

  const inputs: AddCommentInput[] = [];
  for (const rawItem of body['comments']) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new ApiError(422, 'bad_request', 'comments 数组元素必须是对象');
    }
    const item = rawItem as Record<string, unknown>;
    const content = stringField(item, 'content').trim();
    if (!content) throw new ApiError(422, 'bad_request', '评论内容不能为空');
    const file = stringField(item, 'file').trim();
    const line = numberField(item, 'line');
    const rawSide = stringField(item, 'side').trim();
    const side = rawSide ? (rawSide as CommentSide) : undefined;
    const rawRevision = item['revision'] === undefined ? undefined : numberField(item, 'revision');
    const isGeneral = file === '' && line === 0;
    const itemSelection = isGeneral ? selectionFrom(item) : (selectionFrom(item) ?? topSelection);
    const providedAnchor = item['anchor'] === undefined ? undefined : isAnchor(item['anchor']) ? item['anchor'] : (() => {
      throw new ApiError(422, 'bad_request', 'anchor 格式无效');
    })();

    let anchor = providedAnchor;
    if (!isGeneral && (side === 'LEFT' || side === 'RIGHT') && itemSelection) {
      const patchEntry = detail.candidate.meta.patches.find((p) => p.id === itemSelection.patchId && p.optionId === itemSelection.optionId);
      if (patchEntry) {
        const patchText = await runtime.store.readPatch(id, patchEntry.patch, source).catch(() => '');
        anchor = await resolveAnchorForInlineComment(runtime, patchText, patchEntry.baseRevision, file, line, side, providedAnchor);
      }
    }

    inputs.push({
      author: actor,
      content,
      ...(rawRevision !== undefined ? { revision: rawRevision } : {}),
      ...(itemSelection ? { optionId: itemSelection.optionId, patchId: itemSelection.patchId } : {}),
      ...(file ? { file } : {}),
      ...(line > 0 ? { line } : {}),
      ...(side ? { side } : {}),
      ...(anchor ? { anchor } : {}),
    });
  }

  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const { candidate: updated, added } = await runtime.store.addCommentsBatch(id, guard, inputs, source);
  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 批量新增 ${String(added.length)} 条审核意见 [skip ci]`,
  );

  let job: JobRecord | undefined;
  let autoFixError: string | undefined;
  if (body['autoFix'] === true && topSelection) {
    try {
      job = await host.startAiFixJob(
        runtime,
        id,
        {
          expectedRevision: updated.meta.recordRevision,
          expectedOwner: updated.meta.owner,
          expectedUpdatedAt: updated.meta.updatedAt,
        },
        topSelection,
        'revise',
      );
    } catch (error) {
      autoFixError = error instanceof Error ? error.message : String(error);
    }
  }

  sendJson(res, 200, {
    candidate: updated,
    comments: added,
    commit: { success: true, commitRevision },
    ...(job ? { job } : {}),
    ...(autoFixError ? { autoFixError } : {}),
  });
}

export async function handleCommentStatus(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const commentId = stringField(body, 'commentId').trim();
  const status = stringField(body, 'status').trim() as CommentStatus;
  if (!commentId || !['unresolved', 'partial', 'resolved'].includes(status)) {
    throw new ApiError(422, 'bad_request', '必须提供合法的 commentId 与 status（unresolved / partial / resolved）');
  }

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '修改评论状态');

  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const updated = await runtime.store.setCommentStatus(id, guard, commentId, status, source);
  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 更新评论 ${commentId} 状态为 ${status} [skip ci]`,
  );

  sendJson(res, 200, { candidate: updated, commit: { success: true, commitRevision } });
}

export async function handleTakeover(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const targetOwner = stringField(body, 'owner').trim() || actor;
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);

  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const updated = await runtime.store.takeover(id, guard, targetOwner, source);
  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 负责人变更为 ${targetOwner} [skip ci]`,
  );

  sendJson(res, 200, { candidate: updated, commit: { success: true, commitRevision } });
}

export async function handleResume(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '恢复待审核状态');

  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const updated = await runtime.store.resume(id, guard, source);
  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 恢复为 pending [skip ci]`,
  );

  sendJson(res, 200, { candidate: updated, commit: { success: true, commitRevision } });
}

/** SPEC §4.2 / §6.3：POST /finding/decision — 统一 {id, ...guard, action, ...}，更新原 review.md。 */
export async function handleFindingDecision(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const decisionRequest = parseDecisionRequest(body);

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, `执行人工处置（${decisionRequest.action}）`);

  const backupText = await readFile(detail.candidate.reviewPath, 'utf8');
  const updated = await runtime.store.applyDecision(id, guard, decisionRequest, actor, source);
  const commitRevision = await commitSingleReviewWithRecovery(
    runtime,
    updated,
    backupText,
    `review(${id}): 人工处置 ${decisionRequest.action} [skip ci]`,
  );

  sendJson(res, 200, { candidate: updated, finding: buildFindingView(updated), commitRevision });
}

/** SPEC §6.3：POST /approve — 统一 {id, ...guard, optionId, patchId, confirmedDecisions?, waivedDecisions?, commitMessage?, commitDetail?}。 */
export async function handleApprove(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const selection = requireSelectionFrom(body);

  if (body['commitDetail'] !== undefined && normalizeCommitDetail(body['commitDetail']) === undefined) {
    throw new ApiError(422, 'bad_request', 'commitDetail 只能是 simple 或 detailed');
  }
  const commitDetail = normalizeCommitDetail(body['commitDetail']);

  const confirmedDecisions = body['confirmedDecisions'] === undefined
    ? []
    : Array.isArray(body['confirmedDecisions']) && body['confirmedDecisions'].every((v) => typeof v === 'string')
      ? (body['confirmedDecisions'] as string[])
      : (() => { throw new ApiError(422, 'bad_request', 'confirmedDecisions 必须是字符串数组'); })();

  const waivedDecisions: WaivedDecision[] = body['waivedDecisions'] === undefined
    ? []
    : Array.isArray(body['waivedDecisions'])
      ? (body['waivedDecisions'] as unknown[]).map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ApiError(422, 'bad_request', 'waivedDecisions 项必须是对象');
        }
        const entry = item as Record<string, unknown>;
        return { id: stringField(entry, 'id'), reason: stringField(entry, 'reason') };
      })
      : (() => { throw new ApiError(422, 'bad_request', 'waivedDecisions 必须是数组'); })();

  const commitMessage = body['commitMessage'] === undefined
    ? undefined
    : typeof body['commitMessage'] === 'string'
      ? body['commitMessage']
      : (() => { throw new ApiError(422, 'bad_request', 'commitMessage 必须是字符串'); })();

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source, undefined, selection);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  const meta = detail.candidate.meta;

  runtime.store.checkGuard(meta, guard);
  assertOwner(meta.owner, actor, '批准并交付');
  if (meta.status !== 'pending') {
    throw new ApiError(409, 'conflict', `仅 pending 状态允许批准（当前为 ${meta.status}）`);
  }
  if (isDeferred(meta)) {
    throw new ApiError(409, 'conflict', '问题当前处于延期（defer）暂停态，请先执行 resume_review');
  }
  const { option, patch } = requireExplicitSelection(meta, selection);
  if (isPatchBanned(meta, option.id, patch.id)) {
    throw new ApiError(409, 'conflict', `方案 ${option.id} 的补丁 #${String(patch.id)} 曾验证失败已被永久封禁，禁止直接批准`);
  }

  const duplicate = await runtime.store.findDuplicateForCandidate(detail.candidate, source, source);
  if (duplicate) {
    throw new ApiError(409, 'conflict', `命中负向记忆重复指纹（${duplicate.candidateId}：${duplicate.reason}）`, {
      duplicateOf: duplicate.candidateId,
    });
  }

  const decisionError = validateHumanDecisionsCoverage(meta, confirmedDecisions, waivedDecisions);
  if (decisionError) {
    throw new ApiError(422, 'bad_request', decisionError);
  }

  const isManaged = Boolean(currentTrustedActor()?.commandId);
  const job = host.jobManager.start('approve', async (ctx) => {
    return host.withWriteLock(runtime.root, () => runApprovalTransaction(
      {
        store: runtime.store,
        vcs: runtime.vcs,
        settings: host.currentSettings(),
        jobId: ctx.id,
        log: ctx.log,
        sharedSource: () => sharedSourceFor(runtime),
        signal: ctx.signal,
        ...(host.deps.resolveCredential ? { resolveCredential: host.deps.resolveCredential } : {}),
        ...(host.deps.auditStageGates ? { runGates: host.deps.auditStageGates } : {}),
        ...(host.deps.runModeC ? { runModeC: host.deps.runModeC } : {}),
        isManaged,
        recoveryStore: host.recoveryStore,
      },
      {
        id,
        guard,
        optionId: option.id,
        patchId: patch.id,
        confirmedDecisions,
        waivedDecisions,
        ...(commitMessage !== undefined ? { commitMessage } : {}),
        ...(commitDetail ? { commitDetail } : {}),
        actor,
      },
    ));
  });

  sendJson(res, 202, { jobId: job.id, job });
}

/** 校验并提交 Mode B 提案修订产物（用于 /ai-fix、/rebase 与 /candidate/finalize）。 */
async function verifyAndCommitModeBProposal(params: {
  runtime: Runtime;
  id: string;
  guard: ConcurrencyGuard;
  selection: IssueSelection;
  actor: string;
  beforePatchCount: number;
  beforeReviewText: string;
  targetBase: string;
  revertBusinessBeforeVerify: boolean;
  log: (line: string) => void;
}): Promise<AiFixOutcome> {
  const { runtime, id, guard, selection, actor, beforePatchCount, beforeReviewText, targetBase, revertBusinessBeforeVerify, log } = params;

  if (revertBusinessBeforeVerify) {
    // I18：自动化 Mode B 在干净工作区启动后，退出前强制还原非 .ai-review/ 临时改动并清空 .tmp/
    await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      return {
        status: 'RECOVERY_REQUIRED',
        reason: 'RESTORE_INCOMPLETE',
        detail: `Mode B 收尾后业务工作区未完全还原：${clean.dirtyPaths.join(', ')}`,
        message: '业务工作区未能还原干净，已中止提交',
      };
    }
  } else {
    // 手动/外部 /candidate/finalize 不得删除用户的业务改动，遇到脏工作区立即中止并保留用户内容
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      return {
        status: 'ABORTED',
        reason: 'DIRTY_WORKSPACE',
        detail: clean.dirtyPaths.join(', '),
        message: `业务工作区存在未提交改动，已中止收尾并完整保留工作区内容：${clean.dirtyPaths.join(', ')}`,
      };
    }
  }

  const sharedSource = await sharedSourceFor(runtime);
  const sharedBefore = await runtime.store.get(id, null, sharedSource);
  if (sharedBefore.candidate.parseError) {
    return { status: 'ABORTED', reason: 'INVALID_CANDIDATE', message: `共享问题记录损坏：${sharedBefore.candidate.parseError}` };
  }
  try {
    runtime.store.checkGuard(sharedBefore.candidate.meta, guard);
  } catch (error) {
    return { status: 'ABORTED', reason: 'CONCURRENCY_MISMATCH', message: error instanceof Error ? error.message : String(error) };
  }
  if (sharedBefore.candidate.meta.owner !== actor) {
    return { status: 'ABORTED', reason: 'CONCURRENCY_MISMATCH', message: '问题负责人已变更' };
  }
  if (!COMMENTABLE_STATUSES.has(sharedBefore.candidate.meta.status)) {
    return {
      status: 'ABORTED',
      reason: 'STATE_CONFLICT',
      message: `当前状态 ${sharedBefore.candidate.meta.status} 不允许 Mode B 提案修订收尾`,
    };
  }

  const localDetail = await runtime.store.get(id, targetBase);
  const localCandidate = localDetail.candidate;
  if (localCandidate.parseError) {
    return { status: 'VALIDATION_FAILED', errors: [localCandidate.parseError], message: '修订后的 review.md 格式校验失败' };
  }
  const meta = localCandidate.meta;
  const oldMeta = sharedBefore.candidate.meta;
  const errors: string[] = [];

  if (meta.findingId !== oldMeta.findingId) errors.push('finding_id 不得变更');
  if (meta.recordRevision !== oldMeta.recordRevision + 1) {
    errors.push(`record_revision 必须推进为 ${String(oldMeta.recordRevision + 1)}，当前为 ${String(meta.recordRevision)}`);
  }
  // I13：updated_at 必须严格晚于共享旧记录时间
  const oldMs = Date.parse(oldMeta.updatedAt);
  const newMs = Date.parse(meta.updatedAt);
  if (!Number.isFinite(newMs) || (Number.isFinite(oldMs) && newMs <= oldMs)) {
    errors.push(`updated_at（${meta.updatedAt}）必须严格大于旧记录时间（${oldMeta.updatedAt}）`);
  }
  if (meta.status !== 'pending') errors.push(`修订收尾后 status 必须为 pending，当前为 ${meta.status}`);
  if (meta.approval !== null) errors.push('修订收尾后 approval 必须为 null');
  if (meta.patches.length !== beforePatchCount + 1) {
    errors.push(`Mode B 必须恰好追加 1 份新补丁（期望 ${String(beforePatchCount + 1)} 份，实际 ${String(meta.patches.length)} 份）`);
  }

  // 确认历史补丁未被篡改，另一方案未被破坏
  for (let i = 0; i < oldMeta.patches.length; i += 1) {
    const oldP = oldMeta.patches[i]!;
    const newP = meta.patches[i];
    if (!newP || newP.id !== oldP.id || newP.patch !== oldP.patch || newP.optionId !== oldP.optionId || newP.sha256 !== oldP.sha256) {
      errors.push(`历史补丁 #${String(oldP.id)} 被修改或删除`);
    }
  }
  for (const oldOpt of oldMeta.options) {
    if (oldOpt.id === selection.optionId) continue;
    const sameOpt = meta.options.find((o) => o.id === oldOpt.id);
    if (!sameOpt || sameOpt.currentPatch !== oldOpt.currentPatch) {
      errors.push(`非目标方案 ${oldOpt.id} 被意外修改或移除`);
    }
  }
  // 确认原人类评论原文与历史决策未被删除或篡改
  for (const oldComment of oldMeta.comments) {
    const nextComment = meta.comments.find((c) => c.id === oldComment.id);
    if (!nextComment || nextComment.content !== oldComment.content || nextComment.author !== oldComment.author) {
      errors.push(`历史人类评论 ${oldComment.id} 原文被篡改或删除`);
    }
  }
  if (meta.decisions.length < oldMeta.decisions.length) {
    errors.push('历史人工处置 decisions[] 不得被删减');
  }

  const newPatch = meta.patches[meta.patches.length - 1];
  const updatedOpt = meta.options.find((o) => o.id === selection.optionId);
  if (!updatedOpt || !newPatch || newPatch.optionId !== selection.optionId || updatedOpt.currentPatch !== newPatch.id) {
    errors.push(`所选方案 ${selection.optionId} 的 current_patch 未指向新追加补丁`);
  }

  errors.push(...(await runtime.store.validateFullCandidate(localCandidate)));

  let newPatchAbs = '';
  if (newPatch) {
    newPatchAbs = path.join(localCandidate.dirPath, newPatch.patch);
    const check = await runtime.vcs.checkPatch(newPatchAbs);
    if (!check.ok) {
      errors.push(`新补丁 ${newPatch.patch} 只读应用预检失败：${check.message}`);
    }
    const patchBytes = await readFile(newPatchAbs).catch(() => null);
    if (!patchBytes || sha256Hex(patchBytes) !== newPatch.sha256) {
      errors.push(`新补丁 ${newPatch.patch} SHA-256 校验不匹配`);
    } else {
      const parsedNewPatch = parsePatch(patchBytes.toString('utf8'));
      if (parsedNewPatch.paths.some(isAiReviewPath)) {
        errors.push('新补丁包含禁止路径或 .ai-review/');
      }
      if (parsedNewPatch.unsafeModes.length > 0) {
        errors.push(`新补丁包含禁止的文件模式（${parsedNewPatch.unsafeModes.join(', ')}）`);
      }
    }
  }

  if (errors.length > 0) {
    return { status: 'VALIDATION_FAILED', errors, message: `提案修订产物校验未通过（${String(errors.length)} 项问题）` };
  }

  const relReview = `.ai-review/${id}/review.md`;
  const relPatch = `.ai-review/${id}/${newPatch!.patch}`;
  const reviewBlob = gitBlobHash(await readFile(localCandidate.reviewPath));
  const patchBlob = gitBlobHash(await readFile(newPatchAbs));
  log(`Mode B 校验通过，提交 ${relReview} 与 ${relPatch}`);

  const probePaths = [relReview, relPatch];
  const probeBefore = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
  let commit;
  let commitThrew = false;
  try {
    commit = await runtime.vcs.atomicCommit({
      message: `review(${id}): 修订方案 ${selection.optionId}，追加补丁 ${newPatch!.patch} [skip ci]`,
      paths: probePaths,
      verifyEntries: [
        { path: relReview, blobHash: reviewBlob },
        { path: relPatch, blobHash: patchBlob },
      ],
    });
  } catch (error) {
    commitThrew = true;
    commit = {
      success: false,
      commitRevision: null,
      outOfDate: false,
      errorOutput: error instanceof Error ? error.message : String(error),
    };
  }

  if (commit.success && commit.commitRevision) {
    void beforeReviewText;
    return {
      status: 'COMMITTED',
      newRevision: meta.recordRevision,
      newPatchId: newPatch!.id,
      optionId: selection.optionId,
      commitRevision: commit.commitRevision,
      message: `提案已更新至记录版本 ${String(meta.recordRevision)}（补丁 ${newPatch!.patch}）`,
    };
  }

  if (commit.verificationFailed) {
    return { status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: commit.errorOutput, message: '提交核验失败，现场保留待人工核查' };
  }

  // SPEC §8.3 三分支恢复探测
  const probeAfter = await runtime.vcs.getCommitProbe(probePaths).catch(() => null);
  if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
    const committedReview = await runtime.vcs.readFileAt(probeAfter, relReview).catch(() => null);
    if (committedReview !== null && gitBlobHash(committedReview) === reviewBlob) {
      return {
        status: 'COMMITTED',
        newRevision: meta.recordRevision,
        newPatchId: newPatch!.id,
        optionId: selection.optionId,
        commitRevision: probeAfter,
        message: `提交命令异常但核实提案已更新至记录版本 ${String(meta.recordRevision)}（${probeAfter.slice(0, 12)}）`,
      };
    }
    return { status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: commit.errorOutput, message: '提交探针变化但内容无法核对一致，现场保留' };
  }
  if (commitThrew || probeBefore === null || probeAfter === null) {
    return { status: 'RECOVERY_REQUIRED', reason: 'COMMIT_OUTCOME_UNKNOWN', detail: commit.errorOutput, message: '提交命令异常或探针不可读，现场保留' };
  }

  await commit.restorePreparation?.().catch(() => undefined);
  return { status: 'ABORTED', reason: 'COMMIT_FAILED', detail: commit.errorOutput, message: `提交新提案失败：${commit.errorOutput}` };
}

export async function runModeBJob(params: {
  host: ApiHost;
  runtime: Runtime;
  id: string;
  guard: ConcurrencyGuard;
  selection: IssueSelection;
  intent: 'revise' | 'rebase';
  actor: string;
}): Promise<JobRecord> {
  const { host, runtime, id, guard, selection, intent, actor } = params;
  return host.jobManager.start('ai_fix', async (ctx): Promise<AiFixOutcome> => {
    return host.withWriteLock(runtime.root, async (): Promise<AiFixOutcome> => {
      const settings = host.currentSettings();
      const source = await sharedSourceFor(runtime);
      const currentBase = await runtime.vcs.getCurrentBase();
      if (!currentBase) {
        return { status: 'ABORTED', reason: 'SYNC_FAILED', message: '无法读取当前 VCS 基线' };
      }

      let detail;
      try {
        detail = await runtime.store.get(id, currentBase, source, undefined, selection);
      } catch (error) {
        return { status: 'ABORTED', reason: 'STATE_CONFLICT', message: error instanceof Error ? error.message : String(error) };
      }
      const candidate = detail.candidate;
      if (candidate.parseError) {
        return { status: 'ABORTED', reason: 'INVALID_CANDIDATE', message: `问题记录损坏：${candidate.parseError}` };
      }
      try {
        runtime.store.checkGuard(candidate.meta, guard);
      } catch (error) {
        return { status: 'ABORTED', reason: 'CONCURRENCY_MISMATCH', message: error instanceof Error ? error.message : String(error) };
      }
      if (candidate.meta.owner !== actor) {
        return { status: 'ABORTED', reason: 'CONCURRENCY_MISMATCH', message: '仅当前共享负责人可发起修订' };
      }
      if (!COMMENTABLE_STATUSES.has(candidate.meta.status)) {
        return { status: 'ABORTED', reason: 'STATE_CONFLICT', message: `当前状态 ${candidate.meta.status} 不允许 Mode B 修订` };
      }

      const { option, patch } = requireExplicitSelection(candidate.meta, selection);
      if (intent === 'revise') {
        const unresolved = unresolvedCommentsForOption(candidate.meta.comments, option.id);
        if (unresolved.length === 0) {
          return { status: 'ABORTED', reason: 'STATE_CONFLICT', message: `方案 ${option.id} 及总体意见中没有未解决评论` };
        }
      } else {
        // SPEC §5.7：Rebase 校验有效业务基线是否变化
        if (patch.baseRevision === currentBase) {
          return { status: 'ABORTED', reason: 'BASE_UNCHANGED', message: '业务基线未发生变化，无需 Rebase' };
        }
        const businessChanges = await runtime.vcs.businessChangesBetween(patch.baseRevision, currentBase);
        if (businessChanges === null) {
          return { status: 'ABORTED', reason: 'SYNC_FAILED', message: '无法证明业务基线变化（浅克隆或历史不可读），已中止 Rebase' };
        }
        if (businessChanges.length === 0) {
          return { status: 'ABORTED', reason: 'BASE_UNCHANGED', message: '仅 .ai-review/ 元数据变化，有效业务基线未变，无需 Rebase' };
        }
      }

      const clean = await runtime.vcs.ensureCleanWorkspace();
      if (!clean.clean) {
        return { status: 'ABORTED', reason: 'DIRTY_WORKSPACE', message: `工作区不干净：${clean.message}` };
      }

      const systemPrompt = await loadProposalSystemPrompt();
      const userPrompt = buildModeBPrompt({
        candidate,
        option,
        patchEntry: patch,
        patchText: detail.patchText,
        targetBase: currentBase,
        vcsType: runtime.vcsType,
        intent,
        mode: 'headless',
      });
      const fullPrompt = wrapAgentPrompt(systemPrompt, userPrompt);

      if (settings.runner === 'manual') {
        return {
          status: 'MANUAL_REQUIRED',
          prompt: fullPrompt,
          message: '当前为手动模式，请复制提示词在外部执行完成后调用 /candidate/finalize 收尾',
        };
      }

      const beforeReviewText = await readFile(candidate.reviewPath, 'utf8');
      const runResult = await runAgent({
        kind: settings.runner === 'dsh' ? 'dsh' : 'external',
        settings,
        cwd: runtime.root,
        prompt: fullPrompt,
        log: ctx.log,
        timeoutMs: 30 * 60_000,
        label: intent === 'rebase' ? 'Mode B Rebase' : 'Mode B 提案修订',
        signal: ctx.signal,
        ...(host.deps.resolveCredential ? { resolveCredential: host.deps.resolveCredential } : {}),
      });

      if (ctx.signal.aborted || runResult.aborted) {
        await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
        return { status: 'ABORTED', reason: 'CANCELLED', message: '任务已取消并已尝试还原业务工作区' };
      }
      if (!runResult.ok) {
        await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'ABORTED',
          reason: intent === 'rebase' ? 'REBASE_CONFLICT' : 'RUNNER_FAILED',
          detail: runResult.errorMessage ?? runResult.outputTail,
          message: `Mode B 执行失败：${runResult.errorMessage ?? '执行器异常'}`,
        };
      }

      return verifyAndCommitModeBProposal({
        runtime,
        id,
        guard,
        selection,
        actor,
        beforePatchCount: candidate.meta.patches.length,
        beforeReviewText,
        targetBase: currentBase,
        revertBusinessBeforeVerify: true,
        log: ctx.log,
      });
    });
  });
}

export async function handleAiFix(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const selection = requireSelectionFrom(body);

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source, undefined, selection);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '启动提案修订');
  if (!COMMENTABLE_STATUSES.has(detail.candidate.meta.status)) {
    throw new ApiError(409, 'conflict', `当前状态 ${detail.candidate.meta.status} 不允许发起提案修订`);
  }
  const { option } = requireExplicitSelection(detail.candidate.meta, selection);
  if (unresolvedCommentsForOption(detail.candidate.meta.comments, option.id).length === 0) {
    throw new ApiError(409, 'conflict', `方案 ${option.id} 及总体意见中没有未解决评论`);
  }

  const job = await host.startAiFixJob(runtime, id, guard, selection, 'revise');
  sendJson(res, 202, { jobId: job.id, job });
}

export async function handleRebase(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const selection = requireSelectionFrom(body);

  const runtime = await host.runtimeFor(url);
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source, undefined, selection);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '启动 Rebase');
  if (!COMMENTABLE_STATUSES.has(detail.candidate.meta.status)) {
    throw new ApiError(409, 'conflict', `当前状态 ${detail.candidate.meta.status} 不允许执行 Rebase`);
  }
  requireExplicitSelection(detail.candidate.meta, selection);

  const job = await host.startAiFixJob(runtime, id, guard, selection, 'rebase');
  sendJson(res, 202, { jobId: job.id, job });
}

/** SPEC §5.6 / §6.3：POST /candidate/finalize — 仅用于已有问题的 Mode B 外部/会话提案修订收尾。 */
export async function handleCandidateFinalize(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const selection = requireSelectionFrom(body);

  const runtime = await host.runtimeFor(url);
  // 允许在提案会话占用期间收尾当前修订，但存在活动审查租约时仍必须互斥阻塞
  const blockingAudit = host.auditLifecycle.blockingLeaseFor(runtime.root);
  if (blockingAudit) {
    throw new ApiError(409, 'conflict', `仓库审查进行中（${blockingAudit.auditId}），禁止并发执行提案收尾`);
  }
  const actor = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  const detail = await runtime.store.get(id, null, source, undefined, selection);
  if (detail.candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${detail.candidate.parseError}`);
  runtime.store.checkGuard(detail.candidate.meta, guard);
  assertOwner(detail.candidate.meta.owner, actor, '收尾提案修订');
  if (!COMMENTABLE_STATUSES.has(detail.candidate.meta.status)) {
    throw new ApiError(409, 'conflict', `当前状态 ${detail.candidate.meta.status} 不允许收尾提案修订`);
  }
  requireExplicitSelection(detail.candidate.meta, selection);

  const job = host.jobManager.start('ai_fix', async (ctx): Promise<AiFixOutcome> => {
    return host.withWriteLock(runtime.root, async (): Promise<AiFixOutcome> => {
      const currentBase = (await runtime.vcs.getCurrentBase()) ?? '';
      const beforeReviewText = (await source?.readReviewText(detail.candidate.month, detail.candidate.slug)) ?? '';
      const outcome = await verifyAndCommitModeBProposal({
        runtime,
        id,
        guard,
        selection,
        actor,
        beforePatchCount: detail.candidate.meta.patches.length,
        beforeReviewText,
        targetBase: currentBase,
        revertBusinessBeforeVerify: false,
        log: ctx.log,
      });
      if (outcome.status === 'COMMITTED') {
        await host.fixSessionGuard.releaseVerified(runtime.root, runtime);
      }
      return outcome;
    });
  });

  sendJson(res, 202, { jobId: job.id, job });
}

export async function handleSync(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const runtime = await host.runtimeFor(url);
  const result = await runtime.vcs.syncAndGetLatestBase();
  if (result.uncertain) {
    throw new ApiError(409, 'conflict', `同步后仓库状态不明，请人工核查：${result.message}`, {
      status: 'RECOVERY_REQUIRED',
      reason: 'SYNC_STATE_UNKNOWN',
      detail: result.message,
    });
  }
  sendJson(res, 200, result);
}
