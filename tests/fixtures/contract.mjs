import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../helpers.mjs';

/** 集中提供评审数据的公共形状，让各用例只需构造与断言相关的差异。 */

const DEFAULT_PATCH_FILE = 'src/math.js';

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
  const base = {
    schemaVersion: 1,
    title: `net: ${slug}`,
    module: 'net',
    auditType: 'bugfix',
    createdAt: '2026-11-01T10:00:00+08:00',
    updatedAt: '2026-11-01T10:00:00+08:00',
    owner: 'tester',
    tags: '[]',
    status: 'pending',
    ticket: 'null',
    targetFiles: `[${DEFAULT_PATCH_FILE}]`,
    currentRevision: 1,
    baseRevision: '"1"',
    patch: '001.patch',
    author: 'ai',
    gateChecks: '["node --version"]',
    comments: '[]',
    humanDecisions: '[]',
    approval: 'null',
    rejection: 'null',
    commitMessage: `net: ${slug}`,
    extraLines: [],
    ...overrides,
  };
  return [
    '---',
    `schema_version: ${String(base.schemaVersion)}`,
    `title: ${JSON.stringify(base.title)}`,
    `module: ${base.module}`,
    `audit_type: ${base.auditType}`,
    `created_at: ${JSON.stringify(base.createdAt)}`,
    `updated_at: ${JSON.stringify(base.updatedAt)}`,
    `owner: ${base.owner}`,
    `tags: ${base.tags}`,
    `status: ${base.status}`,
    `ticket: ${base.ticket}`,
    `target_files: ${base.targetFiles}`,
    `current_revision: ${String(base.currentRevision)}`,
    'revisions:',
    '  - id: 1',
    `    base_revision: ${base.baseRevision}`,
    `    patch: ${base.patch}`,
    `    author: ${base.author}`,
    `gate_checks: ${base.gateChecks}`,
    `comments:${base.comments.startsWith("\n") ? "" : " "}${base.comments}`,
    `human_decisions: ${base.humanDecisions}`,
    `approval: ${base.approval}`,
    `rejection: ${base.rejection}`,
    `commit_message: ${JSON.stringify(base.commitMessage)}`,
    ...base.extraLines,
    '---',
    '',
    '# 问题与影响',
    '',
    ...(overrides.bodyLines ?? []),
  ].join('\n');
}

export function humanDecisionsFixture(items) {
  return `[${items.map((item) => `{id: ${item.id}, question: ${JSON.stringify(item.question ?? '是否接受行为变化？')}}`).join(', ')}]`;
}

export function commentFixture(items) {
  return '\n' + items.map((item) => [
    `  - id: ${item.id ?? 'c1'}`,
    `    revision: ${String(item.revision ?? 1)}`,
    `    file: ${item.file ?? DEFAULT_PATCH_FILE}`,
    `    line: ${String(item.line ?? 1)}`,
    `    side: ${item.side ?? 'RIGHT'}`,
    ...(item.anchor ? [`    anchor: ${item.anchor}`] : []),
    `    author: ${item.author ?? 'tester'}`,
    `    content: ${JSON.stringify(item.content ?? '请解释原因')}`,
    `    status: ${item.status ?? 'unresolved'}`,
    `    created_at: "2026-11-01T10:05:00+08:00"`,
  ].join('\n')).join('\n');
}

export async function writeCandidate(root, slug, options = {}) {
  const month = options.month ?? '2026-11';
  const dir = path.join(root, '.ai-review', month, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), options.reviewText ?? reviewFixture(slug, options.review ?? {}), 'utf8');
  const patches = options.patches ?? [{ name: '001.patch', text: options.patchText ?? patchFixture() }];
  for (const patch of patches) await writeFile(path.join(dir, patch.name), patch.text, 'utf8');
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
