import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSplitRows,
  filterFindingViews,
  filterQueueItems,
  parseUnifiedDiff,
  relocateInlineComments,
  safeExternalHref,
} from '../packages/protocol/dist/index.js';
import { bindProject, registerNode, setupCentral } from './central-helpers.mjs';

function makeCandidate(overrides = {}) {
  return {
    id: '2026-11/sample-issue',
    findingId: 'sample-issue',
    title: 'Sample Issue',
    module: 'src/core',
    auditType: 'bugfix',
    issueKind: 'repair',
    dependsOn: null,
    priority: 'P1',
    owner: '审核者甲',
    status: 'pending',
    tags: ['security'],
    targetFiles: ['src/core/auth.ts'],
    ticket: 'T-100',
    currentRevision: 1,
    recordRevision: 1,
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:00:00.000Z',
    baseRevision: 'abc123',
    patchStats: { files: 1, additions: 3, deletions: 1, entries: [] },
    unresolvedComments: 0,
    humanJudgmentCount: 0,
    humanJudgmentDeclared: true,
    isBaseBehind: false,
    lastFeedback: '',
    deferred: false,
    options: [],
    ...overrides,
  };
}

function makeFinding(overrides = {}) {
  return {
    id: '2026-11/sample-issue',
    findingId: 'sample-issue',
    recordRevision: 1,
    owner: '审核者甲',
    updatedAt: '2026-11-15T10:00:00.000Z',
    title: 'Sample Finding',
    summary: 'Auth token check missing',
    module: 'src/core',
    auditType: 'bugfix',
    priority: 'P1',
    issueStatus: 'pending',
    issueKind: 'repair',
    dependsOn: null,
    deferred: false,
    disposition: 'undecided',
    baseRevision: 'abc123',
    targetFiles: ['src/core/auth.ts'],
    repairPlan: 'Add validation',
    options: [],
    repairHints: [],
    repairAttempts: [],
    ...overrides,
  };
}

test('Batch4/Protocol：parseUnifiedDiff + buildSplitRows + relocateInlineComments 正确解析并重定位锚点', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a + b;',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/app.ts');
  const rows = buildSplitRows(files[0].lines);
  assert.ok(rows.some((r) => r.kind === 'pair' && r.left?.text === 'const b = 2;' && r.right?.text === 'const b = 3;'));

  // 行号偏移到不存在的 99，但 anchor.snippet + before 仍能精准重定位到第 3 行 RIGHT
  const relocated = relocateInlineComments(files[0], [{
    id: 'c1',
    file: 'src/app.ts',
    line: 99,
    side: 'RIGHT',
    optionId: 'opt-a',
    anchor: { snippet: 'const c = 4;', before: 'const b = 3;' },
  }], 'opt-a');
  assert.deepEqual(relocated.get('c1'), { side: 'RIGHT', line: 3 });
});

test('Batch4/Protocol：safeExternalHref 仅放行 http/https/mailto 并拦截 javascript/data 协议', () => {
  assert.equal(safeExternalHref('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeExternalHref('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(safeExternalHref('mailto:dev@example.com'), 'mailto:dev@example.com');
  assert.equal(safeExternalHref('javascript:alert(1)'), null);
  assert.equal(safeExternalHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeExternalHref('   '), null);
});

test('Batch4/Protocol：filterQueueItems 与 filterFindingViews 支持多维筛选并按 owner 计算 8 态 counts', () => {
  const items = [
    makeCandidate({ id: '2026-11/a', owner: 'alice', status: 'pending', tags: ['sec'], targetFiles: ['src/auth/a.ts'], createdAt: '2026-11-10T00:00:00Z' }),
    makeCandidate({ id: '2026-11/b', owner: 'alice', status: 'awaiting_verification', tags: ['perf'], targetFiles: ['src/db/b.ts'], createdAt: '2026-11-12T00:00:00Z' }),
    makeCandidate({ id: '2026-11/c', owner: 'bob', status: 'approved', tags: ['sec'], targetFiles: ['src/auth/c.ts'], createdAt: '2026-11-14T00:00:00Z' }),
  ];
  const filtered = filterQueueItems(items, { owner: 'alice', statuses: 'pending', tag: 'sec', dir: 'src/auth' });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, '2026-11/a');
  // counts 覆盖 owner=alice 的全部 8 态（不受 statuses 筛选截断）
  assert.equal(filtered.counts.pending, 1);
  assert.equal(filtered.counts.awaiting_verification, 1);
  assert.equal(filtered.counts.approved, 0);

  const findings = [
    makeFinding({ id: '2026-11/a', owner: 'alice', disposition: 'awaiting_verification', targetFiles: ['src/auth/a.ts'] }),
    makeFinding({ id: '2026-11/b', owner: 'bob', disposition: 'undecided', targetFiles: ['src/db/b.ts'] }),
  ];
  const matchedFindings = filterFindingViews(findings, { scope: 'src/auth', dispositions: 'awaiting_verification', owner: 'alice' });
  assert.equal(matchedFindings.length, 1);
  assert.equal(matchedFindings[0].id, '2026-11/a');
});

test('Batch4/Central：/queue 与 /findings 支持全部查询参数，且 owner 默认当前审核身份、空串查全部', async t => {
  const { app, headers } = await setupCentral(t);
  const node = await registerNode(app);
  const project = await bindProject(app, headers, node);

  const snap = await app.inject({
    method: 'POST',
    url: '/node-api/v1/snapshots',
    headers: node.headers,
    payload: {
      instanceId: node.instanceId,
      snapshot: {
        projectId: project.projectId,
        bindingGeneration: 1,
        projectConfigRevision: 1,
        collectedAt: '2026-11-18T00:00:00.000Z',
        snapshotSequence: 1,
        vcsSnapshot: 'rev-1',
        queue: [
          makeCandidate({ id: '2026-11/mine', owner: '审核者甲', status: 'pending', tags: ['sec'], targetFiles: ['src/auth/a.ts'] }),
          makeCandidate({ id: '2026-11/mine-wait', owner: '审核者甲', status: 'awaiting_verification', tags: ['ops'], targetFiles: ['src/ops/b.ts'] }),
          makeCandidate({ id: '2026-11/other', owner: '审核者乙', status: 'pending', tags: ['sec'], targetFiles: ['src/auth/c.ts'] }),
        ],
        findings: [
          makeFinding({ id: '2026-11/mine', owner: '审核者甲', disposition: 'undecided', targetFiles: ['src/auth/a.ts'] }),
          makeFinding({ id: '2026-11/mine-wait', owner: '审核者甲', disposition: 'awaiting_verification', targetFiles: ['src/ops/b.ts'] }),
        ],
        audits: [],
        errors: [],
      },
    },
  });
  assert.equal(snap.statusCode, 200, snap.body);

  // 未传 owner 默认按登录者 reviewIdentity（审核者甲）过滤，且 counts 覆盖其名下 8 态
  const defaultQueue = (await app.inject({ url: `/api/v1/projects/${project.projectId}/queue`, headers })).json();
  assert.equal(defaultQueue.owner, '审核者甲');
  assert.equal(defaultQueue.me, '审核者甲');
  assert.deepEqual(defaultQueue.items.map((x) => x.id), ['2026-11/mine', '2026-11/mine-wait']);
  assert.equal(defaultQueue.counts.pending, 1);
  assert.equal(defaultQueue.counts.awaiting_verification, 1);

  // 传 owner="" 查询全部成员
  const allQueue = (await app.inject({ url: `/api/v1/projects/${project.projectId}/queue?owner=&statuses=pending&tag=sec&dir=src/auth`, headers })).json();
  assert.deepEqual(allQueue.items.map((x) => x.id), ['2026-11/mine', '2026-11/other']);
  assert.equal(allQueue.counts.pending, 2);

  // /findings 支持 scope + dispositions=awaiting_verification
  const findingsRes = (await app.inject({ url: `/api/v1/projects/${project.projectId}/findings?scope=src/ops&dispositions=awaiting_verification`, headers })).json();
  assert.deepEqual(findingsRes.items.map((x) => x.id), ['2026-11/mine-wait']);

  // 已移除旧接口 PUT /audit-schedule 返回 404
  const legacyRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${project.projectId}/audit-schedule`,
    headers,
    payload: { enabled: true, startTime: '02:00', timeZone: 'UTC' },
  });
  assert.equal(legacyRes.statusCode, 404);
});

test('Batch4/Central：takeover 严格校验 owner 参数并拒绝空串、非字符串与未知用户', async t => {
  const { app, headers } = await setupCentral(t);
  const node = await registerNode(app);
  const project = await bindProject(app, headers, node);

  const guard = { expectedRevision: 1, expectedOwner: '审核者乙', expectedUpdatedAt: '2026-11-15T10:00:00.000Z' };
  const postTakeover = (key, payload) => app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.projectId}/commands`,
    headers,
    payload: { idempotencyKey: key, operation: 'takeover', guard, payload },
  });

  for (const [idx, bad] of [
    { id: '2026-11/a', owner: '' },
    { id: '2026-11/a', owner: '   ' },
    { id: '2026-11/a', owner: 123 },
    { id: '2026-11/a', owner: '不存在的用户' },
  ].entries()) {
    const res = await postTakeover(`bad-owner-${idx}`, bad);
    assert.equal(res.statusCode, 422, JSON.stringify({ bad, body: res.body }));
  }

  // 显式传有效审核身份允许提交
  const okExplicit = await postTakeover('ok-explicit', { id: '2026-11/a', owner: '审核者甲' });
  assert.equal(okExplicit.statusCode, 202, okExplicit.body);
  assert.equal(okExplicit.json().command.payload.owner, '审核者甲');
});

test('Batch4/Central：/tasks/:id/logs 返回规范增量字段并正确处理 since 与 logResetRequired', async t => {
  const { app, headers } = await setupCentral(t);
  const node = await registerNode(app);
  const project = await bindProject(app, headers, node);

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.projectId}/commands`,
    headers,
    payload: { idempotencyKey: 'log-test', operation: 'sync', payload: {} },
  });
  assert.equal(created.statusCode, 202, created.body);
  const commandId = created.json().command.commandId;

  await app.inject({
    method: 'POST',
    url: '/node-api/v1/commands/poll',
    headers: node.headers,
    payload: { instanceId: node.instanceId },
  });
  await app.inject({
    method: 'POST',
    url: `/node-api/v1/commands/${commandId}/ack`,
    headers: node.headers,
    payload: { instanceId: node.instanceId },
  });
  await app.inject({
    method: 'POST',
    url: '/node-api/v1/events',
    headers: node.headers,
    payload: {
      instanceId: node.instanceId,
      events: [{ commandId, sequence: 1, type: 'progress', logs: ['line-1', 'line-2', 'line-3'] }],
    },
  });

  const full = (await app.inject({ url: `/api/v1/tasks/${commandId}/logs`, headers })).json();
  assert.deepEqual(full.log, ['line-1', 'line-2', 'line-3']);
  assert.equal(full.logOffset, 3);
  assert.equal(full.totalLogLines, 3);
  assert.equal(full.earliestLogOffset, 0);
  assert.equal(full.logResetRequired, false);

  const delta = (await app.inject({ url: `/api/v1/tasks/${commandId}/logs?since=2`, headers })).json();
  assert.deepEqual(delta.log, ['line-3']);
  assert.equal(delta.logOffset, 3);
  assert.equal(delta.logResetRequired, false);

  // since 超出当前偏移时触发 logResetRequired 并返回当前缓冲窗口
  const reset = (await app.inject({ url: `/api/v1/tasks/${commandId}/logs?since=99`, headers })).json();
  assert.equal(reset.logResetRequired, true);
  assert.deepEqual(reset.log, ['line-1', 'line-2', 'line-3']);
});
