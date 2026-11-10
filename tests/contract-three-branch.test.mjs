import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApprovalOrchestrator } from '../dist/approval.js';
import { ReviewStore } from '../dist/store.js';
import { createVcs } from '../dist/vcs.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/**
 * AC-RECOVERY-01（§5.6 三分支）：提交命令失败后必须查询 VCS 并核对内容，
 * 按“提交存在且内容匹配 → 成功 / 已证明不存在 → 恢复并失败 / 无法确定 → RECOVERY_REQUIRED”处理。
 * 这里通过包装真实 GitAdapter 模拟“提交已落地但命令报错”“并发提交推进 HEAD”“命令失败且未提交”三种结果。
 */

const SLUG = '20261110-three-branch';

async function writeCandidate(root, slug = SLUG) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-08T10:00:00+08:00"', 'updated_at: "2026-11-08T10:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', `    base_revision: "${base}"`, '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    `commit_message: "net: ${slug}"`, '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
}

function wrapVcs(real, overrides) {
  return new Proxy(real, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function orchestratorFor(root, vcsOverrides) {
  const store = new ReviewStore(root);
  const real = createVcs('git', root);
  const vcs = wrapVcs(real, vcsOverrides);
  const orchestrator = new ApprovalOrchestrator({
    store,
    vcs,
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', runner: 'manual', syncBeforeApprove: false, autoFixOnFailure: false },
    makeRunner: () => ({ run: async () => ({ success: false, errorMessage: 'not used' }) }),
  });
  const guard = {
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-08T10:00:00+08:00',
  };
  return { orchestrator, guard, store };
}

test('AC-RECOVERY-01：提交命令报错但提交已落地且 review.md 为 approved → 按成功继续（COMMITTED）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const headBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { orchestrator, guard } = await orchestratorFor(root, {
    async atomicCommit(input) {
      // 真实提交成功，但模拟命令超时/报错（提交已落地）。
      const result = await createVcs('git', root).atomicCommit(input);
      assert.equal(result.success, true, result.errorOutput);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated timeout' };
    },
  });
  const outcome = await orchestrator.approve(`2026-11/${SLUG}`, guard, 'job-three-1', () => undefined);
  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  const headAfter = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.notEqual(headAfter, headBefore);
  assert.equal(outcome.commitRevision, headAfter, '返回的版本号必须是真实提交版本');
  // 业务提交确实已落地，且没有把已成功提交回滚。
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
  const committedReview = runCommand('git', ['show', `HEAD:.ai-review/2026-11/${SLUG}/review.md`], root).stdout;
  assert.match(committedReview, /status: approved/);
});

test('AC-RECOVERY-01：提交命令报错但 HEAD 被并发提交推进且内容不匹配 → RECOVERY_REQUIRED，保留现场', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const { orchestrator, guard } = await orchestratorFor(root, {
    async atomicCommit() {
      // 只产生一个无关的空提交（HEAD 前进），本次批准内容并未提交。
      runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'concurrent'], root);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated failure' };
    },
  });
  const outcome = await orchestrator.approve(`2026-11/${SLUG}`, guard, 'job-three-2', () => undefined);
  assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'COMMIT_OUTCOME_UNKNOWN');
  assert.ok(outcome.detail);
  // 结果不明时禁止恢复：本地 review.md 仍是本次批准写入的 approved 内容。
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
  // HEAD 中的 review.md 仍是 pending（本次批准未落地）。
  const committedReview = runCommand('git', ['show', `HEAD:.ai-review/2026-11/${SLUG}/review.md`], root).stdout;
  assert.match(committedReview, /status: pending/);
});

test('AC-RECOVERY-01：提交命令失败且 HEAD 未前进 → COMMIT_FAILED，恢复 review.md 与业务工作区', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const headBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { orchestrator, guard } = await orchestratorFor(root, {
    async atomicCommit() {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated hard failure' };
    },
  });
  const outcome = await orchestrator.approve(`2026-11/${SLUG}`, guard, 'job-three-3', () => undefined);
  assert.equal(outcome.status, 'ABORTED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'COMMIT_FAILED');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, '不得产生提交');
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: pending/, '必须恢复批准前的 review.md');
  assert.match(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), /a - b/);
  assert.equal(runCommand('git', ['status', '--porcelain', 'src'], root).stdout.trim(), '');
});

test('AC-RECOVERY-01：提交失败且提交探针不可读 → RECOVERY_REQUIRED，禁止恢复', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const { orchestrator, guard } = await orchestratorFor(root, {
    async getCommitProbe() {
      return null;
    },
    async atomicCommit() {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated probe failure' };
    },
  });
  const outcome = await orchestrator.approve(`2026-11/${SLUG}`, guard, 'job-three-4', () => undefined);
  assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'COMMIT_OUTCOME_UNKNOWN');
  // 结果不明时保留现场（本次批准写入的本地 review.md 不被回滚）。
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
});

