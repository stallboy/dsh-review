import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

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

async function writeCandidate(root, base, humanHistory = false) {
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-rb');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', 'title: "net: 修复加法"', 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-05T09:00:00+08:00"', 'updated_at: "2026-11-05T09:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', `current_revision: ${humanHistory ? 2 : 1}`,
    'revisions:', `  - id: 1`, `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    ...(humanHistory ? ['  - id: 2', `    base_revision: "${base}"`, '    patch: 002.patch', '    author: human'] : []),
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: 修复加法"',
    '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), PATCH('+'), 'utf8');
  if (humanHistory) await writeFile(path.join(dir, '002.patch'), PATCH('+'), 'utf8');
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

  // 夹具的候选记录写入前的基线，提交候选本身就会让 HEAD 前进。
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
  assert.match(text, /base_revision: "?[0-9a-f]{40}"?/m);
  assert.match(text, /author: ai/);
  assert.match(text, /status: pending/);
  const bases = [...text.matchAll(/base_revision: "?([0-9a-f]{40})"?/g)].map((match) => match[1]);
  assert.equal(bases[bases.length - 1], newBase);
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
});

test('P8: 既有人工版本和补丁仍可读取，合法补丁也不能手工追加', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, base, true);
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiBase } = await startApi(root);
  const id = '2026-11/20261105-net-rb';
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout;
  const removed = await fetch(`${apiBase}/manual-revision`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id, expectedRevision: 2, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-05T09:00:00+08:00', patchText: PATCH('*'),
    }),
  });
  assert.equal(removed.status, 404, await removed.text());
  const detail = await fetch(`${apiBase}/candidate?id=${id}`);
  assert.equal(detail.status, 200);
  const { candidate, jobs } = await detail.json();
  assert.equal(candidate.meta.currentRevision, 2);
  assert.equal(candidate.meta.revisions[1].author, 'human');
  assert.deepEqual(jobs, []);
  const patch = await fetch(`${apiBase}/patch?id=${id}&name=002.patch`);
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).text, PATCH('+'));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout, head);
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout, '');
});
