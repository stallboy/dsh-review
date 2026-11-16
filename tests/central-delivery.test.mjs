import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitFixture, runCommand } from './helpers.mjs';

async function fixture(t) {
    const root = await createGitFixture();
    const remote = await mkdtemp(path.join(os.tmpdir(), 'central-delivery-remote-'));
    runCommand('git', ['init', '--bare', '-q', remote], root);
    runCommand('git', ['remote', 'add', 'origin', remote], root);
    const target = runCommand('git', ['branch', '--show-current'], root).stdout.trim();
    runCommand('git', ['push', '-qu', 'origin', target], root);
    runCommand('git', ['config', 'user.name', 'review-node'], root);
    runCommand('git', ['config', 'user.email', 'review-node@example.com'], root);
    t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); });
    const entry = new URL('../dist/managed-delivery.js', import.meta.url);
    assert.equal(existsSync(entry), true, '托管交付实现必须存在');
    const { ManagedDelivery } = await import(entry.href);
    return { root, remote, target, delivery: new ManagedDelivery({ root, type: 'git', target }) };
}

test('Git 交付原提交，重复核验不生成新业务提交', async t => {
    const { root, remote, target, delivery } = await fixture(t);
    await writeFile(path.join(root, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'review: fix\n\nDsh-Command: command-1'], root);
    const commit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    const count = runCommand('git', ['rev-list', '--count', 'HEAD'], root).stdout.trim();
    assert.equal(await delivery.findCommandCommit('command-1'), commit);
    assert.equal((await delivery.deliver(commit)).state, 'delivered');
    assert.equal((await delivery.deliver(commit)).state, 'delivered');
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), commit);
    assert.equal(runCommand('git', ['rev-list', '--count', 'HEAD'], root).stdout.trim(), count);
});

test('Git 推送前远端不可用保留原提交等待交付', async t => {
    const { root, remote, delivery } = await fixture(t);
    await writeFile(path.join(root, 'new.txt'), 'local');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'local commit'], root);
    const commit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    runCommand('git', ['remote', 'set-url', 'origin', path.join(remote, 'not-a-repository')], root);
    const result = await delivery.deliver(commit);
    assert.equal(result.state, 'pending');
    assert.equal(result.commitRevision, commit);
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), commit);
});

test('Git 远端分叉保持 conflict，不强推或重写本地已审提交', async t => {
    const { root, remote, target, delivery } = await fixture(t);
    const other = await mkdtemp(path.join(os.tmpdir(), 'central-delivery-other-'));
    t.after(() => rm(other, { recursive: true, force: true }));
    runCommand('git', ['clone', '-q', remote, other], root);
    await writeFile(path.join(other, 'remote.txt'), 'someone else');
    runCommand('git', ['add', '-A'], other);
    runCommand('git', ['commit', '-qm', 'remote advance'], other);
    runCommand('git', ['push', '-q', 'origin', target], other);
    const remoteCommit = runCommand('git', ['rev-parse', 'HEAD'], other).stdout.trim();
    await writeFile(path.join(root, 'local.txt'), 'reviewed local');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'local reviewed'], root);
    const localCommit = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
    assert.equal((await delivery.deliver(localCommit)).state, 'conflict');
    assert.equal(runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim(), localCommit);
    assert.equal(runCommand('git', ['rev-parse', `refs/heads/${target}`], remote).stdout.trim(), remoteCommit);
});
