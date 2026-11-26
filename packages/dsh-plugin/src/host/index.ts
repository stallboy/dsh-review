import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { stopDshAuditSession, withDshAuditSessionIdle } from './audit-session-idle.js';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from './api.js';
import { executeAuditCli } from './audit-stage-runner.js';
import type { ApiDeps } from './api-context.js';
import { registerAuditStageTools, type AuditToolRegistry } from './audit-stage-tools.js';
import { dshHome, loadSettings, saveSettings } from './settings.js';
import { ApiError, type AppSettings } from './types.js';
import { loadManagedNode, type ManagedAuditSessions, type ManagedHandle } from '../managed/managed-config.js';
import { ConnectionController, CONNECTION_PREFIX } from '../connection/controller.js';
import { discoverCandidates, resolveWorktree } from '../connection/config.js';
import { CENTRAL_PREFIX } from '../connection/gateway.js';

export interface HostLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface CredentialRef {
  readonly __brand?: unknown;
}

interface CredentialService {
  resolve(reference: CredentialRef | string): Promise<{ value: string } | undefined>;
}

export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}

export interface WebServerService {
  register(route: WebRoute): () => void;
}

export interface HostContext {
  webServer: WebServerService;
  effect(callback: () => void | (() => void | Promise<void>), label?: string): void;
  inject(services: string[], callback: (ctx: HostContext) => void): void;
  get(name: string): unknown;
  on?(event: string, listener: (...args: any[]) => void): (() => void) | void;
  logger?: HostLogger;
}

/** 对应宿主 sessionController 接口，客户端从 ctx.remote.session 访问同一能力。 */
interface DshSessionController {
  create(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId?: unknown }>;
  rename?(request: { sessionId: string; title: string }): Promise<unknown>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue' | 'steer';
      content: Array<{ type: 'text'; text: string }>;
    },
    signal: AbortSignal,
  ): Promise<{ accepted?: unknown }>;
}

interface WorkspaceLike {
  id: string;
  path: string;
}

interface WorkspaceRegistryLike {
  resolveByPath?(path: string): Promise<WorkspaceLike | undefined>;
  list?(): WorkspaceLike[];
}

interface SessionLike {
  readonly header?: { cwd?: string };
}

interface SessionsLike {
  get?(id: string): SessionLike | undefined;
}

interface AgentLike {
  readonly id: string;
}

interface AgentsLike {
  get?(id: string): AgentLike | undefined;
}

type ApprovalPolicy = 'ask' | 'never';

interface PermissionPresetsLike {
  current(session: SessionLike): string;
  set(session: SessionLike, name: string): void;
}

interface ApprovalLike {
  setPolicy(agent: AgentLike, policy: ApprovalPolicy): void;
  overrideOf(session: SessionLike): ApprovalPolicy | undefined;
}

export interface AuditSessionHost {
  get(name: string): unknown;
  on?(event: string, listener: (...args: any[]) => void): (() => void) | void;
  logger?: HostLogger;
}

export const inject = ['webServer'];

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function errorBody(message: string): unknown {
  return { error: { code: 'internal', message } };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return normalize(left) === normalize(right);
}

function describeSessionError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? `${error.message}（${code}）` : error.message;
  }
  return String(error);
}

/** 新会话继承打开面板时选定的权限与审批策略，避免无人值守的门禁退回部署默认值后卡在审批。 */
function inheritOwnerPolicy(
  host: AuditSessionHost,
  ownerSessionId: string,
  auditSessionId: string,
): { preset?: string; approval?: ApprovalPolicy } {
  if (!ownerSessionId || ownerSessionId === auditSessionId) return {};
  const sessions = host.get('sessions') as SessionsLike | undefined;
  const owner = sessions?.get?.(ownerSessionId);
  const audit = sessions?.get?.(auditSessionId);
  if (!owner || !audit) return {};
  const inherited: { preset?: string; approval?: ApprovalPolicy } = {};

  const presets = host.get('permissionPresets') as PermissionPresetsLike | undefined;
  if (presets?.current && presets.set) {
    try {
      const name = presets.current(owner);
      if (name && name !== 'custom') {
        presets.set(audit, name);
        inherited.preset = name;
      }
    } catch (error) {
      host.logger?.warn(`dsh-code-review: 继承权限预设失败：${describeSessionError(error)}`);
    }
  }

  const approval = host.get('approval') as ApprovalLike | undefined;
  const policy = approval?.overrideOf?.(owner);
  if (!inherited.preset && policy && approval?.setPolicy) {
    const agent = (host.get('agents') as AgentsLike | undefined)?.get?.(auditSessionId);
    if (agent) {
      try {
        approval.setPolicy(agent, policy);
        inherited.approval = policy;
      } catch (error) {
        host.logger?.warn(`dsh-code-review: 继承审批策略失败：${describeSessionError(error)}`);
      }
    }
  } else if (policy) {
    inherited.approval = policy;
  }
  return inherited;
}

export async function createDshAuditSession(
  host: AuditSessionHost,
  input: Parameters<NonNullable<ApiDeps['createAuditSession']>>[0],
): Promise<{ sessionId: string }> {
  return createDshSession(host, input, '审查');
}

/** 与审查共用创建流程，单列动作标签以便失败提示指向用户刚选的入口。 */
export async function createDshFixSession(
  host: AuditSessionHost,
  input: { cwd: string; title: string; prompt: string; requestId?: string; ownerSessionId?: string },
): Promise<{ sessionId: string }> {
  return createDshSession(host, input, '修复');
}

/** 将会话挂到 cwd 对应的工作区，才能让侧栏在正确的工作区展示它。 */
async function createDshSession(
  host: AuditSessionHost,
  input: Parameters<NonNullable<ApiDeps['createAuditSession']>>[0],
  label: string,
): Promise<{ sessionId: string }> {
  const controller = host.get('sessionController') as DshSessionController | undefined;
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    const message = `当前 DSH Host 未挂载 sessionController，无法创建${label}会话（请确认 DSH 版本包含 API Session 控制服务）`;
    if (input.requireWorkspace) throw new ApiError(412, 'not_configured', message);
    throw new Error(message);
  }
  const registry = host.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
  let workspace: WorkspaceLike | undefined;
  if (!input.cwdOnly) {
    try {
      workspace = await registry?.resolveByPath?.(input.cwd);
    } catch (error) {
      host.logger?.warn(`dsh-code-review: 按路径解析工作区失败：${describeSessionError(error)}`);
    }
    if (!workspace) {
      workspace = registry?.list?.().find((item) => samePath(item.path, input.cwd));
    }
  }
  if (input.requireWorkspace) {
    const root = await realpath(input.cwd);
    const candidates = new Map((registry?.list?.() ?? []).map(candidate => [candidate.id, candidate]));
    if (workspace) candidates.set(workspace.id, workspace);
    const paths = await Promise.all([...candidates.values()].map(async candidate => ({
      candidate, directory: await realpath(candidate.path).catch(() => null),
    })));
    const exact = paths.filter(({ directory }) => directory === root);
    const matches = label === '审查' || exact.length ? exact : (await Promise.all(paths.map(async entry => {
      if (!entry.directory || !entry.directory.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return null;
      const worktree = await resolveWorktree(entry.directory).catch(() => null);
      return worktree?.root === root ? entry : null;
    }))).filter(entry => entry !== null);
    if (matches.length !== 1) {
      const detail = matches.length ? 'DSH 中有多个项目匹配同一审查工作副本' : 'DSH 中找不到审查工作副本所属的项目，请登记工作副本根目录';
      throw new ApiError(412, 'not_configured', `${detail}：${input.cwd}`);
    }
    workspace = matches[0]!.candidate;
  }
  if (label === '审查' && workspace && await realpath(workspace.path).catch(() => null) !== await realpath(input.cwd)) workspace = undefined;
  input.signal?.throwIfAborted();
  let created: { sessionId?: unknown };
  try {
    created = workspace
      ? await controller.create({ workspaceId: workspace.id })
      : await controller.create({ cwd: input.cwd });
  } catch (error) {
    throw new Error(`创建 DSH ${label}会话失败：${describeSessionError(error)}`);
  }
  const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
  if (!sessionId) throw new Error(`创建 DSH ${label}会话未返回 sessionId`);
  if (controller.rename) {
    try {
      await controller.rename({ sessionId, title: input.title });
    } catch (error) {
      host.logger?.warn(`dsh-code-review: ${label}会话改名失败：${describeSessionError(error)}`);
    }
  }
  const inherited: ReturnType<typeof inheritOwnerPolicy> = label === '审查' ? {} : inheritOwnerPolicy(host, input.ownerSessionId ?? '', sessionId);
  await input.onCreated?.(sessionId);
  try {
    const prompted = await controller.prompt(
      {
        requestId: input.requestId ?? `dsh-code-review-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: input.prompt }],
      },
      AbortSignal.any([AbortSignal.timeout(60_000), ...(input.signal ? [input.signal] : [])]),
    );
    if (prompted?.accepted !== true) throw new Error(`DSH 未接受${label}提示词`);
  } catch (error) {
    throw new Error(`发送${label}任务失败：${describeSessionError(error)}`);
  }
  host.logger?.info(
    `dsh-code-review: 已创建${label}会话 ${sessionId}（workspace=${workspace?.id ?? 'cwd'}，title=${input.title}，` +
      `preset=${inherited.preset ?? 'default'}，approval=${inherited.approval ?? 'default'}）`,
  );
  return { sessionId };
}

export function apply(ctx: HostContext): void {
  const logger = ctx.logger;
  let api: ReviewApi | undefined;
  let managed: ManagedHandle | null = null;
  let disposed = false;
  const shutdown = new AbortController();
  let initError: Error | undefined;
  let localWrites = 0;
  let removeStageTools: (() => void) | undefined;

  const resolveCredential = async (reference: string): Promise<string | undefined> => {
    try {
      const credentials = ctx.get('credentials') as CredentialService | undefined;
      if (!credentials) return undefined;
      const resolved = await credentials.resolve(reference);
      return resolved?.value;
    } catch (error) {
      logger?.warn(`dsh-code-review: 读取凭据 ${reference} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const tools = ctx.get('tools') as AuditToolRegistry | undefined;
  const stageCapabilities = { auditStageExecutor: executeAuditCli };
  const auditSessions: ManagedAuditSessions = {
    ...stageCapabilities,
    auditSessionTools: typeof tools?.register === 'function',
    createAuditSession: (input) => createDshAuditSession(ctx, input),
    stopAuditSession: (sessionId, signal, processStopped) => stopDshAuditSession(
      ctx, sessionId, AbortSignal.any([signal, shutdown.signal]), processStopped,
    ),
    withAuditSessionIdle: (sessionId, requestId, signal, finalize) => withDshAuditSessionIdle(
      ctx, sessionId, requestId, AbortSignal.any([signal, shutdown.signal]), finalize,
    ),
  };
  const connection = new ConnectionController({
    directory: path.join(dshHome(), 'dsh-code-review'),
    resolveCredential,
    auditSessions,
    beforeConfigure: () => {
      if (initError) throw new Error(`本地评审恢复状态无法核验：${initError.message}`);
      if (localWrites || api?.jobManager.list().some(job => job.status === 'running')) throw new Error('本地评审仍有操作执行中，请先处理后启用中央连接');
      api?.ensureNoAuditRunning();
    },
    candidates: async sessionId => {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
      const sessions = ctx.get('sessions') as SessionsLike | undefined;
      const current = sessionId ? sessions?.get?.(sessionId)?.header?.cwd : undefined;
      return discoverCandidates([
        ...(registry?.list?.() ?? []).map(workspace => ({ root: workspace.path })),
        ...(current ? [{ root: current, current: true }] : []),
      ]);
    },
  });

  const ready = (async () => {
    if (typeof tools?.register === 'function') {
      removeStageTools = registerAuditStageTools(tools, sessionId =>
        connection.auditStageApi(sessionId) ?? (api?.hasAuditStageSession(sessionId) ? api : undefined));
    }
    await connection.init();
    if (disposed) { await connection.stop(); return; }
    if (connection.configured) return;
    managed = await loadManagedNode(resolveCredential, error => logger?.warn(`dsh-code-review: 中央连接异常：${error.message}`), stageCapabilities);
    if (disposed) { await managed?.stop(); return; }
    if (managed) {
      logger?.info('dsh-code-review: 托管节点已启动');
      return;
    }
    let settings: AppSettings;
    try {
      settings = await loadSettings();
    } catch (error) {
      logger?.warn(`dsh-code-review: 读取本地设置失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
      const { DEFAULT_SETTINGS } = await import('./settings.js');
      settings = { ...DEFAULT_SETTINGS };
    }
    const instance = new ReviewApi({
      settings,
      saveSettings: async (next) => {
        const saved = await saveSettings(next);
        logger?.info(`dsh-code-review: 设置已保存（repo=${saved.repoRoot || '未配置'}）`);
        return saved;
      },
      resolveCredential,
      ...auditSessions,
      ...(typeof ctx.on === 'function'
        ? {
            onAuditTurnEnd: (sessionId: string, callback: () => void) => {
              const off = ctx.on!('session.idle', (event: { sessionId?: string }) => {
                if (event?.sessionId === sessionId) callback();
              });
              return typeof off === 'function' ? off : () => {};
            },
          }
        : {}),
      createFixSession: (input) => createDshFixSession(ctx, input),
      resolveSessionCwd: (sessionId) => {
        const sessions = ctx.get('sessions') as {
          get?: (id: string) => { header?: { cwd?: string } } | undefined;
        } | undefined;
        if (!sessions?.get) return undefined;
        return sessions.get(sessionId)?.header?.cwd;
      },
      clientEntry: () => {
        const modules = ctx.get('clientModules') as {
          graph?: () => { entries?: Array<{ id?: string; url?: string; rev?: string }> };
        } | undefined;
        if (!modules?.graph) return null;
        return modules.graph().entries?.find((entry) => entry.id === 'dsh-code-review') ?? null;
      },
    });
    await instance.init();
    if (disposed) return;
    api = instance;
    logger?.info(`dsh-code-review host mounted（repo=${settings.repoRoot || '未配置'}）`);
  })().catch((error: unknown) => {
    initError = error instanceof Error ? error : new Error(String(error));
    logger?.error(`dsh-code-review: 初始化失败：${initError.message}`);
  });

  const off = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      await ready;
      if (managed || connection.configured) {
        const endpoint = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (req.method === 'GET' && [API_PREFIX, `${API_PREFIX}/`, `${API_PREFIX}/health`].includes(endpoint)) {
          const state = managed ?? await connection.status();
          writeJson(res, 200, { managed: { centerUrl: state.centerUrl, nodeId: state.nodeId }, configured: true, counts: {} });
        } else writeJson(res, 409, { error: { code: 'managed_mode', message: '当前节点由中央工作台管理，请通过中央服务操作' } });
        return;
      }
      if (!api) {
        writeJson(res, 500, errorBody(`评审初始化失败：${initError?.message ?? '未知错误'}`));
        return;
      }
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) localWrites++;
        const handled = await api.handle(req, res);
        if (!handled) writeJson(res, 404, { error: { code: 'not_found', message: 'unknown endpoint' } });
      } catch (error) {
        if (!res.headersSent) {
          writeJson(res, 500, errorBody(error instanceof Error ? error.message : String(error)));
        } else {
          res.end();
        }
      } finally {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) localWrites--;
      }
    },
  });
  const offConnection = ctx.webServer.register({ kind: 'prefix', path: CONNECTION_PREFIX,
    handler: async (req, res) => { await ready; await connection.handle(req, res); } });
  const offCentral = ctx.webServer.register({ kind: 'prefix', path: CENTRAL_PREFIX,
    handler: async (req, res) => { await ready; await connection.handle(req, res); } });
  ctx.effect(
    () => async () => {
      disposed = true;
      shutdown.abort();
      off();
      removeStageTools?.();
      offConnection();
      offCentral();
      const results = await Promise.allSettled([connection.stop(), managed?.stop(), api?.closeAudit(), ready]);
      for (const result of results) if (result.status === 'rejected') logger?.error(`dsh-code-review: 节点停止失败：${String(result.reason)}`);
    },
    'dsh-code-review: http routes',
  );
}
