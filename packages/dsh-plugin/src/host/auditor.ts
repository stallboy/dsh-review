/**
 * 仓库审查目标校验与统一总调度执行器（SPEC §5.6 / §9.11）：
 * 手动与定时审查完全共用同一套总调度 + 阶段通道 + finalizeIssueAudit 流水线，不设独立历史复查旁路。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AuditArchive, type AuditTrigger } from './audit-archive.js';
import { AUDIT_TIMEOUT_MS, type AuditLeaseRecord } from './audit-lifecycle.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import { AuditStageSession } from './audit-stages.js';
import type { AuditStage } from './audit-prompts.js';
import type { AuditExecutor, ExecuteAuditStage } from './audit-stage-runner.js';
import type { StageSeal } from './audit-stage-artifacts.js';
import { finalizeIssueAudit } from './issue-finalize.js';
import { formatMemorySummary, topPerModule } from './memory.js';
import type { RepoRecoveryStore } from './recovery-store.js';
import { requireValidReviewers } from './reviewers.js';
import { runAgent } from './runner.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import type { VcsAdapter } from './vcs.js';
import { ApiError, type AppSettings, type AuditOutcome } from './types.js';

export function normalizeAuditTarget(
  repoRoot: string,
  raw: string,
): { targetPath: string; absolutePath: string } {
  const root = path.resolve(repoRoot);
  const trimmed = raw.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (trimmed === '.' || trimmed === '') {
    return { targetPath: '', absolutePath: root };
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) {
    throw new ApiError(400, 'bad_request', '审查目标必须是仓库内的相对路径');
  }
  const absolute = path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ApiError(400, 'bad_request', '审查目标越界：必须位于当前仓库内');
  }
  const targetPath = relative.replaceAll('\\', '/');
  if (targetPath === '.ai-review' || targetPath.startsWith('.ai-review/')) {
    throw new ApiError(400, 'bad_request', '不能审查 .ai-review 数据目录本身');
  }
  return { targetPath, absolutePath: absolute };
}

export async function resolveAuditTarget(
  repoRoot: string,
  raw: string,
): Promise<{ targetPath: string; absolutePath: string }> {
  const target = normalizeAuditTarget(repoRoot, raw);
  try {
    await stat(target.absolutePath);
  } catch {
    throw new ApiError(400, 'bad_request', `审查目标不存在：${target.targetPath || '.'}`);
  }
  return target;
}

export async function negativeMemoryLines(
  store: ReviewStore,
  source?: SharedCandidateSource,
): Promise<string> {
  try {
    const { entries, maxAntiPatterns } = await store.negativeMemoryEntries(source, source);
    return formatMemorySummary(topPerModule(entries, maxAntiPatterns));
  } catch {
    return '- （无法读取负向记忆；请自行检查 .ai-review/。）';
  }
}

export interface HeadlessAuditDeps {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  owner: string;
  targetPath: string;
  note: string;
  trigger: AuditTrigger;
  lease: AuditLeaseRecord;
  log: (line: string) => void;
  candidateSource?: SharedCandidateSource;
  signal?: AbortSignal;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  stageExecutor?: ExecuteAuditStage;
  scheduledBaseMatches?: () => Promise<boolean>;
  onSeal?: (manifest: StageSeal, issueIds: string[]) => Promise<void>;
  onStageStateChange?: (active: boolean) => Promise<void>;
  recoveryStore?: RepoRecoveryStore;
}

export async function runHeadlessPhasedAudit(deps: HeadlessAuditDeps): Promise<AuditOutcome> {
  const { store, vcs, settings, lease, log } = deps;
  const root = store.repoRoot;
  const target = await resolveAuditTarget(root, deps.targetPath);
  await requireValidReviewers(root, deps.candidateSource);

  const base = lease.baseRevision;
  const startedAt = Date.now();
  const deadlineAt = new Date(startedAt + AUDIT_TIMEOUT_MS).toISOString();

  let stageSeal: StageSeal | undefined;
  let publishedIssueIds: string[] | undefined;

  const session = new AuditStageSession({
    auditId: lease.auditId,
    root,
    scope: target.targetPath || '.',
    baseRevision: base,
    ...(lease.svnUrl ? { svnUrl: lease.svnUrl } : {}),
    trigger: deps.trigger,
    owner: deps.owner,
    note: deps.note,
    deadlineAt,
    vcs,
    store,
    ...(deps.candidateSource ? { source: deps.candidateSource } : {}),
    stageExecutors: settings.stageExecutors,
    ...(settings.dshCommand ? { dshCommand: settings.dshCommand } : {}),
    ...(deps.stageExecutor ? { executor: deps.stageExecutor } : {}),
    onLog: log,
    onSeal: async (manifest, issueIds) => {
      stageSeal = manifest;
      publishedIssueIds = issueIds;
      await deps.onSeal?.(manifest, issueIds);
    },
    ...(deps.onStageStateChange ? { onStageStateChange: deps.onStageStateChange } : {}),
  });

  const orchestratorPrompt = await session.buildOrchestratorPrompt(settings.runner === 'manual' ? 'manual' : 'headless');
  const memorySummary = await negativeMemoryLines(store, deps.candidateSource);

  if (settings.runner === 'manual') {
    const prompt = `${orchestratorPrompt}\n\n## 近期负向记忆（供去重参考）\n${memorySummary}\n`;
    return {
      manual: true,
      status: 'MANUAL_REQUIRED',
      auditId: lease.auditId,
      prompt,
      created: [],
      issues: [],
      report: null,
      commitRevision: null,
      baseRevision: base,
      targetPath: target.targetPath,
      warnings: [],
      message: '手动模式：已生成总调度审查提示词并建立租约，完成后请调用 /audit/finalize 收尾。',
    };
  }

  // 打开本轮专属一次性回环阶段通道（结束立即撤销凭据）
  const channel = await openAuditStageChannel(async (input, reqSignal) => {
    const op = input['operation'];
    if (op === 'runAuditStage') {
      return session.runStage(
        input['stage'] as AuditStage,
        (input['runner'] as AuditExecutor | undefined) ?? 'dsh-subagent',
        input['task'],
        reqSignal,
      );
    }
    if (op === 'publishAuditArtifacts') {
      return session.publish(input['publication'], reqSignal);
    }
    if (op === 'queryAuditHistory') {
      return session.queryHistory(typeof input['disposition'] === 'string' ? input['disposition'] : undefined);
    }
    throw new Error(`未知阶段操作：${String(op ?? '')}`);
  });

  const fullPrompt = [
    orchestratorPrompt,
    '',
    '## 近期负向记忆（供去重参考）',
    memorySummary,
    '',
    channel.instructions,
  ].join('\n');

  let runResult;
  try {
    runResult = await runAgent({
      kind: settings.runner === 'dsh' ? 'dsh' : 'external',
      settings,
      cwd: root,
      prompt: fullPrompt,
      log: (line) => log(channel.redact(line)),
      timeoutMs: Math.max(10_000, AUDIT_TIMEOUT_MS - (Date.now() - startedAt)),
      label: deps.trigger === 'scheduled' ? '定时分阶段审查' : '仓库分阶段审查',
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.resolveCredential ? { resolveCredential: deps.resolveCredential } : {}),
    });
  } finally {
    channel.close();
  }

  if (deps.signal?.aborted || runResult.aborted) {
    await vcs.revertBusinessWorkspace().catch(() => undefined);
    return {
      manual: false,
      status: 'ABORTED',
      auditId: lease.auditId,
      created: [],
      issues: [],
      report: null,
      commitRevision: null,
      baseRevision: base,
      targetPath: target.targetPath,
      warnings: ['仓库审查已取消，未执行收尾提交'],
      message: '仓库审查已取消',
    };
  }

  const runError = runResult.ok ? null : (runResult.errorMessage ?? '总调度执行器异常结束');
  const finalized = await finalizeIssueAudit(
    {
      store,
      vcs,
      log,
      ...(deps.candidateSource ? { candidateSource: deps.candidateSource } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.scheduledBaseMatches ? { scheduledBaseMatches: deps.scheduledBaseMatches } : {}),
      ...(deps.recoveryStore ? { recoveryStore: deps.recoveryStore } : {}),
    },
    {
      auditId: lease.auditId,
      baseRevision: base,
      targetPath: target.targetPath,
      trigger: deps.trigger,
      ...(lease.svnUrl ? { svnUrl: lease.svnUrl } : {}),
      beforeIds: new Set(lease.candidateIdsBefore),
      ...(publishedIssueIds ? { publishedIssueIds } : {}),
      ...(stageSeal ? { stageSeal } : {}),
      runError,
    },
  );

  return {
    manual: false,
    status: finalized.status,
    auditId: lease.auditId,
    created: finalized.created,
    issues: finalized.issues,
    report: { path: finalized.reportPath, text: finalized.body, issues: finalized.issues },
    commitRevision: finalized.commitRevision,
    baseRevision: base,
    targetPath: target.targetPath,
    warnings: finalized.warnings,
    dataValidation: finalized.dataValidation,
    ...(finalized.reason ? { reason: finalized.reason } : {}),
    ...(finalized.detail ? { detail: finalized.detail } : {}),
    message: finalized.message,
    ...(runResult.outputTail ? { outputTail: channel.redact(runResult.outputTail) } : {}),
  };
}

export async function previewAuditPrompt(input: {
  store: ReviewStore;
  vcs: VcsAdapter;
  settings: AppSettings;
  owner: string;
  targetPath: string;
  note: string;
  mode: 'session' | 'headless';
  source?: SharedCandidateSource;
}): Promise<{ auditId: string; reportPath: string; baseRevision: string; prompt: string }> {
  const target = await resolveAuditTarget(input.store.repoRoot, input.targetPath);
  const base = await input.vcs.getCurrentBase();
  if (!base) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交');
  const archive = new AuditArchive(input.store.repoRoot);
  const auditId = await archive.nextAuditId(target.targetPath);
  const session = new AuditStageSession({
    auditId,
    root: input.store.repoRoot,
    scope: target.targetPath || '.',
    baseRevision: base,
    trigger: 'manual',
    owner: input.owner,
    note: input.note,
    deadlineAt: new Date(Date.now() + AUDIT_TIMEOUT_MS).toISOString(),
    vcs: input.vcs,
    store: input.store,
    ...(input.source ? { source: input.source } : {}),
    stageExecutors: input.settings.stageExecutors,
    ...(input.settings.dshCommand ? { dshCommand: input.settings.dshCommand } : {}),
  });
  const orchestratorPrompt = await session.buildOrchestratorPrompt(input.mode);
  const memorySummary = await negativeMemoryLines(input.store, input.source);
  return {
    auditId,
    reportPath: `.ai-review/audits/${auditId}/audit.md`,
    baseRevision: base,
    prompt: `${orchestratorPrompt}\n\n## 近期负向记忆（供去重参考）\n${memorySummary}\n`,
  };
}
