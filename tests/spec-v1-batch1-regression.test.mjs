import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAuditMarkdown, serializeAuditMarkdown, upsertAuditVerificationBlock } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { parseReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { JobManager } from '../packages/dsh-plugin/dist/host/jobs.js';
import { anchorFromPatch, isAiReviewPath, isRepoRelativePath, parsePatch } from '../packages/dsh-plugin/dist/host/patch.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { reviewFixture, writeCandidate } from './fixtures/contract.mjs';

test('Batch 1: parsePatch 按 hunk 行数追踪多文件纯 Unified Diff，禁止将第二个文件藏入第一个 hunk', () => {
  const diff = [
    '--- a/src/ok.ts',
    '+++ b/src/ok.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '--- a/.ai-review/evil.md',
    '+++ b/.ai-review/evil.md',
    '@@ -0,0 +1,1 @@',
    '+injected',
    '',
  ].join('\n');
  const parsed = parsePatch(diff);
  assert.deepEqual(parsed.paths, ['src/ok.ts', '.ai-review/evil.md']);
  assert.equal(parsed.paths.some(isAiReviewPath), true);
});

test('Batch 1: parsePatch 解析混合引号 diff --git 头与 SVN svn:special 符号链接属性', () => {
  const mixedQuoted = [
    'diff --git a/src/plain.ts "b/src/with space.ts"',
    '--- a/src/plain.ts',
    '+++ "b/src/with space.ts"',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const parsedQuoted = parsePatch(mixedQuoted);
  assert.deepEqual(parsedQuoted.paths, ['src/plain.ts', 'src/with space.ts']);

  const svnSpecial = [
    'Index: link.txt',
    '===================================================================',
    '--- link.txt\t(nonexistent)',
    '+++ link.txt\t(working copy)',
    '@@ -0,0 +1 @@',
    '+link /etc/passwd',
    'Property changes on: link.txt',
    '___________________________________________________________________',
    'Added: svn:special',
    '## -0,0 +1 ##',
    '+*',
    '',
  ].join('\n');
  const parsedSvn = parsePatch(svnSpecial);
  assert.equal(parsedSvn.paths.includes('link.txt'), true);
  assert.equal(parsedSvn.unsafeModes.some((entry) => entry.includes('svn:special')), true);
});

test('Batch 1: isRepoRelativePath 与 isAiReviewPath 严格路径段与大小写校验', () => {
  assert.equal(isRepoRelativePath('src/v1..v2.ts'), true);
  assert.equal(isRepoRelativePath('src/a.ts'), true);
  assert.equal(isRepoRelativePath('.'), false);
  assert.equal(isRepoRelativePath('src/./a.ts'), false);
  assert.equal(isRepoRelativePath('src/../a.ts'), false);
  assert.equal(isRepoRelativePath('C:/secret.txt'), false);
  assert.equal(isRepoRelativePath('src//a.ts'), false);
  assert.equal(isRepoRelativePath('src/a\0b.ts'), false);

  assert.equal(isAiReviewPath('.AI-REVIEW/2026-11/x/review.md'), true);
  assert.equal(isAiReviewPath('.TMP/scratch.txt'), true);
  assert.equal(isAiReviewPath('NODE_MODULES/pkg/index.js'), true);
  assert.equal(isAiReviewPath('nested/.GIT/config'), true);
  assert.equal(isAiReviewPath('nested/.SVN/wc.db'), true);
  assert.equal(isAiReviewPath('src/app.ts'), false);
});

test('Batch 1: anchorFromPatch 正确处理删除文件 LEFT 锚点、hunk 内 ---/+++ 文本与跨 hunk 隔离', () => {
  const diff = [
    'diff --git a/src/del.ts b/src/del.ts',
    'deleted file mode 100644',
    '--- a/src/del.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-const first = 1;',
    '---- not a file header',
    '-const third = 3;',
    '@@ -20,1 +0,0 @@',
    '-const far = 20;',
    '',
  ].join('\n');

  const line2 = anchorFromPatch(diff, 'src/del.ts', 2, 'LEFT');
  assert.ok(line2);
  assert.equal(line2.snippet, '--- not a file header');
  assert.equal(line2.before, 'const first = 1;');
  assert.equal(line2.after, 'const third = 3;');

  const line20 = anchorFromPatch(diff, 'src/del.ts', 20, 'LEFT');
  assert.ok(line20);
  assert.equal(line20.snippet, 'const far = 20;');
  assert.equal(line20.before, undefined);
});

test('Batch 1: parseAuditMarkdown 拒绝无时区 created_at，upsertAuditVerificationBlock 不展开 $& 替换串', () => {
  const validMd = serializeAuditMarkdown({
    schemaVersion: 1,
    auditId: '20261127-100000-test',
    createdAt: '2026-11-27T10:00:00Z',
    trigger: 'manual',
    scope: '.',
    baseRevision: 'abc1234',
    previousAudit: null,
    issues: [],
  }, '# 审查报告\n');

  const noTz = validMd.replace('2026-11-27T10:00:00Z', '2026-11-27T10:00:00');
  assert.throws(() => parseAuditMarkdown(noTz), /created_at/);

  const first = upsertAuditVerificationBlock(validMd, 'initial');
  const updated = upsertAuditVerificationBlock(first, 'token $& and $1');
  assert.equal(updated.includes('token $& and $1'), true);
  assert.equal(updated.includes('initial'), false);
});

test('Batch 1: invariants 校验 I8 rejected↔decisions 同步、退役 option_id 与标题非空', () => {
  const parsed = parseReviewMarkdown(reviewFixture('sample'));
  const makeCandidate = (meta) => ({
    id: '2026-11/sample',
    month: '2026-11',
    slug: 'sample',
    dirPath: '/tmp/2026-11/sample',
    reviewPath: '/tmp/2026-11/sample/review.md',
    meta,
    sections: parsed.sections,
    rawBody: parsed.rawBody,
  });
  const baseMeta = parsed.meta;

  // 1) rejected 状态缺少 accept_as_is 决策应报错
  const rejectedNoDecision = makeCandidate({
    ...baseMeta,
    status: 'rejected',
    rejection: {
      reason: 'not needed',
      rejectedBy: 'tester',
      rejectedAt: '2026-11-02T10:00:00+08:00',
      fingerprints: ['fp-1'],
    },
    decisions: [],
  });
  assert.equal(
    quickReviewInvariants(rejectedNoDecision).some((err) => err.includes('accept_as_is')),
    true,
  );

  // 2) 同基线被重新观察激活的合法方案不应被误判为退役 option_id
  const sameBaseReopened = makeCandidate({
    ...baseMeta,
    observations: [
      {
        auditId: '20261125-000000-a',
        baseRevision: '1',
        at: '2026-11-25T00:00:00Z',
        verdict: 'confirmed',
        reason: 'first',
        evidence: [{ path: 'src/math.js', line: 1, excerpt: 'export const add', reason: 'wrong operator' }],
      },
      {
        auditId: '20261126-000000-b',
        baseRevision: '1',
        at: '2026-11-26T00:00:00Z',
        verdict: 'confirmed',
        reason: 'second',
        evidence: [{ path: 'src/math.js', line: 1, excerpt: 'export const add', reason: 'still wrong' }],
      },
    ],
  });
  assert.deepEqual(quickReviewInvariants(sameBaseReopened), []);

  // 3) 历史已批准过的 option_id 不得再复用
  const reusedApproved = makeCandidate({
    ...baseMeta,
    approvalHistory: [{
      approvedBy: 'tester',
      approvedAt: '2026-11-25T00:00:00Z',
      recordRevision: 1,
      optionId: baseMeta.options[0].id,
      patchId: 1,
      patchSha256: baseMeta.patches[0].sha256,
      repairAttemptId: 1,
      baseRevision: '1',
      confirmedDecisions: [],
      waivedDecisions: [],
      gateChecks: ['node --version'],
      gateResults: [{ command: 'node --version', exitCode: 0, durationMs: 10 }],
      commitMessage: 'net: sample',
      businessCommit: 'bbb2222',
    }],
  });
  assert.equal(
    quickReviewInvariants(reusedApproved).some((err) => err.includes('退役')),
    true,
  );

  // 4) 仅含 "<module>: " 而无正文标题应报错
  const emptyTitleBody = makeCandidate({ ...baseMeta, module: 'core', title: 'core:   ' });
  assert.equal(
    quickReviewInvariants(emptyTitleBody).some((err) => err.includes('标题') || err.includes('不能为空')),
    true,
  );
});

test('Batch 1: store.get 传播全仓 duplicate finding_id 与 local 标记，写入口拒绝损坏/本地脏候选与非法行内评论路径', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'dsh-batch1-store-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'math.js'), 'export const add = (a, b) => a - b;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const first = await writeCandidate(repo, 'dup-one', { review: { findingId: 'shared-dup-id', baseRevision: base } });
    const second = await writeCandidate(repo, 'dup-two', { review: { findingId: 'shared-dup-id', baseRevision: base } });
    execFileSync('git', ['add', '.ai-review'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add dup issues'], { cwd: repo, stdio: 'ignore' });

    const store = new ReviewStore(repo);
    const source = await GitHeadCandidateSource.create(repo);
    const dupDetail = await store.get(first.id, base, source);
    assert.match(dupDetail.candidate.parseError ?? '', /重复/);

    const guard = {
      expectedRevision: dupDetail.candidate.meta.recordRevision,
      expectedOwner: dupDetail.candidate.meta.owner,
      expectedUpdatedAt: dupDetail.candidate.meta.updatedAt,
    };
    await assert.rejects(
      () => store.addComment(first.id, guard, { author: 'tester', content: 'hi' }, source),
      /重复|损坏/,
    );

    // 删除第二个重复项，恢复合法共享候选，验证非法行内评论路径与 local 写拦截
    await rm(second.dir, { recursive: true, force: true });
    execFileSync('git', ['add', '-A', '.ai-review'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'remove dup'], { cwd: repo, stdio: 'ignore' });

    const cleanSource = await GitHeadCandidateSource.create(repo);
    const okDetail = await store.get(first.id, base, cleanSource);
    assert.equal(okDetail.candidate.parseError, undefined);
    assert.equal(Boolean(okDetail.local), false);

    // 行内评论 file 含非法穿越必须拒绝
    await assert.rejects(
      () => store.addComment(first.id, guard, {
        author: 'tester',
        content: 'bad path',
        optionId: 'opt-a',
        patchId: 1,
        file: '../secret.ts',
        line: 1,
        side: 'RIGHT',
      }, cleanSource),
      /file 含非法或禁止路径/,
    );

    // 制造未提交的本地脏改动后，共享写入口必须拒绝覆盖
    await writeFile(first.reviewPath, 'dirty local edit\n', 'utf8');
    const dirtySource = await GitHeadCandidateSource.create(repo);
    const dirtyDetail = await store.get(first.id, base, dirtySource);
    assert.equal(dirtyDetail.local, true);
    await assert.rejects(
      () => store.addComment(first.id, guard, { author: 'tester', content: 'blocked' }, dirtySource),
      /未提交本地改动/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('Batch 1: JobManager getIncremental 拒绝 NaN since', async () => {
  const manager = new JobManager();
  const job = manager.start('audit', async (ctx) => {
    ctx.log('line-1');
    ctx.log('line-2');
    return { ok: true };
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const res = manager.getIncremental(job.id, Number.NaN);
  assert.ok(res);
  assert.equal(res.log.length, 2);
  assert.equal(res.logResetRequired, false);
});
