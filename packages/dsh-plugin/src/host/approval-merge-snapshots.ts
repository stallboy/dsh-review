import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isRepoRelativePath } from './invariants.js';
import type { RevisionEntry } from '@dsh-review/protocol';
import type { VcsAdapter } from './vcs.js';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const SVN_APPROVAL_SOURCE = 'svn_approval_source';

export interface SvnApprovalBinding {
    uuid: string;
    relativeUrl: string;
}

export interface ApprovalMergeFile {
    path: string;
    source: Buffer;
    target: Buffer;
    targetIdentity: string;
}

export type ApprovalMergeSnapshots =
    | { status: 'ready'; files: ApprovalMergeFile[] }
    | { status: 'unsupported' | 'unavailable' | 'mismatch'; detail: string };

function command(exe: string, args: string[], cwd: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile(exe, args, {
            cwd, windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_INPUT_BYTES,
            encoding: 'buffer', ...(signal ? { signal } : {}),
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}

async function svn(root: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    return command('svn', ['--non-interactive', ...args], root, signal);
}

function svnInfo(xml: string): (SvnApprovalBinding & { revision: string; kind: string }) | null {
    const entry = /<entry\b([^>]*)>/.exec(xml)?.[1] ?? '';
    const uuid = /<uuid>([0-9a-f-]+)<\/uuid>/i.exec(xml)?.[1];
    const relative = /<relative-url>([^<]+)<\/relative-url>/.exec(xml)?.[1];
    const revision = /\brevision="(\d+)"/.exec(entry)?.[1];
    const kind = /\bkind="([^"]+)"/.exec(entry)?.[1];
    if (!uuid || !relative || !revision || !kind) return null;
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return { uuid, relativeUrl: relative.replace(/&(amp|lt|gt|quot|apos);/g, (entity, key: string) => entities[key] ?? entity), revision, kind };
}

export function svnApprovalBinding(value: unknown): SvnApprovalBinding | null {
    if (!value || typeof value !== 'object') return null;
    const { uuid, relative_url: relativeUrl } = value as { uuid?: unknown; relative_url?: unknown };
    return typeof uuid === 'string' && /^[0-9a-f-]+$/i.test(uuid)
        && typeof relativeUrl === 'string' && relativeUrl.startsWith('^/')
        ? { uuid, relativeUrl } : null;
}

export function svnApprovalSourceMetadata(binding: SvnApprovalBinding): { uuid: string; relative_url: string } {
    return { uuid: binding.uuid, relative_url: binding.relativeUrl };
}

export async function readSvnApprovalBinding(root: string, signal?: AbortSignal): Promise<SvnApprovalBinding | null> {
    const info = svnInfo((await svn(root, ['info', '--xml', '--', '.'], signal)).toString('utf8'));
    return info && { uuid: info.uuid, relativeUrl: info.relativeUrl };
}

export async function stampSvnApprovalSource(vcs: VcsAdapter, revision: RevisionEntry, files: string[]): Promise<boolean> {
    if (vcs.type !== 'svn') return false;
    const previous = revision.extra?.[SVN_APPROVAL_SOURCE];
    let binding = await vcs.getCurrentBase().catch(() => null) === revision.baseRevision
        ? await readSvnApprovalBinding(vcs.root).catch(() => null) : null;
    if (binding) {
        const snapshot = await readApprovalMergeSnapshots(vcs, {
            sourceRevision: revision.baseRevision, targetRevision: revision.baseRevision, files, svnBinding: binding,
        });
        if (snapshot.status !== 'ready' || snapshot.files.some(file => !file.source.equals(file.target))) binding = null;
    }
    if (binding) {
        const metadata = svnApprovalSourceMetadata(binding);
        revision.extra = { ...revision.extra, [SVN_APPROVAL_SOURCE]: metadata };
        return JSON.stringify(previous) !== JSON.stringify(metadata);
    }
    if (!revision.extra || !Object.hasOwn(revision.extra, SVN_APPROVAL_SOURCE)) return false;
    delete revision.extra[SVN_APPROVAL_SOURCE];
    return true;
}

function regularText(content: Buffer): boolean {
    if (content.includes(0)) return false;
    try {
        utf8.decode(content);
        return true;
    } catch {
        return false;
    }
}

function identity(parts: (Buffer | string)[]): string {
    const hash = createHash('sha256');
    for (const part of parts) hash.update(String(Buffer.byteLength(part))).update(':').update(part);
    return hash.digest('hex');
}

async function gitFile(root: string, revision: string, file: string, signal?: AbortSignal) {
    if (!/^[0-9a-f]{4,64}$/i.test(revision)) throw new Error('Git 基线标识无效');
    const entry = (await command('git', ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', file], root, signal)).toString('utf8');
    const match = /^(100(?:644|755)) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== file) return null;
    const content = await command('git', ['cat-file', 'blob', match[2]!], root, signal);
    return { content, mode: match[1]!, object: match[2]! };
}

export async function readApprovalMergeSnapshots(
    vcs: VcsAdapter,
    input: { sourceRevision: string; targetRevision: string; files: string[]; svnBinding: SvnApprovalBinding | null; verifyWorktree?: boolean; signal?: AbortSignal },
): Promise<ApprovalMergeSnapshots> {
    const { root, type } = vcs;
    const { sourceRevision, targetRevision } = input;
    if (!input.files.length || input.files.length > 32) {
        return { status: 'unsupported', detail: '候选路径数量超出首期合并范围' };
    }
    const timeout = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
        const resolvedRoot = await realpath(root);
        const binding = type === 'svn' ? await readSvnApprovalBinding(root, signal) : null;
        if (type === 'svn' && (!input.svnBinding || !binding || !/^\d+$/.test(sourceRevision))) {
            return { status: 'unavailable', detail: '缺少可核验的 SVN 候选来源' };
        }
        if (binding && (binding.uuid !== input.svnBinding?.uuid || binding.relativeUrl !== input.svnBinding.relativeUrl)) {
            return { status: 'mismatch', detail: '候选来源与 SVN 仓库或工作副本目标不一致' };
        }
        const files: ApprovalMergeFile[] = [];
        let bytes = 0;
        for (const file of input.files) {
            if (!isRepoRelativePath(file) || /[:\\\r\n\t\0]/.test(file)) {
                return { status: 'unsupported', detail: '候选包含无法隔离处理的路径' };
            }
            const absolute = path.join(root, file);
            const st = await lstat(absolute);
            const actualPath = path.relative(resolvedRoot, await realpath(absolute)).split(path.sep).join('/');
            if (actualPath !== file || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_INPUT_BYTES) {
                return { status: 'unsupported', detail: '目标路径不是可核验的普通文件' };
            }
            const worktree = await readFile(absolute);
            let source: Buffer;
            let target: Buffer;
            let targetIdentity: string;
            if (type === 'git') {
                const [before, current] = await Promise.all([
                    gitFile(root, sourceRevision, file, signal), gitFile(root, targetRevision, file, signal),
                ]);
                if (!before || !current || before.mode !== current.mode) {
                    return { status: 'unsupported', detail: 'Git 文件类型或模式发生变化' };
                }
                source = before.content;
                target = current.content;
                targetIdentity = identity([targetRevision, current.mode, current.object]);
            } else {
                const beforeTarget = file + '@' + sourceRevision;
                const workingTarget = file + '@';
                const current = svnInfo((await svn(root, ['info', '--xml', '--', workingTarget], signal)).toString('utf8'));
                const expectedPath = decodeURI(binding!.relativeUrl).replace(/\/$/, '') + '/' + file;
                if (!current || current.kind !== 'file' || current.uuid !== binding!.uuid
                    || decodeURI(current.relativeUrl) !== expectedPath) {
                    return { status: 'mismatch', detail: 'SVN 目标文件位于不同的仓库路径' };
                }
                const sourceInfo = svnInfo((await svn(root, ['info', '--xml', '-r', sourceRevision, '--', beforeTarget], signal)).toString('utf8'));
                if (!sourceInfo || sourceInfo.kind !== 'file' || sourceInfo.uuid !== current.uuid
                    || sourceInfo.relativeUrl !== current.relativeUrl) {
                    return { status: 'mismatch', detail: 'SVN 历史文件与目标路径不一致' };
                }
                const [sourceProps, targetProps, worktreeProps, from, to] = await Promise.all([
                    svn(root, ['proplist', '--xml', '-r', sourceRevision, '--', beforeTarget], signal),
                    svn(root, ['proplist', '--xml', '-r', 'BASE', '--', workingTarget], signal),
                    svn(root, ['proplist', '--xml', '--', workingTarget], signal),
                    svn(root, ['cat', '--ignore-keywords', '-r', sourceRevision, '--', beforeTarget], signal),
                    svn(root, ['cat', '--ignore-keywords', '-r', 'BASE', '--', workingTarget], signal),
                ]);
                if (/<property\b/.test(sourceProps.toString('utf8') + targetProps.toString('utf8') + worktreeProps.toString('utf8'))) {
                    return { status: 'unsupported', detail: 'SVN 文件带原生属性，继续使用严格应用' };
                }
                source = from;
                target = to;
                targetIdentity = identity([current.uuid, current.relativeUrl, current.revision, target]);
            }
            bytes += source.length + target.length;
            if (bytes > MAX_INPUT_BYTES || (input.verifyWorktree !== false && !target.equals(worktree)) || !regularText(source) || !regularText(target)) {
                return { status: 'unsupported', detail: '文件字节无法在首期范围内验证' };
            }
            files.push({ path: file, source, target, targetIdentity });
        }
        return { status: 'ready', files };
    } catch (error) {
        return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
}


export async function replaceApprovalMergeFile(root: string, file: string, from: Buffer, to: Buffer): Promise<void> {
    const absolute = path.join(root, file);
    const actual = path.relative(await realpath(root), await realpath(absolute)).split(path.sep).join('/');
    if (actual !== file) throw new Error('工作副本路径已变化：' + file);
    const handle = await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== from.length || !(await handle.readFile()).equals(from)) {
            throw new Error('工作副本文件已变化：' + file);
        }
        const { bytesWritten } = await handle.write(to, 0, to.length, 0);
        if (bytesWritten !== to.length) throw new Error('无法完整写入文件：' + file);
        await handle.truncate(to.length);
    } finally {
        await handle.close();
    }
    if (!(await readFile(absolute)).equals(to)) throw new Error('写入内容未通过复核：' + file);
}
