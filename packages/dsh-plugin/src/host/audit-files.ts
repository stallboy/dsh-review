import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ExpectedCommitEntry } from './vcs.js';

export interface AuditFilesRequest {
    op: 'read' | 'list' | 'write' | 'snapshot' | 'remove';
    paths: string[];
    text?: string;
    createOnly?: boolean;
    entries?: ExpectedCommitEntry[];
}

export interface AuditFilesResult {
    bytes?: Buffer | null;
    names?: string[];
    entries?: ExpectedCommitEntry[];
    missing?: string[];
}

export async function auditFiles(root: string, request: AuditFilesRequest): Promise<AuditFilesResult> {
    const cwd = await realpath(root);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./audit-files-worker.js', import.meta.url))], {
            cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, 30_000);
        timer.unref();
        child.once('message', (message: { result?: AuditFilesResult; error?: string }) => {
            if (timedOut) return;
            if (message.result) resolve(message.result);
            else reject(new Error(message.error ?? '评审文件操作未返回结果'));
        });
        child.once('error', reject);
        child.once('close', () => {
            clearTimeout(timer);
            reject(new Error(timedOut ? '核验或写入评审产物超时' : '评审文件操作未完成'));
        });
        child.send({ ...request, root: cwd }, error => {
            if (error) reject(error);
        });
    });
}
