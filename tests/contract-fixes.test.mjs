import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { patchFixture, reviewFixture, sha256Hex, writeCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, settingsPatch = {}) {
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false,
    ...settingsPatch,
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
  return { base, api };
}

test('修复：裸 ISO（YAML Date 对象）被接受并规范化为 UTC Z', () => {
  const base = reviewFixture('bare', {
    title: 'net: bare',
    commitMessage: 'net: bare',
    createdAt: '2026-11-04T10:00:00+08:00',
    updatedAt: '2026-11-04T10:00:00+08:00',
  });
  const bare = base
    .replace('created_at: "2026-11-04T10:00:00+08:00"', 'created_at: 2026-11-04T10:00:00+08:00')
    .replace('updated_at: "2026-11-04T10:00:00+08:00"', 'updated_at: 2026-11-04T10:00:00+08:00');
  const parsed = parseReviewMarkdown(bare); // 未加引号的 YAML 时间也可能被解析为 Date。
  assert.equal(new Date(parsed.meta.createdAt).toISOString(), '2026-11-04T02:00:00.000Z');
  const quoted = parseReviewMarkdown(base);
  const zulu = parseReviewMarkdown(base.replace('created_at: "2026-11-04T10:00:00+08:00"', 'created_at: "2026-11-04T02:00:00Z"'));
  assert.equal(new Date(parsed.meta.createdAt).getTime(), new Date(quoted.meta.createdAt).getTime());
  assert.equal(new Date(quoted.meta.createdAt).getTime(), new Date(zulu.meta.createdAt).getTime());
});

test('修复：嵌套未知键往返保留（I14 深层）', () => {
  const patchText = patchFixture();
  const sha = sha256Hex(patchText);
  const withNested = reviewFixture('nested', {
    title: 'net: nested',
    commitMessage: 'net: nested',
    patches: [
      '',
      '  - id: 1',
      '    patch: 001.patch',
      '    option_id: opt-a',
      '    base_revision: "1"',
      '    author: ai',
      `    sha256: "${sha}"`,
      '    custom_patch_key: keep-patch',
    ].join('\n'),
    comments: [
      '',
      '  - id: c1',
      '    revision: 1',
      '    option_id: opt-a',
      '    patch_id: 1',
      '    file: src/math.js',
      '    line: 3',
      '    side: RIGHT',
      '    author: t',
      '    content: x',
      '    status: unresolved',
      '    custom_comment_key: keep-comment',
    ].join('\n'),
  });
  const parsed = parseReviewMarkdown(withNested);
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  assert.match(out, /custom_patch_key: keep-patch/);
  assert.match(out, /custom_comment_key: keep-comment/);
  const reparsed = parseReviewMarkdown(out);
  assert.equal(reparsed.meta.patches[0].extra?.custom_patch_key, 'keep-patch');
  assert.equal(reparsed.meta.comments[0].extra?.custom_comment_key, 'keep-comment');
});

test('修复：I9——approval 快照与所选方案 gate_checks 不一致标 broken；快照留痕读回', async () => {
  const patchText = patchFixture();
  const sha = sha256Hex(patchText);
  const approvedFm = (matchGate) => reviewFixture('snap', {
    title: 'net: snap',
    commitMessage: 'net: snap',
    status: 'approved',
    patchText,
    patchSha256: sha,
    repairAttempts: [
      '',
      '  - id: 1',
      '    option_id: opt-a',
      '    patch_id: 1',
      '    base_revision: "1"',
      '    actor: tester',
      '    at: "2026-11-04T11:00:00+08:00"',
      '    apply_mode: program_strict',
      '    result: applied',
      '    restored: false',
      '    evidence: "ok"',
    ].join('\n'),
    approval: [
      '',
      '  approved_by: tester',
      '  approved_at: "2026-11-04T11:00:00+08:00"',
      '  record_revision: 1',
      '  option_id: opt-a',
      '  patch_id: 1',
      `  patch_sha256: "${sha}"`,
      '  repair_attempt_id: 1',
      '  base_revision: "1"',
      '  gate_checks:',
      matchGate ? '    - "node --version"' : '    - "echo tampered"',
      '  gate_results:',
      '    - command: "node --version"',
      '      exit_code: 0',
      '      duration_ms: 10',
      '  confirmed_decisions: []',
      '  waived_decisions: []',
    ].join('\n'),
  });
  const ok = parseReviewMarkdown(approvedFm(true));
  assert.deepEqual(quickReviewInvariants({ id: '2026-11/x', month: '2026-11', slug: 'x', meta: ok.meta }), []);
  assert.equal(ok.meta.approval?.gateResults?.[0].exitCode, 0);
  assert.deepEqual(ok.meta.approval?.confirmedDecisions, []);
  const roundtrip = serializeReviewMarkdown(ok.meta, ok.body);
  assert.match(roundtrip, /gate_results:/);
  assert.match(roundtrip, /waived_decisions: \[\]/);
  const bad = parseReviewMarkdown(approvedFm(false));
  const errors = quickReviewInvariants({ id: '2026-11/x', month: '2026-11', slug: 'x', meta: bad.meta });
  assert.ok(errors.some((e) => e.includes('gate_checks')), errors.join('|'));
  assert.throws(() => parseReviewMarkdown(approvedFm(true).replace('  approved_by: tester\n', '')), /approved_by/);
});

test('修复：duplicateOf 候选被阻止批准；broken 候选详情可读', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261106-old', {
    review: {
      findingId: 'old-add-bug',
      title: 'net: 修复加法',
      commitMessage: 'net: 修复加法',
      status: 'rejected',
      updatedAt: '2026-11-04T10:00:00+08:00',
      rejection: [
        '',
        '  rejected_by: tester',
        `  rejected_at: "${new Date(Date.now() - 2 * 86_400_000).toISOString()}"`,
        '  reason: "不采用"',
      ].join('\n'),
    },
  });
  await writeCandidate(root, '20261106-dup', {
    review: {
      findingId: 'dup-add-bug',
      title: 'net: 修复加法',
      commitMessage: 'net: 修复加法',
      status: 'pending',
      updatedAt: '2026-11-04T10:00:00+08:00',
    },
  });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrejection_memory_days: 30\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const blocked = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '2026-11/20261106-dup',
      expectedRevision: 1,
      expectedOwner: 'tester',
      expectedUpdatedAt: '2026-11-04T10:00:00+08:00',
      optionId: 'opt-a',
      patchId: 1,
    }),
  });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error.message, /重复/);

  // 将损坏的候选提交至 HEAD 才能覆盖共享详情，留在工作区只会进入本地诊断。
  const dupPath = path.join(root, '.ai-review', '2026-11', '20261106-dup', 'review.md');
  const original = await readFile(dupPath, 'utf8');
  await writeFile(dupPath, original.replace('current_patch: 1', 'current_patch: 9'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'break dup'], root);
  const detail = await (await fetch(`${base}/candidate?id=2026-11/20261106-dup`)).json();
  assert.ok(detail.candidate?.parseError?.includes('current_patch'), detail.candidate?.parseError);
  await writeFile(dupPath, original, 'utf8');
});

test('修复：approval 不再保存 commit_revision——派生 unknown 仅诊断（§5.5）', async () => {
  const root = await createGitFixture();
  const patchText = patchFixture();
  const sha = sha256Hex(patchText);
  await writeCandidate(root, '20261106-bf', {
    review: {
      title: 'net: bf',
      commitMessage: 'net: bf',
      status: 'approved',
      updatedAt: '2026-11-04T11:00:00+08:00',
      patchText,
      patchSha256: sha,
      repairAttempts: [
        '',
        '  - id: 1',
        '    option_id: opt-a',
        '    patch_id: 1',
        '    base_revision: "1"',
        '    actor: tester',
        '    at: "2026-11-04T11:00:00+08:00"',
        '    apply_mode: program_strict',
        '    result: applied',
        '    restored: false',
        '    evidence: "gate ok"',
      ].join('\n'),
      approval: [
        '',
        '  approved_by: tester',
        '  approved_at: "2026-11-04T11:00:00+08:00"',
        '  record_revision: 1',
        '  option_id: opt-a',
        '  patch_id: 1',
        `  patch_sha256: "${sha}"`,
        '  repair_attempt_id: 1',
        '  base_revision: "1"',
        '  gate_checks: ["node --version"]',
        '  gate_results: [{command: "node --version", exit_code: 0, duration_ms: 1}]',
        '  confirmed_decisions: []',
        '  waived_decisions: []',
      ].join('\n'),
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const gone = await fetch(`${base}/backfill`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261106-bf', commitRevision: 'deadbeef' }),
  });
  assert.equal(gone.status, 404);

  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261106-bf')}`)).json();
  assert.equal(detail.approvalCommitLookup, 'unknown');
  assert.equal(detail.approvalCommitRevision, undefined);
  assert.equal(detail.candidate.parseError, undefined);
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('20261106-bf'));
  assert.equal(item?.approvalCommitLookup, 'unknown');
});
