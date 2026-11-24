import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { ApiRequest, ApiResponse } from './api-context.js';
import path from 'node:path';
import process from 'node:process';
import {
  Auditor,
  buildAuditPrompt,
  permittedScanOutputs,
  sameReviewWorktree,
  existingCandidateLines,
  negativeMemoryLines,
  loadAuditSystemPrompt,
  resolveAuditTarget,
} from './auditor.js';
import {
  AUDIT_TIMEOUT_HOURS,
  AUDIT_TIMEOUT_MS,
  AuditLifecycle,
  LeaseTransitionError,
  type AuditLeaseRecord,
} from './audit-lifecycle.js';
import { AuditArchive } from './audit-archive.js';
import { auditRecheckPrompt, loadAuditHistory, verifyAuditRecheck, verifyPublishedRecheck, type AuditRecheck } from './audit-history.js';
import { SCHEDULED_AUDIT_ACTOR } from '@dsh-review/protocol';
import { assertScheduledCheckout, captureReviewWorktree, matchesAuditTarget, scheduledReviewDataClean, syncScheduledAudit, type ReviewWorktreeState } from './scheduled-audit-vcs.js';
import { runAgent, wrapAgentPrompt } from './runner.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import { runAuditSelfTest, type AuditSelfTestTools } from './audit-self-test.js';
import { loadReviewers } from './reviewers.js';
import { ReviewStore } from './store.js';
import { AuditStages, auditUserFields, renderAuditCoordinator, type AuditPriorityEntry } from './audit-stages.js';
import { assertStageArtifacts, compatibleAuditBase, publishStageArtifacts, readSvnAuditUrl, verifyStageGates } from './audit-stage-artifacts.js';
import { auditObject, AuditStopUnknown, type AuditExecutor } from './audit-stage-runner.js';
import type { AuditStage } from './audit-prompts.js';
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
  private readonly leaseTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly finalizing = new Set<string>();

  isFinalizing(auditId: string): boolean { return this.finalizing.has(auditId); }

  private clearAuditLeaseTimeout(auditId: string): void {
    clearTimeout(this.leaseTimeouts.get(auditId));
    this.leaseTimeouts.delete(auditId);
  }

  private finishAuditTracking(auditId: string, outcome: unknown): void {
    this.host.auditJobFinishes.get(auditId)?.(outcome);
    this.host.auditJobFinishes.delete(auditId);
  }
  private lifecycle: AuditLifecycle | null = null;
  private readonly stages = new Map<string, AuditStages>();
  private readonly testSessions = new Map<string, AuditSelfTestTools>();
  private readonly testShutdown = new AbortController();
  private closed = false;
  private leaseWrites: Promise<void> = Promise.resolve();

  close(): Promise<void> {
    this.closed = true;
    this.testShutdown.abort();
    for (const [jobId] of this.host.auditJobLeases) this.host.jobManager.abort(jobId);
    for (const auditId of new Set([...this.leaseTimeouts.keys(), ...this.stages.keys()])) {
      this.clearAuditLeaseTimeout(auditId);
      this.stopStages(auditId);
      this.finishAuditTracking(auditId, { status: 'RECOVERY_REQUIRED', auditId, message: 'Host 已停止，请核验审查租约' });
    }
    return this.leaseWrites;
  }

  private readonly channels = new Map<string, Awaited<ReturnType<typeof openAuditStageChannel>>>();

  private closeStageChannel(auditId: string): void {
    this.channels.get(auditId)?.close();
    this.channels.delete(auditId);
  }

  stopStages(auditId: string): void {
    this.closeStageChannel(auditId);
    this.stages.get(auditId)?.cancel();
  }

  hasStageSession(sessionId: string): boolean {
    return !this.closed && (this.testSessions.has(sessionId) || this.findStageSession(sessionId) !== undefined);
  }

  private findStageSession(sessionId: string): AuditStages | undefined {
    if (!sessionId || this.closed) return undefined;
    return [...this.stages.values()].find(item => item.lease.sessionId === sessionId && item.lease.state === 'active');
  }

  private stageForSession(sessionId: string): AuditStages {
    const stage = this.findStageSession(sessionId);
    if (!stage) throw new Error('阶段工具需要有效租约绑定的审查会话');
    return stage;
  }

  async runStage(sessionId: string, stage: AuditStage, runner: AuditExecutor, task: unknown, signal: AbortSignal): Promise<unknown> {
    const test = this.testSessions.get(sessionId);
    return test ? test.run(stage, runner, task, signal) : this.executeStage(this.stageForSession(sessionId), stage, runner, task, signal);
  }

  private async executeStage(session: AuditStages, stage: AuditStage, runner: AuditExecutor, task: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      return await session.run(stage, runner, task, signal);
    } finally {
      if (session.uncertain) await this.auditLifecycle.markReleasable(session.lease.auditId);
    }
  }

  async queryHistory(sessionId: string, disposition?: string): Promise<unknown> {
    return this.readStageHistory(this.stageForSession(sessionId), disposition);
  }

  private async readStageHistory(stage: AuditStages, disposition?: string): Promise<unknown> {
    const source = stage.historySource;
    if (!source) return [];
    const values = (await loadAuditHistory(new ReviewStore(stage.lease.root), source, stage.lease.targetPath || '.', stage.findingWorkflow)).protectedFindings;
    return values.filter(item => item.repairPlan && (!disposition || ('disposition' in item && item.disposition === disposition)));
  }

  async publishStages(sessionId: string, input: unknown, signal?: AbortSignal): Promise<{ reportPath: string; overview: AuditPriorityEntry[] }> {
    const test = this.testSessions.get(sessionId);
    return test ? test.publish(input, signal) : this.publishStage(this.stageForSession(sessionId), input, signal);
  }

  runSelfTest(signal: AbortSignal, progress: (step: string, message: string) => void) {
    return runAuditSelfTest({
      deps: this.host.deps, settings: this.host.currentSettings(),
      signal: AbortSignal.any([signal, this.testShutdown.signal]), progress,
      sessions: this.testSessions,
    });
  }

  private async publishStage(stage: AuditStages, input: unknown, signal?: AbortSignal, recheck?: AuditRecheck): Promise<{ reportPath: string; overview: AuditPriorityEntry[] }> {
    const lease = stage.lease;
    return this.host.withWriteLock(lease.root, async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error('审查 Host 已停止');
      if (!await compatibleAuditBase(stage.vcs, lease.baseRevision, lease.svnUrl) || !(await stage.vcs.ensureCleanWorkspace()).clean) {
        await this.auditLifecycle.markReleasable(lease.auditId);
        throw new Error('发布前业务基线或工作区发生变化');
      }
      const { reviewedFindings, ...publication } = auditObject(input);
      const output = stage.publication(publication);
      stage.busy = true;
      try {
        if (!recheck && reviewedFindings !== undefined) {
          if (!Array.isArray(reviewedFindings)) throw new Error('reviewedFindings 必须是数组');
          const source = stage.historySource;
          if (!source) throw new Error('无法固定历史复查基线');
          const history = await loadAuditHistory(new ReviewStore(lease.root), source, lease.targetPath || '.', stage.findingWorkflow);
          recheck = await verifyPublishedRecheck(history, reviewedFindings, lease.baseRevision, stage.vcs);
        }
        signal?.throwIfAborted();
        if (!await compatibleAuditBase(stage.vcs, lease.baseRevision, lease.svnUrl) || !(await stage.vcs.ensureCleanWorkspace()).clean) {
          throw new AuditStopUnknown('封存前业务基线或工作区发生变化');
        }
        const before = new Set(lease.candidateIdsBefore);
        if ((await new ReviewStore(lease.root).listCandidateIds()).some(id => !before.has(id))) {
          throw new Error('发现本轮未登记的新增候选');
        }
        await publishStageArtifacts(lease.root, output.path, output.body, output.candidates, async manifest => {
          signal?.throwIfAborted();
          if (this.closed || lease.state !== 'active' || stage.uncertain) throw new Error('审查租约已停止');
          lease.stageSeal = manifest;
          lease.stageItems = output.items;
          if (recheck) lease.stageRecheck = recheck;
          try { await this.upsertLease(lease); } catch (error) {
            delete lease.stageSeal;
            delete lease.stageItems;
            delete lease.stageRecheck;
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof AuditStopUnknown) await this.auditLifecycle.markReleasable(lease.auditId);
        throw error;
      } finally {
        stage.busy = false;
      }
      return { reportPath: output.path, overview: output.overview };
    });
  }

  private usesStages(): boolean {
    return this.host.deps.auditStageExecutor !== undefined;
  }

  private async coordinatorPrompt(runtime: Runtime, lease: AuditLeaseRecord, fields: ReturnType<typeof auditUserFields>, note: string,
    executionMode: 'dsh-session' | 'host-channel' = 'dsh-session'): Promise<string> {
    const source = await sharedSourceFor(runtime);
    const findingWorkflow = currentTrustedActor()?.findingWorkflow !== false;
    const [reviewers, activeCandidates, negativeMemory, prior] = await Promise.all([
      loadReviewers(runtime.root, source),
      existingCandidateLines(runtime.store, lease.baseRevision, source),
      negativeMemoryLines(runtime.root, source),
      source ? loadAuditHistory(runtime.store, source, lease.targetPath || '.', findingWorkflow) : undefined,
    ]);
    return renderAuditCoordinator({ lease, vcsType: runtime.vcsType, executionMode, findingWorkflow, reviewers, repoOutline: [lease.targetPath || '.'],
      history: { activeCandidates, negativeMemory, findings: prior?.protectedFindings.filter(item => item.repairPlan) ?? [] },
      legacyNote: fields.focus.includes(note.trim()) ? '' : note,
      automaticCandidates: this.host.deps.auditStageGates !== undefined,
      ...fields });
  }

  private async setupStages(runtime: Runtime, lease: AuditLeaseRecord, fields: ReturnType<typeof auditUserFields>): Promise<AuditStages> {
    const source = await sharedSourceFor(runtime);
    const reviewers = await loadReviewers(runtime.root, source);
    const stage = new AuditStages(lease, runtime.vcs, reviewers, this.host.deps.auditStageExecutor!,
      this.host.currentSettings().gateTimeoutMs, fields.extraRequirements, this.host.deps.auditStageGates, source, currentTrustedActor()?.findingWorkflow);
    this.stages.set(lease.auditId, stage);
    return stage;
  }

  private async channelPrompt(runtime: Runtime, lease: AuditLeaseRecord, fields: ReturnType<typeof auditUserFields>, note: string, recheck?: AuditRecheck): Promise<string> {
    const prompt = await this.coordinatorPrompt(runtime, lease, fields, note, 'host-channel');
    const stage = await this.setupStages(runtime, lease, fields);
    const channel = await openAuditStageChannel(async (input, signal) => {
      if (stage.lease.state !== 'active' || stage.lease.stageSeal || this.stages.get(lease.auditId) !== stage) {
        throw new Error('本轮阶段租约不可用');
      }
      if (input['operation'] === 'runAuditStage') {
        return this.executeStage(stage, input['stage'] as AuditStage, input['runner'] as AuditExecutor, input['task'], signal);
      }
      if (input['operation'] === 'queryAuditHistory') {
        return this.readStageHistory(stage, typeof input['disposition'] === 'string' ? input['disposition'] : undefined);
      }
      if (input['operation'] === 'publishAuditArtifacts') return this.publishStage(stage, input['publication'], signal, recheck);
      throw new Error('未知审查阶段操作');
    });
    if (this.closed || lease.state !== 'active') {
      channel.close();
      throw new Error('审查租约已停止');
    }
    this.channels.set(lease.auditId, channel);
    return prompt + '\n\n' + channel.instructions;
  }

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
      save: (leases) => {
        if (this.closed) return Promise.reject(new Error('审查 Host 已停止'));
        const file = this.leaseStatePath;
        const state = JSON.stringify({ leases }, null, 2);
        const write = this.leaseWrites.then(async () => {
          await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
          const temp = `${file}.tmp-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`;
          const { writeFile: writeState, rename: renameState } = await import('node:fs/promises');
          await writeState(temp, state, 'utf8');
          await renameState(temp, file);
        });
        this.leaseWrites = write.catch(() => undefined);
        return write;
      },
    });
    await this.lifecycle.load();
    for (const lease of this.lifecycle.all()) {
      if (lease.phased && lease.state === 'active') await this.lifecycle.markReleasable(lease.auditId);
    }
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
      this.stopStages(auditId);
      this.stages.delete(auditId);
      this.clearAuditLeaseTimeout(auditId);
      this.host.auditJobFinishes.get(auditId)?.({ status: 'ABORTED', auditId, message: '审查执行已结束，租约已释放' });
      this.host.auditJobFinishes.delete(auditId);
    }
  }

  /** 超时只能表明 Host 停止跟踪，租约继续阻塞自动写入。 */
  armAuditLeaseTimeout(auditId: string): void {
    this.clearAuditLeaseTimeout(auditId);
    const lease = this.auditLifecycle.find(auditId);
    if (!lease || lease.state !== 'active') return;
    const timer = setTimeout(() => {
      this.leaseTimeouts.delete(auditId);
      if (this.isFinalizing(auditId)) return;
      this.stopStages(auditId);
      void this.auditLifecycle.markReleasable(auditId).then((changed) => {
        if (!changed) return;
        this.host.auditJobFinishes.get(auditId)?.({
          status: 'RECOVERY_REQUIRED',
          reason: 'SYNC_STATE_UNKNOWN',
          // 超时也可能表示会话已完成但尚未收尾。直接释放会留下未提交的本地候选。
          detail:
            '审查执行超过 ' + AUDIT_TIMEOUT_HOURS + ' 小时上限，租约已置为 releasable。若审查会话已完成，请执行收尾（/audit/finalize）校验并提交候选；'
            + '确认外部执行已停止且不需要提交时，再人工确认释放（/audit/release）',
        });
        this.host.auditJobFinishes.delete(auditId);
      }).catch(() => undefined);
    }, Math.max(0, Date.parse(lease.createdAt) + AUDIT_TIMEOUT_MS - Date.now()));
    this.leaseTimeouts.set(auditId, timer);
    timer.unref?.();
  }

  private startAuditTrackingJob(
    auditId: string, watch?: (log: (line: string) => void, signal: AbortSignal) => Promise<void>,
  ): JobRecord {
    const job = this.host.jobManager.start('audit', async (log, id, signal) => {
      const finished = new AbortController();
      const result = new Promise<unknown>((resolve) => { this.host.auditJobFinishes.set(auditId, resolve); });
      const watching = AbortSignal.any([signal, finished.signal]);
      void watch?.(log, watching).catch((error: unknown) => {
        if (!watching.aborted) log(`自动收尾未启动，请在审查结束后手动收尾：${error instanceof Error ? error.message : String(error)}`);
      });
      try {
        return await result;
      } finally {
        finished.abort();
        this.host.auditJobLeases.delete(id);
      }
    });
    this.host.auditJobLeases.set(job.id, auditId);
    return job;
  }

  private trackAuditSession(runtime: Runtime, auditId: string, sessionId: string, requestId: string, managedSignal?: AbortSignal): JobRecord {
    this.armAuditLeaseTimeout(auditId);
    const watch = this.host.deps.withAuditSessionIdle;
    return this.startAuditTrackingJob(auditId, !watch ? undefined : async (log, signal) => {
      const watching = managedSignal ? AbortSignal.any([signal, managedSignal]) : signal;
      let finished: boolean;
      try {
        finished = await watch(sessionId, requestId, watching, async maintenance => {
          const lease = this.auditLifecycle.find(auditId);
          if (!lease || lease.state !== 'active' || this.isFinalizing(auditId)) return;
          if (lease.phased && (!lease.stageSeal || this.stages.get(auditId)?.busy)) return false;
          this.clearAuditLeaseTimeout(auditId);
          log('审查会话已空闲，开始自动收尾');
          try {
            await this.finalizeAudit(runtime, lease, log, maintenance, true);
          } catch (error) {
            await this.auditLifecycle.markReleasable(auditId).catch(() => false);
            this.finishAuditTracking(auditId, {
              status: 'RECOVERY_REQUIRED', auditId,
              message: `自动收尾失败，保留租约供手动复核：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        });
      } catch (error) {
        if (!managedSignal) throw error;
        finished = false;
        if (!watching.aborted) log(`跟踪 DSH 会话失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (finished || signal.aborted) return;
      if (!managedSignal) {
        log('无法确认 DSH 会话结束，请在审查结束后手动收尾');
        return;
      }
      await this.auditLifecycle.markReleasable(auditId);
      this.clearAuditLeaseTimeout(auditId);
      this.finishAuditTracking(auditId, {
        status: 'RECOVERY_REQUIRED', auditId, sessionId, reason: 'SYNC_STATE_UNKNOWN',
        message: managedSignal.aborted ? '已停止跟踪；请在 DSH 中确认审查会话已停止，再核验原任务。'
          : '无法确认 DSH 会话已结束，请在 DSH 中核对会话状态及审查产物。',
      });
    });
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
    input: { targetPath: string; baseRevision: string; owner: string; now: Date; trigger: 'manual' | 'scheduled'; phased?: boolean; commandId?: string },
    clean: { clean: boolean; message: string },
  ): Promise<{ auditId: string; reportPath: string }> {
    this.assertAuditStartAllowed(runtime, clean);
    const auditId = await new AuditArchive(runtime.root).nextAuditId(input.targetPath, input.now);
    const candidateIdsBefore = await runtime.store.listCandidateIds();
    const svnUrl = input.phased && runtime.vcsType === 'svn' ? await readSvnAuditUrl(runtime.root) : undefined;
    await this.upsertLease({
      auditId,
      root: runtime.root,
      targetPath: input.targetPath,
      trigger: input.trigger,
      baseRevision: input.baseRevision,
      ...(svnUrl ? { svnUrl } : {}),
      owner: input.owner,
      createdAt: input.now.toISOString(),
      candidateIdsBefore,
      ...(input.phased ? { phased: true } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      state: 'active',
    });
    return { auditId, reportPath: `.ai-review/audits/${auditId}/audit.md` };
  }

  private async beginAuditLease(
    runtime: Runtime,
    input: { targetPath: string; baseRevision: string; owner: string; now: Date; trigger: 'manual' | 'scheduled'; phased?: boolean; commandId?: string },
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
    if (this.usesStages()) {
      let fields: ReturnType<typeof auditUserFields>;
      try {
        fields = auditUserFields({
          focus: JSON.parse(url.searchParams.get('focus') ?? '[]'),
          extraRequirements: JSON.parse(url.searchParams.get('extraRequirements') ?? '[]'),
        });
      } catch {
        throw new ApiError(400, 'bad_request', '审查附加字段非法');
      }
      const prompt = await this.coordinatorPrompt(runtime, {
        auditId, root: runtime.root, targetPath: target.targetPath, trigger: 'manual', baseRevision,
        owner, createdAt: now.toISOString(), candidateIdsBefore: [], state: 'active', phased: true,
      }, fields, note, mode === 'session' ? 'dsh-session' : 'host-channel');
      sendJson(res, 200, { prompt: mode === 'headless' ? prompt + '\n\n启动审查取得本轮租约后，Host 会提供本机阶段入口。' : prompt,
        auditId, mode, targetPath: target.targetPath, baseRevision, owner, reportPath });
      return;
    }
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
    const actor = currentTrustedActor();
    const managed = actor?.managedAuditSession;
    if (managed?.signal.aborted) throw new ApiError(409, 'conflict', '审查会话创建前已取消', { reason: 'CANCELLED' });
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (managed && (!this.host.deps.createAuditSession || !this.host.deps.withAuditSessionIdle)) {
      throw new ApiError(412, 'not_configured', '当前桌面节点缺少 DSH 审查会话执行能力');
    }
    if (!this.host.deps.createAuditSession) {
      throw new ApiError(500, 'internal', '当前 Host 不支持创建 DSH 审查会话（sessionController 未挂载）。');
    }
    const owner = await this.host.ownerFor(runtime.root);
    const now = new Date();
    const phased = this.usesStages();
    if (phased && this.host.deps.auditSessionTools === false) throw new ApiError(409, 'conflict', 'DSH 宿主未提供审查阶段工具');
    let fields: ReturnType<typeof auditUserFields> = { focus: [], extraRequirements: [] };
    if (phased) {
      try { fields = auditUserFields(body); } catch { throw new ApiError(400, 'bad_request', '审查附加字段非法'); }
    }
    const { auditId, reportPath } = await this.beginAuditLease(
      runtime, { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual', phased,
        ...(managed && actor?.commandId ? { commandId: actor.commandId } : {}) }, clean,
    );
    const lease = this.auditLifecycle.find(auditId)!;
    const title = ('仓库审查 · ' + (target.targetPath || '全仓库')).slice(0, 60);
    const requestId = `dsh-code-review-${randomUUID()}`;
    let created: { sessionId: string };
    try {
      const source = await sharedSourceFor(runtime);
      let prompt: string;
      if (phased) {
        prompt = await this.coordinatorPrompt(runtime, lease, fields, note);
        await this.setupStages(runtime, lease, fields);
      } else {
        const userPrompt = await buildAuditPrompt({
          repoRoot: runtime.root, vcsType: runtime.vcsType, owner, targetPath: target.targetPath,
          note, baseRevision, reportPath, mode: 'session', now, ...(source ? { source } : {}),
        });
        const workdir = managed ? `\n\n执行命令时请显式使用仓库根目录 ${runtime.root}。报告和补丁路径相对仓库根目录。` : '';
        prompt = composeSessionPrompt(await loadAuditSystemPrompt(), userPrompt + workdir + '\n\n' + await this.ownerRoutingBlock(runtime.root, source));
      }
      created = await this.host.deps.createAuditSession({
        cwd: runtime.root, title, prompt, ownerSessionId, requestId,
        ...(managed ? { requireWorkspace: true, signal: managed.signal } : {}),
        ...(phased || managed ? { onCreated: async (sessionId: string) => {
          lease.sessionId = sessionId;
          await this.upsertLease(lease);
          managed?.onCreated(auditId, sessionId);
        } } : {}),
      });
      if (lease.sessionId !== created.sessionId) {
        lease.sessionId = created.sessionId;
        await this.upsertLease(lease);
      }
    } catch (error) {
      this.stopStages(auditId);
      if ((phased || managed) && lease.sessionId) await this.auditLifecycle.markReleasable(auditId);
      if (managed && lease.sessionId) {
        throw new ApiError(500, 'internal', error instanceof Error ? error.message : String(error), {
          status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', auditId, sessionId: lease.sessionId,
        });
      }
      if (!(phased && lease.sessionId)) {
        this.stages.delete(auditId);
        await this.releaseLeaseById(auditId).catch(() => undefined);
      }
      if (managed?.signal.aborted) throw new ApiError(409, 'conflict', '审查会话创建前已取消', { reason: 'CANCELLED' });
      throw error;
    }
    const job = this.trackAuditSession(runtime, auditId, created.sessionId, requestId, managed?.signal);
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
    const settings = this.host.currentSettings();
    if (this.usesStages() && settings.runner === 'manual') {
      if (actor?.commandId) throw new ApiError(409, 'conflict', '后台节点未配置可运行的审查 Runner', { reason: 'RUNNER_UNAVAILABLE' });
      await this.startManualAudit(runtime, res, body);
      return;
    }
    const phased = this.usesStages();
    const fields = phased ? this.readStageFields(body) : { focus: [], extraRequirements: [] };
    const { auditId } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual', phased,
        ...(phased && actor?.commandId ? { commandId: actor.commandId } : {}) },
      clean,
    );
    if (phased) {
      const job = this.startPhasedRunner(runtime, this.auditLifecycle.find(auditId)!, fields, note);
      sendJson(res, 202, { jobId: job.id, job });
      return;
    }
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
        const commandId = currentTrustedActor()?.commandId;
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
                runtime, { targetPath: '', baseRevision: before, owner, now, trigger: 'scheduled', phased: this.usesStages(),
                    ...(this.usesStages() && commandId ? { commandId } : {}) }, clean,
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
            if (lease.phased) {
                const job = this.startPhasedRunner(runtime, lease, { focus: [], extraRequirements: [] }, '', { scheduled, candidateSource });
                admit(job);
                return;
            }
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

  private readStageFields(body: Record<string, unknown>): ReturnType<typeof auditUserFields> {
    try { return auditUserFields(body); }
    catch { throw new ApiError(400, 'bad_request', '审查附加字段非法'); }
  }

  private startPhasedRunner(
    runtime: Runtime, lease: AuditLeaseRecord, fields: ReturnType<typeof auditUserFields>, note: string,
    schedule?: { scheduled: NonNullable<TrustedActor['scheduledAudit']>; candidateSource: import('./shared-facts.js').SharedCandidateSource },
  ): JobRecord {
    const { auditId } = lease;
    lease.stageProcessActive = true;
    const job = this.host.jobManager.start('audit', async (log, id, jobSignal) => {
      this.host.auditJobLeases.set(id, auditId);
      const signal = schedule ? AbortSignal.any([jobSignal, schedule.scheduled.signal]) : jobSignal;
      const scheduledBaseMatches = schedule ? () => matchesAuditTarget(runtime, schedule.scheduled.target) : undefined;
      let reason: 'SYNC_STATE_UNKNOWN' | 'SCHEDULE_RECHECK_DIRTY' | 'SCHEDULE_SCAN_DIRTY' = 'SYNC_STATE_UNKNOWN';
      let startedRunner = false;
      try {
        await this.upsertLease(lease);
        const settings = this.host.currentSettings();
        const run = (prompt: string, label: string) => {
          signal.throwIfAborted();
          startedRunner = true;
          const redact = this.channels.get(auditId)?.redact;
          return runAgent({
            kind: settings.runner === 'dsh' ? 'dsh' : 'external', settings, cwd: runtime.root,
            prompt: wrapAgentPrompt('', prompt), log: line => log(redact?.(line) ?? line), signal,
            timeoutMs: Math.max(1, Date.parse(lease.createdAt) + AUDIT_TIMEOUT_MS - Date.now()), label,
            ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
          });
        };
        let recheck: AuditRecheck | undefined;
        let beforeScan: ReviewWorktreeState | undefined;
        if (schedule) {
          reason = 'SCHEDULE_RECHECK_DIRTY';
          beforeScan = await captureReviewWorktree(runtime.root, runtime.vcsType, true);
          const history = await loadAuditHistory(runtime.store, schedule.candidateSource, '.', currentTrustedActor()?.findingWorkflow !== false);
          const recheckPrompt = auditRecheckPrompt(history, lease.baseRevision);
          const previous = recheckPrompt ? await run(recheckPrompt, '定时审查历史复查') : undefined;
          signal.throwIfAborted();
          if (!await scheduledBaseMatches!() || !await compatibleAuditBase(runtime.vcs, lease.baseRevision, lease.svnUrl)
            || !(await runtime.vcs.ensureCleanWorkspace()).clean
            || !sameReviewWorktree(beforeScan, await captureReviewWorktree(runtime.root, runtime.vcsType, true))) {
            throw new Error('定时历史复查期间基线或工作区发生变化');
          }
          recheck = await verifyAuditRecheck(history, previous?.ok ? previous.outputTail : '', lease.baseRevision, runtime.vcs);
          reason = 'SCHEDULE_SCAN_DIRTY';
        }
        const prompt = await this.channelPrompt(runtime, lease, fields, note, recheck);
        const execution = await run(prompt, '仓库审查');
        if (!execution.ok || signal.aborted || !lease.stageSeal || this.stages.get(auditId)?.busy) {
          throw new Error(execution.errorMessage ?? '执行器结束时没有可安全发布的阶段产物');
        }
        let scheduledScan: ReviewWorktreeState | undefined;
        if (beforeScan) {
          scheduledScan = await captureReviewWorktree(runtime.root, runtime.vcsType, true);
          const prior = new Set(lease.candidateIdsBefore);
          const newIds = (await runtime.store.listCandidateIds()).filter(candidate => !prior.has(candidate));
          if (!await scheduledBaseMatches!() || !permittedScanOutputs(beforeScan, scheduledScan, auditId, newIds)) {
            throw new Error('定时全仓审查写入了本轮产物以外的评审数据，或工作区绑定发生变化');
          }
        }
        return await this.finalizeAudit(runtime, lease, log, signal, true, { scheduledScan, scheduledBaseMatches });
      } catch (error) {
        if (signal.aborted && !startedRunner) {
          delete lease.stageProcessActive;
          await this.releaseLeaseById(auditId);
          return { manual: false, status: 'ABORTED', reason: 'CANCELLED', auditId, baseRevision: lease.baseRevision,
            targetPath: lease.targetPath, commitRevision: null, created: [], deferred: [], report: null, warnings: [], message: '仓库审查在 Runner 启动前已取消' };
        }
        await this.auditLifecycle.markReleasable(auditId);
        const detail = error instanceof Error ? error.message : String(error);
        log(detail);
        return { manual: false, status: 'RECOVERY_REQUIRED', reason: signal.aborted ? 'SYNC_STATE_UNKNOWN' : reason,
          auditId, baseRevision: lease.baseRevision, targetPath: lease.targetPath, commitRevision: null, created: [],
          deferred: [], report: null, warnings: [], detail, message: '仓库审查需要核验现场' };
      } finally {
        this.stopStages(auditId);
        this.host.auditJobLeases.delete(id);
      }
    });
    return job;
  }

  /** 提示词交给外部 Agent 后，Host 仍用持久化租约保护执行期间的工作区。 */
  async auditManual(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    await this.startManualAudit(runtime, res, await readJson(req));
  }

  private async startManualAudit(runtime: Runtime, res: ApiResponse, body: Record<string, unknown>): Promise<void> {
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交，无法开始仓库审查。');
    const clean = await runtime.vcs.ensureCleanWorkspace();
    const owner = await this.host.ownerFor(runtime.root);
    const now = new Date();
    const phased = this.usesStages();
    const fields = phased ? this.readStageFields(body) : { focus: [], extraRequirements: [] };
    const { auditId, reportPath } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'manual', phased },
      clean,
    );
    let prompt: string;
    try {
      if (phased) {
        prompt = await this.channelPrompt(runtime, this.auditLifecycle.find(auditId)!, fields, note);
      } else {
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
        prompt = wrapAgentPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root, sharedSource)}`);
      }
    } catch (error) {
      this.stopStages(auditId);
      this.closeStageChannel(auditId);
      this.stages.delete(auditId);
      await this.releaseLeaseById(auditId);
      throw error;
    }
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
    if (this.isFinalizing(lease.auditId)) throw new ApiError(409, 'conflict', '当前审查正在收尾');
    const job = this.host.jobManager.start('audit', async (log, id, signal) => {
      try {
        return await this.finalizeAudit(runtime, lease, log, signal);
      } finally {
        this.host.auditJobLeases.delete(id);
      }
    });
    this.host.auditJobLeases.set(job.id, lease.auditId);
    return job;
  }

  private async finalizeAudit(
    runtime: Runtime, lease: AuditLeaseRecord, log: (line: string) => void, signal: AbortSignal, automatic = false,
    schedule?: { scheduledScan?: ReviewWorktreeState | undefined; scheduledBaseMatches?: (() => Promise<boolean>) | undefined },
  ) {
    if (this.isFinalizing(lease.auditId)) throw new ApiError(409, 'conflict', '当前审查正在收尾');
    this.finalizing.add(lease.auditId);
    try {
      return await this.host.withWriteLock(runtime.root, async () => {
        const current = this.auditLifecycle.find(lease.auditId);
        if (!current || current.state === 'released' || current.commitOutcomeUnknown || (automatic && current.state !== 'active')) {
          return {
            status: 'ABORTED', auditId: lease.auditId, commitRevision: null, created: [],
            reportPath: `.ai-review/audits/${lease.auditId}/audit.md`, message: '租约已释放或不存在，未重复收尾',
          };
        }
        if (current.phased) {
          const before = new Set(current.candidateIdsBefore);
          try {
            if (!current.stageSeal || this.stages.get(current.auditId)?.busy
              || !await compatibleAuditBase(runtime.vcs, current.baseRevision, current.svnUrl)
              || !(await runtime.vcs.ensureCleanWorkspace()).clean) throw new Error('未发布或基线发生变化');
            const newCandidates = (await runtime.store.listCandidateIds()).filter(id => !before.has(id));
            await assertStageArtifacts(runtime.root, current.stageSeal, newCandidates);
          } catch (error) {
            await this.auditLifecycle.markReleasable(current.auditId);
            const failed = { status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', auditId: current.auditId,
              detail: error instanceof Error ? error.message : String(error), commitRevision: null, created: [] };
            this.host.auditJobFinishes.get(current.auditId)?.(failed);
            this.host.auditJobFinishes.delete(current.auditId);
            return failed;
          }
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
          ...(schedule?.scheduledBaseMatches ? { scheduledBaseMatches: schedule.scheduledBaseMatches } : {}),
          signal,
        });
        if (automatic) delete current.stageProcessActive;
        const result = await auditor.finalize({
          ...(schedule?.scheduledScan ? { scheduledScan: schedule.scheduledScan } : {}),
          auditId: current.auditId,
          beforeIds: new Set(current.candidateIdsBefore),
          beforeCommit: () => this.auditLifecycle.transition(current.auditId, current.state, true),
          ...(current.phased ? {
            phasedItems: current.stageItems ?? [],
            phasedSeal: current.stageSeal!,
            ...(current.stageRecheck ? { recheck: current.stageRecheck } : {}),
            ...(this.host.deps.auditStageGates ? {
              phasedGate: (patch: string, commands: string[]) => verifyStageGates(current, runtime.vcsType, patch, commands,
                this.host.deps.auditStageGates!, this.host.currentSettings().gateTimeoutMs, signal),
            } : {}),
          } : {}),
          baseRevision: current.baseRevision,
          ...(current.svnUrl ? { svnUrl: current.svnUrl } : {}),
          targetPath: current.targetPath,
          trigger: current.trigger,
          runError: null,
          startedAt: new Date(current.createdAt).getTime(),
          now: new Date(),
        });
        if (result.status === 'COMMITTED' || result.status === 'VALIDATION_FAILED') {
          await this.auditLifecycle.transition(current.auditId, 'released', false);
          this.clearAuditLeaseTimeout(current.auditId);
          this.closeStageChannel(current.auditId);
          this.stages.delete(current.auditId);
        } else {
          if (result.reason === 'COMMIT_OUTCOME_UNKNOWN') {
            await this.auditLifecycle.transition(current.auditId, 'releasable', true);
            this.clearAuditLeaseTimeout(current.auditId);
          } else {
            const state = automatic || signal.aborted ? 'releasable' : current.state;
            await this.auditLifecycle.transition(current.auditId, state, false);
          }
          log(`收尾未完成（${result.status}），租约 ${current.auditId} 保持占用`);
        }
        const outcome = {
          status: result.status,
          auditId: current.auditId,
          baseRevision: current.baseRevision,
          commitRevision: result.commitRevision,
          created: result.created,
          dataValidation: result.dataValidation,
          reportPath: result.reportPath,
          ...(schedule ? {
            manual: false, targetPath: current.targetPath, deferred: result.deferred, warnings: result.warnings,
            report: { path: result.reportPath, text: result.body, deferred: result.deferred },
          } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
          message: result.message,
        };
        log(`结果：${result.status} — ${result.message}`);
        this.finishAuditTracking(current.auditId, outcome);
        return outcome;
      });
    } finally {
      this.finalizing.delete(lease.auditId);
      if (!automatic && !this.leaseTimeouts.has(lease.auditId)) this.armAuditLeaseTimeout(lease.auditId);
    }
  }

  async auditFinalize(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const auditId = stringField(body, 'auditId');
    if (!auditId) throw new ApiError(400, 'bad_request', '缺少 auditId');
    const lease = this.auditLifecycle.find(auditId);
    if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
    if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
    if (this.isFinalizing(lease.auditId)) throw new ApiError(409, 'conflict', '当前审查正在收尾');
    if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放，不能重复收尾`);
    if (lease.commitOutcomeUnknown) throw new ApiError(409, 'conflict', '提交结果待核验，禁止重试收尾；核验后可确认释放租约');
    if (lease.phased && lease.trigger === 'scheduled') throw new ApiError(409, 'conflict', '定时审查须沿用原任务的自动收尾或中央恢复流程');
    if (lease.stageProcessActive) throw new ApiError(409, 'conflict', '须先确认审查 Runner 已退出并完成阶段核验');
    if (lease.phased && (!lease.stageSeal || this.stages.get(auditId)?.busy)) {
      throw new ApiError(409, 'conflict', '分阶段审查尚未发布或阶段仍在执行');
    }
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
    await this.host.withWriteLock(runtime.root, async () => {
      const lease = this.auditLifecycle.find(auditId);
      if (!lease) throw new ApiError(404, 'not_found', `审查租约不存在：${auditId}`);
      if (lease.root !== runtime.root) throw new ApiError(409, 'conflict', '租约属于另一个仓库检出');
      if (lease.state === 'released') throw new ApiError(409, 'conflict', `租约 ${auditId} 已释放`);
      if (this.isFinalizing(auditId)) throw new ApiError(409, 'conflict', '当前审查正在收尾');
      if (lease.commitOutcomeUnknown && body['confirmCommitChecked'] !== true) {
        throw new ApiError(409, 'conflict', '必须显式确认已核验提交结果（confirmCommitChecked: true）');
      }
      if (lease.state === 'active' && !lease.commitOutcomeUnknown) {
        throw new ApiError(409, 'conflict', `租约 ${auditId} 仍处于活跃状态；请先取消审查 Job 或等待超时（releasable）后再释放`);
      }
      if (this.stages.get(auditId)?.busy) throw new ApiError(409, 'conflict', '阶段进程正在停止，暂不能释放租约');
      // 外部 Agent 停止后也可能留下业务改动，释放前须检查工作区。
      const clean = await runtime.vcs.ensureCleanWorkspace();
      if (!clean.clean) {
        throw new ApiError(409, 'conflict', `工作区仍有未还原改动，不能释放租约。\n${clean.message}`);
      }
      await this.auditLifecycle.transition(auditId, 'released');
      this.clearAuditLeaseTimeout(auditId);
      this.closeStageChannel(auditId);
      this.stages.delete(auditId);
      this.host.auditJobFinishes.get(lease.auditId)?.({
        status: 'ABORTED',
        auditId: lease.auditId,
        message: '租约已由人工确认停止后释放',
      });
      this.host.auditJobFinishes.delete(lease.auditId);
      sendJson(res, 200, { released: true });
    });
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
