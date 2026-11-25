import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readApprovalMergeSnapshots, readSvnApprovalBinding, stampSvnApprovalSource } from '../packages/dsh-plugin/dist/host/approval-merge-snapshots.js';
import { GitAdapter, SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { runCommand } from './helpers.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dcr-merge-snapshots-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return root;
}

test('Git 快照绑定当前候选版本，历史不可读时不构造快照', async (t) => {
    const root = await fixture(t);
    const git = (...args) => runCommand('git', args, root).stdout.trim();
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    await writeFile(path.join(root, 'file.txt'), 'original\n');
    git('add', 'file.txt');
    git('commit', '-qm', 'first');
    await writeFile(path.join(root, 'file.txt'), 'rebased\n');
    git('commit', '-qam', 'second');
    const sourceRevision = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'file.txt'), 'target\n');
    git('commit', '-qam', 'target');
    const targetRevision = git('rev-parse', 'HEAD');
    const input = { files: ['file.txt'], sourceRevision, targetRevision, svnBinding: null };
    const vcs = new GitAdapter(root, '');
    const loaded = await readApprovalMergeSnapshots(vcs, input);
    assert.equal(loaded.status, 'ready', JSON.stringify(loaded));
    assert.deepEqual(loaded.files[0].source, Buffer.from('rebased\n'));
    assert.deepEqual(loaded.files[0].target, Buffer.from('target\n'));
    assert.equal((await readApprovalMergeSnapshots(vcs, { ...input, sourceRevision: 'abcdef0123456789' })).status, 'unavailable');
    await link(path.join(root, 'file.txt'), path.join(root, 'alias.txt'));
    assert.equal((await readApprovalMergeSnapshots(vcs, input)).status, 'unsupported');
});

test('SVN 核对原生来源及路径版本，根 revision 不变时也能识别目标变化', async (t) => {
    const parent = await fixture(t);
    const root = path.join(parent, 'wc');
    await mkdir(root);
    runCommand('svnadmin', ['create', 'repo'], parent);
    const url = pathToFileURL(path.join(parent, 'repo')).href;
    const svn = (...args) => runCommand('svn', args, root).stdout.trim();
    svn('checkout', '-q', url, '.');
    await mkdir(path.join(root, 'trunk'));
    await mkdir(path.join(root, 'other'));
    for (const area of ['trunk', 'other']) await writeFile(path.join(root, area, 'file.txt'), 'original\n');
    svn('add', 'trunk', 'other');
    svn('commit', '-qm', 'first');
    svn('update', '-q');
    const vcs = new SvnAdapter(root);
    const version = { id: 1, baseRevision: '1', patch: '001.patch', author: 'ai' };
    assert.equal(await stampSvnApprovalSource(vcs, version, ['trunk/file.txt']), true);
    const binding = await readSvnApprovalBinding(root);
    assert.deepEqual(version.extra.svn_approval_source, { uuid: binding.uuid, relative_url: binding.relativeUrl });
    const input = { files: ['trunk/file.txt'], sourceRevision: '1', targetRevision: '1', svnBinding: binding };
    const before = await readApprovalMergeSnapshots(vcs, input);
    assert.equal(before.status, 'ready', JSON.stringify(before));
    await writeFile(path.join(root, 'trunk/file.txt'), 'committed independently\n');
    svn('commit', '-qm', 'child commit', 'trunk/file.txt');
    assert.equal(await vcs.getCurrentBase(), '1');
    const after = await readApprovalMergeSnapshots(vcs, input);
    assert.equal(after.status, 'ready', JSON.stringify(after));
    assert.notEqual(before.files[0].targetIdentity, after.files[0].targetIdentity);
    assert.equal((await readApprovalMergeSnapshots(vcs, {
        ...input, svnBinding: { ...binding, relativeUrl: '^/other' },
    })).status, 'mismatch');
    assert.equal((await readApprovalMergeSnapshots(vcs, { ...input, svnBinding: null })).status, 'unavailable');
});
