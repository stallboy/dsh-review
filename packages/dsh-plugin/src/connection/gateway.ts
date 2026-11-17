import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CENTRAL_PREFIX = '/dsh-code-review/central';

export async function requestBody(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += bytes.length;
        if (size > 2 * 1024 * 1024) throw new Error('请求内容超过限制');
        parts.push(bytes);
    }
    return Buffer.concat(parts);
}

export class CentralGateway {
    private target = '';
    private identity = '';
    private generation = 0;
    private readonly sessions = new Map<string, { cookie: string; usedAt: number }>();
    private login?: () => Promise<string>;

    connect(centerUrl: string, identity: string, login?: () => Promise<string>): void {
        if (this.target !== centerUrl || this.identity !== identity) { this.sessions.clear(); this.generation++; }
        this.target = centerUrl;
        this.identity = identity;
        this.login = login;
    }

    close(): void {
        this.generation++;
        this.target = '';
        this.sessions.clear();
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!this.target) { res.writeHead(503); res.end('中央尚未连接'); return; }
        const generation = this.generation;
        const checkCurrent = () => { if (generation !== this.generation) throw new Error('中央连接已更换，请刷新工作台'); };
        const input = new URL(req.url ?? '/', 'http://local');
        const raw = input.pathname.slice(CENTRAL_PREFIX.length) || '/';
        const decoded = decodeURIComponent(raw);
        if (!input.pathname.startsWith(`${CENTRAL_PREFIX}/`) || /[\\\x00]/.test(decoded)
            || decoded.split('/').some(part => part === '..' || part === '.') || decoded.includes('//')) {
            res.writeHead(403); res.end('无效的工作台路径'); return;
        }
        if (decoded.startsWith('/node-api') || (decoded.startsWith('/api/') && !decoded.startsWith('/api/v1/'))) {
            res.writeHead(403); res.end('该接口不允许通过工作台访问'); return;
        }
        const base = new URL(this.target);
        const upstream = new URL(`.${raw}${input.search}`, base);
        if (upstream.origin !== base.origin || !upstream.pathname.startsWith(base.pathname)) {
            res.writeHead(403); res.end('工作台目标越界'); return;
        }
        const now = Date.now();
        for (const [id, session] of this.sessions) if (now - session.usedAt > 12 * 60 * 60 * 1000) this.sessions.delete(id);
        let id = /(?:^|;\s*)dsh_review_gateway=([a-zA-Z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
        let session = id ? this.sessions.get(id) : undefined;
        if (!session) {
            if (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!);
            id = randomBytes(32).toString('base64url');
            session = { cookie: this.login ? await this.login() : '', usedAt: now };
            checkCurrent();
            this.sessions.set(id, session);
            res.setHeader('set-cookie', `dsh_review_gateway=${id}; HttpOnly; SameSite=Strict; Path=${CENTRAL_PREFIX}/${(req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : ''}`);
        }
        session.usedAt = now;
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'x-csrf-token', 'accept', 'range']) {
            if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        }
        if (session.cookie) headers.cookie = session.cookie;
        const data = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await requestBody(req);
        checkCurrent();
        let response = await fetch(upstream, { method: req.method, headers, ...(data ? { body: new Uint8Array(data) } : {}),
            redirect: 'manual', signal: AbortSignal.timeout(15000) });
        checkCurrent();
        if (response.status === 401 && this.login && req.method === 'GET' && decoded === '/api/v1/auth/session') {
            await response.body?.cancel();
            session.cookie = await this.login();
            checkCurrent();
            response = await fetch(upstream, { headers: { ...headers, cookie: session.cookie }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
            checkCurrent();
        }
        const cookies = response.headers.getSetCookie();
        for (const cookie of cookies) {
            const match = /^dsh_review_session=([^;]*)/.exec(cookie);
            if (match) {
                session.cookie = match[1] ? `dsh_review_session=${match[1]}` : '';
                if (!match[1] && this.login) this.sessions.delete(id!);
            }
        }
        res.statusCode = response.status;
        for (const name of ['content-type', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'content-range', 'accept-ranges']) {
            const value = response.headers.get(name);
            if (value) res.setHeader(name, value);
        }
        res.setHeader('cache-control', 'no-store');
        const location = response.headers.get('location');
        if (location) {
            const redirect = new URL(location, upstream);
            if (redirect.origin !== base.origin || !redirect.pathname.startsWith(base.pathname)) throw new Error('中央返回了非受信重定向');
            res.setHeader('location', `${CENTRAL_PREFIX}/${redirect.pathname.slice(base.pathname.length)}${redirect.search}`);
        }
        if (response.headers.get('content-type')?.includes('text/html')) {
            const html = (await response.text()).replace(/<base\s+href=["']\/["']\s*\/?\s*>/i, `<base href="${CENTRAL_PREFIX}/">`);
            checkCurrent();
            res.end(html);
        } else {
            const bytes = Buffer.from(await response.arrayBuffer());
            checkCurrent();
            res.end(bytes);
        }
    }
}
