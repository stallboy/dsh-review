import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { registerAuditStageTools } from '../packages/dsh-plugin/dist/host/audit-stage-tools.js';
import { AuditExecutorAuthenticationError, executeAuditCli, isAuditAuthenticationFailure, resolveAuditCliLaunch } from '../packages/dsh-plugin/dist/host/audit-stage-runner.js';
import { fullPatch, taskData } from './fixtures/proposal-patch.mjs';
import { parseReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
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
const firstPassReason = 'first-pass-reason-1d72';
const firstPassFix = 'first-pass-fix-839b';
const history = 'history-private-8d20';
const navigation = line => [{ path: sourcePath, line }];
const evidence = line => [{ ...navigation(line)[0], excerpt: source.split('\n')[line - 1].trim(), reason: '实际基线原文' }];
const lead = (leadId, line) => ({
    leadId, navigation: navigation(line), entry: leadId, preconditions: [firstPassReason], expectedBehavior: firstPassFix, suspectedImpact: secret,
});

async function retryFixture(t) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'tests'));
    await mkdir(path.join(root, '.ai-review'));
    await writeFile(path.join(root, sourcePath), source + '\n');
    await writeFile(path.join(root, testPath), tests + '\n');
    await writeFile(path.join(root, 'src', 'large.txt'), ' '.repeat(33 * 1024));
    await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
        'default_owner: tester', 'rules: []', 'allowed_gate_commands:', '  - ' + gate, 'verify_gate_on_audit_finalize: declared', '',
    ].join('\n'));
    await writeFile(path.join(root, '.ai-review', 'private.md'), history + '\n');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'retry baseline'], root);
    return root;
}

async function fakeExecutor({ prompt, executor, repoRoot, onProcessTreeStopped }) {
    onProcessTreeStopped?.(true);
    if (prompt.startsWith('# 初审')) {
        assert.equal(executor, 'codex');
        return { leads: [lead('retry-job', 10), lead('retry-client', 4), lead('needs-decision', 4)], coverage: ['初审已检查两个入口'], limits: ['初审未覆盖并发请求'] };
    }
    if (prompt.startsWith('# 独立复核')) {
        assert.equal(executor, 'claude-code');
        const client = prompt.includes('"subjectId": "lead-2"');
        const decision = prompt.includes('"subjectId": "lead-3"');
        return { verdict: client ? 'refuted' : 'confirmed', reason: '独立读取了代码',
            preconditions: ['第一次成功且同 ID 重试'], observedBehavior: client ? '客户端复用已有行' : decision ? '复用 ID 时保留旧值' : '后台任务重复写入',
            impact: '核心路径的存储行为', evidence: evidence(client || decision ? 4 : 10), limits: ['复核未覆盖存储事务'] };
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
    const data = taskData(prompt);
    const patchPath = data.candidate.artifactDir + '/proposal.patch';
    const modified = (source + '\n').replace(insert, insert.split('\n')[0] + '\n' + addition);
    await writeFile(path.join(repoRoot, patchPath), fullPatch(sourcePath, source + '\n', modified)
        + fullPatch(testPath, tests + '\n', tests + '\n' + regression));
    return { status: 'ready', patchPath, confidence: optional ? 90 : 95, tradeoff: optional ? '更简短的空值分支' : '显式保护分支', humanDecisions: [],
        summary: optional ? '查找不到现有记录时才写入' : '后台重试沿用现有记录', reason: '' };
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
        auditStageGates: async () => {
            gateCalls++;
            throw new Error('审查不得执行修复后门禁');
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
    const coordinator = requests[0].prompt;
    const taskJson = JSON.parse(coordinator.split('## 本轮任务\n\n' + fence + 'json\n')[1].split('\n' + fence)[0]);
    assert.equal(Date.parse(taskJson.deadlineAt) - Date.parse(api.leaseLookup(body.auditId).createdAt), 3 * 60 * 60_000);
    assert.equal(tools.get('runAuditStage').timeoutMs, 3 * 60 * 60_000);
    assert.deepEqual(taskJson.focus, ['分别看客户端和后台任务超时重试', '兼容旧备注 {{taskJson}}']);
    assert.equal(taskJson.extraRequirements[1], '分别记录两个入口的覆盖情况');
    assert.equal(taskJson.scope, '.');
    assert.ok(!Object.hasOwn(taskJson, 'repoOutline'));
    assert.ok(!Object.hasOwn(taskJson, 'legacyNote'));
    assert.deepEqual(Object.keys(taskJson.history).sort(), ['activeCandidates', 'negativeMemory']);
    assert.deepEqual(taskJson.ownerRouting, { allowedGateCommands: [gate], automaticCandidates: true, findingWorkflow: true });
    assert.match(coordinator, /子 Harness[\s\S]*queryAuditHistory[\s\S]*publishAuditArtifacts/);
    for (const type of ['bugfix', 'delete', 'shrink', 'reuse', 'merge', 'split', 'stdlib', 'native', 'yagni']) {
        assert.ok(requests[0].prompt.includes(type), type);
    }
    finishTurn();
    assert.equal((await post('/audit/finalize', { auditId: body.auditId })).status, 409);
    const scanTask = { taskScope: ['src'], scenarios: ['成功写入后响应超时，以同一 ID 重试'],
        questions: ['后台任务与客户端是否各只写入一次？'], constraints: ['校验两个入口'] };
    await assert.rejects(invoke('runAuditStage', { stage: 'scan', runner: 'codex', task: JSON.stringify(scanTask) }, 'wrong-session'), /有效租约/);
    const scan = await stage('scan', 'codex', scanTask);
    const jobId = live ? scan.leads.find(item => item.navigation.some(anchor => anchor.path === sourcePath && anchor.line >= 9))?.leadId : 'retry-job';
    assert.ok(jobId, JSON.stringify(scan));
    const taskFor = (subjectId, scenario = 'retry_after_response_timeout') => ({
        subjectId, scenario, navigation: scan.leads.find(item => item.leadId === subjectId).navigation,
        expectationIndexes: [2],
    });
    if (!live) {
        await assert.rejects(stage('verify', 'claude-code', { ...taskFor(jobId), analysis: firstPassReason, suggestedFix: firstPassFix }), /字段/);
        await assert.rejects(stage('verify', 'claude-code', { ...taskFor(jobId), scenario: secret }), /scenario/);
        await assert.rejects(stage('verify', 'claude-code', { ...taskFor(jobId), navigation: navigation(1) }), /导航/);
        await assert.rejects(stage('patch', 'codex', { subjectId: jobId, auditType: 'bugfix', allowedPaths: [sourcePath], acceptance: [], gateCommands: [gate] }), /复核/);
    }
    const confirm = await stage('verify', verifier, taskFor(jobId));
    assert.equal(confirm.verdict, 'confirmed', JSON.stringify(confirm));
    if (!live) {
        await assert.rejects(stage('verify', 'claude-code', {
            ...taskFor('retry-client'), expectationIndexes: [99],
        }), /本轮额外要求/);
        const refute = await stage('verify', 'claude-code', taskFor('retry-client', 'repeated_request'));
        assert.equal(refute.verdict, 'refuted');
        await stage('verify', 'claude-code', taskFor('needs-decision', 'reachable_behavior'));
    }
    const verificationPrompts = stageContexts.filter(request => request.prompt.startsWith('# 独立复核')).map(({ prompt }) => prompt);
    assert.equal(verificationPrompts.length, live ? 1 : 3);
    for (const prompt of verificationPrompts) {
        for (const excluded of [
            secret, firstPassReason, firstPassFix, history, '兼容旧备注', 'suspectedImpact', 'extraRequirements', 'ownerRouting',
            '保持 API 与存储接口兼容', '分别记录两个入口的覆盖情况',
        ]) {
            assert.ok(!prompt.includes(excluded), excluded);
        }
        assert.doesNotMatch(prompt, /"subjectId": "(?:retry-job|retry-client|needs-decision)"/);
        assert.match(prompt, /同一请求最多写一次/);
        assert.match(prompt, /本轮用户附加要求/);
        assert.doesNotMatch(prompt, /固定基线只读视图|\"files\"/);
        assert.match(prompt, /Harness.*自主读取/);
        assert.match(prompt, new RegExp(base));
    }
    assert.match(taskData(verificationPrompts[0]).question, /写入成功但响应超时后.*同一请求 ID.*写入几次/);
    assert.deepEqual(taskData(verificationPrompts[0]).navigation, taskFor(jobId).navigation);
    if (!live) {
        assert.match(taskData(verificationPrompts[1]).question, /重复提交同一请求时/);
        assert.deepEqual(taskData(verificationPrompts[1]).navigation, navigation(4));
        await assert.rejects(stage('patch', 'codex', {
            subjectId: jobId, auditType: 'unknown', allowedPaths: [sourcePath], acceptance: [], gateCommands: [gate],
        }), /auditType/);
    }
    assert.equal(new Set(stageContexts.map(ctx => ctx.location)).size, stageContexts.length);
    const result = await stage('patch', 'codex', { subjectId: jobId, auditType: 'bugfix', allowedPaths: [sourcePath, testPath],
        acceptance: ['后台同 ID 重试只写一次', '测试必须新增证明后台重试的用例', '保持 API 与存储接口兼容'], gateCommands: [gate] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    generatedCandidate = result.candidateId;
    const findings = [{ repairPlan: '按独立复核的证据修复重试并添加回归验收。', subjectId: jobId, title: '后台重试重复写入', priority: 'P2', kind: 'A', decision: '', dependsOn: '' }];
    if (!live) findings.push({ subjectId: 'needs-decision', title: '数据语义需要人工决定', priority: 'P0', kind: 'B', repairPlan: '明确同 ID 不同 payload 的规则及取舍，再由执行人修改。', decision: '确认同 ID 不同 payload 的规则', dependsOn: '' });
    let alternative;
    if (versioned) {
        alternative = await stage('patch', 'codex', { subjectId: jobId, auditType: 'reuse', allowedPaths: [sourcePath, testPath],
            acceptance: ['保持 API 与存储接口兼容'], gateCommands: [gate], approach: '使用空值合并' });
        assert.equal(alternative.status, 'ready', JSON.stringify(alternative));
        for (const finding of findings) finding.repairPlan = '证据见复核。先确认边界，再变更并运行门禁验收。';
    }
    const published = await invoke('publishAuditArtifacts', {
        publication: JSON.stringify({ findings, coverage: [],
            requirements: ['REQ-1 API 兼容'], history: [] }),
    });
    assert.equal(published.reportPath, body.reportPath);
    const records = await new (await import('../packages/dsh-plugin/dist/host/store.js')).ReviewStore(root).listCandidateIds();
    const repairId = records.find(id => parseReviewMarkdown(requireText(id)).meta.issue.options.length > 0);
    function requireText(id) { return readFileSync(path.join(root, '.ai-review', id, 'review.md'), 'utf8'); }
    generatedCandidate = repairId;
    if (tamper) await writeFile(path.join(root, '.ai-review', repairId, 'review.md'), requireText(repairId) + '\nchanged after seal\n');
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
        assert.match(job.result.detail, /发生变化|清单|封存/);
        assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
        return;
    }
    assert.equal(job?.result?.status, 'COMMITTED', JSON.stringify(job));
    const report = await readFile(path.join(root, body.reportPath), 'utf8');
    assert.match(report, /schema_version: 3/);
    assert.match(report, /问题索引/);
    assert.doesNotMatch(report, /门禁.*通过|未进入基线视图/);
    assert.equal(gateCalls, 0, '审查阶段不得调用修复门禁');
    const issue = parseReviewMarkdown(requireText(repairId)).meta;
    assert.equal(issue.schemaVersion, 3);
    assert.equal(issue.issue.options.length, alternative ? 2 : 1);
    assert.equal(records.length, live ? 1 : 2, '每个问题一份记录，文字方案也有记录');
    assert.equal(new Set(issue.issue.options.map(option => option.id)).size, alternative ? 2 : 1);
    assert.deepEqual(issue.revisions.map(revision => revision.patch), alternative ? ['001.patch', '002.patch'] : ['001.patch']);
    if (alternative) {
        const { body: view } = await api.invoke({ method: 'GET', path: '/findings' });
        const grouped = view.findings.find(item => item.options?.length === 2);
        assert.deepEqual(grouped.options.map(option => option.candidateId), [repairId, repairId]);
        assert.deepEqual(grouped.options.map(option => option.patchId), [1, 2]);
        assert.ok(view.findings.some(item => item.reviewId && item.options.length === 0));
    }
    if (!live) {
        assert.ok(report.indexOf('数据语义需要人工决定') < report.indexOf('后台重试重复写入'));
        assert.match(report, /retry-client/);
        assert.match(report, /初审已检查两个入口/);
        assert.match(report, /初审未覆盖并发请求/);
        assert.match(report, /复核未覆盖存储事务/);
        assert.ok(stageContexts.every(ctx => ctx.repoRoot === root));
        assert.ok(stageContexts.every(ctx => !ctx.prompt.includes(' '.repeat(1000))));
    }
    const changed = runCommand('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], root).stdout.trim().split(/\r?\n/);
    assert.ok(changed.includes(published.reportPath));
    assert.ok(records.every(id => changed.includes('.ai-review/' + id + '/review.md')));
    assert.ok(changed.every(file => file.startsWith('.ai-review/')));
    assert.equal(await readFile(path.join(root, sourcePath), 'utf8'), source + '\n');
    assert.equal(api.leaseLookup(body.auditId).state, 'released');
}

test('DSH 阶段工具完整运行重试案例，隔离复核，按优先级排序并由 Host 收尾', { timeout: 900_000 },
    t => runRetryAudit(t, false));

test('DSH 阶段工具发布同一发现的两个独立补丁与纯文字方案', { timeout: 900_000 },
    t => runRetryAudit(t, false, true));

test('封存后同一路径被改写时保留租约并拒绝提交', { timeout: 120_000 },
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

test('执行器提前退出、取消或超时时，输入管道错误不会终止宿主', () => {
    const shell = new URL('../packages/dsh-plugin/dist/host/shell.js', import.meta.url).href;
    const script = [
        "import { runProcess } from " + JSON.stringify(shell),
        "const options = { cwd: process.cwd(), input: 'x'.repeat(1024 * 1024) };",
        "const run = (program, extra) => runProcess(process.execPath, ['-e', program], { ...options, ...extra });",
        "const exit = await run('process.exit(17)', { timeoutMs: 5000 });",
        "const timeout = await run('setInterval(() => {}, 1000)', { timeoutMs: 100 });",
        "const abort = await run('setInterval(() => {}, 1000)', { signal: AbortSignal.timeout(100) });",
        "const missing = await runProcess('dsh-test-missing-executable', [], options);",
        "console.log(JSON.stringify({ exit, timeout, abort, missing }));",
    ].join('\n');
    const host = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(host.status, 0, host.stderr || String(host.error));
    const { exit, timeout, abort, missing } = JSON.parse(host.stdout);
    assert.equal(exit.code, 17);
    assert.match(exit.stdinError, /^(EOF|EPIPE|ECONNRESET|ECANCELED|ERR_STREAM_DESTROYED)$/);
    assert.equal(timeout.timedOut, true);
    assert.equal(abort.aborted, true);
    assert.match(missing.error, /ENOENT/);
});

test('认证失败只派发一次，复核证据不足可以通过阶段工具发布空报告', async t => {
    const root = await retryFixture(t);
    const sessionId = 'dsh-audit-executor-failure';
    const executions = [];
    let finishTurn;
    const turn = new Promise(resolve => { finishTurn = resolve; });
    const api = new ReviewApi({
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
        saveSettings: async next => next,
        statePath: path.join(root, '.tmp', 'audit-state.json'),
        createAuditSession: async input => {
            await input.onCreated(sessionId);
            return { sessionId };
        },
        withAuditSessionIdle: async (_id, _requestId, signal, finalize) => {
            await turn;
            return await finalize(signal) !== false;
        },
        auditStageExecutor: async request => {
            executions.push([request.executor, request.location]);
            request.onProcessTreeStopped(true);
            if (request.executor === 'claude-code') throw new AuditExecutorAuthenticationError('claude-code');
            if (request.prompt.startsWith('# 初审')) {
                return { leads: [lead('first', 4), lead('second', 10)], coverage: [], limits: [] };
            }
            return { verdict: 'insufficient_evidence', reason: '基线视图缺少调用链',
                preconditions: [], observedBehavior: '', impact: '', evidence: [], limits: [] };
        },
    });
    await api.init();
    const tools = new Map();
    t.after(registerAuditStageTools({ register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, api));
    const post = (pathname, body) => api.invoke({ method: 'POST', path: pathname, body });
    const invoke = (name, args) => tools.get(name).execute(args, { agent: { session: { id: sessionId } }, signal: new AbortController().signal });
    const stage = (name, runner, task) => invoke('runAuditStage', { stage: name, runner, task: JSON.stringify(task) });
    const { status, body } = await post('/audit/session', { targetPath: '' });
    assert.equal(status, 202, JSON.stringify(body));
    await stage('scan', 'codex', { taskScope: ['src'], scenarios: [], questions: [], constraints: [] });
    const verify = (runner, id, line) => stage('verify', runner, {
        subjectId: id, scenario: 'reachable_behavior', navigation: navigation(line), expectationIndexes: [],
    });
    await assert.rejects(verify('claude-code', 'first', 4), /认证失败/);
    await assert.rejects(verify('claude-code', 'second', 10), /本轮.*停止派发/);
    await verify('codex', 'first', 4);
    await verify('codex', 'second', 10);
    assert.deepEqual(executions.map(([runner]) => runner), ['codex', 'claude-code', 'codex', 'codex']);
    assert.equal(new Set(executions.map(([, directory]) => directory)).size, executions.length);
    const publish = findings => invoke('publishAuditArtifacts', {
        publication: JSON.stringify({ findings, coverage: [], requirements: [], history: [] }),
    });
    await assert.rejects(publish([{ subjectId: 'first', title: '未核实', kind: 'B', priority: 'P2', decision: '复核', dependsOn: '' }]),
        /first.*insufficient_evidence/);
    const publication = JSON.parse((await publish([])).json);
    assert.deepEqual(publication.overview, []);
    finishTurn();
    const job = api.jobManager.get(body.jobId);
    for (let attempt = 0; attempt < 150 && job.status === 'running'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job));
    assert.deepEqual(job.result.created, []);
    assert.equal(api.leaseLookup(body.auditId).state, 'released');
    const report = await readFile(path.join(root, publication.reportPath), 'utf8');
    assert.match(report, /first：证据不足/);
    assert.match(report, /覆盖与限制/);
    const jobLog = job.log.join('\n');
    assert.match(jobLog, /verify-2 claude-code.*认证失败/);
    assert.match(jobLog, /已封存.*0 个正式发现/);
});

test('审查执行器从节点持久配置加载绝对路径和指定的 Claude 认证', async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'audit-executor-config-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const keys = ['DSH_HOME', 'DSH_AUDIT_CODEX', 'DSH_AUDIT_CLAUDE', 'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
        'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'ANTHROPIC_PROFILE',
        'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
        'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'];
    const originalEnv = keys.map(key => [key, process.env[key]]);
    t.after(() => {
        for (const [key, value] of originalEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    for (const key of keys) delete process.env[key];
    process.env.DSH_HOME = home;
    assert.equal((await resolveAuditCliLaunch('codex')).exe, process.platform === 'win32' ? 'codex.exe' : 'codex');

    const codexPath = path.join(home, 'Codex Tools', 'codex');
    const claudeSettingsPath = path.join(home, 'claude-settings.json');
    const settingsDir = path.join(home, 'dsh-code-review');
    const settingsFile = path.join(settingsDir, 'audit-executors.json');
    await mkdir(settingsDir);
    await writeFile(settingsFile, JSON.stringify({ codexPath, claudeSettingsPath }));
    await writeFile(claudeSettingsPath, JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 'fixture-auth', ANTHROPIC_BASE_URL: 'https://example.test',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model', PATH: 'ignored', NODE_OPTIONS: 'ignored' },
        hooks: { ignored: true },
    }));
    assert.deepEqual(await resolveAuditCliLaunch('codex'), { exe: codexPath, env: {} });
    const claude = await resolveAuditCliLaunch('claude-code');
    assert.deepEqual(claude.env, {
        ANTHROPIC_AUTH_TOKEN: 'fixture-auth',
        ANTHROPIC_BASE_URL: 'https://example.test',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model',
    });
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
    process.env.DSH_AUDIT_CODEX = 'override-codex';
    assert.equal((await resolveAuditCliLaunch('codex')).exe, 'override-codex');
    for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
        'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST']) {
        process.env[key] = 'explicit-launch-value';
        assert.deepEqual((await resolveAuditCliLaunch('claude-code')).env, {}, key);
        delete process.env[key];
    }
    await assert.rejects(resolveAuditCliLaunch('claude-code', AbortSignal.abort()), { name: 'AbortError' });
    await writeFile(claudeSettingsPath, '{ rejected-secret');
    await assert.rejects(resolveAuditCliLaunch('claude-code'), { message: '无法读取配置的 Claude Code 用户设置' });
});

test('认证熔断依据执行器错误事件，忽略模型结果中提到的认证字样', () => {
    const claude = (error, result) => JSON.stringify({ type: 'result', is_error: error, result });
    assert.equal(isAuditAuthenticationFailure('claude-code', claude(true, 'Not logged in · Please run /login'), ''), true);
    assert.equal(isAuditAuthenticationFailure('claude-code', claude(false, 'Not logged in'), ''), false);
    const codex = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Unauthorized when the app session expires' } });
    const timeout = JSON.stringify({ type: 'turn.failed', error: { message: 'Request timeout' } });
    const unauthorized = JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
    assert.equal(isAuditAuthenticationFailure('codex', codex + '\n' + timeout, 'request timed out'), false);
    assert.equal(isAuditAuthenticationFailure('codex', unauthorized, ''), true);
});
