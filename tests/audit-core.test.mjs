import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAuditPrompt, normalizeAuditTarget, parseAuditReport, Auditor } from '../dist/auditor.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { ReviewStore } from '../dist/store.js';
import { createVcs } from '../dist/vcs.js';
import { createFakeDshCommand, createGitFixture, failAuditAgentPath, fakeAuditAgentPath, invalidCandidateAgentPath, reportOnlyAgentPath, runCommand } from './helpers.mjs';

test('normalizeAuditTarget maps a relative directory into the repository', () => {
  const root = path.resolve('D:/example/repo');
  const result = normalizeAuditTarget(root, ' src\\lib/ ');
  assert.equal(result.targetPath, 'src/lib');
  assert.equal(path.normalize(result.absolutePath), path.normalize(path.join(root, 'src', 'lib')));
});

test('normalizeAuditTarget treats an empty value as the whole repository', () => {
  const root = path.resolve('D:/example/repo');
  const result = normalizeAuditTarget(root, '   ');
  assert.equal(result.targetPath, '');
  assert.equal(path.normalize(result.absolutePath), path.normalize(root));
});

test('normalizeAuditTarget rejects paths outside the repository', () => {
  const root = path.resolve('D:/example/repo');
  assert.throws(() => normalizeAuditTarget(root, '../outside'), /越界|仓库/);
  assert.throws(() => normalizeAuditTarget(root, path.resolve(root, '..', 'outside')), /越界|仓库/);
});

test('parseAuditReport collects B-class confirmation and deferred items', () => {
  const text = [
    '# 仓库审查报告',
    '',
    '## A 类：已生成候选',
    '- .ai-review/2026-10/a：修复 A',
    '',
    '## B 类：需人工确认（未改代码）',
    '- **公开 API 语义**：会改变异常输入下的返回。',
    '- **跨模块拆分**：需要产品确认边界。',
    '',
    '## 待前置合入后处理（Deferred）',
    '- **缓存层重构**：依赖 A 先合入。',
    '',
    '## 验证与说明',
    '- 通过。',
  ].join('\n');
  const parsed = parseAuditReport(text);
  assert.equal(parsed.deferred.length, 3);
  assert.deepEqual(parsed.deferred.map((item) => item.category), ['confirm', 'confirm', 'deferred']);
  assert.equal(parsed.deferred[0]?.label, '公开 API 语义');
  assert.match(parsed.deferred[0]?.text ?? '', /异常输入/);
  assert.equal(parsed.deferred[2]?.label, '缓存层重构');
});

test('parseAuditReport returns no items when the report has no B-class section', () => {
  const parsed = parseAuditReport('# 仓库审查报告\n\n## A 类：已生成候选\n- 无\n');
  assert.deepEqual(parsed.deferred, []);
});

test('parseAuditReport ignores explicit "无" placeholders', () => {
  const text = [
    '## B 类：需人工确认（未改代码）',
    '- 无',
    '## 待前置合入后处理（Deferred）',
    '- 无（本轮没有强依赖项）',
  ].join('\n');
  assert.deepEqual(parseAuditReport(text).deferred, []);
});

test('parseAuditReport ignores headings and bullets inside fenced code', () => {
  const text = [
    '## 验证与说明',
    '```markdown',
    '## B 类：需人工确认（未改代码）',
    '- **假条目**：这是示例，不是真实 B 类。',
    '```',
  ].join('\n');
  assert.deepEqual(parseAuditReport(text).deferred, []);
});

test('buildAuditPrompt includes scope, owner routing and existing candidates', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await mkdir(path.join(root, '.ai-review', '2026-10', 'existing'), { recursive: true });
  await writeFile(
    path.join(root, '.ai-review', 'reviewers.yml'),
    'default_owner: tester\nrules: []\n',
    'utf8',
  );
  await writeFile(
    path.join(root, '.ai-review', '2026-10', 'existing', '001.patch'),
    'diff --git a/src/math.js b/src/math.js\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n',
    'utf8',
  );
  await writeFile(
    path.join(root, '.ai-review', '2026-10', 'existing', 'review.md'),
    `---
schema_version: 1
title: "existing: 已有候选"
created_at: "2026-10-31T20:00:00+08:00"
owner: tester
tags: [math]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "${base}"
    patch: "001.patch"
gate_checks:
  - "node --version"
comments: []
approval: null
---

# 问题与影响
已有候选。

# 人工判断
- 无：已有。
`,
    'utf8',
  );

  const prompt = await buildAuditPrompt({
    repoRoot: root,
    vcsType: 'git',
    owner: 'tester',
    targetPath: 'src',
    note: '重点检查边界条件',
    baseRevision: base,
    reportPath: '.ai-review/audits/20261031-210000-src.md',
    now: new Date('2026-10-31T21:00:00+08:00'),
  });

  assert.match(prompt, /仓库根目录/);
  assert.match(prompt, new RegExp(base));
  assert.match(prompt, /审查目标.*src/);
  assert.match(prompt, /重点检查边界条件/);
  assert.match(prompt, /default_owner: tester/);
  assert.match(prompt, /existing: 已有候选/);
  assert.match(prompt, /\.ai-review\/audits\/20261031-210000-src\.md/);
  assert.match(prompt, /A 类/);
  assert.match(prompt, /B 类/);
  assert.match(prompt, /正交|独立地基于/);
  assert.match(prompt, /严禁执行 `git commit`/);
});

test('buildAuditPrompt session mode tells the agent to commit only .ai-review', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const prompt = await buildAuditPrompt({
    repoRoot: root,
    vcsType: 'git',
    owner: 'tester',
    targetPath: '',
    note: '',
    baseRevision: base,
    reportPath: '.ai-review/audits/20261031-220000-repo.md',
    mode: 'session',
    now: new Date('2026-10-31T22:00:00+08:00'),
  });

  assert.match(prompt, /会话执行方式/);
  assert.match(prompt, /侧边栏/);
  assert.match(prompt, /只提交 `\.ai-review`/);
  assert.doesNotMatch(prompt, /严禁执行 `git commit`/);
});

function auditorFor(root, overrides = {}) {
  const settings = {
    ...DEFAULT_SETTINGS,
    repoRoot: root,
    owner: 'tester',
    vcsType: 'git',
    runner: 'external',
    externalCommand: `"${process.execPath}" "${fakeAuditAgentPath()}"`,
    ...overrides,
  };
  const logs = [];
  const auditor = new Auditor({
    store: new ReviewStore(root),
    vcs: createVcs('git', root),
    settings,
    owner: 'tester',
    targetPath: '',
    note: '关注正确性',
    log: (line) => logs.push(line),
  });
  return { auditor, logs };
}

test('Auditor runs an agent, verifies candidates, writes report and commits .ai-review', async () => {
  const root = await createGitFixture();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { auditor, logs } = auditorFor(root);

  const outcome = await auditor.run();

  assert.equal(outcome.manual, false);
  assert.equal(outcome.baseRevision, base);
  assert.equal(outcome.created.length, 1);
  const created = outcome.created[0];
  assert.equal(created?.id, '2026-10/20261031-math-fix');
  assert.equal(created?.title, 'math: 修复加法实现');
  assert.equal(created?.owner, 'tester');
  assert.deepEqual(created?.errors, []);
  assert.equal(created?.patchStats.additions, 1);
  assert.equal(created?.patchStats.deletions, 1);

  assert.equal(outcome.deferred.length, 2);
  assert.equal(outcome.deferred[0]?.category, 'confirm');
  assert.equal(outcome.deferred[1]?.category, 'deferred');

  assert.ok(outcome.report);
  assert.match(outcome.report.path, /^\.ai-review\/audits\/.+\.md$/);
  assert.match(outcome.report.text, /插件复核/);
  assert.match(outcome.report.text, /20261031-math-fix/);
  assert.ok(outcome.commitRevision);

  const reviewers = await readFile(path.join(root, '.ai-review', 'reviewers.yml'), 'utf8');
  assert.match(reviewers, /default_owner: "?tester"?/);
  const head = runCommand('git', ['show', '--name-only', '--format=%s', 'HEAD'], root).stdout;
  assert.match(head, /audit\(/);
  assert.match(head, /\.ai-review\/audits\//);
  assert.match(head, /20261031-math-fix\/review\.md/);
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
  assert.ok(logs.some((line) => /新增候选/.test(line)));
});

test('Auditor runs through the DSH headless branch', async () => {
  const root = await createGitFixture();
  const dshCommand = await createFakeDshCommand();
  const { auditor, logs } = auditorFor(root, { runner: 'dsh', dshCommand, externalCommand: '' });

  const outcome = await auditor.run();

  assert.equal(outcome.created.length, 1);
  assert.equal(outcome.created[0]?.errors.length, 0);
  assert.ok(logs.some((line) => line.includes('--profile headless')));
  assert.ok(logs.some((line) => line.includes('状态: done')));
});

test('an audit with only B-class findings commits the report and no candidate', async () => {
  const root = await createGitFixture();
  const { auditor } = auditorFor(root, {
    externalCommand: `"${process.execPath}" "${reportOnlyAgentPath()}"`,
  });

  const outcome = await auditor.run();

  assert.equal(outcome.created.length, 0);
  assert.equal(outcome.deferred.length, 1);
  assert.equal(outcome.deferred[0]?.category, 'confirm');
  assert.ok(outcome.report?.path.endsWith('.md'));
  assert.ok(outcome.commitRevision);
  const head = runCommand('git', ['show', '--format=%s', '--name-only', 'HEAD'], root).stdout;
  assert.match(head, /仅报告/);
  assert.match(head, /\.ai-review\/audits\//);
});

test('an audit surfaces validation errors on an invalid candidate', async () => {
  const root = await createGitFixture();
  const { auditor } = auditorFor(root, {
    externalCommand: `"${process.execPath}" "${invalidCandidateAgentPath()}"`,
  });

  const outcome = await auditor.run();

  assert.equal(outcome.created.length, 1);
  const errors = outcome.created[0]?.errors ?? [];
  assert.ok(errors.some((error) => /gate_checks/.test(error)), errors.join('；'));
  assert.ok(errors.some((error) => /需人工判断项/.test(error)), errors.join('；'));
  assert.ok(outcome.commitRevision);
});

test('Auditor manual mode returns a prompt and leaves the repository untouched', async () => {
  const root = await createGitFixture();
  const { auditor } = auditorFor(root, { runner: 'manual', externalCommand: '' });

  const outcome = await auditor.run();

  assert.equal(outcome.manual, true);
  assert.match(outcome.prompt ?? '', /审查报告文件/);
  await assert.rejects(stat(path.join(root, '.ai-review')), /ENOENT/);
});

test('Auditor refuses to run on a dirty workspace', async () => {
  const root = await createGitFixture();
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  const { auditor } = auditorFor(root);

  await assert.rejects(auditor.run(), /工作区/);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
});

test('a failed audit with no candidates does not create a commit', async () => {
  const root = await createGitFixture();
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { auditor } = auditorFor(root, {
    externalCommand: `"${process.execPath}" "${failAuditAgentPath()}"`,
  });

  await assert.rejects(auditor.run(), /外部命令退出码 1/);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
});
