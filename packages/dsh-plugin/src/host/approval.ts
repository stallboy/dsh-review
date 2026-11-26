/**
 * 批准编排（SPEC §5.5 11 步原子事务）：
 * 优先程序应用（严格应用 → 确定性三方合并），受阻按需唤起 Mode C（完整权限、禁改 .ai-review、物理拓扑硬护栏），
 * 门禁全过落地并关闭（保留补丁），门禁失败还原并记 repair_failed（永久封禁该补丁，绝不自动调用 Agent）。
 */

import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeApprovedText, supportedApprovalMergePatch } from './approval-merge.js';
import {
  readApprovalMergeSnapshots,
  replaceApprovalMergeFile,
  svnApprovalBinding,
} from './approval-merge-snapshots.js';
import {
  buildCommitDetails,
  buildCommitSubject,
  composeCommitMessage,
  type CommitMessageDetail,
} from './commit-message.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from './frontmatter.js';
import { isRepoRelativePath, validateSafeBusinessPath } from './invariants.js';
import {
  formatPatchFilename,
  isDeferred,
  isPatchBanned,
  nextUpdatedAt,
  requireExplicitSelection,
  sha256Hex,
} from './issue-review.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import {
  buildModeCPrompt,
  loadModeCSystemPrompt,
  parseModeCOutput,
  runAgent,
  wrapAgentPrompt,
  type RunAgentResult,
} from './runner.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import { runGateChecks } from './validator.js';
import { collectCommitEntries, gitBlobHash, type ExpectedCommitEntry, type VcsAdapter } from './vcs.js';
import type {
  ApprovalInfo,
  ApprovalOutcome,
  AppSettings,
  ConcurrencyGuard,
  GateCheckResult,
  PatchEntry,
  RepairApplyMode,
  RepairAttempt,
  RepairOption,
  ReviewCandidate,
  ReviewFrontmatter,
  WaivedDecision,
} from './types.js';

export const MAX_COMMIT_RETRIES = 2;

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

async function digestAiReviewDir(root: string): Promise<string> {
  const { entries } = await collectCommitEntries(root, ['.ai-review']);
  const hash = createHash('sha256');
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path).update('\0').update(entry.blobHash).update('\n');
  }
  return hash.digest('hex');
}

async function hasSymlinkEscape(root: string, relPaths: readonly string[]): Promise<boolean> {
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

interface ValidatedSnapshot {
  source: SharedCandidateSource | undefined;
  candidate: ReviewCandidate;
  option: RepairOption;
  patchEntry: PatchEntry;
  patchText: string;
  approvedPatchPaths: string[];
  commitMessage: string;
}

export async function runApprovalTransaction(deps: ApprovalDeps, input: ApproveInput): Promise<ApprovalOutcome> {
  const { store, vcs, settings, jobId, log } = deps;
  const runGatesFn = deps.runGates ?? runGateChecks;

  const abort = (reason: Extract<ApprovalOutcome, { status: 'ABORTED' }>['reason'], message: string, detail?: string): ApprovalOutcome => ({
    status: 'ABORTED',
    jobId,
    reason,
    ...(detail ? { detail } : {}),
    message,
  });

  const recover = (reason: Extract<ApprovalOutcome, { status: 'RECOVERY_REQUIRED' }>['reason'], detail: string, message?: string): ApprovalOutcome => ({
    status: 'RECOVERY_REQUIRED',
    jobId,
    reason,
    detail,
    message: message ?? `批准进入恢复态：${detail}`,
  });

  const validatePreconditions = async (): Promise<ValidatedSnapshot | ApprovalOutcome> => {
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
        duplicate.candidateId,
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
  };

  // 重试循环：仅在确认撞车且无提交（或 B-已推送 C_meta 撞车）时重试，最多 MAX_COMMIT_RETRIES + 1 次。
  let pushedCommitCarriedOver: {
    commit: string;
    remoteRef: string;
    treeHash: string | null;
    summary: string;
    gateResults: GateCheckResult[];
    snapshot: ValidatedSnapshot;
    applyMode: RepairApplyMode;
    base: string;
  } | null = null;

  for (let attemptNumber = 0; attemptNumber <= MAX_COMMIT_RETRIES; attemptNumber += 1) {
    if (deps.signal?.aborted) {
      return abort('RUNNER_FAILED', '批准任务已取消');
    }

    // 若上轮在情况 B-已推送中仅 C_meta 提交撞车，绝不回滚至 preHead，直接在 P 上重试 C_meta！
    if (pushedCommitCarriedOver) {
      const { commit: pushedHash, snapshot, gateResults, applyMode, base, summary } = pushedCommitCarriedOver;
      log(`情况 B-已推送：在业务提交 ${pushedHash.slice(0, 12)} 上重试元数据关闭提交 C_meta（第 ${String(attemptNumber + 1)} 次）`);
      const landed = await landMetaClosingCommitForPushed({
        deps,
        input,
        snapshot,
        pushedHash,
        gateResults,
        applyMode,
        base,
        summary,
      });
      if (landed.retry) continue;
      return landed.outcome;
    }

    log(`步骤 1–4：校验并发守卫、方案选择、人工判断与完整性（尝试 ${String(attemptNumber + 1)}/${String(MAX_COMMIT_RETRIES + 1)}）`);
    const initial = await validatePreconditions();
    if ('status' in initial) return initial;

    // Step 5: 检查工作区干净 & 无未完成 Git 操作
    log('步骤 5：检查业务工作区干净状态');
    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      return abort('DIRTY_WORKSPACE', `批准要求业务工作区干净：${clean.message}`);
    }
    if (vcs.type === 'git' && (await vcs.hasActiveGitOperation?.())) {
      return abort('SYNC_FAILED', 'Git 仓库正处于 merge/rebase/cherry-pick/revert 进行态，已中止批准并保留现场');
    }

    // Step 6: 按配置同步并重绑共享快照
    let snapshot = initial;
    if (settings.syncBeforeApprove) {
      log('步骤 6：同步远端基线并重绑共享快照');
      const sync = await vcs.syncAndGetLatestBase();
      if (sync.uncertain) {
        return recover('SYNC_STATE_UNKNOWN', sync.message);
      }
      if (sync.failed) {
        return abort('SYNC_FAILED', sync.message);
      }
      const rechecked = await validatePreconditions();
      if ('status' in rechecked) return rechecked;
      snapshot = rechecked;
    }

    const currentBase = await vcs.getCurrentBase();
    if (!currentBase) {
      return recover('SYNC_STATE_UNKNOWN', '无法读取当前 VCS 基线版本');
    }

    const { candidate, option, patchEntry, patchText, approvedPatchPaths } = snapshot;
    const patchFileOnDisk = path.join(candidate.dirPath, patchEntry.patch);
    const preHead = currentBase;
    const preBranch = vcs.type === 'git' ? (await vcs.getCurrentBranch?.()) ?? null : null;
    const preRemoteTip = vcs.type === 'git' ? (await vcs.getRemoteTip?.(preBranch ?? undefined)) ?? null : null;
    const preAllRefTips = vcs.type === 'git' ? (await vcs.listAllRefTips?.()) ?? new Map<string, string>() : new Map<string, string>();
    const preRemoteRefTips = vcs.type === 'git' ? (await vcs.listRemoteRefTips?.()) ?? new Map<string, string>() : new Map<string, string>();
    const preAiReviewDigest = await digestAiReviewDir(vcs.root);

    // Step 7: 程序优先应用（严格应用 → 确定性三方合并）→ 受阻则 Mode C
    log(`步骤 7：程序性应用方案 ${option.id} 补丁 ${patchEntry.patch}`);
    let applyMode: RepairApplyMode = 'program_strict';
    let applySummary = '程序严格应用成功';
    let appliedOk = false;
    let conflictMessage = '';
    let localModeC: {
      preHead: string;
      postHead: string;
      mergedParents: string[];
      commitCount: number;
      expectedTreeHash: string | null;
    } | null = null;
    let pushedModeC: {
      commit: string;
      remoteRef: string;
      expectedTreeHash: string | null;
    } | null = null;

    const strict = vcs.applyPatchForApproval
      ? await vcs.applyPatchForApproval(patchFileOnDisk, deps.signal)
      : { ...(await vcs.applyPatch(patchFileOnDisk, false)), workspace: 'unknown' as const, canMerge: true };
    let patchRestore: (() => Promise<void>) | undefined;

    if (strict.ok) {
      appliedOk = true;
      patchRestore = strict.restore;
    } else {
      conflictMessage = strict.message;
      if (strict.workspace === 'unknown') {
        return recover('SYNC_STATE_UNKNOWN', `程序性应用结果不明，已保留现场：${strict.message}`);
      }
      if (strict.workspace !== 'untouched') {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
      }
      // 尝试确定性三方合并
      if (strict.conflict && supportedApprovalMergePatch(patchText)) {
        log('严格应用遇到上下文冲突，尝试隔离环境确定性三方合并');
        const mergeSnapshots = await readApprovalMergeSnapshots(vcs, {
          sourceRevision: patchEntry.baseRevision,
          targetRevision: currentBase,
          files: approvedPatchPaths,
          svnBinding: vcs.type === 'svn' ? svnApprovalBinding(patchEntry.svnApprovalSource) : null,
          signal: deps.signal,
        });
        if (mergeSnapshots.status === 'ready') {
          const merged = await mergeApprovedText(patchText, mergeSnapshots.files, deps.signal);
          if (merged.status === 'merged') {
            try {
              for (const file of mergeSnapshots.files) {
                const nextContent = merged.files.get(file.path);
                if (!nextContent) throw new Error(`三方合并缺少文件结果：${file.path}`);
                await replaceApprovalMergeFile(vcs.root, file.path, file.target, nextContent);
              }
              appliedOk = true;
              applyMode = 'program_3way';
              applySummary = '程序确定性三方合并应用成功（逐 hunk 核验一致）';
            } catch (error) {
              conflictMessage = error instanceof Error ? error.message : String(error);
              await vcs.revertBusinessWorkspace().catch(() => undefined);
            }
          } else {
            conflictMessage = merged.detail;
          }
        } else {
          conflictMessage = `${strict.message}\n三方合并不可用：${mergeSnapshots.detail}`;
        }
      }
    }

    // 若程序受阻，分流至 FALLBACK 或 Mode C
    if (!appliedOk) {
      const modeCPrompt = wrapAgentPrompt(
        await loadModeCSystemPrompt(),
        buildModeCPrompt({
          candidate,
          option,
          patchEntry,
          patchText,
          approvedPatchPaths,
          targetBase: currentBase,
          conflictMessage,
          vcsType: vcs.type,
          repoRoot: vcs.root,
        }),
      );

      if (!settings.autoFixOnFailure || settings.runner === 'manual') {
        await vcs.revertBusinessWorkspace().catch(() => undefined);
        return {
          status: 'FALLBACK_TO_PENDING',
          jobId,
          reason: 'PATCH_CONFLICT',
          ...(settings.runner === 'manual' ? { manualPrompt: modeCPrompt } : {}),
          message: `补丁程序性应用受阻（${conflictMessage.slice(0, 300)}），已回退待审核`,
        };
      }

      log('程序性应用受阻，唤起修复 Agent（Mode C：完整权限辅助应用 / 分支合并）');
      applyMode = 'agent_assisted';
      const modeCResult = deps.runModeC
        ? await deps.runModeC({ prompt: modeCPrompt, cwd: vcs.root, signal: deps.signal })
        : await runAgent({
          kind: settings.runner === 'dsh' ? 'dsh' : 'external',
          settings,
          cwd: vcs.root,
          prompt: modeCPrompt,
          log,
          timeoutMs: 30 * 60_000,
          label: 'Mode C 获批辅助',
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.resolveCredential ? { resolveCredential: deps.resolveCredential } : {}),
        });

      const verdict = parseModeCOutput(modeCResult.assistantText || modeCResult.outputTail);
      const postHead = await vcs.getCurrentBase();
      const postBranch = vcs.type === 'git' ? (await vcs.getCurrentBranch?.()) ?? null : null;
      const postRemoteTip = (vcs.type === 'git' && preRemoteTip)
        ? (await vcs.getRemoteTip?.(preBranch ?? undefined)) ?? null
        : null;
      const postRemoteRefTips = vcs.type === 'git'
        ? (await vcs.listRemoteRefTips?.()) ?? new Map<string, string>()
        : new Map<string, string>();
      const changedRemoteRefs: Array<{ ref: string; before: string | undefined; after: string }> = [];
      for (const [refName, afterTip] of postRemoteRefTips) {
        const beforeTip = preRemoteRefTips.get(refName);
        if (beforeTip !== afterTip) {
          changedRemoteRefs.push({ ref: refName, before: beforeTip, after: afterTip });
        }
      }
      const remoteAdvanced = Boolean(
        (preRemoteTip && postRemoteTip && postRemoteTip.tip !== preRemoteTip.tip)
        || changedRemoteRefs.length > 0,
      );
      const primaryRemoteRef = postRemoteTip?.remoteRef
        ?? changedRemoteRefs[0]?.ref
        ?? 'origin';
      // 仅采信 Mode C 启动前已存在的本地/远端引用，以及未被本次 Mode C 推进的远端引用（防伪造侧分支绕过护栏）
      const trustedUpstreamTips = new Set<string>([
        ...preAllRefTips.values(),
        ...preRemoteRefTips.values(),
      ]);
      for (const [refName, tip] of postRemoteRefTips) {
        if (preRemoteRefTips.get(refName) === tip) trustedUpstreamTips.add(tip);
      }
      const branchSwitched = vcs.type === 'git' && preBranch !== null && postBranch !== preBranch;
      const postAiReviewDigest = await digestAiReviewDir(vcs.root);
      const aiReviewTampered = postAiReviewDigest !== preAiReviewDigest;
      const activeGitOp = vcs.type === 'git' ? Boolean(await vcs.hasActiveGitOperation?.()) : false;
      const allowedSet = new Set(approvedPatchPaths);

      const safeRevertToPreHead = async (): Promise<void> => {
        if (vcs.type === 'git') {
          if (preBranch && postBranch !== preBranch) {
            await vcs.checkoutBranch?.(preBranch).catch(() => undefined);
          }
          if (vcs.resetHard) {
            await vcs.resetHard(preHead);
            return;
          }
        }
        await vcs.revertBusinessWorkspace();
      };

      const exportNewPatchAndFallback = async (summary: string): Promise<ApprovalOutcome> => {
        // SPEC §5.5：先相对 preHead 导出新补丁，再还原业务工作区！
        const changedClean = await vcs.ensureCleanWorkspace();
        const candidateDiffPaths = new Set<string>([...approvedPatchPaths, ...changedClean.dirtyPaths]);
        if (vcs.type === 'git' && postHead && postHead !== preHead) {
          const between = await vcs.businessChangesBetween(preHead, postHead);
          for (const file of between ?? []) candidateDiffPaths.add(file);
        }
        const safePaths = [...candidateDiffPaths].filter((p) => isRepoRelativePath(p) && !isAiReviewPath(p));
        let exportedDiff = '';
        try {
          exportedDiff = await vcs.exportWorkingTreeDiff(preHead, safePaths);
        } catch (error) {
          await safeRevertToPreHead().catch(() => undefined);
          return abort('RUNNER_FAILED', `导出 Mode C 实质变更补丁失败：${error instanceof Error ? error.message : String(error)}`);
        }
        await safeRevertToPreHead();
        if (!exportedDiff.trim()) {
          return abort('RUNNER_FAILED', 'Mode C 声明实质变化但未产生有效业务 diff');
        }
        const parsedNew = parsePatch(exportedDiff);
        if (
          parsedNew.paths.length === 0
          || parsedNew.paths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p))
          || parsedNew.unsafeModes.length > 0
        ) {
          return abort('RUNNER_FAILED', 'Mode C 导出的新补丁包含非法路径或禁止文件模式');
        }

        const { id: newPatchId, patch: newPatchName } = store.nextPatchNumber(candidate.meta);
        const newPatchAbs = path.join(candidate.dirPath, newPatchName);
        const newPatchBytes = Buffer.from(exportedDiff, 'utf8');
        await writeFile(newPatchAbs, newPatchBytes);
        const check = await vcs.checkPatch(newPatchAbs);
        if (!check.ok) {
          await rm(newPatchAbs, { force: true }).catch(() => undefined);
          await safeRevertToPreHead().catch(() => undefined);
          return abort('RUNNER_FAILED', `Mode C 导出的新补丁未通过只读预检：${check.message}`);
        }

        const at = nextUpdatedAt(candidate.meta.updatedAt);
        const newPatchEntry: PatchEntry = {
          id: newPatchId,
          patch: newPatchName,
          optionId: option.id,
          baseRevision: preHead,
          author: 'ai',
          sha256: sha256Hex(newPatchBytes),
        };
        const mergedTargets = [...new Set([...candidate.meta.targetFiles, ...parsedNew.paths])];
        const nextMeta: ReviewFrontmatter = {
          ...candidate.meta,
          status: 'pending',
          baseRevision: preHead,
          targetFiles: mergedTargets,
          recordRevision: candidate.meta.recordRevision + 1,
          updatedAt: at,
          patches: [...candidate.meta.patches, newPatchEntry],
          options: candidate.meta.options.map((o) => (o.id === option.id ? { ...o, currentPatch: newPatchId } : o)),
        };
        const nextBody = `${candidate.body.trimEnd()}\n\n## 记录版本 ${String(nextMeta.recordRevision)}\n- Mode C 实质变化回退重审：方案 \`${option.id}\` 追加补丁 \`${newPatchName}\`（${summary}）。\n`;
        await store.write({ ...candidate, meta: nextMeta, body: nextBody }, { touchUpdatedAt: false });
        const metaCommit = await vcs.atomicCommit({
          message: `review(${candidate.id}): Mode C 实质变更生成新补丁 ${newPatchName} 重新人审 [skip ci]`,
          paths: [candidate.reviewPath, newPatchAbs],
        });
        if (!metaCommit.success) {
          return recover('COMMIT_OUTCOME_UNKNOWN', `Mode C 新补丁提交失败：${metaCommit.errorOutput}`);
        }
        return {
          status: 'FALLBACK_TO_PENDING',
          jobId,
          reason: 'MATERIAL_CHANGE',
          newRevision: nextMeta.recordRevision,
          message: `Mode C 辅助产生实质变更（${summary}），已导出新补丁 ${newPatchName}、还原业务并退回重新人审`,
        };
      };

      const isCaseA = postHead === preHead && postBranch === preBranch && !remoteAdvanced;
      if (isCaseA) {
        // Case A：仅工作区适配
        const postClean = await vcs.ensureCleanWorkspace();
        const dirtyPaths = postClean.dirtyPaths;
        const hasForbidden = dirtyPaths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p));
        const symlinkBad = !hasForbidden && (await hasSymlinkEscape(vcs.root, dirtyPaths));

        if (!modeCResult.ok || !verdict || aiReviewTampered || activeGitOp || hasForbidden || symlinkBad || dirtyPaths.length === 0) {
          await safeRevertToPreHead().catch(() => undefined);
          const why = aiReviewTampered
            ? 'Mode C 篡改了 .ai-review/ 目录'
            : activeGitOp
              ? 'Mode C 留下未完成 Git 合并/变基状态'
              : hasForbidden || symlinkBad
                ? 'Mode C 触及禁止路径或符号链接逃逸'
                : !verdict
                  ? 'Mode C 未返回合法结构化 JSON 结果'
                  : dirtyPaths.length === 0
                    ? 'Mode C 未产生任何业务代码修改'
                    : (modeCResult.errorMessage ?? 'Mode C 执行失败');
          return abort('RUNNER_FAILED', `Mode C 辅助失败并已还原：${why}`);
        }

        const outOfScope = dirtyPaths.filter((p) => !allowedSet.has(p));
        if (verdict.verdict === 'material_change' || outOfScope.length > 0) {
          const reasonText = verdict.verdict === 'material_change'
            ? verdict.summary
            : `业务改动超出获批源补丁范围（越界文件：${outOfScope.join(', ')}）`;
          return exportNewPatchAndFallback(reasonText);
        }

        applySummary = `Mode C 工作区等价适配：${verdict.summary}`;
        appliedOk = true;
      } else {
        // Case B：本地 commit/merge 或已推送远端
        if (vcs.type !== 'git' || !postHead || !vcs.computeModeCNetChangedPaths) {
          if (remoteAdvanced) {
            return recover('REMOTE_PUSH_UNREVERTIBLE', `远端分支已推进至 ${postRemoteTip?.tip ?? '(未知)'}，无法本地撤销`);
          }
          await safeRevertToPreHead().catch(() => undefined);
          return abort('RUNNER_FAILED', '非 Git 环境不支持 Mode C 拓扑变更');
        }

        const topology = await vcs.computeModeCNetChangedPaths(preHead, postHead, [...trustedUpstreamTips]);
        const hasForbidden = topology.netChangedPaths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p));
        const symlinkBad = !hasForbidden && (await hasSymlinkEscape(vcs.root, topology.netChangedPaths));
        const outOfScope = topology.netChangedPaths.filter((p) => !allowedSet.has(p));
        const severeViolation = !modeCResult.ok
          || !verdict
          || branchSwitched
          || !topology.ok
          || topology.aiReviewTouched
          || aiReviewTampered
          || activeGitOp
          || hasForbidden
          || symlinkBad
          || topology.netChangedPaths.length === 0;
        const isMaterial = !severeViolation && (verdict!.verdict === 'material_change' || outOfScope.length > 0);

        if (remoteAdvanced) {
          // 情况 B-已推送：严禁 force push！任何违例或实质变化必须进 RECOVERY_REQUIRED / REMOTE_PUSH_UNREVERTIBLE
          if (severeViolation || isMaterial) {
            const detail = [
              `已推送提交：${postHead}`,
              `远端引用：${primaryRemoteRef}（${preRemoteTip?.tip.slice(0, 12) ?? ''} -> ${postRemoteTip?.tip.slice(0, 12) ?? changedRemoteRefs[0]?.after.slice(0, 12) ?? ''}）`,
              `原因：${severeViolation ? (branchSwitched ? `当前分支被切换（${preBranch} -> ${postBranch ?? 'detached'}）` : topology.diagnostic ?? (aiReviewTampered ? '篡改 .ai-review' : !verdict ? '缺少合法 JSON 裁决' : '硬护栏违例')) : (verdict?.verdict === 'material_change' ? verdict.summary : `越界路径 ${outOfScope.join(', ')}`)}`,
            ].join('；');
            return recover('REMOTE_PUSH_UNREVERTIBLE', detail, 'Mode C 已推送远端但未通过硬护栏，严禁强推覆盖，已保留现场待人工恢复');
          }
          // 若工作区在已推提交之上仍有未提交业务改动，同样视为不可自动收尾违例
          const workClean = await vcs.ensureCleanWorkspace();
          if (!workClean.clean) {
            return recover(
              'REMOTE_PUSH_UNREVERTIBLE',
              `已推送提交 ${postHead} 后工作区仍残留未提交业务改动（${workClean.dirtyPaths.join(', ')}），已保留现场待人工处理`,
            );
          }
          pushedModeC = {
            commit: postHead,
            remoteRef: primaryRemoteRef,
            expectedTreeHash: await vcs.getTreeHash?.('HEAD') ?? null,
          };
          applySummary = `Mode C 分支合并/推送等价适配（${postHead.slice(0, 12)}）：${verdict!.summary}`;
          appliedOk = true;
        } else {
          // 情况 B-本地（未 push）
          if (severeViolation) {
            await safeRevertToPreHead().catch(() => undefined);
            return abort(
              'RUNNER_FAILED',
              `Mode C 本地提交未通过硬护栏并已回滚至 ${preHead.slice(0, 12)}：${branchSwitched ? `当前分支被切换（${preBranch} -> ${postBranch ?? 'detached'}）` : topology.diagnostic ?? (aiReviewTampered ? '篡改 .ai-review' : !verdict ? '缺少合法 JSON' : '违例')}`,
            );
          }
          if (isMaterial) {
            const reasonText = verdict!.verdict === 'material_change'
              ? verdict!.summary
              : `本地提交/合并净改动超出获批源补丁范围（越界：${outOfScope.join(', ')}）`;
            return exportNewPatchAndFallback(reasonText);
          }
          // 确认工作区相对于 postHead 无额外未提交改动（若有，先纳入暂存快照或按 Case A 统一校验）
          const workClean = await vcs.ensureCleanWorkspace();
          if (!workClean.clean) {
            await safeRevertToPreHead().catch(() => undefined);
            return abort('RUNNER_FAILED', `Mode C 本地提交后工作区仍留有未提交改动（${workClean.dirtyPaths.join(', ')}），已回滚至 ${preHead.slice(0, 12)}`);
          }
          localModeC = {
            preHead,
            postHead,
            mergedParents: topology.mergedParents,
            commitCount: topology.commitCount,
            expectedTreeHash: await vcs.getTreeHash?.('HEAD') ?? null,
          };
          applySummary = `Mode C 本地提交/合并等价适配（${String(topology.commitCount)} 提交）：${verdict!.summary}`;
          appliedOk = true;
        }
      }
    }

    // 记录步骤 7 业务快照（用于步骤 9 门禁后防篡改核验）
    const businessPathsToVerify = approvedPatchPaths.filter((p) => isRepoRelativePath(p) && !isAiReviewPath(p));
    const preGateBusiness = await collectCommitEntries(vcs.root, businessPathsToVerify);
    const preGateSnapshotMap = new Map(preGateBusiness.entries.map((e) => [e.path, `${e.blobHash}:${e.mode ?? ''}`]));
    const preGateMissingSet = new Set(preGateBusiness.missing);

    // Step 8: 顺序执行所选方案的全部 gate_checks
    log(`步骤 8：在仓库根目录执行 ${String(option.gateChecks.length)} 条实际门禁`);
    const gateResults = await runGatesFn(option.gateChecks, {
      cwd: vcs.root,
      timeoutMs: settings.gateTimeoutMs,
      log,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (deps.signal?.aborted) {
      if (pushedModeC) {
        return recover(
          'REMOTE_PUSH_UNREVERTIBLE',
          `门禁执行期间任务被取消，但 Mode C 已推送业务提交 ${pushedModeC.commit} 至 ${pushedModeC.remoteRef}`,
          '门禁已取消但远端已有推送提交，已保留现场',
        );
      }
      try {
        if (localModeC && vcs.resetHard) await vcs.resetHard(localModeC.preHead);
        else if (patchRestore) await patchRestore();
        else await vcs.revertBusinessWorkspace();
      } catch (error) {
        return recover('RESTORE_INCOMPLETE', `取消门禁后还原工作区异常：${error instanceof Error ? error.message : String(error)}`);
      }
      const afterCancelClean = await vcs.ensureCleanWorkspace().catch(() => null);
      if (!afterCancelClean?.clean) {
        return recover('RESTORE_INCOMPLETE', `取消门禁后业务工作区未完全还原：${afterCancelClean?.dirtyPaths.join(', ') ?? '状态不可读'}`);
      }
      return abort('CANCELLED', '门禁执行期间任务已取消，已终止门禁并还原工作区');
    }
    const allGatesPassed = gateResults.length === option.gateChecks.length && gateResults.every((r) => r.passed && r.exitCode === 0);

    if (!allGatesPassed) {
      log('门禁验证失败：绝不自动调用 Agent，开始还原业务并记录 repair_failed');
      if (pushedModeC) {
        return recover(
          'REMOTE_PUSH_UNREVERTIBLE',
          `Mode C 已推送业务提交 ${pushedModeC.commit} 至 ${pushedModeC.remoteRef}，随后门禁失败且无法本地撤销，请人工处理远端分支`,
          '门禁失败但远端已被 Mode C 推送，严禁强推，已保留现场',
        );
      }

      // 还原业务改动（含 B-本地 commit/merge 回滚至 preHead；若持有补丁级精确还原句柄则避免误删并发草稿）
      try {
        if (localModeC && vcs.resetHard) {
          await vcs.resetHard(localModeC.preHead);
        } else if (patchRestore) {
          await patchRestore();
        } else {
          await vcs.revertBusinessWorkspace();
        }
      } catch (error) {
        return recover('RESTORE_INCOMPLETE', `门禁失败后还原业务工作区异常：${error instanceof Error ? error.message : String(error)}`);
      }
      const afterRestoreClean = await vcs.ensureCleanWorkspace();
      const restoredBase = await vcs.getCurrentBase();
      if (!afterRestoreClean.clean || restoredBase !== preHead) {
        return recover(
          'RESTORE_INCOMPLETE',
          `门禁失败后工作区未完全还原至 ${preHead}（当前 ${restoredBase ?? 'null'}，脏文件：${afterRestoreClean.dirtyPaths.join(', ')}）`,
        );
      }

      const failedSummary = gateResults
        .map((r) => `${r.command} -> exit ${String(r.exitCode)} (${String(r.durationMs)}ms)${r.passed ? ' PASS' : ' FAIL'}`)
        .join('；');
      const failedAttempt: RepairAttempt = {
        id: candidate.meta.repairAttempts.length + 1,
        optionId: option.id,
        patchId: patchEntry.id,
        baseRevision: currentBase,
        actor: input.actor,
        at: nextUpdatedAt(candidate.meta.updatedAt),
        applyMode,
        result: 'verification_failed',
        restored: true,
        evidence: `${applySummary}；门禁失败：${failedSummary}；已完整还原业务工作区至 ${preHead}`,
      };
      const updatedCandidate = await store.recordRepairFailure(candidate, failedAttempt);
      const failCommit = await vcs.atomicCommit({
        message: `review(${candidate.id}): 门禁验证失败已还原，标记 repair_failed [skip ci]`,
        paths: [updatedCandidate.reviewPath],
      });
      if (!failCommit.success || !failCommit.commitRevision) {
        return recover('COMMIT_OUTCOME_UNKNOWN', `已还原业务但提交 repair_failed 记录失败：${failCommit.errorOutput}`);
      }
      return {
        status: 'REPAIR_FAILED',
        jobId,
        reason: 'GATE_CHECK_FAILED',
        commitRevision: failCommit.commitRevision,
        gateResults,
        message: `门禁验证失败，已还原业务改动并将问题置为 repair_failed（补丁 #${String(patchEntry.id)} 已永久封禁）`,
      };
    }

    // Step 9: 门禁后二次防篡改核验
    log('步骤 9：门禁后二次核验共享守卫、负向记忆与业务内容快照');
    if (vcs.type === 'git' && preBranch !== null) {
      const branchAfterGate = (await vcs.getCurrentBranch?.()) ?? null;
      if (branchAfterGate !== preBranch) {
        return recover('SYNC_STATE_UNKNOWN', `门禁期间当前分支发生切换（${preBranch} -> ${branchAfterGate ?? 'detached'}），已保留现场并停止提交`);
      }
    }
    const postGateRecheck = await validatePreconditions();
    if ('status' in postGateRecheck) {
      if (pushedModeC) return recover('REMOTE_PUSH_UNREVERTIBLE', `门禁通过但共享状态已变化（${postGateRecheck.message}），且业务提交 ${pushedModeC.commit} 已推送`);
      if (localModeC && vcs.resetHard) await vcs.resetHard(localModeC.preHead).catch(() => undefined);
      else await vcs.revertBusinessWorkspace().catch(() => undefined);
      return postGateRecheck;
    }

    const postGateBusiness = await collectCommitEntries(vcs.root, businessPathsToVerify);
    const postGateMap = new Map(postGateBusiness.entries.map((e) => [e.path, `${e.blobHash}:${e.mode ?? ''}`]));
    const postGateMissing = new Set(postGateBusiness.missing);
    let contentChanged = postGateMap.size !== preGateSnapshotMap.size || postGateMissing.size !== preGateMissingSet.size;
    if (!contentChanged) {
      for (const [p, sig] of preGateSnapshotMap) {
        if (postGateMap.get(p) !== sig) { contentChanged = true; break; }
      }
    }
    if (!contentChanged && localModeC && (await vcs.getTreeHash?.('HEAD')) !== localModeC.expectedTreeHash) {
      contentChanged = true;
    }
    if (!contentChanged && pushedModeC && (await vcs.getTreeHash?.('HEAD')) !== pushedModeC.expectedTreeHash) {
      contentChanged = true;
    }
    // 检查门禁是否生成了范围外的额外未追踪业务文件
    if (!contentChanged && !localModeC && !pushedModeC) {
      const statusNow = await vcs.ensureCleanWorkspace();
      const extraDirty = statusNow.dirtyPaths.filter((p) => !businessPathsToVerify.includes(p));
      if (extraDirty.length > 0) contentChanged = true;
    }

    if (contentChanged) {
      if (pushedModeC) {
        return recover('REMOTE_PUSH_UNREVERTIBLE', `门禁后业务内容快照变化且提交 ${pushedModeC.commit} 已推送远端`);
      }
      if (localModeC && vcs.resetHard) await vcs.resetHard(localModeC.preHead).catch(() => undefined);
      else await vcs.revertBusinessWorkspace().catch(() => undefined);
      return abort('BUSINESS_CONTENT_CHANGED', '门禁执行期间业务文件内容发生变化，已拒绝提交并还原工作区');
    }

    // Step 10: 落地提交
    log('步骤 10：写入批准记录并执行原子落地提交');
    if (pushedModeC) {
      const landed = await landMetaClosingCommitForPushed({
        deps,
        input,
        snapshot,
        pushedHash: pushedModeC.commit,
        gateResults,
        applyMode,
        base: currentBase,
        summary: applySummary,
      });
      if (landed.retry) {
        pushedCommitCarriedOver = {
          commit: pushedModeC.commit,
          remoteRef: pushedModeC.remoteRef,
          treeHash: pushedModeC.expectedTreeHash,
          summary: applySummary,
          gateResults,
          snapshot,
          applyMode,
          base: currentBase,
        };
        continue;
      }
      return landed.outcome;
    }

    const approvedAt = nextUpdatedAt(candidate.meta.updatedAt);
    const successAttempt: RepairAttempt = {
      id: candidate.meta.repairAttempts.length + 1,
      optionId: option.id,
      patchId: patchEntry.id,
      baseRevision: currentBase,
      actor: input.actor,
      at: approvedAt,
      applyMode,
      result: 'applied',
      restored: false,
      evidence: `${applySummary}；全部 ${String(gateResults.length)} 项门禁通过`,
    };
    const approvalInfo: ApprovalInfo = {
      approvedBy: input.actor,
      approvedAt,
      recordRevision: candidate.meta.recordRevision,
      optionId: option.id,
      patchId: patchEntry.id,
      patchSha256: patchEntry.sha256,
      repairAttemptId: successAttempt.id,
      baseRevision: currentBase,
      gateChecks: [...option.gateChecks],
      gateResults: gateResults.map((r) => ({
        command: r.command,
        exitCode: r.exitCode ?? 0,
        durationMs: r.durationMs,
      })),
      confirmedDecisions: [...input.confirmedDecisions],
      waivedDecisions: input.waivedDecisions.map((w) => ({ id: w.id, reason: w.reason.trim() })),
    };

    const reviewBackup = await readFile(candidate.reviewPath, 'utf8');
    const updatedCandidate = await store.applyApproval(candidate, {
      approval: approvalInfo,
      attempt: successAttempt,
      commitMessage: snapshot.commitMessage,
      now: new Date(approvedAt),
    });

    const vcsCommitMessage = await assembleFinalCommitMessage({
      candidate,
      optionId: option.id,
      patchId: patchEntry.id,
      patchText,
      commitMessage: snapshot.commitMessage,
      commitDetail: input.commitDetail,
      vcs,
    });

    const relReviewPath = `.ai-review/${candidate.id}/review.md`;
    const updatedReviewBytes = await readFile(updatedCandidate.reviewPath);
    const expectedReviewBlob = gitBlobHash(updatedReviewBytes);

    let commitResult;
    let commitThrew = false;
    const probePaths = [relReviewPath, ...businessPathsToVerify];
    const probeBefore = await vcs.getCommitProbe(probePaths).catch(() => null);
    if (vcs.type === 'git' && preBranch !== null) {
      const branchBeforeCommit = (await vcs.getCurrentBranch?.()) ?? null;
      if (branchBeforeCommit !== preBranch) {
        await writeFile(candidate.reviewPath, reviewBackup, 'utf8').catch(() => undefined);
        return recover('SYNC_STATE_UNKNOWN', `提交前当前分支发生切换（${preBranch} -> ${branchBeforeCommit ?? 'detached'}），已停止提交并保留现场`);
      }
    }

    try {
      if (localModeC) {
        if (localModeC.commitCount === 1 && vcs.amendCommitWithReview) {
          commitResult = await vcs.amendCommitWithReview({
            reviewPath: relReviewPath,
            expectedReviewBlob,
            message: vcsCommitMessage,
          });
        } else if (vcs.collapseLocalCommitsWithReview) {
          commitResult = await vcs.collapseLocalCommitsWithReview({
            preHead: localModeC.preHead,
            mergedParents: localModeC.mergedParents,
            reviewPath: relReviewPath,
            expectedReviewBlob,
            message: vcsCommitMessage,
          });
        } else {
          commitResult = { success: false, commitRevision: null, outOfDate: false, errorOutput: '缺少本地提交收拢能力' };
        }
      } else {
        const verifyEntries: ExpectedCommitEntry[] = [
          ...preGateBusiness.entries,
          { path: relReviewPath, blobHash: expectedReviewBlob },
        ];
        const gitTarget = vcs.type === 'git' ? (await vcs.getApprovalTarget?.()) ?? undefined : undefined;
        commitResult = await vcs.atomicCommit({
          message: vcsCommitMessage,
          paths: [...businessPathsToVerify, relReviewPath],
          verifyEntries,
          verifyDeletions: preGateBusiness.missing,
          ...(gitTarget ? { gitTarget } : {}),
        });
      }
    } catch (error) {
      commitThrew = true;
      commitResult = {
        success: false,
        commitRevision: null,
        outOfDate: false,
        errorOutput: error instanceof Error ? error.message : String(error),
      };
    }

    if (commitResult.success && commitResult.commitRevision) {
      log(`步骤 11：批准原子提交成功（${commitResult.commitRevision.slice(0, 12)}）`);
      return {
        status: 'COMMITTED',
        jobId,
        commitRevision: commitResult.commitRevision,
        gateResults,
        message: `批准并提交成功：${commitResult.commitRevision.slice(0, 12)}`,
      };
    }

    if (commitResult.verificationFailed) {
      return recover('COMMIT_OUTCOME_UNKNOWN', `提交后核验失败，现场保留待核对：${commitResult.errorOutput}`);
    }

    // 三分支恢复判定（SPEC §8.3）
    const probeAfter = await vcs.getCommitProbe(probePaths).catch(() => null);
    if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
      const committedReview = await vcs.readFileAt(probeAfter, relReviewPath).catch(() => null);
      if (committedReview !== null && gitBlobHash(committedReview) === expectedReviewBlob) {
        return {
          status: 'COMMITTED',
          jobId,
          commitRevision: probeAfter,
          gateResults,
          message: `提交命令异常但已核实落地（${probeAfter.slice(0, 12)}）`,
        };
      }
      return recover('COMMIT_OUTCOME_UNKNOWN', `提交探针已变化但内容无法核对一致：${commitResult.errorOutput}`);
    }

    if (commitThrew || probeBefore === null || probeAfter === null) {
      return recover('COMMIT_OUTCOME_UNKNOWN', `提交命令异常中断或无法读取探针，现场保留待人工核对：${commitResult.errorOutput}`);
    }

    // 探针证明未提交：先撤销暂存并还原 review.md 与业务改动，再二次校验工作区干净
    try {
      await commitResult.restorePreparation?.();
      await writeFile(candidate.reviewPath, reviewBackup, 'utf8');
      if (localModeC && vcs.resetHard) await vcs.resetHard(localModeC.preHead);
      else await vcs.revertBusinessWorkspace();
    } catch (error) {
      return recover('RESTORE_INCOMPLETE', `提交失败后还原不完整：${error instanceof Error ? error.message : String(error)}`);
    }
    const postRevertClean = await vcs.ensureCleanWorkspace().catch(() => null);
    if (!postRevertClean?.clean) {
      return recover(
        'RESTORE_INCOMPLETE',
        `提交失败后业务工作区未能恢复干净：${postRevertClean?.dirtyPaths.join(', ') ?? '状态不可读'}`,
      );
    }

    if (commitResult.outOfDate || commitResult.targetChanged) {
      if (attemptNumber < MAX_COMMIT_RETRIES) {
        log(`提交撞车（${commitResult.errorOutput}），已还原，准备重试`);
        continue;
      }
      return abort('MAX_RETRIES_EXCEEDED', `提交连续撞车耗尽重试上限：${commitResult.errorOutput}`);
    }

    return abort('COMMIT_FAILED', `原子提交失败并已完整还原：${commitResult.errorOutput}`);
  }

  return abort('MAX_RETRIES_EXCEEDED', '批准重试次数耗尽');
}

async function landMetaClosingCommitForPushed(params: {
  deps: ApprovalDeps;
  input: ApproveInput;
  snapshot: ValidatedSnapshot;
  pushedHash: string;
  gateResults: GateCheckResult[];
  applyMode: RepairApplyMode;
  base: string;
  summary: string;
}): Promise<{ retry: true } | { retry: false; outcome: ApprovalOutcome }> {
  const { deps, input, snapshot, pushedHash, gateResults, applyMode, base, summary } = params;
  const { store, vcs, jobId } = deps;
  const { candidate, option, patchEntry } = snapshot;
  const relReviewPath = `.ai-review/${candidate.id}/review.md`;
  const reviewBackup = await readFile(candidate.reviewPath, 'utf8');
  const approvedAt = nextUpdatedAt(candidate.meta.updatedAt);

  const successAttempt: RepairAttempt = {
    id: candidate.meta.repairAttempts.length + 1,
    optionId: option.id,
    patchId: patchEntry.id,
    baseRevision: base,
    actor: input.actor,
    at: approvedAt,
    applyMode,
    result: 'applied',
    restored: false,
    evidence: `${summary}；全部 ${String(gateResults.length)} 项门禁通过（已推送业务提交 ${pushedHash}）`,
  };
  const approvalInfo: ApprovalInfo = {
    approvedBy: input.actor,
    approvedAt,
    recordRevision: candidate.meta.recordRevision,
    optionId: option.id,
    patchId: patchEntry.id,
    patchSha256: patchEntry.sha256,
    repairAttemptId: successAttempt.id,
    baseRevision: base,
    gateChecks: [...option.gateChecks],
    gateResults: gateResults.map((r) => ({
      command: r.command,
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs,
    })),
    confirmedDecisions: [...input.confirmedDecisions],
    waivedDecisions: input.waivedDecisions.map((w) => ({ id: w.id, reason: w.reason.trim() })),
    businessCommit: pushedHash,
  };

  const updatedCandidate = await store.applyApproval(candidate, {
    approval: approvalInfo,
    attempt: successAttempt,
    commitMessage: snapshot.commitMessage,
    now: new Date(approvedAt),
  });
  const expectedReviewBlob = gitBlobHash(await readFile(updatedCandidate.reviewPath));
  const probeBefore = await vcs.getCommitProbe([relReviewPath]).catch(() => null);
  let metaCommit;
  let commitThrew = false;
  try {
    metaCommit = await vcs.atomicCommit({
      message: `review(${candidate.id}): 关闭已推送业务提交 ${pushedHash.slice(0, 12)} 的审批记录 [skip ci]`,
      paths: [relReviewPath],
      verifyEntries: [{ path: relReviewPath, blobHash: expectedReviewBlob }],
    });
  } catch (error) {
    commitThrew = true;
    metaCommit = {
      success: false,
      commitRevision: null,
      outOfDate: false,
      errorOutput: error instanceof Error ? error.message : String(error),
    };
  }

  const buildCommitted = (closingRev: string): { retry: false; outcome: ApprovalOutcome } => {
    const pushHint = deps.isManaged
      ? ''
      : `（元数据关闭提交 ${closingRev.slice(0, 12)} 尚未推送，请手动推送至远端）`;
    return {
      retry: false,
      outcome: {
        status: 'COMMITTED',
        jobId,
        // SPEC §5.5 步骤 11：情况 B-已推送的 commitRevision 返回已推送业务提交 P（与派生一致），closingCommitRevision 记录 C_meta 供托管交付。
        commitRevision: pushedHash,
        closingCommitRevision: closingRev,
        gateResults,
        message: `批准并关闭成功，业务提交：${pushedHash.slice(0, 12)}，关闭提交：${closingRev.slice(0, 12)}${pushHint}`,
      },
    };
  };

  if (metaCommit.success && metaCommit.commitRevision) {
    return buildCommitted(metaCommit.commitRevision);
  }

  if (metaCommit.verificationFailed) {
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: `业务提交 ${pushedHash} 已推送，元数据关闭提交 C_meta 核验失败，现场保留：${metaCommit.errorOutput}`,
        message: '已推送业务提交但元数据关闭提交核验失败，请人工确认',
      },
    };
  }

  // SPEC §8.3 三分支探针：确认 C_meta 未落地后才允许恢复 review.md，绝不覆盖已落地提交或回滚至 preHead！
  const probeAfter = await vcs.getCommitProbe([relReviewPath]).catch(() => null);
  if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
    const committedReview = await vcs.readFileAt(probeAfter, relReviewPath).catch(() => null);
    if (committedReview !== null && gitBlobHash(committedReview) === expectedReviewBlob) {
      return buildCommitted(probeAfter);
    }
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: `业务提交 ${pushedHash} 已推送，C_meta 提交探针已变化但内容无法核对一致：${metaCommit.errorOutput}`,
        message: '已推送业务提交但元数据关闭提交状态不明，请人工确认',
      },
    };
  }
  if (commitThrew || probeBefore === null || probeAfter === null) {
    return {
      retry: false,
      outcome: {
        status: 'RECOVERY_REQUIRED',
        jobId,
        reason: 'COMMIT_OUTCOME_UNKNOWN',
        detail: `业务提交 ${pushedHash} 已推送，C_meta 提交中断或探针不可读，现场保留：${metaCommit.errorOutput}`,
        message: '已推送业务提交但元数据关闭提交结果不明，请人工确认',
      },
    };
  }

  // 已证明 C_meta 未落地：仅还原 review.md 回到 P，绝不回滚至 preHead！
  await metaCommit.restorePreparation?.().catch(() => undefined);
  await writeFile(candidate.reviewPath, reviewBackup, 'utf8').catch(() => undefined);

  if (metaCommit.outOfDate) {
    return { retry: true };
  }
  return {
    retry: false,
    outcome: {
      status: 'RECOVERY_REQUIRED',
      jobId,
      reason: 'COMMIT_OUTCOME_UNKNOWN',
      detail: `业务提交 ${pushedHash} 已推送，但创建元数据关闭提交 C_meta 失败：${metaCommit.errorOutput}`,
      message: '已推送业务提交但元数据关闭提交失败，请人工确认',
    },
  };
}

async function assembleFinalCommitMessage(params: {
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
