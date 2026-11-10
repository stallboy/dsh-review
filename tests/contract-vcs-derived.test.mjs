import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVcs } from '../dist/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';

function canRun(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

const hasSvn = canRun('svn') && canRun('svnadmin');

const CANDIDATE_DIR_REL = '.ai-review/2026-11/20261110-derive';
const REVIEW_REL = `${CANDIDATE_DIR_REL}/review.md`;
const PATCH_REL = `${CANDIDATE_DIR_REL}/001.patch`;
const BUSINESS_REL = 'src/math.js';

/** 满足 parseReviewMarkdown 的最小 review.md；approved 时带非空 approval 快照。 */
function reviewMarkdown(status) {
  const approved = status === 'approved';
  return [
    '---',
    'schema_version: 1',
    'title: "net: derive"',
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-05T09:00:00+08:00"',
    'updated_at: "2026-11-05T09:00:00+08:00"',
    'owner: tester',
    'tags: []',
    `status: ${status}`,
    'ticket: null',
    `target_files: [${BUSINESS_REL}]`,
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    'gate_checks: []',
    'comments: []',
    'human_decisions: []',
    ...(approved
      ? ['approval:', '  approved_by: tester', '  approved_at: "2026-11-05T10:00:00+08:00"']
      : ['approval: null']),
    'rejection: null',
    'commit_message: "net: derive"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n');
}

async function writeRepoFile(root, relPath, text) {
  const absolute = path.join(root, ...relPath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
}

/** 自建本地 SVN 仓库 + 工作副本（TortoiseSVN 1.14 真机）。 */
async function createSvnFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-svn-derived-'));
  const repo = path.join(base, 'repo');
  const wc = path.join(base, 'wc');
  runCommand('svnadmin', ['create', repo], base);
  const url = `file:///${repo.replaceAll('\\', '/')}`;
  runCommand('svn', ['--non-interactive', 'checkout', url, wc], base);
  return { base, repo, url, wc };
}

/** 审计提交：pending review.md + 补丁 + 业务文件，然后 update 固定工作副本根 revision。 */
async function seedSvnCandidate(root) {
  await writeRepoFile(root, REVIEW_REL, reviewMarkdown('pending'));
  await writeRepoFile(root, PATCH_REL, '--- a/src/math.js\n+++ b/src/math.js\n');
  await writeRepoFile(root, BUSINESS_REL, 'export const add = (a, b) => a - b;\n');
  runCommand('svn', ['--non-interactive', 'add', '--force', '.'], root);
  runCommand('svn', ['--non-interactive', 'commit', '-m', 'audit pending'], root);
  runCommand('svn', ['--non-interactive', 'update'], root);
}

test('SVN: getCommitProbe 随目标路径提交前进，getCurrentBase 保持根 revision 不变（H1）', { skip: !hasSvn }, async () => {
  const { wc } = await createSvnFixture();
  await seedSvnCandidate(wc);
  const vcs = createVcs('svn', wc);

  const baseBefore = await vcs.getCurrentBase();
  const probeBefore = await vcs.getCommitProbe([REVIEW_REL, PATCH_REL]);
  assert.ok(probeBefore !== null, '审计提交后的路径级探针必须可读');

  await writeRepoFile(wc, REVIEW_REL, reviewMarkdown('approved'));
  await writeRepoFile(wc, BUSINESS_REL, 'export const add = (a, b) => a + b;\n');
  // 生产批准同样把候选目录纳入提交路径，让 svn 把已调度的补丁删除一起提交。
  const commit = await vcs.atomicCommit({
    message: 'net: derive',
    paths: [REVIEW_REL, BUSINESS_REL, CANDIDATE_DIR_REL],
    deletePaths: [PATCH_REL],
  });
  assert.equal(commit.success, true, commit.errorOutput);

  const baseAfter = await vcs.getCurrentBase();
  const probeAfter = await vcs.getCommitProbe([REVIEW_REL, PATCH_REL]);
  // H1 根因：工作副本根 revision 不随子路径提交前进，不能充当提交探针。
  assert.equal(baseAfter, baseBefore, 'SVN 根 revision 不随子路径提交前进');
  assert.notEqual(probeAfter, probeBefore, '路径级探针必须随提交前进');
  assert.equal(probeAfter, commit.commitRevision);
});

test('SVN: readFileAt(probe) 读到已提交内容；out-of-date 失败提交后探针不变', { skip: !hasSvn }, async () => {
  const { base, url, wc } = await createSvnFixture();
  await seedSvnCandidate(wc);
  const vcs = createVcs('svn', wc);

  await writeRepoFile(wc, REVIEW_REL, reviewMarkdown('approved'));
  await writeRepoFile(wc, BUSINESS_REL, 'export const add = (a, b) => a + b;\n');
  const commit = await vcs.atomicCommit({ message: 'net: derive', paths: [REVIEW_REL, BUSINESS_REL] });
  assert.equal(commit.success, true, commit.errorOutput);
  assert.ok(commit.commitRevision !== null);

  const probeAfter = await vcs.getCommitProbe([REVIEW_REL]);
  assert.equal(probeAfter, commit.commitRevision);
  assert.equal(await vcs.readFileAt(probeAfter, REVIEW_REL), reviewMarkdown('approved'));

  // 第二个工作副本并发提交同一 review.md，使第一个工作副本的提交 out-of-date。
  const wc2 = path.join(base, 'wc2');
  runCommand('svn', ['--non-interactive', 'checkout', url, wc2], base);
  await writeRepoFile(wc2, REVIEW_REL, reviewMarkdown('approved').replace('approved_by: tester', 'approved_by: concurrent'));
  runCommand('svn', ['--non-interactive', 'commit', '-m', 'concurrent approve'], wc2);

  await writeRepoFile(wc, REVIEW_REL, reviewMarkdown('approved').replace('approved_at: "2026-11-05T10:00:00+08:00"', 'approved_at: "2026-11-05T11:00:00+08:00"'));
  const probeBeforeFailure = await vcs.getCommitProbe([REVIEW_REL]);
  const failed = await vcs.atomicCommit({ message: 'net: derive', paths: [REVIEW_REL] });
  assert.equal(failed.success, false, 'out-of-date 提交必须失败');
  assert.equal(failed.outOfDate, true, failed.errorOutput);
  // §5.6 分支 2 的前提：提交失败后探针未前进，证明提交不存在。
  assert.equal(await vcs.getCommitProbe([REVIEW_REL]), probeBeforeFailure);
});

test('SVN: approved review.md + 删除补丁的原子提交派生为 found 且 revision 正确', { skip: !hasSvn }, async () => {
  const { wc } = await createSvnFixture();
  await seedSvnCandidate(wc);
  const vcs = createVcs('svn', wc);

  await writeRepoFile(wc, REVIEW_REL, reviewMarkdown('approved'));
  await writeRepoFile(wc, BUSINESS_REL, 'export const add = (a, b) => a + b;\n');
  // 生产批准同样把候选目录纳入提交路径，让 svn 把已调度的补丁删除一起提交。
  const commit = await vcs.atomicCommit({
    message: 'net: derive',
    paths: [REVIEW_REL, BUSINESS_REL, CANDIDATE_DIR_REL],
    deletePaths: [PATCH_REL],
  });
  assert.equal(commit.success, true, commit.errorOutput);
  assert.match(commit.commitRevision ?? '', /^\d+$/);

  const derived = await vcs.deriveApprovalCommit({
    reviewPath: REVIEW_REL,
    patchPaths: [PATCH_REL],
    targetFiles: [BUSINESS_REL],
  });
  assert.equal(derived.lookup, 'found', derived.diagnostic);
  assert.equal(derived.revision, commit.commitRevision);
});

test('Git: 分支上删除补丁后 merge，deriveApprovalCommit 仍 found 且指向批准提交', async () => {
  const root = await createGitFixture();
  const mainBranch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout.trim();

  await writeRepoFile(root, REVIEW_REL, reviewMarkdown('pending'));
  await writeRepoFile(root, PATCH_REL, '--- a/src/math.js\n+++ b/src/math.js\n');
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'audit pending'], root);

  // 批准提交（approved review.md + 删除补丁 + 业务改动）在侧分支上。
  runCommand('git', ['checkout', '-q', '-b', 'feat'], root);
  await writeRepoFile(root, REVIEW_REL, reviewMarkdown('approved'));
  await writeRepoFile(root, BUSINESS_REL, 'export const add = (a, b) => a + b;\n');
  runCommand('git', ['rm', '-q', PATCH_REL], root);
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'net: derive'], root);
  const approvalCommit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // 主分支上制造无关提交，再 merge，使 merge 提交本身也“删除补丁”（相对第一个父）。
  runCommand('git', ['checkout', '-q', mainBranch], root);
  await writeRepoFile(root, 'docs.txt', 'docs\n');
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'unrelated main change'], root);
  runCommand('git', ['merge', '-q', '--no-ff', 'feat', '-m', 'merge feat'], root);
  const mergeCommit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const vcs = createVcs('git', root);
  const derived = await vcs.deriveApprovalCommit({
    reviewPath: REVIEW_REL,
    patchPaths: [PATCH_REL],
    targetFiles: [BUSINESS_REL],
  });
  // 去掉 --first-parent 后必须仍在历史中找到批准提交；merge 提交因父提交 approved 被条件 2 排除。
  assert.equal(derived.lookup, 'found', derived.diagnostic);
  assert.equal(derived.revision, approvalCommit);
  assert.notEqual(derived.revision, mergeCommit);
  assert.equal(await vcs.getCommitProbe([]), mergeCommit);
  assert.equal(await vcs.readFileAt(approvalCommit, REVIEW_REL), reviewMarkdown('approved'));
});
