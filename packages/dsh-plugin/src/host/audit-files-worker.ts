import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
    realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AuditFilesRequest, AuditFilesResult } from './audit-files.js';
import type { ExpectedCommitEntry } from './vcs.js';

const rootIdentity = statSync('.', { bigint: true });

function inspect(file: string) {
    try {
        return lstatSync(file, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function redirected(file: string): never {
    throw new Error(`评审产物禁止路径重定向：${file}`);
}

function parts(file: string): string[] {
    const components = file.split('/');
    if (components.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) redirected(file);
    return components;
}

function assertDirectory(expected: string): void {
    if (path.relative(expected, realpathSync('.')) !== '') redirected(expected);
}

function enter(root: string, components: string[], create = false, createOnly = false): string {
    // 子进程的实际工作目录让叶子操作使用已核验的目录，而不是重新解析祖先链。
    process.chdir(root);
    assertDirectory(root);
    const currentRoot = statSync('.', { bigint: true });
    if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) redirected(root);
    let directory = root;
    for (const [index, part] of components.entries()) {
        if (create) {
            try {
                mkdirSync(part);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (createOnly && index === components.length - 1) throw new Error(`审查目录已存在：${part}`);
            }
        }
        const expected = lstatSync(part, { bigint: true });
        if (!expected.isDirectory() || expected.isSymbolicLink()) redirected(part);
        process.chdir(part);
        directory = path.join(directory, part);
        assertDirectory(directory);
        const actual = statSync('.', { bigint: true });
        if (expected.dev !== actual.dev || expected.ino !== actual.ino) redirected(part);
    }
    return directory;
}

function readLeaf(file: string, directory: string): Buffer | null {
    const info = inspect(file);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) redirected(file);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1n) redirected(file);
        const bytes = readFileSync(fd);
        assertDirectory(directory);
        return bytes;
    } finally {
        closeSync(fd);
    }
}

function writeLeaf(file: string, directory: string, text: string): void {
    const info = inspect(file);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)) redirected(file);
    const temp = `.audit-${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx');
    try {
        let created;
        try {
            writeFileSync(fd, text);
            created = fstatSync(fd, { bigint: true });
        } finally {
            closeSync(fd);
        }
        assertDirectory(directory);
        renameSync(temp, file);
        const written = inspect(file);
        if (!written?.isFile() || written.dev !== created.dev || written.ino !== created.ino || written.nlink !== 1n) redirected(file);
        assertDirectory(directory);
    } catch (error) {
        if (inspect(temp)) unlinkSync(temp);
        throw error;
    }
}

function blobHash(bytes: Buffer): string {
    return createHash('sha1').update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

function snapshot(root: string, paths: string[]): Required<Pick<AuditFilesResult, 'entries' | 'missing'>> {
    const entries = new Map<string, ExpectedCommitEntry>();
    const missing: string[] = [];
    const visit = (file: string): void => {
        try {
            const components = parts(file);
            const leaf = components.pop()!;
            const directory = enter(root, components);
            const info = inspect(leaf);
            if (info?.isDirectory() && !info.isSymbolicLink()) {
                const folder = enter(root, [...components, leaf]);
                const names = readdirSync('.').sort();
                assertDirectory(folder);
                for (const name of names) visit(`${file}/${name}`);
                return;
            }
            const bytes = readLeaf(leaf, directory);
            if (bytes === null) {
                missing.push(file);
                return;
            }
            entries.set(file, { path: file, blobHash: blobHash(bytes), mode: (info!.mode & 0o111n) !== 0n ? '100755' : '100644' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            missing.push(file);
        }
    };
    for (const file of paths) visit(file);
    return { entries: [...entries.values()], missing };
}

function run(request: AuditFilesRequest & { root: string }): AuditFilesResult {
    const { root, paths } = request;
    if (request.op === 'snapshot') return snapshot(root, paths);
    if (request.op === 'remove') {
        const before = snapshot(root, paths);
        if (JSON.stringify(before.entries) !== JSON.stringify(request.entries)) throw new Error('本轮产物已变化');
        for (const entry of before.entries) {
            const components = parts(entry.path);
            const leaf = components.pop()!;
            const directory = enter(root, components);
            const isolated = `.audit-recovery-${randomUUID()}.tmp`;
            renameSync(leaf, isolated);
            try {
                const bytes = readLeaf(isolated, directory);
                if (!bytes || blobHash(bytes) !== entry.blobHash) throw new Error(`本轮产物已变化：${entry.path}`);
            } catch (error) {
                try {
                    linkSync(isolated, leaf);
                    unlinkSync(isolated);
                } catch {
                    throw new Error(`本轮产物无法安全复原，已保存在 ${path.join(directory, isolated)}`);
                }
                throw error;
            }
            unlinkSync(isolated);
            assertDirectory(directory);
        }
        return {};
    }
    const components = parts(paths[0]!);
    try {
        if (request.op === 'list') {
            const folder = enter(root, components);
            const names = readdirSync('.', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
            assertDirectory(folder);
            return { names };
        }
        const leaf = components.pop()!;
        const directory = enter(root, components, request.op === 'write', request.createOnly);
        if (request.op === 'read') return { bytes: readLeaf(leaf, directory) };
        writeLeaf(leaf, directory, request.text ?? '');
        return {};
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || request.op === 'write') throw error;
        return request.op === 'list' ? { names: [] } : { bytes: null };
    }
}

process.once('message', (request: AuditFilesRequest & { root: string }) => {
    try {
        process.send?.({ result: run(request) });
    } catch (error) {
        process.send?.({ error: error instanceof Error ? error.message : String(error) });
    } finally {
        process.disconnect?.();
    }
});
