import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from './api-context.js';
import { runProcess } from './shell.js';
import { ApiError } from './types.js';
import type { VcsType } from './types.js';

export async function matchesAuditTarget(runtime: Runtime, target: string): Promise<boolean> {
    const result = await runProcess(runtime.vcsType, runtime.vcsType === 'git' ? ['branch', '--show-current'] :
        ['--non-interactive', 'info', '--show-item', 'relative-url', '.'], { cwd: runtime.root, timeoutMs: 30000 });
    return result.code === 0 && result.stdout.trim() === target;
}

function uncertain(message: string): ApiError {
    return new ApiError(409, 'conflict', message, { status: 'RECOVERY_REQUIRED', reason: 'SYNC_STATE_UNKNOWN', detail: message });
}

export async function syncScheduledAudit(runtime: Runtime, target: string, signal: AbortSignal): Promise<string> {
    const { vcs } = runtime;
    const assertNotCancelled = () => {
        if (signal.aborted) throw new ApiError(409, 'conflict', '定时审查在同步期间已取消', { reason: 'CANCELLED' });
    };
    if (!await matchesAuditTarget(runtime, target)) throw new ApiError(409, 'conflict', '工作副本目标已变化，已跳过定时审查');
    const before = await vcs.getCurrentBase();
    if (!before) throw new ApiError(412, 'not_configured', '定时审查缺少可用的仓库基线', { reason: 'SCHEDULE_WORKSPACE_NO_BASE' });
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

export async function scheduledReviewDataClean(runtime: Runtime): Promise<boolean> {
    const result = await runProcess(runtime.vcsType, runtime.vcsType === 'git'
        ? ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', '.ai-review']
        : ['--non-interactive', 'status', '--xml', '--no-ignore', '--ignore-externals', '--', '.ai-review'],
    { cwd: runtime.root, timeoutMs: 30000 });
    if (result.code !== 0) throw uncertain('无法核验评审数据是否干净');
    return runtime.vcsType === 'git' ? !result.stdout : !/<entry\b/.test(result.stdout);
}

export async function reviewWorktreeFingerprint(root: string, vcsType: VcsType): Promise<string> {
    const fingerprint = createHash('sha256');
    const directory = path.join(root, '.ai-review');
    const visit = async (absolute: string): Promise<void> => {
        const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && absolute === directory) return null;
            throw error;
        });
        const relative = path.relative(root, absolute);
        if (!info) return;
        if (info.isSymbolicLink()) {
            fingerprint.update(JSON.stringify([relative, 'symlink', await readlink(absolute)]));
        } else if (info.isDirectory()) {
            fingerprint.update(JSON.stringify([relative, 'directory']));
            for (const entry of (await readdir(absolute)).sort()) await visit(path.join(absolute, entry));
        } else if (info.isFile()) {
            const contents = createHash('sha256');
            for await (const chunk of createReadStream(absolute)) contents.update(chunk);
            fingerprint.update(JSON.stringify([relative, info.mode, contents.digest('hex')]));
        } else {
            throw new Error(`无法核验非常规评审文件：${relative}`);
        }
    };
    await visit(directory);
    const commands = vcsType === 'git'
        ? [['ls-files', '--stage', '-z', '--', '.ai-review']]
        : [['--non-interactive', 'status', '--xml', '--ignore-externals', '.'], ['--non-interactive', 'diff', '--properties-only', '.']];
    const maxBytes = 16 * 1024 * 1024;
    for (const args of commands) {
        const result = await runProcess(vcsType, args, { cwd: root, timeoutMs: 30000, maxBytes });
        if (result.code !== 0 || Buffer.byteLength(result.stdout) >= maxBytes) throw new Error('无法核验评审工作区的版本控制状态');
        fingerprint.update(JSON.stringify(result.stdout));
    }
    return fingerprint.digest('hex');
}
