import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { AuditArchive } from '../dist/audit-archive.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** P7 验收：§6.2 转候选——depends_on 满足判定、两侧同一提交、状态/归档目标校验。 */

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

async function writeCandidate(root, slug, status = 'pending') {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const approval = status === 'approved'
    ? ['rejection: null', 'approval:', '  approved_by: tester', '  approved_at: "2026-11-04T10:00:00+08:00"', '  commit_revision: null'].join('\n')
    : ['approval: null', 'rejection: null'].join('\n');
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-04T09:00:00+08:00"', 'updated_at: "2026-11-04T09:00:00+08:00"', 'owner: tester',
    'tags: []', `status: ${status}`, 'ticket: null', 'target_files: [src/host/api.ts]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: []', 'comments: []', 'human_decisions: []', approval, 'commit_message: "net: x"',
    '---', '', '# 问题与影响', '',
  ].join('\n'), 'utf8');
  if (status === 'pending') {
    await writeFile(path.join(dir, '001.patch'), 'diff --git a/src/host/api.ts b/src/host/api.ts\n', 'utf8');
  }
}

const META = (items) => ({
  schemaVersion: 1, auditId: '20261104-020000-src-host', createdAt: '2026-11-04T02:00:00+08:00',
  baseRevision: 'abc', scope: 'src/host', trigger: 'manual', previousAudit: null, candidates: [], items,
});
const ITEM = (over = {}) => ({
  findingId: 'f1', kind: 'confirm', title: 'T', summary: 'S', targetFiles: ['src/host/api.ts'],
  dependsOn: null, status: 'pending', candidate: null, ...over,
});

const convert = (base, payload) => fetch(`${base}/convert`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('P7: confirm 项转换成功——档案与候选目录同一提交', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  await archive.write(META([ITEM({ findingId: 'f-confirm' })]), '# 报告\n');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const commitBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  // 候选在夹具提交之后产生（未提交），转换提交应把两侧一起纳入。
  await writeCandidate(root, '20261104-net-a');

  const { base } = await startApi(root);
  const ok = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'f-confirm', candidateId: '2026-11/20261104-net-a' });
  assert.equal(ok.status, 200);
  const { audit } = await ok.json();
  assert.equal(audit.items[0].status, 'converted');
  assert.equal(audit.items[0].candidate, '2026-11/20261104-net-a');

  // 恰好一个新提交，同时包含档案与候选目录两侧。
  const commits = runCommand('git', ['rev-list', `${commitBefore}..HEAD`], root).stdout.trim().split('\n');
  assert.equal(commits.length, 1);
  const files = runCommand('git', ['show', '--name-only', '--format=', commits[0]], root).stdout.trim().split('\n');
  assert.ok(files.some((f) => f.includes('audits/20261104-020000-src-host/audit.md')), files.join(','));
  assert.ok(files.some((f) => f.includes('20261104-net-a/review.md')), files.join(','));

  // 重复转换被拒（非 pending）。
  const again = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'f-confirm', candidateId: '2026-11/20261104-net-a' });
  assert.equal(again.status, 409);
});

test('P7: deferred——前置 resolved/候选 approved 才可转换；pending/rejected 阻塞', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  await archive.write(META([
    ITEM({ findingId: 'pre-ok', status: 'resolved' }),
    ITEM({ findingId: 'pre-cand', status: 'converted', candidate: '2026-11/20261104-approved' }),
    ITEM({ findingId: 'pre-open', status: 'pending' }),
    ITEM({ findingId: 'dep-ok', kind: 'deferred', dependsOn: 'pre-ok' }),
    ITEM({ findingId: 'dep-cand', kind: 'deferred', dependsOn: 'pre-cand' }),
    ITEM({ findingId: 'dep-open', kind: 'deferred', dependsOn: 'pre-open' }),
    ITEM({ findingId: 'dep-none', kind: 'deferred', dependsOn: 'pre-missing' }),
  ]), '# 报告\n');
  await writeCandidate(root, '20261104-approved', 'approved');
  await writeCandidate(root, '20261104-net-b');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  // 前置 resolved → 满足。
  const ok = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'dep-ok', candidateId: '2026-11/20261104-net-b' });
  assert.equal(ok.status, 200);
  // 前置 converted 且其候选 approved → 满足。
  const ok2 = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'dep-cand', candidateId: '2026-11/20261104-net-b' });
  assert.equal(ok2.status, 200);
  // 前置 pending → 阻塞并显示原因。
  const blocked = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'dep-open', candidateId: '2026-11/20261104-net-b' });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error.message, /depends_on 未满足/);
  // 前置无观察 → 阻塞。
  const none = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'dep-none', candidateId: '2026-11/20261104-net-b' });
  assert.equal(none.status, 409);
  // 已归档候选不能作为转换目标。
  const archived = await convert(base, { auditId: '20261104-020000-src-host', findingId: 'dep-ok', candidateId: '2026-11/20261104-approved' });
  assert.equal(archived.status, 409);
});

test('P7: 转换后投影联动——converted 候选 pending 视为 open', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  await archive.write(META([ITEM({ findingId: 'f-x' })]), '# 报告\n');
  await writeCandidate(root, '20261104-net-c');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  await convert(base, { auditId: '20261104-020000-src-host', findingId: 'f-x', candidateId: '2026-11/20261104-net-c' });
  const findings = await (await fetch(`${base}/findings`)).json();
  assert.equal(findings.findings[0].state, 'open');
  assert.equal(findings.findings[0].candidateStatus, 'pending');
});
