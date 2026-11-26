import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runApprovalTransaction } from '../packages/dsh-plugin/dist/host/approval.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

const SLUG = '20261110-three-branch';

async function writeCandidate(root, slug = SLUG) {
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeSchemaCandidate(root, slug, {
    review: {
      baseRevision: base,
      createdAt: '2026-11-08T10:00:00+08:00',
      updatedAt: '2026-11-08T10:00:00+08:00',
    },
  });
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

async function runApprove(root, vcsOverrides, jobId) {
  const store = new ReviewStore(root);
  const real = createVcs('git', root);
  const vcs = wrapVcs(real, vcsOverrides);
  const guard = {
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-08T10:00:00+08:00',
  };
  return runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', runner: 'manual', syncBeforeApprove: false, autoFixOnFailure: false },
      jobId,
      log: () => undefined,
      sharedSource: async () => (await GitHeadCandidateSource.create(root)) ?? undefined,
    },
    {
      id: `2026-11/${SLUG}`,
      guard,
      optionId: 'opt-a',
      patchId: 1,
      confirmedDecisions: [],
      waivedDecisions: [],
      actor: 'tester',
    },
  );
}

test('AC-RECOVERY-01：提交命令报错但提交已落地且 review.md 为 approved → 按成功继续（COMMITTED）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const headBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const outcome = await runApprove(root, {
    async atomicCommit(input) {
      const result = await createVcs('git', root).atomicCommit(input);
      assert.equal(result.success, true, result.errorOutput);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated timeout' };
    },
  }, 'job-three-1');
  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  const headAfter = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.notEqual(headAfter, headBefore);
  assert.equal(outcome.commitRevision, headAfter, '返回的版本号必须是真实提交版本');
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
  const committedReview = runCommand('git', ['show', `HEAD:.ai-review/2026-11/${SLUG}/review.md`], root).stdout;
  assert.match(committedReview, /status: approved/);
});

test('AC-RECOVERY-01：提交命令报错但 HEAD 被并发提交推进且内容不匹配 → RECOVERY_REQUIRED，保留现场', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const outcome = await runApprove(root, {
    async atomicCommit() {
      runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'concurrent'], root);
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated failure' };
    },
  }, 'job-three-2');
  assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'COMMIT_OUTCOME_UNKNOWN');
  assert.ok(outcome.detail);
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
  const committedReview = runCommand('git', ['show', `HEAD:.ai-review/2026-11/${SLUG}/review.md`], root).stdout;
  assert.match(committedReview, /status: pending/);
});

test('AC-RECOVERY-01：提交命令失败且 HEAD 未前进 → COMMIT_FAILED，恢复 review.md 与业务工作区', async () => {
  const root = await createGitFixture();
  await writeCandidate(root);
  const headBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const outcome = await runApprove(root, {
    async atomicCommit() {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated hard failure' };
    },
  }, 'job-three-3');
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
  const outcome = await runApprove(root, {
    async getCommitProbe() {
      return null;
    },
    async atomicCommit() {
      return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated probe failure' };
    },
  }, 'job-three-4');
  assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'COMMIT_OUTCOME_UNKNOWN');
  const review = await readFile(path.join(root, '.ai-review', '2026-11', SLUG, 'review.md'), 'utf8');
  assert.match(review, /status: approved/);
});
