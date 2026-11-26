import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../helpers.mjs';

/** 集中提供 schema_version: 1 评审数据的公共形状，让各用例只需构造与断言相关的差异。 */

const DEFAULT_PATCH_FILE = 'src/math.js';

export function sha256Hex(content) {
  return createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')).digest('hex');
}

export function patchFixture(options = {}) {
  const file = options.file ?? DEFAULT_PATCH_FILE;
  const from = options.from ?? 'export const add = (a, b) => a - b;';
  const to = options.to ?? 'export const add = (a, b) => a + b;';
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
    '',
  ].join('\n');
}

export function deleteFilePatchFixture(file) {
  return [
    `diff --git a/${file} b/${file}`,
    'deleted file mode 100644',
    `--- a/${file}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-#!/bin/sh',
    '',
  ].join('\n');
}

export function newFilePatchFixture(file, content = 'export const x = 1;') {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${content}`,
    '',
  ].join('\n');
}

export function multiFilePatchFixture(files) {
  return files.map((file) => patchFixture({ file })).join('');
}

/** overrides 可直接提供 YAML 字段片段，以便构造解析器应拒绝的数据。 */
export function reviewFixture(slug, overrides = {}) {
  const patchText = overrides.patchText ?? patchFixture();
  const patchSha = overrides.patchSha256 ?? sha256Hex(patchText);
  const recordRevision = overrides.recordRevision ?? overrides.currentRevision ?? 1;
  const optionId = overrides.optionId ?? 'opt-a';
  const base = {
    schemaVersion: 1,
    findingId: slug.toLowerCase(),
    title: `net: ${slug}`,
    module: 'net',
    auditType: 'bugfix',
    issueKind: 'repair',
    dependsOn: 'null',
    priority: 'P2',
    baseRevision: '"1"',
    createdAt: '2026-11-01T10:00:00+08:00',
    updatedAt: '2026-11-01T10:00:00+08:00',
    owner: 'tester',
    tags: '[]',
    ticket: 'null',
    status: 'pending',
    targetFiles: `[${DEFAULT_PATCH_FILE}]`,
    recordRevision,
    patch: '001.patch',
    author: 'ai',
    gateChecks: '["node --version"]',
    observations: '[]',
    decisions: '[]',
    repairAttempts: '[]',
    comments: '[]',
    humanDecisions: '[]',
    approval: 'null',
    approvalHistory: '[]',
    rejection: 'null',
    commitMessage: `net: ${slug}`,
    extraLines: [],
    ...overrides,
  };

  const normalizedBaseRev = (() => {
    const raw = String(base.baseRevision);
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw;
    return JSON.stringify(raw);
  })();

  const patchesBlock = base.patches !== undefined
    ? `patches:${String(base.patches).startsWith('\n') ? '' : ' '}${base.patches}`
    : base.issueKind !== 'repair'
      ? 'patches: []'
      : [
          'patches:',
          '  - id: 1',
          `    patch: ${JSON.stringify(base.patch)}`,
          `    option_id: ${optionId}`,
          `    base_revision: ${normalizedBaseRev}`,
          `    author: ${base.author}`,
          `    sha256: ${JSON.stringify(patchSha)}`,
        ].join('\n');

  const optionsBlock = base.options !== undefined
    ? `options:${String(base.options).startsWith('\n') ? '' : ' '}${base.options}`
    : base.issueKind !== 'repair'
      ? 'options: []'
      : [
          'options:',
          `  - id: ${optionId}`,
          `    title: ${JSON.stringify('默认修复方案')}`,
          `    tradeoff: ${JSON.stringify('最小侵入修复')}`,
          '    confidence: 0.9',
          '    current_patch: 1',
          `    gate_checks: ${base.gateChecks}`,
        ].join('\n');

  const bodyLines = overrides.bodyLines ?? [
    '# 问题与影响',
    '示例问题。',
    '',
    '# 根因',
    '示例根因。',
    '',
    '# 当前修复方案',
    '示例修复方案。',
    '',
    '# 需人工判断项',
    '- 无',
    '',
    '# 验证证据',
    '仅只读预检。',
    '',
    '# 审核记录',
    '无。',
  ];

  return [
    '---',
    `schema_version: ${String(base.schemaVersion)}`,
    `finding_id: ${JSON.stringify(base.findingId)}`,
    `title: ${JSON.stringify(base.title)}`,
    `module: ${base.module}`,
    `audit_type: ${base.auditType}`,
    `issue_kind: ${base.issueKind}`,
    `depends_on: ${base.dependsOn}`,
    `priority: ${base.priority}`,
    `base_revision: ${normalizedBaseRev}`,
    `created_at: ${JSON.stringify(base.createdAt)}`,
    `updated_at: ${JSON.stringify(base.updatedAt)}`,
    `owner: ${base.owner}`,
    `tags: ${base.tags}`,
    `ticket: ${base.ticket}`,
    `status: ${base.status}`,
    `target_files: ${base.targetFiles}`,
    `record_revision: ${String(base.recordRevision)}`,
    patchesBlock,
    optionsBlock,
    `observations:${String(base.observations).startsWith('\n') ? '' : ' '}${base.observations}`,
    `decisions:${String(base.decisions).startsWith('\n') ? '' : ' '}${base.decisions}`,
    `repair_attempts:${String(base.repairAttempts).startsWith('\n') ? '' : ' '}${base.repairAttempts}`,
    `comments:${String(base.comments).startsWith('\n') ? '' : ' '}${base.comments}`,
    `human_decisions: ${base.humanDecisions}`,
    `approval: ${base.approval}`,
    `approval_history:${String(base.approvalHistory).startsWith('\n') ? '' : ' '}${base.approvalHistory}`,
    `rejection: ${base.rejection}`,
    `commit_message: ${base.commitMessage === null || base.commitMessage === 'null' ? 'null' : JSON.stringify(base.commitMessage)}`,
    ...base.extraLines,
    '---',
    '',
    ...bodyLines,
    '',
  ].join('\n');
}

export function humanDecisionsFixture(items) {
  return `[${items.map((item) => `{id: ${item.id}, question: ${JSON.stringify(item.question ?? '是否接受行为变化？')}}`).join(', ')}]`;
}

export function commentFixture(items) {
  return '\n' + items.map((item) => {
    const file = item.file ?? DEFAULT_PATCH_FILE;
    const line = item.line ?? 1;
    const isInline = file !== '' && line > 0;
    return [
      `  - id: ${item.id ?? 'c1'}`,
      `    revision: ${String(item.revision ?? 1)}`,
      ...(isInline ? [
        `    option_id: ${item.optionId ?? 'opt-a'}`,
        `    patch_id: ${String(item.patchId ?? 1)}`,
      ] : []),
      `    file: ${JSON.stringify(file)}`,
      `    line: ${String(line)}`,
      ...(isInline ? [`    side: ${item.side ?? 'RIGHT'}`] : []),
      ...(isInline && item.anchor ? [`    anchor: ${item.anchor}`] : []),
      `    author: ${item.author ?? 'tester'}`,
      `    content: ${JSON.stringify(item.content ?? '请解释原因')}`,
      `    status: ${item.status ?? 'unresolved'}`,
      `    created_at: "2026-11-01T10:05:00+08:00"`,
    ].join('\n');
  }).join('\n');
}

export async function writeCandidate(root, slug, options = {}) {
  const month = options.month ?? '2026-11';
  const dir = path.join(root, '.ai-review', month, slug);
  await mkdir(dir, { recursive: true });
  const patches = options.patches ?? (options.review?.issueKind && options.review.issueKind !== 'repair'
    ? []
    : [{ name: '001.patch', text: options.patchText ?? patchFixture() }]);
  for (const patch of patches) await writeFile(path.join(dir, patch.name), patch.text, 'utf8');
  const firstPatchText = patches[0]?.text ?? options.patchText ?? patchFixture();
  const reviewText = options.reviewText ?? reviewFixture(slug, { patchText: firstPatchText, ...(options.review ?? {}) });
  await writeFile(path.join(dir, 'review.md'), reviewText, 'utf8');
  return { id: `${month}/${slug}`, dir, reviewPath: path.join(dir, 'review.md'), month, slug };
}

export async function commitCandidate(root, slug, options = {}) {
  const info = await writeCandidate(root, slug, options);
  if (options.commit !== false) {
    runCommand('git', ['add', '-A', '.ai-review'], root);
    runCommand('git', ['commit', '-q', '-m', options.message ?? `fixture: ${slug}`], root);
  }
  return info;
}

export function guardFixture(id, overrides = {}) {
  return {
    id,
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    ...overrides,
  };
}

export async function assertInvariant(store, candidate, invariant, { expectError = true } = {}) {
  const errors = await store.validateFullCandidate(candidate);
  const hit = errors.some((error) => error.includes(invariant) || error.startsWith(`${invariant}:`));
  if (expectError && !hit) {
    throw new Error(`预期违反 ${invariant}，但校验结果未报告：\n${errors.join('\n') || '(无错误)'}`);
  }
  if (!expectError && hit) {
    throw new Error(`预期不违反 ${invariant}，但校验报告了错误：\n${errors.join('\n')}`);
  }
  return errors;
}
