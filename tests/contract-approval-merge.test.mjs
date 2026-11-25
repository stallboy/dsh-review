import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ApprovalOrchestrator } from '../packages/dsh-plugin/dist/host/approval.js';
import { readSvnApprovalBinding } from '../packages/dsh-plugin/dist/host/approval-merge-snapshots.js';
import { GitHeadCandidateSource, SvnBaseCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { runCommand } from './helpers.mjs';

const file = 'sample.txt';
const timestamp = '2026-11-25T10:00:00+08:00';
const baseLines = Array.from({ length: 20 }, (_, index) => 'line ' + String(index + 1));
const body = (lines) => lines.join('\n') + '\n';

async function fixture(t, type, options = {}) {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dcr-contract-merge-'));
    t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const root = path.join(parent, 'wc');
    await mkdir(root);
    const call = (...args) => runCommand(type, args, root).stdout;
    if (type === 'svn') {
        runCommand('svnadmin', ['create', 'repo'], parent);
        call('checkout', '-q', pathToFileURL(path.join(parent, 'repo')).href, '.');
    } else {
        call('init', '-q');
        call('config', 'core.autocrlf', 'false');
    }
    const commit = (message, filePath) => {
        call('add', '--', filePath);
        call('commit', '-qm', message);
        if (type === 'svn') call('update', '-q');
    };
    await writeFile(path.join(root, file), body(baseLines));
    commit('business base', file);
    const vcs = createVcs(type, root);
    const baseline = await vcs.getCurrentBase();
    const source = type === 'svn' ? await readSvnApprovalBinding(root) : null;
    for (const [id, position, value] of [['first', 4, 'first edit'], ['second', options.sameLine ? 4 : 6, 'second edit']]) {
        const proposed = [...baseLines];
        proposed[position] = value;
        await writeFile(path.join(root, file), body(proposed));
        const patch = call('diff', '--', file);
        if (type === 'git') call('restore', '--', file);
        else call('revert', '--', file);
        const directory = '.ai-review/2026-11/' + id;
        await mkdir(path.join(root, directory), { recursive: true });
        await writeFile(path.join(root, directory, '001.patch'), patch);
        const gate = id === 'first' && options.firstGate ? options.firstGate
            : id === 'second' && options.secondGate ? options.secondGate
            : options.failSecond && id === 'second' ? 'node -e "process.exit(7)"' : 'node --version';
        await writeFile(path.join(root, directory, 'review.md'), [
            '---', 'schema_version: 1', 'title: "修复 ' + id + '"', 'module: review', 'audit_type: bugfix',
            'created_at: "' + timestamp + '"', 'updated_at: "' + timestamp + '"', 'owner: tester', 'tags: []',
            'status: pending', 'ticket: null', 'target_files: [sample.txt]', 'current_revision: 1', 'revisions:',
            '  - id: 1', '    base_revision: "' + baseline + '"', '    patch: 001.patch', '    author: ai',
            ...(source ? ['    svn_approval_source: ' + JSON.stringify({ uuid: source.uuid, relative_url: source.relativeUrl })] : []),
            'gate_checks: [' + JSON.stringify(gate) + ']', 'comments: []', 'human_decisions: []', 'approval: null',
            'rejection: null', 'commit_message: "修复 ' + id + '"', '---', '', '# 需人工判断项', '- 无', '',
        ].join('\n'));
    }
    commit('candidate patches', '.ai-review');
    const store = new ReviewStore(root);
    const log = [];
    const orchestrator = new ApprovalOrchestrator({
        store, vcs,
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, vcsType: type, owner: 'tester', autoFixOnFailure: false, syncBeforeApprove: false },
        sharedSource: async () => type === 'svn' ? new SvnBaseCandidateSource(root) : await GitHeadCandidateSource.create(root) ?? undefined,
        makeRunner: () => { throw new Error('自动修复已关闭'); },
    });
    const approve = (id) => orchestrator.approve('2026-11/' + id, {
        expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: timestamp,
    }, 'merge-fixture', (line) => log.push(line));
    return { root, approve, log, call, vcs };
}

for (const type of ['git', 'svn']) {
    for (const order of [['first', 'second'], ['second', 'first']]) {
        test(type + ' 原生交付相邻候选 ' + order.join('→'), async (t) => {
            const { root, approve, log, call } = await fixture(t, type);
            const first = await approve(order[0]);
            assert.equal(first.status, 'COMMITTED', JSON.stringify(first));
            assert.ok(!log.some(line => line.includes('三方合并')));
            const second = await approve(order[1]);
            assert.equal(second.status, 'COMMITTED', JSON.stringify(second));
            assert.notEqual(first.commitRevision, second.commitRevision);
            assert.ok(log.some(line => line.includes('待交付差异与已审修改相符')), log.join('\n'));
            const expected = [...baseLines];
            expected[4] = 'first edit';
            expected[6] = 'second edit';
            assert.equal(await readFile(path.join(root, file), 'utf8'), body(expected));
            const committed = type === 'git'
                ? call('show', second.commitRevision + ':' + file)
                : call('cat', '-r', second.commitRevision, file);
            assert.equal(committed, body(expected));
        });
    }
}

test('Git 真实冲突保留先前提交和当前候选', async (t) => {
    const { root, approve, log } = await fixture(t, 'git', { sameLine: true });
    assert.equal((await approve('first')).status, 'COMMITTED');
    const result = await approve('second');
    assert.equal(result.status, 'FALLBACK_TO_PENDING', JSON.stringify(result));
    assert.equal(result.reason, 'PATCH_CONFLICT');
    assert.match(result.message, /文本冲突/);
    assert.match(await readFile(path.join(root, file), 'utf8'), /first edit/);
    assert.equal(log.filter(line => line.includes('开始执行门禁')).length, 1);
});

test('Git 合并后的组合门禁失败只撤销本次修改', async (t) => {
    const { root, approve, log, vcs } = await fixture(t, 'git', { failSecond: true });
    const first = await approve('first');
    assert.equal(first.status, 'COMMITTED');
    const result = await approve('second');
    assert.equal(result.status, 'FALLBACK_TO_PENDING', JSON.stringify(result));
    assert.equal(result.reason, 'GATE_CHECK_FAILED');
    assert.ok(log.some(line => line.includes('待交付差异与已审修改相符')));
    assert.equal(await vcs.getCurrentBase(), first.commitRevision);
    assert.equal((await vcs.ensureCleanWorkspace()).clean, true);
    const expected = [...baseLines];
    expected[4] = 'first edit';
    assert.equal(await readFile(path.join(root, file), 'utf8'), body(expected));
});


test('门禁改写已核对的合并文件时保留现场，且不会提交', async (t) => {
    const { root, approve, vcs } = await fixture(t, 'git', {
        secondGate: "node -e \"require('node:fs').writeFileSync('sample.txt', 'changed by gate')\"",
    });
    const first = await approve('first');
    assert.equal(first.status, 'COMMITTED');
    const result = await approve('second');
    assert.equal(result.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
    assert.equal(await vcs.getCurrentBase(), first.commitRevision);
    assert.equal(await readFile(path.join(root, file), 'utf8'), 'changed by gate');
});

test('门禁切换到相同 HEAD 的其他 Git 分支时保留现场且停止提交', async (t) => {
    const { approve, vcs, call } = await fixture(t, 'git', { secondGate: 'git switch -c same-sha-target' });
    const first = await approve('first');
    assert.equal(first.status, 'COMMITTED');
    const result = await approve('second');
    assert.equal(result.status, 'RECOVERY_REQUIRED', JSON.stringify(result));
    assert.equal(await vcs.getCurrentBase(), first.commitRevision);
    assert.equal(call('branch', '--show-current').trim(), 'same-sha-target');
});

test('SVN 原生审批门禁失败后撤销补丁并保留并发草稿', async (t) => {
    const { root, approve, log, call } = await fixture(t, 'svn', { firstGate: 'node -e "process.exit(7)"' });
    const revision = call('info', '-r', 'HEAD', '--show-item', 'revision').trim();
    const draft = path.join(root, 'concurrent-draft.txt');
    const push = log.push.bind(log);
    log.push = (line) => {
        if (line.includes('开始执行门禁')) writeFileSync(draft, '用户草稿');
        return push(line);
    };
    const outcome = await approve('first');
    assert.equal(await readFile(draft, 'utf8'), '用户草稿');
    assert.equal(await readFile(path.join(root, file), 'utf8'), body(baseLines));
    assert.equal(outcome.status, 'RECOVERY_REQUIRED', JSON.stringify(outcome));
    assert.equal(call('info', '-r', 'HEAD', '--show-item', 'revision').trim(), revision);
});

test('Git 在提交探针时切换到同 SHA 的另一分支，审批不推进任一分支', async (t) => {
    const { approve, vcs, log, call } = await fixture(t, 'git');
    const first = await approve('first');
    assert.equal(first.status, 'COMMITTED');
    const original = call('symbolic-ref', 'HEAD').trim();
    const probe = vcs.getCommitProbe.bind(vcs);
    let switched = false;
    vcs.getCommitProbe = (paths) => {
        if (!switched) {
            switched = true;
            call('switch', '-qc', 'same-sha-after-gates');
        }
        return probe(paths);
    };
    const second = await approve('second');
    assert.ok(switched);
    assert.ok(log.some(line => line.includes('待交付差异与已审修改相符')));
    assert.equal(second.status, 'RECOVERY_REQUIRED', JSON.stringify(second));
    assert.equal(call('rev-parse', original).trim(), first.commitRevision);
    assert.equal(call('rev-parse', 'refs/heads/same-sha-after-gates').trim(), first.commitRevision);
    assert.match(call('show', 'HEAD:.ai-review/2026-11/second/review.md'), /^status: pending$/m);
});

test('Git 审批保留状态干净但尚未完成的用户合并', async (t) => {
    const { approve, call, log, root } = await fixture(t, 'git');
    const original = call('branch', '--show-current').trim();
    call('switch', '-qc', 'other-merge-side');
    call('commit', '--allow-empty', '-qm', 'other side');
    call('switch', '-q', original);
    call('commit', '--allow-empty', '-qm', 'original side');
    const head = call('rev-parse', 'HEAD').trim();
    call('merge', '--no-ff', '--no-commit', 'other-merge-side');
    const mergeHead = call('rev-parse', 'MERGE_HEAD').trim();
    assert.equal(call('status', '--porcelain').trim(), '');
    const result = await approve('first');
    assert.equal(result.status, 'ABORTED', JSON.stringify(result));
    assert.equal(result.reason, 'SYNC_FAILED');
    assert.equal(call('rev-parse', 'HEAD').trim(), head);
    assert.equal(call('rev-parse', 'MERGE_HEAD').trim(), mergeHead);
    assert.equal(await readFile(path.join(root, file), 'utf8'), body(baseLines));
    assert.ok(log.every(line => !line.includes('开始执行门禁')));
});
