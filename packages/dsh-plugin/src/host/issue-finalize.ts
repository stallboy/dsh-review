/**
 * 审查统一收尾事务（SPEC §5.6 / I15 / I18）：
 * 核验执行停止 → 强制还原非 .ai-review/ 与清理 .tmp/ → 校验归档证据、review.md (schema_version: 1)、
 * 补丁 sha256 与只读应用预检（绝不应用待审补丁或跑修复门禁）→ 写入唯一插件核验块 → 原子提交并释放租约。
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AuditArchive,
  auditInvariantErrors,
  parseAuditMarkdown,
  scopeCovers,
  serializeAuditMarkdown,
  upsertAuditVerificationBlock,
  type AuditFrontmatter,
  type AuditTrigger,
} from './audit-archive.js';
import { auditFiles } from './audit-files.js';
import { assertStageArtifacts, compatibleAuditBase, type StageSeal } from './audit-stage-artifacts.js';
import { stampSvnApprovalSource } from './approval-merge-snapshots.js';
import { parseReviewMarkdown } from './frontmatter.js';
import { isRepoRelativePath } from './invariants.js';
import { sha256Hex } from './issue-review.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers, resolveOwner } from './reviewers.js';
import { validateReviewData } from './review-data-validation.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import { gitBlobHash, type VcsAdapter } from './vcs.js';
import type { AuditCandidateResult, AuditOutcome, PatchStats, ReviewDataFileValidation } from './types.js';

const EMPTY_STATS: PatchStats = { files: 0, additions: 0, deletions: 0, entries: [] };

export interface IssueFinalizeDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  log: (line: string) => void;
  candidateSource?: SharedCandidateSource;
  signal?: AbortSignal;
  scheduledBaseMatches?: () => Promise<boolean>;
}

export interface IssueFinalizeInput {
  auditId: string;
  baseRevision: string;
  targetPath: string;
  trigger: AuditTrigger;
  svnUrl?: string;
  beforeIds: Set<string>;
  publishedIssueIds?: string[];
  stageSeal?: StageSeal;
  runError: string | null;
  extraWarnings?: string[];
  now?: Date;
}

export interface IssueFinalizeResult {
  status: 'COMMITTED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';
  reason?: AuditOutcome['reason'];
  detail?: string;
  commitRevision: string | null;
  reportPath: string;
  body: string;
  issues: string[];
  created: AuditCandidateResult[];
  dataValidation: ReviewDataFileValidation[];
  warnings: string[];
  message: string;
}

async function collectEvidencePaths(repoRoot: string, relDir: string, errors: string[]): Promise<string[]> {
  const abs = path.join(repoRoot, relDir);
  const info = await lstat(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : 'error'));
  if (info === null) return [];
  if (info === 'error' || !info.isDirectory() || info.isSymbolicLink()) {
    errors.push(`归档证据目录非法（非普通目录或含符号链接）：${relDir}`);
    return [];
  }
  const files: string[] = [];
  const walk = async (currentRel: string): Promise<void> => {
    const entries = await readdir(path.join(repoRoot, currentRel), { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = `${currentRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        errors.push(`归档证据不允许符号链接：${nextRel}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(nextRel);
      } else if (entry.isFile()) {
        files.push(nextRel);
      } else {
        errors.push(`归档证据包含非常规文件：${nextRel}`);
      }
    }
  };
  await walk(relDir);
  return files.sort();
}

export async function finalizeIssueAudit(
  deps: IssueFinalizeDeps,
  input: IssueFinalizeInput,
): Promise<IssueFinalizeResult> {
  const { store, vcs, log } = deps;
  const now = input.now ?? new Date();
  const warnings = [...(input.extraWarnings ?? [])];
  const dataValidation: ReviewDataFileValidation[] = [];
  const reportPath = `.ai-review/audits/${input.auditId}/audit.md`;
  const scope = input.targetPath || '.';

  const recovery = (reason: AuditOutcome['reason'], detail: string): IssueFinalizeResult => ({
    status: 'RECOVERY_REQUIRED',
    reason,
    detail,
    commitRevision: null,
    reportPath,
    body: '',
    issues: [],
    created: [],
    dataValidation,
    warnings,
    message: `审查收尾进入恢复态：${detail}`,
  });

  const aborted = (message: string): IssueFinalizeResult => ({
    status: 'ABORTED',
    commitRevision: null,
    reportPath,
    body: '',
    issues: [],
    created: [],
    dataValidation,
    warnings: [...warnings, message],
    message,
  });

  if (deps.signal?.aborted) return aborted('审查收尾已取消');

  // I18：强制还原非 .ai-review/ 改动并清空 .tmp/，然后确认业务工作区彻底干净。
  await vcs.revertBusinessWorkspace().catch((error: unknown) => {
    warnings.push(`还原业务工作区提示：${error instanceof Error ? error.message : String(error)}`);
  });
  const clean = await vcs.ensureCleanWorkspace().catch(() => null);
  if (!clean?.clean) {
    return recovery('SYNC_STATE_UNKNOWN', `收尾前业务工作区未完全还原干净：${clean?.dirtyPaths.join(', ') ?? '状态不可读'}`);
  }

  // 确认基线未漂移
  const baseSafe = (deps.scheduledBaseMatches ? await deps.scheduledBaseMatches().catch(() => false) : true)
    && (await compatibleAuditBase(vcs, input.baseRevision, input.svnUrl).catch(() => false));
  if (!baseSafe) {
    return recovery('SYNC_STATE_UNKNOWN', '审查收尾前起始业务基线或绑定分支发生变化，现场保留待核验');
  }

  // 读取审查档案草稿（若已由 publishAuditStages 封存，先校验封存清单）
  if (input.stageSeal && input.publishedIssueIds) {
    try {
      await assertStageArtifacts(store.repoRoot, input.stageSeal, input.publishedIssueIds);
    } catch (error) {
      return recovery('SYNC_STATE_UNKNOWN', `阶段封存产物核验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const archive = new AuditArchive(store.repoRoot);
  // I12：在读写正式档案前校验路径，拒绝符号链接或目录重定向。
  let rawAudit: string | null = null;
  try {
    const readRes = await auditFiles(store.repoRoot, { op: 'read', paths: [reportPath] });
    rawAudit = readRes.bytes ? readRes.bytes.toString('utf8') : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dataValidation.push({ path: reportPath, errors: [detail] });
    return recovery('SYNC_STATE_UNKNOWN', detail);
  }
  const reviewersConfig = await loadReviewers(store.repoRoot, deps.candidateSource).catch(() => null);
  let auditMeta: AuditFrontmatter;
  let auditBody: string;

  if (rawAudit !== null) {
    try {
      const parsed = parseAuditMarkdown(rawAudit);
      auditMeta = parsed.meta;
      auditBody = parsed.body;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dataValidation.push({ path: reportPath, errors: [detail] });
      return aborted(`audit.md 格式校验失败：${detail}`);
    }
  } else {
    const existingAudits = await archive.list(deps.candidateSource);
    const previous = existingAudits.find((a) => !a.parseError && a.auditId !== input.auditId)?.auditId ?? null;
    const diskIds = await store.listCandidateIds();
    const discoveredIssues = input.publishedIssueIds ?? diskIds.filter((id) => !input.beforeIds.has(id));
    if (input.runError && discoveredIssues.length === 0) {
      return aborted(`审查执行异常且未生成任何产物：${input.runError}`);
    }
    auditMeta = {
      schemaVersion: 1,
      auditId: input.auditId,
      createdAt: (await import('./audit-archive.js')).auditIdTimestampUtc(input.auditId) ?? now.toISOString(),
      baseRevision: input.baseRevision,
      scope,
      trigger: input.trigger,
      previousAudit: previous,
      issues: discoveredIssues,
    };
    auditBody = [
      '# 仓库审查报告',
      '',
      '## 审查目标与范围',
      `- 目标目录：\`${scope}\``,
      `- 起始基线：\`${input.baseRevision}\``,
      '',
      '## 优先级总览',
      ...(discoveredIssues.length === 0 ? ['- 无'] : discoveredIssues.map((id) => `- \`${id}\``)),
      '',
      '## 覆盖说明与未覆盖风险',
      input.runError ? `- 执行器异常结束：${input.runError}` : '- AI 未写入审查报告，已由插件生成回退索引。',
    ].join('\n');
    warnings.push('AI 未写入 audit.md，已由插件生成回退索引');
  }

  const issueIds = [...new Set(input.publishedIssueIds ?? auditMeta.issues)];
  const created: AuditCandidateResult[] = [];
  const validIssueIds: string[] = [];
  const validCommitPaths = new Set<string>([reportPath]);

  // 校验本轮 audit 级归档证据
  const evidenceErrors: string[] = [];
  for (const evFile of await collectEvidencePaths(store.repoRoot, `.ai-review/audits/${input.auditId}/evidence`, evidenceErrors)) {
    validCommitPaths.add(evFile);
  }

  // 逐问题核验：schema_version: 1 不变量、范围覆盖、补丁 sha256 与只读应用预检
  for (const id of issueIds) {
    const relReview = `.ai-review/${id}/review.md`;
    const result: AuditCandidateResult = {
      id,
      title: id,
      owner: '',
      status: 'pending',
      patch: '',
      baseRevision: input.baseRevision,
      patchStats: EMPTY_STATS,
      gateChecks: 0,
      errors: [],
    };
    try {
      const { bytes } = await auditFiles(store.repoRoot, { op: 'read', paths: [relReview] });
      if (!bytes) throw new Error('问题 review.md 不存在');
      const quickErrs = validateReviewData(relReview, bytes);
      if (quickErrs.length > 0) result.errors.push(...quickErrs);

      const detail = await store.get(id, input.baseRevision);
      if (detail.candidate.parseError) {
        result.errors.push(detail.candidate.parseError);
      } else {
        const meta = detail.candidate.meta;
        result.findingId = meta.findingId;
        result.title = meta.title;
        result.owner = meta.owner;
        result.status = meta.status;
        result.issueKind = meta.issueKind;
        result.baseRevision = meta.baseRevision;
        result.patchStats = detail.patchStats;
        result.gateChecks = meta.options[0]?.gateChecks.length ?? 0;
        result.patch = detail.patchEntry?.patch ?? '';

        if (!scopeCovers(scope, meta.observations.flatMap((o) => o.evidence.map((e) => e.path)))) {
          result.errors.push(`问题 ${id} 的观察证据路径超出本轮审查范围 ${scope}`);
        }
        if (input.beforeIds.has(id) && deps.candidateSource) {
          const [priorMonth, priorSlug] = id.split('/');
          if (priorMonth && priorSlug) {
            const priorShared = await store.loadCandidate(priorMonth, priorSlug, deps.candidateSource);
            if (priorShared && !priorShared.parseError && meta.owner !== priorShared.meta.owner) {
              result.errors.push(`不能改写既有共享问题的负责人（当前共享负责人：${priorShared.meta.owner}，提交值：${meta.owner}）`);
            }
          }
        } else if (reviewersConfig?.valid && !input.beforeIds.has(id)) {
          const expectedOwner = resolveOwner(reviewersConfig, { paths: meta.targetFiles, tags: meta.tags }).owner;
          if (expectedOwner && meta.owner !== expectedOwner) {
            result.errors.push(`owner 应为 ${expectedOwner}（当前为 ${meta.owner}）`);
          }
        }
        result.errors.push(...(await store.validateFullCandidate(detail.candidate)));

        // 对所有当前有效方案的最新补丁做只读应用预检（绝不应用待审补丁、绝不跑修复门禁；已解决/已批准问题不重检历史补丁）
        if (meta.status !== 'resolved' && meta.status !== 'approved') {
          for (const option of meta.options) {
            const patchEntry = meta.patches.find((p) => p.id === option.currentPatch);
            if (!patchEntry) continue;
            const patchAbs = path.join(detail.candidate.dirPath, patchEntry.patch);
            const rawBytes = await readFile(patchAbs).catch(() => null);
            if (!rawBytes) {
              result.errors.push(`补丁文件缺失：${patchEntry.patch}`);
              continue;
            }
            if (sha256Hex(rawBytes) !== patchEntry.sha256) {
              result.errors.push(`补丁 ${patchEntry.patch} sha256 不匹配`);
            }
            const parsed = parsePatch(rawBytes.toString('utf8'));
            if (parsed.paths.some((p) => !isRepoRelativePath(p) || isAiReviewPath(p))) {
              result.errors.push(`补丁 ${patchEntry.patch} 触及禁止路径`);
            }
            const check = await vcs.checkPatch(patchAbs);
            if (!check.ok) {
              result.errors.push(`补丁 ${patchEntry.patch} 只读应用预检失败：${check.message}`);
            }
            if (vcs.type === 'svn' && result.errors.length === 0) {
              const stamped = await stampSvnApprovalSource(vcs, patchEntry, parsed.paths);
              if (stamped) await store.write(detail.candidate, { touchUpdatedAt: false });
            }
          }
        }

        // 收集该问题目录的 review.md、所有 patches 与归档 evidence
        if (result.errors.length === 0) {
          validIssueIds.push(id);
          validCommitPaths.add(relReview);
          for (const patchEntry of meta.patches) {
            validCommitPaths.add(`.ai-review/${id}/${patchEntry.patch}`);
          }
          const issueEv = await collectEvidencePaths(store.repoRoot, `.ai-review/${id}/evidence`, result.errors);
          for (const evFile of issueEv) validCommitPaths.add(evFile);
        }
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    dataValidation.push({ path: relReview, errors: result.errors });
    created.push(result);
  }

  if (evidenceErrors.length > 0) {
    warnings.push(...evidenceErrors);
  }

  // 当本轮存在候选问题且全部未通过校验时，拒绝推进共享提交并保留现场供修正
  if (created.length > 0 && validIssueIds.length === 0) {
    return {
      status: 'VALIDATION_FAILED',
      commitRevision: null,
      reportPath,
      body: auditBody,
      issues: [],
      created,
      dataValidation,
      warnings,
      message: `本轮全部 ${String(created.length)} 个问题均未通过校验，未执行共享提交`,
    };
  }

  // 生成唯一插件核验块并写回 audit.md
  const verificationBlock = [
    '## 插件核验',
    `- 核验时间：${now.toISOString()}`,
    `- 起始基线：${input.baseRevision}`,
    `- 范围：${scope}`,
    '- 执行器停止状态：已确认全部阶段及子进程树退出',
    '- 工作区还原状态：业务工作区干净，非 .ai-review/ 零残留，.tmp/ 已清理',
    `- 索引问题数：${String(validIssueIds.length)}（总计检查 ${String(created.length)} 项，失败 ${String(created.filter((c) => c.errors.length > 0).length)} 项）`,
    '- 门禁声明：审查阶段未应用待审补丁，仅完成格式、哈希与只读预检；实际修复门禁留待人工批准后执行。',
    ...(warnings.length > 0 ? ['', '### 核验提示', ...warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');

  const finalAuditMeta: AuditFrontmatter = { ...auditMeta, issues: validIssueIds };
  const finalBody = upsertAuditVerificationBlock(auditBody, verificationBlock);
  const auditErrors = auditInvariantErrors(finalAuditMeta, input.auditId, finalBody);
  if (auditErrors.length > 0) {
    dataValidation.push({ path: reportPath, errors: auditErrors });
    return aborted(`正式 audit.md 不变量校验失败：${auditErrors.join('；')}`);
  }

  await archive.writeAudit(finalAuditMeta, finalBody);
  const finalAuditText = serializeAuditMarkdown(finalAuditMeta, finalBody);
  dataValidation.push({ path: reportPath, errors: [] });

  const commitPathList = [...validCommitPaths].sort();
  const snapshot = await auditFiles(store.repoRoot, { op: 'snapshot', paths: commitPathList }).catch(() => null);
  if (!snapshot?.entries) {
    return aborted('无法安全采集审查收尾提交快照');
  }

  const probeBefore = await vcs.getCommitProbe(commitPathList).catch(() => null);
  const commit = await vcs.atomicCommit({
    message: `audit(${scope === '.' ? 'repo' : scope}): 仓库审查归档 ${String(validIssueIds.length)} 个问题 [skip ci]`,
    paths: commitPathList,
    verifyEntries: snapshot.entries,
  });

  if (commit.verificationFailed) {
    return recovery('COMMIT_OUTCOME_UNKNOWN', `审查收尾提交核验失败：${commit.errorOutput}`);
  }
  if (commit.success && commit.commitRevision) {
    const hasInvalid = created.some((item) => item.errors.length > 0);
    const status = hasInvalid ? 'VALIDATION_FAILED' : 'COMMITTED';
    log(`审查收尾提交成功（${commit.commitRevision.slice(0, 12)}），状态 ${status}`);
    return {
      status,
      commitRevision: commit.commitRevision,
      reportPath,
      body: finalBody,
      issues: validIssueIds,
      created,
      dataValidation,
      warnings,
      message: hasInvalid
        ? `审查部分问题未通过校验，已提交 ${String(validIssueIds.length)} 个合法问题与报告`
        : `审查收尾已提交（${String(validIssueIds.length)} 个问题，${commit.commitRevision.slice(0, 12)}）`,
    };
  }

  // 失败三分支判定（SPEC §8.3）
  const probeAfter = await vcs.getCommitProbe(commitPathList).catch(() => null);
  if (probeBefore !== null && probeAfter !== null && probeAfter !== probeBefore) {
    const committedReport = await vcs.readFileAt(probeAfter, reportPath).catch(() => null);
    if (committedReport !== null && gitBlobHash(committedReport) === gitBlobHash(finalAuditText)) {
      const hasInvalid = created.some((item) => item.errors.length > 0);
      return {
        status: hasInvalid ? 'VALIDATION_FAILED' : 'COMMITTED',
        commitRevision: probeAfter,
        reportPath,
        body: finalBody,
        issues: validIssueIds,
        created,
        dataValidation,
        warnings,
        message: `提交命令异常但核实已落地（${probeAfter.slice(0, 12)}）`,
      };
    }
    return recovery('COMMIT_OUTCOME_UNKNOWN', `提交探针变化但内容无法核实：${commit.errorOutput}`);
  }
  if (probeBefore === null || probeAfter === null) {
    return recovery('COMMIT_OUTCOME_UNKNOWN', `无法读取提交探针核实结果：${commit.errorOutput}`);
  }

  await commit.restorePreparation?.().catch(() => undefined);
  return aborted(`审查收尾提交失败（未产生共享提交）：${commit.errorOutput}`);
}
