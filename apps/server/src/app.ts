import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, ProtocolError, entityId, record, textValue, validateRegistration, type JsonRecord, type QueryKind } from '@dsh-review/protocol';
import { CentralDatabase, CentralError, type User } from './database.js';
import { Commands } from './commands.js';
import { Snapshots } from './snapshots.js';
import { AuditSchedules } from './audit-schedule.js';

interface RequestContext extends FastifyRequest {
    actor: User | null;
    nodeId: string | null;
    csrfToken: string | null;
}

export interface CentralOptions {
    dataDir: string;
    clock?: () => Date;
    secureCookies?: boolean;
    webDir?: string;
}

declare module 'fastify' {
    interface FastifyInstance { database: CentralDatabase; }
}

export type CentralApp = FastifyInstance;

const sessionToken = (req: FastifyRequest): string => /(?:^|;\s*)dsh_review_session=([a-zA-Z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
const params = (req: FastifyRequest): Record<string, string> => req.params as Record<string, string>;
const body = (req: FastifyRequest): JsonRecord => record(req.body, 'body');

export async function createCentralApp(options: CentralOptions): Promise<CentralApp> {
    const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
    const database = new CentralDatabase(options.dataDir, options.clock);
    const schedules = new AuditSchedules(database);
    const commands = new Commands(database, schedules), snapshots = new Snapshots(database, schedules);
    app.decorate('database', database);
    app.decorateRequest('actor', null);
    app.decorateRequest('nodeId', null);
    app.decorateRequest('csrfToken', null);
    app.addHook('onClose', async () => database.close());
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, bytes, done) => done(null, bytes));

    app.addHook('onRequest', async (raw, reply) => {
        const req = raw as RequestContext;
        reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'SAMEORIGIN').header('cache-control', 'no-store');
        const pathname = req.routeOptions.url ?? new URL(req.url, 'http://local').pathname;
        if (pathname.startsWith('/node-api/')) {
            const token = /^Bearer ([a-zA-Z0-9_-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
            req.nodeId = database.nodeIdentity(token);
        } else if (pathname.startsWith('/api/v1/') && !['/api/v1/auth/login', '/api/v1/info'].includes(pathname)) {
            const session = database.session(sessionToken(req));
            req.actor = session.user;
            req.csrfToken = session.csrfToken;
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrfToken) {
                throw new CentralError(403, 'csrf_mismatch', '请求校验失败，请刷新登录状态');
            }
        }
        if (req.nodeId || (req.actor && /^\/api\/v1\/(?:projects|tasks|commands|nodes|workbench)(?:\/|$)/.test(pathname))) schedules.expire();
    });

    app.setErrorHandler((error, _req, reply) => {
        if (error instanceof CentralError) return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof ProtocolError) return reply.status(422).send({ error: { code: 'bad_request', message: error.message } });
        const detail = error as Error & { statusCode?: number };
        if (/UNIQUE constraint failed/.test(detail.message)) return reply.status(409).send({ error: { code: 'conflict', message: '该工作副本或标识已被使用' } });
        if (detail.statusCode && detail.statusCode < 500) return reply.status(detail.statusCode).send({ error: { code: 'bad_request', message: '请求格式无效' } });
        return reply.status(500).send({ error: { code: 'internal', message: '中央服务内部错误' } });
    });

    app.get('/health', async () => ({ status: 'ok', service: 'dsh-review-central', protocolVersion: 1 }));
    app.get('/api/v1/info', async () => ({ centralId: database.centralId, protocolVersion: PROTOCOL_VERSION,
        registrationCapabilities: { executionConfigHash: true } }));
    app.post('/api/v1/auth/login', async (req, reply) => {
        const input = body(req);
        const result = database.login(textValue(input.username, 'username', 80), textValue(input.password, 'password', 256));
        reply.header('set-cookie', `dsh_review_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${options.secureCookies ? '; Secure' : ''}`);
        return { user: result.user, csrfToken: result.csrfToken };
    });
    app.get('/api/v1/auth/session', async req => {
        const context = req as RequestContext;
        return { user: context.actor, csrfToken: context.csrfToken };
    });
    app.post('/api/v1/auth/logout', async (req, reply) => {
        database.logout(sessionToken(req));
        reply.header('set-cookie', 'dsh_review_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return { ok: true };
    });

    app.get('/api/v1/nodes', async () => ({ nodes: database.listNodes() }));
    app.post('/api/v1/nodes', async (req, reply) => reply.status(201).send(database.createNode(textValue(body(req).name, 'name', 160))));
    app.post('/api/v1/nodes/:nodeId/revoke', async req => { database.revokeNode(params(req).nodeId!); return { ok: true }; });
    app.get('/api/v1/projects', async () => ({ projects: database.listProjects().map(p => ({ ...p, ...snapshots.view(p.projectId), snapshot: snapshots.get(p.projectId) })) }));
    app.post('/api/v1/projects', async (req, reply) => {
        const input = body(req);
        const project = database.bindProject({ name: textValue(input.name, 'name', 160), nodeId: textValue(input.nodeId, 'nodeId'), workspaceId: textValue(input.workspaceId, 'workspaceId') });
        return reply.status(201).send({ project });
    });
    app.put('/api/v1/projects/:projectId', async req => {
        const projectId = params(req).projectId!;
        const input = body(req);
        if (Object.keys(input).some(key => !['name', 'enabled'].includes(key))) throw new CentralError(422, 'bad_request', '首期只能修改项目名称或启停状态，不能在线迁移绑定');
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new CentralError(422, 'bad_request', '项目启停值无效');
        const updates = { ...(input.name !== undefined ? { name: textValue(input.name, 'name', 160) } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) };
        if (updates.enabled !== false) return { project: database.updateProject(projectId, updates) };
        return { project: database.transaction(() => {
            const previous = database.getProject(projectId);
            const project = database.updateProject(projectId, updates);
            if (previous.enabled) schedules.rememberMissedWindow(previous);
            return project;
        }) };
    });
    app.get('/api/v1/projects/:projectId', async req => {
        const projectId = params(req).projectId!;
        const view = snapshots.view(projectId);
        return { ...view, snapshot: snapshots.get(projectId), auditSchedule: schedules.view(view.project) };
    });
    app.put('/api/v1/projects/:projectId/audit-schedule', async req => ({
        auditSchedule: schedules.update(database.getProject(params(req).projectId!), body(req), (req as RequestContext).actor!),
    }));
    app.get('/api/v1/projects/:projectId/queue', async req => {
        const projectId = params(req).projectId!, snapshot = snapshots.get(projectId);
        return { ...snapshots.view(projectId), items: snapshot?.queue ?? [], errors: snapshot?.errors ?? [] };
    });
    for (const kind of ['findings', 'audits'] as const) {
        app.get(`/api/v1/projects/:projectId/${kind}`, async req => {
            const id = params(req).projectId!;
            return { ...snapshots.view(id), items: snapshots.get(id)?.[kind] ?? [] };
        });
    }
    app.get('/api/v1/workbench', async () => ({ projects: database.listProjects().map(p => ({ ...snapshots.view(p.projectId), snapshot: snapshots.get(p.projectId) })) }));
    app.get('/api/v1/tasks', async req => ({ tasks: commands.list((req.query as Record<string, string>).projectId) }));
    app.get('/api/v1/commands/:commandId', async req => ({ command: commands.get(params(req).commandId!) }));
    app.get('/api/v1/tasks/:commandId/logs', async req => commands.logs(params(req).commandId!, Number((req.query as Record<string, string>).since ?? 0)));
    app.post('/api/v1/projects/:projectId/commands', async (req, reply) => reply.status(202).send({ command: commands.create(params(req).projectId!, body(req), (req as RequestContext).actor!) }));
    app.post('/api/v1/commands/:commandId/cancel', async req => ({ command: commands.cancel(params(req).commandId!) }));
    app.post('/api/v1/commands/:commandId/recover', async req => ({ command: commands.requestRecovery(params(req).commandId!, body(req).confirmStopped) }));
    app.get('/api/v1/queries/:queryId', async req => snapshots.queryStatus(params(req).queryId!));
    for (const kind of ['candidate', 'patch', 'diff', 'audit', 'reviewers'] as QueryKind[]) {
        app.get(`/api/v1/projects/:projectId/${kind}`, async (req, reply) => {
            const result = snapshots.query(params(req).projectId!, kind, req.query as JsonRecord);
            return reply.status(result.status).send(result.body);
        });
    }

    app.post('/node-api/v1/register', async req => ({ node: database.registerNode((req as RequestContext).nodeId!, validateRegistration(req.body), req.headers['x-dsh-review-admission'] === 'paused') }));
    app.post('/node-api/v1/status', async req => {
        const id = (req as RequestContext).nodeId!;
        return { centralId: database.centralId, nodeId: id, instanceId: database.getNode(id).instanceId, online: database.getNode(id).online,
            activeInstance: database.hasActiveNodeInstance(id), projects: database.listProjects(id), pending: database.pendingNodeCommands(id) };
    });
    app.post('/node-api/v1/projects/ensure', async req => {
        const input = body(req);
        if (Object.keys(input).some(key => !['instanceId', 'workspaceId', 'name', 'enabled', 'restore'].includes(key)) || typeof input.enabled !== 'boolean'
            || (input.restore !== undefined && typeof input.restore !== 'boolean')) {
            throw new CentralError(422, 'bad_request', '项目接入参数无效');
        }
        const nodeId = (req as RequestContext).nodeId!;
        const workspaceId = entityId(input.workspaceId, 'workspaceId');
        const previous = input.enabled ? undefined : database.listProjects(nodeId).find(project => project.workspaceId === workspaceId);
        const project = database.ensureNodeProject(nodeId, {
            instanceId: entityId(input.instanceId, 'instanceId'), workspaceId,
            name: textValue(input.name, 'name', 160), enabled: input.enabled, restore: input.restore as boolean | undefined,
        });
        if (previous?.enabled && !project.enabled) schedules.rememberMissedWindow(previous);
        return { project };
    });
    app.post('/node-api/v1/quiesce', async req => {
        database.quiesceNode((req as RequestContext).nodeId!, entityId(body(req).instanceId, 'instanceId'));
        return { ok: true };
    });
    app.post('/node-api/v1/activate', async req => {
        database.activateNode((req as RequestContext).nodeId!, entityId(body(req).instanceId, 'instanceId'));
        return { ok: true };
    });
    app.post('/node-api/v1/disconnect', async req => {
        database.disconnectNode((req as RequestContext).nodeId!, entityId(body(req).instanceId, 'instanceId'));
        return { ok: true };
    });
    const identify = (req: FastifyRequest): string => {
        const id = (req as RequestContext).nodeId!;
        database.touchNode(id, textValue(body(req).instanceId, 'instanceId'));
        return id;
    };
    app.post('/node-api/v1/heartbeat', async req => {
        const id = identify(req);
        return { node: database.getNode(id), projects: database.listProjects(id) };
    });
    app.post('/node-api/v1/commands/poll', async req => {
        const id = identify(req);
        const capabilities = body(req).scheduledAuditWorkspaces ?? [];
        if (!Array.isArray(capabilities)) throw new CentralError(422, 'bad_request', '节点审查能力声明无效');
        const workspaces = new Set(capabilities.map(id => entityId(id, 'scheduledAuditWorkspaces')));
        return { ...commands.poll(id, workspaces), projects: database.listProjects(id), queries: snapshots.pending(id) };
    });
    app.post('/node-api/v1/commands/:commandId/ack', async req => ({ command: commands.acknowledge(identify(req), params(req).commandId!) }));
    app.post('/node-api/v1/events', async req => {
        const id = identify(req), input = body(req);
        if (!Array.isArray(input.events) || input.events.length > 100) throw new CentralError(422, 'bad_request', '事件批次无效');
        const acks: Record<string, number> = {};
        for (const event of input.events) { const result = commands.event(id, event); acks[result.commandId] = result.acknowledged; }
        return { acks };
    });
    app.post('/node-api/v1/snapshots', async req => ({ snapshot: snapshots.publish(identify(req), body(req).snapshot) }));
    app.post('/node-api/v1/queries/results', async req => {
        const id = identify(req), input = body(req);
        if (!Array.isArray(input.results) || input.results.length > 20) throw new CentralError(422, 'bad_request', '查询批次无效');
        for (const result of input.results) snapshots.complete(id, result);
        return { ok: true };
    });
    app.put('/node-api/v1/artifacts/:hash', { bodyLimit: 8 * 1024 * 1024 }, async req => {
        if (!Buffer.isBuffer(req.body)) throw new CentralError(422, 'bad_request', '附件需要二进制内容');
        const node = database.getNode((req as RequestContext).nodeId!);
        if (!node.compatible) throw new CentralError(409, 'protocol_mismatch', '节点尚未兼容注册');
        await snapshots.putArtifact(params(req).hash!, req.body);
        return { ok: true };
    });
    app.get('/api/v1/artifacts/:hash', async (req, reply) => reply.type('application/octet-stream').send(await snapshots.artifact(params(req).hash!)));

    const webDir = options.webDir ?? fileURLToPath(new URL('./public/', import.meta.url));
    app.get('/*', async (req, reply) => {
        const pathname = new URL(req.url, 'http://local').pathname;
        if (pathname.startsWith('/api/') || pathname.startsWith('/node-api/')) throw new CentralError(404, 'not_found', '接口不存在');
        const asset = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
        const requested = path.resolve(webDir, asset);
        if (!requested.startsWith(path.resolve(webDir) + path.sep) && requested !== path.resolve(webDir, 'index.html')) throw new CentralError(403, 'forbidden', '路径越界');
        let file: string;
        try { file = await realpath(requested); }
        catch {
            if (path.extname(asset)) throw new CentralError(404, 'not_found', '资源不存在');
            try { file = await realpath(path.join(webDir, 'index.html')); }
            catch { throw new CentralError(503, 'web_not_built', '前端尚未构建，请运行 npm run build'); }
        }
        const root = await realpath(webDir);
        if (!file.startsWith(root + path.sep)) throw new CentralError(403, 'forbidden', '路径越界');
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
        reply.type(mime[path.extname(file)] ?? 'application/octet-stream');
        reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'");
        return readFile(file);
    });
    await app.ready();
    return app;
}
