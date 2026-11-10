import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** P8 验收：§6.4 人工微调 / §6.5 Rebase——新版本追加、门禁重跑、失败不留半版本。 */

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
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

const PATCH = (sign) => [
  'diff --git a/src/math.js b/src/math.js',
  '--- a/src/math.js',
  '+++ b/src/math.js',
  '@@ -1 +1 @@',
  '-export const add = (a, b) => a - b;',
  `+export const add = (a, b) => a ${sign} b;`,
  '',
].join('\n');

async function writeCandidate(root, base) {
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-rb');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', 'title: "net: 修复加法"', 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-05T09:00:00+08:00"', 'updated_at: "2026-11-05T09:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', `  - id: 1`, `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: 修复加法"',
    '---', '', '# 问题与影响', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), PATCH('-'), 'utf8');
}

async function runJob(base, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const startBody = await response.json();
  if (response.status !== 202) return { httpStatus: response.status, body: startBody };
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const job = await (await fetch(`${base}/jobs/${startBody.jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return { httpStatus: 202, job };
  }
  throw new Error('job 超时');
}

test('P8: Rebase——基线落后时产生新版本（author ai）；基线最新时拒绝', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, base);
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiBase } = await startApi(root);

  // 基线最新（回写 base 为当前 HEAD）→ 拒绝。
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const fm = await readFile(path.join(root, '.ai-review', '2026-11', '20261105-net-rb', 'review.md'), 'utf8');
  await writeFile(path.join(root, '.ai-review', '2026-11', '20261105-net-rb', 'review.md'), fm.replace(`base_revision: "${base}"`, `base_revision: "${head}"`), 'utf8');
  const noop = await runJob(apiBase, '/rebase', { id: '2026-11/20261105-net-rb', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-05T09:00:00+08:00' });
  assert.match(noop.job.result.message, /无需 Rebase/);

  // 基线前进后 → Rebase 产生版本 2。
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);
  const newBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const ok = await runJob(apiBase, '/rebase', { id: '2026-11/20261105-net-rb', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-05T09:00:00+08:00' });
  assert.equal(ok.job.result.status, 'COMMITTED', JSON.stringify(ok.job.result));
  assert.equal(ok.job.result.newRevision, 2);
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-rb');
  assert.ok(existsSync(path.join(dir, '002.patch')));
  const text = await readFile(path.join(dir, 'review.md'), 'utf8');
  assert.match(text, /base_revision: "?[0-9a-f]{40}"?/m); // 版本 2 基线 = 新基线
  assert.match(text, /author: ai/);
  assert.match(text, /status: pending/);
  // 新基线与 HEAD 一致（取最后一个 revision 的基线）。
  const bases = [...text.matchAll(/base_revision: "?([0-9a-f]{40})"?/g)].map((match) => match[1]);
  assert.equal(bases[bases.length - 1], newBase);
  // 工作区保持干净（业务代码未被留下改动）。
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
});

test('P8: 人工微调——补丁可应用且门禁通过时产生版本（author human）；坏补丁不留半版本', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, base);
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiBase } = await startApi(root);
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-rb');

  // 坏补丁 → ABORTED，不产生 002.patch。
  const bad = await runJob(apiBase, '/manual-revision', {
    id: '2026-11/20261105-net-rb', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-05T09:00:00+08:00',
    patchText: 'not a patch\n',
  });
  assert.equal(bad.job.result.status, 'ABORTED');
  assert.ok(!existsSync(path.join(dir, '002.patch')));

  // 好补丁 → 版本 2，author human，回 pending。
  const ok = await runJob(apiBase, '/manual-revision', {
    id: '2026-11/20261105-net-rb', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-05T09:00:00+08:00',
    patchText: PATCH('+'),
  });
  assert.equal(ok.job.result.status, 'COMMITTED', JSON.stringify(ok.job.result));
  assert.equal(ok.job.result.newRevision, 2);
  const text = await readFile(path.join(dir, 'review.md'), 'utf8');
  assert.match(text, /author: human/);
  const patch2 = await readFile(path.join(dir, '002.patch'), 'utf8');
  assert.match(patch2, /\+export const add = \(a, b\) => a \+ b;/);
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
});
