import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** G38（拒绝分类/相关符号）、G22（/dismiss-finding）、G40（patchCheck）验收。 */

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
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-09T10:00:00+08:00"', 'updated_at: "2026-11-09T10:00:00+08:00"', 'owner: tester',
    'tags: []', `status: ${status}`, 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${base}"`, '    patch: 001.patch', 'author: ai'.replace('author', '    author'),
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null',
    ...(status === 'rejected' ? ['rejection:', '  rejected_by: tester', '  rejected_at: "2026-11-09T11:00:00+08:00"', '  reason: "不采用"'] : ['rejection: null']),
    'commit_message: "net: x"', '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js',
    '@@ -1 +1 @@ func add', '-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;', '',
  ].join('\n'), 'utf8');
}

test('G38：/reject 携带 category 并提取 related_symbols；人工 stale 被拒', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-cat');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const post = (body) => fetch(`${base}/reject`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: '2026-11/20261109-cat', ...guard(), ...body }),
  });
  // 人工使用 stale → 422。
  assert.equal((await post({ reason: 'x', category: 'stale' })).status, 422);
  // 合法分类 → 留痕 category 与 hunk header 提取的相关符号。
  const ok = await post({ reason: '方案有回归风险', category: 'high_risk' });
  assert.equal(ok.status, 200);
  const text = await readFile(path.join(root, '.ai-review', '2026-11', '20261109-cat', 'review.md'), 'utf8');
  assert.match(text, /category: high_risk/);
  assert.match(text, /related_symbols:/);
});

test('G22：/dismiss-finding 仅最新观察 pending 可忽略并留痕；旧观察/非 pending 拒绝', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-fc', 'rejected');
  // 两份档案：旧观察 1100、最新观察 1200，同 finding。
  const mk = async (auditId, createdAt) => {
    const dir = path.join(root, '.ai-review', 'audits', auditId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'audit.md'), [
      '---', 'schema_version: 1', `audit_id: ${auditId}`, `created_at: "${createdAt}"`,
      'base_revision: "1"', 'scope: .', 'trigger: manual', 'previous_audit: null', 'candidates: []',
      'items:', '  - finding_id: auth-legacy', '    kind: confirm', '    title: "旧适配层"', '    summary: "需要拍板。"',
      '    target_files: [src/math.js]', '    depends_on: null', '    status: pending', '    candidate: null', '---', '',
    ].join('\n'), 'utf8');
  };
  await mk('20261109-110000-repo', '2026-11-09T11:00:00Z');
  await mk('20261109-120000-repo', '2026-11-09T12:00:00Z');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const dismiss = (body) => fetch(`${base}/dismiss-finding`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  // 旧观察 → 409。
  assert.equal((await dismiss({ auditId: '20261109-110000-repo', findingId: 'auth-legacy', reason: 'x' })).status, 409);
  // 缺理由 → 422。
  assert.equal((await dismiss({ auditId: '20261109-120000-repo', findingId: 'auth-legacy', reason: '  ' })).status, 422);
  // 最新观察 pending → 200，正文留痕。
  const ok = await dismiss({ auditId: '20261109-120000-repo', findingId: 'auth-legacy', reason: '确认不再处理' });
  assert.equal(ok.status, 200);
  const text = await readFile(path.join(root, '.ai-review', 'audits', '20261109-120000-repo', 'audit.md'), 'utf8');
  assert.match(text, /dismiss auth-legacy：确认不再处理/);
  assert.match(text, /status: dismissed/);
  // 重复忽略 → 409（非 pending）。
  assert.equal((await dismiss({ auditId: '20261109-120000-repo', findingId: 'auth-legacy', reason: 'again' })).status, 409);
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
