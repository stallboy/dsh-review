import { gitBlobHash, type VcsAdapter } from './vcs.js';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { x as extractTar } from 'tar';
import type { AuditLeaseRecord } from './audit-lifecycle.js';
import { serializeReviewMarkdown } from './frontmatter.js';
import { isRepoRelativePath } from './invariants.js';
import { parsePatch } from './patch.js';
import { resolveOwner, type ReviewersConfig } from './reviewers.js';
import { runProcess } from './shell.js';
import type { AuditType } from './types.js';
import { runGateChecks } from './validator.js';
import { AuditStopUnknown } from './audit-stage-runner.js';

export interface StageCandidate {
    id: string;
    title: string;
    patch: string;
    review: string;
}

export interface StageEdit {
    path: string;
    before: string;
    after: string;
}

export function validSourcePath(file: string): boolean {
    return isRepoRelativePath(file) && !/[\\:\r\n\0]/.test(file)
        && !file.split('/').some(part => /^\.(?:ai-review|git|svn|dsh|claude|codex|tmp)$/i.test(part));
}

export function withinScope(scope: string, file: string): boolean {
    return !scope || scope === '.' || scope === file || file.startsWith(scope + '/');
}

export async function compatibleAuditBase(vcs: VcsAdapter, base: string): Promise<boolean> {
    const current = await vcs.getCurrentBase();
    return current === base || (current !== null && (await vcs.businessChangesBetween(base, current))?.length === 0);
}

export async function auditGit(root: string, args: string[], signal: AbortSignal, maximum = 1024 * 1024): Promise<string> {
    const result = await runProcess('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args],
        { cwd: root, signal, timeoutMs: 90_000, maxBytes: maximum });
    if (result.timedOut || result.aborted) throw new AuditStopUnknown('Git 阶段取消或超时');
    if (result.code !== 0 || Buffer.byteLength(result.stdout) >= maximum) throw new Error('阶段 Git 操作失败：' + args[0]);
    return result.stdout;
}

export function oneLine(text: string): string {
    return text.trim().replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').slice(0, 800);
}

async function extractBaseline(lease: AuditLeaseRecord, scratch: string, signal: AbortSignal): Promise<string> {
    const archive = path.join(scratch, 'base.tar');
    const work = path.join(scratch, 'work');
    await mkdir(work);
    await auditGit(lease.root, ['archive', '--format=tar', '-o', archive, lease.baseRevision], signal);
    await extractTar({
        file: archive, cwd: work,
        filter: (name, entry) => validSourcePath(name.replace(/\/$/, '')) && 'type' in entry
            && ['File', 'Directory', 'OldFile'].includes(entry.type),
    });
    return work;
}

export async function verifyStageGates(
    lease: AuditLeaseRecord, patchPath: string, commands: string[], gate: typeof runGateChecks, timeoutMs: number, signal: AbortSignal,
): ReturnType<typeof runGateChecks> {
    const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-audit-gates-'));
    let uncertain = false;
    try {
        const cwd = await extractBaseline(lease, scratch, signal);
        await auditGit(cwd, ['apply', '--binary', patchPath], signal);
        const report = await gate(commands, { cwd, baseRevision: lease.baseRevision, timeoutMs, signal });
        if (signal.aborted || report.results.some(result => result.timedOut)) throw new AuditStopUnknown('门禁停止状态需要核验');
        return report;
    } catch (error) {
        uncertain = error instanceof AuditStopUnknown || signal.aborted;
        throw error;
    } finally {
        if (!uncertain) await rm(scratch, { recursive: true, force: true });
    }
}

export async function prepareStageCandidate(input: {
    lease: AuditLeaseRecord; id: string; scratch: string; edits: StageEdit[]; allowedPaths: string[];
    commands: string[]; reviewers: ReviewersConfig; auditType: AuditType; confirmed: string; evidence: string; summary: string;
    gateTimeoutMs: number; signal: AbortSignal; gate: typeof runGateChecks;
}): Promise<StageCandidate> {
    const { lease, scratch, signal } = input;
    const work = await extractBaseline(lease, scratch, signal);
    await auditGit(work, ['init', '-q'], signal);
    await auditGit(work, ['add', '-f', '--', '.'], signal);
    const edits = new Set<string>();
    for (const edit of input.edits) {
        if (!input.allowedPaths.includes(edit.path) || edits.has(edit.path) || edit.before === edit.after) {
            throw new Error('补丁编辑重复、无变更或超出声明范围');
        }
        edits.add(edit.path);
        const file = path.join(work, edit.path);
        const current = await readFile(file, 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return null;
        });
        if (current === null) {
            if (edit.before || !edit.after) throw new Error('新增文件缺少完整内容：' + edit.path);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, edit.after, { encoding: 'utf8', flag: 'wx' });
            await auditGit(work, ['add', '-N', '-f', '--', edit.path], signal);
        } else {
            const start = current.indexOf(edit.before);
            if (!edit.before || start < 0 || current.indexOf(edit.before, start + 1) >= 0) {
                throw new Error('编辑的基线原文缺失或不唯一：' + edit.path);
            }
            await writeFile(file, current.slice(0, start) + edit.after + current.slice(start + edit.before.length), 'utf8');
        }
    }
    const diff = () => auditGit(work, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', ...edits], signal);
    const patch = await diff();
    const touched = parsePatch(patch).paths.sort();
    if (!patch || touched.length !== edits.size || touched.some(file => !edits.has(file))) throw new Error('补丁路径和编辑不符');
    const remaining = Date.parse(lease.createdAt) + 3600_000 - Date.now();
    if (remaining <= 0) throw new AuditStopUnknown('审查租约已到期');
    const evidence = await input.gate(input.commands, {
        cwd: work, baseRevision: lease.baseRevision, signal, timeoutMs: Math.min(input.gateTimeoutMs, remaining),
    });
    if (signal.aborted || evidence.results.some(result => result.timedOut)) throw new AuditStopUnknown('审查门禁停止状态需要确认');
    if (!evidence.allPassed) throw new Error('候选门禁未全部通过');
    if (await diff() !== patch) throw new Error('门禁改变了候选内容');
    const module = 'audit';
    const title = module + ': ' + oneLine(input.summary);
    const owner = resolveOwner(input.reviewers, { paths: touched, tags: [] }).owner;
    if (!owner) throw new Error('基线缺少有效的候选负责人路由');
    const gates = evidence.results.map(result => '- ' + oneLine(result.command) + '，退出码 0，' + String(result.durationMs) + ' ms').join('\n');
    const body = [
        '# 问题与影响', input.confirmed, '# 根因', input.evidence, '# 当前修复方案', oneLine(input.summary), '# 需人工判断项',
        '- 无', '# 验证证据', '- 基线：' + lease.baseRevision, gates, '# 审核记录', '## 版本 1 (base: ' + lease.baseRevision + ')',
        '### 方案说明', oneLine(input.summary), '### 验证结果', gates, '### 人类总体意见', '待审核', '### 意见处理结果', '无',
    ].join('\n\n');
    const review = serializeReviewMarkdown({
        schemaVersion: 1, module, title, auditType: input.auditType, owner, tags: [], ticket: null, status: 'pending',
        createdAt: lease.createdAt, updatedAt: lease.createdAt, targetFiles: touched, currentRevision: 1,
        revisions: [{ id: 1, baseRevision: lease.baseRevision, patch: '001.patch', author: 'ai' }],
        gateChecks: input.commands, comments: [], humanDecisions: [], approval: null, rejection: null,
        commitMessage: title + '\n\n' + input.confirmed + '\n\n' + gates, extra: {},
    }, body);
    return { id: input.id, title, patch, review };
}

export type StageSeal = Record<string, string>;

const hash = gitBlobHash;

async function artifactPath(root: string, relative: string, create: boolean, created: string[] = []): Promise<string> {
    const parts = relative.split('/');
    if (parts.shift() !== '.ai-review' || parts.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || ['.', '..'].includes(part))) {
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

export async function publishStageArtifacts(
    root: string, reportPath: string, report: string, candidates: StageCandidate[],
    seal: (manifest: StageSeal) => Promise<void>,
): Promise<void> {
    const artifacts = new Map<string, string>([[reportPath, report]]);
    for (const item of candidates) {
        const dir = '.ai-review/' + item.id;
        artifacts.set(dir + '/review.md', item.review);
        artifacts.set(dir + '/001.patch', item.patch);
    }
    const files: string[] = [];
    const dirs: string[] = [];
    try {
        for (const [relative, content] of artifacts) {
            const file = await artifactPath(root, relative, true, dirs);
            await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
            files.push(file);
        }
        await seal(Object.fromEntries([...artifacts].map(([name, content]) => [name, hash(content)])));
    } catch (error) {
        const cleanup = await Promise.allSettled(files.map(file => unlink(file)));
        for (const dir of dirs.reverse()) await rmdir(dir).catch(() => undefined);
        if (cleanup.some(result => result.status === 'rejected')) throw new AuditStopUnknown('评审产物发布失败且无法确认清理');
        throw error;
    }
}

export async function assertStageArtifacts(root: string, manifest: StageSeal, candidates: string[]): Promise<void> {
    const declared = Object.keys(manifest).filter(file => file.endsWith('/review.md')).map(file => file.slice(11, -10)).sort();
    if (declared.join('\0') !== candidates.sort().join('\0')) throw new Error('收尾候选与本轮发布的清单不符');
    const files = Object.keys(manifest);
    for (const [relative, expected] of Object.entries(manifest)) {
        const file = await artifactPath(root, relative, false);
        const parent = path.posix.dirname(relative);
        const expectedNames = files.filter(entry => path.posix.dirname(entry) === parent).map(entry => path.posix.basename(entry)).sort();
        const actualNames = (await readdir(path.dirname(file))).sort();
        if (actualNames.join('\0') !== expectedNames.join('\0')) throw new Error('本轮产物目录包含清单外文件');
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(file)) !== expected) {
            throw new Error('已发布的审查产物发生变化：' + relative);
        }
    }
}
