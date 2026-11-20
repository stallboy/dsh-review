import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { auditFiles } from './audit-files.js';
import { dshHome } from './settings.js';
import type { VcsAdapter } from './vcs.js';

export class FindingApprovalState {
    private readonly file: string;

    constructor(root: string, findingId: string, statePath?: string) {
        const location = statePath ? path.dirname(statePath) : path.join(dshHome(), 'dsh-code-review');
        const key = createHash('sha256').update(JSON.stringify([root, findingId])).digest('hex');
        this.file = path.join(location, 'finding-approvals', `${key}.json`);
    }

    async canRetry(vcs: VcsAdapter): Promise<boolean> {
        let text;
        try {
            text = await readFile(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
        }
        const entry = JSON.parse(text) as { paths?: unknown; before?: unknown };
        if (!Array.isArray(entry.paths) || !entry.paths.length || entry.paths.some(value =>
            typeof value !== 'string' || !/^\.ai-review\/\d{4}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]*\/(?:review\.md|\d+\.patch)$/.test(value))
            || typeof entry.before !== 'string' || !entry.before) return false;
        const [probe, workspace] = await Promise.all([vcs.getCommitProbe(entry.paths as string[]), vcs.ensureCleanWorkspace()]);
        if (!workspace.clean || probe !== entry.before) return false;
        if (vcs.type === 'svn') {
            const review = (entry.paths as string[]).find(file => file.endsWith('/review.md'));
            if (!review || await vcs.getRemoteCommitProbe?.(review) !== entry.before) return false;
        }
        for (const file of entry.paths as string[]) {
            const shared = await vcs.readFileAt(probe, file);
            const local = (await auditFiles(vcs.root, { op: 'read', paths: [file] })).bytes?.toString('utf8');
            if (shared === null || local !== shared) return false;
        }
        await this.clear();
        return true;
    }

    async pending(): Promise<boolean> {
        try {
            await lstat(this.file);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
    }

    async begin(paths: string[], before: string | null): Promise<void> {
        if (!before) throw new Error('无法固定审批前提交探针');
        await mkdir(path.dirname(this.file), { recursive: true });
        const handle = await open(this.file, 'wx');
        try {
            await handle.writeFile(JSON.stringify({ paths, before }), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    async clear(): Promise<void> {
        await unlink(this.file).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
}
