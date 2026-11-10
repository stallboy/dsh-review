import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/**
 * 批准编排强化（§7.5）：
 * G19——只有 pending 可批准（受理前 409 conflict；受理后 STATE_CONFLICT）；
 * G26——门禁期间业务内容/额外文件变化返回 BUSINESS_CONTENT_CHANGED 并回滚。
 */

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
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-08T10:00:00+08:00"', 'updated_at: "2026-11-08T10:00:00+08:00"', 'owner: tester',
    'tags: []', `status: ${extra.status ?? 'pending'}`, 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    ...(extra.gateChecks ? ['gate_checks:', ...extra.gateChecks.map((c) => `  - "${c.replaceAll('"', '\\"')}"`)] : ['gate_checks: ["node --version"]']),
    'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    `commit_message: "net: ${slug}"`, '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
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

function commitFixture(root) {
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
}

async function approveAndWait(base, payload) {
  const response = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
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
    // 门禁命令篡改目标业务文件内容（避免 \n 转义歧义）。
    gateChecks: ["node -e \"require('fs').appendFileSync('src/math.js','-- injected')\""],
  });
  commitFixture(root);
  const { base } = await startApi(root);
  const outcome = await approveAndWait(base, guardOf('20261108-mutate'));
  assert.equal(outcome.job.result.status, 'ABORTED');
  assert.equal(outcome.job.result.reason, 'BUSINESS_CONTENT_CHANGED');
  // 业务工作区已还原：math.js 无注入痕迹，候选仍 pending。
  const text = await readFile(path.join(root, 'src', 'math.js'), 'utf8');
  assert.ok(!text.includes('injected'), text);  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
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
  // 额外文件已清理（工作区还原）。
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

test('§7.5/§8.3：/approve 提供 commitMessage 时替换并写入 review.md 与业务提交说明', async () => {
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
  // 业务提交说明使用替换后的 commit_message 全文。
  const subject = runCommand('git', ['log', '-1', '--format=%B'], root).stdout;
  assert.match(subject, /^net: 20261108-msg/);
  assert.match(subject, /详细说明：替换后的提交信息/);
});

test('§7.5：请求体 commitMessage 首行与 title 不一致 → ABORTED / COMMIT_MESSAGE_MISMATCH，不写入', async () => {
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
