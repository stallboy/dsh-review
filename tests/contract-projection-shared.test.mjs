import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { buildAuditPrompt } from '../dist/auditor.js';
import { GitHeadCandidateSource } from '../dist/shared-facts.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/**
 * §7.1 / G10 / G41 共享事实与投影缓存：
 * - finding 投影、/audits、负向记忆、已存在候选注入只能读同一 VCS 快照（HEAD），
 *   工作区未提交改动不得影响共享读端；
 * - 投影缓存键与读取源同源：新提交后缓存必须失效并反映新档案状态。
 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function ensureReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
}

function candidateFm({ title, status, rejection = false }) {
  return [
    '---', 'schema_version: 1', `title: "${title}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-09T10:00:00+08:00"', 'updated_at: "2026-11-09T10:00:00+08:00"', 'owner: tester',
    'tags: []', `status: ${status}`, 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null',
    ...(rejection ? ['rejection:', '  rejected_by: tester', '  rejected_at: "2026-11-09T10:00:00Z"', '  reason: "已有更简单的实现"'] : ['rejection: null']),
    `commit_message: "${title}"`, '---', '', '# 问题与影响', '',
  ].join('\n');
}

async function writeCandidate(root, slug, { title, status, rejection = false }) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), candidateFm({ title, status, rejection }), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    '',
  ].join('\n'), 'utf8');
}

async function writeAudit(root, auditId, scope, status, findingId = 'f-aaaaaaaaaa') {
  const dir = path.join(root, '.ai-review', 'audits', auditId);
  await mkdir(dir, { recursive: true });
  const compact = auditId.slice(0, 15);
  const createdAt = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'audit.md'), [
    '---', 'schema_version: 1', `audit_id: ${auditId}`, `created_at: "${createdAt}"`, `base_revision: "${head}"`,
    `scope: ${scope}`, 'trigger: manual', 'previous_audit: null', 'candidates: []',
    'items:',
    `  - finding_id: ${findingId}`,
    '    kind: confirm',
    '    title: 认证流程需要确认',
    '    summary: 影响兼容性',
    `    target_files: [${scope === '.' ? 'src/math.js' : scope}]`,
    '    depends_on: null',
    `    status: ${status}`,
    '    candidate: null',
    '---', '', '# 仓库审查报告', '',
  ].join('\n'), 'utf8');
}

function commitAll(root, message) {
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', message], root);
}

test('§7.1/G41：finding 投影读 HEAD 快照，本地篡改不可见；新提交后缓存失效', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  await writeAudit(root, '20261110-100000-repo', '.', 'pending');
  commitAll(root, 'audit fixture');
  const { base } = await startApi(root);

  const first = await (await fetch(`${base}/findings`)).json();
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].state, 'open', 'pending item 投影为 open');

  // 未提交地篡改共享档案：投影/档案列表都必须仍读 HEAD。
  const auditPath = path.join(root, '.ai-review', 'audits', '20261110-100000-repo', 'audit.md');
  const shared = await (await import('node:fs/promises')).readFile(auditPath, 'utf8');
  await writeFile(auditPath, shared.replace('status: pending', 'status: dismissed'), 'utf8');
  const second = await (await fetch(`${base}/findings`)).json();
  assert.equal(second.findings[0].state, 'open', '本地篡改不得进入投影（必须读共享快照）');

  // 本地新增未提交档案（不同 finding）：/audits 也不得列出。
  await writeAudit(root, '20261110-110000-local', '.', 'pending', 'f-bbbbbbbbbb');
  const auditsLocal = await (await fetch(`${base}/audits`)).json();
  assert.deepEqual(auditsLocal.audits.map((entry) => entry.auditId), ['20261110-100000-repo'], '本地档案不是共享事实');

  // 只提交被篡改的共享档案：新快照必须让投影缓存失效并反映 dismissed。
  runCommand('git', ['add', '.ai-review/audits/20261110-100000-repo'], root);
  runCommand('git', ['commit', '-q', '-m', 'dismiss finding'], root);
  const third = await (await fetch(`${base}/findings`)).json();
  assert.equal(third.findings[0].state, 'dismissed', '新提交后投影缓存必须失效');

  // 本地档案仍未提交，仍不得出现在共享档案列表。
  const auditsStillOne = await (await fetch(`${base}/audits`)).json();
  assert.deepEqual(auditsStillOne.audits.map((entry) => entry.auditId), ['20261110-100000-repo']);

  // 提交本地档案后才进入共享列表。
  runCommand('git', ['add', '.ai-review/audits/20261110-110000-local'], root);
  runCommand('git', ['commit', '-q', '-m', 'second audit'], root);
  const auditsCommitted = await (await fetch(`${base}/audits`)).json();
  assert.deepEqual(
    auditsCommitted.audits.map((entry) => entry.auditId).sort(),
    ['20261110-100000-repo', '20261110-110000-local'],
  );
});

test('§7.1/G10：非全仓 scope 的空 target_files 会排除 item（buildAuditItems 告警）', async () => {
  const { buildAuditItems } = await import('../dist/auditor.js');
  const warnings = [];
  const items = buildAuditItems([
    { label: '需要人工确认', text: '影响 `src/math.js` 的边界', category: 'confirm' },
    { label: '无路径线索', text: '只描述行为，不写文件', category: 'confirm' },
  ], warnings, 'src');
  assert.deepEqual(items[0].targetFiles, ['src/math.js']);
  assert.deepEqual(items[1].targetFiles, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /target_files/);
  assert.match(warnings[0], /无路径线索/);

  // 全仓 scope 下空 target_files 合法，不告警。
  const warningsAll = [];
  buildAuditItems([{ label: '全仓问题', text: '无路径', category: 'confirm' }], warningsAll, '.');
  assert.equal(warningsAll.length, 0);
});

test('§7.1/G10：负向记忆与已存在候选注入只读共享快照（本地草稿不注入）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  await writeCandidate(root, '20261109-shared-rejected', { title: 'net: 共享被拒方案', status: 'rejected', rejection: true });
  await writeCandidate(root, '20261109-shared-pending', { title: 'net: 共享待审方案', status: 'pending' });
  commitAll(root, 'shared candidates');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // 本地未提交的 rejected/pending 草稿。
  await writeCandidate(root, '20261109-local-rejected', { title: 'net: 本地被拒方案', status: 'rejected', rejection: true });
  await writeCandidate(root, '20261109-local-pending', { title: 'net: 本地待审方案', status: 'pending' });

  const source = await GitHeadCandidateSource.create(root);
  assert.ok(source);
  const prompt = await buildAuditPrompt({
    repoRoot: root,
    vcsType: 'git',
    owner: 'tester',
    targetPath: '',
    note: '',
    baseRevision: head,
    reportPath: '.ai-review/audits/20261110-120000-repo/audit.md',
    mode: 'headless',
    source,
  });

  const memory = prompt.split('## 负向记忆')[1]?.split('## 仓库结构摘要')[0] ?? '';
  assert.match(memory, /共享被拒方案/, '共享 rejected 必须注入负向记忆');
  assert.doesNotMatch(memory, /本地被拒方案/, '本地 rejected 草稿不得注入负向记忆');

  const existing = prompt.split('## 已存在的候选')[1]?.split('## 负向记忆')[0] ?? '';
  assert.match(existing, /共享待审方案/, '共享 pending 必须列为已存在候选');
  assert.doesNotMatch(existing, /本地待审方案/, '本地草稿不得列为共享已存在候选');
});
