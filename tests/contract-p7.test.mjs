import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { AuditArchive } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

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

test('P7: 已废止 POST /convert 与 POST /dismiss-finding 均返回 404（单一问题账本无转换流程）', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  await archive.writeAudit({
    schemaVersion: 1,
    auditId: '20261104-020000-src-host',
    createdAt: '2026-11-04T02:00:00.000Z',
    baseRevision: 'abc',
    scope: 'src/host',
    trigger: 'manual',
    previousAudit: null,
    issues: [],
  }, '# 报告\n');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const convertRes = await fetch(`${base}/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: '20261104-020000-src-host', findingId: 'f1', candidateId: '2026-11/x' }),
  });
  assert.equal(convertRes.status, 404);

  const dismissRes = await fetch(`${base}/dismiss-finding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: '20261104-020000-src-host', findingId: 'f1' }),
  });
  assert.equal(dismissRes.status, 404);
});

test('P7: confirm 与 deferred 纯文字问题直接作为一等候选存在于队列，并支持 /finding/decision 处置', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261104-pre', {
    review: {
      findingId: 'pre-req',
      issueKind: 'confirm',
      patches: ' []',
      options: ' []',
      commitMessage: null,
    },
  });
  await writeCandidate(root, '20261104-dep', {
    review: {
      findingId: 'dep-item',
      issueKind: 'deferred',
      dependsOn: 'pre-req',
      patches: ' []',
      options: ' []',
      commitMessage: null,
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const dep = queue.items.find((i) => i.id.endsWith('20261104-dep'));
  assert.equal(dep?.issueKind, 'deferred');
  assert.equal(dep?.dependsOn, 'pre-req');
  assert.equal(dep?.options.length, 0);

  // 纯文字问题拒绝直接程序批准
  const approveConfirm = await fetch(`${base}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-pre',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
      optionId: 'opt-a',
      patchId: 1,
    }),
  });
  assert.equal(approveConfirm.status, 409);

  // 人工接管并标记外部完成 -> awaiting_verification
  const takeover = await fetch(`${base}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-pre',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
      action: 'human_takeover',
      reason: '需跨模块重构，人工处理',
    }),
  });
  assert.equal(takeover.status, 200);
  const tBody = await takeover.json();
  assert.equal(tBody.candidate.meta.status, 'human_takeover');

  const extDone = await fetch(`${base}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-pre',
      expectedRevision: tBody.candidate.meta.recordRevision,
      expectedOwner: 'tester',
      expectedUpdatedAt: tBody.candidate.meta.updatedAt,
      action: 'external_completed',
      reason: '已在提交 abc123 修复',
    }),
  });
  assert.equal(extDone.status, 200);
  assert.equal((await extDone.json()).candidate.meta.status, 'awaiting_verification');
});

test('P7: /findings 聚合展示纯文字问题与人工接管状态，无需独立转换步骤', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261104-net-c', {
    review: {
      findingId: 'f-x',
      issueKind: 'confirm',
      patches: ' []',
      options: ' []',
      commitMessage: null,
      status: 'awaiting_verification',
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const findings = await (await fetch(`${base}/findings`)).json();
  assert.equal(findings.findings.length, 1);
  assert.equal(findings.findings[0].findingId, 'f-x');
  assert.equal(findings.findings[0].issueStatus, 'awaiting_verification');
});
