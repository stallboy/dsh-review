import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AuditArchive, parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedNode } from '../packages/dsh-plugin/dist/managed/managed-node.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, reportOnlyAgentPath, runCommand } from './helpers.mjs';
import { patchFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';
import { bindProject, setupCentral } from './central-helpers.mjs';

const workspaceId = 'workspace-a';
const projectId = 'project-a';
const nodeId = 'node-a';
const phasedRunner = fileURLToPath(new URL('./fixtures/phased-audit-agent.mjs', import.meta.url));

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

async function setup(t, runner = 'external', runnerArg = '', auditSessions, runnerPath = reportOnlyAgentPath()) {
    const root = await createGitFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'central-scheduled-node-'));
    const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
    runCommand('git', ['commit', '-qm', 'init reviewers'], root);
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

test('中央定时 Runner 与手动审查共用同一阶段通道并交付纯索引 schema1 报告', async t => {
    const capabilities = {
        auditStageExecutor: async ({ runner }) => ({
            ok: true,
            executorUsed: runner,
            output: { leads: [], coverage: ['中央定时共享阶段'], limits: [] },
        }),
    };
    const { execute, root, writer, remote, target } = await setup(t, 'external', 'empty check-scheduled-note', capabilities, phasedRunner);
    const previousId = '20261117-090000-repo';
    const base = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();
    await new AuditArchive(writer).writeAudit({
        schemaVersion: 1, auditId: previousId, createdAt: '2026-11-17T09:00:00Z',
        baseRevision: base, scope: '.', trigger: 'manual', previousAudit: null, issues: [],
    }, '# 上轮报告\n');
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
    const report = runCommand('git', ['show', 'refs/heads/' + target + ':' + result.outcome.report.path], remote).stdout;
    const parsed = parseAuditMarkdown(report);
    assert.equal(parsed.meta.schemaVersion, 1);
    assert.equal(parsed.meta.trigger, 'scheduled');
    assert.equal(parsed.meta.previousAudit, previousId);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), result.delivery.commitRevision);
});

for (const scheduled of [false, true]) {
    test(`中央${scheduled ? '定时' : '后台手动'} Runner 取消后安全中止并保持工作区干净`, { timeout: 35_000 }, async t => {
        const capabilities = { auditStageExecutor: async () => { throw new Error('此用例在派发阶段之前取消'); } };
        const { operations, project, journal, root } = await setup(t, 'external', 'cancel-before-publication', capabilities, phasedRunner);
        const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
        const command = commandFor('phased-cancel', scheduled);
        const controller = new AbortController();
        journal.accept(command);
        const result = await operations.execute(command, controller.signal, message => {
            if (message.includes('Runner 已开始等待取消')) controller.abort();
        }, project);
        assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
        assert.equal(result.delivery.state, 'not_required');
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
        assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
    });
}

test('D10：托管定时审查经真实轮询同步上游并走统一流水线，不额外复查 approved 问题', async t => {
    const { writer, remote, target, operations, journal } = await setup(t, 'external', '', undefined, reportOnlyAgentPath());
    const original = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();
    const sha = sha256Hex(patchFixture());
    await writeCandidate(writer, 'approved-last-round', {
        review: {
            findingId: 'approved-last-round',
            baseRevision: JSON.stringify(original),
            status: 'approved',
            repairAttempts: `[{id: 1, option_id: opt-a, patch_id: 1, base_revision: ${JSON.stringify(original)}, actor: tester, at: "2026-11-01T11:00:00Z", apply_mode: program_strict, result: applied, restored: false, evidence: "ok"}]`,
            approval: `{option_id: opt-a, patch_id: 1, record_revision: 1, repair_attempt_id: 1, base_revision: ${JSON.stringify(original)}, patch_sha256: "${sha}", approved_by: tester, approved_at: "2026-11-01T11:00:00Z", gate_checks: ["node --version"], gate_results: [{command: "node --version", exit_code: 0, duration_ms: 10}], confirmed_decisions: [], waived_decisions: []}`,
        },
    });
    await new AuditArchive(writer).writeAudit({
        schemaVersion: 1, auditId: '20261117-090000-repo', createdAt: '2026-11-17T09:00:00Z',
        baseRevision: original, scope: '.', trigger: 'manual', previousAudit: null, issues: ['2026-11/approved-last-round'],
    }, '# 既有共享审查档案\n');
    await writeFile(path.join(writer, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
    runCommand('git', ['add', '-A'], writer);
    runCommand('git', ['commit', '-qm', '上游更新与历史归档'], writer);
    runCommand('git', ['push', '-q', 'origin', target], writer);
    const upstream = runCommand('git', ['rev-parse', 'HEAD'], writer).stdout.trim();

    let now = new Date('2026-11-18T07:59:00Z');
    const clock = () => now;
    const { app, headers } = await setupCentral(t, { clock });
    const credential = app.database.createNode('定时审查节点');
    const centerUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = new ManagedNode({
        workspaceIssues: () => operations.workspaceIssues(),
        config: { centerUrl, ...credential, workspaces: operations.registrations() }, journal, clock,
        execute: operations.execute.bind(operations), read: operations.read.bind(operations),
        snapshot: operations.snapshot.bind(operations),
    });
    t.after(() => node.stop());
    await node.tick();
    const project = await bindProject(app, headers, { ...credential, workspaceId });
    const schedule = await app.inject({
        method: 'POST', url: `/api/v1/projects/${project.projectId}/audit-plans`, headers,
        payload: {
            name: '接口兼容性巡检', enabled: true, startTime: '08:00', timeZone: 'UTC',
            recurrence: { kind: 'weekly', weekdays: [3] }, note: '重点检查新增接口的兼容行为',
        },
    });
    assert.equal(schedule.statusCode, 201, schedule.body);
    await node.tick();
    await node.drain();
    now = new Date('2026-11-18T08:05:00Z');
    await node.tick();
    await node.drain();
    await node.tick();

    const tasks = await app.inject({ url: `/api/v1/tasks?projectId=${project.projectId}`, headers });
    const [task] = tasks.json().tasks;
    assert.ok(task, tasks.body);
    assert.equal(task.state, 'completed', JSON.stringify(task));
    assert.equal(task.result.outcome.status, 'COMMITTED', JSON.stringify(task.result));
    assert.equal(task.result.delivery.state, 'delivered');
    const committed = runCommand('git', ['show', `refs/heads/${target}:${task.result.outcome.report.path}`], remote).stdout;
    const record = parseAuditMarkdown(committed);
    assert.equal(record.meta.schemaVersion, 1);
    assert.equal(record.meta.trigger, 'scheduled');
    assert.equal(record.meta.baseRevision, upstream);
    assert.equal(record.meta.previousAudit, '20261117-090000-repo');
    assert.deepEqual(record.meta.issues, []);
});

test('托管手动审查保持 manual，手动 Runner 不申报定时能力', async t => {
    const manual = await setup(t, 'manual');
    assert.equal(manual.operations.registrations()[0].supportsScheduledAudit, undefined);
    const result = await manual.execute(commandFor('scheduled-unavailable'));
    assert.equal(result.outcome.status, 'ABORTED');
    const external = await setup(t);
    assert.equal(external.operations.registrations()[0].supportsScheduledAudit, true);
    const committed = await external.execute(commandFor('user-review', false));
    assert.equal(committed.outcome.status, 'COMMITTED', JSON.stringify(committed));
    const text = runCommand('git', ['show', `HEAD:${committed.outcome.report.path}`], external.root).stdout;
    assert.equal(parseAuditMarkdown(text).meta.trigger, 'manual');
});

test('工作副本有未提交的评审配置时跳过定时审查并保留草稿', async t => {
    const { root, execute } = await setup(t);
    const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const reviewers = path.join(root, '.ai-review', 'reviewers.yml');
    await writeFile(reviewers, 'default_owner: 草稿负责人\n');
    const result = await execute(commandFor('skip-local-reviewers'));
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'SCHEDULE_WORKSPACE_DIRTY');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
    assert.equal(await readFile(reviewers, 'utf8'), 'default_owner: 草稿负责人\n');
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
        config: {
            centerUrl: 'http://127.0.0.1/', nodeId, token: 'fake',
            workspaces: [{ workspaceId, label: '项目 A', vcsType: 'git', target: 'main', supportsScheduledAudit: true }],
        },
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
