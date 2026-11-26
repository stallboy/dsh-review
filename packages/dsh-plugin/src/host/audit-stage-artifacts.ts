import { gitBlobHash, type VcsAdapter } from './vcs.js';
import { lstat, mkdir, readdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRepoRelativePath } from './invariants.js';
import { runProcess } from './shell.js';
import type { AuditType } from './types.js';
import { AuditStopUnknown } from './audit-stage-runner.js';

export interface StageCandidate {
    id: string;
    title: string;
    patch: string;
    review: string;
    expectedReview?: string;
    patches?: Record<string, string>;
    proposal?: { optionId?: string; auditType: AuditType; commands: string[]; confidence: number; tradeoff: string; humanDecisions: string[] };
}

export function validSourcePath(file: string): boolean {
    return isRepoRelativePath(file) && !/[\\:\r\n\0]/.test(file)
        && !file.split('/').some(part => /^\.(?:ai-review|git|svn|dsh|claude|codex|tmp)$/i.test(part));
}

export function withinScope(scope: string, file: string): boolean {
    return !scope || scope === '.' || scope === file || file.startsWith(scope + '/');
}

export async function compatibleAuditBase(vcs: VcsAdapter, base: string, svnUrl?: string): Promise<boolean> {
    if (svnUrl && await readSvnAuditUrl(vcs.root).catch(() => null) !== svnUrl) return false;
    const current = await vcs.getCurrentBase();
    return current === base || (current !== null && (await vcs.businessChangesBetween(base, current))?.length === 0);
}

async function auditVcs(command: 'git' | 'svn', root: string, args: string[], signal: AbortSignal, maximum: number): Promise<string> {
    const result = await runProcess(command, args, { cwd: root, signal, timeoutMs: 90_000, maxBytes: maximum });
    if (result.timedOut || result.aborted) throw new AuditStopUnknown(command + ' 阶段取消或超时');
    if (result.code !== 0 || Buffer.byteLength(result.stdout) >= maximum) throw new Error('阶段版本控制操作失败：' + command + ' ' + (command === 'svn' ? args[1] : args[4]));
    return result.stdout;
}

export async function auditGit(root: string, args: string[], signal: AbortSignal, maximum = 1024 * 1024): Promise<string> {
    return auditVcs('git', root, ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], signal, maximum);
}

export async function readSvnAuditUrl(root: string, signal = AbortSignal.timeout(30_000)): Promise<string> {
    const url = (await auditVcs('svn', root, ['--non-interactive', 'info', '--show-item', 'url', '--', '.'], signal, 16 * 1024)).trim();
    if (!url) throw new Error('无法确定 SVN 固定基线的目录');
    return url;
}

export function oneLine(text: string): string {
    return text.trim().replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').slice(0, 800);
}

export type StageSeal = Record<string, string>;

const hash = gitBlobHash;

async function artifactPath(root: string, relative: string, create: boolean, created: string[] = []): Promise<string> {
    const parts = relative.split('/');
    if (parts.shift() !== '.ai-review' || parts.some(part => !part || /[\\:\r\n\0]/.test(part) || ['.', '..'].includes(part))) {
        throw new Error('审查产物路径非法');
    }
    const file = parts.pop();
    let dir = await realpath(root);
    for (const part of ['.ai-review', ...parts]) {
        dir = path.join(dir, part);
        let info = await lstat(dir).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return null;
        });
        if (!info && create) {
            await mkdir(dir);
            created.push(dir);
            info = await lstat(dir);
        }
        if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('审查产物目录不可用');
    }
    return path.join(dir, file!);
}

export async function createArtifactDirectory(root: string, relative: string): Promise<string> {
    return path.dirname(await artifactPath(root, relative + '/.directory', true));
}

export async function publishStageArtifacts(
    root: string, reportPath: string, report: string, candidates: StageCandidate[],
    seal: (manifest: StageSeal) => Promise<void>,
): Promise<void> {
    const artifacts = new Map<string, string>([[reportPath, report]]);
    const replacements = new Map<string, string>();
    for (const item of candidates) {
        const dir = '.ai-review/' + item.id;
        artifacts.set(dir + '/review.md', item.review);
        if (item.expectedReview !== undefined) replacements.set(dir + '/review.md', item.expectedReview);
        if (item.patches) {
            for (const [name, text] of Object.entries(item.patches)) {
                if (!/^\d{3,}\.patch$/.test(name)) throw new Error('补丁文件编号无效');
                artifacts.set(dir + '/' + name, text);
            }
        } else artifacts.set(dir + '/001.patch', item.patch);
    }
    const files: string[] = [];
    const dirs: string[] = [];
    try {
        for (const [relative, content] of artifacts) {
            const file = await artifactPath(root, relative, true, dirs);
            const previous = replacements.get(relative);
            if (previous !== undefined) {
                if (await readFile(file, 'utf8') !== previous) throw new Error('问题记录已变化，不能覆盖发布');
                await writeFile(file, content, 'utf8');
            } else await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
            files.push(file);
        }
        const manifest = Object.fromEntries([...artifacts].map(([name, content]) => [name, hash(content)]));
        const collect = async (relative: string): Promise<void> => {
            const local = path.join(root, relative);
            for (const entry of await readdir(local, { withFileTypes: true })) {
                const name = relative + '/' + entry.name;
                if (entry.isSymbolicLink()) throw new Error('审查证据不允许链接');
                if (entry.isDirectory()) await collect(name);
                else if (entry.isFile()) manifest[name] = hash(await readFile(await artifactPath(root, name, false)));
                else throw new Error('审查证据不是普通文件');
            }
        };
        const evidence = path.posix.dirname(reportPath) + '/evidence';
        if (await lstat(path.join(root, evidence)).catch(() => null)) await collect(evidence);
        for (const item of candidates) {
            if (!item.expectedReview) continue;
            const before = (await import('./frontmatter.js')).parseReviewMarkdown(item.expectedReview).meta;
            for (const revision of before.revisions) {
                const name = '.ai-review/' + item.id + '/' + revision.patch;
                const actual = await readFile(await artifactPath(root, name, false));
                manifest[name] = hash(actual);
            }
        }
        await seal(manifest);
    } catch (error) {
        const cleanup = await Promise.allSettled(files.map(async file => {
            const relative = path.relative(root, file).split(path.sep).join('/');
            const previous = replacements.get(relative);
            if (previous !== undefined) {
                if (await readFile(file, 'utf8') !== artifacts.get(relative)) throw new Error('清理前问题记录再次变化');
                await writeFile(file, previous, 'utf8');
            } else await unlink(file);
        }));
        for (const dir of dirs.reverse()) await rmdir(dir).catch(() => undefined);
        if (cleanup.some(result => result.status === 'rejected')) throw new AuditStopUnknown('评审产物发布失败且无法确认清理');
        throw error;
    }
}

export async function assertStageArtifacts(root: string, manifest: StageSeal, candidates: string[]): Promise<void> {
    const declared = Object.keys(manifest).filter(file => /^\.ai-review\/\d{4}-\d{2}\/[^/]+\/review\.md$/.test(file)).map(file => file.slice(11, -10)).sort();
    if (declared.join('\0') !== candidates.sort().join('\0')) throw new Error('收尾候选与本轮发布的清单不符');
    const files = Object.keys(manifest);
    for (const [relative, expected] of Object.entries(manifest)) {
        const file = await artifactPath(root, relative, false);
        const parent = path.posix.dirname(relative);
        const expectedNames = files.filter(entry => path.posix.dirname(entry) === parent).map(entry => path.posix.basename(entry)).sort();
        const actualNames = (await readdir(path.dirname(file), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
        if (actualNames.join('\0') !== expectedNames.join('\0')) throw new Error('本轮产物目录包含清单外文件');
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(file)) !== expected) {
            throw new Error('已发布的审查产物发生变化：' + relative);
        }
    }
}
