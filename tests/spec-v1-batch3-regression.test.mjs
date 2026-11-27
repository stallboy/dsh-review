import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { AuditLifecycle, AUDIT_TIMEOUT_MS } from '../packages/dsh-plugin/dist/host/audit-lifecycle.js';
import { AuditStageSession } from '../packages/dsh-plugin/dist/host/audit-stages.js';
import { DshEventStreamParser } from '../packages/dsh-plugin/dist/host/dsh-stream.js';
import { assertAppendOnlyHistory } from '../packages/dsh-plugin/dist/host/history-guard.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { reviewFixture, writeCandidate } from './fixtures/contract.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

function makeBaseMeta(overrides = {}) {
  return {
    schemaVersion: 1,
    findingId: 'net-timeout',
    title: 'net: timeout leak',
    module: 'net',
    auditType: 'bugfix',
    issueKind: 'repair',
    dependsOn: null,
    priority: 'P1',
    baseRevision: 'a'.repeat(40),
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T01:00:00.000Z',
    owner: 'alice',
    tags: ['net'],
    ticket: null,
    status: 'pending',
    targetFiles: ['src/net.js'],
    recordRevision: 2,
    patches: [
      { id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: 'a'.repeat(40), author: 'ai', sha256: '1'.repeat(64) },
      { id: 2, patch: '002.patch', optionId: 'opt-b', baseRevision: 'a'.repeat(40), author: 'ai', sha256: '2'.repeat(64) },
    ],
    options: [
      { id: 'opt-a', title: 'A', tradeoff: 'small', confidence: 0.9, currentPatch: 1, gateChecks: ['node --version'] },
      { id: 'opt-b', title: 'B', tradeoff: 'alt', confidence: 0.8, currentPatch: 2, gateChecks: ['node --version'] },
    ],
    observations: [{
      auditId: '20261120-000000-repo',
      baseRevision: 'a'.repeat(40),
      at: '2026-11-20T00:00:00.000Z',
      verdict: 'confirmed',
      reason: 'leak',
      evidence: [{ path: 'src/net.js', line: 1, excerpt: 'x', reason: 'r' }],
    }],
    decisions: [],
    repairAttempts: [{
      id: 1,
      at: '2026-11-20T00:30:00.000Z',
      actor: 'alice',
      optionId: 'opt-a',
      patchId: 1,
      baseRevision: 'a'.repeat(40),
      applyMode: 'strict',
      outcome: 'gate_failed',
      restored: true,
      summary: 'gate exit 1',
    }],
    comments: [{
      id: 'c1',
      author: 'alice',
      createdAt: '2026-11-20T00:40:00.000Z',
      revision: 1,
      optionId: 'opt-a',
      patchId: 1,
      content: 'please add null guard',
      status: 'unresolved',
    }],
    humanDecisions: [],
    approval: null,
    approvalHistory: [],
    rejection: null,
    commitMessage: 'net: timeout leak\n\nfix',
    extra: { custom_tag: 'keep-me' },
    ...overrides,
  };
}

test('Batch 3: DshEventStreamParser 严格只提取 assistant 输出且 delta 不插入换行', () => {
  const parser = new DshEventStreamParser();
  parser.feedLine(JSON.stringify({ type: 'tool_result', content: '{"verdict":"confirmed","fake":true}' }));
  parser.feedLine(JSON.stringify({ type: 'tool_use', name: 'read', input: { path: 'x' } }));
  parser.feedLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'ignore me' } }));
  parser.feedLine(JSON.stringify({ type: 'thinking', delta: '{"verdict":"refuted"}' }));
  parser.feedLine(JSON.stringify({ type: 'assistant.delta', delta: '{"verdict":' }));
  parser.feedLine(JSON.stringify({ type: 'assistant.delta', delta: '"confirmed","ok":true}' }));
  assert.equal(parser.getAssistantText(), '{"verdict":"confirmed","ok":true}');
});

test('Batch 3: assertAppendOnlyHistory 阻断删改 repair_attempts / owner / 非目标方案 / extra / 错基线补丁', () => {
  const oldMeta = makeBaseMeta();
  const base2 = 'b'.repeat(40);
  const validNext = makeBaseMeta({
    recordRevision: 3,
    updatedAt: '2026-11-20T02:00:00.000Z',
    patches: [
      ...oldMeta.patches,
      { id: 3, patch: '003.patch', optionId: 'opt-a', baseRevision: base2, author: 'ai', sha256: '3'.repeat(64) },
    ],
    options: [
      { ...oldMeta.options[0], currentPatch: 3 },
      oldMeta.options[1],
    ],
    comments: [{ ...oldMeta.comments[0], status: 'resolved' }],
  });
  assert.deepEqual(
    assertAppendOnlyHistory(oldMeta, validNext, { mode: 'mode_b', targetOptionId: 'opt-a', targetBase: base2 }),
    [],
  );

  const tampered = makeBaseMeta({
    ...validNext,
    owner: 'bob',
    repairAttempts: [],
    extra: {},
    options: [
      { ...oldMeta.options[0], currentPatch: 3 },
      { ...oldMeta.options[1], title: 'TAMPERED' },
    ],
    patches: [
      ...oldMeta.patches,
      { id: 3, patch: '003.patch', optionId: 'opt-a', baseRevision: 'c'.repeat(40), author: 'ai', sha256: '3'.repeat(64) },
    ],
  });
  const errs = assertAppendOnlyHistory(oldMeta, tampered, { mode: 'mode_b', targetOptionId: 'opt-a', targetBase: base2 });
  assert.ok(errs.some((e) => e.includes('负责人')));
  assert.ok(errs.some((e) => e.includes('repair_attempts')));
  assert.ok(errs.some((e) => e.includes('扩展键')));
  assert.ok(errs.some((e) => e.includes('非目标方案')));
  assert.ok(errs.some((e) => e.includes('base_revision')));
});

test('Batch 3: verify 阶段强白名单阻断初审推理与修复建议透传', async () => {
  const root = await createGitFixture();
  try {
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: alice\nrules: []\n', 'utf8');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'add reviewers'], root);
    const vcs = createVcs('git', root);
    const base = await vcs.getCurrentBase();
    const session = new AuditStageSession({
      auditId: '20261126-120000-repo',
      root,
      scope: '.',
      baseRevision: base,
      trigger: 'manual',
      owner: 'alice',
      note: '',
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
      vcs,
      store: new ReviewStore(root),
      stageExecutors: [],
      executor: async ({ stage }) => {
        if (stage === 'scan') {
          return {
            ok: true,
            executorUsed: 'dsh-subagent',
            output: {
              leads: [{
                leadId: 'lead-1',
                entry: 'add',
                path: 'src/math.js',
                line: 1,
                precondition: 'always',
                expected: 'add',
                impact: 'none',
              }],
              coverage: ['src/math.js'],
              limits: [],
            },
          };
        }
        return {
          ok: true,
          executorUsed: 'dsh-subagent',
          output: { verdict: 'refuted', reason: 'not a bug', evidence: [] },
        };
      },
    });
    await session.runStage('scan', 'dsh-subagent', { taskScope: ['.'] }, new AbortController().signal);

    await assert.rejects(
      () => session.runStage('verify', 'dsh-subagent', {
        subjectId: 'lead-1',
        scenario: 'reachable_behavior',
        analysis: 'leaked scan reasoning',
        suggestedFix: 'change add',
      }, new AbortController().signal),
      /禁止透传/,
    );

    await assert.rejects(
      () => session.runStage('verify', 'dsh-subagent', {
        subjectId: 'lead-1',
        scenario: 'reachable_behavior',
        navigation: { path: 'src/math.js', line: 1, reasoning: 'sneaky leak' },
      }, new AbortController().signal),
      /禁止字段/,
    );

    const okRes = await session.runStage('verify', 'dsh-subagent', {
      subjectId: 'lead-1',
      scenario: 'reachable_behavior',
      navigation: { path: 'src/math.js', line: 1 },
    }, new AbortController().signal);
    assert.equal(okRes.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Batch 3: AuditLifecycle 重启清理残留 stageProcessActive 且超 3h 活动租约自动迁为 releasable', async () => {
  let persisted = [
    {
      auditId: '20261126-000000-fresh',
      root: '/tmp/repo1',
      targetPath: '',
      trigger: 'manual',
      baseRevision: 'a'.repeat(40),
      owner: 'alice',
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      candidateIdsBefore: [],
      state: 'active',
      stageProcessActive: true,
    },
    {
      auditId: '20261126-000000-overdue',
      root: '/tmp/repo2',
      targetPath: '',
      trigger: 'manual',
      baseRevision: 'b'.repeat(40),
      owner: 'alice',
      createdAt: new Date(Date.now() - AUDIT_TIMEOUT_MS - 1000).toISOString(),
      candidateIdsBefore: [],
      state: 'active',
    },
  ];
  const store = {
    load: async () => structuredClone(persisted),
    save: async (leases) => { persisted = structuredClone(leases); },
  };
  const lifecycle = new AuditLifecycle(store);
  await lifecycle.load();
  const fresh = lifecycle.find('20261126-000000-fresh');
  assert.equal(fresh?.state, 'active');
  assert.equal(fresh?.stageProcessActive, undefined);
  const overdue = lifecycle.find('20261126-000000-overdue');
  assert.equal(overdue?.state, 'releasable');
});

test('Batch 3: GET /findings 支持 awaiting_verification，全部初审失败返回 RECOVERY_REQUIRED 且不写空报告，/candidate/finalize 拦截跨问题占用', async () => {
  const root = await createGitFixture();
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dcr-batch3-state-'));
  try {
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: alice\nrules: []\n', 'utf8');
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

    const extDir = path.join(root, '.ai-review', '2026-11', 'ext-done');
    await mkdir(extDir, { recursive: true });
    await writeFile(path.join(extDir, 'review.md'), reviewFixture('ext-done', {
      baseRevision: JSON.stringify(base),
      owner: 'alice',
      status: 'awaiting_verification',
      issueKind: 'confirm',
      patches: ' []',
      options: ' []',
      commitMessage: 'null',
      decisions: [
        '',
        '  - at: "2026-11-25T00:00:00.000Z"',
        '    actor: alice',
        '    action: human_takeover',
        '    reason: takeover',
        '  - at: "2026-11-25T01:00:00.000Z"',
        '    actor: alice',
        '    action: external_completed',
        '    reason: fixed externally',
      ].join('\n'),
    }), 'utf8');

    await writeCandidate(root, 'issue-a', {
      review: {
        baseRevision: JSON.stringify(base),
        owner: 'alice',
        comments: [
          '',
          '  - id: c1',
          '    author: alice',
          '    created_at: "2026-11-25T00:00:00.000Z"',
          '    revision: 1',
          '    file: ""',
          '    line: 0',
          '    content: revise me',
          '    status: unresolved',
        ].join('\n'),
      },
    });
    await writeCandidate(root, 'issue-b', {
      review: { baseRevision: JSON.stringify(base), owner: 'alice' },
    });
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'seed fixtures'], root);

    let idleCb = null;
    const api = new ReviewApi({
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'alice', runner: 'dsh' },
      saveSettings: async (s) => s,
      statePath: path.join(stateDir, 'state.json'),
      auditStageExecutor: async () => ({ ok: false, reason: 'failed', diagnostic: 'all scans failed' }),
      createAuditSession: async ({ onCreated }) => {
        await onCreated?.('sess-fail-1');
        return { sessionId: 'sess-fail-1' };
      },
      withAuditSessionIdle: async (_sid, _reqId, _sig, finalize) => {
        idleCb = finalize;
        return true;
      },
      stopAuditSession: async () => true,
      createFixSession: async ({ onCreated }) => {
        await onCreated?.('fix-sess-a');
        return { sessionId: 'fix-sess-a' };
      },
    });
    await api.init();

    // 1) GET /findings?dispositions=awaiting_verification
    const findingsRes = await api.invoke({
      method: 'GET',
      path: '/findings',
      query: { dispositions: 'awaiting_verification' },
    });
    assert.equal(findingsRes.status, 200);
    assert.equal(findingsRes.body.findings.length, 1);
    assert.equal(findingsRes.body.findings[0].disposition, 'awaiting_verification');

    // 2) POST /audit/session 全部初审阶段失败 -> 空闲收尾返回 RECOVERY_REQUIRED 且不写空报告
    const sessRes = await api.invoke({ method: 'POST', path: '/audit/session', body: { targetPath: '.' } });
    assert.equal(sessRes.status, 202);
    const failedScan = await api.runAuditStage('sess-fail-1', 'scan', 'dsh-subagent', { taskScope: ['.'] }, new AbortController().signal);
    assert.equal(failedScan.ok, false);
    assert.ok(idleCb);
    await idleCb(new AbortController().signal);
    const jobRes = await api.invoke({ method: 'GET', path: `/jobs/${sessRes.body.jobId}` });
    assert.equal(jobRes.body.result.status, 'RECOVERY_REQUIRED');
    assert.equal(jobRes.body.result.reason, 'SYNC_STATE_UNKNOWN');
    assert.equal(jobRes.body.result.stageFailure, true);
    assert.equal(api.leaseLookup(sessRes.body.auditId)?.state, 'releasable');
    assert.equal(api.leaseLookup(sessRes.body.auditId)?.commitOutcomeUnknown, undefined);

    // 释放租约以便测试 fix-session 跨问题占用拦截
    const relRes = await api.invoke({
      method: 'POST',
      path: '/audit/release',
      body: { auditId: sessRes.body.auditId, confirmStopped: true },
    });
    assert.equal(relRes.status, 200);

    // 3) 开启 issue-a 的 fix-session 后，/candidate/finalize issue-b 必须 409 拒绝
    const issueA = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: '2026-11/issue-a' } })).body.candidate.meta;
    const issueB = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: '2026-11/issue-b' } })).body.candidate.meta;

    const fixRes = await api.invoke({
      method: 'POST',
      path: '/fix-session',
      body: {
        id: '2026-11/issue-a',
        expectedRevision: issueA.recordRevision,
        expectedOwner: issueA.owner,
        expectedUpdatedAt: issueA.updatedAt,
        optionId: 'opt-a',
        patchId: 1,
      },
    });
    assert.equal(fixRes.status, 202, JSON.stringify(fixRes.body));

    const wrongFinalize = await api.invoke({
      method: 'POST',
      path: '/candidate/finalize',
      body: {
        id: '2026-11/issue-b',
        expectedRevision: issueB.recordRevision,
        expectedOwner: issueB.owner,
        expectedUpdatedAt: issueB.updatedAt,
        optionId: 'opt-a',
        patchId: 1,
      },
    });
    assert.equal(wrongFinalize.status, 409);

    await api.closeAudit();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
