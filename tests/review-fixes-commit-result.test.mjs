import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand, reportOnlyAgentPath } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

async function fixture(t, audit = false) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    runCommand('git', ['config', 'user.name', 'tester'], root);
    runCommand('git', ['config', 'user.email', 'tester@example.com'], root);
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    await writeCandidate(root, 'verified', { review: { baseRevision: JSON.stringify(base), bodyLines: ['# 需人工判断项', '无。'] } });
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', 'candidate'], root);
    const api = new ReviewApi({ settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git',
        runner: audit ? 'external' : 'manual', externalCommand: `"${process.execPath}" "${reportOnlyAgentPath()}"`, syncBeforeApprove: false, autoFixOnFailure: false },
        statePath: path.join(root, '.git', 'dsh-review-runtime-state.json'),
        saveSettings: async value => value, decorateVcs: vcs => new Proxy(vcs, { get(target, key) {
            if (key === 'atomicCommit') return async input => {
                const result = await target.atomicCommit(input);
                return result.success ? { ...result, success: false, verificationFailed: true, errorOutput: '实际提交属性与核对属性不一致' } : result;
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } }) });
    await api.init();
    const detail = (await api.invoke({ method: 'GET', path: '/candidate', query: { id: '2026-11/verified' } })).body;
    const meta = detail.candidate.meta;
    const guard = { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt };
    return { root, api, guard };
}

async function resultOf(api, response) {
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const jobId = response.body.jobId;
    for (let attempt = 0; attempt < 500; attempt++) {
        const job = api.jobManager.get(jobId);
        if (job.status !== 'running') return job.result;
        await delay(20);
    }
    throw new Error('等待任务结束超时');
}

test('AC-RECOVERY-01 提交已落地但完整核验失败，评论不得弱化为成功或回滚', async t => {
    const { root, api, guard } = await fixture(t);
    const response = await api.invoke({ method: 'POST', path: '/comments', body: { id: '2026-11/verified', ...guard, content: '保留已落地现场' } });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.details.status, 'RECOVERY_REQUIRED');
    assert.match(await readFile(path.join(root, '.ai-review/2026-11/verified/review.md'), 'utf8'), /保留已落地现场/);
});

test('AC-RECOVERY-01 批准完整提交核验失败保留提交并返回恢复状态', async t => {
    const { root, api, guard } = await fixture(t);
    const outcome = await resultOf(api, await api.invoke({ method: 'POST', path: '/approve', body: { id: '2026-11/verified', optionId: 'opt-a', patchId: 1, ...guard } }));
    assert.equal(outcome.status, 'RECOVERY_REQUIRED');
    assert.equal(outcome.reason, 'COMMIT_OUTCOME_UNKNOWN');
    assert.match(await readFile(path.join(root, 'src/math.js'), 'utf8'), /a \+ b/);
});

test('AC-RECOVERY-01 审查收尾完整核验失败不能按文本匹配判为成功', async t => {
    const { api } = await fixture(t, true);
    const outcome = await resultOf(api, await api.invoke({ method: 'POST', path: '/audit', body: {} }));
    assert.equal(outcome.status, 'RECOVERY_REQUIRED');
});
