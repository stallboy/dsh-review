import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture, runCommand } from './helpers.mjs';
import { reviewFixture, patchFixture } from './fixtures/contract.mjs';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';

async function fixture(t) {
    const root = await createGitFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), 'central-operations-'));
    const remote = path.join(state, 'remote.git');
    runCommand('git', ['init', '--bare', '-q', remote], root);
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const directory = path.join(root, '.ai-review/2026-11/fix-retry');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'review.md'), reviewFixture('fix-retry', { baseRevision: JSON.stringify(base), bodyLines: ['修正加法计算。', '', '# 需人工判断项', '', '无。'] }));
    await writeFile(path.join(directory, '001.patch'), patchFixture());
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'candidate'], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    runCommand('git', ['push', '-qu', 'origin', target], root);
    runCommand('git', ['config', 'user.name', 'review-node'], root);
    runCommand('git', ['config', 'user.email', 'review-node@example.com'], root);
    const journal = new ManagedJournal(path.join(state, 'journal.sqlite'));
    t.after(async () => { journal.close(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
    const { ManagedOperations } = await import('../packages/dsh-plugin/dist/managed/managed-operations.js');
    const operations = new ManagedOperations({ dataDir: state, journal, workspaces: [{ workspaceId: 'workspace-a', label: '项目 A', root, target, settings: { runner: 'manual', syncBeforeApprove: false } }] });
    await operations.init();
    t.after(() => operations.stop());
    const project = { projectId: 'project-a', name: '项目 A', nodeId: 'node-a', workspaceId: 'workspace-a', bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true };
    return { operations, project, journal, root, remote, target };
}

test('托管真实候选评论由登录身份提交并交付，旧 guard 拒绝且不重做', async t => {
    const { operations, project, journal, root, remote, target } = await fixture(t);
    const snapshot = await operations.snapshot(project);
    assert.equal(snapshot.queue.length, 1);
    const detail = await operations.read({ queryId: 'detail-a', projectId: project.projectId, bindingGeneration: 1,
        vcsSnapshot: snapshot.vcsSnapshot, kind: 'candidate', params: { id: snapshot.queue[0].id } }, project);
    const meta = detail.data.candidate.meta;
    const command = { commandId: 'comment-a', requestHash: 'a'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'comments', actor: { userId: 'user-a', reviewIdentity: 'tester' },
        payload: { id: snapshot.queue[0].id, content: '补充边界验证', revision: 1 }, guard: { expectedRevision: meta.currentRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt }, createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'COMMITTED');
    assert.equal(result.delivery.state, 'delivered');
    const commit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), commit);
    assert.match(runCommand('git', ['log', '-1', '--format=%B'], root).stdout, /Dsh-Command: comment-a/);
    const recover = await operations.recover(command, result, project);
    assert.equal(recover.outcome.status, 'COMMITTED');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), commit);
    const stale = { ...command, commandId: 'comment-b' };
    journal.accept(stale);
    const rejected = await operations.execute(stale, new AbortController().signal, () => {}, project);
    assert.equal(rejected.outcome.status, 'ABORTED');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), commit);
});

test('托管详情绑定版本，仓库推进后返回 snapshot_moved', async t => {
    const { operations, project, root } = await fixture(t);
    const snapshot = await operations.snapshot(project);
    const query = { queryId: 'query-a', projectId: project.projectId, bindingGeneration: 1, vcsSnapshot: snapshot.vcsSnapshot,
        kind: 'candidate', params: { id: '2026-11/fix-retry' } };
    const detail = await operations.read(query, project);
    assert.equal(detail.status, 'ready');
    assert.equal(detail.data.candidate.meta.owner, 'tester');
    await writeFile(path.join(root, 'other.txt'), 'new');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'advance'], root);
    assert.equal((await operations.read(query, project)).status, 'snapshot_moved');
});

test('仅有指令提交标记不能推断批准成功，原业务结果丢失时继续要求核验', async t => {
    const { operations, project, journal, root } = await fixture(t);
    runCommand('git', ['commit', '--allow-empty', '-qm', 'AI fallback version\n\nDsh-Command: fallback-a'], root);
    const command = { commandId: 'fallback-a', requestHash: 'b'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'approve', actor: { userId: 'user-a', reviewIdentity: 'tester' },
        payload: { id: '2026-11/fix-retry' }, guard: { expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T02:00:00Z' }, createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.recover(command, undefined, project);
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.delivery.state, 'delivered');
});
