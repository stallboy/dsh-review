import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { quickReviewInvariants, fullReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createGitFixture } from './helpers.mjs';
import { patchFixture, reviewFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';

const PATCH_TEXT = patchFixture();
const PATCH_BYTES = Buffer.from(PATCH_TEXT, 'utf8');
const PATCH_SHA = sha256Hex(PATCH_TEXT);

function makeCandidate(overrides = {}) {
  return {
    id: '2026-11/20261104-net-fix',
    month: '2026-11',
    slug: '20261104-net-fix',
    meta: {
      schemaVersion: 1,
      findingId: 'net-fix',
      title: 'net: 修复',
      module: 'net',
      auditType: 'bugfix',
      issueKind: 'repair',
      dependsOn: null,
      priority: 'P1',
      baseRevision: 'abc',
      createdAt: '2026-11-04T10:00:00+08:00',
      updatedAt: '2026-11-04T10:00:00+08:00',
      owner: 'tester',
      tags: [],
      ticket: null,
      status: 'pending',
      targetFiles: ['src/math.js'],
      recordRevision: 1,
      patches: [{ id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: 'abc', author: 'ai', sha256: PATCH_SHA }],
      options: [{ id: 'opt-a', title: '方案 A', tradeoff: '改动小', confidence: 0.9, currentPatch: 1, gateChecks: ['node --version'] }],
      observations: [],
      decisions: [],
      repairAttempts: [],
      comments: [],
      humanDecisions: [],
      approval: null,
      approvalHistory: [],
      rejection: null,
      commitMessage: 'net: 修复',
      ...(overrides.meta ?? {}),
    },
    ...(overrides.top ?? {}),
  };
}

test('P2: 合法候选零错误（正例）', async () => {
  assert.deepEqual(quickReviewInvariants(makeCandidate()), []);
  assert.deepEqual(await fullReviewInvariants({
    ...makeCandidate(),
    patchFilesOnDisk: ['001.patch'],
    readPatchBytes: async () => PATCH_BYTES,
  }), []);
});

test('P2: I3 反例——patches[].id 不连续 / record_revision 非正整数', () => {
  const bad1 = makeCandidate({
    meta: {
      patches: [
        { id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: 'a', author: 'ai', sha256: PATCH_SHA },
        { id: 3, patch: '003.patch', optionId: 'opt-a', baseRevision: 'a', author: 'ai', sha256: PATCH_SHA },
      ],
    },
  });
  assert.ok(quickReviewInvariants(bad1).some((e) => e.includes('连续递增')));
  const bad2 = makeCandidate({ meta: { recordRevision: 0 } });
  assert.ok(quickReviewInvariants(bad2).some((e) => e.includes('record_revision')));
});

test('P2: I8 反例——approved 无 approval / rejected 缺 rejection.reason', () => {
  const bad = makeCandidate({ meta: { status: 'approved', approval: null } });
  assert.ok(quickReviewInvariants(bad).some((e) => e.includes('approval')));
  const bad2 = makeCandidate({
    meta: {
      status: 'rejected',
      rejection: { rejectedBy: 'tester', rejectedAt: '2026-11-04T11:00:00+08:00', reason: '  ' },
    },
  });
  assert.ok(quickReviewInvariants(bad2).some((e) => e.includes('rejection.reason')));
});

test('P2: I11 反例——行内评论缺 side / 缺 option_id / revision 越界；正例通过', () => {
  const inlineNoSide = makeCandidate({
    meta: {
      comments: [{
        id: 'c1', revision: 1, optionId: 'opt-a', patchId: 1, file: 'src/math.js', line: 5, author: 't', content: 'x', status: 'unresolved',
      }],
    },
  });
  assert.ok(quickReviewInvariants(inlineNoSide).some((e) => e.includes('side')));
  const badRevision = makeCandidate({
    meta: {
      comments: [{
        id: 'c1', revision: 9, optionId: 'opt-a', patchId: 1, file: 'src/math.js', line: 5, side: 'RIGHT', author: 't', content: 'x', status: 'unresolved',
      }],
    },
  });
  assert.ok(quickReviewInvariants(badRevision).some((e) => e.includes('revision')));
  const okInline = makeCandidate({
    meta: {
      comments: [{
        id: 'c1', revision: 1, optionId: 'opt-a', patchId: 1, file: 'src/math.js', line: 5, side: 'RIGHT', author: 't', content: 'x', status: 'unresolved',
      }],
    },
  });
  assert.deepEqual(quickReviewInvariants(okInline), []);
});

test('P2: I12 反例——target_files 含 .. 与绝对路径与 .ai-review', () => {
  const bad = makeCandidate({ meta: { targetFiles: ['../outside.js', '/abs/path.js', '.ai-review/x.md', 'ok.js'] } });
  const errors = quickReviewInvariants(bad).filter((e) => e.includes('非法或禁止路径'));
  assert.equal(errors.length, 3);
});

test('P2: I13 反例——时间缺时区偏移', () => {
  const bad = makeCandidate({ meta: { createdAt: '2026-11-04T10:00:00' } });
  assert.ok(quickReviewInvariants(bad).some((e) => e.includes('时区')));
});

test('P2: I7 反例——deferred 缺 depends_on 或自指；非 deferred 携带 depends_on', () => {
  const missingDep = makeCandidate({ meta: { issueKind: 'deferred', options: [], dependsOn: null } });
  assert.ok(quickReviewInvariants(missingDep).some((e) => e.includes('depends_on')));
  const selfDep = makeCandidate({ meta: { issueKind: 'deferred', options: [], dependsOn: 'net-fix' } });
  assert.ok(quickReviewInvariants(selfDep).some((e) => e.includes('自身')));
  const extraDep = makeCandidate({ meta: { issueKind: 'repair', dependsOn: 'other-id' } });
  assert.ok(quickReviewInvariants(extraDep).some((e) => e.includes('必须为 null')));
  const okDeferred = makeCandidate({ meta: { issueKind: 'deferred', options: [], dependsOn: 'other-id', commitMessage: null } });
  assert.deepEqual(quickReviewInvariants(okDeferred), []);
});

test('P2: I4/I5 反例——补丁缺失 / SHA-256 篡改 / target_files 未覆盖补丁路径 / 孤立补丁', async () => {
  const missing = await fullReviewInvariants({
    ...makeCandidate(),
    patchFilesOnDisk: [],
    readPatchBytes: async () => null,
  });
  assert.ok(missing.some((e) => e.includes('缺失')));

  const tampered = await fullReviewInvariants({
    ...makeCandidate(),
    patchFilesOnDisk: ['001.patch'],
    readPatchBytes: async () => Buffer.from(`${PATCH_TEXT}\n`, 'utf8'),
  });
  assert.ok(tampered.some((e) => e.includes('SHA-256')));

  const mismatch = await fullReviewInvariants({
    ...makeCandidate({ meta: { targetFiles: ['src/other.js'] } }),
    patchFilesOnDisk: ['001.patch'],
    readPatchBytes: async () => PATCH_BYTES,
  });
  assert.ok(mismatch.some((e) => e.includes('target_files 未覆盖')));

  const orphan = await fullReviewInvariants({
    ...makeCandidate(),
    patchFilesOnDisk: ['001.patch', '002.patch'],
    readPatchBytes: async () => PATCH_BYTES,
  });
  assert.ok(orphan.some((e) => e.includes('孤立补丁')));
});

test('P2: 队列 broken 隔离——违反不变量的候选标记 broken 且不崩溃', async () => {
  const root = await createGitFixture();
  const store = new ReviewStore(root);
  await writeCandidate(root, '20261104-net-good');
  const badDir = path.join(root, '.ai-review', '2026-11', '20261104-net-bad');
  await mkdir(badDir, { recursive: true });
  await writeFile(path.join(badDir, 'review.md'), reviewFixture('20261104-net-bad', { status: 'approved', approval: ' null' }), 'utf8');
  await writeFile(path.join(badDir, '001.patch'), PATCH_TEXT, 'utf8');

  const { items } = await store.list({}, null);
  const good = items.find((item) => item.id.endsWith('net-good'));
  const bad = items.find((item) => item.id.endsWith('net-bad'));
  assert.equal(good?.parseError, undefined);
  assert.ok(bad?.parseError?.includes('approval'), bad?.parseError);
});
