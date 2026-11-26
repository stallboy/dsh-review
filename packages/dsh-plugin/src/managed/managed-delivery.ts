import type { ManagedResult } from '@dsh-review/protocol';
import { currentTrustedActor } from '../host/api-context.js';
import { runProcess } from '../host/shell.js';
import type { VcsAdapter } from '../host/vcs.js';

type Delivery = ManagedResult['delivery'];

export class ManagedDelivery {
    constructor(private readonly options: { root: string; type: 'git' | 'svn'; target: string }) {}

    private run(args: string[]) {
        return runProcess(this.options.type, this.options.type === 'svn' ? ['--non-interactive', ...args] : args,
            { cwd: this.options.root, timeoutMs: 180000, maxBytes: 8 * 1024 * 1024 });
    }

    async findCommandCommit(commandId: string): Promise<string | null> {
        if (!/^[\w-]+$/.test(commandId)) throw new Error('指令标识无效');
        const marker = `Dsh-Command: ${commandId}`;
        if (this.options.type === 'git') {
            const log = await this.run(['log', '--fixed-strings', '--grep', marker, '--format=%H']);
            if (log.code !== 0) return null;
            for (const commit of log.stdout.trim().split(/\r?\n/).filter(Boolean)) {
                const message = await this.run(['show', '-s', '--format=%B', commit]);
                if (message.code === 0 && message.stdout.split(/\r?\n/).includes(marker)) return commit;
            }
            return null;
        }
        const log = await this.run(['log', '-r', 'HEAD:1', '--xml', '--search', marker, '--limit', '10', '.']);
        if (log.code !== 0) return null;
        for (const entry of log.stdout.matchAll(/<logentry\s+revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g)) {
            const message = /<msg>([\s\S]*?)<\/msg>/.exec(entry[2]!)?.[1];
            if (message?.split(/\r?\n/).includes(marker)) return entry[1]!;
        }
        return null;
    }

    async deliver(commitRevision: string): Promise<Delivery> {
        if (this.options.type === 'svn') {
            if (!/^\d+$/.test(commitRevision)) throw new Error('SVN 提交版本无效');
            const result = await this.run(['log', '--xml', '-r', commitRevision, '.']);
            return { state: result.code === 0 && result.stdout.includes(`revision="${commitRevision}"`) ? 'delivered' : 'unknown', commitRevision };
        }
        if (!/^[a-f\d]{40,64}$/.test(commitRevision)) throw new Error('Git 提交标识无效');
        const target = this.options.target;
        const ref = `refs/heads/${target}`;
        const valid = await this.run(['check-ref-format', ref]);
        const branch = await this.run(['branch', '--show-current']);
        if (valid.code !== 0 || branch.code !== 0 || branch.stdout.trim() !== target) return { state: 'conflict', commitRevision, reason: '工作副本目标分支不匹配' };
        const fetchRemote = async (): Promise<string | null> => {
            const fetched = await this.run(['fetch', '--no-tags', 'origin', ref]);
            if (fetched.code !== 0) return null;
            const remote = await this.run(['rev-parse', 'FETCH_HEAD']);
            return remote.code === 0 ? remote.stdout.trim() : null;
        };
        const contains = async (ancestor: string, descendant: string) => (await this.run(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
        const before = await fetchRemote();
        if (!before) return { state: 'pending', commitRevision, reason: '无法读取远端目标分支，原提交已保留' };
        if (await contains(commitRevision, before)) return { state: 'delivered', commitRevision };
        if (!await contains(before, commitRevision)) return { state: 'conflict', commitRevision, reason: '远端已分叉，需要人工处理' };
        const pushed = await this.run(['push', 'origin', `${commitRevision}:${ref}`]);
        const after = await fetchRemote();
        if (!after) return { state: 'unknown', commitRevision, reason: '推送后无法证明远端结果，请核验原提交' };
        if (await contains(commitRevision, after)) return { state: 'delivered', commitRevision };
        return { state: await contains(after, commitRevision) ? 'pending' : 'conflict', commitRevision,
            reason: pushed.stderr.trim().slice(-2000) || '远端尚未包含原提交' };
    }
}

export function decorateManagedVcs(vcs: VcsAdapter): VcsAdapter {
    const appendTrailer = (message: string): string => {
        const commandId = currentTrustedActor()?.commandId;
        return commandId ? `${message}\n\nDsh-Command: ${commandId}` : message;
    };
    return new Proxy(vcs, {
        get(target, property) {
            if (property === 'atomicCommit') return (input: Parameters<VcsAdapter['atomicCommit']>[0]) =>
                target.atomicCommit({ ...input, message: appendTrailer(input.message) });
            if (property === 'amendCommitWithReview' && target.amendCommitWithReview) {
                return (input: Parameters<NonNullable<VcsAdapter['amendCommitWithReview']>>[0]) =>
                    target.amendCommitWithReview!({ ...input, message: appendTrailer(input.message) });
            }
            if (property === 'collapseLocalCommitsWithReview' && target.collapseLocalCommitsWithReview) {
                return (input: Parameters<NonNullable<VcsAdapter['collapseLocalCommitsWithReview']>>[0]) =>
                    target.collapseLocalCommitsWithReview!({ ...input, message: appendTrailer(input.message) });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
