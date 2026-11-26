/**
 * 交互式 Mode B 提案会话（POST /fix-session、POST /fix-session/release）与持久化工作副本占用（AC-API-01 / SPEC §5.4）：
 * - 受理前强制校验完整 ConcurrencyGuard、显式 optionId/patchId、Owner、合法状态、总体/本方案未解决评论与干净工作区；
 * - 占用记录持久化到 DSH_HOME 状态目录（重启后仍阻塞并发写，绝不靠 1 小时盲超时自动释放）；
 * - 仅在核验会话停止且业务工作区干净还原后才释放占用（支持回合结束自动核验与显式释放）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  guardFrom,
  readJson,
  requireSelectionFrom,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type ApiRequest,
  type ApiResponse,
  type FixSessionOccupancy,
  type Runtime,
} from './api-context.js';
import { COMMENTABLE_STATUSES, requireExplicitSelection } from './issue-review.js';
import { buildModeBPrompt, loadProposalSystemPrompt, unresolvedCommentsForOption, wrapAgentPrompt } from './runner.js';
import { dshHome } from './settings.js';
import { ApiError } from './types.js';

export class FixSessionRegistry {
  private readonly filePath: string;
  private entries = new Map<string, FixSessionOccupancy>();
  private unsubscribes = new Map<string, () => void>();
  private loaded = false;

  constructor(statePath?: string) {
    const dir = statePath ? path.dirname(statePath) : path.join(dshHome(), 'dsh-code-review');
    this.filePath = path.join(dir, 'fix-sessions.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw error;
    }
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`持久化提案会话占用状态格式无效：${this.filePath}`);
    }
    for (const item of raw) {
      if (item && typeof item === 'object' && typeof (item as FixSessionOccupancy).root === 'string') {
        const entry = item as FixSessionOccupancy;
        this.entries.set(entry.root, entry);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(temp, `${JSON.stringify([...this.entries.values()], null, 2)}\n`, 'utf8');
    await rename(temp, this.filePath);
  }

  activeFor(root: string): FixSessionOccupancy | undefined {
    return this.entries.get(root);
  }

  async acquire(entry: FixSessionOccupancy): Promise<void> {
    await this.load();
    if (this.entries.has(entry.root)) {
      const current = this.entries.get(entry.root)!;
      throw new ApiError(
        409,
        'conflict',
        `工作副本正被交互式提案会话占用（${current.candidateId} / session ${current.sessionId || '启动中'}），须先确认停止并收尾或清理后再操作`,
      );
    }
    this.entries.set(entry.root, entry);
    await this.persist();
  }

  async updateSessionId(root: string, sessionId: string): Promise<void> {
    const entry = this.entries.get(root);
    if (!entry) return;
    entry.sessionId = sessionId;
    entry.state = 'active';
    await this.persist();
  }

  attachTurnListener(root: string, unsubscribe: () => void): void {
    this.unsubscribes.get(root)?.();
    this.unsubscribes.set(root, unsubscribe);
  }

  /**
   * 仅当根会话已确认停止（若宿主提供 stopAuditSession）且业务工作区经还原后确认干净时，才释放持久化占用。
   * 无法核验时保留占用，绝不盲目清除！
   */
  async releaseVerified(
    root: string,
    runtime: Runtime,
    stopSession?: (sessionId: string, signal: AbortSignal, processStopped: Promise<boolean>) => Promise<boolean>,
  ): Promise<boolean> {
    await this.load();
    const entry = this.entries.get(root);
    if (!entry) return true;
    entry.state = 'verifying';
    await this.persist().catch(() => undefined);

    if (entry.sessionId && stopSession) {
      const stopped = await stopSession(entry.sessionId, AbortSignal.timeout(15_000), Promise.resolve(true)).catch(() => false);
      if (!stopped) return false;
    }

    await runtime.vcs.revertBusinessWorkspace().catch(() => undefined);
    const clean = await runtime.vcs.ensureCleanWorkspace().catch(() => null);
    if (!clean?.clean) return false;

    this.unsubscribes.get(root)?.();
    this.unsubscribes.delete(root);
    this.entries.delete(root);
    await this.persist();
    return true;
  }

  /** 仅在 createFixSession 尚未创建出任何会话且工作区未动时同步回滚占位。 */
  async abortUncreated(root: string): Promise<void> {
    this.unsubscribes.get(root)?.();
    this.unsubscribes.delete(root);
    this.entries.delete(root);
    await this.persist().catch(() => undefined);
  }
}

export async function handleCreateFixSession(
  host: ApiHost,
  req: ApiRequest,
  res: ApiResponse,
  url: URL,
  registry: FixSessionRegistry,
): Promise<void> {
  if (!host.deps.createFixSession) {
    throw new ApiError(501 as unknown as number, 'internal', '当前宿主环境未提供交互式 DSH 会话能力（createFixSession）');
  }
  const body = await readJson(req);
  const id = stringField(body, 'id');
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  const guard = guardFrom(body);
  const requestedSelection = requireSelectionFrom(body);

  const runtime = await host.runtimeFor(url);
  host.ensureNoAuditRunning(runtime.root);
  const actor = await host.ownerFor(runtime.root);

  // 在 repo 锁内完成前置核验与持久占用登记，不在等待会话投递期间长期占用 repo 锁。
  const prepared = await host.withWriteLock(runtime.root, async () => {
    host.ensureNoAuditRunning(runtime.root);
    const source = await sharedSourceFor(runtime);
    const base = await runtime.vcs.getCurrentBase();
    if (!base) throw new ApiError(412, 'not_configured', '当前仓库没有可用的基线提交');
    const detail = await runtime.store.get(id, base, source, undefined, requestedSelection);
    const candidate = detail.candidate;
    if (candidate.parseError) throw new ApiError(409, 'conflict', `问题记录损坏：${candidate.parseError}`);
    const meta = candidate.meta;

    runtime.store.checkGuard(meta, guard);
    if (meta.owner !== actor) {
      throw new ApiError(403, 'forbidden', `仅当前共享负责人 ${meta.owner} 可发起交互式提案修订`);
    }
    if (!COMMENTABLE_STATUSES.has(meta.status)) {
      throw new ApiError(409, 'conflict', `当前状态 ${meta.status} 不允许发起 Mode B 提案修订会话`);
    }

    const { option, patch } = requireExplicitSelection(meta, requestedSelection);
    const unresolved = unresolvedCommentsForOption(meta.comments, option.id);
    if (unresolved.length === 0) {
      throw new ApiError(409, 'conflict', `方案 ${option.id} 及总体意见中没有未解决评论，无需启动修订会话`);
    }

    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(409, 'conflict', `启动提案修订会话前业务工作区必须干净：${clean.message}`);
    }

    const systemPrompt = await loadProposalSystemPrompt();
    const userPrompt = buildModeBPrompt({
      candidate,
      option,
      patchEntry: patch,
      patchText: detail.patchText,
      targetBase: base,
      vcsType: runtime.vcsType,
      intent: 'revise',
      mode: 'session',
    });
    const prompt = wrapAgentPrompt(systemPrompt, userPrompt);
    const title = `提案修订：${meta.title}（${option.id}）`;

    await registry.acquire({
      root: runtime.root,
      candidateId: candidate.id,
      optionId: option.id,
      patchId: patch.id,
      sessionId: '',
      owner: actor,
      createdAt: new Date().toISOString(),
      state: 'creating',
    });

    return { candidate, option, patch, prompt, title };
  });

  const ownerSessionId = url.searchParams.get('sessionId') ?? undefined;
  let sessionId = '';
  try {
    const created = await host.deps.createFixSession({
      cwd: runtime.root,
      title: prepared.title,
      prompt: prepared.prompt,
      ...(ownerSessionId ? { ownerSessionId } : {}),
    });
    sessionId = created.sessionId;
    await registry.updateSessionId(runtime.root, sessionId);
  } catch (error) {
    // 若创建失败，仅在确认工作区仍干净且未留下会话时释放占位；否则保留占用等待核验。
    const clean = await runtime.vcs.ensureCleanWorkspace().catch(() => null);
    if (clean?.clean && !sessionId) {
      await registry.abortUncreated(runtime.root);
    }
    throw error;
  }

  // 回合结束或会话空闲时必须核验停止并还原清理工作区后才释放占用（绝不盲目释放或按固定时钟超时清除）。
  if (host.deps.onAuditTurnEnd) {
    const unsubscribe = host.deps.onAuditTurnEnd(sessionId, () => {
      void host.withWriteLock(runtime.root, async () => {
        await registry.releaseVerified(runtime.root, runtime, host.deps.stopAuditSession);
      }).catch(() => undefined);
    });
    registry.attachTurnListener(runtime.root, unsubscribe);
  } else if (host.deps.withAuditSessionIdle) {
    const idleController = new AbortController();
    registry.attachTurnListener(runtime.root, () => idleController.abort());
    void host.deps.withAuditSessionIdle(
      sessionId,
      `fix-session-${sessionId}`,
      idleController.signal,
      async () => {
        await host.withWriteLock(runtime.root, async () => {
          await registry.releaseVerified(runtime.root, runtime, host.deps.stopAuditSession);
        });
      },
    ).catch(() => undefined);
  }

  sendJson(res, 202, {
    sessionId,
    title: prepared.title,
    candidateId: prepared.candidate.id,
    revision: prepared.candidate.meta.recordRevision,
    optionId: prepared.option.id,
    patchId: prepared.patch.id,
    prompt: prepared.prompt,
  });
}

/** POST /fix-session/release — 人工确认提案会话已停止后，经宿主核验停止并还原工作区干净才释放持久化占用。 */
export async function handleReleaseFixSession(
  host: ApiHost,
  req: ApiRequest,
  res: ApiResponse,
  url: URL,
  registry: FixSessionRegistry,
): Promise<void> {
  const body = await readJson(req);
  if (body['confirmStopped'] !== true) {
    throw new ApiError(422, 'bad_request', '释放提案会话占用前必须显式确认 confirmStopped=true');
  }
  const runtime = await host.runtimeFor(url);
  const current = registry.activeFor(runtime.root);
  if (!current) {
    sendJson(res, 200, { released: true, message: '当前仓库无活跃的提案会话占用' });
    return;
  }
  const released = await registry.releaseVerified(runtime.root, runtime, host.deps.stopAuditSession);
  if (!released) {
    throw new ApiError(
      409,
      'conflict',
      `无法核验提案会话 ${current.sessionId || '(未知)'} 已完全停止且工作区已还原干净，保留占用阻塞并发写`,
    );
  }
  sendJson(res, 200, {
    released: true,
    sessionId: current.sessionId,
    candidateId: current.candidateId,
    message: '已核验提案会话停止且工作区干净，工作副本占用已释放',
  });
}
