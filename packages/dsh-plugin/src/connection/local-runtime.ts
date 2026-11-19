import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION } from '@dsh-review/protocol';
import { extract } from 'tar';
import { readJson, saveJson } from './config.js';

interface RuntimeDownload {
    version: string;
    size: number;
    sha256: string;
    url: string;
}

interface RuntimeSource extends RuntimeDownload {
    versionUrl: string;
}

interface CachedRuntime {
    version: string;
    folder: string;
    contentsSha256: string;
    protocolVersion: number;
}

const officialVersion = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const sha256Hex = /^[a-f\d]{64}$/;
const entryPath = 'dist/owned.js';
const removeTree = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

function sourceUrl(value: unknown): URL {
    if (typeof value !== 'string') throw new Error('中央运行包来源必须是 URL');
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('中央运行包来源不受支持');
    return url;
}

async function loadSource(file: URL): Promise<RuntimeSource | null> {
    try {
        const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        const { version, size, sha256 } = value;
        if (typeof version !== 'string' || !officialVersion.test(version)
            || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024
            || typeof sha256 !== 'string' || !sha256Hex.test(sha256)) return null;
        return { version, size, sha256, url: sourceUrl(value.url).href, versionUrl: sourceUrl(value.versionUrl).href };
    } catch {
        return null;
    }
}

async function fetchBytes(url: URL, limit: number, signal: AbortSignal): Promise<Buffer> {
    for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await fetch(url, { signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location) throw new Error('中央运行包来源返回了无效的重定向');
            const next = sourceUrl(new URL(location, url).href);
            if (next.protocol !== url.protocol || (url.protocol === 'http:' && next.origin !== url.origin)) {
                throw new Error('中央运行包来源重定向到了不受支持的地址');
            }
            url = next;
            continue;
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`中央运行包来源返回 HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return Buffer.concat(chunks, length);
                length += value.byteLength;
                if (length > limit) throw new Error('中央运行包响应超过声明的大小');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    throw new Error('中央运行包来源重定向次数过多');
}

async function runtimeVersion(entry: URL): Promise<string | undefined> {
    try {
        const manifest = JSON.parse(await readFile(new URL('../package.json', entry), 'utf8'));
        if (manifest.name === '@dsh-review/server' && typeof manifest.version === 'string'
            && officialVersion.test(manifest.version)) return manifest.version;
    } catch {}
}

async function validatedEntry(directory: string, version: string): Promise<URL | undefined> {
    const entry = pathToFileURL(path.join(directory, entryPath));
    try {
        if ((await stat(entry)).isFile() && (await stat(new URL('./public/index.html', entry))).isFile()
            && await runtimeVersion(entry) === version) return entry;
    } catch {}
}

async function contentsSha256(root: string): Promise<string> {
    if (!(await lstat(root)).isDirectory()) throw new Error('中央运行包缓存目录无效');
    const digest = createHash('sha256');
    async function visit(directory: string, prefix: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            const relative = prefix + entry.name;
            if (entry.isDirectory()) await visit(file, relative + '/');
            else if (entry.isFile()) digest.update(JSON.stringify([relative, createHash('sha256').update(await readFile(file)).digest('hex')]));
            else throw new Error('中央运行包缓存含有不支持的文件类型');
        }
    }
    await visit(root, '');
    return digest.digest('hex');
}

export class LocalCentralRuntime {
    private readonly source: Promise<RuntimeSource | null>;
    private readonly directory: string;
    private readonly installedFile: string;
    private readonly abort = new AbortController();
    private invalidated = '';
    private replaced?: string;

    constructor(directory: string) {
        this.directory = path.join(directory, 'central-runtimes');
        this.installedFile = path.join(this.directory, 'installed.json');
        this.source = loadSource(new URL('../../assets/central-runtime-source.json', import.meta.url));
    }

    private async installed(): Promise<CachedRuntime | undefined> {
        const record = await readJson<CachedRuntime>(this.installedFile).catch(() => null);
        if (!record || typeof record.folder !== 'string' || !/^cache-[A-Za-z\d_-]{6,}$/.test(record.folder)
            || typeof record.contentsSha256 !== 'string' || !sha256Hex.test(record.contentsSha256)
            || typeof record.version !== 'string' || !officialVersion.test(record.version)) return;
        return record;
    }

    async cached(verify: boolean): Promise<URL | undefined> {
        const record = await this.installed();
        if (!record || record.protocolVersion !== PROTOCOL_VERSION || record.folder === this.invalidated) return;
        const directory = path.join(this.directory, record.folder, 'package');
        const entry = await validatedEntry(directory, record.version);
        if (!entry || !verify) return entry;
        if (await contentsSha256(directory).catch(() => '') === record.contentsSha256) return entry;
        this.invalidated = record.folder;
    }

    async offer(): Promise<RuntimeDownload | undefined> {
        const source = await this.source;
        if (source) return { version: source.version, size: source.size, sha256: source.sha256, url: source.url };
    }

    async download(confirmation: unknown): Promise<URL> {
        const source = await this.source;
        if (!source) throw new Error('当前插件未包含中央运行包，请安装本机整合插件包，或连接已有中央');
        if (confirmation !== source.sha256) throw new Error('请确认下载当前提供的中央运行包后再启动');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const previous = await this.installed();
        const staging = await mkdtemp(path.join(this.directory, 'cache-'));
        let published = false;
        try {
            const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]);
            const data = await fetchBytes(new URL(source.url), source.size, signal);
            if (data.length !== source.size || createHash('sha256').update(data).digest('hex') !== source.sha256) {
                throw new Error('中央运行包大小或 SHA-256 校验失败');
            }
            const archive = path.join(staging, 'central.tgz');
            const unpacked = path.join(staging, 'package');
            await writeFile(archive, data, { flag: 'wx' });
            await mkdir(unpacked);
            let unsupportedEntry = false;
            await extract({
                file: archive,
                cwd: unpacked,
                strip: 1,
                strict: true,
                filter(name, entry) {
                    const safe = name.startsWith('package/') && !name.includes('\\')
                        && !name.split('/').some(part => part === '..' || part.includes(':'))
                        && 'type' in entry && (entry.type === 'File' || entry.type === 'Directory');
                    if (!safe) unsupportedEntry = true;
                    return safe;
                },
            });
            const entry = await validatedEntry(unpacked, source.version);
            if (unsupportedEntry || !entry) throw new Error('中央运行包结构不完整或类型不受支持');
            const contents = await contentsSha256(unpacked);
            await rm(archive, { force: true }).catch(() => {});
            this.abort.signal.throwIfAborted();
            // 原子替换安装记录，避免移动可能被 Windows 扫描程序暂时锁定的解包目录。
            await saveJson(this.installedFile, { version: source.version, folder: path.basename(staging), contentsSha256: contents, protocolVersion: PROTOCOL_VERSION });
            published = true;
            this.replaced = previous?.folder;
            return entry;
        } catch (error) {
            throw new Error(`无法获取中央运行包：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (!published) await rm(staging, removeTree).catch(() => {});
        }
    }

    async discardReplaced(): Promise<void> {
        if (this.replaced) {
            await rm(path.join(this.directory, this.replaced), removeTree).catch(() => {});
            this.replaced = undefined;
        }
    }

    async newerVersion(entry: URL): Promise<{ currentVersion: string; latestVersion: string } | undefined> {
        try {
            const source = await this.source;
            if (!source) return;
            const currentVersion = await runtimeVersion(entry);
            if (!currentVersion) return;
            const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]);
            const { version: latestVersion } = JSON.parse((await fetchBytes(new URL(source.versionUrl), 4096, signal)).toString('utf8'));
            if (typeof latestVersion !== 'string' || !officialVersion.test(latestVersion)) return;
            const current = currentVersion.split('.').map(Number);
            const latest = latestVersion.split('.').map(Number);
            const different = latest.findIndex((part, index) => part !== current[index]);
            if (different >= 0 && latest[different]! > current[different]!) return { currentVersion, latestVersion };
        } catch {}
    }

    stop(): void {
        this.abort.abort();
    }
}
