import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AuditArchive, parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { loadAuditHistory, verifyPublishedRecheck } from '../packages/dsh-plugin/dist/host/audit-history.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { scheduledGateState, scheduledPatch, undoScheduledGatePatch } from '../packages/dsh-plugin/dist/host/scheduled-audit-vcs.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

const runner = fileURLToPath(new URL('./fixtures/scheduled-audit-integrity-agent.mjs', import.meta.url));
const previous = '20261117-090000-repo';
const previousReport = `.ai-review/audits/${previous}/audit.md`;

test('自动核验人工接手项，无人工线索时仍按证据归因多个修复版本', async t => {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) => runCommand('git', args, root).stdout.trim();
    await writeFile(path.join(root, 'src/range.js'), 'export const valid = () => false;\n');
    git('add', 'src/range.js');
    git('commit', '-qm', 'add baseline range');
    const baseRevision = git('rev-parse', 'HEAD');
    const findingId = 'validate-arithmetic';
    await new AuditArchive(root).write({
        schemaVersion: 2, auditId: previous, scope: '.', createdAt: '2026-11-17T09:00:00Z', baseRevision, trigger: 'manual',
        previousAudit: null, candidates: [], items: [{ findingId, kind: 'confirm', title: '修复计算与范围', summary: '计算和范围判断错误',
            targetFiles: ['src/math.js', 'src/range.js'], dependsOn: null, status: 'pending', candidate: null,
            repairPlan: '检查加法计算和范围判断。' }],
    }, '历史文字方案');
    await mkdir(path.join(root, '.ai-review/findings'), { recursive: true });
    await writeFile(path.join(root, `.ai-review/findings/${findingId}.yml`),
        `schema_version: 1\nfinding_id: ${findingId}\nevents:\n- {revision: 1, audit_id: ${previous}, actor: tester, at: "2026-11-17T10:00:00Z", action: human_takeover}\n`);
    git('add', '.ai-review');
    git('commit', '-qm', 'take over');
    await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
    git('add', 'src/math.js');
    git('commit', '-qm', 'repair math');
    const math = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'src/range.js'), 'export const valid = value => value >= 0;\n');
    git('add', 'src/range.js');
    git('commit', '-qm', 'repair range');
    const range = git('rev-parse', 'HEAD');
    const vcs = createVcs('git', root);
    const source = await GitHeadCandidateSource.create(root);
    const history = await loadAuditHistory(new ReviewStore(root), source, 'src');
    assert.equal(history.findings.get(findingId).disposition, 'human_takeover');
    assert.equal((await loadAuditHistory(new ReviewStore(root), source, 'other')).findings.size, 0);
    const results = [{ id: findingId, status: 'resolved',
        evidence: { file: 'src/math.js', line: 1, excerpt: 'a + b', reason: '按加法计算' },
        relatedEvidence: [{ file: 'src/range.js', line: 1, excerpt: 'value >= 0', reason: '允许非负值' }] }];
    const recheck = await verifyPublishedRecheck(history, results, range, vcs);
    assert.equal(recheck.versioned, true);
    assert.equal(recheck.observations[0].status, 'resolved');
    assert.deepEqual(recheck.observations[0].repairRevisions, [math, range]);
    assert.deepEqual((await verifyPublishedRecheck(history, [{ ...results[0], evidence: { ...results[0].evidence, excerpt: '伪造代码' } }], range, vcs)).observations, []);
});

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
        await operations.stop();
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
    if (mode === 'legacy-central-with-v2-history') {
        await new AuditArchive(root).write({ schemaVersion: 2, auditId: previous, scope: '.',
            createdAt: '2026-11-17T09:00:00Z', baseRevision: git('rev-parse', 'HEAD'), trigger: 'manual',
            previousAudit: null, candidates: [], items: [
                { findingId: 'v2-takeover', kind: 'confirm', title: '已接手的计算问题', summary: '核验计算',
                    targetFiles: ['src/math.js'], dependsOn: null, status: 'pending', candidate: null, repairPlan: '核对运算。' },
            ] }, '# 新版历史档案');
        await mkdir(path.join(root, '.ai-review/findings'), { recursive: true });
        await writeFile(path.join(root, '.ai-review/findings/v2-takeover.yml'),
            `schema_version: 1\nfinding_id: v2-takeover\nevents:\n- {revision: 1, audit_id: ${previous}, actor: tester, at: "2026-11-17T10:00:00Z", action: human_takeover}\n`);
        git('add', '.ai-review');
        git('commit', '-qm', '新版发现的接手状态');
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

test('旧中央触发定时审查时不将已有新版发现复查写入旧档案', async t => {
    const { result, root, remoteHead } = await setup(t, 'legacy-central-with-v2-history');
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(remoteHead(), result.outcome.commitRevision);
    const archive = new AuditArchive(root);
    const report = await archive.read(result.outcome.auditId);
    assert.equal(report.parseError, undefined);
    assert.equal(report.meta.schemaVersion, 1);
    assert.equal(report.meta.previousAudit, null);
    assert.deepEqual(report.meta.items, []);
    assert.equal((await archive.read(previous)).meta.schemaVersion, 2);
});

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
