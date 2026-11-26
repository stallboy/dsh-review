import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { patchFixture, sha256Hex, writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

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
  const patch1 = PATCH('+');
  const sha1 = sha256Hex(patch1);
  if (!humanHistory) {
    await writeSchemaCandidate(root, '20261105-net-rb', {
      patchText: patch1,
      review: {
        title: 'net: 修复加法',
        commitMessage: 'net: 修复加法',
        baseRevision: base,
        createdAt: '2026-11-05T09:00:00+08:00',
        updatedAt: '2026-11-05T09:00:00+08:00',
      },
    });
    return;
  }
  const { dir } = await writeSchemaCandidate(root, '20261105-net-rb', {
    patchText: patch1,
    review: {
      title: 'net: 修复加法',
      commitMessage: 'net: 修复加法',
      baseRevision: base,
      createdAt: '2026-11-05T09:00:00+08:00',
      updatedAt: '2026-11-05T09:00:00+08:00',
      recordRevision: 2,
      patches: [
        '',
        '  - id: 1',
        '    patch: 001.patch',
        '    option_id: opt-a',
        `    base_revision: "${base}"`,
        '    author: ai',
        `    sha256: "${sha1}"`,
        '  - id: 2',
        '    patch: 002.patch',
        '    option_id: opt-a',
        `    base_revision: "${base}"`,
        '    author: human',
        `    sha256: "${sha1}"`,
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
    },
  });
  await writeFile(path.join(dir, '002.patch'), patch1, 'utf8');
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

test('P8: Rebase——在 manual Runner 下显式绑定 (optionId, patchId) 产出 Mode B Rebase 提示词并保持工作区干净', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, base);
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base: apiBase } = await startApi(root);

  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'base moves'], root);

  const ok = await runJob(apiBase, '/rebase', {
    id: '2026-11/20261105-net-rb',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-05T09:00:00+08:00',
    optionId: 'opt-a',
    patchId: 1,
  });
  assert.equal(ok.httpStatus, 202);
  assert.equal(ok.job.result.status, 'MANUAL_REQUIRED', JSON.stringify(ok.job.result));
  assert.match(String(ok.job.result.prompt), /opt-a/);
  const status = runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim();
  assert.equal(status, '');
});

test('P8: 既有人工补丁可读，已废止 /manual-revision 返回 404', async () => {
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
  assert.equal(candidate.meta.recordRevision, 2);
  assert.equal(candidate.meta.patches[1].author, 'human');
  assert.deepEqual(jobs, []);
  const patch = await fetch(`${apiBase}/patch?id=${id}&name=002.patch`);
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).text, PATCH('+'));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout, head);
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout, '');
  assert.ok(existsSync(path.join(root, '.ai-review', '2026-11', '20261105-net-rb', '002.patch')));
});
