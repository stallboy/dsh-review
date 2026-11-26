import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_TYPES,
  TOP_LEVEL_KEY_ORDER,
  parseReviewMarkdown,
  serializeReviewMarkdown,
} from '../packages/dsh-plugin/dist/host/frontmatter.js';
import {
  DEFAULT_MAX_ANTI_PATTERNS,
  DEFAULT_REJECTION_MEMORY_DAYS,
  loadReviewers,
  reviewersPath,
  serializeInitialReviewers,
} from '../packages/dsh-plugin/dist/host/reviewers.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchFixture, reviewFixture, sha256Hex } from './fixtures/contract.mjs';

const PATCH_SHA = sha256Hex(patchFixture());

const FULL_FM = [
  '---',
  'schema_version: 1',
  'finding_id: net-close-race',
  'title: "net: 修复连接关闭竞态"',
  'module: net',
  'audit_type: stdlib',
  'issue_kind: repair',
  'depends_on: null',
  'priority: P1',
  'base_revision: "108"',
  'created_at: "2026-11-03T14:30:00+08:00"',
  'updated_at: "2026-11-03T15:10:00+08:00"',
  'owner: zhangsan',
  'tags: [net, concurrency]',
  'ticket: null',
  'status: rejected',
  'target_files:',
  '  - internal/net/session.go',
  'record_revision: 3',
  'patches:',
  '  - id: 1',
  '    patch: 001.patch',
  '    option_id: opt-a',
  '    base_revision: "108"',
  '    author: ai',
  `    sha256: "${PATCH_SHA}"`,
  '  - id: 2',
  '    patch: 002.patch',
  '    option_id: opt-a',
  '    base_revision: "112"',
  '    author: human',
  `    sha256: "${PATCH_SHA}"`,
  'options:',
  '  - id: opt-a',
  '    title: 统一关闭状态机',
  '    tradeoff: 改动集中',
  '    confidence: 0.92',
  '    current_patch: 2',
  '    gate_checks:',
  '      - "go test ./..."',
  'observations: []',
  'decisions: []',
  'repair_attempts: []',
  'comments:',
  '  - id: c1',
  '    revision: 1',
  '    option_id: opt-a',
  '    patch_id: 1',
  '    file: internal/net/session.go',
  '    line: 42',
  '    side: RIGHT',
  '    author: zhangsan',
  '    content: "这里会触发多次关闭"',
  '    status: resolved',
  '    created_at: "2026-11-03T15:00:00+08:00"',
  'human_decisions:',
  '  - id: h1',
  '    question: "是否允许丢弃发送中的消息？"',
  '    note: 影响发布说明',
  'approval: null',
  'approval_history: []',
  'rejection:',
  '  rejected_by: zhangsan',
  '  rejected_at: "2026-11-20T02:00:00+08:00"',
  '  reason: "现状可接受，暂不改造"',
  '  category: intentional_design',
  'commit_message: |',
  '  net: 修复连接关闭竞态',
  '',
  '  统一关闭状态流转。',
  'custom_unknown_field: keep-me',
  '---',
  '',
  '# 问题与影响',
  '',
  '测试正文。',
  '',
].join('\n');

test('P1: 全字段解析（28 顶层键 / patches / options / rejection / commit_message / human_decisions / side）', () => {
  const { meta } = parseReviewMarkdown(FULL_FM);
  assert.equal(meta.findingId, 'net-close-race');
  assert.equal(meta.module, 'net');
  assert.equal(meta.auditType, 'stdlib');
  assert.equal(meta.issueKind, 'repair');
  assert.equal(meta.priority, 'P1');
  assert.equal(meta.recordRevision, 3);
  assert.equal(new Date(meta.updatedAt).toISOString(), '2026-11-03T07:10:00.000Z');
  assert.deepEqual(meta.targetFiles, ['internal/net/session.go']);
  assert.equal(meta.patches[1].author, 'human');
  assert.equal(meta.options[0].currentPatch, 2);
  assert.equal(meta.comments[0].side, 'RIGHT');
  assert.equal(meta.comments[0].optionId, 'opt-a');
  assert.equal(meta.comments[0].patchId, 1);
  assert.equal(meta.humanDecisions[0].id, 'h1');
  assert.equal(meta.humanDecisions[0].note, '影响发布说明');
  assert.equal(meta.rejection?.rejectedBy, 'zhangsan');
  assert.equal(meta.rejection?.category, 'intentional_design');
  assert.ok(meta.commitMessage?.startsWith('net: 修复连接关闭竞态'));
  assert.equal(meta.extra?.['custom_unknown_field'], 'keep-me');
});

test('P1: 往返序列化不丢字段且严格遵守 SPEC §3.3 28 键固定键序', () => {
  const parsed = parseReviewMarkdown(FULL_FM);
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  const reparsed = parseReviewMarkdown(out);
  assert.equal(reparsed.meta.module, 'net');
  assert.equal(reparsed.meta.auditType, 'stdlib');
  assert.equal(reparsed.meta.rejection?.reason, parsed.meta.rejection?.reason);
  assert.equal(reparsed.meta.comments[0].side, 'RIGHT');
  assert.equal(reparsed.meta.patches[0].author, 'ai');
  assert.equal(reparsed.meta.humanDecisions[0].question, parsed.meta.humanDecisions[0].question);
  assert.equal(reparsed.meta.extra?.['custom_unknown_field'], 'keep-me');
  assert.equal(reparsed.meta.commitMessage, parsed.meta.commitMessage);
  const keyOrder = /^---\n([\s\S]*?)\n---/.exec(out)?.[1]
    ?.split('\n')
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.replace(/:.*$/, '')) ?? [];
  assert.deepEqual(keyOrder.slice(0, TOP_LEVEL_KEY_ORDER.length), [...TOP_LEVEL_KEY_ORDER]);
  assert.equal(keyOrder[keyOrder.length - 1], 'custom_unknown_field');
});

test('P1: approval_history 与 decisions / observations 往返完整保留', () => {
  const withHistory = reviewFixture('history-roundtrip', {
    decisions: [
      '',
      '  - action: resume_review',
      '    actor: zhangsan',
      '    at: "2026-11-04T09:00:00Z"',
      '    reason: "此前判断已失效"',
    ].join('\n'),
  });
  const parsed = parseReviewMarkdown(withHistory);
  assert.equal(parsed.meta.decisions.length, 1);
  assert.equal(parsed.meta.decisions[0].action, 'resume_review');
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  const reparsed = parseReviewMarkdown(out);
  assert.equal(reparsed.meta.decisions[0].reason, '此前判断已失效');
});

test('P1: audit_type 非法值与 author 非法值报格式错误', () => {
  assert.throws(() => parseReviewMarkdown(FULL_FM.replace('audit_type: stdlib', 'audit_type: refactor')));
  assert.throws(() => parseReviewMarkdown(FULL_FM.replace('    author: ai', '    author: robot')));
  assert.equal(AUDIT_TYPES.length, 9);
  assert.ok(AUDIT_TYPES.includes('yagni'));
});

test('P1: 旧 schema_version 或缺少必填顶层字段必须报错，不得静默补全或降级兼容', () => {
  assert.throws(() => parseReviewMarkdown(FULL_FM.replace('schema_version: 1', 'schema_version: 3')), /schema_version/);
  for (const field of ['finding_id', 'module', 'audit_type', 'issue_kind', 'priority', 'record_revision', 'approval_history', 'commit_message']) {
    const complete = reviewFixture('required-check');
    assert.throws(
      () => parseReviewMarkdown(complete.split('\n').filter((line) => !line.startsWith(`${field}:`)).join('\n')),
      new RegExp(field),
    );
  }
  const withoutPatches = reviewFixture('required-check', { patches: ' []', options: ' []' })
    .split('\n').filter((line) => !line.startsWith('patches:')).join('\n');
  assert.throws(() => parseReviewMarkdown(withoutPatches), /patches/);
  const withoutOptions = reviewFixture('required-check', { patches: ' []', options: ' []' })
    .split('\n').filter((line) => !line.startsWith('options:')).join('\n');
  assert.throws(() => parseReviewMarkdown(withoutOptions), /options/);
});

test('P1: reviewers.yml 解析配置（无旧白名单，含 stale_days / rejection_memory_days / max_anti_patterns 与初始化模板）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-p1-reviewers-'));
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(reviewersPath(root), [
    'default_owner: zhangsan',
    'rules:',
    '  - owner: lisi',
    '    paths:',
    '      - internal/net/**',
    'stale_days: 14',
    'rejection_memory_days: 45',
    'max_anti_patterns: 5',
    '',
  ].join('\n'), 'utf8');
  const config = await loadReviewers(root);
  assert.equal(config.defaultOwner, 'zhangsan');
  assert.equal(config.staleDays, 14);
  assert.equal(config.rejectionMemoryDays, 45);
  assert.equal(config.maxAntiPatterns, 5);
  await writeFile(reviewersPath(root), serializeInitialReviewers('alice'), 'utf8');
  const initParsed = await loadReviewers(root);
  assert.equal(initParsed.defaultOwner, 'alice');
  assert.equal(initParsed.rejectionMemoryDays, DEFAULT_REJECTION_MEMORY_DAYS);
  assert.equal(initParsed.maxAntiPatterns, DEFAULT_MAX_ANTI_PATTERNS);
});
