import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { resolveOwner } from '../packages/dsh-plugin/dist/host/reviewers.js';
import { formatMemorySummary } from '../packages/dsh-plugin/dist/host/memory.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, settingsPatch = {}) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false, ...settingsPatch };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeSharedCandidate(root, slug) {
  await writeCandidate(root, slug);
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
}

const guard = (slug) => ({
  id: `2026-11/${slug}`,
  expectedRevision: 1,
  expectedOwner: 'tester',
  expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
});

const post = async (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('AC-API-01：行内评论缺 line / revision 不存在 / 缺 optionId → 422，且不写坏候选', async () => {
  const root = await createGitFixture();
  await writeSharedCandidate(root, '20261110-comment-check');
  const { base } = await startApi(root);

  const missingLine = await post(base, '/comments', {
    ...guard('20261110-comment-check'), optionId: 'opt-a', patchId: 1, content: '行内但缺行号', file: 'src/math.js', side: 'RIGHT',
  });
  assert.equal(missingLine.status, 422);

  const badRevision = await post(base, '/comments', {
    ...guard('20261110-comment-check'), optionId: 'opt-a', patchId: 1, content: '引用不存在版本', file: 'src/math.js', line: 1, side: 'RIGHT', revision: 99,
  });
  assert.equal(badRevision.status, 422);

  const missingOption = await post(base, '/comments', {
    ...guard('20261110-comment-check'), content: '缺方案归属', file: 'src/math.js', line: 1, side: 'RIGHT',
  });
  assert.equal(missingOption.status, 422);

  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261110-comment-check')}`)).json();
  assert.equal(detail.candidate.parseError, undefined, '非法评论不得写入共享事实');
  assert.equal(detail.candidate.meta.comments.length, 0);
});

test('AC-API-01：/comments/batch 全有或全无，且 Host 为行内评论兜底提取 anchor', async () => {
  const root = await createGitFixture();
  await writeSharedCandidate(root, '20261110-batch-check');
  const { base } = await startApi(root);

  const partial = await post(base, '/comments/batch', {
    ...guard('20261110-batch-check'),
    optionId: 'opt-a',
    patchId: 1,
    comments: [{ content: '合法' }, 'garbage'],
  });
  assert.equal(partial.status, 422);
  const before = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261110-batch-check')}`)).json();
  assert.equal(before.candidate.meta.comments.length, 0, '任一条非法时整批不得写入');

  const ok = await post(base, '/comments/batch', {
    ...guard('20261110-batch-check'),
    optionId: 'opt-a',
    patchId: 1,
    comments: [{ content: '行内意见', file: 'src/math.js', line: 1, side: 'RIGHT' }],
  });
  assert.equal(ok.status, 200);
  const after = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261110-batch-check')}`)).json();
  const comment = after.candidate.meta.comments[0];
  assert.equal(comment.file, 'src/math.js');
  assert.equal(comment.optionId, 'opt-a');
  assert.equal(comment.patchId, 1);
  assert.equal(comment.anchor?.snippet, 'export const add = (a, b) => a + b;');
});

test('§6.3：/audit/manual 创建可追踪 audit Job；active 租约 release 409，取消后置 releasable', async () => {
  const root = await createGitFixture();
  await writeSharedCandidate(root, '20261110-manual-lease');
  const { base } = await startApi(root);
  const manualRes = await post(base, '/audit/manual', { targetPath: '', note: '' });
  assert.equal(manualRes.status, 202);
  const manual = await manualRes.json();
  assert.ok(manual.jobId, 'manual 必须返回 jobId');
  assert.equal(manual.job?.type, 'audit');

  const active = await post(base, '/audit/release', { auditId: manual.auditId, confirmStopped: true });
  assert.equal(active.status, 409);

  const cancelled = await post(base, `/jobs/${encodeURIComponent(manual.jobId)}/cancel`, {});
  assert.equal(cancelled.status, 202);
  const released = await post(base, '/audit/release', { auditId: manual.auditId, confirmStopped: true });
  assert.equal(released.status, 200);
});

test('AC-ROUTING-01：reviewers 规则 paths+tags 必须 AND 命中才参与', () => {
  const base = {
    defaultOwner: 'default', rules: [], staleDays: 14,
    rejectionMemoryDays: 30, maxAntiPatterns: 20, exists: true, valid: true, errors: [],
  };
  const config = {
    ...base,
    rules: [
      { owner: 'A', paths: ['src/**'], tags: ['perf'] },
      { owner: 'B', paths: [], tags: ['net'] },
    ],
  };
  assert.equal(resolveOwner(config, { paths: ['src/math.js'], tags: ['net'] }).owner, 'B');
  assert.equal(resolveOwner(config, { paths: ['src/math.js'], tags: ['net', 'perf'] }).owner, 'A');
  assert.equal(resolveOwner({ ...base, rules: [] }, { paths: ['x'], tags: [] }).owner, 'default');
});

test('AC-MEMORY-01：负向记忆摘要包含 target_files/audit_type，未知分类归 unspecified', () => {
  const text = formatMemorySummary([{
    candidateId: '2026-11/x', findingId: 'fx', module: 'net', title: '标题', targetFiles: ['src/a.ts'], auditType: 'bugfix',
    rejectedAt: '2026-11-01T00:00:00Z', rejectedAtMs: Date.now(), reason: '原因', category: 'unspecified',
    relatedSymbols: [], fingerprint: '[]',
  }]);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /bugfix/);
  assert.match(text, /unspecified/);
});

test('§5.7：取消运行中的 headless audit 会终止 Runner 进程并返回 ABORTED', async () => {
  const root = await createGitFixture();
  await writeSharedCandidate(root, '20261110-cancel-audit');
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},60000)"`,
  });
  const started = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(started.status, 202);
  const startBody = await started.json();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const begin = Date.now();
  const cancelled = await post(base, `/jobs/${encodeURIComponent(startBody.jobId)}/cancel`, {});
  assert.equal(cancelled.status, 202);
  let job;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(startBody.jobId)}`)).json();
    if (job.status !== 'running') break;
  }
  assert.notEqual(job?.status, 'running', '取消后 Job 必须结束（进程已终止）');
  assert.equal(job?.result?.status, 'ABORTED');
  assert.ok(Date.now() - begin < 20_000, '取消必须实际终止进程，而非等待 60s 超时');
});

test('§5.5：暂存 blob 与已验证内容不一致时拒绝提交并清空暂存', async () => {
  const root = await createGitFixture();
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  const vcs = createVcs('git', root);
  const result = await vcs.atomicCommit({
    message: 'should be rejected',
    paths: ['src/math.js'],
    verifyEntries: [{ path: 'src/math.js', blobHash: 'deadbeef' }],
  });
  assert.equal(result.success, false);
  assert.match(result.errorOutput, /不一致/);
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, 'M src/math.js', '工作区改动保留但不得被提交');
});
