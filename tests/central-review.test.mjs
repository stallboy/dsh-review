import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { reviewFixture, patchFixture } from './fixtures/contract.mjs';

test('托管内部入口保留审核 guard 与 owner 校验，身份不会串扰全局设置', async t => {
    const root = await createGitFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), 'central-review-state-'));
    const base = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const directory = path.join(root, '.ai-review/2026-11/fix-retry');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'review.md'), reviewFixture('fix-retry', { baseRevision: JSON.stringify(base) }));
    await writeFile(path.join(directory, '001.patch'), patchFixture());
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', 'candidate'], root);
    const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'local-owner', runner: 'manual', syncBeforeApprove: false };
    const api = new ReviewApi({ settings, saveSettings: async next => next, statePath: path.join(state, 'runtime.json') });
    await api.init();
    t.after(async () => { api.stopScheduler(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
    assert.equal(typeof api.invoke, 'function', '必须提供类型化内部调用入口');
    const actor = { userId: 'user-a', reviewIdentity: 'tester', commandId: 'command-a' };
    const other = { userId: 'user-b', reviewIdentity: 'other', commandId: 'command-b' };
    const query = { id: '2026-11/fix-retry' };
    const [mine, theirs] = await Promise.all([
        api.invoke({ method: 'GET', path: '/candidate', query, actor }),
        api.invoke({ method: 'GET', path: '/candidate', query, actor: other }),
    ]);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.canAct, true);
    assert.equal(theirs.body.canAct, false);
    const meta = mine.body.candidate.meta;
    const payload = { id: query.id, expectedRevision: meta.currentRevision, expectedOwner: meta.owner,
        expectedUpdatedAt: meta.updatedAt, content: '请补充验证', revision: 1 };
    const forbidden = await api.invoke({ method: 'POST', path: '/comments', body: payload, actor: other });
    assert.equal(forbidden.status, 403);
    const accepted = await api.invoke({ method: 'POST', path: '/comments', body: payload, actor });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.candidate.meta.comments[0].author, 'tester');
    assert.equal(api.currentSettings().owner, 'local-owner');
    const stale = await api.invoke({ method: 'POST', path: '/comments', body: payload, actor });
    assert.equal(stale.status, 409);
});
