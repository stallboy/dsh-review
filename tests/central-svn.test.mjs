import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCommand } from './helpers.mjs';
import { reviewFixture, patchFixture } from './fixtures/contract.mjs';
import { ManagedDelivery } from '../packages/dsh-plugin/dist/managed/managed-delivery.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { managedSource } from '../packages/dsh-plugin/dist/managed/managed-source.js';

test('托管 SVN 发现处置与档案从同一远端版本读取', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'finding-svn-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const repo = path.join(directory, 'repo'), reader = path.join(directory, 'reader'), writer = path.join(directory, 'writer');
    const url = pathToFileURL(repo).href;
    runCommand('svnadmin', ['create', repo], directory);
    runCommand('svn', ['checkout', '-q', url, writer], directory);
    await mkdir(path.join(writer, '.ai-review/findings'), { recursive: true });
    const record = path.join(writer, '.ai-review/findings/known-finding.yml');
    await writeFile(record, 'old finding decision\n');
    runCommand('svn', ['add', '.ai-review'], writer);
    runCommand('svn', ['commit', '-qm', 'first version'], writer);
    runCommand('svn', ['checkout', '-q', url, reader], directory);
    const first = await managedSource(reader, 'svn');
    await writeFile(record, 'new finding decision\n');
    runCommand('svn', ['commit', '-qm', 'second version'], writer);
    const second = await managedSource(reader, 'svn');
    assert.equal(await first.source.readFindingText('known-finding'), 'old finding decision\n');
    assert.equal(await second.source.readFindingText('known-finding'), 'new finding decision\n');
});

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
    await nested.init();
    assert.deepEqual(nested.registrations(), []);
    assert.match(nested.workspaceIssue('nested-wc'), /工作副本根目录/);
    nested.stop();
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

test('中央定时 SVN 首轮使用同步后的基线并直接交付审查档案', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-scheduled-svn-'));
    let journal, operations;
    t.after(async () => {
        operations?.stop();
        journal?.close();
        await rm(directory, { recursive: true, force: true });
    });
    const repo = path.join(directory, 'repo'), root = path.join(directory, 'wc'), writer = path.join(directory, 'writer');
    const url = pathToFileURL(repo).href;
    runCommand('svnadmin', ['create', repo], directory);
    runCommand('svn', ['checkout', '-q', url, root], directory);
    runCommand('svn', ['checkout', '-q', url, writer], directory);
    await writeFile(path.join(writer, 'content.md'), '# 审查对象\n');
    runCommand('svn', ['add', 'content.md'], writer);
    runCommand('svn', ['commit', '-qm', '业务基线'], writer);
    const runner = fileURLToPath(new URL('./fixtures/report-only-agent.mjs', import.meta.url));
    journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    operations = new ManagedOperations({ dataDir: path.join(directory, 'state'), journal,
        workspaces: [{ workspaceId: 'svn-wc', label: 'SVN 项目', root, target: '^/',
            settings: { runner: 'external', externalCommand: `"${process.execPath}" "${runner}"` } }] });
    await operations.init();
    const project = { projectId: 'svn-project', nodeId: 'svn-node', name: 'SVN', workspaceId: 'svn-wc',
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'svn', target: '^/', enabled: true };
    const start = Date.now();
    const command = { commandId: 'svn-scheduled-audit', requestHash: 'b'.repeat(64), projectId: project.projectId,
        nodeId: project.nodeId, bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: { targetPath: '.' },
        actor: { userId: 'system-scheduled-audit', reviewIdentity: 'tester' }, createdAt: new Date(start).toISOString(),
        scheduledAudit: { scheduledAt: new Date(start).toISOString(), expiresAt: new Date(start + 30 * 60_000).toISOString() } };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(result.delivery.state, 'delivered');
    const report = parseAuditMarkdown(runCommand('svn', ['cat', `${url}/${result.outcome.report.path}`], root).stdout);
    assert.equal(report.meta.baseRevision, '1');
    assert.equal(report.meta.trigger, 'scheduled');
    assert.equal(report.meta.previousAudit, null);
    assert.match(await readFile(path.join(root, 'content.md'), 'utf8'), /审查对象/);
});

test('中央定时审查遇到稀疏 SVN 检出时保留原范围并跳过', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-sparse-svn-'));
    let journal, operations;
    t.after(async () => {
        operations?.stop();
        journal?.close();
        await rm(directory, { recursive: true, force: true });
    });
    const repo = path.join(directory, 'repo'), root = path.join(directory, 'wc'), writer = path.join(directory, 'writer');
    const url = pathToFileURL(repo).href;
    await mkdir(repo);
    await mkdir(root);
    await mkdir(writer);
    runCommand('svnadmin', ['create', 'repo'], directory);
    runCommand('svn', ['checkout', '-q', url, 'writer'], directory);
    await writeFile(path.join(writer, 'content.md'), '# 审查对象\n');
    runCommand('svn', ['add', 'content.md'], writer);
    runCommand('svn', ['commit', '-qm', '业务基线'], writer);
    runCommand('svn', ['checkout', '-q', '--depth', 'empty', url, 'wc'], directory);
    const runner = fileURLToPath(new URL('./fixtures/report-only-agent.mjs', import.meta.url));
    journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    operations = new ManagedOperations({ dataDir: path.join(directory, 'state'), journal,
        workspaces: [{ workspaceId: 'svn-wc', label: 'SVN 项目', root, target: '^/',
            settings: { runner: 'external', externalCommand: `"${process.execPath}" "${runner}"` } }] });
    await operations.init();
    const project = { projectId: 'svn-project', nodeId: 'svn-node', name: 'SVN', workspaceId: 'svn-wc',
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'svn', target: '^/', enabled: true };
    const start = Date.now();
    const command = { commandId: 'svn-sparse-scheduled-audit', requestHash: 'b'.repeat(64), projectId: project.projectId, nodeId: project.nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: { targetPath: '.' },
        actor: { userId: 'system-scheduled-audit', reviewIdentity: 'tester' }, createdAt: new Date(start).toISOString(),
        scheduledAudit: { scheduledAt: new Date(start).toISOString(), expiresAt: new Date(start + 30 * 60_000).toISOString() } };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_WORKSPACE_INCOMPLETE');
    assert.equal(result.delivery.state, 'not_required');
    assert.equal(runCommand('svn', ['info', '--show-item', 'depth', '.'], root).stdout.trim(), 'empty');
    await assert.rejects(readFile(path.join(root, 'content.md'), 'utf8'), { code: 'ENOENT' });
});
