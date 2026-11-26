import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AuditArchive, parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { loadAuditHistory } from '../packages/dsh-plugin/dist/host/audit-history.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { scheduledGateState, scheduledPatch, undoScheduledGatePatch } from '../packages/dsh-plugin/dist/host/scheduled-audit-vcs.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';
import { patchFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';

const runner = fileURLToPath(new URL('./fixtures/scheduled-audit-integrity-agent.mjs', import.meta.url));
const previous = '20261117-090000-repo';
const previousReport = `.ai-review/audits/${previous}/audit.md`;

test('D10：loadAuditHistory 过滤 approved 不进入待查列表，保留 awaiting_verification 并遵守 scope', async t => {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) => runCommand('git', args, root).stdout.trim();
    const base = git('rev-parse', 'HEAD');
    const sha = sha256Hex(patchFixture());
    await writeCandidate(root, 'approved-item', {
        review: {
            findingId: 'approved-item',
            baseRevision: JSON.stringify(base),
            status: 'approved',
            repairAttempts: `[{id: 1, option_id: opt-a, patch_id: 1, base_revision: ${JSON.stringify(base)}, actor: tester, at: "2026-11-17T09:00:00Z", apply_mode: program_strict, result: applied, restored: false, evidence: "ok"}]`,
            approval: `{option_id: opt-a, patch_id: 1, record_revision: 1, repair_attempt_id: 1, base_revision: ${JSON.stringify(base)}, patch_sha256: "${sha}", approved_by: tester, approved_at: "2026-11-17T09:00:00Z", gate_checks: ["node --version"], gate_results: [{command: "node --version", exit_code: 0, duration_ms: 1}], confirmed_decisions: [], waived_decisions: []}`,
        },
    });
    await writeCandidate(root, 'awaiting-item', {
        review: {
            findingId: 'awaiting-item',
            baseRevision: JSON.stringify(base),
            status: 'awaiting_verification',
            decisions: '[{action: human_takeover, actor: tester, at: "2026-11-17T09:00:00Z", reason: "人工"}, {action: external_completed, actor: tester, at: "2026-11-17T10:00:00Z", reason: "已修"}]',
        },
    });
    git('add', '.ai-review');
    git('commit', '-qm', 'history fixture');

    const source = await GitHeadCandidateSource.create(root);
    const inSrc = await loadAuditHistory(new ReviewStore(root), source, 'src');
    assert.equal(inSrc.activeForOrchestrator.some((i) => i.findingId === 'approved-item'), false, 'approved 不应主动进入总调度清单');
    assert.deepEqual(inSrc.awaitingVerification.map((i) => i.findingId), ['awaiting-item']);
    assert.equal(inSrc.closedFindingIds.has('approved-item'), true);

    const inOther = await loadAuditHistory(new ReviewStore(root), source, 'other');
    assert.equal(inOther.activeForOrchestrator.length, 0);
    assert.equal(inOther.awaitingVerification.length, 0);
});

async function setup(t, mode) {
    const root = await createGitFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scheduled-audit-integrity-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const git = (...args) => runCommand('git', args, root).stdout.trim();
    const target = git('branch', '--show-current');
    const remote = path.join(directory, 'remote.git');
    const project = {
        projectId: 'project-a', nodeId: 'node-a', workspaceId: 'workspace-a', name: '项目 A',
        bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true,
    };
    const smokeMode = mode === 'smoke-gate-dirty' || mode === 'smoke-gate-clean';
    const commandPath = mode === 'trusted-reviewers' || smokeMode ? fakeAuditAgentPath() : runner;
    const operations = new ManagedOperations({
        dataDir: directory,
        journal,
        workspaces: [{
            workspaceId: project.workspaceId, label: project.name, root, target,
            settings: { runner: 'external', externalCommand: `"${process.execPath}" "${commandPath}" ${mode}` },
        }],
    });
    t.after(async () => {
        await operations.stop();
        journal.close();
        await rm(root, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    });
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    if (mode !== 'missing-reviewers') {
        await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    }
    if (mode === 'change-archive') {
        await new AuditArchive(root).writeAudit({
            schemaVersion: 1, auditId: previous, scope: '.',
            createdAt: '2026-11-17T09:00:00Z', baseRevision: git('rev-parse', 'HEAD'), trigger: 'manual',
            previousAudit: null, issues: [],
        }, '# 上轮共享档案\n');
    }
    if (mode !== 'missing-reviewers') {
        git('add', '.ai-review');
        git('commit', '-qm', '配置审查基线');
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
    const command = {
        commandId: 'scheduled-audit', requestHash: 'b'.repeat(64), projectId: project.projectId,
        nodeId: project.nodeId, bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit',
        payload: { targetPath: '.' }, actor: { userId: 'system-scheduled-audit', reviewIdentity: 'tester' },
        createdAt: new Date(now).toISOString(),
        scheduledAudit: {
            scheduledAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now - 1000 + 30 * 60 * 1000).toISOString(),
        },
    };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    return {
        base, git, operations, command, project, result, root,
        remoteHead: () => runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(),
    };
}

test('AC-ROUTING-01：未配置 reviewers.yml 时定时审查前置拒绝（412）不启动 Runner', async t => {
    const { result, remoteHead, base } = await setup(t, 'missing-reviewers');
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.httpStatus, 412);
    assert.equal(remoteHead(), base);
});

test('定时全仓扫描改写已提交旧档案时不会将篡改档案提交到远端', async t => {
    const { base, git, result, remoteHead } = await setup(t, 'change-archive');
    assert.equal(git('show', `refs/heads/${git('branch', '--show-current')}:${previousReport}`).includes('Runner 改写的历史内容'), false);
    if (result.outcome.status !== 'COMMITTED') {
        assert.equal(remoteHead(), base);
    }
});

test('定时全仓扫描无法将 Runner 改写的负责人配置提交到远端', async t => {
    const { root, remoteHead } = await setup(t, 'change-reviewers');
    const committedReviewers = runCommand('git', ['show', `${remoteHead()}:.ai-review/reviewers.yml`], root);
    assert.doesNotMatch(committedReviewers.stdout ?? '', /Runner 改写的负责人/);
});

test('定时全仓 Runner 未生成输出就失败时中止且不提交', async t => {
    const { base, result, remoteHead } = await setup(t, 'failed-without-output');
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.delivery.state, 'not_required');
    assert.equal(remoteHead(), base);
});

test('SPEC §5.3 软引导 + Host 强还原：定时扫描退出前强制还原非 .ai-review 业务改动', async t => {
    const { result, root } = await setup(t, 'change-business');
    assert.equal(await readFile(path.join(root, 'src/math.js'), 'utf8'), 'export const add = (a, b) => a - b;\n');
    await assert.rejects(readFile(path.join(root, 'src/local-draft.js')), { code: 'ENOENT' });
    assert.ok(['COMMITTED', 'ABORTED', 'VALIDATION_FAILED'].includes(result.outcome.status), JSON.stringify(result));
});

test('定时审查使用受信 reviewers.yml，并将合法 schema1 候选以 pending 交付', async t => {
    const { git, result, remoteHead } = await setup(t, 'trusted-reviewers');
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result.outcome));
    assert.equal(result.delivery.state, 'delivered');
    assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
    const report = parseAuditMarkdown(git('show', `HEAD:${result.outcome.report.path}`));
    assert.equal(report.meta.schemaVersion, 1);
    assert.deepEqual(report.meta.issues, ['2026-10/20261031-math-fix']);
    assert.match(git('show', 'HEAD:.ai-review/2026-10/20261031-math-fix/review.md'), /status: pending/);
    assert.match(git('show', 'HEAD:src/math.js'), /=> a - b/);
});

for (const mode of ['smoke-gate-dirty', 'smoke-gate-clean']) {
    test(`I18：审查收尾绝不运行修复门禁（${mode}）`, async t => {
        const { git, root, result, remoteHead } = await setup(t, mode);
        assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result.outcome));
        assert.equal(result.delivery.state, 'delivered');
        assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
        assert.equal(git('status', '--porcelain=v1'), '');
        assert.match(git('show', 'HEAD:src/math.js'), /=> a - b/);
        await assert.rejects(readFile(path.join(root, 'src/gate-draft.js')), { code: 'ENOENT' });
    });
}

test('定时预检拒绝 Git 索引中存在未检出的业务路径', async t => {
    const { base, root, result, remoteHead } = await setup(t, 'skip-worktree');
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
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
