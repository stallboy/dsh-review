import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/**
 * G10（§7.1）共享事实读取 + G8（§12.2）操作隔离：
 * 队列/详情只读 HEAD 同一快照；本地草稿只作 local 诊断、不计共享 KPI；非 Owner 共享写 403。
 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, owner = 'tester') {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner, vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

function candidateFm(slug, updatedAt = '2026-11-01T10:00:00+08:00') {
  return [
    '---', 'schema_version: 1', `title: "net: ${slug}"`, 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-01T10:00:00+08:00"', `updated_at: "${updatedAt}"`, 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: x"', '---', '', '# 问题与影响', '',
  ].join('\n');
}

async function writeCandidate(root, slug) {
  const dir = path.join(root, '.ai-review', '2026-11', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), candidateFm(slug), 'utf8');
  await writeFile(path.join(dir, '001.patch'), 'diff --git a/src/math.js b/src/math.js\n', 'utf8');
}

function commitAll(root, message) {
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', message], root);
}

test('G10：未提交的本地草稿只作 local 诊断，不进入共享流程、不计共享 KPI（AC-READ-01）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-shared-a');
  commitAll(root, 'fixture');
  const { base } = await startApi(root);

  // 本地草稿：未提交的第二个候选。
  await writeCandidate(root, '20261109-local-draft');
  const queue = await (await fetch(`${base}/queue`)).json();
  const shared = queue.items.find((item) => item.id.endsWith('shared-a'));
  const draft = queue.items.find((item) => item.id.endsWith('local-draft'));
  assert.equal(shared?.local, undefined, '已提交候选是共享事实');
  assert.equal(draft?.local, true, '未提交草稿只作 local 诊断');
  assert.equal(queue.counts.pending, 1, 'local 不计入共享 KPI');
});

test('G10：详情读取 HEAD 同一快照——工作区手改不进入共享事实；改动候选标记 local', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-shared-b');
  commitAll(root, 'fixture');
  const { base } = await startApi(root);

  // 未提交地修改已提交候选的 review.md（本地视图）。
  const reviewPath = path.join(root, '.ai-review', '2026-11', '20261109-shared-b', 'review.md');
  const original = await readFile(reviewPath, 'utf8');
  await writeFile(reviewPath, original.replace('net: 20261109-shared-b', '本地篡改标题'), 'utf8');

  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('shared-b'));
  assert.equal(item?.local, true, '存在本地改动的候选标记 local');
  assert.equal(queue.counts.pending, 0, 'local 候选不计共享 KPI');

  const detail = await (await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261109-shared-b')}`)).json();
  assert.equal(detail.candidate.meta.title, 'net: 20261109-shared-b', '详情使用 HEAD 内容，不从工作区拼凑');

  // 还原工作区后恢复共享。
  await writeFile(reviewPath, original, 'utf8');
  const queue2 = await (await fetch(`${base}/queue`)).json();
  assert.equal(queue2.items.find((entry) => entry.id.endsWith('shared-b'))?.local, undefined);
  assert.equal(queue2.counts.pending, 1);
});

test('G8：非 Owner 的候选共享写返回 403；takeover 是唯一例外（AC-SECURITY-01 部分）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261109-owned');
  commitAll(root, 'fixture');
  // 操作者是 other，候选 owner 是 tester。
  const { base } = await startApi(root, 'other');
  const guard = {
    id: '2026-11/20261109-owned',
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
  };
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const comment = await post('/comments', { ...guard, content: '越权评论' });
  assert.equal(comment.status, 403);
  assert.equal((await comment.json()).error.code, 'forbidden');
  const reject = await post('/reject', { ...guard, reason: '越权拒绝' });
  assert.equal(reject.status, 403);
  const approve = await post('/approve', { ...guard });
  assert.equal(approve.status, 403);

  // takeover 唯一允许：接管后 owner 变为 other，写操作放行。
  const takeover = await post('/takeover', { ...guard, owner: 'other' });
  assert.equal(takeover.status, 200);
  const commentAfter = await post('/comments', {
    id: '2026-11/20261109-owned',
    expectedRevision: 1,
    expectedOwner: 'other',
    expectedUpdatedAt: (await takeover.json()).candidate.meta.updatedAt,
    content: '接管后的评论',
  });
  assert.equal(commentAfter.status, 200);
});

test('G10：整个 .ai-review 未跟踪（首次审查）时本地候选仍可见——status 目录折叠不得吞掉 local 诊断', async () => {
  // 2026-11-12 writer-in-dsh 冒烟测试事故回归：首审仓库没有任何已提交的 .ai-review 内容，
  // `git status --porcelain -- .ai-review` 只输出一行 `?? .ai-review/`（折叠到最高未跟踪祖先），
  // 旧的按 月份/候选 层级解析的实现匹配不到任何条目 → 11 个本地候选在队列里完全不可见。
  const root = await createGitFixture();
  await writeCandidate(root, '20261112-first-audit');
  const { base } = await startApi(root);

  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('first-audit'));
  assert.equal(item?.local, true, '整目录未跟踪的候选必须以 local 诊断出现在队列');
  assert.equal(item?.localOnly, true, 'local-only 标记必须区分“目录整体未进入共享快照”');
  assert.equal(queue.counts.pending, 0, 'local 不计入共享 KPI');

  // §8.2：详情只读共享事实——共享快照可建立时，local-only 的 id 请求详情必须 404。
  const detail = await fetch(`${base}/candidate?id=${encodeURIComponent('2026-11/20261112-first-audit')}`);
  assert.equal(detail.status, 404, 'local-only 候选不存在于共享快照，详情应 404');

  // .gitignore 忽略 .ai-review 时同样不得吞掉本地诊断（status 输出为空，文件系统枚举不受影响）。
  await writeFile(path.join(root, '.gitignore'), '.ai-review/\n', 'utf8');
  const ignored = await (await fetch(`${base}/queue`)).json();
  assert.equal(ignored.items.find((entry) => entry.id.endsWith('first-audit'))?.localOnly, true,
    '.ai-review 被 gitignore 时本地候选诊断仍可见');

  // 提交后恢复共享事实，local/localOnly 消失（先移除 ignore，否则 git add 被拒）。
  await rm(path.join(root, '.gitignore'), { force: true });
  commitAll(root, 'commit candidates');
  const shared = await (await fetch(`${base}/queue`)).json();
  const sharedItem = shared.items.find((entry) => entry.id.endsWith('first-audit'));
  assert.equal(sharedItem?.local, undefined, '提交后是共享事实');
  assert.equal(sharedItem?.localOnly, undefined);
  assert.equal(shared.counts.pending, 1);
});
