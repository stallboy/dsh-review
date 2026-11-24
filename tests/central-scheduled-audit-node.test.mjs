import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AuditArchive, parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';
import { bindProject, setupCentral } from './central-helpers.mjs';

const workspaceId = 'workspace-a';
const projectId = 'project-a';
const nodeId = 'node-a';
const fakeRunner = fileURLToPath(new URL('./fixtures/scheduled-audit-agent.mjs', import.meta.url));

function commandFor(id, scheduled = true) {
    const now = Date.now();
    return {
        commandId: id, requestHash: 'b'.repeat(64), projectId, nodeId,
        bindingGeneration: 1, projectConfigRevision: 1, operation: 'audit', payload: { targetPath: '.' },
        actor: { userId: scheduled ? 'system-scheduled-audit' : 'user-a', reviewIdentity: '配置人' },
        createdAt: new Date(now).toISOString(),
        ...(scheduled ? { scheduledAudit: { scheduledAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now - 1000 + 30 * 60 * 1000).toISOString() } } : {}),
    };
}

async function setup(t, runner = 'external', runnerArg = '', auditSessions, runnerPath = fakeRunner) {
    const root = await createGitFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-scheduled-node-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    const remote = path.join(directory, 'remote.git');
    const writer = path.join(directory, 'writer');
    const operations = new ManagedOperations({
        dataDir: directory, journal, auditSessions,
        workspaces: [{ workspaceId, label: '项目 A', root, target, settings: { runner, externalCommand: `"${process.execPath}" "${runnerPath}" ${runnerArg}` } }],
    });
    t.after(async () => {
        await operations.stop();
        journal.close();
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
        await rm(directory, { recursive: true, force: true });
    });
    runCommand('git', ['init', '--bare', '-q', remote], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    runCommand('git', ['push', '-qu', 'origin', target], root);
    runCommand('git', ['clone', '-q', '-b', target, remote, writer], root);
    runCommand('git', ['config', 'user.name', 'scheduled-review'], root);
    runCommand('git', ['config', 'user.email', 'review@example.com'], root);
    await operations.init();
    const project = { projectId, nodeId, workspaceId, name: '项目 A', bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target, enabled: true };
    const execute = async (command, log = () => {}) => {
        journal.accept(command);
        return operations.execute(command, new AbortController().signal, log, project);
    };
    return { root, writer, remote, target, operations, project, journal, directory, execute };
}

test('中央定时 Runner 使用阶段通道并交付 Host 生成的报告', async t => {
    const runner = fileURLToPath(new URL('./fixtures/phased-audit-agent.mjs', import.meta.url));
    const capabilities = { auditStageExecutor: async ({ prompt }) => {
        assert.match(prompt, /固定基线只读视图/);
        return { leads: [], coverage: ['中央定时共享阶段'], limits: [] };
    } };
    const { execute, root, writer, remote, target } = await setup(t, 'external', 'empty check-scheduled-note', capabilities, runner);
    const previousId = '20261117-090000-repo';
    const base = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();
    await writeArchive(writer, previousId, base, '.', [{
        findingId: 'historical-phased', kind: 'confirm', title: '旧档案的问题', summary: '核对旧问题',
        targetFiles: ['src/math.js'], dependsOn: null, status: 'pending', candidate: null,
    }]);
    runCommand('git', ['add', '--', '.ai-review'], writer);
    runCommand('git', ['commit', '-qm', '补充定时历史档案'], writer);
    runCommand('git', ['push', '-q', 'origin', target], writer);
    const command = commandFor('schedule-phased');
    command.payload.note = '重点核对阶段审查的权限边界';
    const logs = [];
    const result = await execute(command, entry => logs.push(entry));
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.ok(logs.some(entry => entry.includes('已验证历史提示范围')), logs.join('\n'));
    assert.equal(result.delivery.state, 'delivered', JSON.stringify(result));
    assert.equal(result.outcome.report.path, result.outcome.reportPath);
    const report = runCommand('git', ['show', 'refs/heads/' + target + ':' + result.outcome.reportPath], remote).stdout;
    assert.match(report, /trigger: scheduled/);
    assert.match(report, /中央定时共享阶段/);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), result.delivery.commitRevision);
});

for (const scheduled of [false, true]) {
    test(`中央${scheduled ? '定时' : '后台手动'} Runner 取消后可以核验并释放原租约`, { timeout: 35_000 }, async t => {
        const runner = fileURLToPath(new URL('./fixtures/phased-audit-agent.mjs', import.meta.url));
        const capabilities = { auditStageExecutor: async () => { throw new Error('此用例在派发阶段之前取消'); } };
        const { operations, project, journal, root } = await setup(t, 'external', 'cancel-before-publication', capabilities, runner);
        const command = commandFor('phased-cancel', scheduled);
        const controller = new AbortController();
        journal.accept(command);
        const result = await operations.execute(command, controller.signal, message => {
            if (message.includes('Runner 已开始等待取消')) controller.abort();
        }, project);
        assert.equal(result.outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
        assert.equal(result.delivery.state, 'unknown');
        const scratch = path.join(root, 'src/math.js');
        const original = await readFile(scratch, 'utf8');
        await writeFile(scratch, original + '// 临时改动\n');
        const blocked = await operations.recover(command, result, project);
        assert.equal(blocked.outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(blocked));
        await writeFile(scratch, original);
        const recovered = await operations.recover(command, result, project);
        assert.equal(recovered.outcome.status, 'ABORTED', JSON.stringify(recovered));
        assert.equal(recovered.outcome.auditId, result.outcome.auditId);
        assert.equal(recovered.delivery.state, 'not_required');
        assert.deepEqual(await operations.recover(command, result, project), recovered);
    });
}

async function writeArchive(root, id, base, scope, items = [], candidates = []) {
    const [, date, time] = /^(\d{8})-(\d{6})-/.exec(id);
    const createdAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}Z`;
    return new AuditArchive(root).write({
        schemaVersion: 1, auditId: id, createdAt, baseRevision: base, scope, trigger: 'manual',
        previousAudit: null, candidates, items,
    }, '# 既有共享审查档案');
}

test('托管定时审查同步绑定分支，在同一基线上先复查，再归档全仓结果和稳定 finding ID', async t => {
    const { root, writer, remote, target, operations, journal, directory } = await setup(t, 'external', 'require-plan-note');
    const original = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();
    await writeCandidate(writer, 'approved-last-round', {
        review: {
            baseRevision: JSON.stringify(original), status: 'approved',
            approval: '{approved_by: tester, approved_at: "2026-11-01T11:00:00+08:00", gate_checks: ["node --version"], gate_results: [{command: "node --version", exit_code: 0, duration_ms: 10}], confirmed_decisions: [], waived_decisions: [], commit_revision: null}',
        },
    });
    await writeCandidate(writer, 'linked-pending', { review: { baseRevision: JSON.stringify(original) } });
    const item = (findingId, title, status = 'pending') => ({
        findingId, kind: 'confirm', title, summary: '需要核实历史问题', targetFiles: ['src/math.js'], dependsOn: null, status, candidate: null,
    });
    await writeArchive(writer, '20261117-090000-repo', original, '.', [
        item('historical-fixed', '加法误用减号'),
        item('historical-unverified', '未知边界'),
        item('historical-dismissed', '已人工排除', 'dismissed'),
        item('historical-unrelated-file', '需要相关代码证据'),
        { ...item('historical-linked', '已关联边界问题', 'converted'), candidate: '2026-11/linked-pending' },
    ], ['2026-11/approved-last-round']);
    await writeArchive(writer, '20261117-100000-src', original, 'src');
    await writeFile(path.join(writer, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
    await writeFile(path.join(writer, 'UNRELATED.md'), '# 无关说明\n');
    runCommand('git', ['add', '-A'], writer);
    runCommand('git', ['commit', '-qm', '上游修复与共享审查档案'], writer);
    runCommand('git', ['push', '-q', 'origin', target], writer);
    const upstream = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();
    const hook = path.join(root, '.git/hooks/post-merge');
    const syncLease = path.join(directory, 'lease-during-sync.json');
    const shellPath = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    await writeFile(hook, `#!/bin/sh\nif test -f ${shellPath(path.join(directory, `${workspaceId}-runtime.json`))}; then\n  cp ${shellPath(path.join(directory, `${workspaceId}-runtime.json`))} ${shellPath(syncLease)}\nfi\n`);
    await chmod(hook, 0o755);
    let now = new Date('2026-11-18T07:59:00Z');
    const clock = () => now;
    const { app, headers } = await setupCentral(t, { clock });
    const credential = app.database.createNode('定时审查节点');
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const snapshotStarted = Promise.withResolvers(), snapshotCanFinish = Promise.withResolvers();
    const node = new ManagedNode({
        config: { centerUrl, ...credential, workspaces: operations.registrations() }, journal, clock,
        execute: operations.execute.bind(operations), read: operations.read.bind(operations),
        snapshot: async project => {
            snapshotStarted.resolve();
            await snapshotCanFinish.promise;
            return operations.snapshot(project);
        },
    });
    t.after(() => { snapshotCanFinish.resolve(); return node.stop(); });
    await node.tick();
    const project = await bindProject(app, headers, { ...credential, workspaceId });
    const schedule = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.projectId}/audit-plans`, headers,
        payload: { name: '接口兼容性巡检', enabled: true, startTime: '08:00', timeZone: 'UTC',
            recurrence: { kind: 'weekly', weekdays: [3] }, note: '重点检查新增接口的兼容行为' } });
    assert.equal(schedule.statusCode, 201, schedule.body);
    await node.tick();
    await snapshotStarted.promise;
    now = new Date('2026-11-18T08:05:00Z');
    try {
        await node.tick();
        const waiting = await app.inject({ url: `/api/v1/tasks?projectId=${project.projectId}`, headers });
        assert.deepEqual(waiting.json().tasks, [], '本机仍在读取时不应占用中央任务名额');
    } finally {
        snapshotCanFinish.resolve();
    }
    await node.drain();
    await node.tick();
    await node.drain();
    await node.tick();
    const tasks = await app.inject({ url: `/api/v1/tasks?projectId=${project.projectId}`, headers });
    const [task, ...others] = tasks.json().tasks;
    assert.ok(task, tasks.body);
    assert.equal(others.length, 0);
    assert.equal(task.state, 'completed', JSON.stringify(task));
    assert.deepEqual(task.actor, { userId: 'system-scheduled-audit', reviewIdentity: '审核者甲' });
    const { result } = task;
    assert.equal(result.outcome.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(result.delivery.state, 'delivered');
    const leaseDuringSync = JSON.parse(await readFile(syncLease, 'utf8')).leases.at(-1);
    assert.equal(leaseDuringSync.state, 'active');
    assert.equal(leaseDuringSync.baseRevision, original);
    const committed = runCommand('git', ['show', `refs/heads/${target}:${result.outcome.report.path}`], remote).stdout;
    const record = parseAuditMarkdown(committed);
    assert.equal(record.meta.trigger, 'scheduled');
    assert.equal(record.meta.baseRevision, upstream);
    assert.equal(record.meta.previousAudit, '20261117-090000-repo');
    assert.deepEqual(record.meta.items.map(({ findingId, status, candidate }) => [findingId, status, candidate]),
        [['historical-fixed', 'resolved', null], ['historical-linked', 'converted', '2026-11/linked-pending']], record.body);
    assert.match(record.meta.items[0].summary, /src\/math\.js:1/);
    assert.match(record.body, /approved-last-round.*已核实/);
    assert.match(record.body, /historical-linked.*仍存在.*相关边界/);
    assert.doesNotMatch(record.body, /AI 报告不应覆盖/);
    const snapshot = await operations.snapshot(project);
    assert.equal(snapshot.findings.find(finding => finding.findingId === 'historical-unverified').lastObservedAudit, '20261117-090000-repo');
    assert.equal(snapshot.findings.find(finding => finding.findingId === 'historical-linked').candidate, '2026-11/linked-pending');
    assert.equal(snapshot.findings.find(finding => finding.findingId === 'historical-unrelated-file').lastObservedAudit, '20261117-090000-repo');
    assert.equal(snapshot.findings.find(finding => finding.findingId === 'historical-dismissed').state, 'dismissed');
    await node.drain();
});

test('托管手动审查保持 manual，手动 Runner 不申报定时能力', async t => {
    const manual = await setup(t, 'manual');
    assert.equal(manual.operations.registrations()[0].supportsScheduledAudit, undefined);
    const result = await manual.execute(commandFor('scheduled-unavailable'));
    assert.equal(result.outcome.status, 'ABORTED');
    const external = await setup(t);
    assert.equal(external.operations.registrations()[0].supportsScheduledAudit, true);
    const committed = await external.execute(commandFor('user-review', false));
    assert.equal(committed.outcome.status, 'COMMITTED');
    const text = runCommand('git', ['show', `HEAD:${committed.outcome.report.path}`], external.root).stdout;
    assert.equal(parseAuditMarkdown(text).meta.trigger, 'manual');
});

test('历史复查误写的候选被保留待核验，定时审查不进入全仓扫描或远端交付', async t => {
    const { root, remote, target, directory, operations, project, execute } = await setup(t, 'external', 'write-during-recheck');
    const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    await writeArchive(root, '20261117-090000-repo', before, '.');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', '共享历史档案'], root);
    runCommand('git', ['push', '-q', 'origin', target], root);
    const shared = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const command = commandFor('history-written');
    const result = await execute(command);
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_RECHECK_DIRTY');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), shared);
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), shared);
    const uncommitted = path.join(root, '.ai-review/2026-11/stage-one-candidate');
    assert.match(await readFile(path.join(uncommitted, 'review.md'), 'utf8'), /stage-one-candidate/);
    const leaseState = async () => JSON.parse(await readFile(path.join(directory, `${workspaceId}-runtime.json`), 'utf8')).leases.at(-1).state;
    assert.equal(await leaseState(), 'releasable');
    assert.equal((await operations.recover(command, result, project)).outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(await leaseState(), 'releasable');
    await rm(uncommitted, { recursive: true });
    const recovered = await operations.recover(command, result, project);
    assert.equal(recovered.outcome.status, 'ABORTED', JSON.stringify(recovered));
    assert.equal(recovered.delivery.state, 'not_required');
    assert.equal(await leaseState(), 'released');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), shared);
});

test('工作副本有未提交的评审配置时跳过定时审查并保留草稿', async t => {
    const { root, execute } = await setup(t);
    const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const reviewers = path.join(root, '.ai-review', 'reviewers.yml');
    await mkdir(path.dirname(reviewers), { recursive: true });
    await writeFile(reviewers, 'default_owner: 草稿负责人\n');
    const result = await execute(commandFor('skip-local-reviewers'));
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_WORKSPACE_DIRTY');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
    assert.equal(await readFile(reviewers, 'utf8'), 'default_owner: 草稿负责人\n');
});

test('只读复查遇到业务改动时保留已跟踪和未跟踪文件并停止全量扫描', async t => {
    const { root, remote, target, execute } = await setup(t, 'external', 'write-business-during-recheck');
    const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    await writeArchive(root, '20261117-090000-repo', before, '.');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', '共享历史档案'], root);
    runCommand('git', ['push', '-q', 'origin', target], root);
    const shared = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const result = await execute(commandFor('recheck-business-changed'));
    assert.equal(result.outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_RECHECK_DIRTY');
    assert.equal(result.delivery.state, 'unknown');
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), shared);
    assert.equal(await readFile(path.join(root, 'src/math.js'), 'utf8'), '// 复查期间出现的业务改动\n');
    assert.equal(await readFile(path.join(root, 'local-note.txt'), 'utf8'), '复查期间出现的未跟踪文件\n');
    assert.deepEqual((await new AuditArchive(root).list()).map(record => record.meta.auditId), ['20261117-090000-repo']);
});

test('定时审查发现 Git 稀疏检出时跳过且不扩展检出范围', async t => {
    const { root, execute } = await setup(t);
    runCommand('git', ['sparse-checkout', 'set', '--no-cone', '/package.json'], root);
    await assert.rejects(readFile(path.join(root, 'src/math.js'), 'utf8'), { code: 'ENOENT' });
    const result = await execute(commandFor('scheduled-sparse-git'));
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_WORKSPACE_INCOMPLETE');
    assert.equal(result.delivery.state, 'not_required');
    await assert.rejects(readFile(path.join(root, 'src/math.js'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, '.ai-review/reviewers.yml'), 'utf8'), { code: 'ENOENT' });
});

test('定时命令在确认期间被中央结束时收敛本地记录且不启动', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-scheduled-ack-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    const command = commandFor('expired-at-ack');
    const project = { projectId, nodeId, workspaceId, name: '项目 A', bindingGeneration: 1, projectConfigRevision: 1, vcsType: 'git', target: 'main', enabled: true };
    const result = { outcome: { status: 'ABORTED', reason: 'SCHEDULE_EXPIRED' }, delivery: { state: 'not_required' } };
    const requests = new Map();
    let executions = 0;
    const node = new ManagedNode({
        config: { centerUrl: 'http://127.0.0.1/', nodeId, token: 'fake',
            workspaces: [{ workspaceId, label: '项目 A', vcsType: 'git', target: 'main', supportsScheduledAudit: true }] },
        journal,
        execute: async () => { executions++; return result; },
        read: async () => { throw new Error('不应读取详情'); },
        fetch: async (url, request) => {
            const pathname = new URL(url).pathname;
            requests.set(pathname, JSON.parse(request.body));
            if (pathname.endsWith('/commands/poll')) return Response.json({ commands: [command], projects: [project], cancellations: [], queries: [], recoveries: [] });
            if (pathname.endsWith('/ack')) return Response.json({ command: { ...command, state: 'completed', cancelRequested: false, updatedAt: command.createdAt, result } });
            if (pathname.endsWith('/events')) return Response.json({ acks: {} });
            return Response.json({});
        },
    });
    t.after(async () => { await node.stop(); journal.close(); await rm(directory, { recursive: true, force: true }); });
    await node.tick();
    await node.drain();
    assert.equal(executions, 0);
    assert.equal(journal.get(command.commandId).phase, 'completed');
    assert.deepEqual(journal.get(command.commandId).result, result);
    assert.deepEqual(journal.pending(), []);
    assert.deepEqual(requests.get('/node-api/v1/commands/poll').scheduledAuditWorkspaces, [workspaceId]);
    assert.equal(requests.get('/node-api/v1/register').workspaces[0].supportsScheduledAudit, undefined);
});
