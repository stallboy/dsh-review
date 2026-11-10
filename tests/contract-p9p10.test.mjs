import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';

/** P9/P10 验收：路由注入提示词、定时审查调度、检出级写互斥、回填恢复提示。 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, extraDeps = {}, settingsPatch = {}) {
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false,
    ...settingsPatch,
  };
  const api = new ReviewApi({
    settings,
    saveSettings: async (next) => next,
    // 租约状态文件放仓库外（生产为 DSH_HOME），避免测试污染真实 DSH_HOME 或被 git clean 删除。
    statePath: path.join(await mkdtemp(path.join(tmpdir(), 'dcr-p9-state-')), 'runtime-state.json'),
    ...extraDeps,
  });
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

test('P9: 审查提示词包含 reviewers.yml 路由解析结果', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), [
    'default_owner: zhangsan',
    'rules:',
    '  - owner: lisi',
    '    paths:',
    '      - src/**',
    '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const response = await (await fetch(`${base}/audit/prompt?mode=session`)).json();
  assert.match(response.prompt, /Owner 路由/);
  assert.match(response.prompt, /default_owner: zhangsan/);
  assert.match(response.prompt, /owner lisi/);
  assert.match(response.prompt, /路径命中数 > tag 命中数/);
});

test('P9: 定时审查——间隔到期自动创建审查会话且提示词含 scheduled 与路由', async () => {
  const root = await createGitFixture();
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const created = [];
  const { api } = await startApi(root, {
    createAuditSession: async (request) => {
      created.push(request);
      return { sessionId: 'sched-1' };
    },
  }, { scheduleIntervalMinutes: 0.001 }); // 60ms
  // 首轮提示词构建含仓库扫描，需要较长等待窗口。
  for (let i = 0; i < 40 && created.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  api.stopScheduler();
  assert.ok(created.length >= 1, '定时审查未触发');
  assert.equal(created[0].title, '定时仓库审查');
  assert.match(created[0].prompt, /trigger: scheduled/);
  assert.match(created[0].prompt, /Owner 路由/);
});

test('P10: 检出级写互斥——并发超时归档串行化，恰好一个成功（只写一次）', async () => {
  const root = await createGitFixture();
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-stale');
  await mkdir(dir, { recursive: true });
  const staleIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', 'title: "net: stale"', 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-01T09:00:00+08:00"',
    'updated_at: "2026-11-01T09:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: pending', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: []', 'comments: []', 'human_decisions: []', 'approval: null', 'rejection: null',
    'commit_message: "net: x"', '---', '', '# 问题与影响', '',
  ].join('\n').replaceAll('"2026-11-01T09:00:00+08:00"', `"${staleIso}"`), 'utf8');
  await writeFile(path.join(dir, '001.patch'), 'diff --git a/src/math.js b/src/math.js\n', 'utf8');
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nstale_days: 14\n', 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);

  // 四个并发归档请求：互斥串行化后，第一个成功写 rejected，其余命中终态校验被拒——只写一次。
  const results = await Promise.all([1, 2, 3, 4].map(() =>
    fetch(`${base}/archive-stale`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '2026-11/20261105-net-stale', expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: staleIso }),
    })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((code) => code === 200).length, 1, statuses.join(','));
  assert.equal(statuses.filter((code) => code === 409).length, 3, statuses.join(','));

  // 终态正确且只产生一次 rejected 提交路径变更；锁已释放，后续读正常。
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('net-stale'));
  assert.equal(item?.status, 'rejected');
});

test('P10: approved 无可派生提交 → lookup unknown 仅诊断；遗留 commit_revision 不再触发 needsBackfill', async () => {
  const root = await createGitFixture();
  const dir = path.join(root, '.ai-review', '2026-11', '20261105-net-bf');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---', 'schema_version: 1', 'title: "net: bf"', 'module: net', 'audit_type: bugfix',
    'created_at: "2026-11-05T09:00:00+08:00"', 'updated_at: "2026-11-05T09:00:00+08:00"', 'owner: tester',
    'tags: []', 'status: approved', 'ticket: null', 'target_files: [src/math.js]', 'current_revision: 1',
    'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
    'gate_checks: []', 'comments: []', 'human_decisions: []',
    'approval:', '  approved_by: tester', '  approved_at: "2026-11-05T10:00:00+08:00"', '  commit_revision: null',
    'rejection: null', 'commit_message: "net: bf"', '---', '', '# 问题与影响', '',
  ].join('\n'), 'utf8');
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'fixture'], root);
  const { base } = await startApi(root);
  const queue = await (await fetch(`${base}/queue`)).json();
  const item = queue.items.find((entry) => entry.id.endsWith('net-bf'));
  // §5.5：unknown 只是诊断，不显示为失败，也不产生 needsBackfill。
  assert.equal(item?.approvalCommitLookup, 'unknown');
  assert.equal(item?.approvalCommitRevision, undefined);
  assert.equal(item?.needsBackfill, undefined);
  assert.equal(item?.parseError, undefined);
});
