import type { ApiRequest, ApiResponse } from './api-context.js';
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

/** 面板在交互式 DSH 会话里投递修复任务的适配层。会话产出的候选由 Host 收尾提交。 */
export class FixSessions {
  constructor(private readonly host: ApiHost) {}

  /** 修复会话会写工作区，需持续占用以免并发任务覆盖补丁。等待宿主创建和投递时也不用长期占住仓库写锁。 */
  private readonly inFlight = new Map<string, { candidateId: string; sessionId: string; release: () => void }>();

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

  async create(req: ApiRequest, res: ApiResponse, url: URL): Promise<void> {
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
    // 已有工作区改动可能被误收进会话生成的补丁。
    const clean = await runtime.vcs.ensureCleanWorkspace();
    if (!clean.clean) throw new ApiError(409, 'conflict', `启动修复会话要求业务工作区干净。\n${clean.message}`);
    const prompt = await this.fixPrompt(runtime, candidate);
    const title = `AI 修复 · ${candidate.meta.title}`.replace(/\s+/g, ' ').slice(0, 60);
    const ownerSessionId = url.searchParams.get('sessionId') ?? '';
    // 检查与占位之间不能让出执行权，否则并发请求都可能通过检查。
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
