import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewMarkdown, serializeReviewMarkdown, ReviewFormatError } from '../dist/frontmatter.js';
import { loadReviewers, reviewersPath, EMPTY_REVIEWERS } from '../dist/reviewers.js';
import { AUDIT_TYPES } from '../dist/types.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewFixture } from './fixtures/contract.mjs';

/** P1 验收：契约 §2.3 键序、全字段往返、未知键保留、reviewers.yml 扩展配置。 */

const FULL_FM = [
  '---',
  'schema_version: 1',
  'title: "net: 修复连接关闭竞态"',
  'module: net',
  'audit_type: stdlib',
  'created_at: "2026-11-03T14:30:00+08:00"',
  'updated_at: "2026-11-03T15:10:00+08:00"',
  'owner: zhangsan',
  'tags: [net, concurrency]',
  'ticket: null',
  'status: rejected',
  'target_files:',
  '  - internal/net/session.go',
  'current_revision: 2',
  'revisions:',
  '  - id: 1',
  '    base_revision: "108"',
  '    patch: 001.patch',
  '    author: ai',
  '  - id: 2',
  '    base_revision: "112"',
  '    patch: 002.patch',
  '    author: human',
  'gate_checks:',
  '  - "go test ./..."',
  'comments:',
  '  - id: c1',
  '    revision: 1',
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
  'rejection:',
  '  rejected_by: "system:stale"',
  '  rejected_at: "2026-11-20T02:00:00+08:00"',
  '  reason: "超过 stale_days 未审核"',
  'commit_message: |',
  '  net: 修复连接关闭竞态',
  '',
  '  统一关闭状态流转。',
  'reopened_from: null',
  'reopen_reason: null',
  'custom_unknown_field: keep-me',
  '---',
  '',
  '# 问题与影响',
  '',
  '测试正文。',
  '',
].join('\n');

test('P1: 全字段解析（module/audit_type/rejection/commit_message/human_decisions/author/side）', () => {
  const { meta } = parseReviewMarkdown(FULL_FM);
  assert.equal(meta.module, 'net');
  assert.equal(meta.auditType, 'stdlib');
  assert.equal(meta.updatedAt, '2026-11-03T15:10:00+08:00');
  assert.deepEqual(meta.targetFiles, ['internal/net/session.go']);
  assert.equal(meta.revisions[1].author, 'human');
  assert.equal(meta.comments[0].side, 'RIGHT');
  assert.equal(meta.humanDecisions[0].id, 'h1');
  assert.equal(meta.humanDecisions[0].note, '影响发布说明');
  assert.equal(meta.rejection.rejectedBy, 'system:stale');
  assert.equal(meta.rejection.reason, '超过 stale_days 未审核');
  assert.ok(meta.commitMessage.startsWith('net: 修复连接关闭竞态'));
  assert.equal(meta.extra['custom_unknown_field'], 'keep-me');
});

test('P1: 往返序列化不丢字段且键序符合 §2.3', () => {
  const parsed = parseReviewMarkdown(FULL_FM);
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  const reparsed = parseReviewMarkdown(out);
  assert.equal(reparsed.meta.module, 'net');
  assert.equal(reparsed.meta.auditType, 'stdlib');
  assert.equal(reparsed.meta.rejection?.reason, parsed.meta.rejection?.reason);
  assert.equal(reparsed.meta.comments[0].side, 'RIGHT');
  assert.equal(reparsed.meta.revisions[0].author, 'ai');
  assert.equal(reparsed.meta.humanDecisions[0].question, parsed.meta.humanDecisions[0].question);
  assert.equal(reparsed.meta.extra['custom_unknown_field'], 'keep-me');
  assert.equal(reparsed.meta.commitMessage, parsed.meta.commitMessage);
  // 键序：§2.3 固定顺序，未知字段在末尾。
  const keyOrder = /^---\n([\s\S]*?)\n---/.exec(out)?.[1]
    ?.split('\n')
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.replace(/:.*$/, '')) ?? [];
  const expectedPrefix = [
    'schema_version', 'title', 'module', 'audit_type', 'created_at', 'updated_at',
    'owner', 'tags', 'ticket', 'status', 'target_files', 'current_revision', 'revisions',
    'gate_checks', 'comments', 'human_decisions', 'approval', 'rejection', 'commit_message',
  ];
  assert.deepEqual(keyOrder.slice(0, expectedPrefix.length), expectedPrefix);
  assert.equal(keyOrder[keyOrder.length - 1], 'custom_unknown_field');
});

test('P1: reopened 字段同时出现或同时缺省（I16 读侧形态）', () => {
  const reopened = FULL_FM.replace('reopened_from: null', 'reopened_from: 2026-11/20261103-net-other')
    .replace('reopen_reason: null', 'reopen_reason: "此前拒绝为误判"');
  const parsed = parseReviewMarkdown(reopened);
  assert.equal(parsed.meta.reopenedFrom, '2026-11/20261103-net-other');
  assert.equal(parsed.meta.reopenedReason, '此前拒绝为误判');
  const out = serializeReviewMarkdown(parsed.meta, parsed.body);
  assert.ok(out.includes('reopened_from: 2026-11/20261103-net-other'));
  // 缺省时序列化不写这两个键。
  const plain = parseReviewMarkdown(FULL_FM.replace(/reopened_from: null\nreopen_reason: null\n/, ''));
  const outPlain = serializeReviewMarkdown(plain.meta, plain.body);
  assert.ok(!outPlain.includes('reopened_from:'));
});

test('P1: audit_type 非法值与 author 非法值报格式错误（I2/枚举）', () => {
  assert.throws(() => parseReviewMarkdown(FULL_FM.replace('audit_type: stdlib', 'audit_type: refactor')), ReviewFormatError);
  assert.throws(() => parseReviewMarkdown(FULL_FM.replace('    author: ai', '    author: robot')), ReviewFormatError);
  assert.equal(AUDIT_TYPES.length, 9);
  assert.ok(AUDIT_TYPES.includes('yagni'));
});

test('P1/§4.3: 开发期旧数据缺少必填字段时必须标记格式错误，不得静默补全', () => {
  const legacy = [
    '---',
    'schema_version: 1',
    'title: "old: legacy"',
    'created_at: "2026-10-01T00:00:00+08:00"',
    'owner: someone',
    'tags: []',
    'status: pending',
    'ticket: null',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "10"',
    '    patch: 001.patch',
    'gate_checks: []',
    'comments: []',
    'approval: null',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
  assert.throws(() => parseReviewMarkdown(legacy), ReviewFormatError);
  for (const field of ['module', 'audit_type', 'updated_at', 'target_files', 'human_decisions', 'rejection', 'commit_message']) {
    const complete = reviewFixture('legacy-required');
    assert.throws(
      () => parseReviewMarkdown(complete.split('\n').filter((line) => !line.startsWith(`${field}:`)).join('\n')),
      new RegExp(field),
    );
  }
});

test('P1: reviewers.yml 解析扩展配置（白名单/时间窗/上限）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-p1-reviewers-'));
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(reviewersPath(root), [
    'default_owner: zhangsan',
    'rules:',
    '  - owner: lisi',
    '    paths:',
    '      - internal/net/**',
    'allowed_gate_commands:',
    '  - "go test ./..."',
    'stale_days: 14',
    'rejection_memory_days: 45',
    'max_anti_patterns: 5',
    '',
  ].join('\n'), 'utf8');
  const config = await loadReviewers(root);
  assert.deepEqual(config.allowedGateCommands, ['go test ./...']);
  assert.equal(config.staleDays, 14);
  assert.equal(config.rejectionMemoryDays, 45);
  assert.equal(config.maxAntiPatterns, 5);
  // 缺省回退默认值。
  await writeFile(reviewersPath(root), 'default_owner: a\n', 'utf8');
  const fallback = await loadReviewers(root);
  assert.equal(fallback.staleDays, null);
  assert.equal(fallback.rejectionMemoryDays, EMPTY_REVIEWERS.rejectionMemoryDays);
  assert.equal(fallback.maxAntiPatterns, EMPTY_REVIEWERS.maxAntiPatterns);
});
