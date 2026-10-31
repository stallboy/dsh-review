import type { IncomingMessage, ServerResponse } from 'node:http';
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
