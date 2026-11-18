import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCommand } from './helpers.mjs';
import { gitBlobHash, SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { SvnBaseCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { Writers } from '../packages/dsh-plugin/dist/host/api-writers.js';

async function fixture(t, reviewData = true) {
    const temporaryRoot = path.resolve(os.tmpdir());
    const base = await mkdtemp(path.join(temporaryRoot, 'review-fixes-svn-'));
    t.after(async () => {
        assert.ok(base.startsWith(`${temporaryRoot}${path.sep}`));
        await rm(base, { recursive: true, force: true });
    });
    const root = path.join(base, 'wc');
    const repo = path.join(base, 'repo');
    runCommand('svnadmin', ['create', repo], base);
    runCommand('svn', ['checkout', '-q', pathToFileURL(repo).href, root], base);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/app.txt'), 'base\n');
    if (reviewData) {
        await mkdir(path.join(root, '.ai-review/audits'), { recursive: true });
        await mkdir(path.join(root, '.ai-review/2026-11'), { recursive: true });
        await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\n');
    }
    runCommand('svn', ['add', 'src', ...(reviewData ? ['.ai-review'] : [])], root);
    runCommand('svn', ['commit', '-qm', 'base'], root);
    runCommand('svn', ['update', '-q'], root);
    return { root, repo, vcs: new SvnAdapter(root) };
}

function expected(file, content, mode = '100644') {
    return { path: file, blobHash: gitBlobHash(content), mode };
}

function revision(root) {
    return runCommand('svn', ['info', '--show-item', 'last-changed-revision', 'src/app.txt'], root).stdout.trim();
}

test('AC-APPROVE-01：SVN 原子提交拒绝已核对后被替换的内容', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, 'src/app.txt'), 'injected\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', 'approved\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '1');
    assert.equal(runCommand('svn', ['cat', '-r', 'HEAD', 'src/app.txt'], root).stdout, 'base\n');
});

test('AC-APPROVE-01：SVN 原子提交必须验证删除已经生效', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: reviewer\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['.ai-review/reviewers.yml', 'src/app.txt'], verifyEntries: [expected('.ai-review/reviewers.yml', 'default_owner: reviewer\n')], verifyDeletions: ['src/app.txt'] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '1');
});

test('AC-APPROVE-01：SVN 原子提交拒绝目录中未列入完整核对集合的文件', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    await writeFile(path.join(root, 'src/injected.txt'), 'injected\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src'], verifyEntries: [expected('src/app.txt', 'approved\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '1');
});

test('AC-APPROVE-01：SVN 原子提交核对 svn:executable 模式', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    runCommand('svn', ['propset', 'svn:executable', 'true', 'src/app.txt'], root);
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', 'approved\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '1');
});

test('AC-APPROVE-01：SVN 原子提交保留平台不跟踪的既有 executable 属性', async t => {
    const { root, vcs } = await fixture(t);
    runCommand('svn', ['propset', 'svn:executable', 'true', 'src/app.txt'], root);
    runCommand('svn', ['commit', '-qm', 'executable', 'src/app.txt'], root);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    const mode = process.platform === 'win32' ? '100644' : '100755';
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', 'approved\n', mode)] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(runCommand('svn', ['propget', 'svn:executable', '-r', result.commitRevision, 'src/app.txt'], root).stdout.trim(), '*');
});

test('AC-APPROVE-01：SVN 原子提交按原始字节核验二进制实际提交', async t => {
    const { root, vcs } = await fixture(t);
    const original = Buffer.from([0, 255, 1, 254]);
    await writeFile(path.join(root, 'src/data.bin'), original);
    runCommand('svn', ['add', 'src/data.bin'], root);
    runCommand('svn', ['commit', '-qm', 'binary', 'src/data.bin'], root);
    const content = Buffer.from([0, 254, 2, 255]);
    await writeFile(path.join(root, 'src/data.bin'), content);
    const result = await vcs.atomicCommit({ message: 'binary fix', paths: ['src/data.bin'], verifyEntries: [expected('src/data.bin', content)] });
    assert.equal(result.success, true, JSON.stringify(result));
    runCommand('svn', ['update', '-q'], root);
    assert.deepEqual(await readFile(path.join(root, 'src/data.bin')), content);
});

test('AC-APPROVE-01：SVN 实际内容核对不因大文件超过日志缓冲限制而失败', async t => {
    const { root, vcs } = await fixture(t);
    const content = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
    await writeFile(path.join(root, 'src/app.txt'), content);
    const result = await vcs.atomicCommit({ message: 'large fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', content)] });
    assert.equal(result.success, true, JSON.stringify(result));
});

test('AC-APPROVE-01：SVN 原子提交在换行转换改变核对字节时拒绝提交', async t => {
    const { root, vcs } = await fixture(t);
    runCommand('svn', ['propset', 'svn:eol-style', 'LF', 'src/app.txt'], root);
    runCommand('svn', ['commit', '-qm', 'eol', 'src/app.txt'], root);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\r\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', 'approved\r\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '2');
});

test('AC-APPROVE-01：SVN 原子提交拒绝未核对的属性变更', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    runCommand('svn', ['propset', 'review:injected', 'yes', 'src/app.txt'], root);
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt'], verifyEntries: [expected('src/app.txt', 'approved\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(revision(root), '1');
});

test('AC-APPROVE-01：SVN 新祖先提交不递归夹带已加入版本控制的兄弟文件', async t => {
    const { root, vcs } = await fixture(t);
    await mkdir(path.join(root, 'new/approved'), { recursive: true });
    await writeFile(path.join(root, 'new/approved/file.txt'), 'approved\n');
    await writeFile(path.join(root, 'new/injected.txt'), 'injected\n');
    runCommand('svn', ['add', 'new'], root);
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['new/approved/file.txt'], verifyEntries: [expected('new/approved/file.txt', 'approved\n')] });
    assert.equal(result.success, true, JSON.stringify(result));
    const changed = runCommand('svn', ['log', '--xml', '-v', '-r', result.commitRevision, pathToFileURL(path.join(path.dirname(root), 'repo')).href], root).stdout;
    assert.doesNotMatch(changed, /injected\.txt/);
    assert.match(changed, /new\/approved\/file\.txt/);
});

test('AC-APPROVE-01：SVN 实际提交核对保留路径中的百分号和 XML 字符', async t => {
    const { root, vcs } = await fixture(t);
    const file = 'src/file%20&name.txt';
    await writeFile(path.join(root, file), 'approved\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: [file], verifyEntries: [expected(file, 'approved\n')] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(runCommand('svn', ['cat', '-r', result.commitRevision, file], root).stdout, 'approved\n');
});

test('AC-APPROVE-01：SVN 原子提交同时保存核对内容和删除，接受未变更的 LF 属性', async t => {
    const { root, vcs } = await fixture(t);
    runCommand('svn', ['propset', 'svn:eol-style', 'LF', 'src/app.txt'], root);
    runCommand('svn', ['commit', '-qm', 'properties', 'src/app.txt'], root);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    const result = await vcs.atomicCommit({ message: 'fix', paths: ['src/app.txt', '.ai-review'], deletePaths: ['.ai-review/reviewers.yml'], verifyEntries: [expected('src/app.txt', 'approved\n')], verifyDeletions: ['.ai-review/reviewers.yml'] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(runCommand('svn', ['cat', '-r', result.commitRevision, 'src/app.txt'], root).stdout, 'approved\n');
    assert.doesNotMatch(runCommand('svn', ['list', '-r', result.commitRevision, '.ai-review'], root).stdout, /reviewers\.yml/);
});

test('AC-APPROVE-01：SVN 继承自动属性导致追加失败后真实 Writers 恢复为干净状态', async t => {
    const { root, vcs } = await fixture(t);
    const candidate = '.ai-review/2026-11/fix';
    const dirPath = path.join(root, candidate);
    const reviewPath = path.join(dirPath, 'review.md');
    const previous = 'shared revision 1\n';
    await mkdir(dirPath, { recursive: true });
    await writeFile(reviewPath, previous);
    await writeFile(path.join(dirPath, '001.patch'), 'shared patch\n');
    runCommand('svn', ['add', candidate], root);
    runCommand('svn', ['propset', 'svn:auto-props', '*.patch = review:marker=on', '.ai-review'], root);
    runCommand('svn', ['commit', '-qm', 'candidate', '.ai-review'], root);
    runCommand('svn', ['update', '-q'], root);
    const entriesBefore = new Set(await readdir(dirPath));
    const probeBefore = await vcs.getCommitProbe([`${candidate}/review.md`]);
    await writeFile(reviewPath, 'updated revision 2\n');
    await writeFile(path.join(dirPath, '002.patch'), 'new patch\n');
    const writers = new Writers({}, {});
    const result = await writers.commitAndClassify({ runtime: { store: { repoRoot: root }, vcs }, message: 'append', paths: [candidate], probePaths: [`${candidate}/review.md`], expectedFiles: [{ relPath: `${candidate}/review.md`, text: 'updated revision 2\n' }, { relPath: `${candidate}/002.patch`, text: 'new patch\n' }] });
    assert.equal(result.landed, false, JSON.stringify(result));
    assert.equal(result.outcome, 'ABORTED');
    assert.match(result.detail, /review:marker/);
    await writers.restoreAppendedRevision({ reviewPath, dirPath }, previous, entriesBefore);
    assert.equal(await readFile(reviewPath, 'utf8'), previous);
    assert.deepEqual((await readdir(dirPath)).sort(), ['001.patch', 'review.md']);
    assert.equal(await vcs.getCommitProbe([`${candidate}/review.md`]), probeBefore);
    assert.equal(runCommand('svn', ['status', '--', candidate], root).stdout.trim(), '');
});

test('AC-APPROVE-01：SVN 提交前失败撤销自身新增文件及祖先调度并保留字节', async t => {
    const { root, vcs } = await fixture(t);
    await mkdir(path.join(root, 'new/deep'), { recursive: true });
    await writeFile(path.join(root, 'new/deep/file.txt'), 'original bytes\n');
    const result = await vcs.atomicCommit({ message: 'fail', paths: ['new/deep/file.txt'], verifyEntries: [expected('new/deep/file.txt', 'different\n')] });
    assert.equal(result.success, false);
    assert.equal(await readFile(path.join(root, 'new/deep/file.txt'), 'utf8'), 'original bytes\n');
    const status = runCommand('svn', ['status', '--xml', '--', 'new'], root).stdout;
    assert.match(status, /item="unversioned"/);
    assert.doesNotMatch(status, /item="added"/);
});

test('AC-APPROVE-01：SVN 提交前补偿保留调用前已有新增删除及属性调度', async t => {
    const { root, vcs } = await fixture(t);
    await writeFile(path.join(root, 'src/preexisting.txt'), 'existing add\n');
    runCommand('svn', ['add', 'src/preexisting.txt'], root);
    runCommand('svn', ['propset', 'review:preserved', 'yes', 'src/preexisting.txt'], root);
    runCommand('svn', ['delete', '.ai-review/reviewers.yml'], root);
    const before = runCommand('svn', ['status', '--', 'src/preexisting.txt', '.ai-review/reviewers.yml'], root).stdout;
    await writeFile(path.join(root, 'src/new.txt'), 'new bytes\n');
    const result = await vcs.atomicCommit({ message: 'fail', paths: ['src/new.txt'], verifyEntries: [expected('src/new.txt', 'different\n')] });
    assert.equal(result.success, false);
    assert.equal(runCommand('svn', ['status', '--', 'src/preexisting.txt', '.ai-review/reviewers.yml'], root).stdout, before);
    assert.equal(await readFile(path.join(root, 'src/preexisting.txt'), 'utf8'), 'existing add\n');
    assert.equal(runCommand('svn', ['propget', 'review:preserved', 'src/preexisting.txt'], root).stdout.trim(), 'yes');
    assert.doesNotMatch(runCommand('svn', ['status', '--xml', '--', 'src/new.txt'], root).stdout, /item="added"/);
});

for (const missing of [false, true]) {
    test(`AC-APPROVE-01：SVN 提交前失败撤销自身删除并保留原${missing ? '缺失' : '文件'}状态`, async t => {
        const { root, vcs } = await fixture(t);
        const deleted = '.ai-review/reviewers.yml';
        const original = await readFile(path.join(root, deleted));
        if (missing) await rm(path.join(root, deleted));
        await writeFile(path.join(root, 'src/app.txt'), 'local bytes\n');
        const result = await vcs.atomicCommit({ message: 'fail', paths: ['src/app.txt'], deletePaths: [deleted], verifyEntries: [expected('src/app.txt', 'different\n')], verifyDeletions: [deleted] });
        assert.equal(result.success, false);
        const restored = await readFile(path.join(root, deleted)).catch(() => null);
        assert.deepEqual(restored, missing ? null : original);
        assert.equal(await readFile(path.join(root, 'src/app.txt'), 'utf8'), 'local bytes\n');
        const status = runCommand('svn', ['status', '--xml', '--', deleted], root).stdout;
        assert.doesNotMatch(status, /item="deleted"/);
        if (missing) assert.match(status, /item="missing"/);
    });
}

test('AC-APPROVE-01：SVN 删除调用前修改的文件被拒且保留原字节和属性', async t => {
    const { root, vcs } = await fixture(t);
    const deleted = '.ai-review/reviewers.yml';
    await writeFile(path.join(root, deleted), 'local reviewers\n');
    runCommand('svn', ['propset', 'review:preserved', 'yes', deleted], root);
    await writeFile(path.join(root, 'src/app.txt'), 'approved\n');
    const result = await vcs.atomicCommit({ message: 'fail', paths: ['src/app.txt'], deletePaths: [deleted], verifyEntries: [expected('src/app.txt', 'different\n')], verifyDeletions: [deleted] });
    assert.equal(result.success, false);
    assert.equal(await readFile(path.join(root, deleted), 'utf8'), 'local reviewers\n');
    assert.equal(runCommand('svn', ['propget', 'review:preserved', deleted], root).stdout.trim(), 'yes');
    assert.doesNotMatch(runCommand('svn', ['status', '--xml', '--', deleted], root).stdout, /item="deleted"/);
});

test('AC-RECOVERY-01：SVN 提交已发起后撞车保留新增调度和工作字节', async t => {
    const { root, repo, vcs } = await fixture(t);
    const other = path.join(path.dirname(root), 'other-wc');
    runCommand('svn', ['checkout', '-q', pathToFileURL(repo).href, other], path.dirname(root));
    await writeFile(path.join(other, 'src/app.txt'), 'remote changed\n');
    runCommand('svn', ['commit', '-qm', 'remote', 'src/app.txt'], other);
    await writeFile(path.join(root, 'src/app.txt'), 'approved local\n');
    await mkdir(path.join(root, 'new'));
    await writeFile(path.join(root, 'new/file.txt'), 'new local\n');
    const result = await vcs.atomicCommit({ message: 'collision', paths: ['src/app.txt', 'new/file.txt'], verifyEntries: [expected('src/app.txt', 'approved local\n'), expected('new/file.txt', 'new local\n')] });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.outOfDate, true, JSON.stringify(result));
    assert.equal(await readFile(path.join(root, 'src/app.txt'), 'utf8'), 'approved local\n');
    assert.equal(await readFile(path.join(root, 'new/file.txt'), 'utf8'), 'new local\n');
    assert.match(runCommand('svn', ['status', '--xml', '--', 'new/file.txt'], root).stdout, /item="added"/);
});

test('AC-READ-01：SVN 共享源从实际版本化子路径读取新候选及档案，并固定内容快照', async t => {
    const { root } = await fixture(t);
    const candidate = '.ai-review/2026-11/new-candidate';
    const audit = '.ai-review/audits/20261118-000000-new';
    await mkdir(path.join(root, candidate), { recursive: true });
    await mkdir(path.join(root, audit), { recursive: true });
    await writeFile(path.join(root, candidate, 'review.md'), 'shared review\n');
    await writeFile(path.join(root, candidate, '001.patch'), 'shared patch\n');
    await writeFile(path.join(root, audit, 'audit.md'), 'shared audit\n');
    runCommand('svn', ['add', candidate, audit], root);
    runCommand('svn', ['commit', '-qm', 'shared children', candidate, audit], root);
    assert.equal(runCommand('svn', ['info', '--show-item', 'revision', '.ai-review'], root).stdout.trim(), '1');
    const local = '.ai-review/2026-11/local-candidate';
    await mkdir(path.join(root, local), { recursive: true });
    await writeFile(path.join(root, local, 'review.md'), 'local review\n');
    runCommand('svn', ['add', local], root);
    const localAudit = '.ai-review/audits/20261118-000001-local';
    await mkdir(path.join(root, localAudit), { recursive: true });
    await writeFile(path.join(root, localAudit, 'audit.md'), 'local audit\n');
    runCommand('svn', ['add', localAudit], root);
    const source = new SvnBaseCandidateSource(root);
    assert.deepEqual(await source.listCandidateDirs(), ['2026-11/new-candidate']);
    assert.deepEqual(await source.listAuditDirs(), ['20261118-000000-new']);
    assert.deepEqual((await source.listDirEntries('2026-11', 'new-candidate')).sort(), ['001.patch', 'review.md']);
    await writeFile(path.join(root, candidate, 'review.md'), 'later review\n');
    runCommand('svn', ['commit', '-qm', 'later child', `${candidate}/review.md`], root);
    assert.equal(await source.readReviewText('2026-11', 'new-candidate'), 'shared review\n');
    assert.equal(await source.readPatchText('2026-11', 'new-candidate', '001.patch'), 'shared patch\n');
    assert.equal(await source.readAuditText('20261118-000000-new'), 'shared audit\n');
    assert.equal(await source.readReviewText('2026-11', 'local-candidate'), null);
    assert.equal(await source.readAuditText('20261118-000001-local'), null);
    assert.equal(await readFile(path.join(root, local, 'review.md'), 'utf8'), 'local review\n');
});

test('AC-READ-01：SVN 新仓库没有评审目录时共享候选及档案为空', async t => {
    const { root } = await fixture(t, false);
    const source = new SvnBaseCandidateSource(root);
    assert.deepEqual(await source.listCandidateDirs(), []);
    assert.deepEqual(await source.listAuditDirs(), []);
    assert.equal(await source.readReviewersText(), null);
});

test('AC-READ-01：SVN 未版本化评审目录只进入本地诊断', async t => {
    const { root } = await fixture(t, false);
    const candidate = '.ai-review/2026-11/local-candidate';
    await mkdir(path.join(root, candidate), { recursive: true });
    await writeFile(path.join(root, candidate, 'review.md'), 'local review\n');
    const source = new SvnBaseCandidateSource(root);
    assert.deepEqual(await source.listCandidateDirs(), []);
    assert.deepEqual(await source.listAuditDirs(), []);
    assert.equal(await source.readReviewText('2026-11', 'local-candidate'), null);
    assert.deepEqual(await source.listLocalOnlyDirs(), ['2026-11/local-candidate']);
});
