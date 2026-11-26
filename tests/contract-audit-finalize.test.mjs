import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, dependencies = {}) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({
    settings,
    saveSettings: async (next) => next,
    statePath: path.join(root, '.tmp', 'runtime-state.json'),
    ...dependencies,
  });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeCandidate(root, slug, owner = 'tester') {
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeSchemaCandidate(root, slug, {
    review: {
      baseRevision: base,
      owner,
      createdAt: '2026-11-09T10:00:00+08:00',
      updatedAt: '2026-11-09T10:00:00+08:00',
    },
  });
}

async function waitForJob(base, jobId) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
  }
  throw new Error('job 超时');
}

async function ensureReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
}

test('G20/G1：手动租约 → 阻塞共享写 → finalize 生成纯索引目录式档案并提交 → 释放', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);

  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();
  assert.match(manual.auditId, /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*$/);
  assert.match(manual.reportPath, new RegExp(`audits/${manual.auditId}/audit\\.md$`));

  await writeCandidate(root, '20261109-manual-ok');
  const blocked = await fetch(`${base}/rebase`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-manual-ok', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', optionId: 'opt-a', patchId: 1,
    }),
  });
  assert.equal(blocked.status, 409);

  const finalizeStart = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  assert.equal(finalizeStart.status, 202);
  const { jobId } = await finalizeStart.json();
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  assert.ok(job.result.commitRevision);

  const auditText = await readFile(path.join(root, '.ai-review', 'audits', manual.auditId, 'audit.md'), 'utf8');
  assert.match(auditText, /schema_version: 1/);
  assert.match(auditText, new RegExp(`audit_id: ${manual.auditId}`));
  assert.match(auditText, /issues:\n\s+- 2026-11\/20261109-manual-ok/);
  assert.equal((auditText.match(/<!-- ai-review:audit-verification -->/g) ?? []).length, 1);

  const okComment = await fetch(`${base}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-manual-ok', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', content: '租约释放后的评论',
    }),
  });
  assert.equal(okComment.status, 200);
});

test('I12：收尾在读取草稿或创建正式档案前拒绝重定向的祖先目录', async () => {
  const root = await createGitFixture();
  const outside = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);
  const post = async (route, body) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const { auditId, reportPath } = await post('/audit/manual', { targetPath: '' });
  const parent = path.join(root, '.ai-review', 'audits');
  const redirected = path.join(outside, auditId);
  await mkdir(redirected, { recursive: true });
  await writeFile(path.join(redirected, 'audit.md'), '# 外部文件\n');
  await symlink(outside, parent, 'junction');

  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout;
  const { jobId } = await post('/audit/finalize', { auditId });
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'RECOVERY_REQUIRED', JSON.stringify(job.result));
  assert.equal(job.result.dataValidation[0].path, reportPath);
  assert.match(job.result.dataValidation[0].errors[0], /重定向|软链|符号链接|路径/);
  assert.equal(await readFile(path.join(redirected, 'audit.md'), 'utf8'), '# 外部文件\n');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout, head);
});

test('I18（软引导 + Host 强还原）：自动收尾前强制还原审查期间的非 .ai-review/ 临时改动并正常收尾', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { promise, resolve } = Promise.withResolvers();
  const { base } = await startApi(root, {
    createAuditSession: async () => ({ sessionId: 'audit-session' }),
    withAuditSessionIdle: async (_id, _requestId, signal, finalize) => {
      await promise;
      await finalize(signal);
      return true;
    },
  });
  const started = await (await fetch(base + '/audit/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetPath: '' }),
  })).json();
  assert.ok(started.jobId, JSON.stringify(started));
  await writeCandidate(root, '20261109-during-audit');
  await writeFile(path.join(root, 'src', 'math.js'), '// 审查期间临时取证改动\n');
  await writeFile(path.join(root, 'src', 'temp-probe.js'), '// 未跟踪临时取证文件\n');
  resolve();

  const job = await waitForJob(base, started.jobId);
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['status', '--porcelain', '--', 'src'], root).stdout.trim(), '');
  assert.match(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), /a - b/);
});

test('提交钩子拒绝收尾时返回 ABORTED 并保留租约', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  await mkdir(path.join(root, '.git', 'audit-hooks'));
  await writeFile(path.join(root, '.git', 'audit-hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  runCommand('git', ['config', 'core.hooksPath', '.git/audit-hooks'], root);
  const { base } = await startApi(root);
  const post = async (route, body) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const { auditId } = await post('/audit/manual', { targetPath: '' });
  const { jobId } = await post('/audit/finalize', { auditId });
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'ABORTED', JSON.stringify(job.result));
});

test('自动收尾提交结果不明时禁止重试，人工核验后可释放', async (t) => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  t.mock.method(GitAdapter.prototype, 'atomicCommit', async () => {
    return { success: false, commitRevision: null, outOfDate: false, verificationFailed: true, errorOutput: '提交结果不明' };
  });
  const { base } = await startApi(root, {
    createAuditSession: async () => ({ sessionId: 'audit-session' }),
    withAuditSessionIdle: async (_id, _requestId, signal, finalize) => {
      await finalize(signal);
      return true;
    },
  });
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const { auditId, jobId, reportPath } = await post('/audit/session', { targetPath: '' }).then((response) => response.json());
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.reason, 'COMMIT_OUTCOME_UNKNOWN');
  const queue = await fetch(base + '/queue').then((response) => response.json());
  assert.equal(queue.auditLease.commitOutcomeUnknown, true);
  assert.equal(queue.auditLease.state, 'releasable');
  assert.equal((await post('/audit/finalize', { auditId })).status, 409);
  assert.equal((await post('/audit/release', { auditId, confirmStopped: true })).status, 409);
  assert.equal((await post('/audit/release', { auditId, confirmStopped: true, confirmCommitChecked: true })).status, 200);
  assert.match(await readFile(path.join(root, reportPath), 'utf8'), /schema_version: 1/);
});

test('G20：未配置 reviewers.yml 启动手动审查返回 412；配置后重复 finalize 拒绝、release 需显式确认停止', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root);
  const precheck = await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  });
  assert.equal(precheck.status, 412);

  await ensureReviewers(root);
  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();

  assert.equal((await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  })).status, 409);

  assert.equal((await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId, confirmStopped: true }),
  })).status, 409);

  assert.equal((await fetch(`${base}/jobs/${encodeURIComponent(manual.jobId)}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 202);

  assert.equal((await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId, confirmStopped: true }),
  })).status, 200);

  assert.equal((await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  })).status, 409);
});

test('G3：owner 填错的候选不进入共享提交（VALIDATION_FAILED + 目录留在本地）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);
  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();
  await writeCandidate(root, '20261109-wrong-owner', 'someone-else');
  const finalizeStart = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  const { jobId } = await finalizeStart.json();
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  const tracked = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim();
  assert.equal(tracked, '', tracked);
  assert.match(job.result.created[0].errors.join('；'), /owner 应为 tester/);
});

test('收尾拒绝重复键和缺失字段，Job 保留原始格式错误', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);
  const post = async (route, data) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })).json();
  const { auditId } = await post('/audit/manual', { targetPath: '', note: '' });
  const duplicate = '20261109-duplicate-owner';
  const missing = '20261109-missing-owner';
  const valid = '20261109-valid-owner';
  await writeCandidate(root, valid);
  await writeCandidate(root, duplicate, 'other\nowner: tester');
  await writeCandidate(root, missing);
  const missingReview = path.join(root, '.ai-review', '2026-11', missing, 'review.md');
  await writeFile(missingReview, (await readFile(missingReview, 'utf8')).replace('owner: tester\n', ''), 'utf8');

  const { jobId } = await post('/audit/finalize', { auditId });
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  const results = new Map(job.result.created.map((candidate) => [candidate.id, candidate.errors]));
  assert.match(results.get(`2026-11/${duplicate}`)[0], /duplicated mapping key/);
  assert.match(results.get(`2026-11/${missing}`)[0], /owner/);
  const committed = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim().split('\n');
  assert.deepEqual(committed, [`.ai-review/2026-11/${valid}/001.patch`, `.ai-review/2026-11/${valid}/review.md`]);
});

test('草稿 audit.md 缺失必填字段时收尾返回 ABORTED 且保留现场', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);
  const post = async (route, data) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })).json();
  const { auditId, reportPath } = await post('/audit/manual', { targetPath: '', note: '' });
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const auditAbs = path.join(root, reportPath);
  await mkdir(path.dirname(auditAbs), { recursive: true });
  await writeFile(auditAbs, `---\nschema_version: 1\naudit_id: ${auditId}\n---\n\n# 报告\n`, 'utf8');

  const { jobId } = await post('/audit/finalize', { auditId });
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'ABORTED');
  assert.equal(job.result.commitRevision, null);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  const queue = await fetch(base + '/queue').then((response) => response.json());
  assert.equal(queue.auditLease.auditId, auditId);
});
