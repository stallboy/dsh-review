import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { runApprovalTransaction } from '../packages/dsh-plugin/dist/host/approval.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { resolveIssueModule } from '../packages/dsh-plugin/dist/host/issue-publication.js';
import { serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { parsePatch } from '../packages/dsh-plugin/dist/host/patch.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, patchFixture, sha256Hex } from './fixtures/contract.mjs';

async function setupConflictingCandidate(t, options = {}) {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const oldBase = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, options.slug ?? '20261126-mode-c', {
    review: {
      findingId: options.findingId ?? 'mode-c-issue',
      baseRevision: JSON.stringify(oldBase),
      gateChecks: JSON.stringify(options.gateChecks ?? ['node --version']),
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  // 让业务文件与补丁上下文产生真实冲突，从而触发 Mode C
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (x, y) => x * y;\n', 'utf8');
  runCommand('git', ['add', 'src/math.js'], root);
  runCommand('git', ['commit', '-qm', 'conflicting business edit'], root);
  const preHead = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const vcs = new GitAdapter(root);
  const store = new ReviewStore(root);
  const detail = await store.get(candidate.id, preHead, await GitHeadCandidateSource.create(root));
  const meta = detail.candidate.meta;
  const guard = { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt };
  return { root, vcs, store, candidate, meta, guard, preHead, oldBase };
}

test('SPEC §5.5 Mode C 情况 A（equivalent）：冲突后由 Mode C 工作区等价适配，经门禁并原子提交', async t => {
  const { root, vcs, store, candidate, guard } = await setupConflictingCandidate(t);
  const outcome = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
      sharedSource: () => GitHeadCandidateSource.create(root),
      log: () => {},
      runModeC: async ({ cwd }) => {
        await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
        return {
          ok: true,
          assistantText: JSON.stringify({ verdict: 'equivalent', summary: '按新参数名 x/y 等价修正加法' }),
          outputTail: '',
        };
      },
    },
    { id: candidate.id, jobId: 'mode-c-a', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
  );
  assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
  assert.equal(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), 'export const add = (x, y) => x + y;\n');
  const shared = (await store.get(candidate.id, null, await GitHeadCandidateSource.create(root))).candidate;
  assert.equal(shared.meta.status, 'approved');
  assert.equal(shared.meta.repairAttempts.at(-1).applyMode, 'agent_assisted');
  assert.equal(shared.meta.repairAttempts.at(-1).result, 'applied');
});

test('SPEC §5.5 Mode C 情况 A（material_change / 越界改动）：先导出新补丁再还原业务并退回重审', async t => {
  const { root, vcs, store, candidate, guard } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-mat' });
  const outcome = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
      sharedSource: () => GitHeadCandidateSource.create(root),
      log: () => {},
      runModeC: async ({ cwd }) => {
        await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => Number(x) + Number(y);\n', 'utf8');
        return {
          ok: true,
          assistantText: JSON.stringify({ verdict: 'material_change', summary: '需要额外强制数值转换' }),
          outputTail: '',
        };
      },
    },
    { id: candidate.id, jobId: 'mode-c-mat', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
  );
  assert.equal(outcome.status, 'FALLBACK_TO_PENDING', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'MATERIAL_CHANGE');
  assert.equal(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), 'export const add = (x, y) => x * y;\n');
  assert.equal((await vcs.ensureCleanWorkspace()).clean, true);
  const shared = (await store.get(candidate.id, null, await GitHeadCandidateSource.create(root))).candidate;
  assert.equal(shared.meta.status, 'pending');
  assert.equal(shared.meta.patches.length, 2);
  assert.equal(shared.meta.options[0].currentPatch, 2);
});

test('SPEC §5.5 Mode C 严禁改写 .ai-review/：篡改后强制还原并中止，不导出新补丁', async t => {
  const { root, vcs, store, candidate, guard, preHead } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-tamper' });
  const outcome = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
      sharedSource: () => GitHeadCandidateSource.create(root),
      log: () => {},
      runModeC: async ({ cwd }) => {
        await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
        await writeFile(path.join(cwd, '.ai-review', 'evil.txt'), 'tamper', 'utf8');
        return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '试图夹带 .ai-review' }), outputTail: '' };
      },
    },
    { id: candidate.id, jobId: 'mode-c-tamper', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
  );
  assert.equal(outcome.status, 'ABORTED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'RUNNER_FAILED');
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), preHead);
  assert.equal(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), 'export const add = (x, y) => x * y;\n');
});

test('SPEC §5.5 Mode C 情况 B-本地（单提交 amend 与多提交含分支合并折叠）', async t => {
  // 1) 单提交 amend
  {
    const { root, vcs, store, candidate, guard, preHead } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-amend' });
    const outcome = await runApprovalTransaction(
      {
        store,
        vcs,
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
        sharedSource: () => GitHeadCandidateSource.create(root),
        log: () => {},
        runModeC: async ({ cwd }) => {
          await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
          runCommand('git', ['add', 'src/math.js'], cwd);
          runCommand('git', ['commit', '-qm', 'mode c local commit'], cwd);
          return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '单提交适配' }), outputTail: '' };
        },
      },
      { id: candidate.id, jobId: 'mode-c-amend', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
    );
    assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
    assert.equal(runCommand('git', ['rev-list', '--count', `${preHead}..HEAD`], root).stdout.trim(), '1');
    const paths = await vcs.listCommitPaths(outcome.commitRevision);
    assert.ok(paths.includes('src/math.js'));
    assert.ok(paths.includes(`.ai-review/${candidate.id}/review.md`));
  }

  // 2) 多提交 + 分支合并（排除上游无冲突纯继承文件 src/upstream-only.js）
  {
    const { root, vcs, store, candidate, guard, preHead } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-merge' });
    const mainBranch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    runCommand('git', ['checkout', '-qb', 'upstream-feature'], root);
    await writeFile(path.join(root, 'src', 'upstream-only.js'), 'export const fromUpstream = 42;\n', 'utf8');
    runCommand('git', ['add', 'src/upstream-only.js'], root);
    runCommand('git', ['commit', '-qm', 'upstream unrelated feature'], root);
    const upstreamTip = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    runCommand('git', ['checkout', '-q', mainBranch], root);

    const outcome = await runApprovalTransaction(
      {
        store,
        vcs,
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
        sharedSource: () => GitHeadCandidateSource.create(root),
        log: () => {},
        runModeC: async ({ cwd }) => {
          runCommand('git', ['merge', '--no-ff', '--no-edit', 'upstream-feature'], cwd);
          await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
          runCommand('git', ['add', 'src/math.js'], cwd);
          runCommand('git', ['commit', '-qm', 'apply fix after merge'], cwd);
          return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '合并上游并等价适配' }), outputTail: '' };
        },
      },
      { id: candidate.id, jobId: 'mode-c-merge', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
    );
    assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
    const parents = runCommand('git', ['show', '-s', '--format=%P', 'HEAD'], root).stdout.trim().split(/\s+/);
    assert.deepEqual(parents, [preHead, upstreamTip]);
    assert.equal(await readFile(path.join(root, 'src', 'upstream-only.js'), 'utf8'), 'export const fromUpstream = 42;\n');
    assert.equal(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), 'export const add = (x, y) => x + y;\n');
  }
});

test('SPEC §5.5 Mode C 情况 B-已推送：通过门禁写 business_commit + C_meta；失败则 REMOTE_PUSH_UNREVERTIBLE 不强推', async t => {
  // 1) 已推送 + 门禁通过 -> C_meta 记录 business_commit
  {
    const { root, vcs, store, candidate, guard } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-push-ok' });
    const remote = await mkdtemp(path.join(os.tmpdir(), 'mode-c-remote-ok-'));
    t.after(() => rm(remote, { recursive: true, force: true }));
    const branch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    runCommand('git', ['init', '--bare', '-q', remote], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    runCommand('git', ['push', '-qu', 'origin', branch], root);

    let pushedCommit = '';
    const outcome = await runApprovalTransaction(
      {
        store,
        vcs,
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
        sharedSource: () => GitHeadCandidateSource.create(root),
        log: () => {},
        runModeC: async ({ cwd }) => {
          await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
          runCommand('git', ['add', 'src/math.js'], cwd);
          runCommand('git', ['commit', '-qm', 'pushed business fix'], cwd);
          pushedCommit = runCommand('git', ['rev-parse', 'HEAD'], cwd).stdout.trim();
          runCommand('git', ['push', '-q', 'origin', branch], cwd);
          return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '已推送业务提交' }), outputTail: '' };
        },
      },
      { id: candidate.id, jobId: 'mode-c-push-ok', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
    );
    assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
    assert.equal(outcome.commitRevision, pushedCommit);
    assert.ok(outcome.closingCommitRevision && outcome.closingCommitRevision !== pushedCommit);
    const shared = (await store.get(candidate.id, null, await GitHeadCandidateSource.create(root))).candidate;
    assert.equal(shared.meta.status, 'approved');
    assert.equal(shared.meta.approval.businessCommit, pushedCommit);
    const derived = await vcs.deriveApprovalCommit({
      reviewPath: `.ai-review/${candidate.id}/review.md`,
      patchPaths: [`.ai-review/${candidate.id}/001.patch`],
      targetFiles: ['src/math.js'],
      approval: shared.meta.approval,
    });
    assert.equal(derived.lookup, 'found');
    assert.equal(derived.revision, pushedCommit);
  }

  // 2) 已推送 + 门禁失败 -> REMOTE_PUSH_UNREVERTIBLE 且远端不回退
  {
    const { root, vcs, store, candidate, guard } = await setupConflictingCandidate(t, {
      slug: '20261126-mode-c-push-fail',
      gateChecks: ['node -e "process.exit(3)"'],
    });
    const remote = await mkdtemp(path.join(os.tmpdir(), 'mode-c-remote-fail-'));
    t.after(() => rm(remote, { recursive: true, force: true }));
    const branch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    runCommand('git', ['init', '--bare', '-q', remote], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    runCommand('git', ['push', '-qu', 'origin', branch], root);

    let pushedCommit = '';
    const outcome = await runApprovalTransaction(
      {
        store,
        vcs,
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
        sharedSource: () => GitHeadCandidateSource.create(root),
        log: () => {},
        runModeC: async ({ cwd }) => {
          await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
          runCommand('git', ['add', 'src/math.js'], cwd);
          runCommand('git', ['commit', '-qm', 'pushed broken fix'], cwd);
          pushedCommit = runCommand('git', ['rev-parse', 'HEAD'], cwd).stdout.trim();
          runCommand('git', ['push', '-q', 'origin', branch], cwd);
          return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '已推送' }), outputTail: '' };
        },
      },
      { id: candidate.id, jobId: 'mode-c-push-fail', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
    );
    assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
    assert.equal(outcome.reason, 'REMOTE_PUSH_UNREVERTIBLE');
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${branch}`], remote).stdout.trim(), pushedCommit);
  }
});

test('SPEC §4.1–§4.2：repair_failed 永久封禁、评论保态、单方案禁止 resume_review、双方案解锁改选与全状态转移', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const p1 = patchFixture();
  const p2 = patchFixture({ to: 'export const add = (a, b) => Number(a) + Number(b);' });
  const dir = path.join(root, '.ai-review', '2026-11', 'two-opt');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '001.patch'), p1, 'utf8');
  await writeFile(path.join(dir, '002.patch'), p2, 'utf8');
  const meta = {
    schemaVersion: 1, findingId: 'two-opt', title: 'math: 双方案状态机测试', module: 'math',
    auditType: 'bugfix', issueKind: 'repair', dependsOn: null, priority: 'P1', baseRevision: baseRev,
    createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', owner: 'tester',
    tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], recordRevision: 1,
    patches: [
      { id: 1, patch: '001.patch', optionId: 'opt-fail', baseRevision: baseRev, author: 'ai', sha256: sha256Hex(p1) },
      { id: 2, patch: '002.patch', optionId: 'opt-pass', baseRevision: baseRev, author: 'ai', sha256: sha256Hex(p2) },
    ],
    options: [
      { id: 'opt-fail', title: '失败方案', tradeoff: '门禁失败', confidence: 0.9, currentPatch: 1, gateChecks: ['node -e "process.exit(5)"'] },
      { id: 'opt-pass', title: '成功方案', tradeoff: '门禁通过', confidence: 0.8, currentPatch: 2, gateChecks: ['node --version'] },
    ],
    observations: [], decisions: [], repairAttempts: [], comments: [], humanDecisions: [],
    approval: null, approvalHistory: [], rejection: null, commitMessage: 'math: 双方案状态机测试',
  };
  await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, '# 问题与影响\n测试\n\n# 需人工判断项\n- 无\n'), 'utf8');
  // 再建一个单方案问题用于验证单方案 repair_failed 无法 resume_review
  const singleDir = path.join(root, '.ai-review', '2026-11', 'one-opt');
  await mkdir(singleDir, { recursive: true });
  await writeFile(path.join(singleDir, '001.patch'), p1, 'utf8');
  const singleMeta = { ...structuredClone(meta), findingId: 'one-opt', auditType: 'shrink', patches: [meta.patches[0]], options: [meta.options[0]] };
  await writeFile(path.join(singleDir, 'review.md'), serializeReviewMarkdown(singleMeta, '# 问题与影响\n单方案\n\n# 需人工判断项\n- 无\n'), 'utf8');
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-qm', 'state machine fixtures'], root);

  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false, autoFixOnFailure: true },
    saveSettings: async v => v,
    statePath: path.join(root, '.tmp', 'sm-state.json'),
  });
  await api.init();
  const waitJob = async (jobId) => {
    for (let i = 0; i < 400; i += 1) {
      const job = api.jobManager.get(jobId);
      if (job && job.status !== 'running') return job.result;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout');
  };
  const guardOf = async (id) => {
    const { body } = await api.invoke({ method: 'GET', path: '/candidate', query: { id } });
    const m = body.candidate.meta;
    return { expectedRevision: m.recordRevision, expectedOwner: m.owner, expectedUpdatedAt: m.updatedAt, meta: m };
  };

  // 单方案门禁失败 -> repair_failed -> 评论保态 -> defer + resume_review 保态 -> 再次 resume_review 409
  const sg1 = await guardOf('2026-11/one-opt');
  const failOne = await waitJob((await api.invoke({
    method: 'POST', path: '/approve',
    body: { id: '2026-11/one-opt', optionId: 'opt-fail', patchId: 1, ...sg1, confirmedDecisions: [], waivedDecisions: [] },
  })).body.jobId);
  assert.equal(failOne.status, 'REPAIR_FAILED');

  const sg2 = await guardOf('2026-11/one-opt');
  assert.equal(sg2.meta.status, 'repair_failed');
  const commented = await api.invoke({ method: 'POST', path: '/comments', body: { id: '2026-11/one-opt', ...sg2, content: '请调整门禁' } });
  assert.equal(commented.status, 200);
  const sg3 = await guardOf('2026-11/one-opt');
  assert.equal(sg3.meta.status, 'repair_failed', 'repair_failed 收到评论必须保持 repair_failed');

  // defer -> resume_review 解除延期仍保持 repair_failed
  const defRes = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg3, action: 'defer', reason: '稍后处理' } });
  assert.equal(defRes.status, 200);
  const sg4 = await guardOf('2026-11/one-opt');
  const unDef = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg4, action: 'resume_review', reason: '解除延期' } });
  assert.equal(unDef.status, 200);
  assert.equal(unDef.body.finding.issueStatus, 'repair_failed');

  // 非延期单方案 repair_failed 无未失败方案，resume_review 必须 409
  const sg5 = await guardOf('2026-11/one-opt');
  const blockedResume = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg5, action: 'resume_review', reason: '试图洗白' } });
  assert.equal(blockedResume.status, 409);

  // human_takeover -> external_completed -> awaiting_verification -> human_takeover（空 reason 422，非空 200）-> accept_as_is
  const ht1 = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg5, action: 'human_takeover', reason: '转人工' } });
  assert.equal(ht1.status, 200);
  const sg6 = await guardOf('2026-11/one-opt');
  const extDone = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg6, action: 'external_completed', reason: '已手动修' } });
  assert.equal(extDone.status, 200);
  assert.equal(extDone.body.finding.issueStatus, 'awaiting_verification');
  const sg7 = await guardOf('2026-11/one-opt');
  const withdrawEmpty = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg7, action: 'human_takeover', reason: '   ' } });
  assert.equal(withdrawEmpty.status, 422);
  const withdrawOk = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg7, action: 'human_takeover', reason: '发现遗漏撤回' } });
  assert.equal(withdrawOk.status, 200);
  const sg8 = await guardOf('2026-11/one-opt');
  const acceptFromHt = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/one-opt', ...sg8, action: 'accept_as_is', reason: '维持现状', category: 'intentional' } });
  assert.equal(acceptFromHt.status, 200);
  assert.equal(acceptFromHt.body.finding.issueStatus, 'rejected');

  // AC-MEMORY-01：自身从 rejected 合法 resume_review 恢复后，不与自己触发重复指纹拦截（在双方案中演示）
  // 双方案：opt-fail 失败 -> repair_failed -> resume_review 解锁 -> opt-fail 仍永久封禁 -> opt-pass 成功批准！
  const tg1 = await guardOf('2026-11/two-opt');
  const failTwo = await waitJob((await api.invoke({
    method: 'POST', path: '/approve',
    body: { id: '2026-11/two-opt', optionId: 'opt-fail', patchId: 1, ...tg1, confirmedDecisions: [], waivedDecisions: [] },
  })).body.jobId);
  assert.equal(failTwo.status, 'REPAIR_FAILED');
  const tg2 = await guardOf('2026-11/two-opt');
  const unlock = await api.invoke({ method: 'POST', path: '/finding/decision', body: { id: '2026-11/two-opt', ...tg2, action: 'resume_review', reason: '改选另一方案' } });
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.finding.issueStatus, 'pending');

  const tg3 = await guardOf('2026-11/two-opt');
  const retryBanned = await api.invoke({
    method: 'POST', path: '/approve',
    body: { id: '2026-11/two-opt', optionId: 'opt-fail', patchId: 1, ...tg3, confirmedDecisions: [], waivedDecisions: [] },
  });
  assert.equal(retryBanned.status, 409, JSON.stringify(retryBanned));
  assert.match(retryBanned.body.error.message, /封禁/);

  const approveAlt = await waitJob((await api.invoke({
    method: 'POST', path: '/approve',
    body: { id: '2026-11/two-opt', optionId: 'opt-pass', patchId: 2, ...tg3, confirmedDecisions: [], waivedDecisions: [] },
  })).body.jobId);
  assert.equal(approveAlt.status, 'COMMITTED', JSON.stringify(approveAlt));
});

test('AC-ROUTING-01：POST /reviewers/init 要求工作区干净并原子提交，重复初始化返回 409', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
    saveSettings: async v => v,
    statePath: path.join(root, '.tmp', 'rev-state.json'),
  });
  await api.init();

  // 未初始化前启动审查 412
  assert.equal((await api.invoke({ method: 'POST', path: '/audit/manual', body: {} })).status, 412);

  // 脏工作区拒绝初始化 409
  await writeFile(path.join(root, 'src', 'math.js'), '// dirty\n', 'utf8');
  assert.equal((await api.invoke({ method: 'POST', path: '/reviewers/init', body: { defaultOwner: 'alice' } })).status, 409);
  runCommand('git', ['checkout', '--', 'src/math.js'], root);

  // 干净工作区初始化成功并原子提交
  const ok = await api.invoke({ method: 'POST', path: '/reviewers/init', body: { defaultOwner: 'alice' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.commitRevision);
  assert.match(runCommand('git', ['show', 'HEAD:.ai-review/reviewers.yml'], root).stdout, /default_owner: alice/);

  // 重复初始化返回 409
  assert.equal((await api.invoke({ method: 'POST', path: '/reviewers/init', body: { defaultOwner: 'bob' } })).status, 409);
});

test('D07 & AC-MEMORY-01：resolveIssueModule 推导真实模块名（不硬编码 audit）且自身合法恢复免重', async t => {
  assert.equal(resolveIssueModule({ module: 'Payment_Core', title: 'fix', targetFiles: ['src/a.ts'] }), 'payment_core');
  assert.equal(resolveIssueModule({ title: 'auth: 缺少鉴权检查', targetFiles: ['src/index.ts'] }), 'auth');
  assert.equal(resolveIssueModule({ title: '缺少空值校验', targetFiles: ['src/billing/invoice.ts'] }), 'billing');
  assert.notEqual(resolveIssueModule({ title: '未知问题', targetFiles: ['src/math.js'] }), 'audit');

  // 同一问题 rejected -> resume_review 后不应被自身拒绝指纹阻断
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261126-self-resume', {
    review: { findingId: 'self-resume', baseRevision: JSON.stringify(baseRev), bodyLines: ['# 需人工判断项', '', '- 无'] },
  });
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
    saveSettings: async v => v,
    statePath: path.join(root, '.tmp', 'mem-state.json'),
  });
  await api.init();
  const g1 = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: candidate.id } })).body.candidate.meta;
  const r1 = await api.invoke({
    method: 'POST', path: '/finding/decision',
    body: { id: candidate.id, expectedRevision: g1.recordRevision, expectedOwner: g1.owner, expectedUpdatedAt: g1.updatedAt, action: 'accept_as_is', reason: '暂时不修' },
  });
  assert.equal(r1.status, 200);
  const g2 = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: candidate.id } })).body.candidate.meta;
  const r2 = await api.invoke({
    method: 'POST', path: '/finding/decision',
    body: { id: candidate.id, expectedRevision: g2.recordRevision, expectedOwner: g2.owner, expectedUpdatedAt: g2.updatedAt, action: 'resume_review', reason: '决定修复' },
  });
  assert.equal(r2.status, 200);
  const g3 = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: candidate.id } })).body.candidate.meta;
  const app = await api.invoke({
    method: 'POST', path: '/approve',
    body: { id: candidate.id, optionId: 'opt-a', patchId: 1, expectedRevision: g3.recordRevision, expectedOwner: g3.owner, expectedUpdatedAt: g3.updatedAt, confirmedDecisions: [], waivedDecisions: [] },
  });
  assert.equal(app.status, 202);
  let job;
  for (let i = 0; i < 200; i += 1) {
    job = api.jobManager.get(app.body.jobId);
    if (job && job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(job.result.status, 'COMMITTED', JSON.stringify(job.result));
});

test('对抗审查回归 P0-1：Mode C 伪造侧分支合并不得绕过范围外文件硬护栏', async t => {
  const { root, vcs, store, candidate, guard, preHead } = await setupConflictingCandidate(t, { slug: '20261126-mode-c-fake-branch' });
  const mainBranch = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
  const outcome = await runApprovalTransaction(
    {
      store,
      vcs,
      settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'external', autoFixOnFailure: true, syncBeforeApprove: false },
      sharedSource: () => GitHeadCandidateSource.create(root),
      log: () => {},
      runModeC: async ({ cwd }) => {
        // 攻击：在 Mode C 内部从 preHead 新建侧分支改写越界文件 evil.js 并合并回主分支
        runCommand('git', ['checkout', '-qb', 'forged-side'], cwd);
        await writeFile(path.join(cwd, 'src', 'evil.js'), 'export const backdoor = true;\n', 'utf8');
        runCommand('git', ['add', 'src/evil.js'], cwd);
        runCommand('git', ['commit', '-qm', 'forged side commit'], cwd);
        runCommand('git', ['checkout', '-q', mainBranch], cwd);
        runCommand('git', ['merge', '--no-ff', '--no-edit', 'forged-side'], cwd);
        await writeFile(path.join(cwd, 'src', 'math.js'), 'export const add = (x, y) => x + y;\n', 'utf8');
        runCommand('git', ['add', 'src/math.js'], cwd);
        runCommand('git', ['commit', '-qm', 'math fix'], cwd);
        return { ok: true, assistantText: JSON.stringify({ verdict: 'equivalent', summary: '伪造合并' }), outputTail: '' };
      },
    },
    { id: candidate.id, jobId: 'mode-c-forged', guard, optionId: 'opt-a', patchId: 1, actor: 'tester', confirmedDecisions: [], waivedDecisions: [] },
  );
  assert.equal(outcome.status, 'ABORTED', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'RUNNER_FAILED');
  assert.match(outcome.message, /自建侧分支|无法追溯/);
  assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), preHead);
  await assert.rejects(readFile(path.join(root, 'src', 'evil.js'), 'utf8'), { code: 'ENOENT' });
});

test('对抗审查回归 P0-4 / P1-9：补丁重命名/符号链接模式拦截与往期未合入 option_id 退役校验', () => {
  const renamePatch = [
    'diff --git a/src/math.js b/src/math.js',
    'similarity index 100%',
    'rename from src/math.js',
    'rename to .ai-review/evil.md',
  ].join('\n');
  const parsedRename = parsePatch(renamePatch);
  assert.ok(parsedRename.paths.includes('.ai-review/evil.md'));

  const symlinkPatch = [
    'diff --git a/src/link b/src/link',
    'new file mode 120000',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/src/link',
    '@@ -0,0 +1 @@',
    '+/etc/passwd',
  ].join('\n');
  const parsedSymlink = parsePatch(symlinkPatch);
  assert.deepEqual(parsedSymlink.unsafeModes, ['120000']);

  // P1-9：Round 1 有 opt-a (#1) 与 opt-b (#2)，批准 opt-a 后重开不得复用 opt-b
  const sha = sha256Hex(patchFixture());
  const errors = quickReviewInvariants({
    id: '2026-11/reopened-retire',
    month: '2026-11',
    slug: 'reopened-retire',
    meta: {
      schemaVersion: 1, findingId: 'reopened-retire', title: 'math: 重开退役', module: 'math',
      auditType: 'bugfix', issueKind: 'repair', dependsOn: null, priority: 'P1', baseRevision: 'rev2',
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', owner: 'tester',
      tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], recordRevision: 3,
      patches: [
        { id: 1, patch: '001.patch', optionId: 'opt-a', baseRevision: 'rev1', author: 'ai', sha256: sha },
        { id: 2, patch: '002.patch', optionId: 'opt-b', baseRevision: 'rev1', author: 'ai', sha256: sha },
        { id: 3, patch: '003.patch', optionId: 'opt-b', baseRevision: 'rev2', author: 'ai', sha256: sha },
      ],
      options: [
        { id: 'opt-b', title: '复用旧备选', tradeoff: '非法', confidence: 0.9, currentPatch: 3, gateChecks: ['node --version'] },
      ],
      observations: [], decisions: [], repairAttempts: [], comments: [], humanDecisions: [],
      approval: null,
      approvalHistory: [{
        optionId: 'opt-a', patchId: 1, recordRevision: 1, repairAttemptId: 1, baseRevision: 'rev1',
        patchSha256: sha, approvedBy: 'tester', approvedAt: '2026-11-01T12:00:00Z',
        gateChecks: ['node --version'], gateResults: [{ command: 'node --version', exitCode: 0, durationMs: 1 }],
        confirmedDecisions: [], waivedDecisions: [],
      }],
      rejection: null, commitMessage: 'math: 重开退役',
    },
  });
  assert.ok(errors.some((e) => e.includes('opt-b') && e.includes('退役')), errors.join('\n'));
});

test('对抗审查回归 P0-3 / P1-3：/fix-session/release 核验释放闭环与 /candidate/finalize 状态守卫', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261126-fix-release', {
    review: {
      baseRevision: JSON.stringify(baseRev),
      comments: '\n  - id: c1\n    revision: 1\n    file: ""\n    line: 0\n    author: tester\n    content: 需修订\n    status: unresolved',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
    saveSettings: async (v) => v,
    statePath: path.join(root, '.tmp', 'fix-rel-state.json'),
    createFixSession: async () => ({ sessionId: 'fix-sess-1' }),
    stopAuditSession: async () => true,
  });
  await api.init();

  const g1 = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: candidate.id } })).body.candidate.meta;
  const started = await api.invoke({
    method: 'POST', path: '/fix-session',
    body: { id: candidate.id, expectedRevision: g1.recordRevision, expectedOwner: g1.owner, expectedUpdatedAt: g1.updatedAt, optionId: 'opt-a', patchId: 1 },
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));

  // 未传 confirmStopped=true 必须 422
  assert.equal((await api.invoke({ method: 'POST', path: '/fix-session/release', body: {} })).status, 422);
  // 传 confirmStopped=true 核验停止与工作区干净后释放
  const rel = await api.invoke({ method: 'POST', path: '/fix-session/release', body: { confirmStopped: true } });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.equal(rel.body.released, true);

  // 转入 human_takeover 后，/candidate/finalize 必须 409 拒绝绕过状态机
  const ht = await api.invoke({
    method: 'POST', path: '/finding/decision',
    body: { id: candidate.id, expectedRevision: g1.recordRevision, expectedOwner: g1.owner, expectedUpdatedAt: g1.updatedAt, action: 'human_takeover', reason: '人工接管' },
  });
  assert.equal(ht.status, 200);
  const g2 = ht.body.candidate.meta;
  const badFin = await api.invoke({
    method: 'POST', path: '/candidate/finalize',
    body: { id: candidate.id, expectedRevision: g2.recordRevision, expectedOwner: g2.owner, expectedUpdatedAt: g2.updatedAt, optionId: 'opt-a', patchId: 1 },
  });
  assert.equal(badFin.status, 409, JSON.stringify(badFin.body));
});

test('对抗审查回归 Round2 P1-1：POST /fix-session 向 createFixSession 与 withAuditSessionIdle 传入一致 requestId 并在空闲时并行自动释放', async t => {
  const root = await createGitFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseRev = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const candidate = await commitCandidate(root, '20261126-fix-idle-reqid', {
    review: {
      baseRevision: JSON.stringify(baseRev),
      comments: '\n  - id: c1\n    revision: 1\n    file: ""\n    line: 0\n    author: tester\n    content: 需修订\n    status: unresolved',
      bodyLines: ['# 需人工判断项', '', '- 无'],
    },
  });
  let createdRequestId = '';
  let idleRequestId = '';
  let triggerIdle;
  let onTurnEndUnsubscribed = false;
  let idleAborted = false;
  const api = new ReviewApi({
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', syncBeforeApprove: false },
    saveSettings: async (v) => v,
    statePath: path.join(root, '.tmp', 'fix-idle-state.json'),
    createFixSession: async (input) => {
      createdRequestId = input.requestId ?? '';
      return { sessionId: 'fix-sess-idle-1' };
    },
    stopAuditSession: async () => true,
    onAuditTurnEnd: () => () => { onTurnEndUnsubscribed = true; },
    withAuditSessionIdle: async (_sessionId, requestId, signal, finalize) => {
      idleRequestId = requestId;
      signal.addEventListener('abort', () => { idleAborted = true; });
      await new Promise((resolve) => { triggerIdle = resolve; });
      await finalize(signal);
      return true;
    },
  });
  await api.init();

  const g1 = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: candidate.id } })).body.candidate.meta;
  const started = await api.invoke({
    method: 'POST', path: '/fix-session',
    body: { id: candidate.id, expectedRevision: g1.recordRevision, expectedOwner: g1.owner, expectedUpdatedAt: g1.updatedAt, optionId: 'opt-a', patchId: 1 },
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.ok(createdRequestId.startsWith('fix-session-'), `unexpected createdRequestId: ${createdRequestId}`);
  assert.equal(idleRequestId, createdRequestId, 'withAuditSessionIdle 必须收到与 createFixSession 相同的 requestId');

  const beforeQueue = await api.invoke({ method: 'GET', path: '/queue' });
  assert.equal(beforeQueue.body.fixSession?.sessionId, 'fix-sess-idle-1');

  // 触发 withAuditSessionIdle 回调，应通过 releaseVerified 自动释放占用并清理两个监听器
  triggerIdle();
  for (let i = 0; i < 50; i += 1) {
    const queue = await api.invoke({ method: 'GET', path: '/queue' });
    if (!queue.body.fixSession) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const afterQueue = await api.invoke({ method: 'GET', path: '/queue' });
  assert.equal(afterQueue.body.fixSession, undefined);
  assert.equal(onTurnEndUnsubscribed, true);
  assert.equal(idleAborted, true);
});
