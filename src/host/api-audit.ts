import { mkdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import { wrapAgentPrompt } from './runner.js';
import { loadReviewers } from './reviewers.js';
import { dshHome } from './settings.js';
import type { JobRecord } from './types.js';
import { ApiError } from './types.js';
import {
  composeSessionPrompt,
  readJson,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type Runtime,
} from './api-context.js';

/**
 * 审查生命周期装配：租约持久化与状态机、开始/收尾/释放、跟踪 Job、1 小时超时、
 * 审查提示词与 /sync。
 *
 * 分层：本模块只依赖 api-context（窄接口），不反向 import api.ts。
 * 横切语义仍由 api.ts 的 dispatch 按 RouteKind 统一套用：
 * - `/audit/prompt` 属 read（不加锁、不判互斥）；
 * - audit-control 类别由 dispatch 做受理期互斥判定；本模块 handler 只在 beginAuditLease
 *   与 Job 体内按既有语义取锁，与拆分前完全一致。
 */
export class AuditRuntime {
  /** A4：租约状态机集中到 AuditLifecycle（唯一迁移入口）；此处只保留持久化适配器。 */
  private lifecycle: AuditLifecycle | null = null;

  constructor(private readonly host: ApiHost) {}

  private get leaseStatePath(): string {
    return this.host.deps.statePath ?? path.join(dshHome(), 'dsh-code-review', 'runtime-state.json');
  }

  /** §7.6 审查租约状态机；未初始化时抛 500。 */
  get auditLifecycle(): AuditLifecycle {
    if (!this.lifecycle) throw new ApiError(500, 'internal', '审查租约状态机未初始化');
    return this.lifecycle;
  }

  /** Host 启动时加载持久化租约：active/releasable 租约继续参与互斥，直到 finalize 或 release。 */
  async loadAuditLeases(): Promise<void> {
    this.lifecycle = new AuditLifecycle({
      load: async () => {
        try {
          const text = await readFile(this.leaseStatePath, 'utf8');
          const parsed = JSON.parse(text) as { leases?: AuditLeaseRecord[] };
          return Array.isArray(parsed.leases) ? parsed.leases : [];
        } catch {
          return [];
        }
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

  /**
   * §7.6/§7.7：把指定租约迁到 `released`（默认）并持久化。
   * 只用于“Host 自身已证明执行结束”的场景：审查 Job 正常结束、会话创建失败、finalize 已完成。
   * 取消/超时只迁到 `releasable`，必须人工确认后 release。
   */
  async releaseLeaseById(auditId: string, state: 'released' | 'releasable' = 'released'): Promise<void> {
    const lease = this.auditLifecycle.find(auditId);
    if (!lease || lease.state === state) return;
    try {
      await this.auditLifecycle.transition(auditId, state);
    } catch (error) {
      if (error instanceof LeaseTransitionError) return; // 已是终态或非法迁移：保持现状
      throw error;
    }
    if (state === 'released') {
      this.host.auditJobFinishes.get(auditId)?.({ status: 'ABORTED', auditId, message: '审查执行已结束，租约已释放' });
      this.host.auditJobFinishes.delete(auditId);
    }
  }

  /** §7.6：审查执行超时上限 1 小时；超时只把租约置 releasable，不自动解除互斥。 */
  armAuditLeaseTimeout(auditId: string): void {
    const timer = setTimeout(() => {
      // §7.6：超时只把 active 迁到 releasable（仍阻塞），绝不自动释放。
      void this.auditLifecycle.markReleasable(auditId).then((changed) => {
        if (!changed) return;
        this.host.auditJobFinishes.get(auditId)?.({
          status: 'RECOVERY_REQUIRED',
          reason: 'SYNC_STATE_UNKNOWN',
          detail: '审查执行超过 1 小时上限，租约已置为 releasable，请人工确认后 /audit/release',
        });
        this.host.auditJobFinishes.delete(auditId);
      }).catch(() => undefined);
    }, 60 * 60 * 1000);
    timer.unref?.();
  }

  /** §7.7：创建 audit 跟踪 Job；取消/超时只把租约置 releasable，不自动释放。 */
  startAuditTrackingJob(auditId: string): JobRecord {
    const job = this.host.jobManager.start('audit', () => new Promise<unknown>((resolve) => {
      this.host.auditJobFinishes.set(auditId, (result) => { resolve(result); });
    }));
    this.host.auditJobLeases.set(job.id, auditId);
    return job;
  }

  /**
   * §7.7：审查启动的互斥检查 + 工作区前置条件必须与租约写入处于同一临界区，
   * 否则两个并发审查请求可同时通过检查并各自写入 active 租约（TOCTOU）。
   * 本方法只在调用方已持有 repo 锁时使用。
   */
  private assertAuditStartAllowed(runtime: Runtime, clean: { clean: boolean; message: string }): void {
    const running = this.host.jobManager.list().find((job) => job.status === 'running');
    if (running) {
      throw new ApiError(409, 'conflict', `已有任务在运行（${running.type}），请等待完成后再开始仓库审查。`);
    }
    // §7.6/§7.7：任何未释放的执行租约（手动/会话/定时）都必须阻止新的审查。
    this.host.ensureNoAuditRunning(runtime.root);
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `仓库审查要求业务工作区干净。\n${clean.message}`);
    }
  }

  /** §7.7：在 repo 锁内完成“互斥判定 → auditId 分配 → 写入 active 租约”。 */
  private async beginAuditLease(
    runtime: Runtime,
    input: { targetPath: string; baseRevision: string; owner: string; now: Date; trigger: 'manual' | 'scheduled' },
    clean: { clean: boolean; message: string },
  ): Promise<{ auditId: string; reportPath: string }> {
    const archive = new AuditArchive(runtime.root);
    let auditId = '';
    await this.host.withWriteLock(runtime.root, async () => {
      this.assertAuditStartAllowed(runtime, clean);
      auditId = await archive.nextAuditId(input.targetPath, input.now);
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
    });
    return { auditId, reportPath: `.ai-review/audits/${auditId}/audit.md` };
  }

  /** §18.2：把 reviewers.yml 解析结果作为提示词参数传入审查会话。 */
  async ownerRoutingBlock(repoRoot: string): Promise<string> {
    const config = await loadReviewers(repoRoot);
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

  async auditPrompt(res: ServerResponse, url: URL): Promise<void> {
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
    const promptWithRouting = `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`;
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

  async auditSession(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    // §7.6：会话审查同样持有执行租约 + 跟踪 audit Job；turn 结束后由 /audit/finalize 收尾。
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
    const prompt = composeSessionPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    const title = `仓库审查 · ${target.targetPath || '全仓库'}`.slice(0, 60);
    let created: { sessionId: string };
    try {
      created = await this.host.deps.createAuditSession({ cwd: runtime.root, title, prompt, ownerSessionId });
    } catch (error) {
      // 会话创建失败：租约不得残留，否则仓库会被阻塞到人工 release。
      await this.releaseLeaseById(auditId).catch(() => undefined);
      throw error;
    }
    // 跟踪 Job 保持 running，直到 /audit/finalize（或 release / 取消）完成它。
    const job = this.startAuditTrackingJob(auditId);
    this.armAuditLeaseTimeout(auditId);
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

  async audit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const body = await readJson(req);
    const targetPath = stringField(body, 'targetPath');
    const note = stringField(body, 'note');
    const target = await resolveAuditTarget(runtime.root, targetPath);
    const baseRevision = await runtime.vcs.getCurrentBase();
    if (!baseRevision) {
      throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交（Git HEAD / SVN revision），无法开始仓库审查。');
    }
    const clean = await runtime.vcs.ensureCleanWorkspace();
    const owner = await this.host.ownerFor(runtime.root);
    // §7.6/§7.7：headless 审查持有一条与手动/会话模式同语义的执行租约，
    // 保证审查期间其他共享写在受理阶段被 409 拒绝。互斥判定与租约写入在同一 repo 锁内。
    const now = new Date();
    const { auditId } = await this.beginAuditLease(
      runtime,
      { targetPath: target.targetPath, baseRevision, owner, now, trigger: 'scheduled' },
      clean,
    );
    // §7.7：headless Runner 的工作区事务必须与其他共享写经同一 repo 锁串行。
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
        });
        const outcome = await auditor.run();
        log(`结果：${outcome.status} — ${outcome.message}`);
        return outcome;
      } finally {
        // Job 的 task 返回前执行：此刻审查已结束，可安全释放本次执行租约（review 期间保持 active）。
        await this.releaseLeaseById(auditId).catch(() => undefined);
      }
    }));
    this.host.auditJobLeases.set(job.id, auditId);
    sendJson(res, 202, { jobId: job.id, job });
  }

  /**
   * §7.6 手动提示词模式：创建持久化执行租约并返回完整提示词。
   * 外部 Agent 执行期间租约参与全部互斥；只有 /audit/finalize 正常完成才释放，
   * 取消或超时只能由人确认停止后经 /audit/release 释放。
   */
  async auditManual(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    // §7.7：互斥判定、auditId 分配与 active 租约写入在同一 repo 锁内（消除 TOCTOU）。
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
    const prompt = wrapAgentPrompt(await loadAuditSystemPrompt(), `${userPrompt}\n\n${await this.ownerRoutingBlock(runtime.root)}`);
    // §7.6/§8.3：手动模式同样创建可追踪的 audit Job，并受 1 小时执行上限约束。
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

  /**
   * §7.6 手动/会话审查收尾：以 lease 中保存的开始快照执行 Host 收尾与共享提交，
   * 正常完成后释放租约。外部写入的候选按全部校验（含 owner 路由复核）验收。
   */
  async auditFinalize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    const job = this.host.jobManager.start('audit', async (log) => this.host.withWriteLock(runtime.root, async () => {
      // §7.7：收尾提交与全部共享写/工作区事务经同一 repo 锁串行。
      // 锁内重新检查租约状态：并发 finalize 的第二个请求不得重复提交。
      if (lease.state === 'released') {
        log(`租约 ${lease.auditId} 已被另一次收尾释放，跳过重复收尾`);
        return {
          status: 'ABORTED',
          auditId: lease.auditId,
          commitRevision: null,
          created: [],
          reportPath: `.ai-review/audits/${lease.auditId}/audit.md`,
          message: '租约已释放，未重复收尾',
        };
      }
      const auditor = new Auditor({
        store: runtime.store,
        vcs: runtime.vcs,
        settings: this.host.currentSettings(),
        owner: lease.owner,
        targetPath: lease.targetPath,
        note: '',
        log,
        ...(this.host.deps.resolveCredential ? { resolveCredential: this.host.deps.resolveCredential } : {}),
      });
      const result = await auditor.finalize({
        auditId: lease.auditId,
        beforeIds: new Set(lease.candidateIdsBefore),
        baseRevision: lease.baseRevision,
        targetPath: lease.targetPath,
        trigger: lease.trigger,
        runError: null,
        startedAt: new Date(lease.createdAt).getTime(),
        now: new Date(),
      });
      // §7.6：只有收尾正常完成（COMMITTED / VALIDATION_FAILED）才释放租约；
      // ABORTED 或结果不明（RECOVERY_REQUIRED）必须保留租约，让仓库继续处于互斥状态，
      // 等待人工核对后重试 finalize 或显式 release。
      if (result.status === 'COMMITTED' || result.status === 'VALIDATION_FAILED') {
        await this.auditLifecycle.transition(lease.auditId, 'released');
        this.host.auditJobFinishes.get(lease.auditId)?.({
          status: result.status,
          auditId: lease.auditId,
          commitRevision: result.commitRevision,
          message: result.message,
        });
        this.host.auditJobFinishes.delete(lease.auditId);
      } else {
        log(`收尾未完成（${result.status}），租约 ${lease.auditId} 保持占用，请核对后重试 finalize 或 /audit/release`);
      }
      log(`结果：${result.status} — ${result.message}`);
      return {
        status: result.status,
        auditId: lease.auditId,
        commitRevision: result.commitRevision,
        created: result.created,
        reportPath: result.reportPath,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        message: result.message,
      };
    }));
    sendJson(res, 202, { jobId: job.id, job });
  }

  /** §7.6 释放租约：仅在租约已取消/超时（releasable）或人工确认外部执行已停止后使用。 */
  async auditRelease(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    // §8.3：仅在租约已取消/超时（releasable）后可用；仍活跃的租约必须 409。
    if (lease.state === 'active') {
      throw new ApiError(409, 'conflict', `租约 ${auditId} 仍处于活跃状态；请先取消审查 Job 或等待超时（releasable）后再释放`);
    }
    // 复核工作区：外部执行可能残留未还原改动。
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

  async sync(res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    const { vcs } = runtime;
    this.host.ensureNoAuditRunning(runtime.root);
    // §7.7：/sync 与其他工作区事务在同一 repo 锁内串行，不得改变其基线。
    const result = await this.host.withWriteLock(runtime.root, () => vcs.syncAndGetLatestBase());
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
