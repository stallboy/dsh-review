import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCommand } from './helpers.mjs';
import { reviewFixture, patchFixture } from './fixtures/contract.mjs';
import { ManagedDelivery } from '../packages/dsh-plugin/dist/managed/managed-delivery.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';

test('SVN 子路径提交后固定远端版本读取，批准直接交付原远端版本', async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'central-svn-'));
    const root = path.join(base, 'wc'), repo = path.join(base, 'repo');
    runCommand('svnadmin', ['create', repo], base);
    runCommand('svn', ['checkout', '-q', pathToFileURL(repo).href, root], base);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a - b;\n');
    runCommand('svn', ['add', 'src'], root);
    runCommand('svn', ['commit', '-qm', 'base'], root);
    runCommand('svn', ['update', '-q'], root);
    const directory = path.join(root, '.ai-review/2026-11/fix-retry');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'review.md'), reviewFixture('fix-retry', { bodyLines: ['修正加法计算。', '', '# 需人工判断项', '', '无。'] }));
    await writeFile(path.join(directory, '001.patch'), patchFixture());
    runCommand('svn', ['add', '.ai-review'], root);
    runCommand('svn', ['commit', '-qm', 'candidate'], root);
    const rootRevision = runCommand('svn', ['info', '--show-item', 'revision', '.'], root).stdout.trim();
    assert.equal(rootRevision, '1');
    const journal = new ManagedJournal(path.join(base, 'journal.sqlite'));
    const operations = new ManagedOperations({ dataDir: path.join(base, 'state'), journal,
        workspaces: [{ workspaceId: 'svn-wc', label: 'SVN 项目', root, target: '^/', settings: { runner: 'manual', syncBeforeApprove: false } }] });
    await operations.init();
    const nested = new ManagedOperations({ dataDir: path.join(base, 'nested-state'), journal,
        workspaces: [{ workspaceId: 'nested-wc', label: '无效子目录', root: path.join(root, 'src') }] });
    await assert.rejects(nested.init(), /工作副本根目录/);
    t.after(async () => { operations.stop(); journal.close(); await rm(base, { recursive: true, force: true }); });
    const project = { projectId: 'svn-project', nodeId: 'svn-node', name: 'SVN', workspaceId: 'svn-wc', bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'svn', target: '^/', enabled: true };
    const snapshot = await operations.snapshot(project);
    assert.equal(snapshot.queue.length, 1, '不能因根 BASE 较旧而漏掉子路径新候选');
    const detail = await operations.read({ queryId: 'svn-query', projectId: project.projectId, bindingGeneration: 1, vcsSnapshot: snapshot.vcsSnapshot, kind: 'candidate', params: { id: '2026-11/fix-retry' } }, project);
    assert.equal(detail.status, 'ready');
    const meta = detail.data.candidate.meta;
    const command = { commandId: 'svn-approve', requestHash: 'a'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'approve', actor: { userId: 'tester-id', reviewIdentity: 'tester' },
        payload: { id: '2026-11/fix-retry', confirmedDecisions: [] }, guard: { expectedRevision: meta.currentRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt }, createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(result.delivery.state, 'delivered');
    const delivery = new ManagedDelivery({ root, type: 'svn', target: '^/' });
    assert.equal(await delivery.findCommandCommit(command.commandId), result.delivery.commitRevision);
    assert.match(await readFile(path.join(root, 'src/math.js'), 'utf8'), /a \+ b/);
    const recovered = await operations.recover(command, result, project);
    assert.equal(recovered.delivery.commitRevision, result.delivery.commitRevision);
    assert.equal(recovered.delivery.state, 'delivered');
});
