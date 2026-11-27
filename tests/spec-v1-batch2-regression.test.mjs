import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { runApprovalTransaction } from '../packages/dsh-plugin/dist/host/approval.js';
import { commitWithThreeBranchRecovery } from '../packages/dsh-plugin/dist/host/commit-recovery.js';
import { RepoRecoveryStore } from '../packages/dsh-plugin/dist/host/recovery-store.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { collectCommitEntries, GitAdapter, gitBlobHash } from '../packages/dsh-plugin/dist/host/vcs.js';
import { commitCandidate, patchFixture } from './fixtures/contract.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

test('Batch 2: RepoRecoveryStore 重启后将未完成 active_write 升级为 RECOVERY_REQUIRED 阻塞写操作，清理后解除', async t => {
  const root = await createGitFixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-b2-recovery-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const statePath = path.join(stateDir, 'runtime-state.json');
  const recoveryPath = path.join(stateDir, 'runtime-state-recovery.json');

  // 模拟崩溃前打开写入窗口未关闭
  const storeBeforeCrash = new RepoRecoveryStore(recoveryPath);
  await storeBeforeCrash.beginWriteWindow(root, {
    kind: 'approve',
    reason: 'APPROVAL_WRITE_IN_PROGRESS',
    detail: '模拟进程在提交窗口崩溃',
    candidateId: '2026-11/sample',
  });

  // 模拟进程重启：加载后自动升级为 recovery_required 并阻塞 repo_write
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
    saveSettings: async (v) => v,
    statePath,
  });
  await api.init();

  const blocked = await api.invoke({ method: 'POST', path: '/sync', body: {} });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.body.error.details.status, 'RECOVERY_REQUIRED');
  assert.equal(blocked.body.error.details.reason, 'COMMIT_OUTCOME_UNKNOWN');

  // 制造脏工作区时 /recovery/clear 必须拒绝解除
  await writeFile(path.join(root, 'src', 'math.js'), '// dirty\n', 'utf8');
  const clearDirty = await api.invoke({ method: 'POST', path: '/recovery/clear', body: {} });
  assert.equal(clearDirty.status, 409);

  // 人工恢复工作区干净后 /recovery/clear 成功解除阻塞
  runCommand('git', ['checkout', '--', 'src/math.js'], root);
  const clearOk = await api.invoke({ method: 'POST', path: '/recovery/clear', body: {} });
  assert.equal(clearOk.status, 200, JSON.stringify(clearOk));
  assert.equal(clearOk.body.cleared, true);

  const syncAfter = await api.invoke({ method: 'POST', path: '/sync', body: {} });
  assert.equal(syncAfter.status, 200);
});

test('Batch 2: commitWithThreeBranchRecovery 精确区分探针证实已提交、结果不明与证实未提交还原三分支', async t => {
  const root = await createGitFixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-b2-3branch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const vcs = new GitAdapter(root);
  const recoveryStore = new RepoRecoveryStore(path.join(stateDir, 'recovery.json'));

  // 分支 1：atomicCommit 抛错但探针变化且校验通过 -> 判 committed（绝不误还原）
  let restoreCalled = false;
  let probeSeq = 0;
  const fakeVcs1 = Object.assign(Object.create(Object.getPrototypeOf(vcs)), vcs, {
    getCommitProbe: async () => (probeSeq++ === 0 ? 'aaa' : 'bbb'),
  });
  const res1 = await commitWithThreeBranchRecovery({
    vcs: fakeVcs1,
    probePaths: ['src/math.js'],
    executeCommit: async () => { throw new Error('killed right after commit'); },
    verifyOnProbeChange: async (rev) => rev === 'bbb',
    restoreOnProvenNotCommitted: async () => { restoreCalled = true; },
    recoveryStore,
    recoveryContext: { repoRoot: root, kind: 'commit' },
  });
  assert.equal(res1.status, 'committed');
  assert.equal(res1.commitRevision, 'bbb');
  assert.equal(restoreCalled, false);
  assert.equal(recoveryStore.blockerFor(root), undefined);

  // 分支 3：命令明确非零失败且探针未变 -> 证明未提交，执行还原并返 failed_restored
  let restored3 = false;
  const fakeVcs3 = Object.assign(Object.create(Object.getPrototypeOf(vcs)), vcs, {
    getCommitProbe: async () => 'same-rev',
  });
  const res3 = await commitWithThreeBranchRecovery({
    vcs: fakeVcs3,
    probePaths: ['src/math.js'],
    executeCommit: async () => ({ success: false, commitRevision: null, outOfDate: true, errorOutput: 'lock conflict' }),
    verifyOnProbeChange: async () => false,
    restoreOnProvenNotCommitted: async () => { restored3 = true; },
    verifyRestored: async () => null,
    recoveryStore,
    recoveryContext: { repoRoot: root, kind: 'commit' },
  });
  assert.equal(res3.status, 'failed_restored');
  assert.equal(res3.outOfDate, true);
  assert.equal(restored3, true);
  assert.equal(recoveryStore.blockerFor(root), undefined);

  // 分支 2：探针不可读 -> 落盘持久化 RECOVERY_REQUIRED 阻塞
  const fakeVcs2 = Object.assign(Object.create(Object.getPrototypeOf(vcs)), vcs, {
    getCommitProbe: async () => null,
  });
  const res2 = await commitWithThreeBranchRecovery({
    vcs: fakeVcs2,
    probePaths: ['src/math.js'],
    executeCommit: async () => ({ success: false, commitRevision: null, outOfDate: false, errorOutput: 'unknown io error' }),
    verifyOnProbeChange: async () => false,
    restoreOnProvenNotCommitted: async () => {},
    recoveryStore,
    recoveryContext: { repoRoot: root, kind: 'commit' },
  });
  assert.equal(res2.status, 'recovery_required');
  assert.equal(res2.reason, 'COMMIT_OUTCOME_UNKNOWN');
  assert.ok(recoveryStore.blockerFor(root));
});

test('Batch 2: GitAdapter ensureCleanWorkspace 检测 .tmp/ 与 -z 重命名；computeInterRevisionDiff 隔离工作区磁盘补丁篡改', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const vcs = new GitAdapter(root);
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // .tmp/ 即使被 .gitignore 忽略也必须报脏
  await writeFile(path.join(root, '.gitignore'), '.tmp/\n', 'utf8');
  runCommand('git', ['add', '.gitignore'], root);
  runCommand('git', ['commit', '-qm', 'ignore tmp'], root);
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  await writeFile(path.join(root, '.tmp', 'leftover.txt'), 'scratch', 'utf8');
  const dirtyTmp = await vcs.ensureCleanWorkspace();
  assert.equal(dirtyTmp.clean, false);
  assert.equal(dirtyTmp.dirtyPaths.includes('.tmp'), true);
  await rm(path.join(root, '.tmp'), { recursive: true, force: true });
  assert.equal((await vcs.ensureCleanWorkspace()).clean, true);

  // computeInterRevisionDiff 必须使用入参共享补丁文本，忽略磁盘上被篡改的补丁路径
  const p1 = patchFixture({ to: 'export const add = (a, b) => a + b; // v1' });
  const p2 = patchFixture({ to: 'export const add = (a, b) => a + b; // v2' });
  const poisonedPath = path.join(root, 'poisoned.patch');
  await writeFile(poisonedPath, 'CORRUPT DISK PATCH\n', 'utf8');
  const diff = await vcs.computeInterRevisionDiff({
    fromRevision: 1,
    toRevision: 2,
    fromBase: base,
    toBase: base,
    fromPatchPath: poisonedPath,
    toPatchPath: poisonedPath,
    fromPatchText: p1,
    toPatchText: p2,
  });
  assert.equal(diff.resolutionMode, 'same_base_direct');
  assert.match(diff.unifiedDiff, /\/\/ v2/);
  await rm(poisonedPath, { force: true });
});

test('Batch 2: computeModeCNetChangedPaths 捕获多父合并借 U2 覆盖 U1 与工作区残留改动', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const vcs = new GitAdapter(root);
  const mainBranch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // 创建 U1（修改 src/extra.js）与 U2（未改 src/extra.js，改了另一个文件）
  runCommand('git', ['checkout', '-qb', 'u1', base], root);
  await writeFile(path.join(root, 'src', 'extra.js'), 'export const u1 = 1;\n', 'utf8');
  runCommand('git', ['add', 'src/extra.js'], root);
  runCommand('git', ['commit', '-qm', 'u1 adds extra'], root);
  const u1 = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  runCommand('git', ['checkout', '-qb', 'u2', base], root);
  await writeFile(path.join(root, 'src', 'other.js'), 'export const u2 = 2;\n', 'utf8');
  runCommand('git', ['add', 'src/other.js'], root);
  runCommand('git', ['commit', '-qm', 'u2 adds other'], root);
  const u2 = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  runCommand('git', ['checkout', '-q', mainBranch], root);
  const preHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // 合并 U1 和 U2，但偷偷删掉 U1 新增的 src/extra.js（使其与 U2 的不存在状态相同）
  runCommand('git', ['merge', '--no-ff', '--no-commit', 'u1', 'u2'], root);
  await rm(path.join(root, 'src', 'extra.js'), { force: true });
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-qm', 'octopus merge reverting u1'], root);
  const postHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  const topology = await vcs.computeModeCNetChangedPaths(preHead, postHead, [preHead, u1, u2]);
  assert.equal(topology.ok, true);
  // src/other.js 来自 U2 且 U1 未动 -> 纯继承不计入；src/extra.js 被删覆盖了 U1 -> 必须计入净改动！
  assert.equal(topology.netChangedPaths.includes('src/extra.js'), true, JSON.stringify(topology.netChangedPaths));
  assert.equal(topology.netChangedPaths.includes('src/other.js'), false, JSON.stringify(topology.netChangedPaths));
});

test('Batch 2: 批准步骤 8 门禁进程树未停止转 RECOVERY_REQUIRED；步骤 9 检测门禁期间本地 .ai-review 篡改', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261127-gate-guard', {
    review: { findingId: 'gate-guard', baseRevision: JSON.stringify(base), bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const vcs = new GitAdapter(root);
  const store = new ReviewStore(root);
  const detail = await store.get(candidate.id, base, await GitHeadCandidateSource.create(root));
  const guard = {
    expectedRevision: detail.candidate.meta.recordRevision,
    expectedOwner: detail.candidate.meta.owner,
    expectedUpdatedAt: detail.candidate.meta.updatedAt,
  };

  // 1) 门禁返回 processTreeStopped: false -> RECOVERY_REQUIRED / RESTORE_INCOMPLETE
  const resTree = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
      jobId: 'job-tree',
      log: () => {},
      sharedSource: () => GitHeadCandidateSource.create(root),
      runGates: async () => [{ command: 'node --version', exitCode: 1, durationMs: 10, passed: false, processTreeStopped: false }],
    },
    { id: candidate.id, guard, optionId: 'opt-a', patchId: 1, confirmedDecisions: [], waivedDecisions: [], actor: 'tester' },
  );
  assert.equal(resTree.status, 'RECOVERY_REQUIRED');
  assert.equal(resTree.reason, 'RESTORE_INCOMPLETE');
  // 清理第一步保留的现场
  await vcs.revertBusinessWorkspace();

  // 2) 门禁期间恶意篡改本地 .ai-review/review.md -> 步骤 9 拦截并还原，返 ABORTED / BUSINESS_CONTENT_CHANGED
  const originalReview = await readFile(candidate.reviewPath, 'utf8');
  const resTamper = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
      jobId: 'job-tamper',
      log: () => {},
      sharedSource: () => GitHeadCandidateSource.create(root),
      runGates: async () => {
        await writeFile(candidate.reviewPath, `${originalReview}\n# TAMPERED\n`, 'utf8');
        return [{ command: 'node --version', exitCode: 0, durationMs: 5, passed: true, processTreeStopped: true }];
      },
    },
    { id: candidate.id, guard, optionId: 'opt-a', patchId: 1, confirmedDecisions: [], waivedDecisions: [], actor: 'tester' },
  );
  assert.equal(resTamper.status, 'ABORTED', JSON.stringify(resTamper));
  assert.equal(resTamper.reason, 'BUSINESS_CONTENT_CHANGED');
  assert.equal(await readFile(candidate.reviewPath, 'utf8'), originalReview);
});

test('Batch 2: deriveApprovalCommit 拒绝不在当前祖先链中的伪造 business_commit', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const vcs = new GitAdapter(root);
  const mainBranch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
  const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  // 在未合并的侧分支制造一个提交
  runCommand('git', ['checkout', '-qb', 'orphan-side', base], root);
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  runCommand('git', ['add', 'src/math.js'], root);
  runCommand('git', ['commit', '-qm', 'unmerged fix'], root);
  const unmergedCommit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  runCommand('git', ['checkout', '-q', mainBranch], root);

  const sha = gitBlobHash(patchFixture());
  const lookup = await vcs.deriveApprovalCommit({
    reviewPath: '.ai-review/2026-11/sample/review.md',
    patchPaths: [],
    targetFiles: ['src/math.js'],
    approvedPatchPaths: ['src/math.js'],
    approval: {
      approvedBy: 'tester',
      approvedAt: '2026-11-27T00:00:00Z',
      recordRevision: 1,
      optionId: 'opt-a',
      patchId: 1,
      patchSha256: sha.padEnd(64, '0'),
      repairAttemptId: 1,
      baseRevision: base,
      gateChecks: ['node --version'],
      gateResults: [{ command: 'node --version', exitCode: 0, durationMs: 1 }],
      confirmedDecisions: [],
      waivedDecisions: [],
      businessCommit: unmergedCommit,
    },
  });
  assert.equal(lookup.lookup, 'unknown');
  assert.match(lookup.diagnostic ?? '', /祖先链/);
});
