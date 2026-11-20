import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { AuditArchive } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({
    settings,
    saveSettings: async (next) => next,
    statePath: path.join(root, '.tmp', 'runtime-state.json'),
  });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function writeCandidate(root, slug, owner = 'tester') {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-09T10:00:00+08:00"', 'updated_at: "2026-11-09T10:00:00+08:00"', `owner: ${owner}`,
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    `commit_message: "net: ${slug}"`, '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js',
    '@@ -1 +1 @@', '-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;', '',
  ].join('\n'), 'utf8');
}

async function waitForJob(base, jobId) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
  }
  throw new Error('job 超时');
}

async function ensureReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
}

test('G20/G1：手动租约 → 阻塞共享写 → finalize 生成目录式档案并提交 → 释放', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);

  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();
  assert.match(manual.auditId, /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*$/);
  assert.match(manual.reportPath, new RegExp(`audits/${manual.auditId}/audit\.md$`));
  assert.ok(manual.prompt.includes('严禁执行 `git commit`'), '外部提示词必须禁止 Agent 提交');

  await writeCandidate(root, '20261109-manual-ok');
  const blocked = await fetch(`${base}/rebase`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-manual-ok', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00',
    }),
  });
  assert.equal(blocked.status, 409);

  const reportBody = [
    '# 仓库审查报告', '',
    '## A 类：已生成候选', '- `.ai-review/2026-11/20261109-manual-ok/`：net: ok（bugfix）', '',
    '## B 类：需人工确认（未改代码）', '- **认证流程需要拍板**：是否保留旧 Token 适配层。', '',
    '## 待前置合入后处理（Deferred）', '- **清理旧适配层**：依赖「认证流程需要拍板」先确认。', '',
    '## 验证与说明', '- node --version 通过。', '',
  ].join('\n');
  await mkdir(path.join(root, manual.reportPath.split('/').slice(0, -1).join('/')), { recursive: true });
  await writeFile(path.join(root, manual.reportPath), reportBody, 'utf8');

  const finalizeStart = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  assert.equal(finalizeStart.status, 202);
  const { jobId } = await finalizeStart.json();
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
  assert.ok(job.result.commitRevision);

  const auditText = await readFile(path.join(root, '.ai-review', 'audits', manual.auditId, 'audit.md'), 'utf8');
  assert.match(auditText, /schema_version: 1/);
  assert.match(auditText, new RegExp(`audit_id: ${manual.auditId}`));
  assert.match(auditText, /candidates:\n\s+- 2026-11\/20261109-manual-ok/);
  assert.match(auditText, /kind: confirm/);
  assert.match(auditText, /kind: deferred/);
  assert.match(auditText, /depends_on: f-[0-9a-f]{10}/);
  // 对照审查 ID 嵌入的 UTC 时间，防止归档名和 created_at 来自不同时刻（I13）。
  const stamp = manual.auditId.slice(0, 15);
  const expectedIso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  assert.match(auditText, new RegExp(`created_at: ['"]?${expectedIso.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal((auditText.match(/<!-- ai-review:audit-verification -->/g) ?? []).length, 1);
  const tracked = runCommand('git', ['ls-files', '.ai-review/audits'], root).stdout.trim();
  assert.ok(tracked.includes(`${manual.auditId}/audit.md`), tracked);

  const okComment = await fetch(`${base}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261109-manual-ok', expectedRevision: 1, expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-09T10:00:00+08:00', content: '租约释放后的评论',
    }),
  });
  assert.equal(okComment.status, 200);
});

test('G20：重复 finalize 拒绝；release 需显式确认停止', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root);
  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();

  const noConfirm = await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  assert.equal(noConfirm.status, 409);

  const activeRelease = await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId, confirmStopped: true }),
  });
  assert.equal(activeRelease.status, 409);

  const cancelled = await fetch(`${base}/jobs/${encodeURIComponent(manual.jobId)}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(cancelled.status, 202);

  const released = await fetch(`${base}/audit/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId, confirmStopped: true }),
  });
  assert.equal(released.status, 200);

  const refinalize = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  assert.equal(refinalize.status, 409);
});

test('G3：owner 填错的候选不进入共享提交（VALIDATION_FAILED + 目录留在本地）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  const { base } = await startApi(root);
  const manual = await (await fetch(`${base}/audit/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPath: '', note: '' }),
  })).json();
  await writeCandidate(root, '20261109-wrong-owner', 'someone-else');
  const finalizeStart = await fetch(`${base}/audit/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auditId: manual.auditId }),
  });
  const { jobId } = await finalizeStart.json();
  const job = await waitForJob(base, jobId);
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  const tracked = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim();
  assert.equal(tracked, '', tracked);
  // 失败候选应从 Frontmatter 的候选列表移除，错误详情仍由复核块保留。
  const auditText = await readFile(path.join(root, '.ai-review', 'audits', manual.auditId, 'audit.md'), 'utf8');
  assert.doesNotMatch(auditText, /candidates:\n\s+- 20261109-wrong-owner/);
  assert.match(auditText, /未通过收尾校验/);
  assert.match(auditText, /owner 应为 tester/);
});

test('收尾拒绝重复键和缺失字段，Job 保留原始格式错误', async () => {
    const root = await createGitFixture();
    await ensureReviewers(root);
    const { base } = await startApi(root);
    const post = async (route, data) => (await fetch(base + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    })).json();
    const { auditId } = await post('/audit/manual', { targetPath: '', note: '' });
    const duplicate = '20261109-duplicate-owner', missing = '20261109-missing-owner';
    const valid = '20261109-valid-owner';
    await writeCandidate(root, valid);
    await writeCandidate(root, duplicate, 'other\nowner: tester');
    await writeCandidate(root, missing);
    const missingReview = path.join(root, '.ai-review', '2026-11', missing, 'review.md');
    await writeFile(missingReview, (await readFile(missingReview, 'utf8')).replace('owner: tester\n', ''), 'utf8');

    const { jobId } = await post('/audit/finalize', { auditId });
    const job = await waitForJob(base, jobId);
    assert.equal(job.result.status, 'VALIDATION_FAILED');
    const results = new Map(job.result.created.map(candidate => [candidate.id, candidate.errors]));
    assert.match(results.get(`2026-11/${duplicate}`)[0], /duplicated mapping key/);
    assert.match(results.get(`2026-11/${missing}`)[0], /owner.*必填/);
    const validation = new Map(job.result.dataValidation.map(file => [file.path, file.errors]));
    assert.equal(validation.size, 4);
    assert.deepEqual(validation.get(`.ai-review/2026-11/${valid}/review.md`), []);
    assert.match(validation.get(`.ai-review/2026-11/${duplicate}/review.md`)[0], /duplicated mapping key[\s\S]*owner:/);
    assert.match(validation.get(`.ai-review/2026-11/${missing}/review.md`)[0], /owner.*必填/);
    assert.deepEqual(validation.get(`.ai-review/audits/${auditId}/audit.md`), []);
    const committed = runCommand('git', ['ls-files', '.ai-review/2026-11'], root).stdout.trim().split('\n');
    assert.deepEqual(committed, [`.ai-review/2026-11/${valid}/001.patch`, `.ai-review/2026-11/${valid}/review.md`]);
});

test('正式 audit.md 校验失败时 Job 指明字段并保留租约和本轮文件', async (t) => {
    const write = AuditArchive.prototype.writeExisting;
    t.mock.method(AuditArchive.prototype, 'writeExisting', async function (meta, body) {
        const record = await write.call(this, meta, body);
        const text = await readFile(record.reviewPath, 'utf8');
        await writeFile(record.reviewPath, text.replace(/^previous_audit: .*\n/m, ''), 'utf8');
        return record;
    });
    const root = await createGitFixture();
    await ensureReviewers(root);
    const { base } = await startApi(root);
    const post = async (route, data) => (await fetch(base + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    })).json();
    const { auditId } = await post('/audit/manual', { targetPath: '', note: '' });
    const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const slug = '20261109-valid-review';
    await writeCandidate(root, slug);

    const { jobId } = await post('/audit/finalize', { auditId });
    const job = await waitForJob(base, jobId);
    const auditPath = `.ai-review/audits/${auditId}/audit.md`;
    assert.equal(job.result.status, 'ABORTED');
    assert.equal(job.result.commitRevision, null);
    assert.deepEqual(job.result.dataValidation, [
        { path: `.ai-review/2026-11/${slug}/review.md`, errors: [] },
        { path: auditPath, errors: ['previous_audit 是必填字段，不得缺省'] },
    ]);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
    assert.match(await readFile(path.join(root, auditPath), 'utf8'), /schema_version: 1/);
    assert.match(await readFile(path.join(root, '.ai-review', '2026-11', slug, 'review.md'), 'utf8'), /owner: tester/);
    const queue = await fetch(base + '/queue').then(response => response.json());
    assert.equal(queue.auditLease.auditId, auditId);
});
