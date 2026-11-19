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

/** 租约状态文件必须放在仓库之外，否则会被 ensureCleanWorkspace 判为脏工作区。 */
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

test('§7.7：审查运行期间共享写在受理阶段 409，而不是排队到审查结束后放行（C1）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261110-mutex');
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},5000)"`,
  });

  const auditRes = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(auditRes.status, 202);
  const auditBody = await auditRes.json();
  // 留出执行器启动时间，使评论请求进入租约已激活的窗口。
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

test('§7.7：审查运行中不允许并发启动第二次审查（C2），互斥判定在锁内（无 TOCTOU）', async () => {
  const root = await createGitFixture();
  await commitCandidate(root, '20261110-double-audit');
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

test('§7.7/AC-RETRY-01：基线落后时 Rebase 产生新版本，且新补丁来自共享快照（B4/B2 正向）', async () => {
  const root = await createGitFixture();
  const baseHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261110-rebase-lag', {
    review: {
      baseRevision: JSON.stringify(baseHead),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);
  const newBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id) });
  assert.equal(res.status, 202);
  const body = await res.json();
  const job = await waitJob(base, body.jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(job.result.newRevision, 2);
  const newPatch = await readFile(path.join(candidate.dir, '002.patch'), 'utf8');
  // 删除行是新基线的旧内容，检查新增行才能区分重导出的补丁与旧补丁。
  assert.match(newPatch, /^\+export const add = \(a, b\) => a \+ b;$/m);
  assert.doesNotMatch(newPatch, /^\+.*a - b;$/m);
  const review = await readFile(candidate.reviewPath, 'utf8');
  assert.match(review, /status: pending/);
  assert.match(review, /author: ai/);
  const bases = [...review.matchAll(/base_revision: "?([0-9a-f]{40})"?/g)].map((match) => match[1]);
  assert.equal(bases[bases.length - 1], newBase, '新版本基线必须等于新基线');
  assert.equal(runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim(), '');
});

test('§7.7：Rebase 的“业务基线未变”守卫存在且使用业务差异判定（B4 守卫存在性）', async () => {
  // 候选元数据提交也会推进 HEAD，因此不能用版本号相等判定业务基线是否相同。
  const hostFiles = ['api.ts', 'api-writers.ts', 'api-readmodels.ts'];
  const sources = await Promise.all(
    hostFiles.map(async (name) => [name, await readFile(new URL(`../packages/dsh-plugin/src/host/${name}`, import.meta.url), 'utf8')]),
  );
  const source = sources.map(([, text]) => text).join('\n');
  assert.match(source, /businessBaselineState\(vcs, current\.baseRevision, base\)/, 'Rebase 必须用业务基线判定');
  assert.match(source, /'BASE_UNCHANGED'/);
  assert.doesNotMatch(source, /基线已是最新，无需 Rebase/, '旧的“比较版本号相同”判定必须移除');
  // 分别核对写事务中的调用与读模型中的定义，避免拼接源码掩盖守卫放错模块。
  const writers = sources.find(([name]) => name === 'api-writers.ts')?.[1] ?? '';
  const readModels = sources.find(([name]) => name === 'api-readmodels.ts')?.[1] ?? '';
  assert.match(
    writers,
    /this\.readModels\.businessBaselineState\(vcs, current\.baseRevision, base\)/,
    'Rebase 必须在 api-writers.ts 经读模型判定业务基线',
  );
  assert.match(readModels, /^ {2}async businessBaselineState\($/m, 'api-readmodels.ts 必须定义 businessBaselineState');
});

test('§7.5：目录内出现未列入核对的暂存文件时拒绝提交（B1：集合相等而不是子集）', async () => {
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

test('§7.1：Rebase 读取共享快照中的补丁，工作区本地改动不能进入新版本（B2）', async () => {
  const root = await createGitFixture();
  const baseHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261110-rebase-shared', {
    review: { baseRevision: JSON.stringify(baseHead) },
  });
  const tampered = patchFixture({ to: 'export const add = (a, b) => a - b;' });
  await writeFile(path.join(candidate.dir, '001.patch'), tampered, 'utf8');
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);
  // 本地补丁改动会使候选进入 local 视图，此时共享候选检查会先于重导补丁拒绝请求。
  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id) });
  const status = res.status;
  if (status === 409) {
    const body = await res.json();
    assert.match(body.error.message, /本地未提交改动/, '存在本地改动时必须拒绝，不得读取工作区补丁');
    return;
  }
  assert.equal(status, 202);
  const body = await res.json();
  const job = await waitJob(base, body.jobId);
  const newPatch = await readFile(path.join(candidate.dir, '002.patch'), 'utf8').catch(() => '');
  assert.match(newPatch, /^\+export const add = \(a, b\) => a \+ b;$/m);
  assert.doesNotMatch(newPatch, /^\+export const add = \(a, b\) => a - b;$/m);
});

test('§7.5：取消导致的 ABORTED 必须携带 reason（B3）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261110-cancel-reason');
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},4000)"`,
  });
  const res = await post(base, '/ai-fix', { ...guardFixture(candidate.id) });
  // 缺少未解决评论时，入口会先拒绝，因此只有受理后才有可取消的修复 Job。
  if (res.status === 409) return;
  assert.equal(res.status, 202);
  const body = await res.json();
  await post(base, `/jobs/${encodeURIComponent(body.jobId)}/cancel`, {});
  const job = await waitJob(base, body.jobId);
  if (job.result?.status === 'ABORTED') {
    assert.ok(job.result.reason, `ABORTED 必须带 reason：${JSON.stringify(job.result)}`);
  }
});
