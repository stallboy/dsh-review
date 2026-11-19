import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown, ReviewFormatError } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { createGitFixture, runCommand } from './helpers.mjs';

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
  const bare = [
    '---',
    'schema_version: 1',
    'title: "net: bare"',
    'module: net',
    'audit_type: bugfix',
    'created_at: 2026-11-04T10:00:00+08:00',
    'updated_at: 2026-11-04T10:00:00+08:00',
    'owner: tester',
    'tags: []',
    'status: pending',
    'ticket: null',
    'target_files: []',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    'gate_checks: []',
    'comments: []',
    'human_decisions: []',
    'approval: null',
    'rejection: null',
    'commit_message: "net: bare"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  const parsed = parseReviewMarkdown(bare); // 未加引号的 YAML 时间也可能被解析为 Date。
  assert.equal(new Date(parsed.meta.createdAt).toISOString(), '2026-11-04T02:00:00.000Z');
  const quoted = parseReviewMarkdown(bare.replace('created_at: 2026-11-04T10:00:00+08:00', 'created_at: "2026-11-04T10:00:00+08:00"'));
  const zulu = parseReviewMarkdown(bare.replace('created_at: 2026-11-04T10:00:00+08:00', 'created_at: "2026-11-04T02:00:00Z"'));
  assert.equal(new Date(parsed.meta.createdAt).getTime(), new Date(quoted.meta.createdAt).getTime());
  assert.equal(new Date(quoted.meta.createdAt).getTime(), new Date(zulu.meta.createdAt).getTime());
});

test('修复：嵌套未知键往返保留（I14 深层）', () => {
  const withNested = [
    '---',
    'schema_version: 1',
    'title: "net: nested"',
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-04T10:00:00+08:00"',
    'updated_at: "2026-11-04T10:00:00+08:00"',
    'owner: tester',
    'tags: []',
    'status: pending',
    'ticket: null',
    'target_files: []',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    '    custom_rev_key: keep-rev',
    'gate_checks: []',
    'comments:',
    '  - id: c1',
    '    revision: 1',
    '    file: src/a.js',
    '    line: 3',
    '    side: RIGHT',
    '    author: t',
    '    content: x',
    '    status: unresolved',
    '    custom_comment_key: keep-comment',
    'human_decisions: []',
    'approval: null',
    'rejection: null',
    'commit_message: "net: nested"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  const parsed = parseReviewMarkdown(withNested);
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  assert.match(out, /custom_rev_key: keep-rev/);
  assert.match(out, /custom_comment_key: keep-comment/);
  const reparsed = parseReviewMarkdown(out);
  assert.equal(reparsed.meta.revisions[0].extra?.custom_rev_key, 'keep-rev');
  assert.equal(reparsed.meta.comments[0].extra?.custom_comment_key, 'keep-comment');
});

test('修复：I7——approval 快照与顶层 gate_checks 不一致标 broken；快照留痕读回', async () => {
  // 故意让顶层门禁与批准快照不同，用来检出读侧误用顶层值。
  const approvedFm = (snapshot) => [
    '---',
    'schema_version: 1',
    'title: "net: snap"',
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-04T10:00:00+08:00"',
    'updated_at: "2026-11-04T10:00:00+08:00"',
    'owner: tester',
    'tags: []',
    'status: approved',
    'ticket: null',
    'target_files: [src/math.js]',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    '    author: ai',
    'gate_checks:',
    '  - "node --version"',
    'comments: []',
    'human_decisions: []',
    'approval:',
    '  approved_by: tester',
    '  approved_at: "2026-11-04T11:00:00+08:00"',
    '  commit_revision: "abc"',
    '  gate_checks:',
    snapshot ? '    - "node --version"' : '    - "echo tampered"',
    '  gate_results:',
    '    - command: node --version',
    '      exit_code: 0',
    '      duration_ms: 10',
    '  confirmed_decisions: []',
    '  waived_decisions: []',
    'rejection: null',
    'commit_message: "net: snap"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  const ok = parseReviewMarkdown(approvedFm(true));
  assert.deepEqual(quickReviewInvariants(ok.meta ? { id: '2026-11/x', month: '2026-11', slug: 'x', meta: ok.meta } : {}), []);
  assert.equal(ok.meta.approval?.gateResults?.[0].exit_code, 0);
  assert.deepEqual(ok.meta.approval?.confirmedDecisions, []);
  const roundtrip = serializeReviewMarkdown(ok.meta, ok.body);
  assert.match(roundtrip, /gate_results:/);
  assert.match(roundtrip, /waived_decisions: \[\]/);
  const bad = parseReviewMarkdown(approvedFm(false));
  const errors = quickReviewInvariants({ id: '2026-11/x', month: '2026-11', slug: 'x', meta: bad.meta });
  assert.ok(errors.some((e) => e.startsWith('I7')), errors.join('|'));
  assert.throws(() => parseReviewMarkdown(approvedFm(true).replace('  approved_by: tester\n', '')), ReviewFormatError);
});

test('修复：duplicateOf 候选被阻止批准；broken 候选详情可读', async () => {
  const root = await createGitFixture();
  const fm = (slug, status, extra = {}) => [
    '---',
    'schema_version: 1',
    `title: "net: ${extra.titleText ?? slug}"`,
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-04T10:00:00+08:00"',
    'updated_at: "2026-11-04T10:00:00+08:00"',
    'owner: tester',
    'tags: []',
    `status: ${status}`,
    'ticket: null',
    'target_files: [src/math.js]',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    '    author: ai',
    'gate_checks: ["node --version"]',
    'comments: []',
    'human_decisions: []',
    'approval: null',
    status === 'rejected'
      ? ['rejection:', '  rejected_by: tester', `  rejected_at: "${extra.rejectedAt ?? '2026-11-04T12:00:00+08:00'}"`, '  reason: "不采用"'].join('\n')
      : 'rejection: null',
    'commit_message: "net: x"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  const dirOf = (slug) => path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dirOf('20261106-old'), { recursive: true });
  await writeFile(path.join(dirOf('20261106-old'), 'review.md'), fm('20261106-old', 'rejected', { titleText: '修复加法' }), 'utf8');
  await mkdir(dirOf('20261106-dup'), { recursive: true });
  await writeFile(path.join(dirOf('20261106-dup'), 'review.md'), fm('20261106-dup', 'pending', { titleText: '修复加法' }), 'utf8');
  await writeFile(path.join(dirOf('20261106-dup'), '001.patch'), 'diff --git a/src/math.js b/src/math.js\n', 'utf8');
  await mkdir(dirOf('20261106-broken'), { recursive: true });
  const brokenText = fm('20261106-broken', 'approved');
  await writeFile(path.join(dirOf('20261106-broken'), 'review.md'), brokenText.replace(/status: approved/, 'status: approved'), 'utf8');
  await writeFile(path.join(dirOf('20261106-broken'), 'review.md'), brokenText, 'utf8');
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrejection_memory_days: 30\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);

  const { base } = await startApi(root);
  const blocked = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261106-dup', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: '2026-11-04T10:00:00+08:00' }),
  });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error.message, /完全重复/);

  // 将损坏的候选提交至 HEAD 才能覆盖共享详情，留在工作区只会进入本地诊断。
  const dupPath = path.join(dirOf('20261106-dup'), 'review.md');
  const original = await readFile(dupPath, 'utf8');
  await writeFile(dupPath, original.replace('current_revision: 1', 'current_revision: 9'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'break dup'], root);
  const detail = await (await fetch(`${base}/candidate?id=2026-11/20261106-dup`)).json();
  assert.ok(detail.candidate?.parseError?.includes('current_revision=9'), detail.candidate?.parseError);
  await writeFile(dupPath, original, 'utf8');
});

test('修复：approval 不再保存 commit_revision——旧字段只读保留，派生 unknown 仅诊断（§5.5）', async () => {
  const root = await createGitFixture();
  const dir = path.join(root, '.ai-review', '2026-11', '20261106-bf');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', 'title: "net: bf"', 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-04T10:00:00+08:00"', 'updated_at: "2026-11-04T11:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: approved', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []',
    'approval:', '  approved_by: tester', '  approved_at: "2026-11-04T11:00:00+08:00"',
    '  gate_checks: ["node --version"]', '  gate_results: [{command: "node --version", exit_code: 0, duration_ms: 1}]',
    '  confirmed_decisions: []', '  waived_decisions: []', '  commit_revision: null',
    'rejection: null', 'commit_message: "net: bf"',
    '---', '', '# 问题与影响', '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  const gone = await fetch(`${base}/backfill`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '2026-11/20261106-bf', commitRevision: 'deadbeef' }),
  });
  assert.equal(gone.status, 404);

  // 历史缺少同时删除补丁并转入 approved 的提交，用来触发无法定位批准版本的场景。
  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261106-bf')}`)).json();
  assert.equal(detail.approvalCommitLookup, 'unknown');
  assert.equal(detail.approvalCommitRevision, undefined);
  assert.equal(detail.candidate.parseError, undefined);
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('20261106-bf'));
  assert.equal(item?.approvalCommitLookup, 'unknown');
  assert.equal(item?.needsBackfill, undefined);
});
