import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isRepoRelativePath } from './invariants.js';
import { parsePatch } from './patch.js';
import { runProcess } from './shell.js';
import type { ApprovalMergeFile } from './approval-merge-snapshots.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface Edit {
    start: number;
    removed: number;
    next: number;
    added: number;
}

export type ApprovalMergeResult =
    | { status: 'merged'; files: Map<string, Buffer> }
    | { status: 'conflict' | 'unsupported' | 'unavailable'; detail: string };

export function supportedApprovalMergePatch(text: string): boolean {
    const parsed = parsePatch(text);
    return !parsed.binary && parsed.paths.length > 0
        && !/^(?:new file mode |deleted file mode |old mode |new mode |rename (?:from|to) |copy (?:from|to) |Property changes on:|(?:---|\+\+\+) \/dev\/null)/m.test(text)
        && parsed.paths.every(file => isRepoRelativePath(file) && !/[:\\\r\n\t\0]/.test(file)
            && !file.split('/').some(part => /^(?:\.git|\.svn|\.gitattributes|\.ai-review)$/i.test(part)));
}

function lines(buffer: Buffer): string[] {
    return decoder.decode(buffer).match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, index) => line === b[index]);
}

function uniquelyAt(source: string[], sequence: string[], expected: number): boolean {
    if (!sequence.length || !sequence.every((line, offset) => source[expected + offset] === line)) return false;
    const anchor = sequence[0];
    for (let index = source.indexOf(anchor!); index !== -1; index = source.indexOf(anchor!, index + 1)) {
        if (index !== expected && sequence.every((line, offset) => source[index + offset] === line)) return false;
    }
    return true;
}

function preservesEdit(
    reviewed: Edit, delivered: Edit, drift: Edit[], before: string[], current: string[], proposed: string[], merged: string[],
): boolean {
    const end = reviewed.start + reviewed.removed;
    let left = 0;
    let right = before.length;
    let offset = 0;
    for (const change of drift) {
        const changeEnd = change.start + change.removed;
        if (changeEnd <= reviewed.start && !(reviewed.removed === 0 && changeEnd === reviewed.start)) {
            left = changeEnd;
            offset += change.added - change.removed;
        } else if (change.start >= end && !(reviewed.removed === 0 && change.start === end)) {
            right = change.start;
            break;
        } else {
            return false;
        }
    }
    if (delivered.start !== reviewed.start + offset || delivered.removed !== reviewed.removed || delivered.added !== reviewed.added
        || !sameLines(before.slice(reviewed.start, end), current.slice(delivered.start, delivered.start + delivered.removed))
        || !sameLines(proposed.slice(reviewed.next, reviewed.next + reviewed.added), merged.slice(delivered.next, delivered.next + delivered.added))) {
        return false;
    }
    const start = Math.max(left, reviewed.start - 3);
    const finish = Math.min(right, end + 3);
    const sequence = before.slice(start, finish);
    return uniquelyAt(before, sequence, start) && uniquelyAt(current, sequence, start + offset);
}

export async function mergeApprovedText(
    patch: string, files: ApprovalMergeFile[], signal?: AbortSignal,
): Promise<ApprovalMergeResult> {
    if (Buffer.byteLength(patch) >= MAX_OUTPUT || !supportedApprovalMergePatch(patch) || !files.length) {
        return { status: 'unsupported', detail: '补丁包含首期合并范围之外的文件或操作' };
    }
    const timeout = AbortSignal.timeout(30_000);
    const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const directory = await mkdtemp(path.join(tmpdir(), 'dcr-approval-merge-'));
    try {
        const repo = path.join(directory, 'repo');
        const template = path.join(directory, 'template');
        await mkdir(repo);
        await mkdir(template);
        const signature = parsePatch(patch).paths.sort();
        if (signature.length !== files.length || !files.every(file => signature.includes(file.path))) {
            return { status: 'conflict', detail: '已验证快照与补丁路径不一致' };
        }
        const git = (args: string[]) => runProcess('git', args, {
            cwd: repo, timeoutMs: 30_000, maxBytes: MAX_OUTPUT, inheritEnv: false,
            env: {
                PATH: process.env['PATH'] ?? '',
                ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
                GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-config'),
                GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
            },
            signal: operationSignal,
        });
        const usable = (result: Awaited<ReturnType<typeof git>>) => result.code !== null && !result.timedOut && !result.aborted
            && !result.error && !result.signal && Buffer.byteLength(result.stdout) < MAX_OUTPUT && Buffer.byteLength(result.stderr) < MAX_OUTPUT;
        const init = await git(['init', '-q', '--template=' + template]);
        if (!usable(init) || init.code !== 0) return { status: 'unavailable', detail: '无法初始化隔离 Git 合并环境' };
        for (const file of files) {
            const abs = path.join(repo, file.path);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, file.source, { flag: 'wx' });
        }
        const patchFile = path.join(directory, 'reviewed.patch');
        await writeFile(patchFile, patch, 'utf8');
        const strip = /^diff --git /m.test(patch) ? '-p1' : '-p0';
        const applied = await git(['apply', strip, '--', patchFile]);
        if (!usable(applied)) return { status: 'unavailable', detail: '候选源补丁重建命令未完成' };
        if (applied.code !== 0) return { status: 'conflict', detail: '原补丁无法在候选源快照重建：' + applied.stderr.trim() };
        const created = (await readdir(repo, { recursive: true, withFileTypes: true }))
            .filter(entry => !entry.isDirectory())
            .map(entry => path.relative(repo, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
            .filter(file => !file.startsWith('.git/'));
        if (created.length !== signature.length || created.some(file => !signature.includes(file))) {
            return { status: 'conflict', detail: '重建后的业务文件范围与原补丁不一致' };
        }
        const sourcePath = path.join(directory, 'source');
        const targetPath = path.join(directory, 'target');
        const proposedPath = path.join(directory, 'proposed');
        const mergedPath = path.join(directory, 'merged');
        const diff = async (left: string, right: string): Promise<Edit[]> => {
            const result = await git(['diff', '--no-index', '--no-color', '--text', '--no-ext-diff',
                '--no-indent-heuristic', '--diff-algorithm=myers', '--unified=0', '--', left, right]);
            if (!usable(result) || (result.code !== 0 && result.code !== 1)) throw new Error('无法完整取得合并差异');
            const edits = [...result.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => {
                const removed = Number(match[2] ?? 1);
                const added = Number(match[4] ?? 1);
                return { start: Number(match[1]) - (removed ? 1 : 0), removed, next: Number(match[3]) - (added ? 1 : 0), added };
            });
            if (result.code === 1 && !edits.length) throw new Error('合并差异缺少可验证的修改位置');
            return edits;
        };
        const output = new Map<string, Buffer>();
        for (const file of files) {
            const proposed = await readFile(path.join(repo, file.path));
            await Promise.all([
                writeFile(sourcePath, file.source), writeFile(targetPath, file.target),
                writeFile(proposedPath, proposed), writeFile(mergedPath, file.target),
            ]);
            const result = await git(['merge-file', '--', mergedPath, sourcePath, proposedPath]);
            if (!usable(result) || result.code! > 127) return { status: 'unavailable', detail: '隔离 Git 合并没有得到完整结果' };
            if (result.code !== 0) return { status: 'conflict', detail: '候选与当前目标存在文本冲突：' + file.path };
            const merged = await readFile(mergedPath);
            const [reviewed, delivered, drift] = await Promise.all([
                diff(sourcePath, proposedPath), diff(targetPath, mergedPath), diff(sourcePath, targetPath),
            ]);
            const [beforeLines, targetLines, proposedLines, mergedLines] = [file.source, file.target, proposed, merged].map(lines);
            if (!reviewed.length || reviewed.length !== delivered.length || !reviewed.every((edit, index) =>
                preservesEdit(edit, delivered[index]!, drift, beforeLines!, targetLines!, proposedLines!, mergedLines!))) {
                return { status: 'conflict', detail: '实际修改与已审修改无法唯一对应：' + file.path };
            }
            output.set(file.path, merged);
        }
        return { status: 'merged', files: output };
    } catch (error) {
        return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
}
