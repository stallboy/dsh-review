import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, extraDeps = {}, settingsPatch = {}) {
  let settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'external',
    externalCommand: `"${process.execPath}" "${fakeAuditAgentPath()}"`,
    syncBeforeApprove: false,
    ...settingsPatch,
  };
  const api = new ReviewApi({
    settings,
    saveSettings: async (next) => {
      settings = next;
      return next;
    },
    ...extraDeps,
  });
  await api.init();
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${text}`);
  return body;
}

async function waitForJob(base, jobId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await getJson(`${base}/jobs/${encodeURIComponent(jobId)}`);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('audit job timed out');
}

test('API exposes audit prompt and runs a full audit job', async () => {
  const root = await createGitFixture();
  const server = await startApi(root);
  servers.push(server);
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const exported = await getJson(`${server.base}/audit/prompt?targetPath=src&note=${encodeURIComponent('重点看错误处理')}&mode=session`);
  assert.equal(exported.baseRevision, baseRevision);
  assert.equal(exported.targetPath, 'src');
  assert.equal(exported.owner, 'tester');
  assert.equal(exported.mode, 'session');
  assert.match(exported.prompt, /重点看错误处理/);
  assert.match(exported.prompt, /基线独立性铁律|Orthogonality Rule/);
  assert.match(exported.prompt, /独立 DSH 会话/);
  assert.doesNotMatch(exported.prompt, /^<system>/);
  assert.match(exported.reportPath, /^\.ai-review\/audits\/.+\.md$/);
  await assert.rejects(stat(path.join(root, '.ai-review')), /ENOENT/);

  const headlessPrompt = await getJson(`${server.base}/audit/prompt?targetPath=src&mode=headless`);
  assert.equal(headlessPrompt.mode, 'headless');
  assert.match(headlessPrompt.prompt, /^<system>/);

  const started = await getJson(`${server.base}/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '关注正确性' }),
  });
  assert.equal(started.job.type, 'audit');
  const job = await waitForJob(server.base, started.jobId);
  assert.equal(job.status, 'succeeded', job.error ?? '');
  assert.equal(job.result.created.length, 1);
  assert.equal(job.result.created[0].id, '2026-10/20261031-math-fix');
  assert.equal(job.result.deferred.length, 2);
  assert.ok(job.result.report.path.startsWith('.ai-review/audits/'));

  const queue = await getJson(`${server.base}/queue`);
  assert.equal(queue.configured, true);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].title, 'math: 修复加法实现');
  assert.equal(queue.items[0].owner, 'tester');

  const candidate = await getJson(`${server.base}/candidate?id=${encodeURIComponent('2026-10/20261031-math-fix')}`);
  assert.equal(candidate.canAct, true);
  assert.deepEqual(candidate.validation, []);
  assert.match(candidate.patchText, /src\/math\.js/);
});

test('API creates a DSH audit session with the session prompt', async () => {
  const root = await createGitFixture();
  const calls = [];
  const server = await startApi(root, {
    createAuditSession: async (input) => {
      calls.push(input);
      return { sessionId: 'session-test' };
    },
  });
  servers.push(server);

  const response = await getJson(`${server.base}/audit/session?sessionId=session-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: 'src', note: '重点看边界条件' }),
  });

  assert.equal(response.sessionId, 'session-test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].ownerSessionId, 'session-owner');
  assert.match(calls[0].title, /仓库审查/);
  assert.match(calls[0].title, /src/);
  assert.match(calls[0].prompt, /独立 DSH 会话/);
  assert.match(calls[0].prompt, /只提交 `\.ai-review`/);
  assert.match(calls[0].prompt, /重点看边界条件/);
  await assert.rejects(stat(path.join(root, '.ai-review')), /ENOENT/);
});

test('API rejects an audit request with a target outside the repository', async () => {
  const root = await createGitFixture();
  const server = await startApi(root);
  servers.push(server);

  const response = await fetch(`${server.base}/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '../outside' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /越界|仓库/);
});

async function writeQueueCandidate(root, slug, status, baseRevision) {
  const dir = path.join(root, '.ai-review', '2026-10', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---',
    'schema_version: 1',
    `title: "${slug}: 队列过滤夹具"`,
    'created_at: "2026-10-31T20:00:00+08:00"',
    'owner: tester',
    'tags: [queue]',
    `status: ${status}`,
    'ticket: null',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    `    base_revision: "${baseRevision}"`,
    '    patch: "001.patch"',
    'gate_checks:',
    '  - "node --version"',
    'comments: []',
    'approval: null',
    ...(status === 'approved'
      ? [
          'rejection: null',
          'approval:',
          '  approved_by: tester',
          '  approved_at: "2026-10-31T21:00:00+08:00"',
          '  commit_revision: null',
        ]
      : []),
    '---',
    '',
    '# 问题与影响',
    '夹具。',
    '',
    '# 需人工判断项',
    '- 无：夹具。',
    '',
  ].join('\n'), 'utf8');
  if (status === 'approved') return;
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    '',
  ].join('\n'), 'utf8');
}

test('API queue filters items but keeps owner-wide status counts', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeQueueCandidate(root, 'pending-one', 'pending', baseRevision);
  await writeQueueCandidate(root, 'approved-one', 'approved', baseRevision);
  const server = await startApi(root);
  servers.push(server);

  const filtered = await getJson(`${server.base}/queue?statuses=pending`);
  assert.deepEqual(filtered.items.map((item) => item.id), ['2026-10/pending-one']);
  assert.equal(filtered.counts.pending, 1);
  assert.equal(filtered.counts.approved, 1);

  const all = await getJson(`${server.base}/queue`);
  assert.equal(all.items.length, 2);
  assert.deepEqual(all.errors, []);
});

test('API chains an overall comment into an AI fix job', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeQueueCandidate(root, 'pending-one', 'pending', baseRevision);
  const server = await startApi(root, {}, { runner: 'manual' });
  servers.push(server);

  const response = await getJson(`${server.base}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-10/pending-one',
      expectedRevision: 1,
      expectedOwner: 'tester',
      content: '请补充边界测试',
      autoFix: true,
    }),
  });
  assert.ok(response.job, response.autoFixError ?? '没有启动 AI 修复 job');
  assert.equal(response.job.type, 'ai_fix');

  const job = await waitForJob(server.base, response.job.id);
  assert.equal(job.status, 'succeeded', job.error ?? '');
  assert.equal(job.result.manual, true);
  assert.match(job.result.prompt, /请补充边界测试/);

  const detail = await getJson(`${server.base}/candidate?id=${encodeURIComponent('2026-10/pending-one')}`);
  assert.equal(detail.candidate.meta.status, 'changes_requested');
  assert.equal(detail.candidate.meta.comments.length, 1);

  const plain = await getJson(`${server.base}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-10/pending-one',
      expectedRevision: 1,
      expectedOwner: 'tester',
      content: '只记一条意见',
      autoFix: false,
    }),
  });
  assert.equal(plain.job, undefined);
  assert.equal(plain.autoFixError, undefined);
});

