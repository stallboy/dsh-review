import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { registerAuditStageTools } from '../packages/dsh-plugin/dist/host/audit-stage-tools.js';
import { executeAuditCli } from '../packages/dsh-plugin/dist/host/audit-stage-runner.js';
import { compatibleAuditBase } from '../packages/dsh-plugin/dist/host/audit-stage-artifacts.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { runGateChecks } from '../packages/dsh-plugin/dist/host/validator.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

const fence = String.fromCharCode(96).repeat(3);
const sourceDoc = await readFile(new URL('../docs/plans/2026-11-20-dsh-multi-runner-audit-prompt-design.md', import.meta.url), 'utf8');
const [source, tests] = [...sourceDoc.matchAll(new RegExp('^' + fence + 'javascript\\r?\\n([\\s\\S]*?)\\r?\\n' + fence + '$', 'gm'))]
    .map(match => match[1].replaceAll('\r', ''));
const sourcePath = 'src/retry.cjs';
const testPath = 'tests/retry.test.cjs';
const gate = 'node --test tests/retry.test.cjs';
const secret = 'first-pass-private-7df1';
const history = 'history-private-8d20';
const navigation = line => [{ path: sourcePath, line }];
const evidence = line => [{ ...navigation(line)[0], excerpt: source.split('\n')[line - 1].trim(), reason: '实际基线原文' }];
const lead = (leadId, line) => ({
    leadId, navigation: navigation(line), entry: leadId, preconditions: ['同 ID 重试'], expectedBehavior: '最多落库一次', suspectedImpact: secret,
});

async function retryFixture(t) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'tests'));
    await mkdir(path.join(root, '.ai-review'));
    await writeFile(path.join(root, sourcePath), source + '\n');
    await writeFile(path.join(root, testPath), tests + '\n');
    await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
        'default_owner: tester', 'rules: []', 'allowed_gate_commands:', '  - ' + gate, 'verify_gate_on_audit_finalize: declared', '',
    ].join('\n'));
    await writeFile(path.join(root, '.ai-review', 'private.md'), history + '\n');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'retry baseline'], root);
    return root;
}

function fakeExecutor({ prompt, executor }) {
    if (prompt.startsWith('# 初审')) {
        assert.equal(executor, 'codex');
        return { leads: [lead('retry-job', 10), lead('retry-client', 4), lead('needs-decision', 4)], coverage: [sourcePath], limits: [] };
    }
    if (prompt.startsWith('# 独立复核')) {
        assert.equal(executor, 'claude-code');
        const client = prompt.includes('"subjectId": "lead-2"');
        const decision = prompt.includes('"subjectId": "lead-3"');
        return { verdict: client ? 'refuted' : 'confirmed', reason: '独立读取了代码',
            preconditions: ['第一次成功且同 ID 重试'], observedBehavior: client ? '客户端复用已有行' : decision ? '复用 ID 时保留旧值' : '后台任务重复写入',
            impact: '核心路径的存储行为', evidence: evidence(client || decision ? 4 : 10), limits: [] };
    }
    assert.equal(executor, 'codex');
    assert.match(prompt, /保持 API 与存储接口兼容/);
    const regression = [
        '', "test('后台同 ID 重试只写一次', () => {", '    const store = newStore();',
        '    submitFromJob(store, request);', '    submitFromJob(store, request);', '    assert.equal(store.writes.length, 1);', '});', '',
    ].join('\n');
    const insert = 'function submitFromJob(store, request) {\n    return store.insert(request.id, request.value);';
    const optional = prompt.includes('使用空值合并');
    const addition = optional ? '    return store.find(request.id) ?? store.insert(request.id, request.value);'
        : '    const existing = store.find(request.id);\n    if (existing) return existing;\n    return store.insert(request.id, request.value);';
    return { status: 'ready', summary: optional ? '查找不到现有记录时才写入' : '后台重试沿用现有记录', reason: '', edits: [
        { path: sourcePath, before: insert, after: insert.split('\n')[0] + '\n' + addition },
        { path: testPath, before: tests.split('\n').slice(-3).join('\n'), after: tests.split('\n').slice(-3).join('\n') + '\n' + regression },
    ] };
}

async function runRetryAudit(t, tamper, versioned = false) {
    const mode = process.env['DSH_AUDIT_LIVE_CLI'];
    const live = !tamper && !versioned && (mode === '1' || mode === 'codex');
    const verifier = live && mode === 'codex' ? 'codex' : 'claude-code';
    const root = await retryFixture(t);
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const requests = [];
    const stageContexts = [];
    let finishTurn;
    let gateCalls = 0;
    let generatedCandidate;
    const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', gateTimeoutMs: 10_000 };
    const api = new ReviewApi({
        settings, saveSettings: async next => next, statePath: path.join(root, '.tmp', 'audit-state.json'),
        auditStageGates: async (commands, options) => {
            const check = await runGateChecks(commands, options);
            if (tamper && ++gateCalls === 2) {
                const file = path.join(root, '.ai-review', generatedCandidate, 'review.md');
                await writeFile(file, await readFile(file, 'utf8') + '\nchanged after seal\n');
            }
            return check;
        },
        auditStageExecutor: async request => {
            stageContexts.push(request);
            return live && !request.prompt.startsWith('# 候选补丁') ? executeAuditCli(request) : fakeExecutor(request);
        },
        createAuditSession: async input => {
            requests.push(input);
            await input.onCreated('dsh-audit-retry');
            return { sessionId: 'dsh-audit-retry' };
        },
        withAuditSessionIdle: async (id, requestId, signal, finalize) => {
            assert.equal(id, 'dsh-audit-retry');
            assert.equal(requestId, requests[0].requestId);
            while (!signal.aborted) {
                await new Promise(resolve => { finishTurn = resolve; });
                if (await finalize(signal) !== false) return true;
            }
            return false;
        },
    });
    await api.init();
    const tools = new Map();
    t.after(registerAuditStageTools({ register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, api));
    const post = (pathname, body) => api.invoke({ method: 'POST', path: pathname, body });
    const invoke = async (name, args, id = 'dsh-audit-retry') => {
        const response = await tools.get(name).execute(args, { agent: { session: { id } }, signal: new AbortController().signal });
        return JSON.parse(response.json);
    };
    const stage = (name, runner, task) => invoke('runAuditStage', { stage: name, runner, task: JSON.stringify(task) });
    const { status, body } = await post('/audit/session', {
        targetPath: '', note: '兼容旧备注 {{taskJson}}', focus: ['分别看客户端和后台任务超时重试'],
        extraRequirements: ['保持 API 与存储接口兼容', '分别记录两个入口的覆盖情况', '同一请求最多写一次'],
    });
    assert.equal(status, 202, JSON.stringify(body));
    assert.match(requests[0].prompt, /兼容旧备注 \{\{taskJson\}\}/);
    assert.match(requests[0].prompt, /分别记录两个入口的覆盖情况/);
    finishTurn();
    assert.equal((await post('/audit/finalize', { auditId: body.auditId })).status, 409);
    const scanTask = { taskScope: ['src'], scenarios: ['成功写入后响应超时，以同一 ID 重试'],
        questions: ['后台任务与客户端是否各只写入一次？'], constraints: ['校验两个入口'] };
    await assert.rejects(invoke('runAuditStage', { stage: 'scan', runner: 'codex', task: JSON.stringify(scanTask) }, 'wrong-session'), /有效租约/);
    const scan = await stage('scan', 'codex', scanTask);
    const jobId = live ? scan.leads.find(item => item.navigation.some(anchor => anchor.path === sourcePath && anchor.line >= 9))?.leadId : 'retry-job';
    assert.ok(jobId, JSON.stringify(scan));
    const taskFor = (subjectId, entry, line) => ({
        subjectId, question: '同请求已写入但响应丢失时，经' + entry + '重试会写入几次？',
        navigation: navigation(line), expectedBehavior: [{ text: '同一请求最多写一次', source: '试跑样本业务规则' }],
    });
    if (!live) {
        await assert.rejects(stage('verify', 'claude-code', { ...taskFor(jobId, '后台', 9), analysis: secret }), /字段/);
        await assert.rejects(stage('patch', 'codex', { subjectId: jobId, allowedPaths: [sourcePath], acceptance: [], gateCommands: [gate] }), /复核/);
    }
    const confirm = await stage('verify', verifier, taskFor(jobId, '后台', 9));
    assert.equal(confirm.verdict, 'confirmed', JSON.stringify(confirm));
    if (!live) {
        await assert.rejects(stage('verify', 'claude-code', {
            ...taskFor('retry-client', '客户端', 3), expectedBehavior: [{ text: secret, source: '伪造来源' }],
        }), /本轮用户原文/);
        const refute = await stage('verify', 'claude-code', taskFor('retry-client', '客户端', 3));
        assert.equal(refute.verdict, 'refuted');
        await stage('verify', 'claude-code', taskFor('needs-decision', '客户端', 4));
    }
    for (const ctx of stageContexts.filter(request => request.prompt.startsWith('# 独立复核'))) {
        assert.doesNotMatch(ctx.prompt, new RegExp(secret + '|' + history + '|legacyNote|suspectedImpact|extraRequirements|ownerRouting'));
        assert.doesNotMatch(ctx.prompt, /"subjectId": "(?:retry-job|retry-client|needs-decision)"/);
        assert.match(ctx.prompt, /src\/retry\.cjs/);
        assert.match(ctx.prompt, /"line":10,"text":"    return store\.insert\(request\.id, request\.value\);"/);
        assert.match(ctx.prompt, new RegExp(base));
    }
    assert.equal(new Set(stageContexts.map(ctx => ctx.location)).size, stageContexts.length);
    const result = await stage('patch', 'codex', { subjectId: jobId, allowedPaths: [sourcePath, testPath],
        acceptance: ['后台同 ID 重试只写一次', '测试必须新增证明后台重试的用例', '保持 API 与存储接口兼容'], gateCommands: [gate] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    generatedCandidate = result.candidateId;
    const findings = [{ subjectId: jobId, title: '后台重试重复写入', priority: 'P2', kind: 'A', decision: '', dependsOn: '' }];
    if (!live) findings.push({ subjectId: 'needs-decision', title: '数据语义需要人工决定', priority: 'P0', kind: 'B', decision: '确认同 ID 不同 payload 的规则', dependsOn: '' });
    let alternative;
    if (versioned) {
        alternative = await stage('patch', 'codex', { subjectId: jobId, allowedPaths: [sourcePath, testPath],
            acceptance: ['保持 API 与存储接口兼容'], gateCommands: [gate], approach: '使用空值合并' });
        assert.equal(alternative.status, 'ready', JSON.stringify(alternative));
        for (const finding of findings) finding.repairPlan = '证据见复核。先确认边界，再变更并运行门禁验收。';
    }
    const published = await invoke('publishAuditArtifacts', {
        publication: JSON.stringify({ findings, coverage: ['客户端与后台入口'],
            requirements: ['REQ-1 API 兼容'], history: [] }),
    });
    assert.equal(published.reportPath, body.reportPath);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
    finishTurn();
    let job;
    for (let attempt = 0; attempt < 150; attempt += 1) {
        ({ body: job } = await api.invoke({ method: 'GET', path: '/jobs/' + body.jobId }));
        if (job.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (tamper) {
        assert.equal(job?.result?.status, 'RECOVERY_REQUIRED', JSON.stringify(job));
        assert.match(job.result.detail, /快照与本轮封存内容不符/);
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
        return;
    }
    assert.equal(job?.result?.status, 'COMMITTED', JSON.stringify(job));
    const report = await readFile(path.join(root, body.reportPath), 'utf8');
    assert.match(report, /插件复核/);
    assert.match(report, /declared/);
    assert.match(report, versioned ? /2 通过/ : /1 通过/);
    if (alternative) {
        assert.match(report, /schema_version: 2/);
        const { body: view } = await api.invoke({ method: 'GET', path: '/findings' });
        const grouped = view.findings.find(item => item.options?.length === 2);
        assert.deepEqual(grouped.options.map(option => option.candidateId), [result.candidateId, alternative.candidateId]);
        assert.ok(view.findings.some(item => item.repairPlan && item.options.length === 0));
    }
    if (!live) {
        assert.ok(report.indexOf('| P0 |') < report.indexOf('| P2 |'));
        assert.match(report, /retry-client：已排除/);
        assert.match(report, /target_files:\s*\n\s+- src\/retry\.cjs/);
    }
    const changed = runCommand('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], root).stdout.trim().split(/\r?\n/);
    assert.deepEqual(changed.sort(), [
        '.ai-review/' + result.candidateId + '/001.patch', '.ai-review/' + result.candidateId + '/review.md', published.reportPath,
        ...(alternative ? ['.ai-review/' + alternative.candidateId + '/001.patch', '.ai-review/' + alternative.candidateId + '/review.md'] : []),
    ].sort());
    assert.equal(await readFile(path.join(root, sourcePath), 'utf8'), source + '\n');
    assert.equal(api.leaseLookup(body.auditId).state, 'released');
}

test('DSH 阶段工具完整运行重试案例，隔离复核，按优先级排序并由 Host 收尾', { timeout: 900_000 },
    t => runRetryAudit(t, false));

test('DSH 阶段工具发布同一发现的两个独立补丁与纯文字方案', { timeout: 900_000 },
    t => runRetryAudit(t, false, true));

test('Host 门禁期间同一路径被改写时保留租约并拒绝提交', { timeout: 120_000 },
    t => runRetryAudit(t, true));

test('阶段业务基线允许仅评审元数据推进，拒绝业务文件推进', async t => {
    const root = await retryFixture(t);
    const vcs = new GitAdapter(root, 'master');
    const base = await vcs.getCurrentBase();
    await writeFile(path.join(root, '.ai-review', 'private.md'), 'review-only update\n');
    runCommand('git', ['add', '.ai-review/private.md'], root);
    runCommand('git', ['commit', '-qm', 'review-only update'], root);
    assert.equal(await compatibleAuditBase(vcs, base), true);
    await writeFile(path.join(root, sourcePath), source + '\n// new business content\n');
    runCommand('git', ['add', sourcePath], root);
    runCommand('git', ['commit', '-qm', 'business content update'], root);
    assert.equal(await compatibleAuditBase(vcs, base), false);
});
