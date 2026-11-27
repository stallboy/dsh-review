/**
 * 批准前置校验、工作区还原核验与提交信息装配（SPEC §5.5 步骤 1–4）。
 */

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildCommitDetails,
  buildCommitSubject,
  composeCommitMessage,
  type CommitMessageDetail,
} from './commit-message.js';
import { isRepoRelativePath } from './invariants.js';
import { isDeferred, isPatchBanned, requireExplicitSelection, sha256Hex } from './issue-review.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import type { RepoRecoveryStore } from './recovery-store.js';
import type { RunAgentResult } from './runner.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import type { runGateChecks } from './validator.js';
import { collectCommitEntries, type VcsAdapter } from './vcs.js';
import type {
  ApprovalOutcome,
  AppSettings,
  ConcurrencyGuard,
  GateCheckResult,
  PatchEntry,
  RepairApplyMode,
  RepairOption,
  ReviewCandidate,
  ReviewFrontmatter,
  WaivedDecision,
} from './types.js';

export interface ApproveInput {
  id: string;
  guard: ConcurrencyGuard;
  optionId: string;
  patchId: number;
  confirmedDecisions: string[];
  waivedDecisions: WaivedDecision[];
  commitMessage?: string;
  commitDetail?: CommitMessageDetail;
  actor: string;
}

export interface ApprovalDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  jobId: string;
  log: (line: string) => void;
  sharedSource: () => Promise<SharedCandidateSource | undefined>;
  signal?: AbortSignal;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  runGates?: typeof runGateChecks;
  /** 测试可注入受控 Mode C 执行器，验证全部物理拓扑分支。 */
  runModeC?: (input: { prompt: string; cwd: string; signal?: AbortSignal }) => Promise<RunAgentResult>;
  isManaged?: boolean;
  recoveryStore?: RepoRecoveryStore;
}

export interface ValidatedSnapshot {
  source: SharedCandidateSource | undefined;
  candidate: ReviewCandidate;
  option: RepairOption;
  patchEntry: PatchEntry;
  patchText: string;
  approvedPatchPaths: string[];
  commitMessage: string;
}

export interface LocalModeCState {
  preHead: string;
  postHead: string;
  mergedParents: string[];
  commitCount: number;
  expectedTreeHash: string | null;
}

export interface PushedModeCState {
  commit: string;
  remoteRef: string;
  expectedTreeHash: string | null;
}

export interface PushedCarryOver {
  commit: string;
  remoteRef: string;
  treeHash: string | null;
  summary: string;
  gateResults: GateCheckResult[];
  snapshot: ValidatedSnapshot;
  applyMode: RepairApplyMode;
  base: string;
}

/** I10：校验 confirmedDecisions 与 waivedDecisions 构成当前 human_decisions 的精确无重无交划分。 */
export function validateHumanDecisionsCoverage(
  meta: ReviewFrontmatter,
  confirmedDecisions: readonly string[],
  waivedDecisions: readonly WaivedDecision[],
): string | null {
  const declared = new Set(meta.humanDecisions.map((item) => item.id));
  const confirmed = new Set<string>();
  for (const id of confirmedDecisions) {
    if (confirmed.has(id)) return `confirmedDecisions 包含重复判断项：${id}`;
    if (!declared.has(id)) return `confirmedDecisions 包含未知判断项：${id}`;
    confirmed.add(id);
  }
  const waived = new Set<string>();
  for (const item of waivedDecisions) {
    if (!item || typeof item.id !== 'string' || typeof item.reason !== 'string') {
      return 'waivedDecisions 项格式非法';
    }
    if (waived.has(item.id)) return `waivedDecisions 包含重复判断项：${item.id}`;
    if (!declared.has(item.id)) return `waivedDecisions 包含未知判断项：${item.id}`;
    if (confirmed.has(item.id)) return `判断项 ${item.id} 同时出现在 confirmedDecisions 与 waivedDecisions`;
    if (!item.reason.trim()) return `判断项 ${item.id} 的放弃理由（reason）不能为空`;
    waived.add(item.id);
  }
  for (const id of declared) {
    if (!confirmed.has(id) && !waived.has(id)) {
      return `遗漏必须处理的人工判断项：${id}`;
    }
  }
  return null;
}

export async function digestAiReviewDir(root: string): Promise<string> {
  const { entries } = await collectCommitEntries(root, ['.ai-review']);
  const hash = createHash('sha256');
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path).update('\0').update(entry.blobHash).update('\n');
  }
  return hash.digest('hex');
}

export async function hasSymlinkEscape(root: string, relPaths: readonly string[]): Promise<boolean> {
  const resolvedRoot = await realpath(root).catch(() => null);
  if (!resolvedRoot) return true;
  for (const rel of relPaths) {
    if (!isRepoRelativePath(rel) || isAiReviewPath(rel)) return true;
    const abs = path.join(root, rel);
    const info = await lstat(abs).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : 'error'));
    if (info === 'error') return true;
    if (info === null) continue;
    if (info.isSymbolicLink()) return true;
    const real = await realpath(abs).catch(() => null);
    if (!real) return true;
    const checkRel = path.relative(resolvedRoot, real).replaceAll('\\', '/');
    if (checkRel !== rel) return true;
  }
  return false;
}

/**
 * 还原工作区并强制核验三项后置条件（业务工作区干净、基线回到 preHead、.ai-review 摘要一致）。
 * 任一步骤失败或核验不通过，调用方必须转入 RECOVERY_REQUIRED / RESTORE_INCOMPLETE。
 */
export async function revertAndVerifyClean(params: {
  vcs: VcsAdapter;
  preHead: string;
  preBranch: string | null;
  preAiReviewDigest: string;
  includeAiReview?: boolean;
  patchRestore?: () => Promise<void>;
  useResetHard?: boolean;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { vcs, preHead, preBranch, preAiReviewDigest, includeAiReview = false, patchRestore, useResetHard = false } = params;
  try {
    if (vcs.type === 'git' && preBranch) {
      const currentBranch = (await vcs.getCurrentBranch?.()) ?? null;
      if (currentBranch !== preBranch) {
        await vcs.checkoutBranch?.(preBranch);
      }
    }
    if (includeAiReview && vcs.revertAllToPreHead) {
      await vcs.revertAllToPreHead(preHead, true);
    } else if (useResetHard && vcs.resetHard) {
      await vcs.resetHard(preHead, { includeAiReview });
    } else if (patchRestore) {
      await patchRestore();
    } else if (vcs.type === 'git' && vcs.resetHard && (await vcs.getCurrentBase()) !== preHead) {
      await vcs.resetHard(preHead, { includeAiReview });
    } else {
      await vcs.revertBusinessWorkspace();
    }
  } catch (error) {
    return { ok: false, detail: `还原工作区异常：${error instanceof Error ? error.message : String(error)}` };
  }

  const clean = await vcs.ensureCleanWorkspace().catch(() => null);
  if (!clean?.clean) {
    return { ok: false, detail: `还原后业务工作区仍不干净：${clean?.dirtyPaths.join(', ') ?? '状态不可读'}` };
  }
  const currentBase = await vcs.getCurrentBase().catch(() => null);
  if (currentBase !== preHead) {
    return { ok: false, detail: `还原后基线未回到 ${preHead}（当前 ${currentBase ?? 'null'}）` };
  }
  const digestNow = await digestAiReviewDir(vcs.root).catch(() => null);
  if (digestNow !== preAiReviewDigest) {
    return { ok: false, detail: '还原后 .ai-review/ 内容与批准前快照不一致' };
  }
  return { ok: true };
}

export async function validateApprovalPreconditions(
  deps: ApprovalDeps,
  input: ApproveInput,
): Promise<ValidatedSnapshot | ApprovalOutcome> {
  const { store, vcs, jobId } = deps;
  const abort = (
    reason: Extract<ApprovalOutcome, { status: 'ABORTED' }>['reason'],
    message: string,
    extra?: { detail?: string; duplicateOf?: string },
  ): ApprovalOutcome => ({
    status: 'ABORTED',
    jobId,
    reason,
    ...(extra?.duplicateOf ? { duplicateOf: extra.duplicateOf } : {}),
    ...(extra?.detail ? { detail: extra.detail } : {}),
    message,
  });

  const source = await deps.sharedSource();
  const base = await vcs.getCurrentBase();
  let detail;
  try {
    detail = await store.get(input.id, base, source, undefined, { optionId: input.optionId, patchId: input.patchId });
  } catch (error) {
    return abort('STATE_CONFLICT', error instanceof Error ? error.message : String(error));
  }
  const candidate = detail.candidate;
  if (candidate.parseError) {
    return abort('INVALID_CANDIDATE', `问题记录损坏：${candidate.parseError}`);
  }
  if (detail.local) {
    return abort('STATE_CONFLICT', `问题目录 ${candidate.id} 存在未提交本地改动（local 视图），禁止基于本地脏数据批准`);
  }
  const meta = candidate.meta;

  // Step 1: guard / status / defer / selection / sha256 / ban / duplicate
  try {
    store.checkGuard(meta, input.guard);
  } catch (error) {
    return abort('CONCURRENCY_MISMATCH', error instanceof Error ? error.message : String(error));
  }
  if (meta.status !== 'pending') {
    return abort('STATE_CONFLICT', `仅 pending 状态允许批准（当前为 ${meta.status}）`);
  }
  if (isDeferred(meta)) {
    return abort('STATE_CONFLICT', '该问题当前处于延期（defer）暂停态，请先执行 resume_review 解除暂停后再批准');
  }
  if (meta.owner !== input.actor) {
    return abort('CONCURRENCY_MISMATCH', `仅当前共享负责人 ${meta.owner} 可批准（当前操作者：${input.actor}）`);
  }

  let option: RepairOption;
  let patchEntry: PatchEntry;
  try {
    const resolved = requireExplicitSelection(meta, { optionId: input.optionId, patchId: input.patchId });
    option = resolved.option;
    patchEntry = resolved.patch;
  } catch (error) {
    return abort('STATE_CONFLICT', error instanceof Error ? error.message : String(error));
  }

  if (isPatchBanned(meta, option.id, patchEntry.id)) {
    return abort(
      'STATE_CONFLICT',
      `方案 ${option.id} 的补丁 #${String(patchEntry.id)} 曾因门禁验证失败被永久封禁，禁止再次直接批准`,
    );
  }

  const rawBytes = await store.readPatchBytes(candidate.month, candidate.slug, patchEntry.patch, source);
  if (rawBytes === null || sha256Hex(rawBytes) !== patchEntry.sha256) {
    return abort('INVALID_CANDIDATE', `补丁 ${patchEntry.patch} 缺失或 SHA-256 与账本不一致`);
  }
  const patchText = rawBytes.toString('utf8');
  const parsedPatch = parsePatch(patchText);
  const approvedPatchPaths = parsedPatch.paths;
  if (approvedPatchPaths.length === 0) {
    return abort('INVALID_CANDIDATE', `补丁 ${patchEntry.patch} 未包含任何业务文件路径`);
  }
  if (parsedPatch.unsafeModes.length > 0) {
    return abort('INVALID_CANDIDATE', `补丁 ${patchEntry.patch} 包含禁止的文件模式（${parsedPatch.unsafeModes.join(', ')}）`);
  }

  const duplicate = await store.findDuplicateForCandidate(candidate, source, source);
  if (duplicate) {
    return abort(
      'DUPLICATE_CANDIDATE',
      `命中负向记忆重复指纹，窗口期内已由 ${duplicate.candidateId} 拒绝（${duplicate.reason}）`,
      { detail: duplicate.candidateId, duplicateOf: duplicate.candidateId },
    );
  }

  // Step 2: 人工判断项精确覆盖
  const decisionError = validateHumanDecisionsCoverage(meta, input.confirmedDecisions, input.waivedDecisions);
  if (decisionError) {
    return abort('DECISIONS_UNCONFIRMED', decisionError);
  }

  // Step 3: 提交信息校验
  const commitMessage = (input.commitMessage !== undefined ? input.commitMessage : meta.commitMessage ?? '').trim();
  if (!commitMessage) {
    return abort('COMMIT_MESSAGE_MISMATCH', 'commit_message 不能为空');
  }
  const firstLine = commitMessage.replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? '';
  if (firstLine !== meta.title.trim()) {
    return abort('COMMIT_MESSAGE_MISMATCH', `commit_message 首行必须与 title 一致（期望 "${meta.title.trim()}"）`);
  }

  // Step 4: 完整不变量校验
  const validation = await store.validateFullCandidate(candidate, source);
  if (validation.length > 0) {
    return abort('INVALID_CANDIDATE', `问题记录校验失败：${validation.join('；')}`);
  }

  return { source, candidate, option, patchEntry, patchText, approvedPatchPaths, commitMessage };
}

export async function assembleFinalCommitMessage(params: {
  candidate: ReviewCandidate;
  optionId: string;
  patchId: number;
  patchText: string;
  commitMessage: string;
  commitDetail?: CommitMessageDetail;
  vcs: VcsAdapter;
}): Promise<string> {
  const { candidate, optionId, patchId, patchText, commitMessage, commitDetail, vcs } = params;
  if (!commitDetail) return commitMessage;
  if (commitDetail === 'simple') {
    return buildCommitSubject(candidate, optionId);
  }
  const authorStats = await vcs.authorStats(parsePatch(patchText).paths).catch(() => undefined);
  const details = await buildCommitDetails(candidate, {
    repoRoot: vcs.root,
    optionId,
    patchId,
    patchText,
    vcsType: vcs.type,
    ...(authorStats ? { authorStats } : {}),
  });
  return composeCommitMessage(candidate, 'detailed', details, optionId);
}
