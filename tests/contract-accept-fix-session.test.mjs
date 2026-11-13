import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { buildCommitDetails, buildCommitSubject, composeCommitMessage, normalizeCommitDetail } from '../dist/commit-message.js';
import { buildSessionFixPrompt, toSessionFixPrompt } from '../dist/runner.js';
import { createDshFixSession } from '../dist/index.js';
import { createVcs } from '../dist/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, commentFixture, guardFixture } from './fixtures/contract.mjs';

function canRun(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

const hasSvn = canRun('svn') && canRun('svnadmin');

/**
 * 2026-11-12 三项需求的契约测试：
 * 1) §7.4：接受（提交并让 AI 修复）可在新 DSH 会话中执行，并保留导出提示词路径；
 * 2) §5.6/§10.2：提交信息可选「简略 / 详细」（单行综述 + 空行 + 事实正文）；
 * 3) §10.2：面板移除「上传人工补丁 / 超时归档 / 从重开来源恢复」，但端点语义不变。
 */

const servers = [];
const apis = [];
after(async () => {
  for (const api of apis) api.stopScheduler();
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
  apis.push(api);
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
  const response = await post(base, '/approve', payload);
  const body = await response.json();
  if (response.status !== 202) return { httpStatus: response.status, body };
  return { httpStatus: 202, job: await waitJob(base, body.jobId) };
}

/**
 * 已归档（approved）候选的完整 approval 快照：I7/I8 要求门禁与判断项快照齐全，
 * 缺任何一项都会被解析成 422，测出的就不是「已归档」这条规则了。
 * reviewFixture 把 `approval: ${overrides.approval}` 渲染成一行，因此这里用行内映射。
 */
const APPROVED_SNAPSHOT =
  '{approved_by: tester, approved_at: "2026-11-01T11:00:00+08:00", '
  + 'gate_checks: ["node --version"], '
  + 'gate_results: [{command: "node --version", exit_code: 0, duration_ms: 10}], '
  + 'confirmed_decisions: [], waived_decisions: []}';

/**
 * 候选夹具：默认带 `# 需人工判断项 / - 无`（否则会被判为「需人工判断项未填写」而无法批准），
 * 可选附带一条评论。`review` 里的同名字段覆盖默认值。
 */
async function candidateFixture(root, slug, { review = {}, comments = [] } = {}) {
  return commitCandidate(root, slug, {
    review: {
      bodyLines: ['# 需人工判断项', '', '- 无'],
      ...(comments.length > 0 ? { extraLines: ['comments:', commentFixture(comments)] } : {}),
      ...review,
    },
  });
}

// ---------------------------------------------------------------- 1) 修复执行方式

test('§7.4：POST /fix-session 在独立 DSH 会话中投递修复提示词（不创建审查租约）', async () => {
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
  const response = await post(base, '/fix-session?sessionId=owner-sess', { id: candidate.id });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.equal(body.sessionId, 'sess-fix-1');
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.revision, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].ownerSessionId, 'owner-sess');
  assert.match(calls[0].title, /AI 修复 · net: 20261112-fix-session/);
  // 提示词必须包含新会话口径与候选上下文，且不出现内部章节引用（§11 展开要求）。
  assert.match(body.prompt, /修复任务（独立会话）/);
  assert.match(body.prompt, /20261112-fix-session/);
  assert.match(body.prompt, /请修正运算方向/);
  assert.match(body.prompt, /不要执行 `git commit`/);
  assert.doesNotMatch(body.prompt, /§\s*\d/);
  assert.ok(calls[0].prompt === body.prompt, '投递的提示词必须与响应中一致');
  // 修复会话不占用审查执行租约：共享写不被阻塞。
  assert.equal(api.auditLifecycle.blockingLeaseFor(root), undefined);
});

test('§7.4/§12.2：/fix-session 拒绝已归档候选、无未解决评论与脏工作区', async () => {
  const root = await createGitFixture();
  const owned = await candidateFixture(root, '20261112-fix-guard', { comments: [{ id: 'c1' }] });
  const archived = await commitCandidate(root, '20261112-fix-archived', {
    review: {
      status: 'approved',
      approval: APPROVED_SNAPSHOT,
      extraLines: ['comments:', commentFixture([{ id: 'c1' }])],
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const quiet = await commitCandidate(root, '20261112-fix-quiet', {
    review: { status: 'pending', bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root, {}, { createFixSession: async () => ({ sessionId: 'sess-x' }) });

  const archivedResponse = await post(base, '/fix-session', { id: archived.id });
  assert.equal(archivedResponse.status, 409, JSON.stringify(await archivedResponse.clone().json()));

  const quietResponse = await post(base, '/fix-session', { id: quiet.id });
  assert.equal(quietResponse.status, 409, JSON.stringify(await quietResponse.clone().json()));
  assert.match((await quietResponse.json()).error.message, /未解决的评论/);

  const missing = await post(base, '/fix-session', {});
  assert.equal(missing.status, 400);

  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a - b; // dirty\n', 'utf8');
  const dirty = await post(base, '/fix-session', { id: owned.id });
  assert.equal(dirty.status, 409, JSON.stringify(await dirty.clone().json()));
  assert.match((await dirty.json()).error.message, /工作区干净/);
});

test('§7.4：Host 未挂载 sessionController 时 /fix-session 返回 500 且提示导出提示词', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261112-fix-nosession', {
    review: { extraLines: ['comments:', commentFixture([{ id: 'c1' }])], bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root);
  const response = await post(base, '/fix-session', { id: candidate.id });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error.message, /导出修复提示词/);
});

test('§7.4：/fix-prompt?mode=session 与 /fix-session 投递同一份提示词；缺省为 headless 口径', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-prompt', {
    comments: [{ id: 'c1', content: '补充边界测试' }],
  });
  const calls = [];
  const { base } = await startApi(root, {}, {
    createFixSession: async (input) => { calls.push(input); return { sessionId: 'sess-p' }; },
  });
  const session = await post(base, '/fix-session', { id: candidate.id }).then((response) => response.json());
  const exported = await (await fetch(`${base}/fix-prompt?id=${encodeURIComponent(candidate.id)}&mode=session`)).json();
  assert.equal(exported.prompt, session.prompt, '导出提示词必须与实际投递的一致');
  assert.equal(calls[0].prompt, exported.prompt);
  assert.equal(exported.mode, 'session');

  const headless = await (await fetch(`${base}/fix-prompt?id=${encodeURIComponent(candidate.id)}`)).json();
  assert.equal(headless.mode, 'headless');
  // headless 口径就是 buildFixPrompt 的原文（Runner 再包 stdin 信封），不含会话小节。
  assert.match(headless.prompt, /^# 任务\n请以 ADDRESS_FEEDBACK 模式执行修复/);
  assert.doesNotMatch(headless.prompt, /修复任务（独立会话）/);
  assert.match(headless.prompt, /补充边界测试/);
  assert.notEqual(headless.prompt, exported.prompt);
});

test('§7.4：/fix-session 与运行中的审查租约互斥（workspace-txn）', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-mutex', { comments: [{ id: 'c1' }] });
  const calls = [];
  const { api, base } = await startApi(root, {}, {
    createFixSession: async () => { calls.push(1); return { sessionId: 'sess-m' }; },
  });
  // 真实占用一条 active 审查租约：blockingLeaseFor(root) 必须命中。
  await api.auditLifecycle.create({
    auditId: '20261112-000000-repo', root, targetPath: '', trigger: 'manual', baseRevision: 'x',
    owner: 'tester', createdAt: new Date().toISOString(), candidateIdsBefore: [], state: 'active',
  });
  const response = await post(base, '/fix-session', { id: candidate.id });
  assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
  assert.match((await response.json()).error.message, /审查执行租约/);
  assert.equal(calls.length, 0, '互斥拒绝时不得创建会话');
});

test('§7.4：createDshFixSession 走 sessionController 序列并继承发起会话的权限/审批策略', async () => {
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
        return { current: () => 'danger-full-access', set: (session, preset) => { policySets.push(preset); } };
      }
      return undefined;
    },
  };
  const result = await createDshFixSession(host, {
    cwd: 'F:/repo', title: 'AI 修复 · x', prompt: '# 修复任务（独立会话）', ownerSessionId: 'owner-sess',
  });
  assert.equal(result.sessionId, 'sess-new');
  assert.deepEqual(created, [{ workspaceId: 'ws-1' }]);
  assert.deepEqual(renames, [{ sessionId: 'sess-new', title: 'AI 修复 · x' }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].content[0].text, '# 修复任务（独立会话）');
  assert.deepEqual(policySets, ['danger-full-access'], '修复会话必须继承评审页会话的权限预设');
});

test('§7.4：toSessionFixPrompt 只在 manual 提示词上换口径，不丢硬性约束', () => {
  const manual = [
    '# 任务',
    '请以 ADDRESS_FEEDBACK 模式执行修复，并把候选目录更新到版本 2。',
    '',
    '## 硬性要求',
    '1. 生成 002.patch，内容必须是相对当前基线 abc 的全量 diff，不得包含 .ai-review/ 自身。',
    '4. 不得执行 git commit / svn commit；完成后业务代码工作区必须还原干净。',
  ].join('\n');
  const prompt = toSessionFixPrompt(manual, '你是 AI Fixer。');
  assert.match(prompt, /请以 ADDRESS_FEEDBACK 模式在独立会话中执行修复/);
  assert.match(prompt, /生成 002\.patch/);
  assert.match(prompt, /不得执行 git commit \/ svn commit/);
  assert.match(prompt, /你是 AI Fixer。/);
  assert.match(prompt, /## 提交边界/);
  assert.equal(buildSessionFixPrompt('S', 'U'), [
    '# 修复任务（独立会话）', '', '请直接在当前仓库中执行下面的修复任务；不要只输出计划或复述指令。', '',
    '## 执行准则', '', 'S', '', '## 提交边界', '',
    '- 不要执行 `git commit` / `git push` / `svn commit`；改动 `.ai-review/` 后回到评审面板，由 Host 统一原子提交。',
    '- 只修改业务代码与当前候选目录；不得改动其他候选、历史补丁、人类评论或历史审核记录。',
    '- 完成后业务工作区必须还原干净，只保留 `.ai-review/` 下的候选产物。',
    '', '## 任务', '', 'U',
  ].join('\n'));
});

// ---------------------------------------------------------------- 2) 提交信息详略

test('§5.6：提交信息规范单行由 Host 生成；人类修订版本追加 @ rev 标记', () => {
  const base = {
    id: '2026-11/demo',
    month: '2026-11',
    slug: 'demo',
    dirPath: '/repo/.ai-review/2026-11/demo',
    reviewPath: '/repo/.ai-review/2026-11/demo/review.md',
    sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '', rawBody: '' },
    humanJudgment: [],
    humanJudgmentDeclared: false,
  };
  const meta = (revisions) => ({
    schemaVersion: 1, title: 'net: 修复连接关闭竞态', module: 'net', auditType: 'bugfix',
    createdAt: '2026-11-01T10:00:00+08:00', updatedAt: '2026-11-01T10:00:00+08:00', owner: 'tester',
    tags: [], status: 'pending', ticket: null, targetFiles: ['src/math.js'], currentRevision: revisions.at(-1).id,
    revisions, gateChecks: ['node --version'], comments: [], humanDecisions: [], approval: null, rejection: null,
    commitMessage: 'net: 修复连接关闭竞态', extra: {},
  });
  const aiOnly = { ...base, meta: meta([{ id: 1, baseRevision: 'a1', patch: '001.patch', author: 'ai' }]) };
  assert.equal(buildCommitSubject(aiOnly), 'review(2026-11/demo): net: 修复连接关闭竞态');
  const mixed = {
    ...base,
    meta: meta([
      { id: 1, baseRevision: 'a1', patch: '001.patch', author: 'ai' },
      { id: 2, baseRevision: 'a1', patch: '002.patch', author: 'human' },
    ]),
  };
  assert.equal(buildCommitSubject(mixed), 'review(2026-11/demo): net: 修复连接关闭竞态 @ rev 2');
  // 标题里的换行/连续空白必须压成单行，否则首行校验会被标题自身破坏。
  const dirtyTitle = { ...base, meta: { ...aiOnly.meta, title: 'net:   修复\n连接关闭竞态' } };
  assert.equal(composeCommitMessage(dirtyTitle, 'simple', ''), 'review(2026-11/demo): net: 修复 连接关闭竞态');
});

test('§5.6：简略信息只提交单行；详细信息在单行后空行分隔追加正文', () => {
  const candidate = {
    id: '2026-11/mode', month: '2026-11', slug: 'mode', dirPath: 'd', reviewPath: 'r',
    sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '', rawBody: '' },
    humanJudgment: [], humanJudgmentDeclared: false,
    meta: {
      schemaVersion: 1, title: 'net: 模式', module: 'net', auditType: 'bugfix',
      createdAt: '2026-11-01T10:00:00+08:00', updatedAt: '2026-11-01T10:00:00+08:00', owner: 'tester',
      tags: [], status: 'pending', ticket: null, targetFiles: ['src/math.js'], currentRevision: 1,
      revisions: [{ id: 1, baseRevision: 'a1', patch: '001.patch', author: 'ai' }],
      gateChecks: [], comments: [], humanDecisions: [], approval: null, rejection: null, commitMessage: 'net: 模式', extra: {},
    },
  };
  const simple = composeCommitMessage(candidate, 'simple', '被忽略的正文');
  assert.equal(simple, 'review(2026-11/mode): net: 模式');
  const detailed = composeCommitMessage(candidate, 'detailed', '作者统计：A <a@x>：3 次提交');
  const lines = detailed.split('\n');
  assert.equal(lines[0], 'review(2026-11/mode): net: 模式');
  assert.equal(lines[1], '', '单行综述与正文之间必须空一行');
  assert.equal(lines[2], '作者统计：A <a@x>：3 次提交');
  // 正文为空或超长时不得破坏单行 + 空行结构。
  assert.equal(composeCommitMessage(candidate, 'detailed', '   '), 'review(2026-11/mode): net: 模式');
  const clamped = composeCommitMessage(candidate, 'detailed', 'x'.repeat(9000));
  assert.ok(clamped.length < 6200, '详细正文必须限长');
  assert.match(clamped, /正文已截断/);
  assert.equal(normalizeCommitDetail('simple'), 'simple');
  assert.equal(normalizeCommitDetail('detailed'), 'detailed');
  assert.equal(normalizeCommitDetail('LONG'), undefined);
});

test('§5.6：详细正文区分历史作者统计与本次待提交，并如实标注统计不可用', async () => {
  const root = await createGitFixture();
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a - b;\n// 用户改动\n', 'utf8');
  const candidate = await commitCandidate(root, '20261112-detail-body', {
    review: { extraLines: ['comments:', commentFixture([{ id: 'c1', status: 'resolved' }])], bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { api } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  const detail = await runtime.store.get(candidate.id, null);
  const patch = await runtime.store.currentPatch(detail.candidate);
  const stats = await runtime.vcs.authorStats(['src/math.js']);
  const body = await buildCommitDetails(detail.candidate, {
    repoRoot: root, authorStats: stats, patchText: patch.text, vcsType: 'git',
  });
  assert.match(body, /作者统计（本候选触及文件）：/);
  assert.match(body, /audit-test <audit-test@example\.com>：1 次提交/);
  assert.match(body, /本次提交：1 个业务原子提交，涉及 1 个业务文件/);
  assert.match(body, /待提交，不计入上方历史统计/);
  assert.match(body, /改动摘要：1 个文件，\+1 \/ -1 行/);
  assert.match(body, /- src\/math\.js \+1 \/ -1/);
  assert.match(body, /修复方案：/);
  assert.match(body, /来源候选：/);
  assert.match(body, /audit_type|审查类型 bugfix/);
  assert.match(body, /门禁（本次批准重新执行 1 条）：/);
  assert.match(body, /审核评论：共 1 条，已处理 1 条/);

  const unavailable = await buildCommitDetails(detail.candidate, {
    repoRoot: root,
    authorStats: { buckets: [], historyCommits: 0, pendingFiles: 0, diagnostic: '浅克隆', scope: 'repo' },
    patchText: patch.text,
    vcsType: 'git',
  });
  assert.match(unavailable, /作者统计：不可用（浅克隆）/);
  const none = await buildCommitDetails(detail.candidate, { repoRoot: root, patchText: patch.text, vcsType: 'git' });
  assert.match(none, /作者统计：不可用（当前 VCS 适配器不提供作者统计）/);
  // review.md 不记录 audit_id，正文不得凭日期/范围猜测审查档案路径。
  assert.doesNotMatch(body, /audits\//);
});

test('§5.6：authorStats 只统计触及路径的历史提交，脏文件计入本次待提交', async () => {
  const root = await createGitFixture();
  const { api } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  const scoped = await runtime.vcs.authorStats(['src/math.js']);
  assert.equal(scoped.scope, 'tracked');
  assert.equal(scoped.pendingFiles, 1);
  assert.equal(scoped.historyCommits, 1);
  assert.equal(scoped.buckets[0].name, 'audit-test');
  // 空路径 = 全仓库统计。
  const repo = await runtime.vcs.authorStats([]);
  assert.equal(repo.scope, 'repo');
  assert.ok(repo.historyCommits >= 1);
});

test('§5.6/§8.3：/approve commitDetail=simple 只提交规范单行（即使候选 commit_message 是多行）', async () => {
  const root = await createGitFixture();
  await commitCandidate(root, '20261112-simple', {
    review: { commitMessage: 'net: 20261112-simple\n\nAI 写的旧正文', bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, { ...guardFixture('2026-11/20261112-simple'), commitDetail: 'simple' });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.trim();
  assert.equal(message, 'review(2026-11/20261112-simple): net: 20261112-simple');
  // review.md 仍保存候选的 commit_message（§4.9），业务提交说明由 detail 决定。
  const review = await readFile(path.join(root, '.ai-review', '2026-11', '20261112-simple', 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
});

test('§5.6/§8.3：/approve commitDetail=detailed 提交「单行 + 空行 + 事实正文」', async () => {
  const root = await createGitFixture();
  await commitCandidate(root, '20261112-detailed', {
    review: { extraLines: ['comments:', commentFixture([{ id: 'c1', content: '请补充说明' }])], bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, { ...guardFixture('2026-11/20261112-detailed'), commitDetail: 'detailed' });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.replace(/\r\n/g, '\n').trimEnd();
  const lines = message.split('\n');
  assert.equal(lines[0], 'review(2026-11/20261112-detailed): net: 20261112-detailed');
  assert.equal(lines[1], '');
  assert.match(message, /作者统计（本候选触及文件）：/);
  assert.match(message, /改动摘要：1 个文件，\+1 \/ -1 行/);
  assert.match(message, /修复方案：/);
  assert.match(message, /来源候选：/);
  assert.match(message, /门禁（本次批准重新执行 1 条）：/);
  assert.match(message, /- node --version/);
  assert.match(message, /审核评论：共 1 条，已处理 0 条/);
});

test('§8.3：/approve commitDetail 非法取值必须 422，不得静默降级', async () => {
  const root = await createGitFixture();
  await candidateFixture(root, '20261112-bad-detail');
  const { base } = await startApi(root);
  for (const value of ['LONG', '', 1, null, true]) {
    const response = await post(base, '/approve', { ...guardFixture('2026-11/20261112-bad-detail'), commitDetail: value });
    assert.equal(response.status, 422, `commitDetail=${JSON.stringify(value)} 必须 422`);
    assert.match((await response.json()).error.message, /commitDetail/);
  }
  // 候选仍为 pending，未被任何一次请求改动。
  const review = await readFile(path.join(root, '.ai-review', '2026-11', '20261112-bad-detail', 'review.md'), 'utf8');
  assert.match(review, /status: pending/);
});

test('§5.6：未提供 commitDetail 时保持旧语义（业务提交使用候选 commit_message 全文）', async () => {
  const root = await createGitFixture();
  await commitCandidate(root, '20261112-legacy', {
    review: { commitMessage: 'net: 20261112-legacy\n\n候选自带的正文', bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardFixture('2026-11/20261112-legacy'));
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout;
  assert.match(message, /候选自带的正文/);
});

// ---------------------------------------------------------------- 3) 审查整改回归

test('§7.5/§5.6（回归）：commitDetail 不放宽首行校验——commit_message 首行 ≠ title 时仍必须中止', async () => {
  // 独立审查提出「detail 模式可能绕过 §7.5 步骤 3」。实测：步骤 3 读的是 review.md 自身的
  // commit_message（与请求是否带 commitDetail 无关），因此不存在旁路；本用例把这一结论钉死，
  // 防止日后有人把 detail 实现成「用生成的首行替换校验对象」而悄悄放宽契约。
  const root = await createGitFixture();
  await commitCandidate(root, '20261112-bypass', {
    review: { commitMessage: '完全不同的标题\n\n正文', bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { base } = await startApi(root);
  for (const commitDetail of ['simple', 'detailed']) {
    const outcome = await approveAndWait(base, { ...guardFixture('2026-11/20261112-bypass'), commitDetail });
    assert.equal(outcome.job.result.status, 'ABORTED', JSON.stringify(outcome.job.result));
    assert.equal(outcome.job.result.reason, 'COMMIT_MESSAGE_MISMATCH');
    // 报错必须指向 review.md 的首行（而不是 Host 生成的单行），否则说明校验对象被换掉了。
    assert.match(outcome.job.result.message, /完全不同的标题/);
  }
  // 没有产生业务提交：HEAD 仍是候选夹具那次提交，候选仍是 pending。
  const log = runCommand('git', ['log', '-1', '--format=%s'], root).stdout.trim();
  assert.equal(log, 'fixture: 20261112-bypass');
  const review = await readFile(path.join(root, '.ai-review', '2026-11', '20261112-bypass', 'review.md'), 'utf8');
  assert.match(review, /status: pending/);
});

test('§7.5/§5.6（回归）：详细正文由锁内同步后的同一快照生成，描述的就是被提交的补丁', async () => {
  // 独立审查 P1-2：受理阶段生成的正文在同步换基线后会描述旧补丁。这里用一个只有同步时
  // 才会改变的候选补丁验证——提交说明的「改动摘要」必须来自实际提交的补丁。
  const root = await createGitFixture();
  await commitCandidate(root, '20261112-sync-body', {
    review: { bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { api, base } = await startApi(root, { syncBeforeApprove: false });
  const runtime = await api.runtimeFor(new URL('http://local/'));
  // 共享源（git HEAD）中的当前补丁改成触及两个文件；正文必须反映这份补丁。
  const candidateDir = path.join(root, '.ai-review', '2026-11', '20261112-sync-body');
  await writeFile(path.join(candidateDir, '001.patch'), [
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
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture: patch with two files'], root);
  // target_files 需要与补丁一致，否则批准前的完整性校验会拒绝；只改 review.md 并再次提交。
  const reviewPath = path.join(candidateDir, 'review.md');
  const reviewText = await readFile(reviewPath, 'utf8');
  await writeFile(reviewPath, reviewText.replace('target_files: [src/math.js]', 'target_files: [src/math.js, src/extra.txt]'), 'utf8');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture: target_files'], root);
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  void runtime;
  const outcome = await approveAndWait(base, {
    ...guardFixture('2026-11/20261112-sync-body'),
    commitDetail: 'detailed',
  });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const message = runCommand('git', ['log', '-1', '--format=%B'], root).stdout.replace(/\r\n/g, '\n');
  assert.match(message, /改动摘要：2 个文件/);
  assert.match(message, /src\/extra\.txt/);
  assert.match(message, /本次提交：1 个业务原子提交，涉及 2 个业务文件/);
  assert.notEqual(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
});

test('§7.4（回归）：同一仓库并发 /fix-session 只允许一个修复会话，turn 结束后释放占用', async () => {
  const root = await createGitFixture();
  const candidate = await candidateFixture(root, '20261112-fix-concurrent', { comments: [{ id: 'c1' }] });
  let turnEnded;
  let created = 0;
  const { api, base } = await startApi(root, {}, {
    createFixSession: async () => {
      created += 1;
      // 模拟创建会话耗时：期间第二个请求必须被拒绝。
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { sessionId: `sess-${String(created)}` };
    },
    onAuditTurnEnd: (_sessionId, callback) => { turnEnded = callback; return () => undefined; },
  });
  const [first, second] = await Promise.all([
    post(base, '/fix-session', { id: candidate.id }),
    post(base, '/fix-session', { id: candidate.id }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [202, 409], JSON.stringify([await first.clone().json(), await second.clone().json()]));
  assert.equal(created, 1, '只允许创建一个修复会话');
  assert.equal(api.fixSessionGuard.activeFor(root)?.candidateId, candidate.id);
  // turn 结束释放占用后可以再次启动。
  turnEnded();
  assert.equal(api.fixSessionGuard.activeFor(root), undefined);
  const third = await post(base, '/fix-session', { id: candidate.id });
  assert.equal(third.status, 202, JSON.stringify(await third.clone().json()));
});

// ---------------------------------------------------------------- 4) SVN 作者统计
test('§5.6：SVN authorStats 用 svn log --xml 聚合作者，且正文不渲染空邮箱', { skip: !hasSvn }, async () => {
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
  assert.ok(stats.buckets.every((bucket) => bucket.email === ''), 'SVN 只提供作者名');
  const text = await buildCommitDetails(
    {
      id: '2026-11/svn', month: '2026-11', slug: 'svn', dirPath: wc, reviewPath: path.join(wc, 'review.md'),
      sections: { problem: '', rootCause: '', solution: '', humanJudgment: '', evidence: '', history: '', rawBody: '' },
      humanJudgment: [], humanJudgmentDeclared: false,
      meta: {
        schemaVersion: 1, title: 'net: svn', module: 'net', auditType: 'bugfix',
        createdAt: '2026-11-01T10:00:00+08:00', updatedAt: '2026-11-01T10:00:00+08:00', owner: 'tester',
        tags: [], status: 'pending', ticket: null, targetFiles: ['a.txt'], currentRevision: 1,
        revisions: [{ id: 1, baseRevision: '1', patch: '001.patch', author: 'ai' }],
        gateChecks: [], comments: [], humanDecisions: [], approval: null, rejection: null, commitMessage: 'net: svn', extra: {},
      },
    },
    { repoRoot: wc, authorStats: stats, vcsType: 'svn' },
  );
  assert.doesNotMatch(text, /<>/, '无邮箱时不得渲染成 name <>');
  assert.match(text, /次revision/, 'SVN 使用 revision 作为统计单位');
  assert.match(text, /本次提交：1 个业务 revision/);
});
