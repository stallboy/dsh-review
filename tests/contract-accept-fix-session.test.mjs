import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { buildCommitDetails, buildCommitSubject, composeCommitMessage, normalizeCommitDetail } from '../packages/dsh-plugin/dist/host/commit-message.js';
import { buildModeBPrompt } from '../packages/dsh-plugin/dist/host/runner.js';
import { createDshFixSession } from '../packages/dsh-plugin/dist/index.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, commentFixture, guardFixture, patchFixture, sha256Hex } from './fixtures/contract.mjs';

function canRun(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

const hasSvn = canRun('svn') && canRun('svnadmin');

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startApi(root, settingsPatch = {}, depsPatch = {}) {
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'dcr-state-')), 'runtime-state.json');
  const settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'manual',
    syncBeforeApprove: false,
    ...settingsPatch,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath, ...depsPatch });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { api, base: `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}` };
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitJob(base, jobId, attempts = 400) {
  let job;
  for (let index = 0; index < attempts; index += 1) {
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return job;
}

async function approveAndWait(base, payload) {
  const response = await post(base, '/approve', { optionId: 'opt-a', patchId: 1, ...payload });
  const body = await response.json();
  if (response.status !== 202) return { httpStatus: response.status, body };
  return { httpStatus: 202, job: await waitJob(base, body.jobId) };
}

const PATCH_SHA = sha256Hex(patchFixture());

async function candidateFixture(root, slug, { review = {}, comments = [] } = {}) {
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  return commitCandidate(root, slug, {
    review: {
      baseRevision: base,
      bodyLines: ['# 需人工判断项', '', '- 无'],
      ...(comments.length > 0 ? { comments: commentFixture(comments) } : {}),
      ...review,
    },
  });
}

const fixReq = (id) => ({ ...guardFixture(id), optionId: 'opt-a', patchId: 1 });

test('§5.4：POST /fix-session 在独立 DSH 会话中投递 Mode B 提案修订提示词（不创建审查租约）', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-session', {
    comments: [{ id: 'c1', content: '请修正运算方向' }],
  });
  const calls = [];
  const { api, base } = await startApi(root, {}, {
    createFixSession: async (input) => {
      calls.push(input);
      return { sessionId: 'sess-fix-1' };
    },
  });
  const response = await post(base, '/fix-session?sessionId=owner-sess', fixReq(candidate.id));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.equal(body.sessionId, 'sess-fix-1');
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.optionId, 'opt-a');
  assert.equal(body.patchId, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].ownerSessionId, 'owner-sess');
  assert.match(calls[0].title, /20261112-fix-session/);
  assert.match(body.prompt, /20261112-fix-session/);
  assert.match(body.prompt, /请修正运算方向/);
  assert.ok(calls[0].prompt === body.prompt, '投递的提示词必须与响应中一致');
  assert.equal(api.auditLifecycle.blockingLeaseFor(root), undefined);
});

test('§5.4：/fix-session 拒绝已归档候选、无未解决评论、缺 guard 与脏工作区', async () => {
  const root = await createGitFixture();
  const owned = await candidateFixture(root, '20261112-fix-guard', { comments: [{ id: 'c1' }] });
  const archived = await candidateFixture(root, '20261112-fix-archived', {
    review: {
      status: 'approved',
      repairAttempts: '\n  - id: 1\n    option_id: opt-a\n    patch_id: 1\n    base_revision: "1"\n    actor: tester\n    at: "2026-11-01T11:00:00+08:00"\n    apply_mode: program_strict\n    result: applied\n    restored: false\n    evidence: "ok"',
      approval: `\n  approved_by: tester\n  approved_at: "2026-11-01T11:00:00+08:00"\n  record_revision: 1\n  option_id: opt-a\n  patch_id: 1\n  patch_sha256: "${PATCH_SHA}"\n  repair_attempt_id: 1\n  base_revision: "1"\n  gate_checks: ["node --version"]\n  gate_results: [{command: "node --version", exit_code: 0, duration_ms: 10}]\n  confirmed_decisions: []\n  waived_decisions: []`,
      comments: commentFixture([{ id: 'c1' }]),
    },
  });
  const quiet = await candidateFixture(root, '20261112-fix-quiet', { review: { status: 'pending' } });
  const { base } = await startApi(root, {}, { createFixSession: async () => ({ sessionId: 'sess-x' }) });

  assert.equal((await post(base, '/fix-session', fixReq(archived.id))).status, 409);

  const quietResponse = await post(base, '/fix-session', fixReq(quiet.id));
  assert.equal(quietResponse.status, 409);
  assert.match((await quietResponse.json()).error.message, /未解决评论/);

  assert.equal((await post(base, '/fix-session', {})).status, 400);

  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a - b; // dirty\n', 'utf8');
  const dirty = await post(base, '/fix-session', fixReq(owned.id));
  assert.equal(dirty.status, 409);
  assert.match((await dirty.json()).error.message, /干净/);
});

test('§5.4：Host 未挂载 sessionController 时 /fix-session 返回 501', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-nosession', { comments: [{ id: 'c1' }] });
  const { base } = await startApi(root);
  const response = await post(base, '/fix-session', fixReq(candidate.id));
  assert.equal(response.status, 501);
});

test('§5.4：/fix-prompt?mode=session 与 /fix-session 投递同一份提示词；缺省为 headless 口径', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-prompt', {
    comments: [{ id: 'c1', content: '补充边界测试' }],
  });
  const calls = [];
  const { base } = await startApi(root, {}, {
    createFixSession: async (input) => { calls.push(input); return { sessionId: 'sess-p' }; },
  });
  const session = await post(base, '/fix-session', fixReq(candidate.id)).then((response) => response.json());
  const exported = await (await fetch(`${base}/fix-prompt?id=${encodeURIComponent(candidate.id)}&optionId=opt-a&patchId=1&mode=session`)).json();
  assert.equal(exported.prompt, session.prompt, '导出提示词必须与实际投递的一致');
  assert.equal(calls[0].prompt, exported.prompt);
  assert.equal(exported.mode, 'session');

  const headless = await (await fetch(`${base}/fix-prompt?id=${encodeURIComponent(candidate.id)}&optionId=opt-a&patchId=1`)).json();
  assert.equal(headless.mode, 'headless');
  assert.match(headless.prompt, /补充边界测试/);
  assert.notEqual(headless.prompt, exported.prompt);
});

test('§5.4：/fix-session 与运行中的审查租约互斥（workspace-txn）', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-mutex', { comments: [{ id: 'c1' }] });
  const calls = [];
  const { api, base } = await startApi(root, {}, {
    createFixSession: async () => { calls.push(1); return { sessionId: 'sess-m' }; },
  });
  await api.auditLifecycle.create({
    auditId: '20261112-000000-repo', root, targetPath: '', trigger: 'manual', baseRevision: 'x',
    owner: 'tester', createdAt: new Date().toISOString(), candidateIdsBefore: [], state: 'active',
  });
  const response = await post(base, '/fix-session', fixReq(candidate.id));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /审查租约/);
  assert.equal(calls.length, 0, '互斥拒绝时不得创建会话');
});

test('§5.4：createDshFixSession 走 sessionController 序列并继承发起会话的权限/审批策略', async () => {
  const created = [];
  const prompts = [];
  const renames = [];
  const policySets = [];
  const host = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async (request) => { created.push(request); return { sessionId: 'sess-new' }; },
          rename: async (request) => { renames.push(request); },
          prompt: async (request) => { prompts.push(request); return { accepted: true }; },
        };
      }
      if (name === 'workspaceRegistry') return { resolveByPath: async () => ({ id: 'ws-1', path: 'F:/repo' }) };
      if (name === 'sessions') {
        return {
          get: (id) => (id === 'owner-sess' ? { header: { cwd: 'F:/repo' } } : {}),
        };
      }
      if (name === 'permissionPresets') {
        return { current: () => 'danger-full-access', set: (_session, preset) => { policySets.push(preset); } };
      }
      return undefined;
    },
  };
  const result = await createDshFixSession(host, {
    cwd: 'F:/repo', title: '提案修订 · x', prompt: '# 提案修订', ownerSessionId: 'owner-sess',
  });
  assert.equal(result.sessionId, 'sess-new');
  assert.deepEqual(created, [{ workspaceId: 'ws-1' }]);
  assert.deepEqual(renames, [{ sessionId: 'sess-new', title: '提案修订 · x' }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].content[0].text, '# 提案修订');
  assert.deepEqual(policySets, ['danger-full-access'], '修复会话必须继承评审页会话的权限预设');
});

test('§5.4：buildModeBPrompt 显式绑定方案与补丁且包含不可变账本与严禁运行修复门禁约束', () => {
  const candidate = {
    id: '2026-11/demo', month: '2026-11', slug: 'demo', dirPath: '/repo/.ai-review/2026-11/demo', reviewPath: '/repo/.ai-review/2026-11/demo/review.md',
    body: '', sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '' },
    humanJudgment: [], humanJudgmentDeclared: false,
    meta: {
      schemaVersion: 1, findingId: 'demo', title: 'net: demo', module: 'net', auditType: 'bugfix', issueKind: 'repair',
      dependsOn: null, priority: 'P1', baseRevision: 'abc', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z',
      owner: 'tester', tags: [], ticket: null, status: 'changes_requested', targetFiles: ['src/math.js'], recordRevision: 2,
      patches: [{ id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: 'abc', author: 'ai', sha256: PATCH_SHA }],
      options: [{ id: 'opt-a', title: '方案 A', tradeoff: '改动小', confidence: 0.9, currentPatch: 1, gateChecks: ['node --version'] }],
      observations: [], decisions: [], repairAttempts: [],
      comments: [{ id: 'c1', revision: 1, file: '', line: 0, author: 'tester', content: '补充边界校验', status: 'unresolved', createdAt: '2026-11-01T10:05:00Z' }],
      humanDecisions: [], approval: null, approvalHistory: [], rejection: null, commitMessage: 'net: demo',
    },
  };
  const prompt = buildModeBPrompt({
    candidate,
    option: candidate.meta.options[0],
    patchEntry: candidate.meta.patches[0],
    patchText: patchFixture(),
    targetBase: 'abc',
    vcsType: 'git',
    intent: 'revise',
    mode: 'session',
  });
  assert.match(prompt, /opt-a/);
  assert.match(prompt, /002\.patch/);
  assert.match(prompt, /补充边界校验/);
  assert.match(prompt, /严禁|禁止/);
});

test('§4.5：提交信息规范单行由 Host 生成；人工补丁追加 @ patch 标记（严禁使用 record_revision）', () => {
  const base = {
    id: '2026-11/demo', month: '2026-11', slug: 'demo', dirPath: '/repo/.ai-review/2026-11/demo',
    reviewPath: '/repo/.ai-review/2026-11/demo/review.md', body: '',
    sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '' },
    humanJudgment: [], humanJudgmentDeclared: false,
  };
  const meta = (patches) => ({
    schemaVersion: 1, findingId: 'demo', title: 'net: 修复连接关闭竞态', module: 'net', auditType: 'bugfix', issueKind: 'repair',
    dependsOn: null, priority: 'P1', baseRevision: 'a1', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z',
    owner: 'tester', tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], recordRevision: 9,
    patches, options: [{ id: 'opt-a', title: 'A', tradeoff: 't', confidence: 0.9, currentPatch: patches.at(-1).id, gateChecks: ['node --version'] }],
    observations: [], decisions: [], repairAttempts: [], comments: [], humanDecisions: [], approval: null, approvalHistory: [],
    rejection: null, commitMessage: 'net: 修复连接关闭竞态',
  });
  const aiOnly = { ...base, meta: meta([{ id: 1, baseRevision: 'a1', patch: '001.patch', optionId: 'opt-a', author: 'ai', sha256: PATCH_SHA }]) };
  assert.equal(buildCommitSubject(aiOnly, 'opt-a'), 'review(2026-11/demo): net: 修复连接关闭竞态');
  const mixed = {
    ...base,
    meta: meta([
      { id: 1, baseRevision: 'a1', patch: '001.patch', optionId: 'opt-a', author: 'ai', sha256: PATCH_SHA },
      { id: 2, baseRevision: 'a1', patch: '002.patch', optionId: 'opt-a', author: 'human', sha256: PATCH_SHA },
    ]),
  };
  assert.equal(buildCommitSubject(mixed, 'opt-a'), 'review(2026-11/demo): net: 修复连接关闭竞态 @ patch 2');
  const dirtyTitle = { ...base, meta: { ...aiOnly.meta, title: 'net:   修复\n连接关闭竞态' } };
  assert.equal(composeCommitMessage(dirtyTitle, 'simple', '', 'opt-a'), 'review(2026-11/demo): net: 修复 连接关闭竞态');
});

test('§4.5：简略信息只提交单行；详细信息在单行后空行分隔追加正文', () => {
  const candidate = {
    id: '2026-11/mode', month: '2026-11', slug: 'mode', dirPath: 'd', reviewPath: 'r', body: '',
    sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '' },
    humanJudgment: [], humanJudgmentDeclared: false,
    meta: {
      schemaVersion: 1, findingId: 'mode', title: 'net: 模式', module: 'net', auditType: 'bugfix', issueKind: 'repair',
      dependsOn: null, priority: 'P1', baseRevision: 'a1', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z',
      owner: 'tester', tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], recordRevision: 1,
      patches: [{ id: 1, baseRevision: 'a1', patch: '001.patch', optionId: 'opt-a', author: 'ai', sha256: PATCH_SHA }],
      options: [{ id: 'opt-a', title: 'A', tradeoff: 't', confidence: 0.9, currentPatch: 1, gateChecks: [] }],
      observations: [], decisions: [], repairAttempts: [], comments: [], humanDecisions: [], approval: null, approvalHistory: [],
      rejection: null, commitMessage: 'net: 模式',
    },
  };
  assert.equal(composeCommitMessage(candidate, 'simple', '被忽略的正文', 'opt-a'), 'review(2026-11/mode): net: 模式');
  const detailed = composeCommitMessage(candidate, 'detailed', '作者统计：A <a@x>：3 次提交', 'opt-a');
  const lines = detailed.split('\n');
  assert.equal(lines[0], 'review(2026-11/mode): net: 模式');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '作者统计：A <a@x>：3 次提交');
  assert.equal(composeCommitMessage(candidate, 'detailed', '   ', 'opt-a'), 'review(2026-11/mode): net: 模式');
  const clamped = composeCommitMessage(candidate, 'detailed', 'x'.repeat(9000), 'opt-a');
  assert.ok(clamped.length < 6200);
  assert.match(clamped, /正文已截断/);
  assert.equal(normalizeCommitDetail('simple'), 'simple');
  assert.equal(normalizeCommitDetail('detailed'), 'detailed');
  assert.equal(normalizeCommitDetail('LONG'), undefined);
});

test('§4.5：详细正文区分历史作者统计与本次待提交，并如实标注统计不可用', async () => {
  const root = await createGitFixture();
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a - b;\n// 用户改动\n', 'utf8');
  const candidate = await candidateFixture(root, '20261112-detail-body', {
    comments: [{ id: 'c1', status: 'resolved' }],
  });
  const { api } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  const detail = await runtime.store.get(candidate.id, null);
  const stats = await runtime.vcs.authorStats(['src/math.js']);
  const body = await buildCommitDetails(detail.candidate, {
    repoRoot: root, optionId: 'opt-a', patchId: 1, authorStats: stats, patchText: detail.patchText, vcsType: 'git',
  });
  assert.match(body, /作者统计（本问题触及文件）：/);
  assert.match(body, /audit-test <audit-test@example\.com>：1 次提交/);
  assert.match(body, /本次提交：1 个业务原子提交，涉及 1 个业务文件/);
  assert.match(body, /改动摘要：1 个文件，\+1 \/ -1 行/);
  assert.match(body, /门禁（本次批准实际执行 1 条）：/);
  assert.match(body, /审核评论：共 1 条，已处理 1 条/);

  const unavailable = await buildCommitDetails(detail.candidate, {
    repoRoot: root,
    authorStats: { buckets: [], historyCommits: 0, pendingFiles: 0, diagnostic: '浅克隆', scope: 'repo' },
    patchText: detail.patchText,
    vcsType: 'git',
  });
  assert.match(unavailable, /作者统计：不可用（浅克隆）/);
});

test('§4.5：authorStats 只统计触及路径的历史提交，脏文件计入本次待提交', async () => {
  const root = await createGitFixture();
  const { api } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  const scoped = await runtime.vcs.authorStats(['src/math.js']);
  assert.equal(scoped.scope, 'tracked');
  assert.equal(scoped.pendingFiles, 1);
  assert.equal(scoped.historyCommits, 1);
  assert.equal(scoped.buckets[0].name, 'audit-test');
  const repo = await runtime.vcs.authorStats([]);
  assert.equal(repo.scope, 'repo');
  assert.ok(repo.historyCommits >= 1);
});

test('§4.5：/approve commitDetail=simple 只提交规范单行（即使候选 commit_message 是多行）', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-simple', {
    review: { commitMessage: 'net: 20261112-simple\n\nAI 写的旧正文' },
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, { ...guardFixture('2026-11/20261112-simple'), commitDetail: 'simple' });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.trim();
  assert.equal(message, 'review(2026-11/20261112-simple): net: 20261112-simple');
});

test('§4.5：/approve commitDetail=detailed 提交「单行 + 空行 + 事实正文」', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-detailed', {
    comments: [{ id: 'c1', content: '请补充说明' }],
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, { ...guardFixture('2026-11/20261112-detailed'), commitDetail: 'detailed' });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.replace(/\r\n/g, '\n').trimEnd();
  const lines = message.split('\n');
  assert.equal(lines[0], 'review(2026-11/20261112-detailed): net: 20261112-detailed');
  assert.equal(lines[1], '');
  assert.match(message, /改动摘要：1 个文件，\+1 \/ -1 行/);
  assert.match(message, /门禁（本次批准实际执行 1 条）：/);
  assert.match(message, /审核评论：共 1 条，已处理 0 条/);
});

test('§6.3：/approve commitDetail 非法取值必须 422，不得静默降级', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-bad-detail');
  const { base } = await startApi(root);
  for (const value of ['LONG', '', 1, null, true]) {
    const response = await post(base, '/approve', { ...guardFixture('2026-11/20261112-bad-detail'), optionId: 'opt-a', patchId: 1, commitDetail: value });
    assert.equal(response.status, 422, `commitDetail=${JSON.stringify(value)} 必须 422`);
  }
});

test('§4.5：未提供 commitDetail 时保持旧语义（业务提交使用候选 commit_message 全文）', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-legacy', {
    review: { commitMessage: 'net: 20261112-legacy\n\n候选自带的正文' },
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardFixture('2026-11/20261112-legacy'));
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  assert.match(runCommand('git', ['log', '-1', '--format=%B'], root).stdout, /候选自带的正文/);
});

test('§5.5（回归）：commitDetail 不放宽首行校验——commitMessage 首行 ≠ title 时仍必须中止', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-bypass');
  const { base } = await startApi(root);
  for (const commitDetail of ['simple', 'detailed']) {
    const outcome = await approveAndWait(base, {
      ...guardFixture('2026-11/20261112-bypass'),
      commitMessage: '完全不同的标题\n\n正文',
      commitDetail,
    });
    assert.equal(outcome.job.result.status, 'ABORTED', JSON.stringify(outcome.job.result));
    assert.equal(outcome.job.result.reason, 'COMMIT_MESSAGE_MISMATCH');
  }
});

test('§5.5（回归）：详细正文由锁内同一快照生成，描述的就是被提交的补丁', async () => {
  const root = await createGitFixture();
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const twoFilePatch = [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    'diff --git a/src/extra.txt b/src/extra.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/extra.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');
  await commitCandidate(root, '20261112-sync-body', {
    patchText: twoFilePatch,
    review: {
      baseRevision: baseRev,
      targetFiles: '[src/math.js, src/extra.txt]',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const { base } = await startApi(root, { syncBeforeApprove: false });
  const outcome = await approveAndWait(base, {
    ...guardFixture('2026-11/20261112-sync-body'),
    commitDetail: 'detailed',
  });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.replace(/\r\n/g, '\n');
  assert.match(message, /改动摘要：2 个文件/);
  assert.match(message, /src\/extra\.txt/);
});

test('§5.4（回归）：同一仓库并发 /fix-session 只允许一个修复会话，turn 结束后经核验释放持久化占用', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-concurrent', { comments: [{ id: 'c1' }] });
  let turnEnded;
  let created = 0;
  const { api, base } = await startApi(root, {}, {
    createFixSession: async () => {
      created += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { sessionId: `sess-${String(created)}` };
    },
    onAuditTurnEnd: (_sessionId, callback) => { turnEnded = callback; return () => undefined; },
  });
  const [first, second] = await Promise.all([
    post(base, '/fix-session', fixReq(candidate.id)),
    post(base, '/fix-session', fixReq(candidate.id)),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409]);
  assert.equal(created, 1);
  assert.equal(api.fixSessionGuard.activeFor(root)?.candidateId, candidate.id);
  turnEnded();
  // 等待异步核验释放完成
  for (let i = 0; i < 40 && api.fixSessionGuard.activeFor(root); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(api.fixSessionGuard.activeFor(root), undefined);
  const third = await post(base, '/fix-session', fixReq(candidate.id));
  assert.equal(third.status, 202);
});

test('§4.5：SVN authorStats 用 svn log --xml 聚合作者，且正文不渲染空邮箱', { skip: !hasSvn }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dcr-svn-stats-'));
  const repo = path.join(base, 'repo');
  const wc = path.join(base, 'wc');
  runCommand('svnadmin', ['create', repo], base);
  runCommand('svn', ['--non-interactive', 'checkout', `file:///${repo.replaceAll('\\', '/')}`, wc], base);
  await writeFile(path.join(wc, 'a.txt'), 'one\n', 'utf8');
  runCommand('svn', ['--non-interactive', 'add', 'a.txt'], wc);
  runCommand('svn', ['--non-interactive', 'commit', '-m', 'c1'], wc);
  await writeFile(path.join(wc, 'a.txt'), 'two\n', 'utf8');
  runCommand('svn', ['--non-interactive', 'commit', '-m', 'c2'], wc);
  await writeFile(path.join(wc, 'a.txt'), 'three\n', 'utf8');

  const vcs = createVcs('svn', wc);
  const stats = await vcs.authorStats(['a.txt']);
  assert.equal(stats.scope, 'tracked');
  assert.equal(stats.historyCommits, 2, JSON.stringify(stats));
  assert.equal(stats.pendingFiles, 1);
  assert.ok(stats.buckets.every((bucket) => bucket.email === ''));
  const text = await buildCommitDetails(
    {
      id: '2026-11/svn', month: '2026-11', slug: 'svn', dirPath: wc, reviewPath: path.join(wc, 'review.md'), body: '',
      sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '' },
      humanJudgment: [], humanJudgmentDeclared: false,
      meta: {
        schemaVersion: 1, findingId: 'svn', title: 'net: svn', module: 'net', auditType: 'bugfix', issueKind: 'repair',
        dependsOn: null, priority: 'P1', baseRevision: '1', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z',
        owner: 'tester', tags: [], ticket: null, status: 'pending', targetFiles: ['a.txt'], recordRevision: 1,
        patches: [{ id: 1, baseRevision: '1', patch: '001.patch', optionId: 'opt-a', author: 'ai', sha256: PATCH_SHA }],
        options: [{ id: 'opt-a', title: 'A', tradeoff: 't', confidence: 0.9, currentPatch: 1, gateChecks: [] }],
        observations: [], decisions: [], repairAttempts: [], comments: [], humanDecisions: [], approval: null, approvalHistory: [],
        rejection: null, commitMessage: 'net: svn',
      },
    },
    { repoRoot: wc, authorStats: stats, vcsType: 'svn' },
  );
  assert.doesNotMatch(text, /<>/);
  assert.match(text, /次revision/);
  assert.match(text, /本次提交：1 个业务 revision/);
});
