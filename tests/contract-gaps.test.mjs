import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

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

const guard = (over = {}) => ({
  expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-09T10:00:00+08:00', ...over,
});

async function writeCandidate(root, slug, status = 'pending') {
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const patchText = [
    'diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js',
    '@@ -1 +1 @@ function add(a, b)', '-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;', '',
  ].join('\n');
  await writeSchemaCandidate(root, slug, {
    patchText,
    review: {
      baseRevision: base,
      createdAt: '2026-11-09T10:00:00+08:00',
      updatedAt: '2026-11-09T10:00:00+08:00',
      status,
      ...(status === 'rejected' ? {
        rejection: '\n  rejected_by: tester\n  rejected_at: "2026-11-09T11:00:00+08:00"\n  reason: "不采用"',
      } : {}),
    },
  });
}

test('G38：/finding/decision accept_as_is 携带 category 并提取 related_symbols；已废止 /reject 返回 404', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-cat');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const gone = await fetch(`${base}/reject`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-cat', ...guard(), reason: '旧路由' }),
  });
  assert.equal(gone.status, 404);

  const ok = await fetch(`${base}/finding/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-cat',
      ...guard(),
      action: 'accept_as_is',
      reason: '方案有回归风险',
      category: 'high_risk',
    }),
  });
  assert.equal(ok.status, 200);
  const text = await readFile(path.join(root, '.ai-review', '2026-11', '20261109-cat', 'review.md'), 'utf8');
  assert.match(text, /category: high_risk/);
  assert.match(text, /related_symbols:/);
  assert.match(text, /add/);
});

test('G22：已废止 /dismiss-finding 返回 404；confirm 问题通过 /finding/decision accept_as_is 关闭并留痕', async () => {
  const root = await createGitFixture();
  await writeSchemaCandidate(root, '20261109-confirm', {
    review: {
      findingId: 'auth-legacy',
      issueKind: 'confirm',
      patches: ' []',
      options: ' []',
      commitMessage: null,
      createdAt: '2026-11-09T10:00:00+08:00',
      updatedAt: '2026-11-09T10:00:00+08:00',
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const gone = await fetch(`${base}/dismiss-finding`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: '20261109-120000-repo', findingId: 'auth-legacy', reason: '旧路由' }),
  });
  assert.equal(gone.status, 404);

  const badReason = await fetch(`${base}/finding/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-confirm', ...guard(), action: 'accept_as_is', reason: '  ' }),
  });
  assert.equal(badReason.status, 422);

  const ok = await fetch(`${base}/finding/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261109-confirm', ...guard(), action: 'accept_as_is', reason: '确认不再处理' }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.candidate.meta.status, 'rejected');
  assert.equal(body.candidate.meta.rejection.reason, '确认不再处理');
});

test('G40：/candidate 返回 patchCheck 三态诊断（clean，含 checkedBase/checkedAt）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-pc');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261109-pc')}`)).json();
  assert.equal(detail.patchCheck?.state, 'clean', JSON.stringify(detail.patchCheck));
  assert.ok(detail.patchCheck?.checkedBase);
  assert.ok(detail.patchCheck?.checkedAt);
});
