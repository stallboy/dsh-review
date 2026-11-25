import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ApprovalOrchestrator } from '../packages/dsh-plugin/dist/host/approval.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { SvnBaseCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { classifySvnApprovalPatch, SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { runCommand } from './helpers.mjs';

const file = 'sample.txt';
const candidate = '2026-11/svn-approval';
const directory = '.ai-review/' + candidate;
const timestamp = '2026-11-25T10:00:00+08:00';
const base = Array.from({ length: 20 }, (_, index) => 'line ' + String(index + 1));
const changed = [...base];
changed[4] = 'first edit';
changed[15] = 'second edit';

async function fixture(t, preset) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dcr-svn-approval-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'wc');
    await mkdir(root);
    runCommand('svnadmin', ['create', 'repo'], parent);
    runCommand('svn', ['checkout', '-q', pathToFileURL(path.join(parent, 'repo')).href, '.'], root);
    const svn = (...args) => runCommand('svn', ['--non-interactive', ...args], root).stdout;
    const contents = (lines) => lines.join('\n') + '\n';
    await writeFile(path.join(root, file), contents(base));
    svn('add', file);
    svn('commit', '-qm', 'base');
    await writeFile(path.join(root, file), contents(changed));
    const patch = svn('diff', '--', file);
    svn('revert', file);
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, '001.patch'), patch);
    await writeFile(path.join(root, directory, 'review.md'), [
        '---', 'schema_version: 1', 'title: "修复 SVN 样例"', 'module: svn', 'audit_type: bugfix',
        'created_at: "' + timestamp + '"', 'updated_at: "' + timestamp + '"', 'owner: tester',
        'tags: []', 'status: pending', 'ticket: null', 'target_files: [sample.txt]', 'current_revision: 1',
        'revisions:', '  - id: 1', '    base_revision: "1"', '    patch: 001.patch', '    author: ai',
        'gate_checks: ["node --version"]', 'comments: []', 'human_decisions: []', 'approval: null',
        'rejection: null', 'commit_message: "修复 SVN 样例"', '---', '', '# 问题与影响', '', '# 需人工判断项', '- 无', '',
    ].join('\n'));
    svn('add', '.ai-review');
    svn('commit', '-qm', 'candidate');
    if (preset === 'missing') {
        svn('delete', file);
        svn('commit', '-qm', 'remove target');
    } else if (preset) {
        await writeFile(path.join(root, file), contents(preset));
        svn('commit', '-qm', 'advance target');
    }
    svn('update', '-q');
    const store = new ReviewStore(root);
    const log = [];
    const vcs = new SvnAdapter(root);
    const approval = new ApprovalOrchestrator({
        store, vcs,
        settings: { ...DEFAULT_SETTINGS, vcsType: 'svn', repoRoot: root, owner: 'tester', runner: 'manual', autoFixOnFailure: false },
        sharedSource: async () => new SvnBaseCandidateSource(root),
        makeRunner: () => { throw new Error('自动修复已关闭'); },
    });
    const approve = () => approval.approve(candidate, {
        expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: timestamp,
    }, 'svn-approval-fixture', (line) => log.push(line));
    return { approve, contents, log, root, svn, vcs };
}

const conflicting = [...base];
conflicting[4] = 'upstream changed this line';
const partial = [...base];
partial[4] = changed[4];

for (const [name, preset, diagnostic] of [
    ['拒绝一个块', conflicting, /rejected hunk/],
    ['一个块已生效', partial, /already applied/],
    ['所有块已生效', changed, /already applied/],
    ['目标已删除', 'missing', /rejected hunk/],
]) {
    test('SVN 退出码为 0 仍拒绝不完整应用：' + name, async (t) => {
        const { approve, contents, log, root, svn } = await fixture(t, preset);
        const revision = svn('info', '-r', 'HEAD', '--show-item', 'revision').trim();
        const raw = svn('patch', '--dry-run', '--', directory + '/001.patch');
        assert.match(raw, diagnostic);
        const outcome = await approve();
        assert.equal(outcome.status, 'FALLBACK_TO_PENDING', JSON.stringify(outcome));
        assert.equal(outcome.reason, 'PATCH_CONFLICT');
        assert.match(outcome.message, diagnostic);
        assert.ok(log.every((line) => !line.includes('开始执行门禁')));
        assert.equal(svn('info', '-r', 'HEAD', '--show-item', 'revision').trim(), revision);
        assert.equal(svn('status', '--no-ignore').trim(), '');
        if (preset !== 'missing') assert.equal(await readFile(path.join(root, file), 'utf8'), contents(preset));
        assert.match(svn('cat', '-r', 'HEAD', directory + '/review.md'), /^status: pending$/m);
        assert.match(svn('cat', '-r', 'HEAD', directory + '/001.patch'), /second edit/);
    });
}

test('SVN 完整应用后通过门禁并提交原生版本', async (t) => {
    const { approve, contents, log, svn } = await fixture(t);
    const outcome = await approve();
    assert.equal(outcome.status, 'COMMITTED', JSON.stringify(outcome));
    assert.equal(svn('cat', '-r', outcome.commitRevision, file), contents(changed));
    assert.ok(log.some((line) => line.includes('门禁检查全部通过')));
    assert.match(svn('cat', '-r', outcome.commitRevision, directory + '/review.md'), /^status: approved$/m);
});


test('SVN 审批区分跳过目标和超限输出', () => {
    const result = { code: 0, signal: null, timedOut: false, stdout: "Skipped 'sample.txt'\n", stderr: '' };
    assert.equal(classifySvnApprovalPatch(result), 'conflict');
    assert.equal(classifySvnApprovalPatch({
        ...result, stdout: 'U         sample.txt\n>         applied hunk @@ -4,7 +4,7 @@ with fuzz 2\n',
    }), 'conflict');
    assert.equal(classifySvnApprovalPatch({
        ...result, stdout: 'U         sample.txt\n>         applied hunk @@ -4,7 +4,7 @@ with offset 1\n',
    }), 'complete');
    assert.equal(classifySvnApprovalPatch({ ...result, stdout: 'U         sample.txt\n' }, 12), 'unknown');
    assert.equal(classifySvnApprovalPatch({ ...result, stdout: 'U         sample.txt\n', timedOut: true }), 'unknown');
});

test('SVN 实际应用结果不确定时保留现场，跳过门禁和业务提交', async (t) => {
    const { approve, log, root, svn, vcs } = await fixture(t);
    const revision = svn('info', '-r', 'HEAD', '--show-item', 'revision').trim();
    const concurrent = path.join(root, 'concurrent.txt');
    vcs.applyPatchForApproval = async () => {
        await writeFile(concurrent, 'external work');
        return { ok: false, conflict: true, workspace: 'unknown', message: '实际应用结果不明' };
    };
    const outcome = await approve();
    assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
    assert.equal(outcome.reason, 'SYNC_STATE_UNKNOWN');
    assert.ok(log.every((line) => !line.includes('开始执行门禁')));
    assert.equal(await readFile(concurrent, 'utf8'), 'external work');
    assert.equal(svn('info', '-r', 'HEAD', '--show-item', 'revision').trim(), revision);
    assert.match(svn('cat', '-r', 'HEAD', directory + '/review.md'), /^status: pending$/m);
});
