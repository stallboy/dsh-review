import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { checkDecisionCoverage, checkCommitMessage } from '../dist/approval.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

/** P5 验收：批准强化——I8 判断项全覆盖、§4.9 标题一致、§4.7 快照/结果/决定留痕、业务提交用 commit_message。 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'manual',
    syncBeforeApprove: false,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeCandidate(root, slug, extra = {}) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---',
    'schema_version: 1',
    `title: "${extra.title ?? 'net: 修复加法'}"`,
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-01T10:00:00+08:00"',
    'updated_at: "2026-11-01T10:00:00+08:00"',
    'owner: tester',
    'tags: []',
    'status: pending',
    'ticket: null',
    'target_files: [src/math.js]',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    'gate_checks: ["node --version"]',
    'comments: []',
    ...((extra.decisions ?? []).length > 0 ? ['human_decisions:'] : ['human_decisions: []']),
    ...(extra.decisions ?? []).map((d) => `  - id: ${d.id}\n    question: "${d.q}"`),
    'approval: null',
    'rejection: null',
    ...(extra.commitMessage !== undefined
      ? ['commit_message: |', ...extra.commitMessage.split('\n').map((l) => `  ${l}`)]
      : ['commit_message: "net: 修复加法"']),
    '---',
    '',
    '# 问题与影响',
    '',
    '# 需人工判断项',
    ...(extra.decisions ?? []).map((d) => `- ${d.q}`),
    '',
  ].join('\n'), 'utf8');
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const fm = await readFile(path.join(dir, 'review.md'), 'utf8');
  await writeFile(path.join(dir, 'review.md'), fm.replace('base_revision: "1"', `base_revision: "${base}"`), 'utf8');
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

async function approveAndWait(base, payload) {
  const response = await fetch(`${base}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status !== 202) return { httpStatus: response.status, body: await response.json() };
  const { jobId } = await response.json();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const job = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return { httpStatus: 202, job };
  }
  throw new Error('approve job 超时');
}

test('P5: 判断项未全覆盖 / 知悉缺理由 / 标题不一致 —— 批准被拒', async () => {
  // 纯函数级
  const errs = checkDecisionCoverage(
    [{ id: 'h1', question: 'Q1' }, { id: 'h2', question: 'Q2' }],
    ['h1'],
    [{ id: 'h2', reason: '  ' }],
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /缺少理由/);
  const uncovered = checkDecisionCoverage(
    [{ id: 'h1', question: 'Q1' }, { id: 'h2', question: 'Q2' }],
    ['h1'],
    [],
  );
  assert.equal(uncovered.length, 1);
  assert.match(uncovered[0], /h2.*未确认/);
  assert.match(checkCommitMessage('t: x', ''), /为空/);
  assert.match(checkCommitMessage('t: x', 'other: y\nbody'), /一致/);
  assert.equal(checkCommitMessage('t: x', 't: x\nbody'), null);

  // API 级：知悉缺理由直接 400。
  const root = await createGitFixture();
  await writeCandidate(root, '20261105-net-a', { decisions: [{ id: 'h1', q: '是否接受行为变化？' }] });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const bad = await approveAndWait(base, {
    id: '2026-11/20261105-net-a',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    confirmedDecisions: [],
    waivedDecisions: [{ id: 'h1', reason: '' }],
  });
  assert.equal(bad.httpStatus, 422);

  // 判断项漏确认 → job 结果 DECISIONS_UNCONFIRMED。
  const miss = await approveAndWait(base, {
    id: '2026-11/20261105-net-a',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    confirmedDecisions: [],
    waivedDecisions: [],
  });
  assert.equal(miss.job.result.reason, 'DECISIONS_UNCONFIRMED');

  // commit_message 首行不一致 → COMMIT_MESSAGE_MISMATCH。
  const mismatchRoot = await createGitFixture();
  await writeCandidate(mismatchRoot, '20261105-net-b', { commitMessage: '别的标题\n正文' });
  runCommand('git', ['add', '.ai-review'], mismatchRoot);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], mismatchRoot);
  const { base: base2 } = await startApi(mismatchRoot);
  const mismatch = await approveAndWait(base2, {
    id: '2026-11/20261105-net-b',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
  });
  assert.ok(mismatch.job, JSON.stringify(mismatch));
  assert.equal(mismatch.job.result.reason, 'COMMIT_MESSAGE_MISMATCH');
});

test('P5: 合法批准——快照/结果/决定留痕 + 业务提交使用 commit_message', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261105-net-ok', {
    decisions: [{ id: 'h1', q: '是否接受行为变化？' }, { id: 'h2', q: '是否写入发布说明？' }],
    commitMessage: 'net: 修复加法\n\n问题证据：add 符号写反。\n实际验证：node --version 通过。',
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const outcome = await approveAndWait(base, {
    id: '2026-11/20261105-net-ok',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    confirmedDecisions: ['h1'],
    waivedDecisions: [{ id: 'h2', reason: '发布说明由产品另行补充' }],
  });
  assert.equal(outcome.job.status, 'succeeded');
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));

  // review.md 留痕：快照、逐条结果、确认/知悉。
  const reviewText = await readFile(path.join(root, '.ai-review', '2026-11', '20261105-net-ok', 'review.md'), 'utf8');
  assert.match(reviewText, /gate_checks:\n\s+- node --version/);
  assert.match(reviewText, /exit_code: 0/);
  assert.match(reviewText, /confirmed_decisions:\n\s+- h1/);
  assert.match(reviewText, /waived_decisions:/);
  assert.match(reviewText, /发布说明由产品另行补充/);

  // §5.5（2026-11-09 修订）：单次原子提交——最新提交即业务提交（首行 == title），无第二次回填提交。
  const log = runCommand('git', ['log', '-2', '--format=%s'], root).stdout.trim().split('\n');
  assert.equal(log[0], 'net: 修复加法');
  assert.equal(log[1], 'fixture');
  // review.md 不保存 commit_revision。
  assert.doesNotMatch(reviewText, /commit_revision/);

  // §5.5 派生读模型：/candidate 返回 found 与业务提交版本（AC-APPROVE-01）。
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261105-net-ok')}`)).json();
  assert.equal(detail.approvalCommitLookup, 'found', JSON.stringify(detail.approvalCommitLookup));
  assert.equal(detail.approvalCommitRevision, head);
});

test('AC-DECISION-01：未知 id / 重复 / 交叉的确认-知悉集合均拒绝且不写 approval', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261105-net-decisions', {
    decisions: [{ id: 'h1', q: '是否接受行为变化？' }, { id: 'h2', q: '是否写入发布说明？' }],
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const guard = {
    id: '2026-11/20261105-net-decisions',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
  };
  const cases = [
    { confirmedDecisions: ['h1', 'unknown'], waivedDecisions: [{ id: 'h2', reason: '产品补充' }] },
    { confirmedDecisions: ['h1', 'h1'], waivedDecisions: [{ id: 'h2', reason: '产品补充' }] },
    { confirmedDecisions: ['h1'], waivedDecisions: [{ id: 'h1', reason: '交叉' }, { id: 'h2', reason: '产品补充' }] },
  ];
  for (const decisions of cases) {
    const outcome = await approveAndWait(base, { ...guard, ...decisions });
    assert.equal(outcome.job.result.status, 'ABORTED');
    assert.equal(outcome.job.result.reason, 'DECISIONS_UNCONFIRMED');
  }
  const reviewText = await readFile(path.join(root, '.ai-review', '2026-11', '20261105-net-decisions', 'review.md'), 'utf8');
  assert.match(reviewText, /status: pending/);
  assert.match(reviewText, /approval: null/);
});
