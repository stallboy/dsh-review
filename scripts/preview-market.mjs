import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const CENTRAL_ARCHIVE_PATH = '/central-runtime.tgz';
export const CENTRAL_VERSION_PATH = '/central-version.json';

export async function servePreviewMarket(manifest, archive, central) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const origin = `http://127.0.0.1:${server.address().port}`;
    if (typeof archive === 'function') {
        try { archive = await archive(origin); }
        catch (error) { server.close(); throw error; }
    }
    const { name, version, description } = manifest;
    const tarballPath = `/${name}/-/${name}-${version}.tgz`;
    const startedAt = new Date();
    const index = {
        format: 1,
        title: '代码评审开发预览',
        plugins: [{
            name,
            title: '代码评审',
            description,
            versions: [{
                version,
                publishTimestamp: Math.floor(startedAt.getTime() / 1000),
                source: { type: 'npm', registry: origin },
            }],
        }],
    };
    const dist = {
        tarball: `${origin}${tarballPath}`,
        shasum: createHash('sha1').update(archive).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    };
    const metadata = {
        name,
        'dist-tags': { latest: version },
        versions: { [version]: { ...manifest, dist } },
        time: { [version]: startedAt.toISOString() },
    };
    const routes = new Map([
        ['/index.json', ['application/json', Buffer.from(JSON.stringify(index))]],
        [`/${name}`, ['application/json', Buffer.from(JSON.stringify(metadata))]],
        [tarballPath, ['application/octet-stream', archive]],
    ]);
    if (central) {
        routes.set(CENTRAL_ARCHIVE_PATH, ['application/octet-stream', central.archive]);
        routes.set(CENTRAL_VERSION_PATH, ['application/json', Buffer.from(JSON.stringify({ version: central.version }))]);
    }
    server.on('request', (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        const route = routes.get(request.url);
        if (!route) {
            response.writeHead(404).end();
            return;
        }
        const [contentType, body] = route;
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    return { server, origin };
}
