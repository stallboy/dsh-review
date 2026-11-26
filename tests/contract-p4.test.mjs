import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import {
  computeRejectionFingerprint,
  normalizeTitleForFingerprint,
  findDuplicateRejection,
  entryFromCandidate,
  topPerModule,
  formatMemorySummary,
} from '../packages/dsh-plugin/dist/host/memory.js';
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

const meta = (over = {}) => ({
  schemaVersion: 1,
  findingId: 'f-default',
  title: 'T',
  module: 'net',
  auditType: 'bugfix',
  issueKind: 'repair',
  dependsOn: null,
  priority: 'P2',
  baseRevision: '1',
  createdAt: '',
  updatedAt: '',
  owner: 'o',
  tags: [],
  ticket: null,
  status: 'pending',
  targetFiles: ['b.js', 'a.js'],
  recordRevision: 1,
  patches: [],
  options: [],
  observations: [],
  decisions: [],
  repairAttempts: [],
  comments: [],
  humanDecisions: [],
  approval: null,
  approvalHistory: [],
  rejection: null,
  commitMessage: 'T',
  ...over,
});

test('P4: 指纹规范化——规范 JSON 数组、UTF-8 字节序排序、title 小写合并空白', () => {
  assert.equal(normalizeTitleForFingerprint('  Net:   FIX '), 'net: fix');
  const a = computeRejectionFingerprint(meta());
  const b = computeRejectionFingerprint(meta({ targetFiles: ['a.js', 'b.js'], title: 't' }));
  assert.equal(a, b);
  assert.equal(a, '["net",["a.js","b.js"],"bugfix","t"]');
  assert.equal(
    computeRejectionFingerprint(meta({ targetFiles: ['a.js', 'B.js'] })),
    '["net",["B.js","a.js"],"bugfix","t"]',
  );
  const c = computeRejectionFingerprint(meta({ auditType: 'shrink' }));
  assert.notEqual(a, c);
});

test('P4: 窗口内完全重复被阻止；窗口外/换写法/自问题恢复豁免', () => {
  const now = Date.now();
  const rejectedCand = {
    id: '2026-10/old',
    meta: meta({
      findingId: 'f-old',
      status: 'rejected',
      targetFiles: ['a.js'],
      rejection: { rejectedBy: 'o', rejectedAt: new Date(now - 5 * 86_400_000).toISOString(), reason: 'r' },
    }),
  };
  assert.ok(entryFromCandidate({ candidateId: rejectedCand.id, meta: rejectedCand.meta }));
  assert.equal(
    findDuplicateRejection({ id: 'n1', meta: meta({ findingId: 'f-new', targetFiles: ['a.js'], title: 't' }) }, [rejectedCand], 30, now)?.candidateId,
    '2026-10/old',
  );
  assert.equal(
    findDuplicateRejection({ id: 'n2', meta: meta({ findingId: 'f-other', targetFiles: ['a.js'], title: 'other' }) }, [rejectedCand], 30, now),
    null,
  );
  const oldCand = {
    id: '2026-08/very-old',
    meta: meta({
      findingId: 'f-very-old',
      status: 'rejected',
      targetFiles: ['a.js'],
      rejection: { rejectedBy: 'o', rejectedAt: new Date(now - 60 * 86_400_000).toISOString(), reason: 'r' },
    }),
  };
  assert.equal(
    findDuplicateRejection({ id: 'n3', meta: meta({ findingId: 'f-new3', targetFiles: ['a.js'] }) }, [oldCand], 30, now),
    null,
  );
  // AC-MEMORY-01 自问题合法恢复豁免：同一问题自身的历史拒绝不阻断自己恢复后的审批
  const selfResumed = {
    id: '2026-10/self',
    meta: meta({
      findingId: 'f-self',
      status: 'pending',
      targetFiles: ['a.js'],
      decisions: [
        { action: 'accept_as_is', actor: 'o', at: new Date(now - 2 * 86_400_000).toISOString(), reason: '暂不修' },
        { action: 'resume_review', actor: 'o', at: new Date(now - 1 * 86_400_000).toISOString(), reason: '重新打开' },
      ],
    }),
  };
  assert.equal(findDuplicateRejection(selfResumed, [selfResumed], 30, now), null);
});

test('P4: topPerModule 按 rejected_at 倒序限量 + 按 module -> category 分组摘要格式', () => {
  const entries = [1, 2, 3].map((i) => ({
    candidateId: `c${String(i)}`,
    findingId: `f${String(i)}`,
    module: 'net',
    title: `t${String(i)}`,
    targetFiles: ['src/a.js'],
    auditType: 'bugfix',
    rejectedAt: `2026-11-0${String(i)}T00:00:00+08:00`,
    rejectedAtMs: i,
    reason: `r${String(i)}`,
    category: 'false_positive',
    relatedSymbols: ['add'],
    fingerprint: `f${String(i)}`,
  }));
  const top = topPerModule(entries, 2);
  assert.deepEqual(top.map((e) => e.candidateId), ['c3', 'c2']);
  const summary = formatMemorySummary(top);
  assert.match(summary, /### 模块 `net`/);
  assert.match(summary, /分类 `false_positive`/);
  assert.match(summary, /t3/);
  assert.match(summary, /t2/);
  assert.match(summary, /相关符号：add/);
  assert.ok(!summary.includes('t1'));
});

test('P4: 队列标记 duplicateOf；自问题 resume_review 恢复不自标 duplicateOf', async () => {
  const root = await createGitFixture();
  const rejectedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await writeCandidate(root, '20261104-net-old', {
    review: {
      findingId: 'net-old',
      title: 'net: 修复加法符号',
      commitMessage: 'net: 修复加法符号',
      status: 'rejected',
      rejection: `\n  rejected_by: tester\n  rejected_at: "${rejectedAt}"\n  reason: "暂不修"\n  category: intentional_design`,
    },
  });
  await writeCandidate(root, '20261104-net-new', {
    review: {
      findingId: 'net-new',
      title: 'net: 修复加法符号',
      commitMessage: 'net: 修复加法符号',
      status: 'pending',
    },
  });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrejection_memory_days: 30\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const dup = queue.items.find((item) => item.id.endsWith('net-new'));
  assert.equal(dup?.duplicateOf, '2026-11/20261104-net-old');
});

test('P4: 已废止 POST /reopen 返回 404；改为在原问题上调用 /finding/decision resume_review 恢复', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261104-net-old', {
    review: {
      findingId: 'net-old',
      status: 'rejected',
      rejection: '\n  rejected_by: tester\n  rejected_at: "2026-11-02T10:00:00+08:00"\n  reason: "误判"',
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const gone = await fetch(`${base}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-old', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T10:00:00+08:00' }),
  });
  assert.equal(gone.status, 404);

  const noReason = await fetch(`${base}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-net-old',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
      action: 'resume_review',
      reason: '  ',
    }),
  });
  assert.equal(noReason.status, 422);

  const ok = await fetch(`${base}/finding/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261104-net-old',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
      action: 'resume_review',
      reason: '此前拒绝为误判，方案已修正',
    }),
  });
  assert.equal(ok.status, 200);
  const { candidate } = await ok.json();
  assert.equal(candidate.meta.status, 'pending');
  assert.equal(candidate.meta.rejection, null);
  assert.equal(candidate.meta.decisions.at(-1).action, 'resume_review');
  assert.equal(candidate.meta.decisions.at(-1).reason, '此前拒绝为误判，方案已修正');
});
