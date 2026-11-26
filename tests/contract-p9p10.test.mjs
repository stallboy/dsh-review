import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { patchFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, extraDeps = {}, settingsPatch = {}) {
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false,
    ...settingsPatch,
  };
  const api = new ReviewApi({
    settings,
    saveSettings: async (next) => next,
    statePath: path.join(await mkdtemp(path.join(tmpdir(), 'dcr-p9-state-')), 'runtime-state.json'),
    ...extraDeps,
  });
  await api.init();
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base, api };
}

test('P9: 审查提示词包含 reviewers.yml 路由解析结果', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
    'default_owner: zhangsan',
    'rules:',
    '  - owner: lisi',
    '    paths:',
    '      - src/**',
    '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const response = await (await fetch(`${base}/audit/prompt?mode=session`)).json();
  assert.match(response.prompt, /"defaultOwner":\s*"zhangsan"/);
  assert.match(response.prompt, /"ruleCount":\s*1/);
});

test('P9: 旧定时配置键被忽略，手动审查会话仍通过 reviewers 校验并注入路由', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const created = [];
  const { base } = await startApi(root, {
    createAuditSession: async (request) => {
      created.push(request);
      return { sessionId: 'manual-1' };
    },
  });
  const updated = await fetch(`${base}/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheduleIntervalMinutes: 0.001 }),
  });
  assert.equal(updated.status, 200);
  const started = await fetch(`${base}/audit/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  });
  assert.equal(started.status, 202);
  assert.equal(created.length, 1);
  assert.equal((await started.json()).sessionId, 'manual-1');
  assert.match(created[0].prompt, /tester/);
});

test('P10: 检出级写互斥——并发 /finding/decision 串行化，恰好一个成功（只写一次）', async () => {
  const root = await createGitFixture();
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  await writeCandidate(root, '20261105-net-stale', {
    review: { createdAt: staleIso, updatedAt: staleIso },
  });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nstale_days: 14\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const results = await Promise.all([1, 2, 3, 4].map(() =>
    fetch(`${base}/finding/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: '2026-11/20261105-net-stale',
        expectedRevision: 1,
        expectedOwner: 'tester',
        expectedUpdatedAt: staleIso,
        action: 'accept_as_is',
        reason: '并发关闭测试',
      }),
    })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((code) => code === 200).length, 1, statuses.join(','));
  assert.equal(statuses.filter((code) => code === 409).length, 3, statuses.join(','));

  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('net-stale'));
  assert.equal(item?.status, 'rejected');
});

test('P10: approved 无可派生提交 → lookup unknown 仅诊断', async () => {
  const root = await createGitFixture();
  const patchText = patchFixture();
  const sha = sha256Hex(patchText);
  await writeCandidate(root, '20261105-net-bf', {
    patchText,
    review: {
      title: 'net: bf',
      commitMessage: 'net: bf',
      status: 'approved',
      createdAt: '2026-11-05T09:00:00+08:00',
      updatedAt: '2026-11-05T10:00:00+08:00',
      repairAttempts: '\n  - id: 1\n    option_id: opt-a\n    patch_id: 1\n    base_revision: "1"\n    actor: tester\n    at: "2026-11-05T10:00:00+08:00"\n    apply_mode: program_strict\n    result: applied\n    restored: false\n    evidence: "ok"',
      approval: `\n  approved_by: tester\n  approved_at: "2026-11-05T10:00:00+08:00"\n  record_revision: 1\n  option_id: opt-a\n  patch_id: 1\n  patch_sha256: "${sha}"\n  repair_attempt_id: 1\n  base_revision: "1"\n  gate_checks: ["node --version"]\n  gate_results: [{command: "node --version", exit_code: 0, duration_ms: 1}]\n  confirmed_decisions: []\n  waived_decisions: []`,
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('net-bf'));
  assert.equal(item?.approvalCommitLookup, 'unknown');
  assert.equal(item?.approvalCommitRevision, undefined);
  assert.equal(item?.parseError, undefined);
});
