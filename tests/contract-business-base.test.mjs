import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createVcs } from '../dist/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture } from './fixtures/contract.mjs';

/**
 * §7.7「有效业务基线」与 ai_fix Outcome 边界的回归测试。
 *
 * 时序本质：候选元数据存放在 `.ai-review/` 并随仓库提交，任何评论/状态变更/收尾
 * 提交都会推进 HEAD。因此“基线未变”必须比较**业务代码**，而不是顶层版本号。
 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, settingsPatch = {}) {
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'dcr-state-')), 'runtime-state.json');
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual',
    syncBeforeApprove: false, ...settingsPatch,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function waitJob(base, jobId, attempts = 120) {
  let job;
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status !== 'running') return job;
  }
  return job;
}

/** 只触碰 .ai-review/ 的提交（模拟评论/状态变更/收尾），会推进 HEAD 但不改业务代码。 */
function commitReviewMetaOnly(root, message) {
  runCommand('git', ['add', '-A', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '--allow-empty', '-m', message], root);
}

test('§7.7：VcsAdapter.businessChangesBetween 排除 .ai-review/，只报告业务路径（Git）', async () => {
  const root = await createGitFixture();
  const from = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  // 只改 .ai-review/ 的提交
  await commitCandidate(root, '20261111-meta-only');
  const metaOnlyHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  // 再改一个业务文件
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'business change'], root);
  const businessHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const vcs = createVcs('git', root);
  assert.deepEqual(await vcs.businessChangesBetween(from, metaOnlyHead), [], '只有 .ai-review 变更时必须返回空');
  assert.deepEqual(await vcs.businessChangesBetween(from, businessHead), ['src/math.js']);
  assert.deepEqual(await vcs.businessChangesBetween(from, from), []);
  // 非法版本 → null（调用方必须按“无法证明”处理）。
  assert.equal(await vcs.businessChangesBetween('not-a-rev', businessHead), null);
});

test('§7.7：评论推进 HEAD 后 /candidate 的 isBaseBehind 仍为 false（业务基线未变）', async () => {
  const root = await createGitFixture();
  const realBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-comment-head', {
    review: { baseRevision: JSON.stringify(realBase) },
  });
  const { base } = await startApi(root);

  const before = await (await fetch(`${base}/candidate?id=${encodeURIComponent(candidate.id)}`)).json();
  // 添加评论会推进 HEAD（写入 .ai-review/ 并提交）。
  const res = await post(base, '/comments', { ...guardFixture(candidate.id), content: '推进 HEAD 的评论' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const headBefore = before.currentBase;
  const headAfter = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.notEqual(headAfter, headBefore, '前置条件：评论必须推进 HEAD');

  const after = await (await fetch(`${base}/candidate?id=${encodeURIComponent(candidate.id)}`)).json();
  assert.equal(after.currentBase, headAfter);
  assert.equal(after.isBaseBehind, false, '业务代码未变时不得显示基线落后');
});

test('§7.7：/rebase 在业务基线未变（仅 .ai-review 提交）时返回 ABORTED / BASE_UNCHANGED', async () => {
  const root = await createGitFixture();
  const realBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-rebase-base-unchanged', {
    review: { baseRevision: JSON.stringify(realBase) },
  });
  // 只推进 .ai-review/：HEAD 前进但业务代码零变化 → 正是“业务基线未变”分支。
  commitReviewMetaOnly(root, 'review meta only');
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.notEqual(head, realBase, '前置条件：HEAD 已前进但业务代码未变');

  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id) });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'ABORTED', JSON.stringify(job.result));
  assert.equal(job.result.reason, 'BASE_UNCHANGED', JSON.stringify(job.result));
  // 不得产生新版本。
  const files = runCommand('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', `.ai-review/${candidate.id}`], root).stdout;
  assert.doesNotMatch(files, /002\.patch/);
});

test('§7.7：业务代码确有变化时 /rebase 正常产生新版本（不是 BASE_UNCHANGED）', async () => {
  const root = await createGitFixture();
  const realBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261111-rebase-business-changed', {
    review: { baseRevision: JSON.stringify(realBase) },
  });
  await writeFile(path.join(root, 'src', 'other.js'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', 'src'], root);
  runCommand('git', ['commit', '-q', '-m', 'business moves'], root);

  const { base } = await startApi(root);
  const res = await post(base, '/rebase', { ...guardFixture(candidate.id) });
  assert.equal(res.status, 202);
  const job = await waitJob(base, (await res.json()).jobId);
  assert.equal(job.result?.status, 'COMMITTED', JSON.stringify(job.result));
  assert.equal(job.result.newRevision, 2);
});

test('§7.7/§7.5：ai_fix 的 ABORTED reason 与审批原因表相互独立（类型边界）', async () => {
  // §7.5 的 ApprovalAbortReason 不得包含 REBASE_CONFLICT / BASE_UNCHANGED。
  const types = await readFile(new URL('../src/host/types.ts', import.meta.url), 'utf8');
  const approvalBlock = /export type ApprovalAbortReason =([\s\S]*?);/.exec(types)?.[1] ?? '';
  assert.ok(approvalBlock.length > 0, '必须能定位 ApprovalAbortReason');
  assert.doesNotMatch(approvalBlock, /REBASE_CONFLICT/, '§7.5 审批原因表不得包含 REBASE_CONFLICT');
  assert.doesNotMatch(approvalBlock, /BASE_UNCHANGED/, '§7.5 审批原因表不得包含 BASE_UNCHANGED');
  // ai_fix 侧必须定义了这些原因。
  const aiFixBlock = /export type AiFixAbortReason =([\s\S]*?);/.exec(types)?.[1] ?? '';
  assert.match(aiFixBlock, /REBASE_CONFLICT/);
  assert.match(aiFixBlock, /BASE_UNCHANGED/);
  assert.match(aiFixBlock, /GATE_CHECK_FAILED/);
  assert.match(aiFixBlock, /DIRTY_WORKSPACE/);
});
