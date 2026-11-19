import { mkdir, readFile } from 'node:fs/promises';
import type { ApiRequest, ApiResponse } from './api-context.js';
import path from 'node:path';
import process from 'node:process';
import {
  Auditor,
  buildAuditPrompt,
  loadAuditSystemPrompt,
  resolveAuditTarget,
} from './auditor.js';
import {
  AuditLifecycle,
  LeaseTransitionError,
  type AuditLeaseRecord,
} from './audit-lifecycle.js';
import { AuditArchive } from './audit-archive.js';
import { SCHEDULED_AUDIT_ACTOR } from '@dsh-review/protocol';
import { assertScheduledCheckout, matchesAuditTarget, scheduledReviewDataClean, syncScheduledAudit } from './scheduled-audit-vcs.js';
import { wrapAgentPrompt } from './runner.js';
import { loadReviewers } from './reviewers.js';
import { dshHome } from './settings.js';
import type { JobRecord } from './types.js';
import { ApiError } from './types.js';
import {
  composeSessionPrompt,
  currentTrustedActor,
  readJson,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type Runtime,
  type TrustedActor,
} from './api-context.js';

/** 将审查执行和租约状态机接入 Host。路由负责请求受理，租约在执行期间持续约束共享写入。 */
export class AuditRuntime {
  private lifecycle: AuditLifecycle | null = null;

  constructor(private readonly host: ApiHost) {}

  private get leaseStatePath(): string {
    return this.host.deps.statePath ?? path.join(dshHome(), 'dsh-code-review', 'runtime-state.json');
  }

  get auditLifecycle(): AuditLifecycle {
    if (!this.lifecycle) throw new ApiError(500, 'internal', '审查租约状态机未初始化');
    return this.lifecycle;
  }

  /** 进程重启后恢复未释放租约，外部 Agent 可能仍在操作工作区。 */
  async loadAuditLeases(): Promise<void> {
    this.lifecycle = new AuditLifecycle({
      load: async () => {
        let text: string;
        try {
          text = await readFile(this.leaseStatePath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw new Error(`审查租约读取失败，互斥状态不可证明：${error instanceof Error ? error.message : String(error)}`);
        }
        let parsed: { leases?: AuditLeaseRecord[] };
        try {
          parsed = JSON.parse(text) as { leases?: AuditLeaseRecord[] };
        } catch (error) {
          throw new Error(`审查租约解析失败，互斥状态不可证明：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!Array.isArray(parsed.leases)) throw new Error('审查租约文件缺少 leases 数组，互斥状态不可证明');
        return parsed.leases;
      },
      save: async (leases) => {
        const file = this.leaseStatePath;
        await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
        const temp = `${file}.tmp-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`;
        const { writeFile: writeState, rename: renameState } = await import('node:fs/promises');
        await writeState(temp, JSON.stringify({ leases }, null, 2), 'utf8');
        await renameState(temp, file);
      },
    });
    await this.lifecycle.load();
  }

  activeLeaseFor(root: string): AuditLeaseRecord | undefined {
    return this.auditLifecycle.blockingLeaseFor(root);
  }

  async upsertLease(lease: AuditLeaseRecord): Promise<void> {
    await this.auditLifecycle.create(lease);
  }

  /** 只有 Host 能确认执行已结束才可转为 released。结果不明时应保留互斥。 */
  async releaseLeaseById(auditId: string, state: 'released' | 'releasable' = 'released'): Promise<void> {
    const lease = this.auditLifecycle.find(auditId);
    if (!lease || lease.state === state) return;
    try {
      await this.auditLifecycle.transition(auditId, state);
    } catch (error) {
      if (error instanceof LeaseTransitionError) return;
      throw error;
    }
    if (state === 'released') {
      this.host.auditJobFinishes.get(auditId)?.({ status: 'ABORTED', auditId, message: '审查执行已结束，租约已释放' });
      this.host.auditJobFinishes.delete(auditId);
    }
  }

  /** 超时只能表明 Host 停止跟踪，租约继续阻塞自动写入。 */
  armAuditLeaseTimeout(auditId: string): void {
    const timer = setTimeout(() => {
      void this.auditLifecycle.markReleasable(auditId).then((changed) => {
        if (!changed) return;
        this.host.auditJobFinishes.get(auditId)?.({
          status: 'RECOVERY_REQUIRED',
          reason: 'SYNC_STATE_UNKNOWN',
          // 超时也可能表示会话已完成但尚未收尾。直接释放会留下未提交的本地候选。
          detail:
            '审查执行超过 1 小时上限，租约已置为 releasable。若审查会话已完成，请执行收尾（/audit/finalize）校验并提交候选；'
            + '确认外部执行已停止且不需要提交时，再人工确认释放（/audit/release）',
        });
        this.host.auditJobFinishes.delete(auditId);
      }).catch(() => undefined);
    }, 60 * 60 * 1000);
    timer.unref?.();
  }

  startAuditTrackingJob(auditId: string): JobRecord {
    const job = this.host.jobManager.start('audit', () => new Promise<unknown>((resolve) => {
      this.host.auditJobFinishes.set(auditId, (result) => { resolve(result); });
    }));
    this.host.auditJobLeases.set(job.id, auditId);
    return job;
  }

  trackAuditSession(runtime: Runtime, auditId: string, sessionId: string): JobRecord {
    const job = this.startAuditTrackingJob(auditId);
    this.followAuditTurn(runtime, auditId, sessionId);
    this.armAuditLeaseTimeout(auditId);
    return job;
  }

  private assertAuditStartAllowed(runtime: Runtime, clean: { clean: boolean; message: string }): void {
    const running = this.host.jobManager.list().find((job) => job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再开始仓库审查。`);
    }
    this.host.ensureNoAuditRunning(runtime.root);
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
  }

  /** 调用方须持有仓库锁，避免并发请求在各自通过互斥检查后同时取得租约。 */
  async beginAuditLeaseUnderLock(
    runtime: Runtime,
    input: { targetPath: string; baseRevision: string; owner: string; now: Date; trigger: 'manual' | 'scheduled' },
    clean: { clean: boolean; message: string },
  ): Promise<{ auditId: string; reportPath: string }> {
    this.assertAuditStartAllowed(runtime, clean);
    const auditId = await new AuditArchive(runtime.root).nextAuditId(input.targetPath, input.now);
    const candidateIdsBefore = await runtime.store.listCandidateIds();
    await this.upsertLease({
      auditId,
      root: runtime.root,
      targetPath: input.targetPath,
      trigger: input.trigger,
      baseRevision: input.baseRevision,
      owner: input.owner,
      createdAt: input.now.toISOString(),
      candidateIdsBefore,
      state: 'active',
    });
    return { auditId, reportPath: `.ai-review/audits/${auditId}/audit.md` };
  }

  private async beginAuditLease(
    runtime: Runtime,
    input: { targetPath: string; baseRevision: string; owner: string; now: Date; trigger: 'manual' | 'scheduled' },
    clean: { clean: boolean; message: string },
  ): Promise<{ auditId: string; reportPath: string }> {
    return this.host.withWriteLock(runtime.root, () => this.beginAuditLeaseUnderLock(runtime, input, clean));
  }

  async ownerRoutingBlock(
    repoRoot: string,
    source?: import('./shared-facts.js').SharedCandidateSource,
  ): Promise<string> {
    const config = await loadReviewers(repoRoot, source);
    const lines = [
      '## Owner 路由（reviewers.yml 解析结果，创建候选时按此写 owner）',
      `- default_owner: ${config.defaultOwner || '(未配置，由当前操作者兜底)'}`,
    ];
    for (const rule of config.rules) {
      lines.push(`- owner ${rule.owner}：paths ${JSON.stringify(rule.paths)} tags ${JSON.stringify(rule.tags)}`);
    }
    lines.push('- 匹配顺序：路径命中数 > tag 命中数 > 配置顺序；无命中用 default_owner。');
    return lines.join('\n');
  }

  async auditPrompt(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const owner = await this.host.ownerFor(runtime.root);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法生成仓库审查提示词。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
    const target = await resolveAuditTarget(runtime.root, url.searchParams.get('targetPath') ?? '');
    const note = url.searchParams.get('note') ?? '';
    const mode = url.searchParams.get('mode') === 'headless' ? 'headless' : 'session';
    const now = new Date();
    const auditId = await new AuditArchive(runtime.root).nextAuditId(target.targetPath, now);
    const reportPath = `.ai-review/audits/${auditId}/audit.md`;
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode,
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const systemPrompt = await loadAuditSystemPrompt();
    const promptWithRouting = `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root, sharedSource)}`;
    const prompt = mode === 'session'
      ? composeSessionPrompt(systemPrompt, promptWithRouting)
      : wrapAgentPrompt(systemPrompt, promptWithRouting);
    sendJson(res, 200, {
      prompt,
      auditId,
      mode,
      targetPath: target.targetPath,
      baseRevision,
      owner,
      reportPath,
    });
  }

  async auditSession(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const ownerSessionId = url.searchParams.get('sessionId') ?? '';
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!this.host.deps.createAuditSession) {
      throw new ApiError(500, 'internal', '当前 Host 不支持创建 DSH 审查会话（sessionController 未挂载）。');
    }
    const owner = await this.host.ownerFor(runtime.root);
    const now = new Date();
    const { auditId, reportPath } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual' },
      clean,
    );
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode: 'session',
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root, sharedSource)}`);
    const title = `仓库审查 · ${target.targetPath || '全仓库'}`.slice(0, 60);
    let created: { sessionId: string };
    try {
      created = await this.host.deps.createAuditSession({ cwd: runtime.root, title, prompt, ownerSessionId });
    } catch (error) {
      await this.releaseLeaseById(auditId).catch(() => undefined);
      throw error;
    }
    const leaseForSession = this.auditLifecycle.find(auditId);
    if (leaseForSession && leaseForSession.sessionId !== created.sessionId) {
      await this.upsertLease({ ...leaseForSession, sessionId: created.sessionId });
    }
    const job = this.trackAuditSession(runtime, auditId, created.sessionId);
    sendJson(res, 202, {
      sessionId: created.sessionId,
      jobId: job.id,
      job,
      auditId,
      targetPath: target.targetPath,
      reportPath,
      baseRevision,
      owner,
    });
  }

  async audit(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const actor = currentTrustedActor();
    if (actor?.userId === SCHEDULED_AUDIT_ACTOR && actor.commandId && actor.scheduledAudit) {
        const job = await this.startScheduledAudit(runtime, actor.scheduledAudit);
        sendJson(res, 202, { jobId: job.id, job });
        return;
    }
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    const owner = await this.host.ownerFor(runtime.root);
    const now = new Date();
    const { auditId } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual' },
      clean,
    );
    const job = this.host.jobManager.start('audit', (log, _jobId, signal) => this.host.withWriteLock(runtime.root, async () => {
      try {
        const sharedSource = await sharedSourceFor(runtime);
        const auditor = new Auditor({
          store: runtime.store,
          vcs: runtime.vcs,
          settings: this.host.currentSettings(),
          owner,
          targetPath: target.targetPath,
          note,
          log,
          ...(sharedSource ? { candidateSource: sharedSource } : {}),
          ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
          signal,
          lease: this.auditLifecycle.find(auditId)!,
        });
        const outcome = await auditor.run();
        log(`结果：${outcome.status} — ${outcome.message}`);
        return outcome;
      } finally {
        await this.releaseLeaseById(auditId).catch(() => undefined);
      }
    }));
    this.host.auditJobLeases.set(job.id, auditId);
    sendJson(res, 202, { jobId: job.id, job });
  }

    private async startScheduledAudit(runtime: Runtime, scheduled: NonNullable<TrustedActor['scheduledAudit']>): Promise<JobRecord> {
        let admit!: (job: JobRecord) => void;
        let rejectAdmission!: (reason: unknown) => void;
        const admitted = new Promise<JobRecord>((resolve, reject) => {
            admit = resolve;
            rejectAdmission = reject;
        });
        void this.host.withWriteLock(runtime.root, async () => {
            const settings = this.host.currentSettings();
            if (settings.runner === 'manual' || (settings.runner === 'external' && !settings.externalCommand.trim())) {
                throw new ApiError(409, 'conflict', '未配置可无人值守的审查 Runner', { reason: 'RUNNER_UNAVAILABLE' });
            }
            const clean = await runtime.vcs.ensureCleanWorkspace();
            try {
                this.assertAuditStartAllowed(runtime, clean);
            } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                const busy = Boolean(this.activeLeaseFor(runtime.root) || this.host.jobManager.list().some(job => job.status === 'running'));
                throw new ApiError(409, 'conflict', error.message, { reason: busy ? 'SCHEDULE_WORKSPACE_BUSY' : 'SCHEDULE_WORKSPACE_DIRTY' });
            }
            if (!await scheduledReviewDataClean(runtime)) {
                throw new ApiError(409, 'conflict', '评审目录有未提交的改动，已跳过本轮定时审查并保留现场', { reason: 'SCHEDULE_WORKSPACE_DIRTY' });
            }
            const before = await runtime.vcs.getCurrentBase();
            if (!before) throw new ApiError(412, 'not_configured', '定时审查缺少可用的仓库基线', { reason: 'SCHEDULE_WORKSPACE_NO_BASE' });
            await assertScheduledCheckout(runtime);
            const owner = await this.host.ownerFor(runtime.root);
            const now = new Date();
            const { auditId: reservedId } = await this.beginAuditLeaseUnderLock(
                runtime, { targetPath: '', baseRevision: before, owner, now, trigger: 'scheduled' }, clean,
            );
            let activeId = reservedId;
            const { candidateSource, lease } = await (async () => {
                const baseRevision = await syncScheduledAudit(runtime, scheduled.target, before, scheduled.signal);
                if (scheduled.signal.aborted) throw new ApiError(409, 'conflict', '定时审查在启动 Runner 前已取消', { reason: 'CANCELLED' });
                if (!await scheduledReviewDataClean(runtime)) {
                    throw new ApiError(409, 'conflict', '同步后评审目录出现未提交改动，需要核验现场', {
                        status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', detail: '无法证明同步后的评审数据与共享基线一致',
                    });
                }
                const candidateSource = await sharedSourceFor(runtime);
                if (!candidateSource || (runtime.vcsType === 'git' && await candidateSource.snapshotId() !== baseRevision)) {
                    throw new ApiError(409, 'conflict', '无法固定同步后的审查基线', {
                        status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', detail: '共享快照与同步结果无法对应',
                    });
                }
                const auditId = await new AuditArchive(runtime.root).nextAuditId('', now);
                const lease = { ...this.auditLifecycle.find(reservedId)!, auditId, baseRevision,
                    candidateIdsBefore: await runtime.store.listCandidateIds() };
                await this.upsertLease(lease);
                activeId = auditId;
                if (reservedId !== activeId) await this.releaseLeaseById(reservedId);
                return { candidateSource, lease };
            })().catch(async error => {
                const details = error instanceof ApiError ? error.details : null;
                const recovery = !(error instanceof ApiError) || error.status >= 500
                    || (details !== null && typeof details === 'object' && 'status' in details && details.status === 'RECOVERY_REQUIRED');
                await this.releaseLeaseById(activeId, recovery ? 'releasable' : 'released');
                throw error;
            });
            const { auditId } = lease;
            let execution: Promise<unknown> | undefined;
            const job = this.host.jobManager.start('audit', (log, jobId, signal) => {
                this.host.auditJobLeases.set(jobId, auditId);
                const auditor = new Auditor({
                    store: runtime.store, vcs: runtime.vcs, settings, owner, targetPath: '', note: '', log,
                    candidateSource, lease, signal: AbortSignal.any([scheduled.signal, signal]),
                    ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
                    scheduledBaseMatches: () => matchesAuditTarget(runtime, scheduled.target),
                });
                execution = auditor.run().then(async outcome => {
                    const state = outcome.status === 'RECOVERY_REQUIRED' ? 'releasable' : 'released';
                    await this.releaseLeaseById(auditId, state);
                    log(`结果：${outcome.status} — ${outcome.message}`);
                    return outcome;
                }, async error => {
                    await this.releaseLeaseById(auditId, 'releasable');
                    throw error;
                }).finally(() => this.host.auditJobLeases.delete(jobId));
                return execution;
            });
            admit(job);
            await execution;
        }).catch(rejectAdmission);
        return admitted;
    }

  /** 提示词交给外部 Agent 后，Host 仍用持久化租约保护执行期间的工作区。 */
  async auditManual(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交，无法开始仓库审查。');
    const clean = await runtime.vcs.ensureCleanWorkspace();
    const owner = await this.host.ownerFor(runtime.root);
    const now = new Date();
    const { auditId, reportPath } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual' },
      clean,
    );
    const sharedSource = await sharedSourceFor(runtime);
    const userPrompt = await buildAuditPrompt({
      repoRoot: runtime.root,
      vcsType: runtime.vcsType,
      owner,
      targetPath: target.targetPath,
      note,
      baseRevision,
      reportPath,
      mode: 'headless',
      now,
      ...(sharedSource ? { source: sharedSource } : {}),
    });
    const prompt = wrapAgentPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root, sharedSource)}`);
    const job = this.startAuditTrackingJob(auditId);
    this.armAuditLeaseTimeout(auditId);
    sendJson(res, 202, {
      jobId: job.id,
      job,
      auditId,
      prompt,
      targetPath: target.targetPath,
      reportPath,
      baseRevision,
      owner,
    });
  }

  /** 用租约记录的起始快照验收外部执行结果，避免按变化后的基线接受候选。 */
  private startAuditFinalizeJob(runtime: Runtime, lease: AuditLeaseRecord): JobRecord {
    const job = this.host.jobManager.start('audit', async (log, _jobId, signal) => {
      try {
        return await this.host.withWriteLock(runtime.root, async () => {
      const current = this.auditLifecycle.find(lease.auditId);
      if (!current || current.state === 'released') {
        return {
          status: 'ABORTED', auditId: lease.auditId, commitRevision: null, created: [],
          reportPath: `.ai-review/audits/${lease.auditId}/audit.md`, message: '租约已释放或不存在，未重复收尾',
        };
      }
      const sharedSource = await sharedSourceFor(runtime);
      const auditor = new Auditor({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: this.host.currentSettings(),
        owner: current.owner,
        targetPath: current.targetPath,
        note: '',
        log,
        ...(sharedSource ? { candidateSource: sharedSource } : {}),
        ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
        signal,
      });
      const result = await auditor.finalize({
        auditId: current.auditId,
        beforeIds: new Set(current.candidateIdsBefore),
        baseRevision: current.baseRevision,
        targetPath: current.targetPath,
        trigger: current.trigger,
        runError: null,
        startedAt: new Date(current.createdAt).getTime(),
        now: new Date(),
      });
      if (result.status === 'COMMITTED' || result.status === 'VALIDATION_FAILED') {
        await this.auditLifecycle.transition(current.auditId, 'released');
      } else {
        log(`收尾未完成（${result.status}），租约 ${current.auditId} 保持占用`);
      }
      const outcome = {
        status: result.status,
        auditId: current.auditId,
        commitRevision: result.commitRevision,
        created: result.created,
        reportPath: result.reportPath,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        message: result.message,
      };
      log(`结果：${result.status} — ${result.message}`);
      this.host.auditJobFinishes.get(current.auditId)?.(outcome);
      this.host.auditJobFinishes.delete(current.auditId);
      return outcome;
        });
      } finally {
        this.host.auditJobLeases.delete(_jobId);
      }
    });
    this.host.auditJobLeases.set(job.id, lease.auditId);
    return job;
  }

  /** 宿主未提供 turn-end 钩子时，跟踪任务须等待显式收尾。 */
  private followAuditTurn(runtime: Runtime, auditId: string, sessionId: string): void {
    const subscribe = this.host.deps.onAuditTurnEnd;
    if (!subscribe) return;
    let finished = false;
    let dispose = (): void => undefined;
    dispose = subscribe(sessionId, () => {
      if (finished) return;
      finished = true;
      queueMicrotask(dispose);
      const lease = this.auditLifecycle.find(auditId);
      if (lease?.state === 'active') this.startAuditFinalizeJob(runtime, lease);
    });
  }

  async auditFinalize(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
    const lease = this.auditLifecycle.find(auditId);
    if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
    if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
    if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放，不能重复收尾`);
    const running = this.host.jobManager.list().find((job) => job.status === 'running' && job.type !== 'audit');
    if (running) throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再收尾。`);
    const job = this.startAuditFinalizeJob(runtime, lease);
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** 取消和超时都无法证明外部执行已停止，因此释放还需要人工确认。 */
  async auditRelease(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    const confirmStopped = body['confirmStopped'] === true;
    if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
    if (!confirmStopped) throw new ApiError(409, 'conflict', '必须显式确认外部执行已停止（confirmStopped: true）');
    const lease = this.auditLifecycle.find(auditId);
    if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
    if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
    if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放`);
    if (lease.state === 'active') {
      throw new ApiError(409, 'conflict', `租约 ${auditId} 仍处于活跃状态；请先取消审查 Job 或等待超时（releasable）后再释放`);
    }
    // 外部 Agent 停止后也可能留下业务改动，释放前须检查工作区。
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `工作区仍有未还原改动，不能释放租约。\n${clean.message}`);
    }
    await this.auditLifecycle.transition(auditId, 'released');
    this.host.auditJobFinishes.get(lease.auditId)?.({
      status: 'ABORTED',
      auditId: lease.auditId,
      message: '租约已由人工确认停止后释放',
    });
    this.host.auditJobFinishes.delete(lease.auditId);
    sendJson(res, 200, { released: true });
  }

  async sync(res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { vcs } = runtime;
    this.host.ensureNoAuditRunning(runtime.root);
    // 同步会改变基线，必须与使用该工作区的其他事务串行。
    const result = await this.host.withWriteLock(runtime.root, () => vcs.syncAndGetLatestBase());
    if (result.uncertain) {
      throw new ApiError(409, 'conflict', `同步状态无法确定，禁止自动重试：${result.message}`, {
        status: 'RECOVERY_REQUIRED',
        reason: 'SYNC_STATE_UNKNOWN',
        detail: result.message,
      });
    }
    sendJson(res, 200, result);
  }

  ensureNoAuditRunning(root?: string): void {
    const running = this.host.jobManager.list().find((job) => job.type === 'audit' && job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', '仓库审查正在运行，请等待完成后再执行该操作。');
    }
    const lease = root !== undefined
      ? this.activeLeaseFor(root)
      : this.auditLifecycle.anyBlocking();
    if (lease) {
      throw new ApiError(409, 'conflict', `审查执行租约 ${lease.auditId}（${lease.state}）仍在占用仓库；请先 /audit/finalize 收尾，或确认外部执行已停止后 /audit/release。`);
    }
  }
}
