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

interface RpcResultLike {
  ok: boolean;
  value?: unknown;
  error?: { message?: string };
}

interface ApiProxyLike {
  sessions: {
    create(request: { rpcId: string; payload: { workspaceId?: string; cwd?: string } }): Promise<RpcResultLike>;
    rename?(request: { rpcId: string; payload: { sessionId: string; title: string } }): Promise<RpcResultLike>;
    prompt(request: {
      rpcId: string;
      payload: { sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> };
    }): Promise<RpcResultLike>;
  };
}

interface WorkspaceRegistryLike {
  list(): Array<{ id: string; path: string }>;
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
      createAuditSession: async ({ cwd, title, prompt }) => {
        const apiProxy = ctx.get('apiProxy') as ApiProxyLike | undefined;
        if (!apiProxy?.sessions) {
          throw new Error('DSH apiProxy 服务不可用，无法创建审查会话');
        }
        const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
        const normalized = path.resolve(cwd).replaceAll('\\', '/').toLowerCase();
        const workspace = registry?.list?.().find((item) =>
          path.resolve(item.path).replaceAll('\\', '/').toLowerCase() === normalized,
        );
        const rpcId = `dsh-code-review-${randomUUID()}`;
        const created = await apiProxy.sessions.create({
          rpcId,
          payload: {
            ...(workspace ? { workspaceId: workspace.id } : {}),
            cwd,
          },
        });
        if (!created.ok) throw new Error(created.error?.message ?? '创建 DSH 会话失败');
        const value = created.value as { sessionId?: unknown } | null | undefined;
        const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : '';
        if (!sessionId) throw new Error('创建 DSH 会话未返回 sessionId');
        try {
          await apiProxy.sessions.rename?.({ rpcId, payload: { sessionId, title } });
        } catch (error) {
          logger?.warn(`dsh-code-review: 审查会话改名失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const prompted = await apiProxy.sessions.prompt({
          rpcId,
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] },
        });
        if (!prompted.ok) throw new Error(prompted.error?.message ?? '发送审查任务失败');
        logger?.info(`dsh-code-review: 已创建审查会话 ${sessionId}`);
        return { sessionId };
      },
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
      off();
    },
    'dsh-code-review: http routes',
  );
}
