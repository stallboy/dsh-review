import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quickReviewInvariants, fullReviewInvariants } from '../dist/invariants.js';
import { ReviewStore } from '../dist/store.js';
import { createGitFixture } from './helpers.mjs';

/** P2 验收：§13.1 不变量逐条正反用例 + 队列 broken 隔离。 */

function makeCandidate(overrides = {}) {
  return {
    id: '2026-11/20261104-net-fix',
    month: '2026-11',
    slug: '20261104-net-fix',
    meta: {
      schemaVersion: 1,
      title: 'net: 修复',
      module: 'net',
      auditType: 'bugfix',
      createdAt: '2026-11-04T10:00:00+08:00',
      updatedAt: '2026-11-04T10:00:00+08:00',
      owner: 'tester',
      tags: [],
      status: 'pending',
      ticket: null,
      targetFiles: ['src/a.js'],
      currentRevision: 1,
      revisions: [{ id: 1, baseRevision: 'abc', patch: '001.patch', author: 'ai' }],
      gateChecks: ['node --version'],
      comments: [],
      humanDecisions: [],
      approval: null,
      rejection: null,
      commitMessage: 'net: 修复',
      extra: {},
      ...(overrides.meta ?? {}),
    },
    ...(overrides.top ?? {}),
  };
}

test('P2: 合法候选零错误（正例）', () => {
  assert.deepEqual(quickReviewInvariants(makeCandidate()), []);
  assert.deepEqual(fullReviewInvariants({
    candidate: makeCandidate(),
    patchExists: () => true,
    currentPatchPaths: ['src/a.js'],
  }), []);
});

test('P2: I3 反例——版本号不连续 / current_revision 非最高', () => {
  const bad1 = makeCandidate({ meta: { revisions: [
    { id: 1, baseRevision: 'a', patch: '001.patch' },
    { id: 3, baseRevision: 'a', patch: '003.patch' },
  ], currentRevision: 3 } });
  assert.ok(quickReviewInvariants(bad1).some((e) => e.startsWith('I3')));
  const bad2 = makeCandidate({ meta: { currentRevision: 1, revisions: [
    { id: 1, baseRevision: 'a', patch: '001.patch' },
    { id: 2, baseRevision: 'a', patch: '002.patch' },
  ] } });
  assert.ok(quickReviewInvariants(bad2).some((e) => e.startsWith('I3')));
});

test('P2: I6 反例——approved 无 approval / rejection 缺 reason', () => {
  const bad = makeCandidate({ meta: { status: 'approved', approval: null } });
  assert.ok(quickReviewInvariants(bad).some((e) => e.startsWith('I6')));
  const bad2 = makeCandidate({ meta: {
    status: 'rejected',
    rejection: { rejectedBy: 'tester', rejectedAt: '2026-11-04T11:00:00+08:00', reason: '  ' },
  } });
  assert.ok(quickReviewInvariants(bad2).some((e) => e.startsWith('I6') && e.includes('reason')));
});

test('P2: I11 反例——行内评论缺 side / 指向不存在版本；正例通过', () => {
  const inlineNoSide = makeCandidate({ meta: { comments: [{
    id: 'c1', revision: 1, file: 'src/a.js', line: 5, author: 't', content: 'x', status: 'unresolved',
  }] } });
  assert.ok(quickReviewInvariants(inlineNoSide).some((e) => e.startsWith('I11')));
  const badRevision = makeCandidate({ meta: { comments: [{
    id: 'c1', revision: 9, file: 'src/a.js', line: 5, side: 'RIGHT', author: 't', content: 'x', status: 'unresolved',
  }] } });
  assert.ok(quickReviewInvariants(badRevision).some((e) => e.startsWith('I11') && e.includes('不存在')));
  const okInline = makeCandidate({ meta: { comments: [{
    id: 'c1', revision: 1, file: 'src/a.js', line: 5, side: 'RIGHT', author: 't', content: 'x', status: 'unresolved',
  }] } });
  assert.ok(!quickReviewInvariants(okInline).some((e) => e.startsWith('I11')));
});

test('P2: I12 反例——target_files 含 .. 与绝对路径', () => {
  const bad = makeCandidate({ meta: { targetFiles: ['../outside.js', '/abs/path.js', 'ok.js'] } });
  const errors = quickReviewInvariants(bad).filter((e) => e.startsWith('I12'));
  assert.equal(errors.length, 2);
});

test('P2: I13 反例——时间缺时区偏移', () => {
  const bad = makeCandidate({ meta: { createdAt: '2026-11-04T10:00:00' } });
  assert.ok(quickReviewInvariants(bad).some((e) => e.startsWith('I13')));
});

test('P2: I16 反例——重开字段只出现一个 / 指向非 rejected；正例通过', () => {
  const half = makeCandidate({ meta: { reopenedFrom: '2026-10/20261031-old', reopenedReason: null } });
  assert.ok(quickReviewInvariants(half).some((e) => e.startsWith('I16')));
  const ok = makeCandidate({ meta: {
    reopenedFrom: '2026-10/20261031-old', reopenedReason: '此前为误判',
  } });
  assert.ok(!quickReviewInvariants(ok).some((e) => e.startsWith('I16')));
  const badTarget = fullReviewInvariants({
    candidate: ok,
    patchExists: () => true,
    currentPatchPaths: null,
    reopenedTargetRejected: () => false,
  });
  assert.ok(badTarget.some((e) => e.startsWith('I16') && e.includes('不是 rejected')));
});

test('P2: I4/I5 反例——补丁缺失 / target_files 与补丁路径不一致', () => {
  const missing = fullReviewInvariants({
    candidate: makeCandidate(),
    patchExists: () => false,
    currentPatchPaths: null,
  });
  assert.ok(missing.some((e) => e.startsWith('I4')));
  const mismatch = fullReviewInvariants({
    candidate: makeCandidate(),
    patchExists: () => true,
    currentPatchPaths: ['src/other.js'],
  });
  assert.ok(mismatch.some((e) => e.startsWith('I5')));
});

test('P2: 队列 broken 隔离——违反不变量的候选标记 broken 且不崩溃', async () => {
  const root = await createGitFixture();
  const store = new ReviewStore(root);
  const goodDir = path.join(root, '.ai-review', '2026-11', '20261104-net-good');
  const badDir = path.join(root, '.ai-review', '2026-11', '20261104-net-bad');
  await mkdir(goodDir, { recursive: true });
  await mkdir(badDir, { recursive: true });
  const fm = (status, approval) => [
    '---',
    'schema_version: 1',
    `title: "net: ${status}"`,
    'created_at: "2026-11-04T10:00:00+08:00"',
    'updated_at: "2026-11-04T10:00:00+08:00"',
    'owner: tester',
    'tags: []',
    `status: ${status}`,
    'ticket: null',
    'target_files: []',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    'gate_checks: []',
    'comments: []',
    'human_decisions: []',
    `approval: ${approval}`,
    'rejection: null',
    'commit_message: ""',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  await writeFile(path.join(goodDir, 'review.md'), fm('pending', 'null').replace('target_files: []', 'target_files: [src/math.js]'), 'utf8');
  await writeFile(path.join(goodDir, '001.patch'), [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1 +1 @@',
    '-export const add = (a, b) => a - b;',
    '+export const add = (a, b) => a + b;',
    '',
  ].join('\n'), 'utf8');
  // approved 却 approval: null —— 违反 I6。
  await writeFile(path.join(badDir, 'review.md'), fm('approved', 'null'), 'utf8');
  const { items, errors } = await store.list({}, null);
  assert.equal(errors.length, 0, errors.join('|'));
  const good = items.find((item) => item.id.endsWith('net-good'));
  const bad = items.find((item) => item.id.endsWith('net-bad'));
  assert.equal(good?.parseError, undefined);
  assert.ok(bad?.parseError?.includes('I6'), bad?.parseError);
});
