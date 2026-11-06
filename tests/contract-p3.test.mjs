import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { ReviewStore } from '../dist/store.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

/** P3 验收：§18.1 超时归档——队列只提示；显式归档写 system:stale；只写一次；未过期拒绝。 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'external',
    externalCommand: `"${process.execPath}" "${fakeAuditAgentPath()}"`,
    syncBeforeApprove: false,
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

async function writeCandidate(root, slug, updatedAt) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---',
    'schema_version: 1',
    `title: "net: ${slug}"`,
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-01T10:00:00+08:00"',
    `updated_at: "${updatedAt}"`,
    'owner: tester',
    'tags: []',
    'status: pending',
    'ticket: null',
    'target_files: [src/math.js]',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    'gate_checks: ["node --version"]',
    'comments: []',
    'human_decisions: []',
    'approval: null',
    'rejection: null',
    'commit_message: "net: x"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    '',
  ].join('\n'), 'utf8');
}

const HEAD_BEFORE = 'HEAD@{0}';

test('P3: 队列只提示过期，不产生共享提交', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const freshIso = new Date(Date.now() - 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', staleIso);
  await writeCandidate(root, '20261104-net-fresh', freshIso);
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
    'default_owner: tester',
    'stale_days: 14',
    '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const commitBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const { base: apiUrl } = await startApi(root);
  const queue = await (await fetch(`${apiUrl}/queue`)).json();
  const staleItem = queue.items.find((item) => item.id.endsWith('net-stale'));
  const freshItem = queue.items.find((item) => item.id.endsWith('net-fresh'));
  assert.equal(staleItem?.isStale, true);
  assert.equal(freshItem?.isStale, undefined);
  // 读队列不产生共享提交。
  const commitAfter = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.equal(commitAfter, commitBefore);
  assert.notEqual(base, HEAD_BEFORE);
});

test('P3: 显式归档写 system:stale + 删补丁 + 只写一次；未过期候选拒绝归档', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const freshIso = new Date(Date.now() - 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', staleIso);
  await writeCandidate(root, '20261104-net-fresh', freshIso);
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nstale_days: 14\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base: apiUrl } = await startApi(root);
  const staleDir = path.join(root, '.ai-review', '2026-11', '20261104-net-stale');

  // 未过期候选：409 拒绝。
  const tooFresh = await fetch(`${apiUrl}/archive-stale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-fresh', expectedRevision: 1, expectedOwner: 'tester' }),
  });
  assert.equal(tooFresh.status, 409);
  assert.match((await tooFresh.json()).error.message, /未超过 stale_days/);

  // 过期候选：归档成功，rejection=system:stale，补丁删除。
  const ok = await fetch(`${apiUrl}/archive-stale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-stale', expectedRevision: 1, expectedOwner: 'tester' }),
  });
  assert.equal(ok.status, 200);
  const { candidate } = await ok.json();
  assert.equal(candidate.meta.status, 'rejected');
  assert.equal(candidate.meta.rejection.rejectedBy, 'system:stale');
  assert.match(candidate.meta.rejection.reason, /超时/);
  assert.ok(!existsSync(path.join(staleDir, '001.patch')), '归档后补丁应删除');

  // 第二次归档：终态拒绝（乐观锁 + 已归档），只写一次。
  const again = await fetch(`${apiUrl}/archive-stale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-stale', expectedRevision: 1, expectedOwner: 'tester' }),
  });
  assert.equal(again.status, 409);

  // store 层直读验证 rejection 留痕。
  const store = new ReviewStore(root);
  const detail = await store.get('2026-11/20261104-net-stale', null);
  assert.equal(detail.candidate.meta.rejection.rejectedBy, 'system:stale');
});

test('P3: 未配置 stale_days 时归档被拒绝', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', staleIso);
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiUrl } = await startApi(root);
  const response = await fetch(`${apiUrl}/archive-stale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-stale', expectedRevision: 1, expectedOwner: 'tester' }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /stale_days/);
});
