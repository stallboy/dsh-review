import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createVcs } from '../dist/vcs.js';
import { resolveOwner } from '../dist/reviewers.js';
import { formatMemorySummary } from '../dist/memory.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** 第 3 轮：评论字段校验、Host anchor 兜底、manual Job/租约、Owner AND、负向记忆摘要、提交树核对。 */

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

function reviewMd(slug) {
  return [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-01T10:00:00+08:00"', 'updated_at: "2026-11-01T10:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: x"', '---', '', '# 问题与影响', '',
  ].join('\n');
}

const PATCH = [
  'diff --git a/src/math.js b/src/math.js',
  '--- a/src/math.js',
  '+++ b/src/math.js',
  '@@ -1 +1 @@',
  '-export const add = (a, b) => a - b;',
  '+export const add = (a, b) => a + b;',
  '',
].join('\n');

async function writeSharedCandidate(root, slug) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), reviewMd(slug), 'utf8');
  await writeFile(path.join(dir, '001.patch'), PATCH, 'utf8');
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

test('AC-API-01：行内评论缺 line / revision 不存在 → 422，且不写坏候选', async () => {
  const root = await createGitFixture();
  await writeSharedCandidate(root, '20261110-comment-check');
  const { base } = await startApi(root);

  const missingLine = await post(base, '/comments', {
    ...guard('20261110-comment-check'), content: '行内但缺行号', file: 'src/math.js', side: 'RIGHT',
  });
  assert.equal(missingLine.status, 422);

  const badRevision = await post(base, '/comments', {
    ...guard('20261110-comment-check'), content: '引用不存在版本', file: 'src/math.js', line: 1, side: 'RIGHT', revision: 99,
  });
  assert.equal(badRevision.status, 422);

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
    comments: [{ content: '合法' }, 'garbage'],
  });
  assert.equal(partial.status, 422);
  const before = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261110-batch-check')}`)).json();
  assert.equal(before.candidate.meta.comments.length, 0, '任一条非法时整批不得写入');

  const ok = await post(base, '/comments/batch', {
    ...guard('20261110-batch-check'),
    comments: [{ content: '行内意见', file: 'src/math.js', line: 1, side: 'RIGHT' }],
  });
  assert.equal(ok.status, 200);
  const after = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261110-batch-check')}`)).json();
  const comment = after.candidate.meta.comments[0];
  assert.equal(comment.file, 'src/math.js');
  assert.equal(comment.anchor?.snippet, 'export const add = (a, b) => a + b;');
});

test('§7.6/§8.3：/audit/manual 创建可追踪 audit Job；active 租约 release 409，取消后置 releasable', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root);
  const manual = await (await post(base, '/audit/manual', { targetPath: '', note: '' })).json();
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
    defaultOwner: 'default', rules: [], allowedGateCommands: [], staleDays: null,
    rejectionMemoryDays: 30, maxAntiPatterns: 20, verifyGateOnAuditFinalize: 'none', auditSmokeCommands: [],
  };
  const config = {
    ...base,
    rules: [
      { owner: 'A', paths: ['src/**'], tags: ['perf'] },
      { owner: 'B', paths: [], tags: ['net'] },
    ],
  };
  // A 只命中 paths，未命中 tags → 不参与；B 命中 tag → 胜出。
  assert.equal(resolveOwner(config, { paths: ['src/math.js'], tags: ['net'] }).owner, 'B');
  // 两者都命中 → A 按路径命中数胜出。
  assert.equal(resolveOwner(config, { paths: ['src/math.js'], tags: ['net', 'perf'] }).owner, 'A');
  assert.equal(resolveOwner({ ...base, rules: [] }, { paths: ['x'], tags: [] }).owner, 'default');
});

test('AC-MEMORY-01：负向记忆摘要包含 target_files/audit_type，未知分类归 unspecified', () => {
  const text = formatMemorySummary([{
    candidateId: '2026-11/x', module: 'net', title: '标题', targetFiles: ['src/a.ts'], auditType: 'bugfix',
    rejectedAt: '2026-11-01T00:00:00Z', rejectedAtMs: Date.now(), reason: '原因', category: 'unknown_category',
    fingerprint: '[]',
  }]);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /bugfix/);
  assert.match(text, /未分类/);
  assert.doesNotMatch(text, /### unknown_category/);
});

test('§7.7：取消运行中的 headless audit 会终止 Runner 进程并返回 ABORTED', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" -e "setTimeout(function(){},60000)"`,
  });
  const started = await post(base, '/audit', { targetPath: '', note: '' });
  assert.equal(started.status, 202);
  const startBody = await started.json();
  // 等 Job 真正进入 running，再取消。
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

test('§7.5 步骤 9：暂存 blob 与已验证内容不一致时拒绝提交并清空暂存', async () => {
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
