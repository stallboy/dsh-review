import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../dist/frontmatter.js';
import { quickReviewInvariants } from '../dist/invariants.js';
import { projectFindings } from '../dist/audit-archive.js';
import { AuditLifecycle } from '../dist/audit-lifecycle.js';
import { ReadModels } from '../dist/api-readmodels.js';
import { SvnAdapter, createVcs } from '../dist/vcs.js';
import { Auditor, buildAuditPrompt, loadAuditSystemPrompt } from '../dist/auditor.js';
import { Writers } from '../dist/api-writers.js';
import { ReviewStore } from '../dist/store.js';
import { GitHeadCandidateSource } from '../dist/shared-facts.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture, reviewFixture } from './fixtures/contract.mjs';

const servers = [];
const apis = [];
after(async () => {
  for (const api of apis) api.stopScheduler();
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
  apis.push(api);
  return { api, base: `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}` };
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitJob(base, jobId, attempts = 160) {
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


test('§7.6：真实 turn 结束通知驱动 audit Job 自动 Host finalize 并释放租约', async () => {
  const root = await createGitFixture();
  let turnEnded;
  const { base } = await startApi(root, {}, {
    createAuditSession: async () => ({ sessionId: 'audit-turn-session' }),
    onAuditTurnEnd: (sessionId, callback) => {
      assert.equal(sessionId, 'audit-turn-session');
      turnEnded = callback;
      return () => undefined;
    },
  });
  const response = await post(base, '/audit/session', { targetPath: '', note: '' });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const started = await response.json();
  assert.equal(typeof turnEnded, 'function');
  turnEnded();
  const job = await waitJob(base, started.jobId, 240);
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  const audits = await (await fetch(`${base}/audits`)).json();
  assert.equal(audits.audits.length, 1);
  assert.equal(audits.audits[0].auditId, started.auditId);
});

test('§7.7：并发定时审查在同一 repo 锁内完成互斥、auditId 与租约，只创建一个会话', async () => {
  const root = await createGitFixture();
  const calls = [];
  const { api } = await startApi(root, {}, {
    createAuditSession: async (input) => {
      calls.push(input);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { sessionId: `scheduled-${calls.length}` };
    },
  });
  const results = await Promise.allSettled([
    api.runScheduledAuditOnce(),
    api.runScheduledAuditOnce(),
  ]);
  assert.equal(calls.length, 1, JSON.stringify(results));
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
    readFile(new URL('../assets/ai-fixer-system.md', import.meta.url), 'utf8'),
    readFile(new URL('../assets/repo-audit-system.md', import.meta.url), 'utf8'),
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

test('§10/AC-UI-01：Client 包含审查租约、取消、人工修订与 finding 工作流入口', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  for (const endpoint of ['/audit/manual', '/audit/finalize', '/audit/release', '/manual-revision', '/archive-stale', '/reopen', '/convert', '/dismiss-finding']) {
    assert.ok(source.includes(`'${endpoint}'`), `Client 缺少 ${endpoint}`);
  }
  assert.match(source, /\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/cancel/);
  for (const filter of ['statuses', 'tag', 'dir', 'text', 'createdAfter', 'createdBefore']) {
    assert.ok(source.includes(filter), `Client 缺少服务端筛选 ${filter}`);
  }
  assert.match(source, /query\.set\(key, filter\[key\]\)/);
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


test('§7.7：finalize 门禁取消不得提交档案或释放租约', async () => {
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
  const { api, base } = await startApi(root);
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
  let running;
  for (let index = 0; index < 120; index += 1) {
    running = await (await fetch(`${base}/jobs/${jobId}`)).json();
    if (running.log.some((line) => line.includes('收尾门禁复算'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(running.log.some((line) => line.includes('收尾门禁复算')), JSON.stringify(running));
  await post(base, `/jobs/${jobId}/cancel`, {});
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
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
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
