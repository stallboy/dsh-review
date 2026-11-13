import type { IncomingMessage, ServerResponse } from 'node:http';
import { Runner, loadSystemPrompt, toSessionFixPrompt } from './runner.js';
import { ApiError, type ReviewCandidate } from './types.js';
import {
  readJson,
  sendJson,
  sharedSourceFor,
  stringField,
  type ApiHost,
  type Runtime,
} from './api-context.js';

/**
 * §7.4（2026-11-12 新增）：在**独立 DSH 会话**中启动修复（「提交并让 AI 修复」的执行器之一）。
 *
 * 与两条既有路径的区别：
 * - `manual` Runner：只生成可复制的提示词，由人贴到外部 Agent（本次需求要求继续保留）；
 * - `dsh` headless Runner：spawn `dsh --profile headless`，在后台 Job 里跑完；
 * - 本模块：用 Host `sessionController` 新建**可见会话**并投递同一份修复提示词。
 *
 * 提交语义保持不变（§7.6/§11.4）：会话只产出 `.ai-review/` 候选新版本，不 commit；
 * 用户回到面板点「收尾」时由 Host 校验并原子提交。因此这里不创建审查执行租约，
 * 只要求工作区干净、owner 匹配、候选可解析。
 */
export class FixSessions {
  constructor(private readonly host: ApiHost) {}

  /**
   * §7.7（2026-11-12）：同一仓库同一时刻只能有**一个**在执行的修复会话。
   *
   * 为什么不用 repo 锁：`workspace-txn` 只在受理阶段做审查互斥，且创建会话要等待
   * `sessionController.prompt`（最长 60 秒），把它放进 repo 锁会长时间阻塞 approve/sync。
   * 但修复会话会真实改写工作区，两个并行会话必然互相覆盖补丁——因此用一个跨整个
   * 修复过程的显式占用记录（进程内，键为仓库根与候选 id），turn 结束后由 Host 释放。
   */
  private readonly inFlight = new Map<string, { candidateId: string; sessionId: string; release: () => void }>();

  /** 该仓库当前是否已有未结束的修复会话（诊断/测试用）。 */
  activeFor(root: string): { candidateId: string; sessionId: string } | undefined {
    const entry = this.inFlight.get(root);
    return entry ? { candidateId: entry.candidateId, sessionId: entry.sessionId } : undefined;
  }

  private release(root: string, sessionId: string): void {
    const entry = this.inFlight.get(root);
    if (entry && entry.sessionId === sessionId) {
      this.inFlight.delete(root);
      entry.release();
    }
  }

  /** 由 `manual` Runner 的提示词生成「新会话」版本的完整执行提示词。 */
  async fixPrompt(runtime: Runtime, candidate: ReviewCandidate): Promise<string> {
    const comments = candidate.meta.comments.filter((comment) => comment.status !== 'resolved');
    const runner = new Runner({
      kind: 'manual',
      settings: this.host.currentSettings(),
      store: runtime.store,
      candidate,
      mode: 'ADDRESS_FEEDBACK',
      comments,
      log: () => undefined,
    });
    const result = await runner.run();
    const manualPrompt = result.prompt ?? result.errorMessage;
    if (!manualPrompt) throw new ApiError(500, 'internal', '无法生成修复提示词');
    return toSessionFixPrompt(manualPrompt, await loadSystemPrompt());
  }

  async create(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runtime = await this.host.runtimeFor(url);
    if (!this.host.deps.createFixSession) {
      throw new ApiError(500, 'internal', '当前 Host 不支持创建 DSH 会话（sessionController 未挂载）；可用「导出修复提示词」手动执行。');
    }
    const body = await readJson(req);
    const id = stringField(body, 'id');
    if (!id) throw new ApiError(400, 'bad_request', '缺少候选 id');
    const source = await sharedSourceFor(runtime);
    const detail = await runtime.store.get(id, null, source);
    const candidate = detail.candidate;
    if (candidate.parseError) throw new ApiError(422, 'bad_request', candidate.parseError);
    // §12.2：只有 Owner 可以让 Agent 改写自己负责的候选。
    const me = await this.host.ownerFor(runtime.store.repoRoot);
    if (candidate.meta.owner !== me) {
      throw new ApiError(403, 'forbidden', `当前操作者 ${me} 不是候选 Owner`);
    }
    if (candidate.meta.status === 'approved' || candidate.meta.status === 'rejected') {
      throw new ApiError(409, 'conflict', '已归档的候选不能再启动修复会话');
    }
    if (candidate.meta.comments.filter((comment) => comment.status !== 'resolved').length === 0) {
      throw new ApiError(409, 'conflict', '没有未解决的评论可交给修复会话；请先提出具体意见');
    }
    // §11.4：修复会话会真实改动工作区，必须从干净基线开始，避免把未审改动混进新补丁。
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', `启动修复会话要求业务工作区干净。\n${clean.message}`);
    const prompt = await this.fixPrompt(runtime, candidate);
    const title = `AI 修复 · ${candidate.meta.title}`.replace(/\s+/g, ' ').slice(0, 60);
    const ownerSessionId = url.searchParams.get('sessionId') ?? '';
    // 在同一同步段内「检查 + 占位」，避免两个请求同时通过上面的检查后各建一个会话。
    // 占位从受理开始，一直持续到 turn 结束 / 1 小时上限 / 创建失败。
    const busy = this.inFlight.get(runtime.store.repoRoot);
    if (busy) {
      throw new ApiError(409, 'conflict', `已有修复会话在执行（${busy.candidateId} · ${busy.sessionId}）；请等待其结束后再启动新会话。`);
    }
    const root = runtime.store.repoRoot;
    const timer = setTimeout(() => { this.release(root, created.sessionId); }, 60 * 60 * 1000);
    timer.unref?.();
    let off: (() => void) | undefined;
    const placeholder = {
      candidateId: candidate.id,
      sessionId: '(creating)',
      release: () => { clearTimeout(timer); off?.(); },
    };
    this.inFlight.set(root, placeholder);
    let created: { sessionId: string };
    try {
      created = await this.host.deps.createFixSession({
        cwd: root,
        title,
        prompt,
        ...(ownerSessionId ? { ownerSessionId } : {}),
      });
    } catch (error) {
      if (this.inFlight.get(root) === placeholder) {
        this.inFlight.delete(root);
        clearTimeout(timer);
      }
      throw error;
    }
    placeholder.sessionId = created.sessionId;
    // 真实 turn 结束通知可立即释放占用；宿主不提供时由上面的 1 小时上限兜底。
    const subscribe = this.host.deps.onAuditTurnEnd;
    if (subscribe) {
      const unsubscribe = subscribe(created.sessionId, () => { this.release(root, created.sessionId); });
      if (this.inFlight.get(root) === placeholder) off = unsubscribe;
      else unsubscribe();
    }
    sendJson(res, 202, {
      sessionId: created.sessionId,
      title,
      candidateId: candidate.id,
      revision: candidate.meta.currentRevision,
      prompt,
    });
  }
}
