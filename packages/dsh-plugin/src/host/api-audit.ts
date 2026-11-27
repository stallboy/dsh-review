/**
 * 审查编排与租约控制 API（SPEC §5.6 / §6.3 / §9.11）：
 * - 所有启动入口前置核验 reviewers.yml 与有效 default_owner（412 not_configured）；
 * - 手动、会话与定时审查完全共用统一 AuditStageSession + finalizeIssueAudit 流水线；
 * - 所有运行时阶段会话与手动回环通道归属 ReviewApi.auditCoordinator 实例，无模块级全局泄漏；
 * - 持久化租约互斥，超时/取消/零合法问题失败均不盲目释放租约。
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  currentTrustedActor,
  readJson,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type ApiRequest,
  type ApiResponse,
  type Runtime,
} from './api-context.js';
import { AuditArchive } from './audit-archive.js';
import { AUDIT_TIMEOUT_MS, type AuditLeaseRecord } from './audit-lifecycle.js';
import type { AuditStage } from './audit-prompts.js';
import { readSvnAuditUrl } from './audit-stage-artifacts.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import type { AuditExecutor } from './audit-stage-runner.js';
import { AuditStageSession } from './audit-stages.js';
import { negativeMemoryLines, previewAuditPrompt, resolveAuditTarget, runHeadlessPhasedAudit } from './auditor.js';
import { finalizeIssueAudit } from './issue-finalize.js';
import { requireValidReviewers } from './reviewers.js';
import {
  assertScheduledCheckout,
  matchesAuditTarget,
  scheduledReviewDataClean,
  syncScheduledAudit,
} from './scheduled-audit-vcs.js';
import type { SharedCandidateSource } from './shared-facts.js';
import { ApiError } from './types.js';

export function runAuditStageForSession(
  host: ApiHost,
  sessionId: string,
  stage: AuditStage,
  runner: AuditExecutor,
  task: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const bound = host.auditCoordinator.getStageSession(sessionId);
  if (!bound) throw new Error('审查会话未绑定活跃阶段租约');
  const lease = host.leaseLookup(bound.auditId);
  if (!lease || lease.state !== 'active' || lease.sessionId !== sessionId) {
    throw new Error('审查租约已失效，禁止继续执行阶段任务');
  }
  return bound.session.runStage(stage, runner, task, signal);
}

export function publishAuditStagesForSession(
  host: ApiHost,
  sessionId: string,
  publication: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const bound = host.auditCoordinator.getStageSession(sessionId);
  if (!bound) throw new Error('审查会话未绑定活跃阶段租约');
  const lease = host.leaseLookup(bound.auditId);
  if (!lease || lease.state !== 'active' || lease.sessionId !== sessionId) {
    throw new Error('审查租约已失效，禁止发布审查产物');
  }
  return bound.session.publish(publication, signal);
}

export function queryAuditHistoryForSession(
  host: ApiHost,
  sessionId: string,
  disposition?: string,
): Promise<unknown> {
  const bound = host.auditCoordinator.getStageSession(sessionId);
  if (!bound) throw new Error('审查会话未绑定活跃阶段租约');
  const lease = host.leaseLookup(bound.auditId);
  if (!lease || lease.state === 'released' || lease.sessionId !== sessionId) {
    throw new Error('审查租约已释放，无法查询历史');
  }
  return bound.session.queryHistory(disposition);
}

/** 统一根据收尾结果迁移审查租约并清理通道：仅成功落盘共享提交才释放租约，0 合法问题或恢复态保留 releasable。 */
async function applyAuditLeaseOutcome(
  host: ApiHost,
  runtime: Runtime,
  lease: AuditLeaseRecord,
  outcome: { status: string; commitRevision: string | null; reason?: string },
  options: { releaseOnCleanAbort?: boolean } = {},
): Promise<void> {
  const { auditId, sessionId } = lease;
  if (outcome.status === 'COMMITTED' || (outcome.status === 'VALIDATION_FAILED' && outcome.commitRevision !== null)) {
    await host.auditLifecycle.transition(auditId, 'released', false);
    host.auditCoordinator.closeManualChannel(auditId);
    if (sessionId) host.auditCoordinator.unbindStageSession(sessionId);
    host.auditCoordinator.clearStopping(auditId);
    return;
  }
  if (outcome.status === 'VALIDATION_FAILED') {
    await host.auditLifecycle.markReleasable(auditId);
    host.auditCoordinator.closeManualChannel(auditId);
    if (sessionId) host.auditCoordinator.unbindStageSession(sessionId);
    return;
  }
  if (outcome.status === 'RECOVERY_REQUIRED') {
    const commitOutcomeUnknown = outcome.reason === 'COMMIT_OUTCOME_UNKNOWN' ? true : undefined;
    await host.auditLifecycle.transition(auditId, 'releasable', commitOutcomeUnknown);
    host.auditCoordinator.closeManualChannel(auditId);
    if (sessionId) host.auditCoordinator.unbindStageSession(sessionId);
    return;
  }
  if (outcome.status === 'ABORTED') {
    if (options.releaseOnCleanAbort) {
      const cleanNow = await runtime.vcs.ensureCleanWorkspace().catch(() => null);
      if (cleanNow?.clean && !lease.stageProcessActive) {
        await host.auditLifecycle.transition(auditId, 'released', false);
        host.auditCoordinator.closeManualChannel(auditId);
        if (sessionId) host.auditCoordinator.unbindStageSession(sessionId);
        return;
      }
    }
    await host.auditLifecycle.markReleasable(auditId);
    host.auditCoordinator.closeManualChannel(auditId);
    if (sessionId) host.auditCoordinator.unbindStageSession(sessionId);
  }
}

async function openManualStageChannel(params: {
  host: ApiHost;
  runtime: Runtime;
  lease: AuditLeaseRecord;
  note: string;
  source?: SharedCandidateSource;
  now: Date;
}): Promise<string> {
  const { host, runtime, lease, note, source, now } = params;
  const auditId = lease.auditId;
  let channelClose: (() => void) | undefined;
  try {
    const stageSession = new AuditStageSession({
      auditId,
      root: runtime.root,
      scope: lease.targetPath || '.',
      baseRevision: lease.baseRevision,
      ...(lease.svnUrl ? { svnUrl: lease.svnUrl } : {}),
      trigger: lease.trigger,
      owner: lease.owner,
      note,
      deadlineAt: new Date(now.getTime() + AUDIT_TIMEOUT_MS).toISOString(),
      vcs: runtime.vcs,
      store: runtime.store,
      ...(source ? { source } : {}),
      stageExecutors: host.currentSettings().stageExecutors,
      ...(host.currentSettings().dshCommand ? { dshCommand: host.currentSettings().dshCommand } : {}),
      ...(host.deps.auditStageExecutor ? { executor: host.deps.auditStageExecutor } : {}),
      onSeal: async (manifest, issueIds) => {
        lease.stageSeal = manifest;
        lease.publishedIssueIds = issueIds;
        await host.auditLifecycle.create(lease);
      },
      onStageStateChange: async (active) => {
        if (active) lease.stageProcessActive = true;
        else delete lease.stageProcessActive;
        await host.auditLifecycle.create(lease);
      },
    });
    const orchestratorPrompt = await stageSession.buildOrchestratorPrompt('manual');
    const memorySummary = await negativeMemoryLines(runtime.store, source);
    const channel = await openAuditStageChannel(async (input, reqSignal) => {
      const current = host.leaseLookup(auditId);
      if (!current || current.state !== 'active') throw new Error('审查租约已失效，阶段入口已关闭');
      const op = input['operation'];
      if (op === 'runAuditStage') {
        return stageSession.runStage(
          input['stage'] as AuditStage,
          (input['runner'] as AuditExecutor | undefined) ?? 'dsh-subagent',
          input['task'],
          reqSignal,
        );
      }
      if (op === 'publishAuditArtifacts') {
        return stageSession.publish(input['publication'], reqSignal);
      }
      if (op === 'queryAuditHistory') {
        return stageSession.queryHistory(typeof input['disposition'] === 'string' ? input['disposition'] : undefined);
      }
      throw new Error(`未知阶段操作：${String(op ?? '')}`);
    });
    channelClose = channel.close;
    host.auditCoordinator.registerManualChannel(auditId, channel.close);
    const timer = setTimeout(() => {
      host.auditCoordinator.closeManualChannel(auditId);
      void host.auditLifecycle.markReleasable(auditId).catch(() => undefined);
    }, AUDIT_TIMEOUT_MS);
    timer.unref?.();
    host.auditCoordinator.setTimer(auditId, timer);

    return [
      orchestratorPrompt,
      '',
      '## 近期负向记忆（供去重参考）',
      memorySummary,
      '',
      channel.instructions,
    ].join('\n');
  } catch (error) {
    channelClose?.();
    host.auditCoordinator.closeManualChannel(auditId);
    await host.leaseTransition(auditId, 'released').catch(() => undefined);
    throw error;
  }
}

export async function handleAuditPrompt(host: ApiHost, _req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const runtime = await host.runtimeFor(url);
  const owner = await host.ownerFor(runtime.root);
  const source = await sharedSourceFor(runtime);
  await requireValidReviewers(runtime.root, source);

  const targetPath = url.searchParams.get('targetPath') ?? '.';
  const note = url.searchParams.get('note') ?? '';
  const mode = url.searchParams.get('mode') === 'session' ? 'session' : 'headless';

  const preview = await previewAuditPrompt({
    store: runtime.store,
    vcs: runtime.vcs,
    settings: host.currentSettings(),
    owner,
    targetPath,
    note,
    mode,
    ...(source ? { source } : {}),
  });
  sendJson(res, 200, preview);
}

/** POST /audit/manual — 预检 reviewers.yml，建立持久化租约，返回 auditId 与展开提示词。 */
export async function handleAuditManual(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const rawTarget = stringField(body, 'targetPath') || '.';
  const note = stringField(body, 'note');
  const runtime = await host.runtimeFor(url);

  const result = await host.withWriteLock(runtime.root, async () => {
    host.ensureNoAuditRunning(runtime.root);
    if (host.jobManager.list().some((j) => j.status === 'running')) {
      throw new ApiError(409, 'conflict', '当前有正在执行的后台任务，不能启动新审查');
    }
    const source = await sharedSourceFor(runtime);
    await requireValidReviewers(runtime.root, source);
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净：${clean.message}`);
    const target = await resolveAuditTarget(runtime.root, rawTarget);
    const base = await runtime.vcs.getCurrentBase();
    if (!base) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交');

    const owner = await host.ownerFor(runtime.root);
    const now = new Date();
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const svnUrl = runtime.vcsType === 'svn' ? await readSvnAuditUrl(runtime.root).catch(() => undefined) : undefined;
    const candidateIdsBefore = await runtime.store.listCandidateIds();

    const lease: AuditLeaseRecord = {
      auditId,
      root: runtime.root,
      targetPath: target.targetPath,
      trigger: 'manual',
      baseRevision: base,
      ...(svnUrl ? { svnUrl } : {}),
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
    };
    await host.auditLifecycle.create(lease);

    const fullPrompt = await openManualStageChannel({
      host,
      runtime,
      lease,
      note,
      ...(source ? { source } : {}),
      now,
    });

    const job = host.jobManager.start('audit', async () => ({
      manual: true,
      status: 'MANUAL_REQUIRED',
      auditId,
      prompt: fullPrompt,
      created: [],
      issues: [],
      report: null,
      commitRevision: null,
      baseRevision: base,
      targetPath: target.targetPath,
      warnings: [],
      message: '已创建持久化手动审查租约，外部执行完成后请调用 /audit/finalize 收尾',
    }));
    host.auditJobLeases.set(job.id, auditId);

    return {
      jobId: job.id,
      job,
      auditId,
      baseRevision: base,
      targetPath: target.targetPath,
      reportPath: `.ai-review/audits/${auditId}/audit.md`,
      owner,
      prompt: fullPrompt,
    };
  });

  sendJson(res, 202, result);
}

/** POST /audit — Headless 分阶段审查（手动触发与中央定时触发共用统一流水线）。 */
export async function handleAuditStart(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const rawTarget = stringField(body, 'targetPath') || '.';
  const note = stringField(body, 'note');
  const runtime = await host.runtimeFor(url);
  const trusted = currentTrustedActor();
  const scheduled = trusted?.scheduledAudit;
  const trigger: 'manual' | 'scheduled' = scheduled ? 'scheduled' : 'manual';

  const setup = await host.withWriteLock(runtime.root, async () => {
    host.ensureNoAuditRunning(runtime.root);
    if (host.jobManager.list().some((j) => j.status === 'running')) {
      throw new ApiError(409, 'conflict', '当前有正在执行的后台任务，不能启动新审查');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(
        409,
        'conflict',
        `仓库审查要求业务工作区干净：${clean.message}`,
        scheduled ? { reason: 'SCHEDULE_WORKSPACE_DIRTY' } : undefined,
      );
    }

    let base = await runtime.vcs.getCurrentBase();
    if (!base) {
      throw new ApiError(
        412,
        'not_configured',
        '当前仓库没有可用的基线提交',
        scheduled ? { reason: 'SCHEDULE_WORKSPACE_NO_BASE' } : undefined,
      );
    }

    if (scheduled) {
      await assertScheduledCheckout(runtime);
      if (!(await scheduledReviewDataClean(runtime))) {
        throw new ApiError(409, 'conflict', '.ai-review/ 存在未提交改动，已跳过定时审查', {
          reason: 'SCHEDULE_WORKSPACE_DIRTY',
        });
      }
      base = await syncScheduledAudit(runtime, scheduled.target, base, scheduled.signal);
    }

    const source = await sharedSourceFor(runtime);
    await requireValidReviewers(runtime.root, source);

    const target = await resolveAuditTarget(runtime.root, rawTarget);
    const owner = await host.ownerFor(runtime.root);
    const now = new Date();
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const svnUrl = runtime.vcsType === 'svn' ? await readSvnAuditUrl(runtime.root).catch(() => undefined) : undefined;
    const candidateIdsBefore = await runtime.store.listCandidateIds();

    const lease: AuditLeaseRecord = {
      auditId,
      root: runtime.root,
      targetPath: target.targetPath,
      trigger,
      baseRevision: base,
      ...(svnUrl ? { svnUrl } : {}),
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
      ...(trusted?.commandId ? { commandId: trusted.commandId } : {}),
    };
    await host.auditLifecycle.create(lease);

    if (host.currentSettings().runner === 'manual') {
      const fullPrompt = await openManualStageChannel({
        host,
        runtime,
        lease,
        note,
        ...(source ? { source } : {}),
        now,
      });
      return { lease, target, owner, source, manualPrompt: fullPrompt };
    }
    return { lease, target, owner, source, manualPrompt: undefined as string | undefined };
  });

  if (setup.manualPrompt !== undefined) {
    const prompt = setup.manualPrompt;
    const job = host.jobManager.start('audit', async () => ({
      manual: true,
      status: 'MANUAL_REQUIRED',
      auditId: setup.lease.auditId,
      prompt,
      created: [],
      issues: [],
      report: null,
      commitRevision: null,
      baseRevision: setup.lease.baseRevision,
      targetPath: setup.target.targetPath,
      warnings: [],
      message: '手动模式：已生成总调度审查提示词并建立租约，完成后请调用 /audit/finalize 收尾。',
    }));
    host.auditJobLeases.set(job.id, setup.lease.auditId);
    sendJson(res, 202, { jobId: job.id, job, auditId: setup.lease.auditId, prompt });
    return;
  }

  const job = host.jobManager.start('audit', async (ctx) => {
    const combinedSignal = scheduled ? AbortSignal.any([ctx.signal, scheduled.signal]) : ctx.signal;
    try {
      const outcome = await runHeadlessPhasedAudit({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: host.currentSettings(),
        owner: setup.owner,
        targetPath: setup.target.targetPath,
        note,
        trigger,
        lease: setup.lease,
        log: ctx.log,
        ...(setup.source ? { candidateSource: setup.source } : {}),
        signal: combinedSignal,
        ...(host.deps.resolveCredential ? { resolveCredential: host.deps.resolveCredential } : {}),
        ...(host.deps.auditStageExecutor ? { stageExecutor: host.deps.auditStageExecutor } : {}),
        ...(scheduled ? { scheduledBaseMatches: () => matchesAuditTarget(runtime, scheduled.target) } : {}),
        recoveryStore: host.recoveryStore,
        onSeal: async (manifest, issueIds) => {
          setup.lease.stageSeal = manifest;
          setup.lease.publishedIssueIds = issueIds;
          await host.auditLifecycle.create(setup.lease);
        },
        onStageStateChange: async (active) => {
          if (active) setup.lease.stageProcessActive = true;
          else delete setup.lease.stageProcessActive;
          await host.auditLifecycle.create(setup.lease);
        },
      });

      await applyAuditLeaseOutcome(host, runtime, setup.lease, outcome, { releaseOnCleanAbort: true });
      return outcome;
    } catch (error) {
      await host.auditLifecycle.markReleasable(setup.lease.auditId).catch(() => undefined);
      throw error;
    } finally {
      host.auditJobLeases.delete(ctx.id);
    }
  });
  host.auditJobLeases.set(job.id, setup.lease.auditId);

  sendJson(res, 202, { jobId: job.id, job, auditId: setup.lease.auditId });
}

/** POST /audit/session — 创建可见 DSH 审查会话并绑定阶段工具与持久租约（SPEC §5.6）。 */
export async function handleAuditSession(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  if (!host.deps.createAuditSession) {
    throw new ApiError(501 as unknown as number, 'internal', '当前宿主未提供 DSH 审查会话能力（createAuditSession）');
  }
  const body = await readJson(req);
  const rawTarget = stringField(body, 'targetPath') || '.';
  const note = stringField(body, 'note');
  const runtime = await host.runtimeFor(url);
  const trusted = currentTrustedActor();

  const prepared = await host.withWriteLock(runtime.root, async () => {
    host.ensureNoAuditRunning(runtime.root);
    if (host.jobManager.list().some((j) => j.status === 'running')) {
      throw new ApiError(409, 'conflict', '当前有正在执行的后台任务，不能启动新审查');
    }
    const source = await sharedSourceFor(runtime);
    await requireValidReviewers(runtime.root, source);
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净：${clean.message}`);
    const target = await resolveAuditTarget(runtime.root, rawTarget);
    const base = await runtime.vcs.getCurrentBase();
    if (!base) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交');

    const owner = await host.ownerFor(runtime.root);
    const now = new Date();
    const archive = new AuditArchive(runtime.root);
    const auditId = await archive.nextAuditId(target.targetPath, now);
    const svnUrl = runtime.vcsType === 'svn' ? await readSvnAuditUrl(runtime.root).catch(() => undefined) : undefined;
    const candidateIdsBefore = await runtime.store.listCandidateIds();

    const lease: AuditLeaseRecord = {
      auditId,
      root: runtime.root,
      targetPath: target.targetPath,
      trigger: 'manual',
      baseRevision: base,
      ...(svnUrl ? { svnUrl } : {}),
      owner,
      createdAt: now.toISOString(),
      candidateIdsBefore,
      state: 'active',
      ...(trusted?.commandId ? { commandId: trusted.commandId } : {}),
    };
    await host.auditLifecycle.create(lease);

    const stageSession = new AuditStageSession({
      auditId,
      root: runtime.root,
      scope: target.targetPath || '.',
      baseRevision: base,
      ...(svnUrl ? { svnUrl } : {}),
      trigger: 'manual',
      owner,
      note,
      deadlineAt: new Date(now.getTime() + AUDIT_TIMEOUT_MS).toISOString(),
      vcs: runtime.vcs,
      store: runtime.store,
      ...(source ? { source } : {}),
      stageExecutors: host.currentSettings().stageExecutors,
      ...(host.currentSettings().dshCommand ? { dshCommand: host.currentSettings().dshCommand } : {}),
      ...(host.deps.auditStageExecutor ? { executor: host.deps.auditStageExecutor } : {}),
      onSeal: async (manifest, issueIds) => {
        lease.stageSeal = manifest;
        lease.publishedIssueIds = issueIds;
        await host.auditLifecycle.create(lease);
      },
      onStageStateChange: async (active) => {
        if (active) lease.stageProcessActive = true;
        else delete lease.stageProcessActive;
        await host.auditLifecycle.create(lease);
      },
    });

    const orchestratorPrompt = await stageSession.buildOrchestratorPrompt('session');
    const memorySummary = await negativeMemoryLines(runtime.store, source);
    const prompt = `${orchestratorPrompt}\n\n## 近期负向记忆（供去重参考）\n${memorySummary}\n`;

    return { lease, target, owner, source, stageSession, prompt };
  });

  const requestId = randomUUID();
  const ownerSessionId = url.searchParams.get('sessionId') ?? undefined;
  let sessionId = '';
  try {
    const created = await host.deps.createAuditSession({
      cwd: runtime.root,
      title: `仓库审查：${prepared.target.targetPath || '全仓'}（${prepared.lease.auditId}）`,
      prompt: prepared.prompt,
      requestId,
      requireWorkspace: true,
      cwdOnly: true,
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(trusted?.managedAuditSession?.signal ? { signal: trusted.managedAuditSession.signal } : {}),
      onCreated: async (sid) => {
        sessionId = sid;
        prepared.lease.sessionId = sid;
        await host.auditLifecycle.create(prepared.lease);
        host.auditCoordinator.bindStageSession(sid, prepared.lease.auditId, prepared.stageSession);
        trusted?.managedAuditSession?.onCreated(prepared.lease.auditId, sid);
      },
    });
    sessionId = created.sessionId;
    if (!host.auditCoordinator.getStageSession(sessionId)) {
      prepared.lease.sessionId = sessionId;
      await host.auditLifecycle.create(prepared.lease);
      host.auditCoordinator.bindStageSession(sessionId, prepared.lease.auditId, prepared.stageSession);
    }
  } catch (error) {
    if (!sessionId) {
      await host.auditLifecycle.transition(prepared.lease.auditId, 'released').catch(() => undefined);
    } else {
      await host.auditLifecycle.markReleasable(prepared.lease.auditId).catch(() => undefined);
    }
    throw error;
  }

  let settled = false;
  let resolveJob!: (result: unknown) => void;
  const finishJob = (result: unknown): void => {
    if (settled) return;
    settled = true;
    resolveJob(result);
  };
  const waitDone = new Promise<unknown>((resolve) => { resolveJob = resolve; });

  const job = host.jobManager.start('audit', async (ctx) => {
    host.auditJobFinishes.set(ctx.id, finishJob);
    const auditId = prepared.lease.auditId;
    const managedSignal = trusted?.managedAuditSession?.signal;
    const nodeShutdown = trusted?.managedAuditSession?.nodeShutdown;
    const watchSignal = managedSignal ? AbortSignal.any([ctx.signal, managedSignal]) : ctx.signal;

    let stopTriggered = false;
    const stopAndMarkRecovery = async (kind: 'cancel' | 'timeout'): Promise<void> => {
      if (stopTriggered || settled) return;
      stopTriggered = true;
      host.auditCoordinator.clearTimer(auditId);

      // 节点主动关闭时保留持久化租约原样，待重启后自动转 releasable 人工核验
      if (kind === 'cancel' && nodeShutdown?.aborted) {
        finishJob({
          manual: false,
          status: 'RECOVERY_REQUIRED',
          reason: 'SYNC_STATE_UNKNOWN',
          detail: '宿主节点正在关闭，审查租约已持久化保留待重启后核验',
          auditId,
          sessionId,
          created: [],
          issues: [],
          report: null,
          commitRevision: null,
          baseRevision: prepared.lease.baseRevision,
          targetPath: prepared.lease.targetPath,
          warnings: ['宿主节点关闭中断跟踪'],
          message: '宿主节点关闭，原审查租约已保留',
        });
        return;
      }

      const stoppingLine = kind === 'timeout'
        ? `审查 ${auditId} 超过 3 小时上限，正在停止审查会话并保留现场`
        : `收到取消信号，正在停止审查会话 ${sessionId}`;
      host.auditCoordinator.markStopping(auditId);
      ctx.log(stoppingLine);
      await trusted?.managedAuditSession?.reportStopping?.(stoppingLine).catch(() => undefined);
      let stoppedConfirmed = true;
      if (host.deps.stopAuditSession) {
        stoppedConfirmed = await host.deps.stopAuditSession(
          sessionId,
          AbortSignal.timeout(15_000),
          Promise.resolve(true),
        ).catch(() => false);
      }
      await host.auditLifecycle.markReleasable(auditId).catch(() => undefined);
      host.auditCoordinator.unbindStageSession(sessionId);
      host.auditCoordinator.clearStopping(auditId);

      const detail = kind === 'timeout'
        ? (stoppedConfirmed
          ? '审查超过 3 小时上限，已停止会话并保留现场待核验释放'
          : '审查超过 3 小时上限，未能确认会话完全停止，已保留租约待核验')
        : (stoppedConfirmed
          ? '审查跟踪已取消，已请求停止原会话并保留租约待核验释放'
          : '审查跟踪已取消，未能确认原会话完全停止，已保留租约待核验');

      finishJob({
        manual: false,
        status: 'RECOVERY_REQUIRED',
        reason: 'SYNC_STATE_UNKNOWN',
        detail,
        auditId,
        sessionId,
        created: [],
        issues: [],
        report: null,
        commitRevision: null,
        baseRevision: prepared.lease.baseRevision,
        targetPath: prepared.lease.targetPath,
        warnings: [kind === 'timeout' ? '审查超过 3 小时上限' : '审查跟踪已取消'],
        message: kind === 'timeout' ? '审查超时，需人工核验后释放租约' : '审查跟踪已取消，需核验现场',
      });
    };

    const onAbort = () => {
      void stopAndMarkRecovery('cancel');
    };
    if (watchSignal.aborted) onAbort();
    else watchSignal.addEventListener('abort', onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      void stopAndMarkRecovery('timeout');
    }, AUDIT_TIMEOUT_MS);
    timeoutTimer.unref?.();
    host.auditCoordinator.setTimer(auditId, timeoutTimer);

    if (host.deps.withAuditSessionIdle) {
      void host.deps.withAuditSessionIdle(sessionId, requestId, watchSignal, async (finalizeSignal) => {
        const currentLease = host.leaseLookup(auditId);
        if (!currentLease || currentLease.state === 'released' || stopTriggered) return false;

        // 若阶段执行器均失败（0 次成功初审且未发布任何审查报告），绝不炮制空报告关闭租约
        const reportDiskPath = path.join(runtime.root, '.ai-review', 'audits', currentLease.auditId, 'audit.md');
        if (!prepared.stageSession.isPublished && prepared.stageSession.getScanCount() === 0 && prepared.stageSession.hasStageFailure() && !existsSync(reportDiskPath)) {
          await host.auditLifecycle.markReleasable(currentLease.auditId);
          host.auditCoordinator.unbindStageSession(sessionId);
          finishJob({
            manual: false,
            status: 'RECOVERY_REQUIRED',
            reason: 'SYNC_STATE_UNKNOWN',
            stageFailure: true,
            detail: '全部初审子阶段执行失败且未发布任何审查报告，已保留现场待核验',
            auditId: currentLease.auditId,
            sessionId,
            created: [],
            issues: [],
            report: null,
            commitRevision: null,
            baseRevision: currentLease.baseRevision,
            targetPath: currentLease.targetPath,
            warnings: ['全部初审子阶段失败，未生成空报告'],
            message: '审查子阶段全部失败，需人工核验',
          });
          return false;
        }

        const result = await host.withWriteLock(runtime.root, () => finalizeIssueAudit(
          {
            store: runtime.store,
            vcs: runtime.vcs,
            log: ctx.log,
            ...(prepared.source ? { candidateSource: prepared.source } : {}),
            signal: finalizeSignal,
            recoveryStore: host.recoveryStore,
          },
          {
            auditId: currentLease.auditId,
            baseRevision: currentLease.baseRevision,
            targetPath: currentLease.targetPath,
            trigger: currentLease.trigger,
            ...(currentLease.svnUrl ? { svnUrl: currentLease.svnUrl } : {}),
            beforeIds: new Set(currentLease.candidateIdsBefore),
            ...(currentLease.publishedIssueIds ? { publishedIssueIds: currentLease.publishedIssueIds } : {}),
            ...(currentLease.stageSeal ? { stageSeal: currentLease.stageSeal } : {}),
            runError: null,
          },
        ));
        await applyAuditLeaseOutcome(host, runtime, currentLease, result);
        finishJob({
          manual: false,
          status: result.status,
          auditId: currentLease.auditId,
          sessionId,
          created: result.created,
          issues: result.issues,
          report: { path: result.reportPath, text: result.body, issues: result.issues },
          commitRevision: result.commitRevision,
          baseRevision: currentLease.baseRevision,
          targetPath: currentLease.targetPath,
          warnings: result.warnings,
          dataValidation: result.dataValidation,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
          message: result.message,
        });
      }).catch(() => {
        void host.auditLifecycle.markReleasable(auditId).catch(() => undefined);
      });
    }

    try {
      return await waitDone;
    } finally {
      watchSignal.removeEventListener('abort', onAbort);
      host.auditCoordinator.clearTimer(auditId);
      host.auditJobFinishes.delete(ctx.id);
      host.auditJobLeases.delete(ctx.id);
    }
  });
  host.auditJobLeases.set(job.id, prepared.lease.auditId);

  sendJson(res, 202, {
    sessionId,
    jobId: job.id,
    job,
    auditId: prepared.lease.auditId,
    targetPath: prepared.target.targetPath,
    reportPath: `.ai-review/audits/${prepared.lease.auditId}/audit.md`,
    baseRevision: prepared.lease.baseRevision,
    owner: prepared.owner,
  });
}

/** POST /audit/finalize — Host 校验、还原非 .ai-review/ 改动、原子提交并释放租约。 */
export async function handleAuditFinalize(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const auditId = stringField(body, 'auditId').trim();
  if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
  const runtime = await host.runtimeFor(url);
  const lease = host.leaseLookup(auditId);
  if (!lease || lease.root !== runtime.root) {
    throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
  }
  if (lease.state === 'released') {
    throw new ApiError(409, 'conflict', `审查租约 ${auditId} 已释放，不能重复收尾`);
  }
  if (lease.commitOutcomeUnknown) {
    throw new ApiError(409, 'conflict', `审查租约 ${auditId} 的前一次提交结果不明，禁止重复收尾，请先人工核验后再释放租约`);
  }
  if (lease.stageProcessActive) {
    throw new ApiError(409, 'conflict', '审查子阶段进程仍在运行，请等待或取消后再收尾');
  }

  const source = await sharedSourceFor(runtime);
  const job = host.jobManager.start('audit', async (ctx) => {
    return host.withWriteLock(runtime.root, async () => {
      if (lease.sessionId && host.deps.stopAuditSession) {
        const stopped = await host.deps.stopAuditSession(lease.sessionId, ctx.signal, Promise.resolve(true)).catch(() => false);
        if (!stopped) {
          await host.auditLifecycle.markReleasable(auditId);
          return {
            manual: false,
            status: 'RECOVERY_REQUIRED',
            reason: 'SYNC_STATE_UNKNOWN',
            detail: `无法确认审查会话 ${lease.sessionId} 已完全停止`,
            auditId,
            created: [],
            issues: [],
            report: null,
            commitRevision: null,
            baseRevision: lease.baseRevision,
            targetPath: lease.targetPath,
            warnings: [],
            message: '审查会话未能确认停止，暂不收尾',
          };
        }
      }

      const result = await finalizeIssueAudit(
        {
          store: runtime.store,
          vcs: runtime.vcs,
          log: ctx.log,
          ...(source ? { candidateSource: source } : {}),
          signal: ctx.signal,
          recoveryStore: host.recoveryStore,
        },
        {
          auditId: lease.auditId,
          baseRevision: lease.baseRevision,
          targetPath: lease.targetPath,
          trigger: lease.trigger,
          ...(lease.svnUrl ? { svnUrl: lease.svnUrl } : {}),
          beforeIds: new Set(lease.candidateIdsBefore),
          ...(lease.publishedIssueIds ? { publishedIssueIds: lease.publishedIssueIds } : {}),
          ...(lease.stageSeal ? { stageSeal: lease.stageSeal } : {}),
          runError: null,
        },
      );

      await applyAuditLeaseOutcome(host, runtime, lease, result);

      const outcome = {
        manual: false,
        status: result.status,
        auditId,
        created: result.created,
        issues: result.issues,
        report: { path: result.reportPath, text: result.body, issues: result.issues },
        commitRevision: result.commitRevision,
        baseRevision: lease.baseRevision,
        targetPath: lease.targetPath,
        warnings: result.warnings,
        dataValidation: result.dataValidation,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        message: result.message,
      };
      for (const [jid, lid] of host.auditJobLeases) {
        if (lid === auditId) {
          host.auditJobFinishes.get(jid)?.(outcome);
        }
      }
      return outcome;
    });
  });

  sendJson(res, 202, { jobId: job.id, job });
}

/** POST /audit/release — 仅已取消/超时（releasable）租约可用，经确认停止与工作区核验后释放。 */
export async function handleAuditRelease(host: ApiHost, req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
  const body = await readJson(req);
  const auditId = stringField(body, 'auditId').trim();
  if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
  const runtime = await host.runtimeFor(url);
  await host.auditLifecycle.expireOverdue();
  const lease = host.leaseLookup(auditId);
  if (!lease || lease.root !== runtime.root) {
    throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
  }
  if (lease.state === 'released') {
    sendJson(res, 200, { released: true, auditId });
    return;
  }
  if (lease.state !== 'releasable') {
    throw new ApiError(409, 'conflict', `仅处于 releasable 状态的租约允许手动释放（当前为 ${lease.state}），请先取消任务或直接收尾`);
  }
  if (body['confirmStopped'] !== true) {
    throw new ApiError(422, 'bad_request', '释放审查租约必须显式确认 confirmStopped: true');
  }
  if (lease.commitOutcomeUnknown && body['confirmCommitChecked'] !== true) {
    throw new ApiError(409, 'conflict', '原审查提交结果不明，释放租约必须同时显式确认 confirmCommitChecked: true');
  }
  if (lease.sessionId && host.deps.stopAuditSession) {
    const stopped = await host.deps.stopAuditSession(lease.sessionId, AbortSignal.timeout(15_000), Promise.resolve(true)).catch(() => false);
    if (!stopped) {
      throw new ApiError(409, 'conflict', `无法确认原审查会话 ${lease.sessionId} 已完全停止，拒绝释放租约`);
    }
  }
  await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
  const clean = await runtime.vcs.ensureCleanWorkspace();
  if (!clean.clean) {
    throw new ApiError(409, 'conflict', `业务工作区仍不干净，请先人工清理后再释放租约：${clean.message}`);
  }

  await host.auditLifecycle.transition(auditId, 'released', false);
  host.auditCoordinator.closeManualChannel(auditId);
  if (lease.sessionId) host.auditCoordinator.unbindStageSession(lease.sessionId);
  host.auditCoordinator.clearStopping(auditId);
  for (const [jid, lid] of host.auditJobLeases) {
    if (lid === auditId) {
      host.auditJobFinishes.get(jid)?.({
        manual: false,
        status: 'ABORTED',
        auditId,
        created: [],
        issues: [],
        report: null,
        commitRevision: null,
        baseRevision: lease.baseRevision,
        targetPath: lease.targetPath,
        warnings: ['审查租约已由用户确认停止后释放'],
        message: '审查租约已释放',
      });
    }
  }
  sendJson(res, 200, { released: true, auditId });
}

/** POST /jobs/:id/cancel — 幂等请求停止，手动租约不随取消自动释放。 */
export async function handleJobCancel(host: ApiHost, _req: ApiRequest, res: ApiResponse, jobId: string): Promise<void> {
  const job = host.jobManager.get(jobId);
  if (!job) throw new ApiError(404, 'not_found', `Job 不存在：${jobId}`);
  host.jobManager.abort(jobId);
  const leaseId = host.auditJobLeases.get(jobId);
  if (leaseId) {
    await host.auditLifecycle.markReleasable(leaseId).catch(() => undefined);
  }
  sendJson(res, 202, { jobId: job.id, job });
}
