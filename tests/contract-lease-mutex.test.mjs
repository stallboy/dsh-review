import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

process.env.GIT_AUTHOR_NAME ??= 'lease-test';
process.env.GIT_AUTHOR_EMAIL ??= 'lease-test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'lease-test';
process.env.GIT_COMMITTER_EMAIL ??= 'lease-test@example.com';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, extraDeps = {}) {
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
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeSchemaCandidate(root, slug, {
    review: { baseRevision: base, owner, createdAt: '2026-11-09T10:00:00+08:00', updatedAt: '2026-11-09T10:00:00+08:00' },
  });
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
  assert.equal(created.length, 1);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.leases.length, 1);
  assert.equal(state.leases[0].trigger, 'manual');
  assert.equal(state.leases[0].sessionId, 'sess-manual');
  assert.match(state.leases[0].auditId, /^\d{8}-\d{6}-/);
  assert.equal(state.leases[0].state, 'active');
  assert.ok(created[0].prompt.includes(`.ai-review/audits/${state.leases[0].auditId}/audit.md`));
  const job = await (await fetch(`${base}/jobs/${accepted.jobId}`)).json();
  assert.equal(job.type, 'audit');
  assert.equal(job.status, 'running');

  const duplicate = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(duplicate.status, 409);
  assert.equal(created.length, 1);
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

  assert.equal((await post(base, '/audit', { targetPath: '', note: '' })).status, 409);
  assert.equal((await post(base, '/audit/session', { targetPath: '', note: '' })).status, 409);
  assert.equal(created.length, 0);
});

test('AC-SCHEDULE-01：finalize 提交失败保留租约，正常收尾后才释放', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base, statePath } = await startApi(root);
  const manual = await (await post(base, '/audit/manual', { targetPath: '', note: '' })).json();

  await writeCandidate(root, '20261110-lease-finalize');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(hook, 0o755);

  const first = await (await post(base, '/audit/finalize', { auditId: manual.auditId })).json();
  const firstJob = await waitForJob(base, first.jobId);
  assert.equal(firstJob.result.status, 'ABORTED', JSON.stringify(firstJob.result));
  const stateAfterFail = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateAfterFail.leases[0].state, 'active');
  assert.equal((await post(base, '/sync', {})).status, 409);

  await rm(hook, { force: true });
  const second = await (await post(base, '/audit/finalize', { auditId: manual.auditId })).json();
  const secondJob = await waitForJob(base, second.jobId);
  assert.equal(secondJob.result.status, 'COMMITTED', JSON.stringify(secondJob.result));
  assert.ok(secondJob.result.commitRevision);
  const stateAfterOk = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateAfterOk.leases[0].state, 'released');
  assert.equal((await post(base, '/sync', {})).status, 200);
});

test('§6.2：/queue 暴露阻塞审查租约全生命周期（active + sessionId → releasable → 无）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base, statePath } = await startApi(root, {
    createAuditSession: async () => ({ sessionId: 'sess-queue-lease' }),
  });

  const before = await (await fetch(`${base}/queue`)).json();
  assert.equal(before.auditLease, undefined);

  const session = await (await post(base, '/audit/session', { targetPath: '', note: '' })).json();
  assert.ok(session.auditId);

  const stateJson = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stateJson.leases[0].sessionId, 'sess-queue-lease');

  const during = await (await fetch(`${base}/queue`)).json();
  assert.equal(during.auditLease?.auditId, session.auditId);
  assert.equal(during.auditLease?.state, 'active');
  assert.equal(during.auditLease?.sessionId, 'sess-queue-lease');
  assert.equal(during.auditLease?.trigger, 'manual');

  const healthDuring = await (await fetch(`${base}/health`)).json();
  assert.ok(healthDuring.diagnostics.some((line) => line.includes(session.auditId) && line.includes('active')));

  assert.equal((await post(base, `/jobs/${encodeURIComponent(session.jobId)}/cancel`, {})).status, 202);
  const afterCancel = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterCancel.auditLease?.state, 'releasable');

  assert.equal((await post(base, '/audit/release', { auditId: session.auditId, confirmStopped: true })).status, 200);
  const afterRelease = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterRelease.auditLease, undefined);
});
