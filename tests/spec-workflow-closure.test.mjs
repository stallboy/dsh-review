import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { AuditLifecycle } from '../packages/dsh-plugin/dist/host/audit-lifecycle.js';
import { SvnAdapter, createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { previewAuditPrompt } from '../packages/dsh-plugin/dist/host/auditor.js';
import { finalizeIssueAudit } from '../packages/dsh-plugin/dist/host/issue-finalize.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { assertAppendOnlyHistory } from '../packages/dsh-plugin/dist/host/history-guard.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture, patchFixture, reviewFixture, sha256Hex } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function seedReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewer routing'], root);
}

async function startApi(root, settingsPatch = {}, depsPatch = {}) {
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'dcr-state-')), 'runtime-state.json');
  const settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'manual',
    syncBeforeApprove: false,
    ...settingsPatch,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath, ...depsPatch });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { api, base: `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}` };
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitJob(base, jobId, attempts = 400) {
  let job;
  for (let index = 0; index < attempts; index += 1) {
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return job;
}

async function prepareTwoOptionIssue(root) {
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const p1 = patchFixture();
  const p2 = patchFixture({ to: 'export const add = (a, b) => Number(a) + Number(b);' });
  const dir = path.join(root, '.ai-review', '2026-11', 'parallel-options');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '001.patch'), p1, 'utf8');
  await writeFile(path.join(dir, '002.patch'), p2, 'utf8');
  const meta = {
    schemaVersion: 1,
    findingId: 'parallel-options',
    title: 'math: 并行方案测试',
    module: 'math',
    auditType: 'bugfix',
    issueKind: 'repair',
    dependsOn: null,
    priority: 'P1',
    baseRevision: baseRev,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    owner: 'tester',
    tags: [],
    ticket: null,
    status: 'pending',
    targetFiles: ['src/math.js'],
    recordRevision: 1,
    patches: [
      { id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: baseRev, author: 'ai', sha256: sha256Hex(p1) },
      { id: 2, patch: '002.patch', optionId: 'opt-b', baseRevision: baseRev, author: 'ai', sha256: sha256Hex(p2) },
    ],
    options: [
      { id: 'opt-a', title: '方案 A', tradeoff: '直接修正', confidence: 0.9, currentPatch: 1, gateChecks: ['node --version'] },
      { id: 'opt-b', title: '方案 B', tradeoff: '数值转换', confidence: 0.85, currentPatch: 2, gateChecks: ['node --version'] },
    ],
    observations: [],
    decisions: [],
    repairAttempts: [],
    comments: [],
    humanDecisions: [],
    approval: null,
    approvalHistory: [],
    rejection: null,
    commitMessage: 'math: 并行方案测试',
  };
  await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, '# 问题与影响\n测试\n\n# 需人工判断项\n- 无\n'), 'utf8');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-qm', 'publish two options'], root);
  return { id: '2026-11/parallel-options', meta };
}

test('schema1 /findings 读共享快照，支持 scope 与 disposition 筛选，且本地草稿不可见', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const { id, meta } = await prepareTwoOptionIssue(root);
  const { base } = await startApi(root);

  const dec = await post(base, '/finding/decision', {
    id, expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt,
    action: 'human_takeover', reason: '人工接管',
  });
  assert.equal(dec.status, 200);
  const decBody = await dec.json();
  const hint = await post(base, '/finding/decision', {
    id, expectedRevision: decBody.finding.recordRevision, expectedOwner: decBody.finding.owner, expectedUpdatedAt: decBody.finding.updatedAt,
    action: 'add_repair_hint', hint: 'PR 42',
  });
  assert.equal(hint.status, 200);

  const read = async (query) => {
    const res = await fetch(`${base}/findings${query}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const original = await read('?scope=src&dispositions=human_takeover');
  assert.equal(original.findings.length, 1);
  assert.deepEqual(original.findings[0].repairHints, ['PR 42']);
  assert.equal(original.findings[0].options.length, 2);
  assert.deepEqual((await read('?scope=docs')).findings, []);
  assert.deepEqual((await read('?dispositions=applied')).findings, []);

  // 1) 未提交的新增本地草稿不可见
  const localDraftDir = path.join(root, '.ai-review', '2026-11', 'local-draft-only');
  await mkdir(localDraftDir, { recursive: true });
  await writeFile(path.join(localDraftDir, 'review.md'), reviewFixture('local-draft-only', { status: 'human_takeover' }), 'utf8');
  await writeFile(path.join(localDraftDir, '001.patch'), patchFixture(), 'utf8');
  assert.deepEqual(await read('?scope=src&dispositions=human_takeover'), original);

  // 2) 本地未提交篡改原共享问题会将其降级为 local，不泄露本地内容到共享投影
  await writeFile(path.join(root, '.ai-review', id, 'review.md'), '本地未提交草稿', 'utf8');
  assert.deepEqual((await read('?scope=src&dispositions=human_takeover')).findings, []);
});

test('同一问题的两个备选方案并发审批只产生一次业务提交', async () => {
  const root = await createGitFixture();
  const { id, meta } = await prepareTwoOptionIssue(root);
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root);
  const guard = { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt };
  const outcomes = await Promise.all([
    { optionId: 'opt-a', patchId: 1 },
    { optionId: 'opt-b', patchId: 2 },
  ].map(async (sel) => {
    const res = await post(base, '/approve', { id, ...guard, ...sel, confirmedDecisions: [], waivedDecisions: [] });
    if (res.status === 409) return 'ABORTED';
    const body = await res.json();
    assert.equal(res.status, 202, JSON.stringify(body));
    const job = await waitJob(base, body.jobId);
    return job.result.status;
  }));
  assert.deepEqual(outcomes.sort(), ['ABORTED', 'COMMITTED']);
  assert.equal(runCommand('git', ['rev-list', '--count', `${before}..HEAD`], root).stdout.trim(), '1');
});

test('提交命令异常中断进入 RECOVERY_REQUIRED 且不推进仓库 HEAD', async () => {
  const root = await createGitFixture();
  const { id, meta } = await prepareTwoOptionIssue(root);
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL(base));
  runtime.vcs.atomicCommit = async () => { throw new Error('测试中断提交响应'); };
  const original = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const res = await post(base, '/approve', {
    id, optionId: 'opt-a', patchId: 1,
    expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt,
    confirmedDecisions: [], waivedDecisions: [],
  });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result.status, 'RECOVERY_REQUIRED');
  assert.equal(job.result.reason, 'COMMIT_OUTCOME_UNKNOWN');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), original);
});

test('明确未提交但业务工作区无法恢复时返回 RECOVERY_REQUIRED / RESTORE_INCOMPLETE', async () => {
  const root = await createGitFixture();
  const { id, meta } = await prepareTwoOptionIssue(root);
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL(base));
  runtime.vcs.atomicCommit = async () => ({
    success: false, commitRevision: null, outOfDate: false, errorOutput: '测试拒绝提交',
  });
  runtime.vcs.revertBusinessWorkspace = async () => {};
  const res = await post(base, '/approve', {
    id, optionId: 'opt-a', patchId: 1,
    expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt,
    confirmedDecisions: [], waivedDecisions: [],
  });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'RECOVERY_REQUIRED', JSON.stringify(job));
});

test('文字方案（confirm）可人工接手、补充线索，旧 guard 拒绝覆盖', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const dir = path.join(root, '.ai-review', '2026-11', 'complex-repair');
  await mkdir(dir, { recursive: true });
  const meta = {
    schemaVersion: 1, findingId: 'complex-repair', title: 'math: 复杂修复', module: 'math',
    auditType: 'bugfix', issueKind: 'confirm', dependsOn: null, priority: 'P1', baseRevision: baseRev,
    createdAt: '2026-11-20T10:02:00Z', updatedAt: '2026-11-20T10:02:00Z', owner: 'tester',
    tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], recordRevision: 1,
    patches: [], options: [], observations: [], decisions: [], repairAttempts: [],
    comments: [], humanDecisions: [], approval: null, approvalHistory: [], rejection: null,
    commitMessage: 'math: 复杂修复',
  };
  await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, '# 问题与影响\n复杂\n\n# 需人工判断项\n- 无\n'), 'utf8');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-qm', 'publish text plan'], root);

  const { base } = await startApi(root);
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  assert.deepEqual(finding.options, []);
  const guard = { expectedRevision: finding.recordRevision, expectedOwner: finding.owner, expectedUpdatedAt: finding.updatedAt };
  const received = await post(base, '/finding/decision', { id: finding.id, ...guard, action: 'human_takeover', reason: '接手' });
  const body = await received.json();
  assert.equal(received.status, 200, JSON.stringify(body));
  assert.equal(body.finding.disposition, 'human_takeover');
  assert.equal((await post(base, '/finding/decision', { id: finding.id, ...guard, action: 'human_takeover' })).status, 409);

  const hint = await post(base, '/finding/decision', {
    id: finding.id,
    expectedRevision: body.finding.recordRevision,
    expectedOwner: body.finding.owner,
    expectedUpdatedAt: body.finding.updatedAt,
    action: 'add_repair_hint',
    hint: 'PR 42',
  });
  assert.equal(hint.status, 200);
  assert.deepEqual((await hint.json()).finding.repairHints, ['PR 42']);
});

test('SVN 拒绝提交后清除处置和批准的 SVN 调度，原操作可以重试', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finding-svn-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  const root = path.join(directory, 'wc');
  await mkdir(repo);
  await mkdir(root);
  runCommand('svnadmin', ['create', 'repo'], directory);
  runCommand('svn', ['checkout', '-q', pathToFileURL(repo).href, 'wc'], directory);
  const svn = (...args) => runCommand('svn', args, root).stdout.trim();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a - b;\n');
  svn('add', 'src');
  svn('commit', '-qm', 'business base');
  svn('update', '-q');
  const candidateId = '2026-11/svn-fix';
  const candidateDir = path.join(root, '.ai-review', candidateId);
  await mkdir(candidateDir, { recursive: true });
  await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n');
  const baseRevision = svn('info', '--show-item', 'revision');
  const reviewPath = path.join(candidateDir, 'review.md');
  const original = reviewFixture('svn-fix', {
    findingId: 'svn-repair',
    baseRevision: JSON.stringify(baseRevision),
    bodyLines: ['# 需人工判断项', '', '- 无'],
  });
  await writeFile(reviewPath, original);
  await writeFile(path.join(candidateDir, '001.patch'), patchFixture());
  svn('add', '.ai-review');
  svn('commit', '-qm', 'finding');
  svn('update', '-q');

  const windows = process.platform === 'win32';
  const hook = path.join(repo, 'hooks', windows ? 'pre-commit.cmd' : 'pre-commit');
  await writeFile(hook, windows ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  if (!windows) await chmod(hook, 0o755);

  const { base } = await startApi(root, { vcsType: 'svn' });
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  const guard = { expectedRevision: finding.recordRevision, expectedOwner: finding.owner, expectedUpdatedAt: finding.updatedAt };
  const action = { id: candidateId, ...guard, action: 'human_takeover', reason: '人工接管' };
  const decline = await post(base, '/finding/decision', action);
  assert.equal(decline.status, 409);
  assert.equal(svn('status'), '');

  const approval = await post(base, '/approve', { id: candidateId, ...guard, optionId: 'opt-a', patchId: 1, confirmedDecisions: [], waivedDecisions: [] });
  assert.equal(approval.status, 202);
  const job = await waitJob(base, (await approval.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job));
  assert.equal(job.result.reason, 'COMMIT_FAILED');
  assert.equal(svn('status'), '');
  assert.equal(await readFile(reviewPath, 'utf8'), original);

  const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
  const operations = new ManagedOperations({
    dataDir: path.join(directory, 'state'), journal,
    workspaces: [{ workspaceId: 'svn', label: 'SVN', root, target: '^/', settings: { runner: 'manual' } }],
  });
  try {
    await operations.init();
    const project = {
      projectId: 'project', nodeId: 'node', workspaceId: 'svn', name: 'SVN', bindingGeneration: 1,
      projectConfigRevision: 1, vcsType: 'svn', target: '^/', enabled: true,
    };
    const command = {
      commandId: 'svn-finding-decision', requestHash: 'b'.repeat(64), projectId: project.projectId,
      nodeId: project.nodeId, bindingGeneration: 1, projectConfigRevision: 1, operation: 'finding-decision',
      payload: { id: candidateId, action: 'human_takeover', reason: '人工接管' }, guard,
      actor: { userId: 'tester-id', reviewIdentity: 'tester' },
      createdAt: new Date().toISOString(),
    };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.delivery.state, 'not_required');
    assert.equal(svn('status'), '');
  } finally {
    await operations.stop();
    journal.close();
  }
  await rm(hook);
  const retry = await post(base, '/finding/decision', action);
  assert.equal(retry.status, 200, await retry.text());
});

for (const kind of ['tracked', 'untracked']) {
  test(`§7.6：Mode B /candidate/finalize 遇到 ${kind} 业务修改时中止且完整保留用户内容`, async () => {
    const root = await createGitFixture();
    await seedReviewers(root);
    const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const candidate = await commitCandidate(root, `20261111-finalize-dirty-${kind}`, {
      review: { baseRevision: JSON.stringify(baseRev), bodyLines: ['# 需人工判断项', '', '- 无'] },
    });
    const userFile = path.join(root, 'src', kind === 'tracked' ? 'math.js' : 'unrelated-user-edit.txt');
    const userText = kind === 'tracked'
      ? 'export const add = (a, b) => a - b;\n// 用户尚未提交的修改\n'
      : '不得删除的用户草稿\n';
    await writeFile(userFile, userText, 'utf8');
    const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const { base } = await startApi(root);

    const response = await post(base, '/candidate/finalize', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
    assert.equal(response.status, 202);
    const job = await waitJob(base, (await response.json()).jobId);
    assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
    assert.equal(job.result?.reason, 'DIRTY_WORKSPACE', JSON.stringify(job.result));
    assert.equal(await readFile(userFile, 'utf8'), userText);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  });
}

test('§7.4：Runner 生成 target_files=[] 的新补丁时不得提交或返回 COMMITTED', async () => {
  const root = await createGitFixture();
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-ai-fix-invalid-targets', {
    review: {
      baseRevision: JSON.stringify(baseRev),
      comments: '\n  - id: c1\n    revision: 1\n    file: ""\n    line: 0\n    author: tester\n    content: 请修复\n    status: unresolved',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dcr-invalid-runner-'));
  const script = path.join(temp, 'runner.mjs');
  await writeFile(script, `
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(process.cwd(), '.ai-review', '2026-11', '20261111-ai-fix-invalid-targets');
const reviewPath = path.join(dir, 'review.md');
let text = await readFile(reviewPath, 'utf8');
text = text.replace('target_files: [src/math.js]', 'target_files: []')
  .replace('record_revision: 1', 'record_revision: 2');
await writeFile(reviewPath, text, 'utf8');
await copyFile(path.join(dir, '001.patch'), path.join(dir, '002.patch'));
`, 'utf8');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root, { runner: 'external', externalCommand: `"${process.execPath}" "${script}"` });

  const response = await post(base, '/ai-fix', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'VALIDATION_FAILED', JSON.stringify(job.result));
  assert.ok(Array.isArray(job.result?.errors) && job.result.errors.length > 0, JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
});

test('§4.3/§13：必填 Frontmatter 字段缺省、null 或类型错误必须成为格式错误', async () => {
  const requiredLines = [
    'finding_id', 'issue_kind', 'priority', 'base_revision', 'updated_at', 'tags', 'ticket',
    'target_files', 'record_revision', 'patches', 'options', 'comments', 'human_decisions',
    'approval', 'approval_history', 'rejection', 'commit_message',
  ];
  for (const field of requiredLines) {
    const lines = reviewFixture('20261111-required-fields').split('\n');
    const kept = [];
    let skipping = false;
    for (const line of lines) {
      if (skipping) {
        if (/^[ \t]/.test(line)) continue;
        skipping = false;
      }
      if (line.startsWith(`${field}:`)) {
        skipping = true;
        continue;
      }
      kept.push(line);
    }
    const text = kept.join('\n');
    assert.throws(() => parseReviewMarkdown(text), new RegExp(field), `${field} 缺省不得静默补默认值`);
  }
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-null-array', { tags: 'null' })), /tags/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-null-string', { owner: 'null' })), /owner/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-number-type', { recordRevision: '"1"' })), /record_revision/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-schema-type', { schemaVersion: '"1"' })), /schema_version/);
});

test('§4.3/§13 I7/I8：approved 候选缺少门禁和判断项快照必须 broken', () => {
  const parsed = parseReviewMarkdown(reviewFixture('20261111-approval-snapshot', {
    status: 'approved',
    approval: '{option_id: opt-a, patch_id: 1, record_revision: 1, repair_attempt_id: 1, base_revision: "1", patch_sha256: "' + 'a'.repeat(64) + '", approved_by: tester, approved_at: "2026-11-01T10:10:00Z", gate_checks: [], gate_results: [], confirmed_decisions: [], waived_decisions: []}',
  }));
  const errors = quickReviewInvariants({
    id: '2026-11/20261111-approval-snapshot',
    month: '2026-11',
    slug: '20261111-approval-snapshot',
    meta: parsed.meta,
  });
  assert.ok(errors.some((error) => error.includes('I7') || error.includes('gate')), errors.join('\n'));
});

test('§4.3 I14：严格校验仍保留未知顶层及嵌套键', () => {
  const text = reviewFixture('20261111-unknown-keys', {
    extraLines: ['future_top:', '  nested: {keep: true}'],
  });
  const parsed = parseReviewMarkdown(text);
  const output = serializeReviewMarkdown(parsed.meta, parsed.body);
  assert.match(output, /future_top:\n\s+nested:\n\s+keep: true/);
});

test('§7.7/§8.2：仅元数据提交时 /queue 的 isBaseBehind=false', async () => {
  const root = await createGitFixture();
  const businessBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-queue-meta-only', {
    review: { baseRevision: JSON.stringify(businessBase) },
  });
  runCommand('git', ['commit', '-q', '--allow-empty', '-m', 'review metadata only'], root);
  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id === candidate.id);
  assert.ok(item, JSON.stringify(queue));
  assert.equal(item.isBaseBehind, false);
});

test('§7.7：base_revision === currentBase 时 /rebase 返回 BASE_UNCHANGED', async () => {
  const root = await createGitFixture();
  const businessBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-rebase-same', {
    review: { baseRevision: JSON.stringify(businessBase), bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  runtime.vcs.getCurrentBase = async () => businessBase;
  const response = await post(base, '/rebase', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'BASE_UNCHANGED');
});

test('§7.7/§7.3：门禁执行中取消会终止进程并返回带 reason 的 ABORTED', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-approve-cancel-gate', {
    review: {
      baseRevision: JSON.stringify(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim()),
      gateChecks: JSON.stringify(['node -e "setTimeout(function(){},60000)"']),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const { base } = await startApi(root);
  const response = await post(base, '/approve', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1, confirmedDecisions: [], waivedDecisions: [] });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const jobId = (await response.json()).jobId;
  let running;
  for (let index = 0; index < 100; index += 1) {
    running = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (running.log.some((line) => line.includes('步骤 8'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await post(base, `/jobs/${jobId}/cancel`, {});
  const started = Date.now();
  const job = await waitJob(base, jobId);
  assert.ok(Date.now() - started < 10_000, '取消不得等待原门禁超时');
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['status', '--porcelain', '--', 'src'], root).stdout.trim(), '');
});

test('§7.6：已确认空闲的会话复用跟踪 Job，自动收尾并发布纯索引档案', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  let ready;
  let request;
  const { base } = await startApi(root, {}, {
    createAuditSession: async input => {
      request = input.requestId;
      return { sessionId: 'audit-idle-session' };
    },
    withAuditSessionIdle: async (sessionId, requestId, signal, finalize) => {
      assert.equal(sessionId, 'audit-idle-session');
      assert.equal(requestId, request);
      await new Promise(resolve => { ready = resolve; });
      await finalize(signal);
      return true;
    },
  });
  const response = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const started = await response.json();
  assert.equal(typeof ready, 'function');
  ready();
  const job = await waitJob(base, started.jobId, 240);
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  const audits = await (await fetch(`${base}/audits`)).json();
  assert.equal(audits.audits.length, 1);
  assert.equal(audits.audits[0].auditId, started.auditId);
});

test('AC-SCHEDULE-01：并发会话审查在同一 repo 锁内取得租约，只创建一个会话', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const calls = [];
  const { api, base } = await startApi(root, {}, {
    createAuditSession: async (input) => {
      calls.push(input);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { sessionId: `manual-${calls.length}` };
    },
  });
  const responses = await Promise.all([
    post(base, '/audit/session', { targetPath: '', note: '' }),
    post(base, '/audit/session', { targetPath: '', note: '' }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  assert.equal(calls.length, 1);
  assert.equal(api.auditLifecycle.all().filter((lease) => lease.state === 'active').length, 1);
});

test('§7.1：本地 reviewers.yml 与补丁不得污染共享读取', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-shared-isolation', {
    review: { bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'shared reviewers'], root);
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: local-only\n', 'utf8');
  await writeFile(path.join(candidate.dir, '001.patch'), 'LOCAL PATCH POLLUTION\n', 'utf8');
  const { base } = await startApi(root);
  const reviewers = await (await fetch(`${base}/reviewers`)).json();
  assert.equal(reviewers.config.defaultOwner, 'tester');
  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent(candidate.id)}`)).json();
  assert.match(detail.patchText, /diff --git a\/src\/math\.js/);
  assert.doesNotMatch(detail.patchText, /LOCAL PATCH POLLUTION/);
  const queue = await (await fetch(`${base}/queue`)).json();
  assert.equal(queue.items.find((item) => item.id === candidate.id)?.local, true);
});

test('§12.3：/sync 状态不明返回 409 和 RECOVERY_REQUIRED details', async () => {
  const root = await createGitFixture();
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  runtime.vcs.syncAndGetLatestBase = async () => ({ base: null, synced: false, uncertain: true, message: 'partial sync' });
  const response = await post(base, '/sync', {});
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.details.status, 'RECOVERY_REQUIRED');
  assert.equal(body.error.details.reason, 'SYNC_STATE_UNKNOWN');
  assert.equal(body.error.details.detail, 'partial sync');
});

test('§7.6：租约 JSON 损坏时 Host 初始化必须 fail-closed', async () => {
  const root = await createGitFixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcr-corrupt-lease-'));
  const statePath = path.join(dir, 'runtime-state.json');
  await writeFile(statePath, '{not json', 'utf8');
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    saveSettings: async (next) => next,
    statePath,
  });
  await assert.rejects(() => api.init());
});

test('§11/AC-PROMPT-01：系统提示词与审查提示词包含完整 9 种 audit_type 且无裸章节引用', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const preview = await previewAuditPrompt({
    store: new ReviewStore(root),
    vcs: createVcs('git', root),
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    owner: 'tester',
    targetPath: '',
    note: '',
    mode: 'headless',
    source: await GitHeadCandidateSource.create(root),
  });
  const assets = await Promise.all([
    readFile(new URL('../packages/dsh-plugin/assets/ai-proposal-system.md', import.meta.url), 'utf8'),
    readFile(new URL('../packages/dsh-plugin/assets/ai-mode-c-system.md', import.meta.url), 'utf8'),
    readFile(new URL('../packages/dsh-plugin/assets/audit/orchestrator.md', import.meta.url), 'utf8'),
  ]);
  for (const text of [preview.prompt, ...assets]) {
    assert.doesNotMatch(text, /§\s*\d/);
  }
  const combined = preview.prompt + '\n' + assets.join('\n');
  for (const type of ['bugfix', 'delete', 'shrink', 'reuse', 'merge', 'split', 'stdlib', 'native', 'yagni']) {
    assert.ok(combined.includes(type), `提示词缺少 audit_type=${type}`);
  }
});

test('§10/AC-UI-01：Client 包含统一入口且不包含已移除的历史遗留入口', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  for (const endpoint of ['/audit/manual', '/audit/finalize', '/audit/release', '/fix-session', '/fix-prompt', '/finding/decision', '/reviewers/init']) {
    assert.ok(source.includes(`'${endpoint}'`) || source.includes(`"${endpoint}"`) || source.includes(`${endpoint}?`), `Client 缺少 ${endpoint}`);
  }
  for (const removed of ['/manual-revision', '/archive-stale', '/reopen', '/convert', '/dismiss-finding']) {
    assert.ok(!source.includes(`'${removed}'`) && !source.includes(`"${removed}"`), `Client 不应再调用已移除入口 ${removed}`);
  }
});

test('§7.4/§4.6：Runner 改写历史补丁正文时不得提交新版本', async () => {
  const root = await createGitFixture();
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-ai-fix-history-rewrite', {
    review: {
      baseRevision: JSON.stringify(baseRev),
      comments: '\n  - id: c1\n    revision: 1\n    file: ""\n    line: 0\n    author: tester\n    content: 请修复\n    status: unresolved',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dcr-history-runner-'));
  const script = path.join(temp, 'runner.mjs');
  await writeFile(script, `
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(process.cwd(), '.ai-review', '2026-11', '20261111-ai-fix-history-rewrite');
await copyFile(path.join(dir, '001.patch'), path.join(dir, '002.patch'));
await writeFile(path.join(dir, '001.patch'), 'HISTORY REWRITTEN\\n', 'utf8');
`, 'utf8');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root, { runner: 'external', externalCommand: `"${process.execPath}" "${script}"` });
  const response = await post(base, '/ai-fix', { ...guardFixture(candidate.id), optionId: 'opt-a', patchId: 1 });
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'VALIDATION_FAILED', JSON.stringify(job.result));
  assert.ok(Array.isArray(job.result?.errors) && job.result.errors.length > 0, JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.equal(runCommand('git', ['show', `HEAD:.ai-review/${candidate.id}/001.patch`], root).stdout.includes('HISTORY REWRITTEN'), false);
});

test('§7.6：租约持久化失败必须回滚内存迁移并继续阻塞', async () => {
  const lease = {
    auditId: '20261111-000000-save-failure', root: '/repo', targetPath: '', trigger: 'manual',
    baseRevision: '1', owner: 'tester', createdAt: '2026-11-11T00:00:00Z', candidateIdsBefore: [], state: 'active',
  };
  const lifecycle = new AuditLifecycle({
    load: async () => [lease],
    save: async () => { throw new Error('disk full'); },
  });
  await lifecycle.load();
  await assert.rejects(() => lifecycle.transition(lease.auditId, 'released'), /disk full/);
  assert.equal(lifecycle.find(lease.auditId)?.state, 'active');
  assert.ok(lifecycle.blockingLeaseFor('/repo'));
});

test('§5.6：finalize 提交报错后完整内容不符必须 RECOVERY_REQUIRED', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-finalize-tampered-commit', {
    review: { baseRevision: JSON.stringify(baseRevision), bodyLines: ['# 需人工判断项', '', '- 无'] },
    commit: false,
  });
  const store = new ReviewStore(root);
  const vcs = createVcs('git', root);
  const realCommit = vcs.atomicCommit.bind(vcs);
  vcs.atomicCommit = async (input) => {
    const result = await realCommit(input);
    if (!result.success) return result;
    await writeFile(path.join(candidate.dir, '001.patch'), 'UNREVIEWED PATCH\n', 'utf8');
    runCommand('git', ['add', '-A', '.ai-review'], root);
    runCommand('git', ['commit', '-q', '--amend', '-m', 'tampered after commit'], root);
    return { success: false, commitRevision: null, outOfDate: false, verificationFailed: true, errorOutput: 'simulated post-commit failure' };
  };
  const result = await finalizeIssueAudit(
    { store, vcs, candidateSource: await GitHeadCandidateSource.create(root) },
    {
      auditId: '20261111-000000-tampered', beforeIds: new Set(), baseRevision,
      targetPath: '', trigger: 'manual', runError: null,
    },
  );
  assert.equal(result.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
  assert.equal(result.reason, 'COMMIT_OUTCOME_UNKNOWN');
});

test('§7.1/§7.6：未提交共享 reviewers.yml 时启动手动审查前置 412 拦截', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root);
  // 本地写入未提交的 reviewers.yml 不能绕过共享视图校验
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  const res = await post(base, '/audit/manual', { targetPath: '', note: '' });
  assert.equal(res.status, 412);
});

test('§8.2：SVN 在非 SVN 目录 checkPatch 返回非 ok 状态', async () => {
  const root = await createGitFixture();
  const svn = new SvnAdapter(root);
  const patchPath = path.join(root, '.tmp', 'dummy.patch');
  await mkdir(path.dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patchFixture(), 'utf8');
  const checked = await svn.checkPatch(patchPath);
  assert.equal(checked.ok, false);
});

test('AC-DATA-03：数值字段不得用字符串或 null 冒充', () => {
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-number-type', { recordRevision: '"1"' })), /record_revision/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-schema-type', { schemaVersion: '"1"' })), /schema_version/);
});

test('I4/I14：提交前校验拒绝篡改创建时间、重排补丁历史与删除嵌套未知键', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-history-guard', {
    review: {
      humanDecisions: '[{id: h1, question: "是否接受", future_nested: {keep: true}}]',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const store = new ReviewStore(root);
  const source = await GitHeadCandidateSource.create(root);
  const previous = (await store.get(candidate.id, null, source)).candidate;

  const badCreated = structuredClone(previous);
  badCreated.meta.recordRevision = previous.meta.recordRevision + 1;
  badCreated.meta.updatedAt = '2026-11-02T10:00:00Z';
  badCreated.meta.createdAt = '2020-01-01T00:00:00Z';
  const errCreated = assertAppendOnlyHistory(previous.meta, badCreated.meta, { mode: 'mode_b', targetOptionId: 'opt-a' });
  assert.ok(errCreated.some((e) => /created_at/.test(e)), errCreated.join('; '));

  const badPatches = structuredClone(previous);
  badPatches.meta.recordRevision = previous.meta.recordRevision + 1;
  badPatches.meta.updatedAt = '2026-11-02T10:00:00Z';
  badPatches.meta.patches = [
    { id: 2, optionId: 'opt-a', patch: '002.patch', baseRevision: previous.meta.baseRevision, author: 'ai', sha256: previous.meta.patches[0].sha256 },
    previous.meta.patches[0],
  ];
  const errPatches = assertAppendOnlyHistory(previous.meta, badPatches.meta, { mode: 'mode_b', targetOptionId: 'opt-a' });
  assert.ok(errPatches.some((e) => /历史补丁/.test(e)), errPatches.join('; '));

  const badExtra = structuredClone(previous);
  badExtra.meta.recordRevision = previous.meta.recordRevision + 1;
  badExtra.meta.updatedAt = '2026-11-02T10:00:00Z';
  badExtra.meta.humanDecisions[0].extra = {};
  const errExtra = assertAppendOnlyHistory(previous.meta, badExtra.meta, { mode: 'mode_b', targetOptionId: 'opt-a' });
  assert.ok(errExtra.some((e) => /未知键/.test(e)), errExtra.join('; '));
});

test('AC-UI-01：本地详情页不含已移除的上传人工补丁、超时归档与重开按钮且含服务端筛选参数', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  for (const label of ['上传人工补丁', '超时归档', '从重开来源恢复']) {
    assert.ok(!source.includes(label), `详情页不应再出现按钮「${label}」`);
  }
  for (const filter of ['statuses', 'tag', 'dir', 'text', 'createdAfter', 'createdBefore']) {
    assert.ok(source.includes(filter), `Client 缺少服务端筛选 ${filter}`);
  }
  assert.match(source, /\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/cancel/);
});

test('AC-UI-01：审查跟踪 Job 运行中面板内收尾按钮不被 busy 死锁', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  assert.match(source, /disabled:\s*auditLaunching,\s*onClick:\s*\(\)\s*=>\s*onFinalizeAudit\(auditLeaseId\)/);
});

test('AC-APPROVE-01：门禁期间候选本地 review.md 被修改时必须中止批准并保留现场', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const tamperScriptDir = await mkdtemp(path.join(os.tmpdir(), 'dcr-gate-tamper-'));
  const tamperScript = path.join(tamperScriptDir, 'tamper.mjs');
  const reviewFile = path.join(root, '.ai-review', '2026-11', '20261111-gate-tamper-review', 'review.md');
  await writeFile(
    tamperScript,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(reviewFile)}, '\\n<!-- tampered -->\\n');\n`,
    'utf8',
  );
  const candidate = await commitCandidate(root, '20261111-gate-tamper-review', {
    review: {
      baseRevision: JSON.stringify(baseRev),
      gateChecks: JSON.stringify([`${JSON.stringify(process.execPath)} ${JSON.stringify(tamperScript)}`]),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const headBefore = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root);
  const res = await post(base, '/approve', {
    ...guardFixture(candidate.id),
    optionId: 'opt-a',
    patchId: 1,
    confirmedDecisions: [],
    waivedDecisions: [],
  });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'BUSINESS_CONTENT_CHANGED', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  await rm(tamperScriptDir, { recursive: true, force: true });
});

test('AC-AUDIT-01：finalize 只读预检期间取消不得提交档案或释放租约', { timeout: 15000 }, async t => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const checking = Promise.withResolvers();
  const releaseCheck = Promise.withResolvers();
  t.after(() => releaseCheck.resolve());
  const { api, base } = await startApi(root, {}, {
    decorateVcs(vcs) {
      const check = vcs.checkPatch.bind(vcs);
      vcs.checkPatch = async (...args) => { checking.resolve(); await releaseCheck.promise; return check(...args); };
      vcs.applyPatch = async () => { throw new Error('审查预检不得实际应用补丁'); };
      return vcs;
    },
  });
  const manual = await post(base, '/audit/manual', { targetPath: '', note: '' });
  assert.equal(manual.status, 202);
  const { auditId } = await manual.json();
  await commitCandidate(root, '20261111-finalize-cancel', {
    review: {
      baseRevision: JSON.stringify(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim()),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
    commit: false,
  });
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const response = await post(base, '/audit/finalize', { auditId });
  assert.equal(response.status, 202);
  const jobId = (await response.json()).jobId;
  await checking.promise;
  await post(base, `/jobs/${jobId}/cancel`, {});
  releaseCheck.resolve();
  const job = await waitJob(base, jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.ok(api.auditLifecycle.blockingLeaseFor(root), '取消 finalize 后租约仍须保留');
});

test('AC-AUDIT-02：手动 finalize 不得用未提交的 reviewers.yml 让候选进入共享历史', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  await commitCandidate(root, '20261111-uncommitted-reviewers', {
    review: { baseRevision: JSON.stringify(baseRevision), bodyLines: ['# 需人工判断项', '', '- 无'] },
    commit: false,
  });
  const store = new ReviewStore(root);
  const vcs = createVcs('git', root);
  const result = await finalizeIssueAudit(
    { store, vcs, candidateSource: await GitHeadCandidateSource.create(root), log: () => undefined },
    {
      auditId: '20261111-000000-uncommitted-reviewers',
      beforeIds: new Set(),
      baseRevision,
      targetPath: '',
      trigger: 'manual',
      runError: null,
    },
  );
  assert.equal(result.status, 'VALIDATION_FAILED', JSON.stringify(result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), baseRevision);
});

test('AC-FIX-01：独立候选成功收尾仅提交 .ai-review 改动，不改动无关业务文件', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-candidate-finalize-clean', {
    review: { baseRevision: JSON.stringify(baseRev), bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const headAfterCommit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root);
  const p2 = patchFixture({ to: 'export const add = (a, b) => (a + b);' });
  await writeFile(path.join(candidate.dir, '002.patch'), p2, 'utf8');
  const existing = parseReviewMarkdown(await readFile(candidate.reviewPath, 'utf8'));
  existing.meta.recordRevision = 2;
  existing.meta.updatedAt = '2026-11-02T10:00:00Z';
  existing.meta.patches.push({
    id: 2, optionId: 'opt-a', patch: '002.patch', baseRevision: headAfterCommit, author: 'ai', sha256: sha256Hex(p2),
  });
  existing.meta.options[0].currentPatch = 2;
  await writeFile(candidate.reviewPath, serializeReviewMarkdown(existing.meta, existing.body), 'utf8');
  const origMath = await readFile(path.join(root, 'src', 'math.js'), 'utf8');

  const res = await post(base, '/candidate/finalize', {
    ...guardFixture(candidate.id),
    optionId: 'opt-a',
    patchId: 1,
  });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), origMath, '无关业务文件不得被改动');
  const changed = runCommand('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], root).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(changed.every((f) => f.startsWith('.ai-review/')), `不得混入业务文件：${changed.join(', ')}`);
});
