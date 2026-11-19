import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

process.env.GIT_AUTHOR_NAME ??= 'lease-test';
process.env.GIT_AUTHOR_EMAIL ??= 'lease-test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'lease-test';
process.env.GIT_COMMITTER_EMAIL ??= 'lease-test@example.com';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, extraDeps = {}) {
  // 将租约文件置于仓库外，避免工作区回滚时的 git clean 删除租约，干扰持久化验证。
  const statePath = path.join(await mkdtemp(path.join(tmpdir(), 'dcr-lease-state-')), 'runtime-state.json');
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath, ...extraDeps });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { api, base, statePath };
}

async function ensureReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
}

async function writeCandidate(root, slug, owner = 'tester') {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-09T10:00:00+08:00"', 'updated_at: "2026-11-09T10:00:00+08:00"', `owner: ${owner}`,
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    `commit_message: "net: ${slug}"`, '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js',
    '@@ -1 +1 @@', '-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;', '',
  ].join('\n'), 'utf8');
}

async function waitForJob(base, jobId) {
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
  }
  throw new Error('job 超时');
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('AC-SCHEDULE-01：手动会话审查创建租约与跟踪 Job，租约存在时阻止重复会话', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const created = [];
  const { base, statePath } = await startApi(root, {
    createAuditSession: async (input) => {
      created.push(input);
      return { sessionId: 'sess-manual' };
    },
  });

  const response = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(created.length, 1, '首次手动审查应创建会话');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.leases.length, 1);
  assert.equal(state.leases[0].trigger, 'manual');
  assert.equal(state.leases[0].sessionId, 'sess-manual');
  assert.match(state.leases[0].auditId, /^\d{8}-\d{6}-/);
  assert.equal(state.leases[0].state, 'active');
  assert.ok(created[0].prompt.includes(`.ai-review/audits/${state.leases[0].auditId}/audit.md`), '提示词必须使用租约的 auditId/reportPath');
  const job = await (await fetch(`${base}/jobs/${accepted.jobId}`)).json();
  assert.equal(job.type, 'audit');
  assert.equal(job.status, 'running');

  const duplicate = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(duplicate.status, 409);
  assert.equal(created.length, 1, '已有租约/运行中 Job 时应拒绝启动第二个会话');
});

test('AC-SCHEDULE-01：未释放手动租约阻止 /audit 与 /audit/session', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const created = [];
  const { base } = await startApi(root, {
    createAuditSession: async () => {
      created.push('session');
      return { sessionId: 'sess-manual' };
    },
  });
  const manual = await (await post(base, '/audit/manual', { targetPath: '', note: '' })).json();
  assert.ok(manual.auditId);

  const headless = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(headless.status, 409, '租约存在时 headless 审查必须 409');
  const session = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(session.status, 409, '租约存在时会话审查必须 409');
  assert.equal(created.length, 0, '被拒绝的入口不得创建会话');
});

test('AC-SCHEDULE-01：finalize 提交失败保留租约，正常收尾后才释放', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base, statePath } = await startApi(root);
  const manual = await (await post(base, '/audit/manual', { targetPath: '', note: '' })).json();

  await writeCandidate(root, '20261110-lease-finalize');
  const reportBody = [
    '# 仓库审查报告', '',
    '## A 类：已生成候选', '- `.ai-review/2026-11/20261110-lease-finalize/`：net: candidate（bugfix）', '',
    '## B 类：需人工确认（未改代码）', '- 无', '',
    '## 待前置合入后处理（Deferred）', '- 无', '',
    '## 验证与说明', '- node --version 通过。', '',
  ].join('\n');
  const reportAbs = path.join(root, manual.reportPath);
  await mkdir(path.dirname(reportAbs), { recursive: true });
  await writeFile(reportAbs, reportBody, 'utf8');

  // 用 pre-commit 钩子阻止提交落地，使 HEAD 停在原位置。
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(hook, 0o755);

  const first = await (await post(base, '/audit/finalize', { auditId: manual.auditId })).json();
  const firstJob = await waitForJob(base, first.jobId);
  assert.equal(firstJob.result.status, 'ABORTED', JSON.stringify(firstJob.result));
  const stateAfterFail = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateAfterFail.leases[0].state, 'active', '收尾失败必须保留租约');
  const syncBlocked = await post(base, '/sync', {});
  assert.equal(syncBlocked.status, 409);

  await rm(hook, { force: true });
  const second = await (await post(base, '/audit/finalize', { auditId: manual.auditId })).json();
  const secondJob = await waitForJob(base, second.jobId);
  assert.equal(secondJob.result.status, 'COMMITTED', JSON.stringify(secondJob.result));
  assert.ok(secondJob.result.commitRevision);
  const stateAfterOk = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateAfterOk.leases[0].state, 'released');
  const syncOk = await post(base, '/sync', {});
  assert.equal(syncOk.status, 200);
});

test('§8.2/§10.1：/queue 暴露阻塞审查租约全生命周期（active + sessionId → releasable → 无）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base, statePath } = await startApi(root, {
    createAuditSession: async () => ({ sessionId: 'sess-queue-lease' }),
  });

  const before = await (await fetch(`${base}/queue`)).json();
  assert.equal(before.auditLease, undefined, '无阻塞租约时省略诊断字段');

  const session = await (await post(base, '/audit/session', { targetPath: '', note: '' })).json();
  assert.ok(session.auditId);

  const stateJson = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateJson.leases[0].sessionId, 'sess-queue-lease', '会话 id 必须写入租约记录');

  const during = await (await fetch(`${base}/queue`)).json();
  assert.equal(during.auditLease?.auditId, session.auditId);
  assert.equal(during.auditLease?.state, 'active');
  assert.equal(during.auditLease?.sessionId, 'sess-queue-lease');
  assert.equal(during.auditLease?.trigger, 'manual');

  // 只查询健康端点的调用者也需要知道共享写入为何返回 409。
  const healthDuring = await (await fetch(`${base}/health`)).json();
  assert.ok(
    healthDuring.diagnostics.some((line) => line.includes(session.auditId) && line.includes('active')),
    `health 诊断应包含 active 租约：${JSON.stringify(healthDuring.diagnostics)}`,
  );

  const cancelled = await post(base, `/jobs/${encodeURIComponent(session.jobId)}/cancel`, {});
  assert.equal(cancelled.status, 202);
  const afterCancel = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterCancel.auditLease?.state, 'releasable', '超时/取消后租约必须以 releasable 可见');
  const healthAfterCancel = await (await fetch(`${base}/health`)).json();
  assert.ok(
    healthAfterCancel.diagnostics.some((line) => line.includes(session.auditId) && line.includes('releasable')),
    'health 诊断应包含 releasable 租约',
  );

  const released = await post(base, '/audit/release', { auditId: session.auditId, confirmStopped: true });
  assert.equal(released.status, 200);
  const afterRelease = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterRelease.auditLease, undefined);
  const healthAfterRelease = await (await fetch(`${base}/health`)).json();
  assert.ok(
    !healthAfterRelease.diagnostics.some((line) => line.includes(session.auditId)),
    '释放后 health 诊断不得再出现该租约',
  );
});
