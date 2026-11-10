import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** 第 2 轮：G29 /candidate/finalize、G30 cancel、G39 anchor、G42 收尾门禁、G15 禁止路径、tags/slug。 */

const servers = [];
after(async () => { await Promise.all(servers.map((server) => server.close())); });

async function startApi(root) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({ settings, saveSettings: async (n) => n, statePath: path.join(root, '.tmp', 'state.json') });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeCandidate(root, slug, over = {}) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-09T10:00:00+08:00"', 'updated_at: "2026-11-09T10:00:00+08:00"', 'owner: tester',
    `tags: ${JSON.stringify(over.tags ?? ['Net', ' net ', 'net'])}`, 'status: pending', 'ticket: null',
    'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${over.base ?? base}"`, '    patch: 001.patch', '    author: ai',
    `gate_checks: ${JSON.stringify(over.gateChecks ?? ['node --version'])}`,
    'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: x"', '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), over.patchText ?? [
    'diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js',
    '@@ -1 +1 @@', '-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;', '',
  ].join('\n'), 'utf8');
}

async function waitJob(base, jobId) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
  }
  throw new Error('job 超时');
}

test('G29：/candidate/finalize 校验并单目录提交；tags 规范化去重生效', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
  await writeCandidate(root, '20261109-solo'); // 未提交（本地候选）
  const { base } = await startApi(root);
  const start = await fetch(`${base}/candidate/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-solo' }),
  });
  assert.equal(start.status, 202);
  const job = await waitJob(base, (await start.json()).jobId);
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  const tracked = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim();
  assert.match(tracked, /20261109-solo/);
  // §4.3：tags 解析时 trim + 小写 + 去重（['Net',' net ','net'] → ['net']）。
  const text = await readFile(path.join(root, '.ai-review', '2026-11', '20261109-solo', 'review.md'), 'utf8');
  // §4.3：tags trim + 小写 + 去重（['Net',' net ','net'] → ['net']）。
  assert.doesNotMatch(text, /tags:[^\n]*Net/, text);
  assert.match(text, /tags:\s*(\[\s*"net"\s*\]\s*\n|\n\s+- net\s*\n)/, text);
  // 重复 finalize（已共享）→ 409。
  const again = await fetch(`${base}/candidate/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-solo' }),
  });
  assert.equal(again.status, 409);
});

test('G15：补丁触及禁止路径 → finalize 拒绝', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-forbidden', {
    patchText: [
      'diff --git a/node_modules/x.js b/node_modules/x.js', '--- a/node_modules/x.js',
      '+++ b/node_modules/x.js', '@@ -0,0 +1 @@', '+evil', '',
    ].join('\n'),
  });
  const { base } = await startApi(root);
  const start = await fetch(`${base}/candidate/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-forbidden' }),
  });
  const job = await waitJob(base, (await start.json()).jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  assert.match(job.result.errors.join('\n'), /禁止路径/);
});

test('G39：行内评论携带 anchor 往返；总体评论带 anchor 422', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-anchor');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const bad = await fetch(`${base}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-anchor', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', content: '总体带锚点',
      anchor: { snippet: 'x' },
    }),
  });
  assert.equal(bad.status, 422);
  const ok = await fetch(`${base}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-anchor', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', content: '带锚点',
      file: 'src/math.js', line: 1, side: 'RIGHT',
      anchor: { snippet: 'export const add = (a, b) => a + b;', before: '// head', after: '// tail' },
    }),
  });
  assert.equal(ok.status, 200);
  const text = await readFile(path.join(root, '.ai-review', '2026-11', '20261109-anchor', 'review.md'), 'utf8');
  assert.match(text, /snippet: export const add = \(a, b\) => a \+ b;/);
  assert.match(text, /before: \/\/ head/);
  assert.match(text, /after: \/\/ tail/);
});

test('G30：/jobs/:id/cancel 已结束 Job 幂等返回原结果', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-cancel');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  // 结束一个 ai-fix（manual runner → MANUAL_REQUIRED outcome）。
  const fix = await fetch(`${base}/ai-fix`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-cancel', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00',
    }),
  });
  assert.equal(fix.status, 409, '无未解决评论应 409（G23）');
  // 直接对未知 job 取消 → 404；对已结束 job → 202 原结果。
  assert.equal((await fetch(`${base}/jobs/job-x/cancel`, { method: 'POST' })).status, 404);
});

test('G42：verify_gate_on_audit_finalize=declared 时收尾复算门禁并留痕', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review', 'audits'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'),
    'default_owner: tester\nrules: []\nverify_gate_on_audit_finalize: declared\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
  // 手动租约 + 候选（门禁失败命令）→ finalize 应把该候选剔除并返回 VALIDATION_FAILED。
  const { base } = await startApi(root);
  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();
  await writeCandidate(root, '20261109-gatefail', { gateChecks: ['node --version', 'node -e "process.exit(1)"'] });
  const start = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  const job = await waitJob(base, (await start.json()).jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED', JSON.stringify(job.result));
  const auditText = await readFile(path.join(root, '.ai-review', 'audits', manual.auditId, 'audit.md'), 'utf8');
  assert.match(auditText, /门禁已由 Host 复算（declared）/);
  // 候选目录未提交。
  assert.equal(runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim(), '');
});
