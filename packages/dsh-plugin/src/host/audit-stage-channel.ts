import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readJson, sendJson } from './api-context.js';

export type AuditStageRequest = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

export async function openAuditStageChannel(dispatch: AuditStageRequest): Promise<{ instructions: string; redact(line: string): string; close(): void }> {
    const secret = randomBytes(32).toString('base64url');
    const abort = new AbortController();
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== 'Bearer ' + secret
            || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
            sendJson(res, 404, { error: '阶段入口不可用' });
            return;
        }
        const requestAbort = new AbortController();
        res.once('close', () => { if (!res.writableEnded) requestAbort.abort(); });
        const signal = AbortSignal.any([abort.signal, requestAbort.signal]);
        try {
            const input = await readJson(req);
            signal.throwIfAborted();
            const result = await dispatch(input, signal);
            if (!res.destroyed) sendJson(res, 200, { result });
        } catch (error) {
            if (!res.destroyed) sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('无法启动本轮审查的本机阶段入口');
    }
    return {
        instructions: [
            '## 本机 Host 阶段入口',
            '在执行器没有 DSH 工具时，通过下列 HTTP 调用完成同样的阶段。除调用此入口外，遵守总调度的工作区和工具限制。',
            '向 http://127.0.0.1:' + String(address.port) + '/ 发送 POST JSON，请求头为 Content-Type: application/json 和 Authorization: Bearer ' + secret + '。',
            '只向这个本机入口发送本轮凭据。避免在报告、摘要和计划中输出凭据。',
            '运行阶段发送 {"operation":"runAuditStage","stage":"scan","runner":"codex","task":{...}}，按工具说明填写 task 对象。',
            '查询历史发送 {"operation":"queryAuditHistory"}，可加 disposition。发布发送 {"operation":"publishAuditArtifacts","publication":{...}}。',
            '结果在响应的 result 中。发布成功后结束执行，由 Host 确认停止并收尾。',
        ].join('\n'),
        redact: line => line.replaceAll(secret, '[阶段凭据]'),
        close: () => {
            abort.abort();
            server.close();
            server.closeAllConnections();
        },
    };
}
