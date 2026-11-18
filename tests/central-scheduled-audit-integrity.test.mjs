import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AuditArchive, parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { scheduledGateState, scheduledPatch, undoScheduledGatePatch } from '../packages/dsh-plugin/dist/host/scheduled-audit-vcs.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

const runner = fileURLToPath(new URL('./fixtures/scheduled-audit-integrity-agent.mjs', import.meta.url));
const previous = '20261117-090000-repo';
const previousReport = `.ai-review/audits/${previous}/audit.md`;

async function setup(t, mode) {
    const root = await createGitFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduled-audit-integrity-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const git = (...args) => runCommand('git', args, root).stdout.trim();
    const target = git('branch', '--show-current');
    const remote = path.join(directory, 'remote.git');
    const project = { projectId: 'project-a', nodeId: 'node-a', workspaceId: 'workspace-a', name: '项目 A',
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true };
    const smokeMode = mode === 'smoke-gate-dirty' || mode === 'smoke-gate-clean';
    const commandPath = mode === 'trusted-reviewers' || smokeMode ? fakeAuditAgentPath() : runner;
    const operations = new ManagedOperations({ dataDir: directory, journal, workspaces: [{
        workspaceId: project.workspaceId, label: project.name, root, target,
        settings: { runner: 'external', externalCommand: `"${process.execPath}" "${commandPath}" ${mode}` },
    }] });
    t.after(async () => {
        operations.stop();
        journal.close();
        await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    if (mode === 'change-archive') {
        await new AuditArchive(root).write({ schemaVersion: 1, auditId: previous, scope: '.',
            createdAt: '2026-11-17T09:00:00Z', baseRevision: git('rev-parse', 'HEAD'), trigger: 'manual',
            previousAudit: null, candidates: [], items: [] }, '# 上轮共享档案');
        git('add', '.ai-review');
        git('commit', '-qm', '上轮共享档案');
    }
    if (smokeMode) {
        const gate = path.join(directory, 'gate.mjs');
        await writeFile(gate, mode === 'smoke-gate-dirty'
            ? "import { writeFileSync } from 'node:fs'; writeFileSync('src/gate-draft.js', '// gate draft');"
            : "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.match(readFileSync('src/math.js', 'utf8'), /a \\+ b/);");
        await mkdir(path.join(root, '.ai-review'));
        await writeFile(path.join(root, '.ai-review/reviewers.yml'), [
            'default_owner: tester', 'verify_gate_on_audit_finalize: smoke',
            `audit_smoke_commands: [${JSON.stringify(`"${process.execPath}" "${gate}"`)}]`, '',
        ].join('\n'));
        git('add', '.ai-review');
        git('commit', '-qm', '配置收尾门禁');
    }
    git('init', '--bare', '-q', remote);
    git('remote', 'add', 'origin', remote);
    git('push', '-qu', 'origin', target);
    if (mode === 'skip-worktree') {
        git('update-index', '--skip-worktree', 'src/math.js');
        await rm(path.join(root, 'src/math.js'));
    }
    await operations.init();
    const base = git('rev-parse', 'HEAD');
    const now = Date.now();
    const command = { commandId: 'scheduled-audit', requestHash: 'b'.repeat(64), projectId: project.projectId,
        nodeId: project.nodeId, bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit',
        payload: { targetPath: '.' }, actor: { userId: 'system-scheduled-audit', reviewIdentity: 'tester' },
        createdAt: new Date(now).toISOString(), scheduledAudit: { scheduledAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now - 1000 + 30 * 60 * 1000).toISOString() } };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    return { base, git, operations, command, project, result, root,
        remoteHead: () => runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim() };
}

test('定时全仓扫描改写已提交旧档案时保留现场并阻止提交，恢复原状后可核验结束', async t => {
    const { base, git, operations, command, project, result, root, remoteHead } = await setup(t, 'change-archive');
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(remoteHead(), base);
    assert.match(await readFile(path.join(root, previousReport), 'utf8'), /Runner 改写的历史内容/);
    assert.equal((await operations.recover(command, result, project)).outcome.status, 'RECOVERY_REQUIRED');
    git('restore', '--', previousReport);
    await rm(path.join(root, '.ai-review/audits', result.outcome.auditId), { recursive: true, force: true });
    assert.equal(git('status', '--porcelain=v1'), '');
    const recovered = await operations.recover(command, result, project);
    assert.equal(recovered.outcome.status, 'ABORTED');
    assert.equal(recovered.delivery.state, 'not_required');
});

test('定时全仓扫描无法将 Runner 改写的首轮负责人配置提交到远端', async t => {
    const { base, git, result, root, remoteHead } = await setup(t, 'change-reviewers');
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(remoteHead(), base);
    assert.match(await readFile(path.join(root, '.ai-review/reviewers.yml'), 'utf8'), /Runner 改写的负责人/);
});

test('定时全仓 Runner 未生成输出就失败时工作区仍干净', async t => {
    const { base, git, result, root, remoteHead } = await setup(t, 'failed-without-output');
    assert.equal(result.outcome.status, 'ABORTED');
    assert.equal(result.delivery.state, 'not_required');
    assert.equal(git('status', '--porcelain=v1'), '');
    assert.equal(remoteHead(), base);
    await assert.rejects(readFile(path.join(root, '.ai-review/reviewers.yml')), { code: 'ENOENT' });
});

test('定时全仓扫描退出时业务工作区有改动，保留跟踪文件改动和未跟踪草稿待核验', async t => {
    const { base, result, root, remoteHead } = await setup(t, 'change-business');
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(remoteHead(), base);
    assert.match(await readFile(path.join(root, 'src/math.js'), 'utf8'), /本地业务改动/);
    assert.match(await readFile(path.join(root, 'src/local-draft.js'), 'utf8'), /尚未提交的草稿/);
});

test('首轮定时审查使用受信 Owner，并将合法候选以 pending 交付', async t => {
    const { git, result, remoteHead } = await setup(t, 'trusted-reviewers');
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result.outcome));
    assert.equal(result.delivery.state, 'delivered');
    assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
    const report = parseAuditMarkdown(git('show', `HEAD:${result.outcome.report.path}`));
    assert.deepEqual(report.meta.candidates, ['2026-10/20261031-math-fix']);
    assert.match(git('show', 'HEAD:.ai-review/reviewers.yml'), /default_owner: "tester"/);
    assert.match(git('show', 'HEAD:.ai-review/2026-10/20261031-math-fix/review.md'), /status: pending/);
    assert.match(git('show', 'HEAD:src/math.js'), /=> a - b/);
});

test('定时收尾门禁留下补丁以外的草稿时保留现场并阻止交付', async t => {
    const { base, root, result, remoteHead } = await setup(t, 'smoke-gate-dirty');
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(result.outcome));
    assert.equal(result.outcome.reason, 'SCHEDULE_SCAN_DIRTY');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(remoteHead(), base);
    assert.match(await readFile(path.join(root, 'src/gate-draft.js'), 'utf8'), /gate draft/);
});

test('干净的定时收尾门禁在已应用补丁后验证，交付前还原该补丁', async t => {
    const { git, result, remoteHead } = await setup(t, 'smoke-gate-clean');
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result.outcome));
    assert.equal(result.delivery.state, 'delivered');
    assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
    assert.equal(git('status', '--porcelain=v1'), '');
    assert.match(git('show', 'HEAD:src/math.js'), /=> a - b/);
});

test('定时预检拒绝 Git 索引中存在未检出的业务路径', async t => {
    const { base, root, result, remoteHead } = await setup(t, 'skip-worktree');
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result.outcome));
    assert.equal(result.outcome.reason, 'SCHEDULE_WORKSPACE_INCOMPLETE');
    assert.equal(remoteHead(), base);
    await assert.rejects(readFile(path.join(root, 'src/math.js')), { code: 'ENOENT' });
});

test('SVN 定时补丁只读预检识别冲突，撤销门禁补丁后还原修改、删除和新增', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduled-gate-svn-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'wc');
    const repo = path.join(directory, 'repo');
    await mkdir(root);
    await mkdir(repo);
    runCommand('svnadmin', ['create', 'repo'], directory);
    runCommand('svn', ['checkout', pathToFileURL(repo).href, 'wc'], directory);
    const svn = (...args) => runCommand('svn', args, root).stdout;
    const tracked = path.join(root, 'tracked.txt');
    const removed = path.join(root, 'removed.txt');
    const added = path.join(root, 'new/child/added.txt');
    await writeFile(tracked, 'original\n');
    await writeFile(removed, 'will be deleted\n');
    svn('add', 'tracked.txt', 'removed.txt');
    svn('commit', '-m', 'initial');
    svn('update');
    await mkdir(path.dirname(added), { recursive: true });
    await writeFile(added, 'new\n');
    await writeFile(tracked, 'updated\n');
    svn('propset', 'audit-test', 'edited', 'tracked.txt');
    svn('add', 'new');
    svn('delete', 'removed.txt');
    await mkdir(path.join(root, '.ai-review'));
    const patch = path.join(root, '.ai-review/001.patch');
    await writeFile(patch, svn('diff'));
    svn('revert', '--remove-added', '-R', '.');
    await rm(path.join(root, 'new'), { recursive: true, force: true });

    const vcs = createVcs('svn', root, '');
    const targets = ['tracked.txt', 'removed.txt', 'new/child/added.txt'];
    assert.equal((await scheduledPatch(vcs, patch, true)).ok, true);
    assert.equal(await readFile(tracked, 'utf8'), 'original\n');
    assert.equal((await scheduledPatch(vcs, patch, false)).ok, true);
    assert.equal(await readFile(tracked, 'utf8'), 'updated\n');
    assert.equal(await readFile(added, 'utf8'), 'new\n');
    const applied = await scheduledGateState(vcs, targets);
    assert.equal(await scheduledGateState(vcs, targets), applied);
    assert.equal(await undoScheduledGatePatch(vcs, patch, targets), true);
    assert.equal(await readFile(removed, 'utf8'), 'will be deleted\n');
    assert.match(svn('status'), /^\?\s+\.ai-review\s*$/);

    await writeFile(patch, [
        'Index: tracked.txt', '===================================================================',
        '--- tracked.txt\t(revision 1)', '+++ tracked.txt\t(working copy)', '@@ -1 +1 @@', '-mismatched', '+updated', '',
    ].join('\n'));
    const rejected = await scheduledPatch(vcs, patch, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.conflict, true);
    assert.match(svn('status'), /^\?\s+\.ai-review\s*$/);
});
