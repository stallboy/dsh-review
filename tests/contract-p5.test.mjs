import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { validateHumanDecisionsCoverage } from '../packages/dsh-plugin/dist/host/approval.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

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
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const decisionsYaml = (extra.decisions ?? []).length > 0
    ? '\n' + extra.decisions.map((d) => `  - id: ${d.id}\n    question: "${d.q}"`).join('\n')
    : ' []';
  await writeSchemaCandidate(root, slug, {
    review: {
      title: extra.title ?? 'net: 修复加法',
      baseRevision: baseRev,
      humanDecisions: decisionsYaml,
      commitMessage: extra.commitMessage ?? 'net: 修复加法',
    },
  });
}

async function approveAndWait(base, payload) {
  const response = await fetch(`${base}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: 'opt-a', patchId: 1, ...payload }),
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
  const fakeMeta = { humanDecisions: [{ id: 'h1', question: 'Q1' }, { id: 'h2', question: 'Q2' }] };
  const errBlank = validateHumanDecisionsCoverage(fakeMeta, ['h1'], [{ id: 'h2', reason: '  ' }]);
  assert.match(errBlank ?? '', /理由/);
  const errUncovered = validateHumanDecisionsCoverage(fakeMeta, ['h1'], []);
  assert.match(errUncovered ?? '', /h2/);

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

  const miss = await approveAndWait(base, {
    id: '2026-11/20261105-net-a',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    confirmedDecisions: [],
    waivedDecisions: [],
  });
  assert.equal(miss.httpStatus, 422);

  const mismatchRoot = await createGitFixture();
  await writeCandidate(mismatchRoot, '20261105-net-b');
  runCommand('git', ['add', '.ai-review'], mismatchRoot);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], mismatchRoot);
  const { base: base2 } = await startApi(mismatchRoot);
  const mismatch = await approveAndWait(base2, {
    id: '2026-11/20261105-net-b',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    commitMessage: '别的标题\n正文',
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

  const reviewText = await readFile(path.join(root, '.ai-review', '2026-11', '20261105-net-ok', 'review.md'), 'utf8');
  assert.match(reviewText, /gate_checks:\n\s+- node --version/);
  assert.match(reviewText, /exit_code: 0/);
  assert.match(reviewText, /confirmed_decisions:\n\s+- h1/);
  assert.match(reviewText, /waived_decisions:/);
  assert.match(reviewText, /发布说明由产品另行补充/);

  // 只允许一次原子业务提交，因此 HEAD 必须直接指向业务提交（AC-APPROVE-01）。
  const log = runCommand('git', ['log', '-2', '--format=%s'], root).stdout.trim().split('\n');
  assert.equal(log[0], 'net: 修复加法');
  assert.equal(log[1], 'fixture');
  assert.doesNotMatch(reviewText, /commit_revision/);

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
    assert.equal(outcome.httpStatus, 422);
  }
  const reviewText = await readFile(path.join(root, '.ai-review', '2026-11', '20261105-net-decisions', 'review.md'), 'utf8');
  assert.match(reviewText, /status: pending/);
  assert.match(reviewText, /approval: null/);
});
