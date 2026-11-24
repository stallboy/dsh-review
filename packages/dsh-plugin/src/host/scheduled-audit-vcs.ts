import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from './api-context.js';
import { runProcess } from './shell.js';
import { ApiError } from './types.js';
import type { ApplyPatchResult, VcsType } from './types.js';
import type { VcsAdapter } from './vcs.js';

export async function matchesAuditTarget(runtime: Runtime, target: string): Promise<boolean> {
    const result = await runProcess(runtime.vcsType, runtime.vcsType === 'git' ? ['branch', '--show-current'] :
        ['--non-interactive', 'info', '--show-item', 'relative-url', '.'], { cwd: runtime.root, timeoutMs: 30000 });
    return result.code === 0 && result.stdout.trim() === target;
}

function uncertain(message: string): ApiError {
    return new ApiError(409, 'conflict', message, { status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', detail: message });
}

export async function assertScheduledCheckout(runtime: Runtime): Promise<void> {
    const options = { cwd: runtime.root, timeoutMs: 30000 };
    if (runtime.vcsType === 'git') {
        const sparse = await runProcess('git', ['config', '--bool', '--get', 'core.sparseCheckout'], options);
        if (sparse.code === 1 || (sparse.code === 0 && sparse.stdout.trim() === 'false')) {
            const maxBytes = 16 * 1024 * 1024;
            const index = await runProcess('git', ['ls-files', '-t', '-z'], { ...options, maxBytes });
            if (index.code === 0 && Buffer.byteLength(index.stdout) < maxBytes && !/(?:^|\0)S /.test(index.stdout)) return;
        }
    } else {
        const version = await runProcess('svnversion', ['-n', '.'], options);
        if (version.code === 0 && /^\d+(?::\d+)?$/.test(version.stdout.trim())) return;
    }
    throw new ApiError(409, 'conflict', '无法确认工作副本为完整检出，已跳过定时全仓审查', { reason: 'SCHEDULE_WORKSPACE_INCOMPLETE' });
}

export async function syncScheduledAudit(runtime: Runtime, target: string, before: string, signal: AbortSignal): Promise<string> {
    const { vcs } = runtime;
    const assertNotCancelled = () => {
        if (signal.aborted) throw new ApiError(409, 'conflict', '定时审查在同步期间已取消', { reason: 'CANCELLED' });
    };
    if (!await matchesAuditTarget(runtime, target)) throw new ApiError(409, 'conflict', '工作副本目标已变化，已跳过定时审查');
    assertNotCancelled();
    let expected: string | null;
    let syncError: string | undefined;
    if (runtime.vcsType === 'git') {
        const git = (args: string[]) => runProcess('git', args, { cwd: runtime.root, timeoutMs: 180000, signal });
        const fetched = await git(['fetch', '--no-tags', 'origin', `refs/heads/${target}`]);
        assertNotCancelled();
        if (fetched.code !== 0) throw new ApiError(409, 'conflict', '无法获取绑定分支的最新版本，已跳过定时审查');
        const remote = await git(['rev-parse', 'FETCH_HEAD']);
        assertNotCancelled();
        if (remote.code !== 0) throw new ApiError(409, 'conflict', '无法读取绑定分支的远端版本，已跳过定时审查');
        expected = remote.stdout.trim();
        const ancestor = await git(['merge-base', '--is-ancestor', before, expected]);
        assertNotCancelled();
        if (ancestor.code !== 0) throw new ApiError(409, 'conflict', '本地分支无法快进到绑定分支，已跳过定时审查');
        if (expected !== before) {
            const merged = await git(['merge', '--ff-only', '--', expected]);
            if (merged.code !== 0) syncError = '快进绑定分支失败';
        }
    } else {
        const updated = await vcs.syncAndGetLatestBase();
        if (updated.uncertain || updated.failed) throw uncertain(updated.message);
        expected = updated.base;
    }
    const after = await vcs.getCurrentBase().catch(() => null);
    const clean = await vcs.ensureCleanWorkspace().catch(() => null);
    if (!after || !clean?.clean || !await matchesAuditTarget(runtime, target)) throw uncertain('同步后无法确认绑定工作副本安全，需要核验现场');
    if (syncError && after !== expected) {
        if (after !== before) throw uncertain(syncError);
        assertNotCancelled();
        throw new ApiError(409, 'conflict', syncError);
    }
    if (syncError || expected !== after) throw uncertain(syncError ?? '同步后实际版本与绑定分支不一致');
    return after;
}

export async function scheduledReviewDataStatus(runtime: Runtime): Promise<{ clean: boolean; paths: string[] }> {
    const result = await runProcess(runtime.vcsType, runtime.vcsType === 'git'
        ? ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', '.ai-review']
        : ['--non-interactive', 'status', '--xml', '--no-ignore', '--ignore-externals', '--', '.ai-review'],
    { cwd: runtime.root, timeoutMs: 30000 });
    if (result.code !== 0) throw uncertain('无法核验评审数据是否干净');
    if (runtime.vcsType === 'svn') return { clean: !/<entry\b/.test(result.stdout), paths: [] };
    return { clean: !result.stdout, paths: result.stdout.split('\0').filter(Boolean).slice(0, 5).map(entry => entry.slice(3)) };
}

export async function scheduledReviewDataClean(runtime: Runtime): Promise<boolean> {
    return (await scheduledReviewDataStatus(runtime)).clean;
}

async function svnScheduledPatch(vcs: VcsAdapter, patchPath: string, dryRun: boolean): Promise<ApplyPatchResult> {
    const result = await runProcess('svn', ['--non-interactive', 'patch', ...(dryRun ? ['--dry-run'] : []), '--',
        path.relative(vcs.root, patchPath)], { cwd: vcs.root, timeoutMs: 180000, env: { LC_ALL: 'C' } });
    const conflict = /^(?:Skipped\b|C[ \t]|.C[ \t]|Summary of conflicts:)/m.test(result.stdout);
    return { ok: result.code === 0 && !conflict, conflict, message: (result.stderr || result.stdout).trim() };
}

export function scheduledPatch(vcs: VcsAdapter, patchPath: string, dryRun: boolean): Promise<ApplyPatchResult> {
    if (vcs.type === 'svn') return svnScheduledPatch(vcs, patchPath, dryRun);
    return dryRun ? vcs.checkPatch(patchPath) : vcs.applyPatch(patchPath, false);
}

export async function scheduledGateState(vcs: VcsAdapter, targetFiles: readonly string[]): Promise<string> {
    const commands = vcs.type === 'git'
        ? [['status', '--porcelain=v1', '-z', '--untracked-files=all'], ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
            ['diff', '--no-ext-diff', '--binary', '--cached', '--']]
        : [['--non-interactive', 'status', '--ignore-externals', '--', '.'], ['--non-interactive', 'diff', '--git', '--', '.']];
    const maxBytes = 16 * 1024 * 1024;
    const outputs = await Promise.all(commands.map(args => runProcess(vcs.type, args, { cwd: vcs.root, timeoutMs: 30000, maxBytes })));
    if (outputs.some(result => result.code !== 0 || Buffer.byteLength(result.stdout) >= maxBytes)) throw new Error('无法核验门禁业务工作区状态');
    const contents = await Promise.all(targetFiles.map(async file => {
        const absolute = path.join(vcs.root, file);
        const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!info) return null;
        if (info.isSymbolicLink()) return [info.mode, await readlink(absolute)];
        if (!info.isFile()) return [info.mode];
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        return [info.mode, hash.digest('hex')];
    }));
    return createHash('sha256').update(JSON.stringify([outputs.map(output => output.stdout), contents])).digest('hex');
}

export async function undoScheduledGatePatch(vcs: VcsAdapter, patchPath: string, targetFiles: readonly string[]): Promise<boolean> {
    const options = { cwd: vcs.root, timeoutMs: 180000, env: { LC_ALL: 'C' } };
    if (vcs.type === 'git') {
        const result = await runProcess('git', ['apply', '--reverse', '--binary', '--', patchPath], options);
        return result.code === 0;
    }
    const reverse = await runProcess('svn', ['--non-interactive', 'patch', '--reverse-diff', '--', path.relative(vcs.root, patchPath)], options);
    if (reverse.code !== 0 || /^(?:Skipped\b|C[ \t]|.C[ \t]|Summary of conflicts:)/m.test(reverse.stdout)) return false;
    // 反向补丁恢复被删除的路径时，SVN 会把它记为 replaced，即使文件内容已恢复原样。
    for (const file of targetFiles) {
        const target = file.includes('@') ? `${file}@` : file;
        const status = await runProcess('svn', ['--non-interactive', 'status', '--xml', '--depth', 'empty', '--', target], options);
        if (status.code !== 0) return false;
        if (!/\bitem="replaced"/.test(status.stdout)) continue;
        const restored = await runProcess('svn', ['--non-interactive', 'revert', '--depth', 'empty', '--', target], options);
        if (restored.code !== 0) return false;
    }
    return true;
}

export async function reviewWorktreeFingerprint(root: string, vcsType: VcsType): Promise<string> {
    const { paths, versionControl } = await captureReviewWorktree(root, vcsType);
    return createHash('sha256').update(JSON.stringify([[...paths], versionControl])).digest('hex');
}

export interface ReviewWorktreeState {
    paths: ReadonlyMap<string, string>;
    versionControl: string;
}

export async function captureReviewWorktree(root: string, vcsType: VcsType, allowUnversioned = false): Promise<ReviewWorktreeState> {
    const paths = new Map<string, string>();
    const directory = path.join(root, '.ai-review');
    const visit = async (absolute: string): Promise<void> => {
        const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && absolute === directory) return null;
            throw error;
        });
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (!info) return;
        if (info.isSymbolicLink()) {
            paths.set(relative, JSON.stringify(['symlink', await readlink(absolute)]));
        } else if (info.isDirectory()) {
            paths.set(relative, 'directory');
            for (const entry of (await readdir(absolute)).sort()) await visit(path.join(absolute, entry));
        } else if (info.isFile()) {
            const contents = createHash('sha256');
            for await (const chunk of createReadStream(absolute)) contents.update(chunk);
            paths.set(relative, JSON.stringify(['file', info.mode, contents.digest('hex')]));
        } else {
            throw new Error(`无法核验非常规评审文件：${relative}`);
        }
    };
    await visit(directory);
    const commands = vcsType === 'git'
        ? [['ls-files', '--stage', '-z', '--', '.ai-review']]
        : [['--non-interactive', 'status', '--xml', '--ignore-externals', allowUnversioned ? '.ai-review' : '.']];
    if (vcsType === 'svn' && !allowUnversioned) commands.push(['--non-interactive', 'diff', '--properties-only', '.']);
    const maxBytes = 16 * 1024 * 1024;
    const versionControl = [];
    for (const args of commands) {
        const result = await runProcess(vcsType, args, { cwd: root, timeoutMs: 30000, maxBytes });
        if (result.code !== 0 || Buffer.byteLength(result.stdout) >= maxBytes) throw new Error('无法核验评审工作区的版本控制状态');
        if (vcsType === 'svn' && allowUnversioned && args.includes('status')) {
            versionControl.push([...result.stdout.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map(([entry]) => entry)
                .filter(entry => !/\bitem="unversioned"/.test(entry)));
        } else {
            versionControl.push(result.stdout);
        }
    }
    return { paths, versionControl: JSON.stringify(versionControl) };
}
