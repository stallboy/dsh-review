import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

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

test('P3: 队列只提示过期（isStale），不产生共享提交', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const freshIso = new Date(Date.now() - 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', { review: { createdAt: staleIso, updatedAt: staleIso } });
  await writeCandidate(root, '20261104-net-fresh', { review: { createdAt: freshIso, updatedAt: freshIso } });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nstale_days: 14\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const commitBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const { base: apiUrl } = await startApi(root);
  const queue = await (await fetch(`${apiUrl}/queue`)).json();
  const staleItem = queue.items.find((item) => item.id.endsWith('net-stale'));
  const freshItem = queue.items.find((item) => item.id.endsWith('net-fresh'));
  assert.equal(staleItem?.isStale, true);
  assert.equal(freshItem?.isStale, undefined);
  const commitAfter = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.equal(commitAfter, commitBefore);
});

test('P3: 已废止 /archive-stale 返回 404；使用 /finding/decision defer + accept_as_is 替代且保留不可变补丁', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', { review: { createdAt: staleIso, updatedAt: staleIso } });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nstale_days: 14\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base: apiUrl } = await startApi(root);
  const staleDir = path.join(root, '.ai-review', '2026-11', '20261104-net-stale');

  const gone = await fetch(`${apiUrl}/archive-stale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-stale', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: staleIso }),
  });
  assert.equal(gone.status, 404);

  const accepted = await fetch(`${apiUrl}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-net-stale',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: staleIso,
      action: 'accept_as_is',
      reason: '长期过期且已无必要修改',
      category: 'out_of_scope',
    }),
  });
  assert.equal(accepted.status, 200);
  const { candidate } = await accepted.json();
  assert.equal(candidate.meta.status, 'rejected');
  assert.equal(candidate.meta.rejection.rejectedBy, 'tester');
  assert.equal(candidate.meta.rejection.category, 'out_of_scope');
  assert.ok(existsSync(path.join(staleDir, '001.patch')), 'SPEC §3.1：历史补丁必须永久保留，不得删除');

  const store = new ReviewStore(root);
  const detail = await store.get('2026-11/20261104-net-stale', null);
  assert.equal(detail.candidate.meta.rejection.reason, '长期过期且已无必要修改');
});

test('P3: 未配置 stale_days 时按 SPEC 默认 14 天提示过期，defer 延期暂停后阻断批准', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const freshIso = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-stale', { review: { createdAt: staleIso, updatedAt: staleIso } });
  await writeCandidate(root, '20261104-net-fresh', { review: { createdAt: freshIso, updatedAt: freshIso } });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiUrl } = await startApi(root);

  const queue = await (await fetch(`${apiUrl}/queue`)).json();
  assert.equal(queue.items.find((item) => item.id.endsWith('net-stale'))?.isStale, true);
  assert.equal(queue.items.find((item) => item.id.endsWith('net-fresh'))?.isStale, undefined);

  const deferred = await fetch(`${apiUrl}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-net-stale',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: staleIso,
      action: 'defer',
      reason: '等下个迭代再处理',
    }),
  });
  assert.equal(deferred.status, 200);
  const deferredBody = await deferred.json();
  const blockedApprove = await fetch(`${apiUrl}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-net-stale',
      expectedRevision: deferredBody.candidate.meta.recordRevision,
      expectedOwner: 'tester',
      expectedUpdatedAt: deferredBody.candidate.meta.updatedAt,
      optionId: 'opt-a',
      patchId: 1,
    }),
  });
  assert.equal(blockedApprove.status, 409);
  assert.match((await blockedApprove.json()).error.message, /延期|defer/);
});
