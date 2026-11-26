import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { patchFixture, reviewFixture, sha256Hex, writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

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
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const gates = over.gateChecks ? `[${over.gateChecks.map((g) => JSON.stringify(g)).join(', ')}]` : '["node --version"]';
  return writeSchemaCandidate(root, slug, {
    ...(over.patchText ? { patchText: over.patchText } : {}),
    review: {
      baseRevision: over.base ?? base,
      createdAt: '2026-11-09T10:00:00+08:00',
      updatedAt: '2026-11-09T10:00:00+08:00',
      tags: JSON.stringify(over.tags ?? ['net']),
      gateChecks: gates,
    },
  });
}

async function waitJob(base, jobId) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 150));
    const job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
  }
  throw new Error('job 超时');
}

test('G29：/candidate/finalize 校验 Mode B 追加新补丁并原子提交', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-solo');
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const dir = path.join(root, '.ai-review', '2026-11', '20261109-solo');
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const p1 = patchFixture();
  const p2 = patchFixture({ to: 'export const add = (a, b) => Number(a) + Number(b);' });
  await writeFile(path.join(dir, '002.patch'), p2, 'utf8');
  await writeFile(path.join(dir, 'review.md'), reviewFixture('20261109-solo', {
    baseRevision: base,
    createdAt: '2026-11-09T10:00:00+08:00',
    updatedAt: '2026-11-09T10:05:00+08:00',
    recordRevision: 2,
    patches: [
      '',
      '  - id: 1',
      '    patch: 001.patch',
      '    option_id: opt-a',
      `    base_revision: "${base}"`,
      '    author: ai',
      `    sha256: "${sha256Hex(p1)}"`,
      '  - id: 2',
      '    patch: 002.patch',
      '    option_id: opt-a',
      `    base_revision: "${base}"`,
      '    author: ai',
      `    sha256: "${sha256Hex(p2)}"`,
    ].join('\n'),
    options: [
      '',
      '  - id: opt-a',
      '    title: 方案 A',
      '    tradeoff: 改动小',
      '    confidence: 0.9',
      '    current_patch: 2',
      '    gate_checks: ["node --version"]',
    ].join('\n'),
  }), 'utf8');

  const { base: apiBase } = await startApi(root);
  const start = await fetch(`${apiBase}/candidate/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-solo',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00',
      optionId: 'opt-a',
      patchId: 1,
    }),
  });
  assert.equal(start.status, 202);
  const job = await waitJob(apiBase, (await start.json()).jobId);
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(job.result.newPatchId, 2);
  const tracked = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim();
  assert.match(tracked, /002\.patch/);
});

test('G15：新补丁触及禁止路径 → finalize 拒绝（VALIDATION_FAILED）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-forbidden');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const dir = path.join(root, '.ai-review', '2026-11', '20261109-forbidden');
  const badPatch = [
    'diff --git a/.ai-review/evil.md b/.ai-review/evil.md',
    '--- a/.ai-review/evil.md',
    '+++ b/.ai-review/evil.md',
    '@@ -0,0 +1 @@',
    '+evil',
    '',
  ].join('\n');
  await writeFile(path.join(dir, '002.patch'), badPatch, 'utf8');
  const { base } = await startApi(root);
  const start = await fetch(`${base}/candidate/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-forbidden',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00',
      optionId: 'opt-a',
      patchId: 1,
    }),
  });
  const job = await waitJob(base, (await start.json()).jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  assert.ok(job.result.errors.length > 0);
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
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', optionId: 'opt-a', patchId: 1,
      content: '带锚点', file: 'src/math.js', line: 1, side: 'RIGHT',
      anchor: { snippet: 'export const add = (a, b) => a + b;', before: '// head', after: '// tail' },
    }),
  });
  assert.equal(ok.status, 200);
  const text = await readFile(path.join(root, '.ai-review', '2026-11', '20261109-anchor', 'review.md'), 'utf8');
  assert.match(text, /snippet: export const add = \(a, b\) => a \+ b;/);
  assert.match(text, /before: \/\/ head/);
  assert.match(text, /after: \/\/ tail/);
});

test('G30：无未解决评论 /ai-fix 409；未知 Job 取消返回 404', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-cancel');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const fix = await fetch(`${base}/ai-fix`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-cancel', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', optionId: 'opt-a', patchId: 1,
    }),
  });
  assert.equal(fix.status, 409);
  assert.equal((await fetch(`${base}/jobs/job-x/cancel`, { method: 'POST' })).status, 404);
});

test('AC-AUDIT-NO-APPLY：审查收尾绝不应用待审补丁或执行修复门禁', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review', 'audits'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
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
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  assert.deepEqual(job.result.created[0].errors, []);
  assert.match(await readFile(path.join(root, 'src/math.js'), 'utf8'), /=> a - b/);
  assert.equal(runCommand('git', ['status', '--porcelain=v1'], root).stdout.trim(), '?? .tmp/');
  assert.deepEqual(await readdir(path.join(root, '.tmp')), ['state.json']);
  assert.match(runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout, /001\.patch/);
});
