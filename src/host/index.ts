import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from './api.js';
import { loadSettings, saveSettings } from './settings.js';
import type { AppSettings } from './types.js';

/** Minimal shape of the host-side Cordis context this plugin uses. */
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
  effect(callback: () => void | (() => void), label?: string): void;
  inject(services: string[], callback: (ctx: HostContext) => void): void;
  get(name: string): unknown;
  logger?: HostLogger;
}

/** The live `ctx.sessionController` contract this plugin uses (generated `ctx.remote.session` host side). */
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
  logger?: HostLogger;
}

/** Hard dependency: without the web server this plugin cannot serve its panel API. */
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

/**
 * Give the audit conversation the same permission preset / approval policy as
 * the session that opened the review tab. Without this the new session starts
 * at the deployment default (`workspace-write` + `ask`), so an audit that runs
 * `gate_checks` through a piped subprocess stalls on an approval prompt nobody
 * is watching. Inheritance keeps the audit inside the trust level the user
 * already chose for this repository.
 */
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

/**
 * Create a real DSH conversation for the repository audit and submit the audit prompt.
 *
 * DSH exposes session creation only through the host `sessionController`
 * (`ctx.remote.session` on the client). The former `apiProxy.sessions` transport
 * does not exist in current DSH builds, so this helper drives the supported
 * create → rename → prompt sequence directly and attaches the session to the
 * workspace that owns `cwd`, which makes it show up in the sidebar.
 */
export async function createDshAuditSession(
  host: AuditSessionHost,
  input: { cwd: string; title: string; prompt: string; ownerSessionId?: string },
): Promise<{ sessionId: string }> {
  const controller = host.get('sessionController') as DshSessionController | undefined;
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new Error('当前 DSH Host 未挂载 sessionController，无法创建审查会话（请确认 DSH 版本包含 API Session 控制服务）');
  }
  const registry = host.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
  let workspace: WorkspaceLike | undefined;
  try {
    workspace = await registry?.resolveByPath?.(input.cwd);
  } catch (error) {
    host.logger?.warn(`dsh-code-review: 按路径解析工作区失败：${describeSessionError(error)}`);
  }
  if (!workspace) {
    workspace = registry?.list?.().find((item) => samePath(item.path, input.cwd));
  }
  let created: { sessionId?: unknown };
  try {
    created = workspace
      ? await controller.create({ workspaceId: workspace.id })
      : await controller.create({ cwd: input.cwd });
  } catch (error) {
    throw new Error(`创建 DSH 审查会话失败：${describeSessionError(error)}`);
  }
  const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
  if (!sessionId) throw new Error('创建 DSH 审查会话未返回 sessionId');
  if (controller.rename) {
    try {
      await controller.rename({ sessionId, title: input.title });
    } catch (error) {
      host.logger?.warn(`dsh-code-review: 审查会话改名失败：${describeSessionError(error)}`);
    }
  }
  const inherited = inheritOwnerPolicy(host, input.ownerSessionId ?? '', sessionId);
  try {
    const prompted = await controller.prompt(
      {
        requestId: `dsh-code-review-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: input.prompt }],
      },
      AbortSignal.timeout(60_000),
    );
    if (prompted?.accepted !== true) throw new Error('DSH 未接受审查提示词');
  } catch (error) {
    throw new Error(`发送审查任务失败：${describeSessionError(error)}`);
  }
  host.logger?.info(
    `dsh-code-review: 已创建审查会话 ${sessionId}（workspace=${workspace?.id ?? 'cwd'}，title=${input.title}，` +
      `preset=${inherited.preset ?? 'default'}，approval=${inherited.approval ?? 'default'}）`,
  );
  return { sessionId };
}

export function apply(ctx: HostContext): void {
  const logger = ctx.logger;
  let api: ReviewApi | undefined;
  let initError: Error | undefined;

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

  const ready = (async () => {
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
      createAuditSession: (input) => createDshAuditSession(ctx, input),
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
      if (!api) {
        writeJson(res, 500, errorBody(`评审初始化失败：${initError?.message ?? '未知错误'}`));
        return;
      }
      try {
        const handled = await api.handle(req, res);
        if (!handled) writeJson(res, 404, { error: { code: 'not_found', message: 'unknown endpoint' } });
      } catch (error) {
        if (!res.headersSent) {
          writeJson(res, 500, errorBody(error instanceof Error ? error.message : String(error)));
        } else {
          res.end();
        }
      }
    },
  });
  ctx.effect(
    () => () => {
      // 插件卸载/重载时停止定时审查调度，避免回调泄漏。
      api?.stopScheduler();
      off();
    },
    'dsh-code-review: http routes',
  );
}
