import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { fingerprintOf, normalizeTitle, findDuplicate, entryFromCandidate, topPerModule, formatMemorySummary } from '../dist/memory.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

/** P4 验收：§7 负向记忆指纹/窗口/阻止/重开豁免 + §4.8 人工重开 API。 */

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

const FM = (slug, status, extra = {}) => [
  '---',
  'schema_version: 1',
  `title: "net: ${extra.titleText ?? slug}"`,
  `module: ${extra.module ?? 'net'}`,
  `audit_type: ${extra.auditType ?? 'bugfix'}`,
  'created_at: "2026-11-01T10:00:00+08:00"',
  'updated_at: "2026-11-01T10:00:00+08:00"',
  'owner: tester',
  'tags: []',
  `status: ${status}`,
  'ticket: null',
  `target_files: ${(extra.targetFiles ?? ['src/math.js']).map((f) => `\n  - ${f}`).join('')}`,
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
  status === 'rejected'
    ? [
        'rejection:',
        '  rejected_by: tester',
        `  rejected_at: "${extra.rejectedAt ?? '2026-11-02T10:00:00+08:00'}"`,
        '  reason: "方案有回归风险"',
      ].join('\n')
    : 'rejection: null',
  'commit_message: "net: x"',
  ...(extra.reopenedFrom ? [
    `reopened_from: ${extra.reopenedFrom}`,
    `reopen_reason: "${extra.reopenedReason ?? '此前为误判'}"`,
  ] : []),
  '---',
  '',
  '# 问题与影响',
  '',
].join('\n');

async function writeCandidate(root, slug, status, extra = {}) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), FM(slug, status, extra), 'utf8');
  if (status !== 'rejected') {
    await writeFile(path.join(dir, '001.patch'), [
      'diff --git a/src/math.js b/src/math.js',
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'), 'utf8');
  }
}

const meta = (over = {}) => ({
  schemaVersion: 1, title: 'T', module: 'net', auditType: 'bugfix', createdAt: '', updatedAt: '',
  owner: 'o', tags: [], status: 'pending', ticket: null, targetFiles: ['b.js', 'a.js'],
  currentRevision: 1, revisions: [], gateChecks: [], comments: [], humanDecisions: [],
  approval: null, rejection: null, commitMessage: '', extra: {}, ...over,
});

test('P4: 指纹规范化——规范 JSON 数组、UTF-8 字节序排序、title 小写合并空白', () => {
  assert.equal(normalizeTitle('  Net:   FIX '), 'net: fix');
  const a = fingerprintOf(meta());
  const b = fingerprintOf(meta({ targetFiles: ['a.js', 'b.js'], title: 't' }));
  assert.equal(a, b);
  // §6.1：确定性指纹使用无分隔符碰撞的规范 JSON 数组。
  assert.equal(a, '["net",["a.js","b.js"],"bugfix","t"]');
  // UTF-8 字节序：'B'(0x42) < 'a'(0x61)，大写排前。
  assert.equal(
    fingerprintOf(meta({ targetFiles: ['a.js', 'B.js'] })),
    '["net",["B.js","a.js"],"bugfix","t"]',
  );
  const c = fingerprintOf(meta({ auditType: 'shrink' }));
  assert.notEqual(a, c);
});

test('P4: 窗口内完全重复被阻止；窗口外/换写法不阻止（链豁免在 store 层）', () => {
  const rejected = entryFromCandidate({
    candidateId: '2026-10/old',
    meta: meta({
      status: 'rejected',
      targetFiles: ['a.js'],
      rejection: { rejectedBy: 'o', rejectedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), reason: 'r' },
    }),
  });
  assert.ok(rejected);
  const memory = [rejected];
  const now = Date.now();
  // 完全相同、窗口内 → 阻止；duplicateOf 取 rejected_at 倒序第一条未豁免匹配。
  assert.equal(findDuplicate({ candidateId: 'n1', meta: meta({ targetFiles: ['a.js'], title: 't' }) }, memory, 30, now)?.candidateId, '2026-10/old');
  // 换写法（title 不同）→ 不阻止。
  assert.equal(findDuplicate({ candidateId: 'n2', meta: meta({ targetFiles: ['a.js'], title: 'other' }) }, memory, 30, now), null);
  // 窗口外 → 不阻止。
  const old = [{ ...rejected, rejectedAtMs: now - 60 * 86_400_000 }];
  assert.equal(findDuplicate({ candidateId: 'n3', meta: meta({ targetFiles: ['a.js'] }) }, old, 30, now), null);
  // §6.2（2026-11-10）：豁免判定上移到 store 的重开链计算——findDuplicate 本身返回匹配，
  // store.list 会把合法链上祖先从 duplicateOf 候选中剔除（见“队列标记 duplicateOf”测试）。
  assert.equal(findDuplicate({ candidateId: 'n4', meta: meta({ targetFiles: ['a.js'], reopenedFrom: '2026-10/old' }) }, memory, 30, now)?.candidateId, '2026-10/old');
});

test('P4: topPerModule 按 rejected_at 倒序限量 + 注入摘要格式', () => {
  const entries = [1, 2, 3].map((i) => ({
    candidateId: `c${String(i)}`, module: 'net', title: `t${String(i)}`, targetFiles: [], auditType: 'bugfix',
    rejectedAt: `2026-11-0${String(i)}T00:00:00+08:00`, rejectedAtMs: i, reason: `r${String(i)}`, fingerprint: `f${String(i)}`,
  }));
  const top = topPerModule(entries, 2);
  assert.deepEqual(top.map((e) => e.candidateId), ['c3', 'c2']);
  const summary = formatMemorySummary(top);
  assert.match(summary, /\[net\] t3（审查类型 bugfix；目标文件 —；被拒于 2026-11-03/);
  assert.match(summary, /\[net\] t2（审查类型 bugfix；目标文件 —；被拒于 2026-11-02/);
  assert.ok(!summary.includes('t1'));
});

test('P4: 队列标记 duplicateOf；重开后豁免', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261104-net-old', 'rejected', { titleText: '修复加法符号', rejectedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });
  await writeCandidate(root, '20261104-net-new', 'pending', { titleText: '修复加法符号' });
  await writeCandidate(root, '20261104-net-reopened', 'pending', { titleText: '修复加法符号', reopenedFrom: '2026-11/20261104-net-old' });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrejection_memory_days: 30\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const dup = queue.items.find((item) => item.id.endsWith('net-new'));
  const reopened = queue.items.find((item) => item.id.endsWith('net-reopened'));
  assert.equal(dup?.duplicateOf, '2026-11/20261104-net-old');
  assert.equal(reopened?.duplicateOf, undefined);
});

test('P4: POST /reopen——合法重开成功；非 rejected 目标与空理由被拒', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261104-net-old', 'rejected');
  await writeCandidate(root, '20261104-net-other', 'pending');
  await writeCandidate(root, '20261104-net-new', 'pending');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  // 目标不是 rejected → 409。
  const badTarget = await fetch(`${base}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-new', from: '2026-11/20261104-net-other', reason: '误判', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T10:00:00+08:00' }),
  });
  assert.equal(badTarget.status, 409);

  // 空理由 → 422。
  const noReason = await fetch(`${base}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-new', from: '2026-11/20261104-net-old', reason: '  ', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T10:00:00+08:00' }),
  });
  assert.equal(noReason.status, 422);

  // 合法重开 → 成功并留痕。
  const ok = await fetch(`${base}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261104-net-new', from: '2026-11/20261104-net-old', reason: '此前拒绝为误判，方案已修正', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-01T10:00:00+08:00' }),
  });
  assert.equal(ok.status, 200);
  const { candidate } = await ok.json();
  assert.equal(candidate.meta.reopenedFrom, '2026-11/20261104-net-old');
  assert.equal(candidate.meta.reopenedReason, '此前拒绝为误判，方案已修正');
});
