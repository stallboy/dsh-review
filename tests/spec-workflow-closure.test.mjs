import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { withTrustedActor } from '../packages/dsh-plugin/dist/host/api-context.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { AuditArchive, projectFindings } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { AuditLifecycle } from '../packages/dsh-plugin/dist/host/audit-lifecycle.js';
import { ReadModels } from '../packages/dsh-plugin/dist/host/api-readmodels.js';
import { SvnAdapter, createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { Auditor, buildAuditPrompt, loadAuditSystemPrompt } from '../packages/dsh-plugin/dist/host/auditor.js';
import { Writers } from '../packages/dsh-plugin/dist/host/api-writers.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { FindingApprovalState } from '../packages/dsh-plugin/dist/host/finding-approval-state.js';
import { ManagedJournal } from '../packages/dsh-plugin/dist/managed/managed-journal.js';
import { ManagedOperations } from '../packages/dsh-plugin/dist/managed/managed-operations.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture, patchFixture, reviewFixture } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

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

async function standaloneCandidate(root, slug) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewer routing'], root);
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  return commitCandidate(root, slug, {
    review: {
      baseRevision: JSON.stringify(baseRevision),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
    commit: false,
  });
}

test('v2 发现从共享快照恢复选项和人工处置，筛选结果与无关提交无关', async () => {
  const root = await createGitFixture();
  const findingId = 'addition-result';
  const options = [];
  for (const name of ['first', 'second']) {
    const item = await commitCandidate(root, name, {
      commit: false,
      review: { schemaVersion: 2, extraLines: [`finding_id: ${findingId}`] },
    });
    options.push({ candidateId: item.id, tradeoff: name });
  }
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const archive = new AuditArchive(root);
  const item = {
    findingId, kind: 'repair', title: '加法结果错误', summary: '正数相加的结果不正确',
    targetFiles: ['src/math.js'], dependsOn: null, status: 'pending', candidate: null,
  };
  const firstAudit = {
    schemaVersion: 2, auditId: '20261119-100000-src', createdAt: '2026-11-19T10:00:00Z',
    baseRevision, scope: 'src', trigger: 'manual', previousAudit: null,
    candidates: options.map(option => option.candidateId),
    items: [{ ...item, repairPlan: '恢复正数相加逻辑', options }],
  };
  await archive.write(firstAudit, '# 审查报告\n');
  await archive.write({
    ...firstAudit, auditId: '20261120-100000-src', createdAt: '2026-11-20T10:00:00Z',
    previousAudit: firstAudit.auditId, candidates: [], items: [item],
  }, '# 审查报告\n');
  const decisionDir = path.join(root, '.ai-review', 'findings');
  await mkdir(decisionDir, { recursive: true });
  const decisionPath = path.join(decisionDir, `${findingId}.yml`);
  await writeFile(decisionPath, [
    'schema_version: 1', `finding_id: ${findingId}`, 'events:',
    `  - {revision: 1, audit_id: ${firstAudit.auditId}, actor: tester, at: "2026-11-19T11:00:00Z", action: human_takeover}`,
    `  - {revision: 2, audit_id: ${firstAudit.auditId}, actor: tester, at: "2026-11-19T11:30:00Z", action: add_repair_hint, hint: "PR 42"}`,
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-qm', 'v2 fixture'], root);
  const { base } = await startApi(root);
  const read = async query => {
    const response = await fetch(`${base}/findings${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const query = '?scope=src&dispositions=human_takeover';
  const original = await read(query);
  assert.deepEqual(original.errors, []);
  assert.equal(original.findings.length, 1);
  const [finding] = original.findings;
  assert.equal(finding.lastObservedAudit, '20261120-100000-src');
  assert.equal(finding.repairPlan, '恢复正数相加逻辑');
  assert.deepEqual(finding.repairHints, ['PR 42']);
  assert.deepEqual(finding.options, options.map(option => ({ ...option, status: 'pending' })));
  assert.match(finding.findingVersion, /^[a-f\d]{64}$/);
  assert.deepEqual((await read('?scope=docs')).findings, []);
  assert.deepEqual((await read('?dispositions=applied')).findings, []);
  assert.equal((await fetch(`${base}/findings?scope=../src`)).status, 422);

  const approval = await post(base, '/approve', guardFixture(options[0].candidateId));
  assert.equal(approval.status, 422);
  assert.equal((await post(base, '/approve', guardFixture(options[0].candidateId, {
    expectedFindingVersion: finding.findingVersion,
  }))).status, 409);
  const dismiss = await post(base, '/dismiss-finding', { findingId, auditId: firstAudit.auditId, reason: '旧入口' });
  assert.equal(dismiss.status, 409);

  runCommand('git', ['commit', '--allow-empty', '-qm', 'unrelated'], root);
  await writeFile(decisionPath, '本地未提交草稿', 'utf8');
  assert.deepEqual(await read(query), original);
  runCommand('git', ['add', '.ai-review/findings'], root);
  runCommand('git', ['commit', '-qm', 'invalid shared decision'], root);
  const invalid = await read('');
  assert.deepEqual(invalid.findings, []);
  assert.match(invalid.errors.join(), /addition-result.*处置记录/);
});

async function prepareFindingOptions() {
  const root = await createGitFixture();
  const archive = new AuditArchive(root);
  const findingId = 'parallel-options';
  const revision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const options = [];
  for (const slug of ['option-a', 'option-b']) {
    const candidate = await commitCandidate(root, slug, {
      commit: false,
      review: {
        schemaVersion: 2, extraLines: [`finding_id: ${findingId}`], baseRevision: JSON.stringify(revision),
        bodyLines: ['# 需人工判断项', '', '- 无'],
      },
    });
    options.push({ candidateId: candidate.id, tradeoff: slug });
  }
  const published = {
    schemaVersion: 2, auditId: '20261120-100100-src', createdAt: '2026-11-20T10:01:00Z', scope: 'src',
    trigger: 'manual', previousAudit: null, baseRevision: revision, candidates: options.map(option => option.candidateId),
    items: [{ findingId, kind: 'repair', title: '算术', summary: '加法错误', targetFiles: ['src/math.js'],
      dependsOn: null, status: 'pending', candidate: null, repairPlan: '修复计算并验证', options }],
  };
  await archive.write(published, '# 审查报告\n');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-qm', 'publish group'], root);
  return { root, findingId, options };
}

test('同一发现的两个备选补丁并发审批只产生一次业务提交', async () => {
  const { root, findingId, options } = await prepareFindingOptions();
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root);
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  const outcomes = await Promise.all(options.map(async ({ candidateId }) => {
    const response = await post(base, '/approve', guardFixture(candidateId, { expectedFindingVersion: finding.findingVersion }));
    if (response.status === 409) return 'ABORTED';
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    const job = await waitJob(base, body.jobId);
    assert.ok(job.result, JSON.stringify(job));
    return job.result.status;
  }));
  assert.deepEqual(outcomes.sort(), ['ABORTED', 'COMMITTED']);
  assert.equal(runCommand('git', ['rev-list', '--count', `${before}..HEAD`], root).stdout.trim(), '1');
  const [applied] = (await (await fetch(`${base}/findings?dispositions=applied`)).json()).findings;
  assert.equal(applied.findingId, findingId);
  assert.equal(applied.options.filter(option => option.status === 'approved').length, 1);
});

test('发现的提交命令异常中断进入待核验，同组另一补丁仍受阻', async () => {
  const { root, options } = await prepareFindingOptions();
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL(base));
  runtime.vcs.atomicCommit = async () => { throw new Error('测试中断提交响应'); };
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  const original = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const approve = async id => {
    const response = await post(base, '/approve', guardFixture(id, { expectedFindingVersion: finding.findingVersion }));
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    return (await waitJob(base, body.jobId)).result;
  };
  const interrupted = await approve(options[0].candidateId);
  assert.equal(interrupted.status, 'RECOVERY_REQUIRED');
  assert.equal(interrupted.reason, 'COMMIT_OUTCOME_UNKNOWN');
  assert.match(interrupted.detail, /测试中断提交响应/);
  const sibling = await approve(options[1].candidateId);
  assert.equal(sibling.status, 'ABORTED');
  assert.match(sibling.message, /仍待核验/);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), original);
});

test('重启后发现的未决审批保留到探针和候选现场均可证明未提交', async () => {
  const root = await createGitFixture();
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'finding-recovery-')), 'runtime-state.json');
  const option = await commitCandidate(root, 'recovery-option');
  const review = `.ai-review/${option.id}/review.md`;
  const patch = `.ai-review/${option.id}/001.patch`;
  const vcs = createVcs('git', root);
  const probe = await vcs.getCommitProbe([review, patch]);
  const state = new FindingApprovalState(root, 'retry-group', statePath);
  await state.begin([review, patch], probe);
  await assert.rejects(state.begin([review, patch], probe), /EEXIST/);
  const file = path.join(root, review);
  const before = await readFile(file, 'utf8');
  await writeFile(file, before + '\n提交结果待核验的工作区内容', 'utf8');
  const restarted = new FindingApprovalState(root, 'retry-group', statePath);
  assert.equal(await restarted.canRetry(vcs), false);
  await writeFile(file, before, 'utf8');
  assert.equal(await restarted.canRetry(vcs), true);
  await restarted.begin([review, patch], probe);
  runCommand('git', ['commit', '--allow-empty', '-qm', 'probe moved'], root);
  assert.equal(await new FindingApprovalState(root, 'retry-group', statePath).canRetry(vcs), false);
  await restarted.clear();
});

test('明确未提交但业务工作区无法恢复时保留发现的待核验标记', async () => {
  const { root, findingId, options } = await prepareFindingOptions();
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL(base));
  runtime.vcs.atomicCommit = async () => ({
    success: false, commitRevision: null, outOfDate: false, errorOutput: '测试拒绝提交',
  });
  runtime.vcs.revertBusinessWorkspace = async () => {};
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  const response = await post(base, '/approve', guardFixture(options[0].candidateId, { expectedFindingVersion: finding.findingVersion }));
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'RECOVERY_REQUIRED', JSON.stringify(job));
  assert.equal(await new FindingApprovalState(root, findingId, api.deps.statePath).pending(), true);
});

test('文字方案可人工接手并提交可选线索，旧发现版本不能覆盖新决定', async () => {
  const root = await createGitFixture();
  const findingId = 'complex-repair';
  const revision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  await new AuditArchive(root).write({
    schemaVersion: 2, auditId: '20261120-100200-src', createdAt: '2026-11-20T10:02:00Z', scope: 'src',
    trigger: 'manual', previousAudit: null, baseRevision: revision, candidates: [],
    items: [{ findingId, kind: 'confirm', title: '复杂修复', summary: '需要人工接手', targetFiles: ['src/math.js'],
      dependsOn: null, status: 'pending', candidate: null, repairPlan: '验证边界后改动 API' }],
  }, '# 审查报告\n');
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-qm', 'publish text plan'], root);
  const { base } = await startApi(root);
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  assert.deepEqual(finding.options, []);
  const action = { findingId, expectedFindingVersion: finding.findingVersion, action: 'human_takeover' };
  const received = await post(base, '/finding/decision', action);
  const body = await received.json();
  assert.equal(received.status, 200, JSON.stringify(body));
  assert.equal(body.finding.disposition, 'human_takeover');
  assert.equal((await post(base, '/finding/decision', action)).status, 409);
  const hint = await post(base, '/finding/decision', {
    findingId, expectedFindingVersion: body.finding.findingVersion, action: 'add_repair_hint', hint: 'PR 42',
  });
  const updated = await hint.json();
  assert.equal(hint.status, 200, JSON.stringify(updated));
  assert.deepEqual(updated.finding.repairHints, ['PR 42']);
  await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  runCommand('git', ['commit', '-qam', 'external repair'], root);
  const started = await post(base, '/audit/manual', { targetPath: 'src' });
  assert.equal(started.status, 202);
  const { auditId, prompt, reportPath } = await started.json();
  assert.match(prompt, /历史复查数据/);
  assert.match(prompt, /complex-repair/);
  await mkdir(path.dirname(path.resolve(root, reportPath)), { recursive: true });
  const evidence = { file: 'src/math.js', line: 1, excerpt: 'a + b', reason: '已有的加法修复与验收一致' };
  await writeFile(path.resolve(root, reportPath), [
    '# 外部审查报告', '## 历史复查数据', '```json',
    JSON.stringify([{ id: findingId, status: 'resolved', evidence }]), '```', '',
  ].join('\n'));
  const finalize = await post(base, '/audit/finalize', { auditId });
  assert.equal(finalize.status, 202);
  const job = await waitJob(base, (await finalize.json()).jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job));
  const [refreshed] = (await (await fetch(`${base}/findings`)).json()).findings;
  assert.equal(refreshed.disposition, 'resolved');
});

test('SVN 拒绝提交后清除发现处置和批准的 SVN 调度，原发现可以重试', async t => {
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
  const findingId = 'svn-repair';
  const candidateId = '2026-11/svn-fix';
  const candidateDir = path.join(root, '.ai-review', candidateId);
  await mkdir(candidateDir, { recursive: true });
  await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\n');
  const baseRevision = svn('info', '--show-item', 'revision');
  const reviewPath = path.join(candidateDir, 'review.md');
  const original = reviewFixture('svn-fix', {
    schemaVersion: 2, extraLines: [`finding_id: ${findingId}`], baseRevision: JSON.stringify(baseRevision),
    bodyLines: ['# 需人工判断项', '', '- 无'],
  });
  await writeFile(reviewPath, original);
  await writeFile(path.join(candidateDir, '001.patch'), patchFixture());
  await new AuditArchive(root).write({
    schemaVersion: 2, auditId: '20261120-100300-src', createdAt: '2026-11-20T10:03:00Z', scope: 'src',
    trigger: 'manual', previousAudit: null, baseRevision, candidates: [candidateId],
    items: [{ findingId, kind: 'repair', title: '算术', summary: '加法错误', targetFiles: ['src/math.js'],
      dependsOn: null, status: 'pending', candidate: null, repairPlan: '修复计算并验证',
      options: [{ candidateId, tradeoff: '更正运算符' }] }],
  }, '# 审查报告\n');
  svn('add', '.ai-review');
  svn('commit', '-qm', 'finding');
  svn('update', '-q');
  const windows = process.platform === 'win32';
  const hook = path.join(repo, 'hooks', windows ? 'pre-commit.cmd' : 'pre-commit');
  await writeFile(hook, windows ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
  if (!windows) await chmod(hook, 0o755);
  const { base } = await startApi(root, { vcsType: 'svn' });
  const [finding] = (await (await fetch(`${base}/findings`)).json()).findings;
  const action = { findingId, expectedFindingVersion: finding.findingVersion, action: 'human_takeover' };
  const decline = await post(base, '/finding/decision', action);
  assert.equal(decline.status, 409);
  assert.equal((await decline.json()).error.details.reason, 'COMMIT_FAILED');
  assert.equal(svn('status'), '');
  const approval = await post(base, '/approve', guardFixture(candidateId, { expectedFindingVersion: finding.findingVersion }));
  assert.equal(approval.status, 202);
  const job = await waitJob(base, (await approval.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job));
  assert.equal(job.result.reason, 'COMMIT_FAILED');
  assert.equal(svn('status'), '');
  assert.equal(await readFile(reviewPath, 'utf8'), original);
  const journal = new ManagedJournal(path.join(directory, 'journal.sqlite'));
  const operations = new ManagedOperations({ dataDir: path.join(directory, 'state'), journal, workspaces: [
    { workspaceId: 'svn', label: 'SVN', root, target: '^/', settings: { runner: 'manual' } },
  ] });
  try {
    await operations.init();
    const project = { projectId: 'project', nodeId: 'node', workspaceId: 'svn', name: 'SVN', bindingGeneration: 1,
      projectConfigRevision: 1, vcsType: 'svn', target: '^/', enabled: true };
    const command = { commandId: 'svn-finding-decision', requestHash: 'b'.repeat(64), projectId: project.projectId,
      nodeId: project.nodeId, bindingGeneration: 1, projectConfigRevision: 1, operation: 'finding-decision',
      payload: action, actor: { userId: 'tester-id', reviewIdentity: 'tester' },
      createdAt: new Date().toISOString() };
    journal.accept(command);
    const result = await operations.execute(command, new AbortController().signal, () => {}, project);
    assert.equal(result.outcome.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.outcome.reason, 'COMMIT_FAILED');
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
  test(`§7.6：独立候选收尾遇到 ${kind} 业务修改时中止且完整保留用户内容`, async () => {
    const root = await createGitFixture();
    const candidate = await standaloneCandidate(root, `20261111-finalize-dirty-${kind}`);
    const userFile = path.join(root, 'src', kind === 'tracked' ? 'math.js' : 'unrelated-user-edit.txt');
    const userText = kind === 'tracked'
      ? 'export const add = (a, b) => a - b;\n// 用户尚未提交的修改\n'
      : '不得删除的用户草稿\n';
    await writeFile(userFile, userText, 'utf8');
    const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const { base } = await startApi(root);

    const response = await post(base, '/candidate/finalize', { id: candidate.id });
    assert.equal(response.status, 202);
    const job = await waitJob(base, (await response.json()).jobId);
    assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
    assert.equal(job.result?.reason, 'DIRTY_WORKSPACE', JSON.stringify(job.result));
    assert.equal(await readFile(userFile, 'utf8'), userText);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  });
}

test('§7.6：独立候选成功收尾不改动无关业务文件', async () => {
  const root = await createGitFixture();
  const unrelated = path.join(root, 'src', 'unrelated-committed.txt');
  await writeFile(unrelated, '用户已有内容\n', 'utf8');
  runCommand('git', ['add', 'src/unrelated-committed.txt'], root);
  runCommand('git', ['commit', '-q', '-m', 'user content'], root);
  const candidate = await standaloneCandidate(root, '20261111-finalize-clean');
  const { base } = await startApi(root);

  const response = await post(base, '/candidate/finalize', { id: candidate.id });
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(await readFile(unrelated, 'utf8'), '用户已有内容\n');
});

test('§7.4：Runner 生成 target_files=[] 的版本 2 时不得提交或返回 COMMITTED', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-ai-fix-invalid-targets', {
    review: {
      comments: [
        '',
        '  - id: c1',
        '    revision: 1',
        '    file: ""',
        '    line: 0',
        '    author: tester',
        '    content: 请修复',
        '    status: unresolved',
      ].join('\n'),
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
  .replace('current_revision: 1', 'current_revision: 2')
  .replace('updated_at: "2026-11-01T10:00:00+08:00"', 'updated_at: "2026-11-01T10:01:00+08:00"')
  .replace('    author: ai\\ngate_checks:', '    author: ai\\n  - id: 2\\n    base_revision: "1"\\n    patch: 002.patch\\n    author: ai\\ngate_checks:');
await writeFile(reviewPath, text, 'utf8');
await copyFile(path.join(dir, '001.patch'), path.join(dir, '002.patch'));
`, 'utf8');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" "${script}"`,
  });

  const response = await post(base, '/ai-fix', guardFixture(candidate.id));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'INVALID_CANDIDATE', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  const sharedReview = runCommand('git', ['show', `HEAD:.ai-review/${candidate.id}/review.md`], root).stdout;
  assert.match(sharedReview, /current_revision: 1/);
  assert.doesNotMatch(sharedReview, /002\.patch/);
});

test('§4.3/§13：必填 Frontmatter 字段缺省、null 或类型错误必须成为格式错误', async () => {
  const requiredLines = [
    'updated_at', 'tags', 'ticket', 'target_files', 'comments',
    'human_decisions', 'approval', 'rejection', 'commit_message',
  ];
  for (const field of requiredLines) {
    const text = reviewFixture('20261111-required-fields')
      .split('\n')
      .filter((line) => !line.startsWith(`${field}:`))
      .join('\n');
    assert.throws(() => parseReviewMarkdown(text), new RegExp(field), `${field} 缺省不得静默补默认值`);
  }
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-null-array', { tags: 'null' })), /tags/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-null-string', { commitMessage: null })), /commit_message/);
  assert.throws(
    () => parseReviewMarkdown(reviewFixture('20261111-revision-author').replace('    author: ai\n', '')),
    /author/,
  );
});

test('§4.3/§13 I7/I8：approved 候选缺少门禁和判断项快照必须 broken', () => {
  const parsed = parseReviewMarkdown(reviewFixture('20261111-approval-snapshot', {
    status: 'approved',
    approval: '{approved_by: tester, approved_at: "2026-11-01T10:10:00+08:00"}',
  }));
  const errors = quickReviewInvariants({
    id: '2026-11/20261111-approval-snapshot',
    month: '2026-11',
    slug: '20261111-approval-snapshot',
    meta: parsed.meta,
  });
  assert.ok(errors.some((error) => error.startsWith('I7:') && error.includes('gate_checks')), errors.join('\n'));
  assert.ok(errors.some((error) => error.startsWith('I7:') && error.includes('gate_results')), errors.join('\n'));
  assert.ok(errors.some((error) => error.startsWith('I8:') && error.includes('confirmed_decisions')), errors.join('\n'));
  assert.ok(errors.some((error) => error.startsWith('I8:') && error.includes('waived_decisions')), errors.join('\n'));
});

test('§4.3 I14：严格校验仍保留未知顶层及批准嵌套键', () => {
  const text = reviewFixture('20261111-unknown-keys', {
    extraLines: ['future_top:', '  nested: {keep: true}'],
  }).replace('approval: null', 'approval: null\nfuture_approval_side: ignored');
  const parsed = parseReviewMarkdown(text);
  const output = serializeReviewMarkdown(parsed.meta, parsed.body);
  assert.match(output, /future_top:\n\s+nested:\n\s+keep: true/);
  assert.match(output, /future_approval_side: ignored/);
});

test('§4.8/I16：A↔B 重开环必须进入 errors，不得投影成 reopened', () => {
  const audit = {
    dirName: '20261111-000000-cycle',
    reviewPath: '',
    meta: {
      auditId: '20261111-000000-cycle',
      createdAt: '2026-11-11T00:00:00Z',
      scope: '.',
      items: [{
        findingId: 'cycle-finding', kind: 'confirm', title: '环', summary: '环',
        targetFiles: ['src/math.js'], dependsOn: null, status: 'converted', candidate: '2026-11/a',
      }],
      candidates: [],
    },
  };
  const infos = {
    '2026-11/a': { status: 'rejected', reopenedFrom: '2026-11/b' },
    '2026-11/b': { status: 'rejected', reopenedFrom: '2026-11/a' },
  };
  const result = projectFindings([audit], (id) => infos[id] ?? null, Object.keys(infos));
  assert.equal(result.findings.length, 0);
  assert.ok(result.errors.some((error) => error.includes('环')), result.errors.join('\n'));
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


test('§7.7：base_revision === currentBase 的 same 分支返回 BASE_UNCHANGED', async () => {
  const root = await createGitFixture();
  const businessBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-rebase-same', {
    review: {
      baseRevision: JSON.stringify(businessBase),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const { api, base } = await startApi(root);
  const runtime = await api.runtimeFor(new URL('http://local/'));
  runtime.vcs.getCurrentBase = async () => businessBase;
  const response = await post(base, '/rebase', guardFixture(candidate.id));
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'BASE_UNCHANGED');
});

async function runModeCScenario(kind) {
  const root = await createGitFixture();
  const oldBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const slug = `20261111-rebase-mode-c-${kind}`;
  const candidate = await commitCandidate(root, slug, {
    review: {
      baseRevision: JSON.stringify(oldBase),
      gateChecks: kind === 'gate' ? JSON.stringify(['node -e "process.exit(1)"']) : '["node --version"]',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  if (kind === 'conflict') {
    await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a * b;\n', 'utf8');
    runCommand('git', ['add', 'src/math.js'], root);
  } else {
    await writeFile(path.join(root, 'src', 'other.js'), 'export const other = true;\n', 'utf8');
    runCommand('git', ['add', 'src/other.js'], root);
  }
  runCommand('git', ['commit', '-q', '-m', `business change ${kind}`], root);
  const newBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const temp = await mkdtemp(path.join(os.tmpdir(), `dcr-mode-c-${kind}-`));
  const script = path.join(temp, 'runner.mjs');
  const promptCapture = path.join(temp, 'prompt.txt');
  await writeFile(script, `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(${JSON.stringify(promptCapture)}, prompt, 'utf8');
const dir = path.join(process.cwd(), '.ai-review', '2026-11', ${JSON.stringify(slug)});
const reviewPath = path.join(dir, 'review.md');
let review = readFileSync(reviewPath, 'utf8');
review = review.replace('current_revision: 1', 'current_revision: 2')
  .replace('updated_at: "2026-11-01T10:00:00+08:00"', 'updated_at: "2026-11-01T10:01:00+08:00"')
  .replace(/gate_checks: .*/, 'gate_checks: ["node --version"]')
  .replace('    author: ai\\ngate_checks:', '    author: ai\\n  - id: 2\\n    base_revision: "${newBase}"\\n    patch: 002.patch\\n    author: ai\\ngate_checks:');
writeFileSync(reviewPath, review, 'utf8');
writeFileSync(path.join(process.cwd(), 'src', 'math.js'), 'export const add = (a, b) => a + b;\\n', 'utf8');
const patch = execFileSync('git', ['diff', '--binary', ${JSON.stringify(newBase)}, '--', 'src/math.js'], { encoding: 'utf8' });
writeFileSync(path.join(dir, '002.patch'), patch, 'utf8');
execFileSync('git', ['checkout', '--', 'src/math.js']);
`, 'utf8');
  const { base } = await startApi(root, {
    runner: 'external',
    externalCommand: `"${process.execPath}" "${script}"`,
  });
  const response = await post(base, '/rebase', guardFixture(candidate.id));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(job.result?.newRevision, 2);
  const prompt = await readFile(promptCapture, 'utf8');
  assert.match(prompt, /RESOLVE_CONFLICT/);
  assert.ok(prompt.includes(newBase), 'Mode C 必须使用最新基线');
  const sharedPatch = runCommand('git', ['show', `HEAD:.ai-review/${candidate.id}/002.patch`], root).stdout;
  assert.ok(sharedPatch.length > 0);
  if (kind === 'conflict') assert.match(sharedPatch, /a \* b/);
  return { root, candidate };
}

test('§7.7：三方应用冲突进入 Mode C，Runner 成功后提交新基线完整补丁', async () => {
  await runModeCScenario('conflict');
});

test('§7.7：Rebase 门禁失败进入 Mode C，而不是直接 ABORTED', async () => {
  await runModeCScenario('gate');
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
  const response = await post(base, '/approve', guardFixture(candidate.id));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const jobId = (await response.json()).jobId;
  let running;
  for (let index = 0; index < 100; index += 1) {
    running = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (running.log.some((line) => line.includes('开始执行门禁'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(running.log.some((line) => line.includes('开始执行门禁')), JSON.stringify(running));
  await post(base, `/jobs/${jobId}/cancel`, {});
  const started = Date.now();
  const job = await waitJob(base, jobId);
  assert.ok(Date.now() - started < 10_000, '取消不得等待原门禁超时');
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(typeof job.result?.reason, 'string');
  assert.ok(job.result.reason.length > 0);
  const clean = runCommand('git', ['status', '--porcelain', '--', 'src'], root).stdout;
  assert.equal(clean.trim(), '');
});


test('§7.6：已确认空闲的会话复用跟踪 Job，在维护窗口内自动收尾', async () => {
    const root = await createGitFixture();
    let ready;
    let request;
    let observing;
    const { api, base } = await startApi(root, {}, {
        createAuditSession: async input => {
            request = input.requestId;
            return { sessionId: 'audit-idle-session' };
        },
        withAuditSessionIdle: async (sessionId, requestId, signal, finalize) => {
            assert.equal(sessionId, 'audit-idle-session');
            assert.equal(requestId, request);
            assert.ok(requestId);
            observing = signal;
            await new Promise(resolve => { ready = resolve; });
            await finalize(signal);
            return true;
        },
    });
    const response = await post(base, '/audit/session', { targetPath: '', note: '' });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    const started = await response.json();
    assert.equal(typeof ready, 'function');
    assert.equal(api.auditRuntime.leaseTimeouts.has(started.auditId), true);
    let unlock;
    let acquired;
    const held = new Promise(resolve => { acquired = resolve; });
    const blocker = api.withWriteLock(root, async () => {
        acquired();
        await new Promise(resolve => { unlock = resolve; });
    });
    await held;
    try {
        ready();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(api.auditRuntime.leaseTimeouts.has(started.auditId), false);
        const duplicate = await post(base, '/audit/finalize', { auditId: started.auditId });
        assert.equal(duplicate.status, 409);
    } finally {
        unlock();
        await blocker;
    }
    const job = await waitJob(base, started.jobId, 240);
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
    assert.deepEqual(job.result.dataValidation, [{ path: started.reportPath, errors: [] }]);
    assert.equal(observing.aborted, true);
    const audits = await (await fetch(`${base}/audits`)).json();
    assert.equal(audits.audits.length, 1);
    assert.equal(audits.audits[0].auditId, started.auditId);
});

test('AC-SCHEDULE-01：并发会话审查在同一 repo 锁内取得租约，只创建一个会话', async () => {
  const root = await createGitFixture();
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
  await assert.rejects(() => api.init(), /租约解析失败|互斥状态不可证明/);
});

test('§8.2：SVN 无法 dry-run 时 patchCheck=unknown，而不是 conflicted', async () => {
  const root = await createGitFixture();
  const svn = new SvnAdapter(root);
  const models = new ReadModels({});
  const runtime = {
    root,
    store: {},
    vcs: {
      getCurrentBase: async () => '7',
      checkPatch: (patchPath) => svn.checkPatch(patchPath),
    },
  };
  const result = await models.computePatchCheck(runtime, '2026-11/svn', 1, '7', 'diff --git a/a b/a\n');
  assert.equal(result.state, 'unknown');
  assert.equal(result.checkedBase, '7');
});

test('§11/AC-PROMPT-01：系统提示词和 Host 展开包含完整 Schema、9 种类型且无内部章节引用', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const prompt = await buildAuditPrompt({
    repoRoot: root,
    vcsType: 'git',
    owner: 'tester',
    targetPath: '',
    note: '',
    baseRevision,
    reportPath: '.ai-review/audits/20261111-000000-repo/audit.md',
    now: new Date('2026-11-11T00:00:00Z'),
  });
  const assets = await Promise.all([
    readFile(new URL('../packages/dsh-plugin/assets/ai-fixer-system.md', import.meta.url), 'utf8'),
    readFile(new URL('../packages/dsh-plugin/assets/repo-audit-system.md', import.meta.url), 'utf8'),
    loadAuditSystemPrompt(),
  ]);
  for (const text of [prompt, ...assets]) {
    for (const field of ['updated_at', 'target_files', 'human_decisions', 'rejection', 'commit_message', 'author: ai']) {
      assert.ok(text.includes(field), `提示词缺少 ${field}`);
    }
    for (const type of ['bugfix', 'delete', 'shrink', 'reuse', 'merge', 'split', 'stdlib', 'native', 'yagni']) {
      assert.ok(text.includes(type), `提示词缺少 audit_type=${type}`);
    }
    assert.doesNotMatch(text, /§\s*\d/);
    assert.doesNotMatch(text, /唯一例外/);
  }
});

test('直接执行的审查提示词按能力只给出一版交付规则，并区分证据不足和无法验证修复', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    repoRoot: root, vcsType: 'git', owner: 'tester', targetPath: '', note: '',
    baseRevision: runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(),
    reportPath: '.ai-review/audits/example/audit.md',
  };
  const system = await loadAuditSystemPrompt();
  for (const enabled of [false, true]) {
    const task = await withTrustedActor({ userId: 'tester', reviewIdentity: 'tester', findingWorkflow: enabled },
      () => buildAuditPrompt(input));
    const rendered = system + '\n' + task;
    assert.deepEqual([...rendered.matchAll(/^schema_version: (\d)$/gm)].map(match => Number(match[1])), [enabled ? 2 : 1]);
    assert.equal(rendered.includes('最多三个'), enabled);
    assert.equal(rendered.includes('一个问题一个候选目录'), !enabled);
    assert.equal(rendered.includes('## 修复方案数据'), enabled);
    assert.equal(/^finding_id: /m.test(rendered), enabled);
    assert.match(rendered, /问题本身证据不足时仅记入覆盖说明/);
    assert.match(rendered, /问题已确认.*无法.*验证.*B 类/);
    assert.doesNotMatch(rendered, /判定不确定时一律降级为 B 类|A 类（直接生成候选，占大多数）/);
  }
});

test('§10/AC-UI-01：Client 包含审查租约、取消、修复会话/导出提示词与 finding 工作流入口', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  for (const endpoint of ['/audit/manual', '/audit/finalize', '/audit/release', '/fix-session', '/fix-prompt', '/convert', '/dismiss-finding']) {
    assert.ok(source.includes(`'${endpoint}'`) || source.includes(`${endpoint}?`), `Client 缺少 ${endpoint}`);
  }
  assert.match(source, /\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/cancel/);
  for (const filter of ['statuses', 'tag', 'dir', 'text', 'createdAfter', 'createdBefore']) {
    assert.ok(source.includes(filter), `Client 缺少服务端筛选 ${filter}`);
  }
  assert.match(source, /query\.set\(key, filter\[key\]\)/);
});

test('§10.2：本地详情页没有上传人工补丁、超时归档和从重开来源恢复按钮', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  for (const label of ['上传人工补丁', '超时归档', '从重开来源恢复']) {
    assert.ok(!source.includes(label), `详情页不应再出现按钮「${label}」`);
  }
  for (const endpoint of ['/manual-revision', '/archive-stale', '/reopen']) {
    assert.ok(!source.includes(`'${endpoint}'`), `Client 不应再调用已移除入口的 ${endpoint}`);
  }
});

test('§7.6/§7.1：rejected 重开来源存在本地修改时必须拒绝', async () => {
  const root = await createGitFixture();
  const rejected = await commitCandidate(root, '20261111-reopen-source', {
    review: {
      status: 'rejected',
      rejection: '{rejected_by: tester, rejected_at: "2026-11-01T11:00:00+08:00", reason: "原方案有风险"}',
    },
  });
  const active = await commitCandidate(root, '20261111-reopen-active');
  await writeFile(rejected.reviewPath, (await readFile(rejected.reviewPath, 'utf8')).replace('status: rejected', 'status: pending'), 'utf8');
  const { base } = await startApi(root);
  const response = await post(base, '/reopen', {
    ...guardFixture(active.id),
    from: rejected.id,
    reason: '重新评估',
  });
  assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
});


test('§7.7：finalize 只读预检期间取消不得提交档案或释放租约', { timeout: 15000 }, async t => {
  const root = await createGitFixture();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
    'default_owner: tester',
    'verify_gate_on_audit_finalize: declared',
    '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'declared finalize gates'], root);
  const checking = Promise.withResolvers();
  const releaseCheck = Promise.withResolvers();
  t.after(() => releaseCheck.resolve());
  const { api, base } = await startApi(root, {}, { decorateVcs(vcs) {
    const check = vcs.checkPatch.bind(vcs);
    vcs.checkPatch = async (...args) => { checking.resolve(); await releaseCheck.promise; return check(...args); };
    vcs.applyPatch = async () => { throw new Error('审查预检不得实际应用补丁'); };
    return vcs;
  } });
  const manual = await post(base, '/audit/manual', { targetPath: '', note: '' });
  const { auditId } = await manual.json();
  await commitCandidate(root, '20261111-finalize-cancel', {
    review: {
      baseRevision: JSON.stringify(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim()),
      gateChecks: JSON.stringify(['node -e "setTimeout(function(){},60000)"']),
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
  assert.equal(runCommand('git', ['status', '--porcelain', '--', 'src'], root).stdout.trim(), '');
  assert.equal(api.auditLifecycle.find(auditId)?.state, 'releasable');
});

test('§7.4/§4.6：Runner 改写历史补丁正文时不得提交新版本', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-ai-fix-history-rewrite', {
    review: {
      comments: [
        '', '  - id: c1', '    revision: 1', '    file: ""', '    line: 0',
        '    author: tester', '    content: 请修复', '    status: unresolved',
      ].join('\n'),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dcr-history-runner-'));
  const script = path.join(temp, 'runner.mjs');
  await writeFile(script, `
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(process.cwd(), '.ai-review', '2026-11', '20261111-ai-fix-history-rewrite');
const reviewPath = path.join(dir, 'review.md');
let text = await readFile(reviewPath, 'utf8');
text = text.replace('current_revision: 1', 'current_revision: 2')
  .replace('updated_at: "2026-11-01T10:00:00+08:00"', 'updated_at: "2026-11-01T10:01:00+08:00"')
  .replace('    author: ai\\ngate_checks:', '    author: ai\\n  - id: 2\\n    base_revision: "1"\\n    patch: 002.patch\\n    author: ai\\ngate_checks:');
await writeFile(reviewPath, text, 'utf8');
await copyFile(path.join(dir, '001.patch'), path.join(dir, '002.patch'));
await writeFile(path.join(dir, '001.patch'), 'HISTORY REWRITTEN\\n', 'utf8');
`, 'utf8');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root, {
    runner: 'external', externalCommand: `"${process.execPath}" "${script}"`,
  });
  const response = await post(base, '/ai-fix', guardFixture(candidate.id));
  assert.equal(response.status, 202);
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'INVALID_CANDIDATE');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.equal(runCommand('git', ['show', `HEAD:.ai-review/${candidate.id}/001.patch`], root).stdout.includes('HISTORY REWRITTEN'), false);
});

test('§10：审查跟踪 Job 运行中仍可点击 finalize，不被 busy 死锁', async () => {
  const source = await readFile(new URL('../packages/dsh-plugin/dist/client.js', import.meta.url), 'utf8');
  const finalize = source.match(/h\('button', \{ className: 'dcr-btn', disabled: ([^,]+), onClick: \(\) => \{ void startJob\('\/audit\/finalize'/);
  assert.ok(finalize, '找不到 finalize 按钮');
  assert.equal(finalize[1], 'auditLaunching');
});


test('§7.5：门禁期间候选本地 review.md 被修改时必须中止批准并保留现场', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-approve-local-race', {
    review: {
      baseRevision: JSON.stringify(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim()),
      gateChecks: JSON.stringify(['node -e "setTimeout(function(){},1200)"']),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { base } = await startApi(root);
  const response = await post(base, '/approve', guardFixture(candidate.id));
  assert.equal(response.status, 202);
  const jobId = (await response.json()).jobId;
  let running;
  for (let index = 0; index < 100; index += 1) {
    running = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (running.log.some((line) => line.includes('开始执行门禁'))) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const localText = `${await readFile(candidate.reviewPath, 'utf8')}\n<!-- local-only-race -->\n`;
  await writeFile(candidate.reviewPath, localText, 'utf8');
  const job = await waitJob(base, jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result?.reason, 'CONCURRENCY_MISMATCH', JSON.stringify(job.result));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.equal(await readFile(candidate.reviewPath, 'utf8'), localText);
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

test('§4.8/I16：broken 的重开替代候选必须进入 errors，不得视为无替代', () => {
  const audit = {
    dirName: '20261111-000000-broken-reopen', reviewPath: '',
    meta: {
      auditId: '20261111-000000-broken-reopen', createdAt: '2026-11-11T00:00:00Z', scope: '.',
      items: [{
        findingId: 'broken-reopen', kind: 'confirm', title: 'broken', summary: 'broken',
        targetFiles: ['src/math.js'], dependsOn: null, status: 'converted', candidate: '2026-11/a',
      }],
      candidates: [],
    },
  };
  const infos = {
    '2026-11/a': { status: 'rejected', reopenedFrom: null },
    '2026-11/b': { status: 'pending', reopenedFrom: '2026-11/a', broken: true },
  };
  const result = projectFindings([audit], (id) => infos[id] ?? null, Object.keys(infos));
  assert.equal(result.findings.length, 0);
  assert.ok(result.errors.some((error) => error.includes('broken')), result.errors.join('\n'));
});

test('§4.3：数值字段不得用字符串或 null 冒充', () => {
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-number-type', { currentRevision: '"1"' })), /current_revision/);
  assert.throws(() => parseReviewMarkdown(reviewFixture('20261111-schema-type', { schemaVersion: '"1"' })), /schema_version/);
});


test('§5.6：finalize 提交报错后完整内容不符必须 RECOVERY_REQUIRED', async () => {
  const root = await createGitFixture();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'reviewers'], root);
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-finalize-tampered-commit', {
    review: {
      baseRevision: JSON.stringify(baseRevision),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
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
    return { success: false, commitRevision: null, outOfDate: false, errorOutput: 'simulated post-commit failure' };
  };
  const auditor = new Auditor({
    store,
    vcs,
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    owner: 'tester',
    targetPath: '',
    note: '',
    log: () => undefined,
    candidateSource: await GitHeadCandidateSource.create(root),
  });
  const result = await auditor.finalize({
    auditId: '20261111-000000-tampered', beforeIds: new Set(), baseRevision,
    targetPath: '', trigger: 'manual', runError: null, startedAt: Date.now(), now: new Date(),
  });
  assert.equal(result.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
  assert.equal(result.reason, 'COMMIT_OUTCOME_UNKNOWN');
});

test('§4.3/§5.2/I14/I16：提交前校验拒绝伪造重开、改创建时间、重排历史和删除嵌套未知键', async () => {
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
  const latest = structuredClone(previous);
  latest.meta.createdAt = '2020-01-01T00:00:00Z';
  latest.meta.updatedAt = '2026-11-01T10:01:00+08:00';
  latest.meta.currentRevision = 2;
  latest.meta.reopenedFrom = '2026-11/nonexistent-rejected';
  latest.meta.reopenedReason = '伪造豁免';
  latest.meta.humanDecisions[0].extra = {};
  latest.meta.revisions = [
    { id: 2, baseRevision: '1', patch: '002.patch', author: 'ai' },
    latest.meta.revisions[0],
  ];
  await writeFile(path.join(candidate.dir, '002.patch'), await readFile(path.join(candidate.dir, '001.patch'), 'utf8'), 'utf8');
  const writers = new Writers({}, {});
  const errors = await writers.validateNewRevision(
    { root, store, vcs: createVcs('git', root), vcsType: 'git' },
    previous,
    latest,
    'ai',
  );
  assert.ok(errors.some((error) => error.includes('created_at')), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('顺序')), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('reopened_from')), errors.join('\n'));
  assert.ok(errors.some((error) => error.includes('human_decisions')), errors.join('\n'));
});

test('§7.1/§7.6：手动 finalize 不得用未提交的 reviewers.yml 让候选进入共享历史', async () => {
  const root = await createGitFixture();
  const { base } = await startApi(root);
  const manual = await post(base, '/audit/manual', { targetPath: '', note: '' });
  const { auditId } = await manual.json();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  const candidate = await commitCandidate(root, '20261111-manual-local-reviewers', {
    review: {
      baseRevision: JSON.stringify(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim()),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
    commit: false,
  });
  const response = await post(base, '/audit/finalize', { auditId });
  const job = await waitJob(base, (await response.json()).jobId);
  assert.equal(job.result?.status, 'VALIDATION_FAILED', JSON.stringify(job.result));
  assert.throws(() => runCommand('git', ['cat-file', '-e', `HEAD:.ai-review/${candidate.id}/review.md`], root));
  assert.throws(() => runCommand('git', ['cat-file', '-e', 'HEAD:.ai-review/reviewers.yml'], root));
});

test('§4.8/I16：已有 broken 直接替代时第二次 /reopen 必须 409', async () => {
  const root = await createGitFixture();
  const rejected = await commitCandidate(root, '20261111-reopen-origin', {
    review: {
      status: 'rejected',
      rejection: '{rejected_by: tester, rejected_at: "2026-11-01T11:00:00+08:00", reason: "风险"}',
    },
  });
  await commitCandidate(root, '20261111-reopen-broken', {
    review: {
      currentRevision: 9,
      extraLines: [`reopened_from: ${rejected.id}`, 'reopen_reason: "第一次替代"'],
    },
  });
  const active = await commitCandidate(root, '20261111-reopen-second');
  const { base } = await startApi(root);
  const response = await post(base, '/reopen', {
    ...guardFixture(active.id), from: rejected.id, reason: '第二次替代',
  });
  assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
});
