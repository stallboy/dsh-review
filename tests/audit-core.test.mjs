import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeAuditTarget, previewAuditPrompt, resolveAuditTarget, runHeadlessPhasedAudit } from '../packages/dsh-plugin/dist/host/auditor.js';
import { parseAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createFakeDshCommand, createGitFixture, failAuditAgentPath, fakeAuditAgentPath, invalidCandidateAgentPath, reportOnlyAgentPath, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

async function seedReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
  runCommand('git', ['add', '.ai-review/reviewers.yml'], root);
  runCommand('git', ['commit', '-q', '-m', 'init reviewers'], root);
}

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

test('normalizeAuditTarget rejects .ai-review itself', () => {
  const root = path.resolve('D:/example/repo');
  assert.throws(() => normalizeAuditTarget(root, '.ai-review'), /\.ai-review/);
  assert.throws(() => normalizeAuditTarget(root, '.ai-review/audits'), /\.ai-review/);
});

test('resolveAuditTarget rejects non-existent relative paths', async () => {
  const root = await createGitFixture();
  await assert.rejects(resolveAuditTarget(root, 'does-not-exist'), /不存在/);
});

test('previewAuditPrompt includes scope, owner routing and existing negative memory', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, 'existing-rejected', {
    month: '2026-10',
    review: {
      baseRevision: JSON.stringify(base),
      status: 'rejected',
      rejection: '{rejected_by: tester, rejected_at: "2026-11-01T11:00:00Z", reason: "业务特意保留减法"}',
    },
  });
  runCommand('git', ['add', '.ai-review'], root);
  runCommand('git', ['commit', '-q', '-m', 'rejected history'], root);
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const preview = await previewAuditPrompt({
    store: new ReviewStore(root),
    vcs: createVcs('git', root),
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    owner: 'tester',
    targetPath: 'src',
    note: '重点检查边界条件',
    mode: 'headless',
    source: await GitHeadCandidateSource.create(root),
  });

  assert.equal(preview.baseRevision, head);
  assert.match(preview.reportPath, /^\.ai-review\/audits\/.+\/audit\.md$/);
  assert.match(preview.prompt, new RegExp(head));
  assert.match(preview.prompt, /重点检查边界条件/);
  assert.match(preview.prompt, /tester/);
  assert.match(preview.prompt, /业务特意保留减法/);
});

test('previewAuditPrompt session mode instructs orchestrator without allowing VCS commits', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const preview = await previewAuditPrompt({
    store: new ReviewStore(root),
    vcs: createVcs('git', root),
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    owner: 'tester',
    targetPath: '',
    note: '',
    mode: 'session',
    source: await GitHeadCandidateSource.create(root),
  });

  assert.match(preview.prompt, /session/);
  assert.match(preview.prompt, /runAuditStage/);
  assert.match(preview.prompt, /publishAuditArtifacts/);
});

async function runPhased(root, overrides = {}) {
  const vcs = createVcs('git', root);
  const base = await vcs.getCurrentBase();
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
  const auditId = '20261031-130000-repo';
  const lease = {
    auditId,
    root,
    targetPath: '',
    trigger: 'manual',
    baseRevision: base,
    owner: 'tester',
    createdAt: new Date().toISOString(),
    candidateIdsBefore: [],
    state: 'active',
  };
  const outcome = await runHeadlessPhasedAudit({
    store: new ReviewStore(root),
    vcs,
    settings,
    owner: 'tester',
    targetPath: '',
    note: '关注正确性',
    trigger: 'manual',
    lease,
    log: (line) => logs.push(line),
    candidateSource: await GitHeadCandidateSource.create(root),
  });
  return { outcome, logs, base };
}

test('runHeadlessPhasedAudit runs agent, verifies schema1 candidate, writes pure-index audit.md and commits', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const { outcome, base } = await runPhased(root);

  assert.equal(outcome.manual, false);
  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  assert.equal(outcome.baseRevision, base);
  assert.equal(outcome.created.length, 1);
  const created = outcome.created[0];
  assert.equal(created?.id, '2026-10/20261031-math-fix');
  assert.equal(created?.title, 'math: 修复加法实现');
  assert.equal(created?.owner, 'tester');
  assert.deepEqual(created?.errors, []);
  assert.ok(outcome.commitRevision);

  const committedAudit = runCommand('git', ['show', `HEAD:${outcome.report.path}`], root).stdout;
  const { meta } = parseAuditMarkdown(committedAudit);
  assert.equal(meta.schemaVersion, 1);
  assert.deepEqual(meta.issues, ['2026-10/20261031-math-fix']);
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('runHeadlessPhasedAudit runs through the DSH headless branch', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const dshCommand = await createFakeDshCommand();
  const { outcome, logs } = await runPhased(root, { runner: 'dsh', dshCommand, externalCommand: '' });

  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  assert.equal(outcome.created.length, 1);
  assert.equal(outcome.created[0]?.errors.length, 0);
  assert.ok(logs.some((line) => line.includes('--profile headless')));
});

test('an audit with report only commits the pure-index audit.md and no candidates', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const { outcome } = await runPhased(root, {
    externalCommand: `"${process.execPath}" "${reportOnlyAgentPath()}"`,
  });

  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  assert.equal(outcome.created.length, 0);
  assert.ok(outcome.report?.path.endsWith('/audit.md'));
  assert.ok(outcome.commitRevision);
});

test('an audit with invalid candidate fails validation and does not commit invalid data', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { outcome } = await runPhased(root, {
    externalCommand: `"${process.execPath}" "${invalidCandidateAgentPath()}"`,
  });

  assert.equal(outcome.status, 'VALIDATION_FAILED', JSON.stringify(outcome));
  assert.equal(outcome.commitRevision, null);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
});

test('runHeadlessPhasedAudit manual mode returns prompt without committing', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const { outcome } = await runPhased(root, { runner: 'manual', externalCommand: '' });

  assert.equal(outcome.manual, true);
  assert.equal(outcome.status, 'MANUAL_REQUIRED');
  assert.ok(outcome.prompt && outcome.prompt.length > 0);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
});

test('audit start refuses dirty workspace and failed runner does not commit', async () => {
  const root = await createGitFixture();
  await seedReviewers(root);
  const before = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');

  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', externalCommand: `"${process.execPath}" "${failAuditAgentPath()}"` },
    saveSettings: async (v) => v,
    statePath: path.join(root, '.tmp', 'state.json'),
  });
  await api.init();
  const dirtyRes = await api.invoke({ method: 'POST', path: '/audit', body: {} });
  assert.equal(dirtyRes.status, 409);

  runCommand('git', ['checkout', '--', 'src/math.js'], root);
  const { outcome } = await runPhased(root, {
    externalCommand: `"${process.execPath}" "${failAuditAgentPath()}"`,
  });
  assert.equal(outcome.status, 'ABORTED', JSON.stringify(outcome));
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
});
