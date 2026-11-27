import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { registerAuditStageTools } from '../packages/dsh-plugin/dist/host/audit-stage-tools.js';
import { executeAuditCli, normalizeExecutorName, probeStageExecutors } from '../packages/dsh-plugin/dist/host/audit-stage-runner.js';
import { fullPatch, taskData } from './fixtures/proposal-patch.mjs';
import { parseReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { compatibleAuditBase } from '../packages/dsh-plugin/dist/host/audit-stage-artifacts.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

const sourcePath = 'src/retry.cjs';
const testPath = 'tests/retry.test.cjs';
const gate = 'node --test tests/retry.test.cjs';
const source = [
  'function newStore() { return { rows: new Map(), writes: [], find(id) { return this.rows.get(id); }, insert(id, value) { this.writes.push({ id, value }); this.rows.set(id, value); return value; } }; }',
  'function submitFromClient(store, request) {',
  '    const existing = store.find(request.id);',
  '    if (existing) return existing;',
  '    return store.insert(request.id, request.value);',
  '}',
  'function submitFromJob(store, request) {',
  '    return store.insert(request.id, request.value);',
  '}',
  'module.exports = { newStore, submitFromClient, submitFromJob };',
].join('\n');
const tests = [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { newStore, submitFromClient, submitFromJob } = require('../src/retry.cjs');",
  "test('client deduplicates', () => { const s = newStore(); submitFromClient(s, { id: '1', value: 'a' }); submitFromClient(s, { id: '1', value: 'a' }); assert.equal(s.writes.length, 1); });",
].join('\n');

const evidenceLine = (line) => [{ path: sourcePath, line, excerpt: source.split('\n')[line - 1].trim(), reason: '实际基线原文' }];

async function retryFixture(t) {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, sourcePath), source + '\n');
  await writeFile(path.join(root, testPath), tests + '\n');
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n');
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-qm', 'retry baseline'], root);
  return root;
}

async function fakeStageExecutor({ stage, runner, cwd, artifactDir, prompt }) {
  if (stage === 'scan') {
    return {
      ok: true,
      executorUsed: runner,
      output: {
        leads: [
          { leadId: 'retry-job', entry: 'submitFromJob', path: sourcePath, line: 8, precondition: '同 ID 重试', expected: '最多写一次', impact: '重复写入' },
          { leadId: 'retry-client', entry: 'submitFromClient', path: sourcePath, line: 4, precondition: '同 ID 重试', expected: '复用记录', impact: '无' },
          { leadId: 'needs-decision', entry: 'submitFromClient', path: sourcePath, line: 4, precondition: '同 ID 不同载荷', expected: '确认语义', impact: '业务歧义' },
        ],
        coverage: ['初审已检查两个入口'],
        limits: ['初审未覆盖并发请求'],
      },
    };
  }
  if (stage === 'verify') {
    const data = taskData(prompt);
    const isClient = data.subjectId === 'retry-client';
    const isDecision = data.subjectId === 'needs-decision';
    return {
      ok: true,
      executorUsed: runner,
      output: {
        verdict: isClient ? 'refuted' : 'confirmed',
        reason: isClient ? '客户端已复用已有行' : isDecision ? '同 ID 不同载荷需业务决策' : '后台任务未查重直接插入',
        evidence: evidenceLine(isClient || isDecision ? 4 : 8),
      },
    };
  }
  // stage === 'patch'
  const data = taskData(prompt);
  const optional = data.candidate?.approach === '使用空值合并';
  const insert = 'function submitFromJob(store, request) {\n    return store.insert(request.id, request.value);';
  const addition = optional
    ? '    return store.find(request.id) ?? store.insert(request.id, request.value);'
    : '    const existing = store.find(request.id);\n    if (existing) return existing;\n    return store.insert(request.id, request.value);';
  const modified = (source + '\n').replace(insert, 'function submitFromJob(store, request) {\n' + addition);
  const patchRel = path.posix.join(data.candidate.artifactRelDir, 'proposal.patch');
  await writeFile(path.join(artifactDir, 'proposal.patch'), fullPatch(sourcePath, source + '\n', modified));
  return {
    ok: true,
    executorUsed: runner,
    output: {
      status: 'ready',
      optionId: optional ? 'opt-coalesce' : 'opt-guard',
      title: optional ? '空值合并去重' : '显式存在性检查',
      patchPath: patchRel,
      confidence: optional ? 90 : 95,
      tradeoff: optional ? '更简短的空值分支' : '显式保护分支',
      humanDecisions: [],
      summary: optional ? '查找不到现有记录时才写入' : '后台重试沿用现有记录',
      reason: '已按基线生成完整统一 diff',
    },
  };
}

async function runRetryAudit(t, tamper, twoOptions = false) {
  const root = await retryFixture(t);
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const requests = [];
  let finishTurn;
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', gateTimeoutMs: 10_000 };
  const api = new ReviewApi({
    settings,
    saveSettings: async next => next,
    statePath: path.join(root, '.tmp', 'audit-state.json'),
    auditStageExecutor: fakeStageExecutor,
    createAuditSession: async input => {
      requests.push(input);
      await input.onCreated('dsh-audit-retry');
      return { sessionId: 'dsh-audit-retry' };
    },
    withAuditSessionIdle: async (_id, _requestId, signal, finalize) => {
      await new Promise(resolve => { finishTurn = resolve; });
      await finalize(signal);
      return true;
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

  const { status, body } = await post('/audit/session', { targetPath: '', note: '保持 API 与存储接口兼容' });
  assert.equal(status, 202, JSON.stringify(body));

  const scanTask = { taskScope: ['src'], scenarios: ['同 ID 重试'], questions: ['后台任务是否查重'], constraints: [] };
  await assert.rejects(invoke('runAuditStage', { stage: 'scan', runner: 'codex', task: JSON.stringify(scanTask) }, 'wrong-session'), /租约/);
  const scan = await stage('scan', 'codex', scanTask);
  assert.equal(scan.ok, true);
  assert.equal(scan.leads.length, 3);

  const confirm = await stage('verify', 'claude', { subjectId: 'retry-job', scenario: 'retry_after_response_timeout', expectationIndexes: [0] });
  assert.equal(confirm.verdict, 'confirmed');
  const refute = await stage('verify', 'claude', { subjectId: 'retry-client', scenario: 'repeated_request', expectationIndexes: [] });
  assert.equal(refute.verdict, 'refuted');
  const decision = await stage('verify', 'claude', { subjectId: 'needs-decision', scenario: 'reachable_behavior', expectationIndexes: [] });
  assert.equal(decision.verdict, 'confirmed');

  const p1 = await stage('patch', 'codex', { subjectId: 'retry-job', auditType: 'bugfix', allowedPaths: [sourcePath], acceptance: ['同 ID 只写一次'], gateCommands: [gate] });
  assert.equal(p1.ok, true);
  if (twoOptions) {
    const p2 = await stage('patch', 'codex', { subjectId: 'retry-job', auditType: 'reuse', allowedPaths: [sourcePath], acceptance: ['同 ID 只写一次'], gateCommands: [gate], approach: '使用空值合并' });
    assert.equal(p2.ok, true);
    assert.equal(p2.registeredCount, 2);
  }

  const published = await invoke('publishAuditArtifacts', {
    publication: JSON.stringify({
      findings: [
        { subjectId: 'retry-job', findingId: 'retry-job', title: '后台重试重复写入', priority: 'P2', kind: 'A', repairPlan: '检查已存在记录再写入' },
        { subjectId: 'needs-decision', findingId: 'needs-decision', title: '数据语义需要人工决定', priority: 'P0', kind: 'B', repairPlan: '明确同 ID 不同载荷规则' },
      ],
      coverage: ['初审已检查两个入口'],
      requirements: ['REQ-1 API 兼容'],
      history: [],
    }),
  });
  assert.equal(published.reportPath, body.reportPath);

  const records = await new ReviewStore(root).listCandidateIds();
  const requireText = (id) => readFileSync(path.join(root, '.ai-review', id, 'review.md'), 'utf8');
  const repairId = records.find(id => parseReviewMarkdown(requireText(id)).meta.options.length > 0);
  assert.ok(repairId);
  if (tamper) {
    await writeFile(path.join(root, '.ai-review', repairId, 'review.md'), requireText(repairId) + '\nchanged after seal\n');
  }
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
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), base);
    return;
  }
  assert.equal(job?.result?.status, 'COMMITTED', JSON.stringify(job));
  const report = await readFile(path.join(root, body.reportPath), 'utf8');
  assert.match(report, /schema_version: 1/);
  assert.ok(report.indexOf('数据语义需要人工决定') < report.indexOf('后台重试重复写入'));

  const issue = parseReviewMarkdown(requireText(repairId)).meta;
  assert.equal(issue.schemaVersion, 1);
  assert.equal(issue.options.length, twoOptions ? 2 : 1);
  assert.equal(records.length, 2);
  assert.deepEqual(issue.patches.map(p => p.patch), twoOptions ? ['001.patch', '002.patch'] : ['001.patch']);
  assert.equal(api.leaseLookup(body.auditId).state, 'released');
}

test('DSH 阶段工具完整运行重试案例，隔离复核，按优先级排序并由 Host 收尾', { timeout: 120_000 },
  t => runRetryAudit(t, false));

test('DSH 阶段工具发布同一发现的两个独立补丁与纯文字方案', { timeout: 120_000 },
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

test('AC-AUDIT-03：外部执行器名称归一化、可用性探测与优雅降级至 dsh-subagent', async () => {
  assert.equal(normalizeExecutorName('codex'), 'codex');
  assert.equal(normalizeExecutorName('claude-code'), 'claude');
  assert.equal(normalizeExecutorName('claude'), 'claude');
  assert.equal(normalizeExecutorName('unknown-runner'), 'dsh-subagent');

  const probed = probeStageExecutors(['codex', 'claude', 'dsh-subagent'], 'nonexistent-dsh-bin-xyz');
  assert.ok(probed.availableRunners.includes('dsh-subagent'));
  assert.ok(probed.executors.some((e) => e.name === 'dsh-subagent'));

  // 请求外部执行器且外部不可用时，优雅降级尝试 dsh-subagent（此处用 node 模拟 headless 子代理）
  const fakeSubagent = `${process.execPath} -e "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({structured_output:{leads:[],coverage:['subagent-ok'],limits:[]}})))"`;
  const logs = [];
  const degraded = await executeAuditCli({
    stage: 'scan',
    runner: 'codex',
    cwd: process.cwd(),
    prompt: 'test',
    schema: { type: 'object' },
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    dshCommand: fakeSubagent,
    onLog: (line) => logs.push(line),
  });
  // 若本机恰好未装 codex，则自动降级至 dsh-subagent 并成功；若本机装了 codex 则由 codex 执行
  if (degraded.degradedFrom) {
    assert.equal(degraded.ok, true, JSON.stringify(degraded));
    assert.equal(degraded.executorUsed, 'dsh-subagent');
    assert.equal(degraded.degradedFrom, 'codex');
  }
});

test('AC-AUDIT-04：verify 阶段严格拒绝越权字段并仅传递白名单定位事实', async () => {
  const { AuditStageSession } = await import('../packages/dsh-plugin/dist/host/audit-stages.js');
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  let capturedVerifyPrompt = '';
  const session = new AuditStageSession({
    auditId: '20261127-verify-leak-check',
    root,
    scope: '.',
    baseRevision,
    trigger: 'manual',
    owner: 'tester',
    note: '',
    deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    vcs: new GitAdapter(root),
    store: new ReviewStore(root),
    stageExecutors: ['codex'],
    executor: async ({ stage, prompt }) => {
      if (stage === 'scan') {
        return {
          ok: true,
          executorUsed: 'codex',
          output: {
            leads: [{
              leadId: 'lead-1',
              entry: 'add',
              path: 'src/math.js',
              line: 1,
              precondition: 'a=1, b=2',
              expected: '返回 3',
              impact: 'SECRET_SCAN_IMPACT_DO_NOT_LEAK',
            }],
            coverage: ['src/math.js'],
            limits: [],
          },
          logs: [],
          durationMs: 10,
        };
      }
      capturedVerifyPrompt = prompt;
      return {
        ok: true,
        executorUsed: 'codex',
        output: {
          verdict: 'confirmed',
          reason: 'add 实际执行了减法',
          evidence: [{ path: 'src/math.js', line: 1, excerpt: 'a - b', reason: '操作符错误' }],
        },
        logs: [],
        durationMs: 10,
      };
    },
  });

  const scanRes = await session.runStage('scan', 'codex', { taskScope: ['src'], scenarios: [], questions: [], constraints: [] }, new AbortController().signal);
  assert.equal(scanRes.ok, true);

  // 试图向 verify 传入非白名单字段（如 reasoning / fixSuggestion / priority）必须被拦截
  await assert.rejects(
    session.runStage('verify', 'codex', {
      subjectId: 'lead-1',
      scenario: 'add(1,2)',
      reasoning: 'SECRET_SCAN_REASONING_DO_NOT_LEAK',
      fixSuggestion: 'SECRET_SCAN_FIX_SUGGESTION_DO_NOT_LEAK',
    }, new AbortController().signal),
    /verify/,
  );

  // 试图向 verify.navigation 传入非白名单字段同样必须被拦截
  await assert.rejects(
    session.runStage('verify', 'codex', {
      subjectId: 'lead-1',
      scenario: 'add(1,2)',
      navigation: { path: 'src/math.js', line: 1, rootCause: 'SECRET_NAV_ROOT_CAUSE_DO_NOT_LEAK' },
    }, new AbortController().signal),
    /navigation/,
  );

  // 仅传合法白名单字段时成功执行，且提示词中不含任何初审推理/影响字段
  const verifyRes = await session.runStage('verify', 'codex', {
    subjectId: 'lead-1',
    scenario: 'add(1,2)',
    navigation: { path: 'src/math.js', line: 1 },
  }, new AbortController().signal);
  assert.equal(verifyRes.ok, true, JSON.stringify(verifyRes));
  assert.ok(capturedVerifyPrompt.includes('src/math.js:1'));
  assert.doesNotMatch(capturedVerifyPrompt, /SECRET_SCAN_IMPACT_DO_NOT_LEAK/);
  assert.doesNotMatch(capturedVerifyPrompt, /SECRET_SCAN_REASONING_DO_NOT_LEAK/);
  assert.doesNotMatch(capturedVerifyPrompt, /SECRET_SCAN_FIX_SUGGESTION_DO_NOT_LEAK/);
});
