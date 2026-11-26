import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import {
  AuditArchive,
  auditInvariantErrors,
  parseAuditMarkdown,
  scopeCovers,
  serializeAuditMarkdown,
} from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { patchFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';

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
  createdAt: '2026-11-04T02:00:00.000Z',
  baseRevision: 'abc123',
  scope: 'src/host',
  trigger: 'manual',
  previousAudit: null,
  issues: [],
  ...over,
});

const BODY = '# 仓库审查报告\n\n## 本轮范围与执行\n';

test('P6: 纯索引 audit.md 序列化往返 + 不变量正例', () => {
  const meta = META({ issues: ['2026-11/20261104-a', '2026-11/20261104-b'] });
  const text = serializeAuditMarkdown(meta, BODY);
  const parsed = parseAuditMarkdown(text);
  assert.equal(parsed.meta.auditId, meta.auditId);
  assert.deepEqual(parsed.meta.issues, ['2026-11/20261104-a', '2026-11/20261104-b']);
  assert.deepEqual(auditInvariantErrors(parsed.meta, meta.auditId, parsed.body), []);
});

test('P6: audit.md 不变量反例（目录名/时间戳/scope/重复问题 ID）', () => {
  assert.ok(auditInvariantErrors(META(), '20261104-020000-other').some((e) => e.includes('不一致')));
  assert.ok(auditInvariantErrors(META({ issues: ['bad-id'] }), META().auditId).some((e) => e.includes('非法')));
  assert.ok(auditInvariantErrors(META({ issues: ['2026-11/a', '2026-11/a'] }), META().auditId).some((e) => e.includes('重复')));
  assert.ok(auditInvariantErrors(META({ scope: '../escape' }), META().auditId).some((e) => e.includes('scope')));
  assert.ok(auditInvariantErrors(META({ createdAt: '2026-11-04T03:00:00.000Z' }), '20261104-020000-src-host').some((e) => e.includes('UTC')));
});

test('P6: 档案写入/读取与非规范平铺文件忽略', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  const meta = META({ issues: ['2026-11/20261104-api-mutex'] });
  await archive.writeAudit(meta, BODY);
  const read = await archive.read(meta.auditId);
  assert.equal(read.auditId, meta.auditId);
  assert.deepEqual(read.meta.issues, ['2026-11/20261104-api-mutex']);
  await mkdir(path.join(root, '.ai-review', 'audits'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'audits', '20261031-flat.md'), '# 旧报告\n', 'utf8');
  const records = await archive.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].auditId, meta.auditId);
});

test('P6: scopeCovers 覆盖判定', () => {
  assert.equal(scopeCovers('.', ['src/net/session.ts', 'src/host/api.ts']), true);
  assert.equal(scopeCovers('src/host', ['src/host/api.ts']), true);
  assert.equal(scopeCovers('src/host', ['src/host/api.ts', 'src/net/session.ts']), false);
});

test('P6: API /audits 与 /findings 统一来自单一问题账本（含 8 状态）', async () => {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  const patchText = patchFixture();
  const sha = sha256Hex(patchText);

  await writeCandidate(root, '20261104-a', {
    review: {
      findingId: 'f-approved',
      status: 'approved',
      patchText,
      patchSha256: sha,
      repairAttempts: '\n  - id: 1\n    option_id: opt-a\n    patch_id: 1\n    base_revision: "1"\n    actor: tester\n    at: "2026-11-04T10:00:00+08:00"\n    apply_mode: program_strict\n    result: applied\n    restored: false\n    evidence: "ok"',
      approval: `\n  approved_by: tester\n  approved_at: "2026-11-04T10:00:00+08:00"\n  record_revision: 1\n  option_id: opt-a\n  patch_id: 1\n  patch_sha256: "${sha}"\n  repair_attempt_id: 1\n  base_revision: "1"\n  gate_checks: ["node --version"]\n  gate_results: [{command: "node --version", exit_code: 0, duration_ms: 1}]\n  confirmed_decisions: []\n  waived_decisions: []`,
    },
  });
  await writeCandidate(root, '20261104-b', {
    review: {
      findingId: 'f-rejected',
      status: 'rejected',
      rejection: '\n  rejected_by: tester\n  rejected_at: "2026-11-04T10:00:00+08:00"\n  reason: "不采用"',
    },
  });
  await writeCandidate(root, '20261104-c', {
    review: {
      findingId: 'f-open',
      status: 'pending',
    },
  });
  await writeCandidate(root, '20261104-d', {
    review: {
      findingId: 'f-confirm',
      issueKind: 'confirm',
      patches: ' []',
      options: ' []',
      commitMessage: null,
      status: 'pending',
    },
  });
  await archive.writeAudit(META({
    issues: ['2026-11/20261104-a', '2026-11/20261104-b', '2026-11/20261104-c', '2026-11/20261104-d'],
  }), BODY);

  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'shared audit fixture'], root);
  const { base } = await startApi(root);

  const audits = await (await fetch(`${base}/audits`)).json();
  assert.equal(audits.audits.length, 1);
  assert.equal(audits.audits[0].issues.length, 4);

  const findings = await (await fetch(`${base}/findings`)).json();
  const byId = Object.fromEntries(findings.findings.map((f) => [f.findingId, f]));
  assert.equal(byId['f-approved']?.issueStatus, 'approved');
  assert.equal(byId['f-rejected']?.issueStatus, 'rejected');
  assert.equal(byId['f-open']?.issueStatus, 'pending');
  assert.equal(byId['f-confirm']?.issueKind, 'confirm');
  assert.equal(byId['f-confirm']?.options.length, 0);
});
