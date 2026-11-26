import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeCandidate(root, slug, extra = {}) {
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const gates = extra.gateChecks
    ? `[${extra.gateChecks.map((c) => JSON.stringify(c)).join(', ')}]`
    : '["node --version"]';
  await writeSchemaCandidate(root, slug, {
    review: {
      title: `net: ${slug}`,
      commitMessage: `net: ${slug}`,
      baseRevision: baseRev,
      createdAt: '2026-11-08T10:00:00+08:00',
      updatedAt: '2026-11-08T10:00:00+08:00',
      status: extra.status ?? 'pending',
      gateChecks: gates,
    },
  });
}

function commitFixture(root) {
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
}

async function approveAndWait(base, payload) {
  const response = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: 'opt-a', patchId: 1, ...payload }),
  });
  if (response.status !== 202) return { httpStatus: response.status, body: await response.json() };
  const { jobId } = await response.json();
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const job = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return { httpStatus: 202, job };
  }
  throw new Error('approve job 超时');
}

const guardOf = (slug, over = {}) => ({
  id: `2026-11/${slug}`,
  expectedRevision: 1,
  expectedOwner: 'tester',
  expectedUpdatedAt: '2026-11-08T10:00:00+08:00',
  ...over,
});

test('切换本地评审仓库后，旧页面无法写入含同一候选的工作副本', async () => {
  const first = await createGitFixture();
  const second = await createGitFixture();
  const slug = '20261120-shared';
  await writeCandidate(first, slug);
  commitFixture(first);
  runCommand('git', ['fetch', first, 'HEAD'], second);
  runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], second);
  const head = runCommand('git', ['rev-parse', 'HEAD'], first).stdout.trim();
  const api = new ReviewApi({ settings: { ...DEFAULT_SETTINGS, repoRoot: first, owner: 'tester' }, saveSettings: async (next) => next });
  await api.init();
  const opened = await api.invoke({ method: 'GET', path: '/candidate', query: { id: guardOf(slug).id, expectedRepoRoot: first } });
  assert.equal(opened.status, 200);
  assert.equal((await api.invoke({ method: 'PUT', path: '/settings', body: { repoRoot: second } })).status, 200);
  const staleQueue = await api.invoke({ method: 'GET', path: '/queue', query: { expectedRepoRoot: first } });
  assert.equal(staleQueue.status, 409);
  const body = { ...guardOf(slug), action: 'accept_as_is', reason: '回归测试' };
  const staleWrite = await api.invoke({ method: 'POST', path: '/finding/decision', query: { expectedRepoRoot: first }, body });
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.body.error.code, 'conflict');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], first).stdout.trim(), head);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], second).stdout.trim(), head);
  assert.equal((await api.invoke({ method: 'POST', path: '/finding/decision', query: { expectedRepoRoot: second }, body })).status, 200);
  assert.notEqual(runCommand('git', ['rev-parse', 'HEAD'], second).stdout.trim(), head);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], first).stdout.trim(), head);
});

test('G19：changes_requested 不能批准——受理前 409 conflict', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-cr', { status: 'changes_requested' });
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardOf('20261108-cr'));
  assert.equal(outcome.httpStatus, 409);
  assert.match(outcome.body.error.message, /pending/);
});

test('G26：门禁期间修改目标业务文件 → BUSINESS_CONTENT_CHANGED 并回滚', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-mutate', {
    gateChecks: ["node -e \"require('fs').appendFileSync('src/math.js','-- injected')\""],
  });
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardOf('20261108-mutate'));
  assert.equal(outcome.job.result.status, 'ABORTED');
  assert.equal(outcome.job.result.reason, 'BUSINESS_CONTENT_CHANGED');
  const text = await readFile(path.join(root, 'src', 'math.js'), 'utf8');
  assert.ok(!text.includes('injected'), text);
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261108-mutate')}`)).json();
  assert.equal(detail.candidate.meta.status, 'pending');
});

test('G26：门禁期间生成额外业务文件 → BUSINESS_CONTENT_CHANGED', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-extra', {
    gateChecks: ['node -e "require(\'fs\').writeFileSync(\'src/sneaky.txt\',\'x\')"'],
  });
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardOf('20261108-extra'));
  assert.equal(outcome.job.result.status, 'ABORTED');
  assert.equal(outcome.job.result.reason, 'BUSINESS_CONTENT_CHANGED');
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
});

test('G19/G26 回归：干净门禁仍可正常批准（COMMITTED）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-ok');
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardOf('20261108-ok'));
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  assert.ok(outcome.job.result.commitRevision);
});

test('§5.5：/approve 提供 commitMessage 时替换并写入 review.md 与业务提交说明', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-msg');
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, {
    ...guardOf('20261108-msg'),
    commitMessage: 'net: 20261108-msg\n\n详细说明：替换后的提交信息。',
  });
  assert.equal(outcome.job.result.status, 'COMMITTED', JSON.stringify(outcome.job.result));
  const review = await readFile(path.join(root, '.ai-review', '2026-11', '20261108-msg', 'review.md'), 'utf8');
  assert.match(review, /详细说明：替换后的提交信息/);
  const subject = runCommand('git', ['log', '-1', '--format=%B'], root).stdout;
  assert.match(subject, /^net: 20261108-msg/);
  assert.match(subject, /详细说明：替换后的提交信息/);
});

test('§5.5：请求体 commitMessage 首行与 title 不一致 → ABORTED / COMMIT_MESSAGE_MISMATCH，不写入', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261108-badmsg');
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, {
    ...guardOf('20261108-badmsg'),
    commitMessage: 'net: 完全不同的标题\n\n正文',
  });
  assert.equal(outcome.job.result.status, 'ABORTED');
  assert.equal(outcome.job.result.reason, 'COMMIT_MESSAGE_MISMATCH');
  const review = await readFile(path.join(root, '.ai-review', '2026-11', '20261108-badmsg', 'review.md'), 'utf8');
  assert.match(review, /status: pending/);
  assert.doesNotMatch(review, /完全不同的标题/);
});
