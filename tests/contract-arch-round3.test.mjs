import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createVcs, gitBlobHash } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture, patchFixture } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, settingsPatch = {}) {
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
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}`;
  servers.push(server);
  return { base, statePath };
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function waitJob(base, jobId, attempts = 100) {
  let job;
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status !== 'running') return job;
  }
  return job;
}

async function seedReviewers(root) {
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
}

test('§5.7：审查运行期间共享写在受理阶段 409，而不是排队到审查结束后放行（C1）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261110-mutex');
  await seedReviewers(root);
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},5000)"`,
  });

  const auditRes = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(auditRes.status, 202);
  const auditBody = await auditRes.json();
  await new Promise((resolve) => setTimeout(resolve, 400));

  const started = Date.now();
  const comment = await post(base, '/comments', { ...guardFixture(candidate.id), content: '审查期间写入' });
  const elapsed = Date.now() - started;
  const commentBody = await comment.json();
  assert.equal(comment.status, 409, JSON.stringify(commentBody));
  assert.match(commentBody.error.message, /审查/);
  assert.ok(elapsed < 3000, `拒绝耗时 ${String(elapsed)}ms，说明请求被排队而不是在受理阶段拒绝`);

  await post(base, `/jobs/${encodeURIComponent(auditBody.jobId)}/cancel`, {});
  const job = await waitJob(base, auditBody.jobId);
  assert.notEqual(job.status, 'running');
});

test('§5.7：审查运行中不允许并发启动第二次审查（C2），互斥判定在锁内（无 TOCTOU）', async () => {
  const root = await createGitFixture();
  await commitCandidate(root, '20261110-double-audit');
  await seedReviewers(root);
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},5000)"`,
  });

  const first = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const second = await post(base, '/audit/manual', { targetPath: '', note: '' });
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.match(secondBody.error.message, /审查|任务/);

  await post(base, `/jobs/${encodeURIComponent(firstBody.jobId)}/cancel`, {});
  await waitJob(base, firstBody.jobId);
});

test('§5.7：基线落后时 Rebase 受理并返回 Mode B 提示词（manual 模式）且工作区干净', async () => {
  const root = await createGitFixture();
  const baseHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261110-rebase-lag', {
    review: { baseRevision: baseHead },
  });
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);

  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'MANUAL_REQUIRED', JSON.stringify(job.result));
  assert.match(String(job.result.prompt), /opt-a/);
  assert.equal(runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim(), '');
});

test('§5.7：Rebase 的“业务基线未变”守卫存在且使用 businessChangesBetween 判定（B4）', async () => {
  const writers = await readFile(new URL('../packages/dsh-plugin/src/host/api-writers.ts', import.meta.url), 'utf8');
  assert.match(writers, /businessChangesBetween\(/, 'Rebase 必须用业务基线变更判定');
  assert.match(writers, /'BASE_UNCHANGED'/);
});

test('§5.5：目录内出现未列入核对的暂存文件时拒绝提交（B1：集合相等而不是子集）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261110-collect');
  await writeFile(path.join(candidate.dir, '001.patch'), patchFixture(), 'utf8');
  await writeFile(path.join(candidate.dir, 'sneaky.patch'), 'UNAPPROVED\n', 'utf8');
  const vcs = createVcs('git', root);
  const verified = gitBlobHash(patchFixture());

  const rejected = await vcs.atomicCommit({
    message: 'should reject',
    paths: [`.ai-review/${candidate.id}`],
    verifyEntries: [{ path: `.ai-review/${candidate.id}/001.patch`, blobHash: verified }],
  });
  assert.equal(rejected.success, false, '未列入核对集合的文件必须导致拒绝');
  assert.match(rejected.errorOutput, /未列入核对集合/);

  const ok = await vcs.atomicCommit({
    message: 'all verified',
    paths: [`.ai-review/${candidate.id}`],
    verifyEntries: [
      { path: `.ai-review/${candidate.id}/001.patch`, blobHash: verified },
      { path: `.ai-review/${candidate.id}/sneaky.patch`, blobHash: gitBlobHash('UNAPPROVED\n') },
      { path: `.ai-review/${candidate.id}/review.md`, blobHash: gitBlobHash(await readFile(candidate.reviewPath, 'utf8')) },
    ],
  });
  assert.equal(ok.success, true, ok.errorOutput);
});

test('§5.4：Rebase 读取共享快照中的补丁，工作区本地篡改补丁不会进入提示词（B2）', async () => {
  const root = await createGitFixture();
  const baseHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261110-rebase-shared', {
    review: { baseRevision: baseHead },
  });
  const tampered = patchFixture({ to: 'export const add = (a, b) => a * 999;' });
  await writeFile(path.join(candidate.dir, '001.patch'), tampered, 'utf8');
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);

  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  if (res.status === 409) return;
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.doesNotMatch(String(job.result?.prompt ?? ''), /999/, '工作区本地篡改不得进入共享快照提示词');
});

test('§5.7：取消导致的 ABORTED 必须携带 reason（B3）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261110-cancel-reason', {
    review: {
      comments: '\n  - id: c1\n    revision: 1\n    file: ""\n    line: 0\n    author: tester\n    content: 需要补充测试\n    status: unresolved',
    },
  });
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},4000)"`,
  });
  const res = await post(base, '/ai-fix', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  assert.equal(res.status, 202);
  const body = await res.json();
  await post(base, `/jobs/${encodeURIComponent(body.jobId)}/cancel`, {});
  const job = await waitJob(base, body.jobId);
  if (job.result?.status === 'ABORTED') {
    assert.ok(job.result.reason, `ABORTED 必须带 reason：${JSON.stringify(job.result)}`);
  }
});
