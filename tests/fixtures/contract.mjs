import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../helpers.mjs';

/**
 * 契约夹具库（架构改进 A8）。
 *
 * 历史问题：24 个测试文件各自手写 review.md / 补丁夹具，SPEC 一变就要逐文件改，
 * 而“顺手放宽断言”很容易在改动中发生（缺陷 B4 就是这样删掉了 Rebase 的拒绝断言）。
 *
 * 设计原则：
 * - 只描述**差异维度**（状态、版本、判断项、评论、锚点…），公共形状由本文件提供；
 * - 每个夹具都可通过 `commit()` 固化进共享事实，避免“本地草稿”与“共享候选”混淆；
 * - 断言侧提供 `assertInvariant`，让 I1–I16 的正反例可以数据驱动。
 */

const DEFAULT_PATCH_FILE = 'src/math.js';

/** 单文件补丁：把 `-` 改成给定运算符。 */
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

/** 删除文件的补丁（用于 anchor / 禁止路径等边界用例）。 */
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

/** 新建文件的补丁。 */
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

/** 多文件补丁：同时改两个文件（用于 Hunk 解析与 I5）。 */
export function multiFilePatchFixture(files) {
  return files.map((file) => patchFixture({ file })).join('');
}

/**
 * review.md 夹具。默认是一个合法的 pending 候选（rev1、无评论、无判断项）。
 * `overrides` 直接覆盖字段片段，便于构造非法/边界数据。
 */
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
    `comments: ${base.comments}`,
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

/** 人工判断项 YAML 片段。 */
export function humanDecisionsFixture(items) {
  return `[${items.map((item) => `{id: ${item.id}, question: ${JSON.stringify(item.question ?? '是否接受行为变化？')}}`).join(', ')}]`;
}

/** 行内评论 YAML 片段。 */
export function commentFixture(items) {
  return items.map((item) => [
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

/**
 * 在仓库中写入一个候选目录（默认不提交）。返回目录与路径信息。
 */
export async function writeCandidate(root, slug, options = {}) {
  const month = options.month ?? '2026-11';
  const dir = path.join(root, '.ai-review', month, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), options.reviewText ?? reviewFixture(slug, options.review ?? {}), 'utf8');
  const patches = options.patches ?? [{ name: '001.patch', text: options.patchText ?? patchFixture() }];
  for (const patch of patches) await writeFile(path.join(dir, patch.name), patch.text, 'utf8');
  return { id: `${month}/${slug}`, dir, reviewPath: path.join(dir, 'review.md'), month, slug };
}

/** 把候选写入并提交为共享事实。 */
export async function commitCandidate(root, slug, options = {}) {
  const info = await writeCandidate(root, slug, options);
  if (options.commit !== false) {
    runCommand('git', ['add', '-A', '.ai-review'], root);
    runCommand('git', ['commit', '-q', '-m', options.message ?? `fixture: ${slug}`], root);
  }
  return info;
}

/** 标准并发 guard。 */
export function guardFixture(id, overrides = {}) {
  return {
    id,
    expectedRevision: 1,
    expectedOwner: 'tester',
    expectedUpdatedAt: '2026-11-01T10:00:00+08:00',
    ...overrides,
  };
}

/**
 * 不变量断言辅助：把候选交给实现的校验器，断言错误中包含/不包含指定编号。
 * 让 AC-DATA-01 的正反例可以数据驱动，而不是每个测试重写一套断言。
 */
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
