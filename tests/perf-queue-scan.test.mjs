import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/**
 * 队列扫描性能优化的契约回归（§4.8 缓存模式 / §7.1 本地视图实时性）：
 * - 共享扫描结果按 HEAD 快照缓存：HEAD 前进必须立即可见新内容（不跨快照复用）；
 * - local/localOnly 属本地视图层，不参与缓存：工作区改动必须在下一次 /queue 立即反映；
 * - 批量本地改动检测（一次 git status）与逐候选检测语义等价，含已跟踪目录内新文件（-uall）。
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

test('§4.8：扫描缓存不跨快照复用——HEAD 前进后新共享内容立即可见', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261113-cache-a');
  commitAll(root, 'fixture');
  const { base } = await startApi(root);

  const before = await (await fetch(`${base}/queue`)).json();
  assert.equal(before.items.length, 1, '首扫见 1 个共享候选');

  // 同一 HEAD 的第二次请求（命中缓存）内容必须一致。
  const repeat = await (await fetch(`${base}/queue`)).json();
  assert.deepEqual(repeat.items.map((item) => item.id), before.items.map((item) => item.id));

  // HEAD 前进：修改标题并提交 + 新增候选并提交，下一次队列必须立即反映。
  const reviewPath = path.join(root, '.ai-review', '2026-11', '20261113-cache-a', 'review.md');
  const original = await readFile(reviewPath, 'utf8');
  await writeFile(reviewPath, original.replace('net: 20261113-cache-a', 'net: 缓存后新标题'), 'utf8');
  await writeCandidate(root, '20261113-cache-b');
  commitAll(root, 'advance head');
  const afterCommit = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterCommit.items.length, 2, '新提交的候选必须立即可见');
  assert.equal(
    afterCommit.items.find((item) => item.id.endsWith('cache-a'))?.title,
    'net: 缓存后新标题',
    'HEAD 变化后不得返回旧快照内容',
  );
});

test('§7.1：本地视图层不缓存——工作区改动在下一请求立即标记 local（含 -uall 新文件）', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261113-local-a');
  await writeCandidate(root, '20261113-local-b');
  commitAll(root, 'fixture');
  const { base } = await startApi(root);

  // 暖缓存（同一 HEAD）。
  const warm = await (await fetch(`${base}/queue`)).json();
  assert.equal(warm.items.every((item) => item.local === undefined), true, '干净工作区无 local 标记');

  // 已跟踪候选目录内新建未跟踪**子目录**并放文件：默认 -unormal 会把该子目录折叠成一条目录记录
  // （`?? .../sub/`），按文件路径层级解析可能漏判；必须用 -uall 逐文件列出才算覆盖。
  await mkdir(path.join(root, '.ai-review', '2026-11', '20261113-local-a', 'sub'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', '2026-11', '20261113-local-a', 'sub', 'notes.md'), 'draft', 'utf8');
  const withNewFile = await (await fetch(`${base}/queue`)).json();
  assert.equal(withNewFile.items.find((item) => item.id.endsWith('local-a'))?.local, true,
    '已跟踪候选目录内的未跟踪子目录（-uall 语义）必须使候选标记 local');
  assert.equal(withNewFile.items.find((item) => item.id.endsWith('local-b'))?.local, undefined,
    '未改动候选不得误标 local');

  // 修改另一候选的已跟踪文件：批量检测与逐候选检测语义等价。
  const reviewPath = path.join(root, '.ai-review', '2026-11', '20261113-local-b', 'review.md');
  const original = await readFile(reviewPath, 'utf8');
  await writeFile(reviewPath, `${original}\n本地改动\n`, 'utf8');
  const withEdit = await (await fetch(`${base}/queue`)).json();
  assert.equal(withEdit.items.find((item) => item.id.endsWith('local-b'))?.local, true,
    '已跟踪文件的本地修改必须使候选标记 local');
});

test('§4.8：错误条目不随快照键固化——broken 候选在缓存命中路径仍稳定出现', async () => {
  const root = await createGitFixture();
  // 确定性 broken 候选：review.md 声明 001.patch 但补丁文件不存在 → 扫描错误路径。
  const dir = path.join(root, '.ai-review', '2026-11', '20261113-broken-a');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), candidateFm('20261113-broken-a'), 'utf8');
  commitAll(root, 'fixture broken');
  const { base } = await startApi(root);

  // 显式空 owner 查全部（缺省 owner 过滤会按设计排除 owner 为空的错误摘要）。
  const first = await (await fetch(`${base}/queue?owner=`)).json();
  const firstItem = first.items.find((item) => item.id.endsWith('broken-a'));
  assert.ok(firstItem?.parseError, '首扫：补丁缺失的候选必须带 parseError');
  assert.ok(first.errors.some((error) => error.includes('broken-a')), '首扫：错误必须汇总');

  // 第二次请求（缓存命中路径）：错误条目不进缓存、逐请求重扫，结果必须与首扫一致，
  // 且不得因缓存缺失键而静默丢条目。
  const second = await (await fetch(`${base}/queue?owner=`)).json();
  const secondItem = second.items.find((item) => item.id.endsWith('broken-a'));
  assert.ok(secondItem?.parseError, '缓存命中：broken 候选必须仍带 parseError 出现');
  assert.ok(second.errors.some((error) => error.includes('broken-a')), '缓存命中：错误必须仍汇总');
});

test('§7.1：缓存存在时 local-only 候选（未提交目录）仍实时出现与消失', async () => {
  const root = await createGitFixture();
  await writeCandidate(root, '20261113-localonly-base');
  commitAll(root, 'fixture');
  const { base } = await startApi(root);

  await (await fetch(`${base}/queue`)).json(); // 暖缓存

  // 审查进行中的典型场景：工作区新增未提交候选目录。
  await writeCandidate(root, '20261113-localonly-new');
  const withDraft = await (await fetch(`${base}/queue`)).json();
  const draft = withDraft.items.find((item) => item.id.endsWith('localonly-new'));
  assert.equal(draft?.local, true, '未提交候选必须实时出现为 local');
  assert.equal(draft?.localOnly, true, '未提交候选必须带 localOnly');
  assert.equal(withDraft.counts.pending, 1, 'local-only 不计共享 KPI');

  // 删除后实时消失（本地视图层不缓存）。
  await rm(path.join(root, '.ai-review', '2026-11', '20261113-localonly-new'), { recursive: true, force: true });
  const afterRemove = await (await fetch(`${base}/queue`)).json();
  assert.equal(afterRemove.items.some((item) => item.id.endsWith('localonly-new')), false,
    '删除本地候选目录后必须实时从队列消失');
});
