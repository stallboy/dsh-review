import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { AuditArchive, auditInvariantErrors, parseAuditMarkdown, projectFindings, serializeAuditMarkdown } from '../dist/audit-archive.js';
import { createGitFixture, fakeAuditAgentPath, runCommand } from './helpers.mjs';

/** P6 验收：audit.md 新契约（I1/I9/I10/I13）+ §3.4 投影四规则 + API /audits /findings。 */

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

const META = (over = {}) => ({
  schemaVersion: 1,
  auditId: '20261104-020000-src-host',
  createdAt: '2026-11-04T02:00:00Z',
  baseRevision: 'abc123',
  scope: 'src/host',
  trigger: 'manual',
  previousAudit: null,
  candidates: [],
  items: [],
  ...over,
});

const ITEM = (over = {}) => ({
  findingId: 'api-double-approval', kind: 'confirm', title: '并发批准互斥', summary: '需实现串行化',
  targetFiles: ['src/host/api.ts'], dependsOn: null, status: 'pending', candidate: null, ...over,
});

const BODY = '# 仓库审查报告\n\n## 本轮范围与执行\n';

test('P6: 序列化往返 + 不变量正例', () => {
  const meta = META({ items: [ITEM(), ITEM({ findingId: 'auth-legacy', kind: 'deferred', dependsOn: 'auth-isolate', targetFiles: ['src/host/auth/legacy.ts'] })] });
  const text = serializeAuditMarkdown(meta, BODY);
  const parsed = parseAuditMarkdown(text);
  assert.equal(parsed.meta.auditId, meta.auditId);
  assert.equal(parsed.meta.items.length, 2);
  assert.equal(parsed.meta.items[1].dependsOn, 'auth-isolate');
  assert.deepEqual(auditInvariantErrors(parsed.meta, meta.auditId), []);
});

test('P6: I1/I9/I10/I13 反例', () => {
  // I1：audit_id 与目录名不一致。
  assert.ok(auditInvariantErrors(META(), '20261104-020000-other').some((e) => e.startsWith('I1')));
  // I9：converted 无 candidate / 非 converted 有 candidate。
  assert.ok(auditInvariantErrors(META({ items: [ITEM({ status: 'converted' })] }), META().auditId).some((e) => e.startsWith('I9')));
  assert.ok(auditInvariantErrors(META({ items: [ITEM({ candidate: '2026-11/x' })] }), META().auditId).some((e) => e.startsWith('I9')));
  // I10：deferred 缺依赖 / confirm 带依赖。
  assert.ok(auditInvariantErrors(META({ items: [ITEM({ kind: 'deferred' })] }), META().auditId).some((e) => e.startsWith('I10')));
  assert.ok(auditInvariantErrors(META({ items: [ITEM({ dependsOn: 'x' })] }), META().auditId).some((e) => e.startsWith('I10')));
  // I13：时间戳不一致。
  assert.ok(auditInvariantErrors(META({ createdAt: '2026-11-04T03:00:00Z' }), '20261104-020000-src-host').some((e) => e.startsWith('I13')));
});

test('P6: 档案写入/读取/目录冲突/updateItem 不重写历史', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  const meta = META({ items: [ITEM()] });
  const record = await archive.write(meta, BODY);
  assert.equal(record.dirName, meta.auditId);
  // 目录冲突即失败（§18.8）。
  await assert.rejects(() => archive.write(meta, BODY), /已存在/);
  // updateItem：converted + candidate。
  const updated = await archive.updateItem(meta.auditId, 'api-double-approval', 'converted', '2026-11/20261104-api-mutex');
  assert.equal(updated.meta.items[0].status, 'converted');
  assert.equal(updated.meta.items[0].candidate, '2026-11/20261104-api-mutex');
  // 旧扁平报告不参与 list。
  await mkdir(path.join(root, '.ai-review', 'audits'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'audits', '20261031-flat.md'), '# 旧报告\n', 'utf8');
  const records = await archive.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].dirName, meta.auditId);
});

test('P6: 投影——覆盖判定/最新观察/当前状态/可见性', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  // 第 1 轮：src/host 范围，两个 finding（一个 pending，一个 converted→候选）。
  await archive.write(META({
    items: [
      ITEM({ findingId: 'api-race' }),
      ITEM({ findingId: 'net-close', targetFiles: ['src/net/session.ts'] }), // 不在 src/host 范围 → 不被本轮覆盖
    ],
  }), BODY);
  // 第 2 轮（更新）：api-race 仍 pending；net-close 覆盖（全仓 '.'）。
  await archive.write(META({
    auditId: '20261105-020000-repo', createdAt: '2026-11-05T02:00:00Z', scope: '.',
    previousAudit: '20261104-020000-src-host',
    items: [ITEM({ findingId: 'api-race' }), ITEM({ findingId: 'net-close', targetFiles: ['src/net/session.ts'] })],
  }), BODY);
  // 候选状态映射：net-close 的候选已 approved → closed；api-race 的候选 rejected → reopened。
  const { findings: projections } = projectFindings(await archive.list(), (candidateId) =>
    candidateId.endsWith('net-cand') ? { status: 'approved', reopenedFrom: null }
      : candidateId.endsWith('api-cand') ? { status: 'rejected', reopenedFrom: null }
        : null,
    ['2026-11/net-cand', '2026-11/api-cand']);
  const byId = new Map(projections.map((p) => [p.findingId, p]));
  // 覆盖判定：net-close 只被第 2 轮（全仓）观察。
  assert.equal(byId.get('net-close')?.lastObservedAudit, '20261105-020000-repo');
  // 最新观察：api-race 最新来自第 2 轮。
  assert.equal(byId.get('api-race')?.lastObservedAudit, '20261105-020000-repo');
  assert.equal(byId.get('api-race')?.lastObservedAt, '2026-11-05T02:00:00Z');
  // 当前状态规则（converted 结合候选真实状态）在下面 API 测试验证。
});

test('P6: API /audits 与 /findings——converted 结合候选状态出 closed/reopened', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  await archive.write(META({
    items: [
      ITEM({ findingId: 'f-approved', status: 'converted', candidate: '2026-11/20261104-a' }),
      ITEM({ findingId: 'f-rejected', status: 'converted', candidate: '2026-11/20261104-b' }),
      ITEM({ findingId: 'f-open', status: 'converted', candidate: '2026-11/20261104-c' }),
      ITEM({ findingId: 'f-pending' }),
      ITEM({ findingId: 'f-dismissed', status: 'dismissed' }),
      ITEM({ findingId: 'f-resolved', status: 'resolved' }),
    ],
  }), BODY);
  // 对应候选：a=approved, b=rejected, c=pending。
  for (const [slug, status] of [['20261104-a', 'approved'], ['20261104-b', 'rejected'], ['20261104-c', 'pending']]) {
    const dir = path.join(root, '.ai-review', '2026-11', slug);
    await mkdir(dir, { recursive: true });
    const approval = status === 'approved'
      ? 'approval:\n  approved_by: tester\n  approved_at: "2026-11-04T10:00:00+08:00"\n  gate_checks: []\n  gate_results: []\n  confirmed_decisions: []\n  waived_decisions: []\n  commit_revision: null' : 'approval: null';
    const rejection = status === 'rejected'
      ? 'rejection:\n  rejected_by: tester\n  rejected_at: "2026-11-04T10:00:00+08:00"\n  reason: "不采用"' : 'rejection: null';
    await writeFile(path.join(dir, 'review.md'), [
      '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
      'created_at: "2026-11-04T09:00:00+08:00"', 'updated_at: "2026-11-04T09:00:00+08:00"', 'owner: tester',
      'tags: []', `status: ${status}`, 'ticket: null', 'target_files: [src/host/api.ts]', 'current_revision: 1',
      'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai', 'gate_checks: []',
      'comments: []', 'human_decisions: []', approval, rejection, 'commit_message: "x: y"',
      '---', '', '# 问题与影响', '',
    ].join('\n'), 'utf8');
    if (status === 'pending') {
      // 活跃候选必须带补丁文件，且 target_files 与补丁路径一致（I4/I5）。
      await writeFile(path.join(dir, '001.patch'), [
        'diff --git a/src/host/api.ts b/src/host/api.ts',
        '--- a/src/host/api.ts',
        '+++ b/src/host/api.ts',
        '@@ -1 +1 @@',
        '-const x = 1;',
        '+const x = 2;',
        '',
      ].join('\n'), 'utf8');
    }
  }
  // §7.1：档案与候选只有进入共享提交后才可被 /audits 与 /findings 读取。
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'shared audit fixture'], root);
  const { base } = await startApi(root);
  const audits = await (await fetch(`${base}/audits`)).json();
  assert.equal(audits.audits.length, 1);
  assert.equal(audits.audits[0].itemCount, 6);
  const findings = await (await fetch(`${base}/findings`)).json();
  const states = Object.fromEntries(findings.findings.map((f) => [f.findingId, f.state]));
  assert.equal(states['f-approved'], 'closed');
  assert.equal(states['f-rejected'], 'reopened');
  assert.equal(states['f-open'], 'open');
  assert.equal(states['f-pending'], 'open');
  assert.equal(states['f-dismissed'], 'dismissed');
  assert.equal(states['f-resolved'], 'closed');
});
