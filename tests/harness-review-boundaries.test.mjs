import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AuditStageSession } from '../packages/dsh-plugin/dist/host/audit-stages.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { runProcess } from '../packages/dsh-plugin/dist/host/shell.js';
import { createGitFixture, runCommand } from './helpers.mjs';

const scanTask = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
const verifyTask = { subjectId: 'math', scenario: 'reachable_behavior', navigation: { path: 'src/math.js', line: 1 }, expectationIndexes: [] };
const emptyPublication = { findings: [], coverage: [], requirements: [], history: [] };
const scanOutput = {
    leads: [{
        leadId: 'math',
        entry: 'add',
        path: 'src/math.js',
        line: 1,
        precondition: '调用函数',
        expected: '返回两数之和',
        impact: '返回错误差值',
    }],
    coverage: ['src/math.js'],
    limits: [],
};

async function createStageFixture(t, executor) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', 'init reviewers'], root);
    const vcs = new GitAdapter(root);
    const store = new ReviewStore(root);
    const baseRevision = await vcs.getCurrentBase();
    const session = new AuditStageSession({
        auditId: '20261126-120000-test',
        root,
        scope: '.',
        baseRevision,
        trigger: 'manual',
        owner: 'tester',
        note: '',
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        vcs,
        store,
        source: await GitHeadCandidateSource.create(root),
        stageExecutors: ['codex', 'dsh-subagent'],
        executor,
    });
    return { session, root, vcs, store, run: (stage, task) => session.runStage(stage, 'codex', task, new AbortController().signal) };
}

test('审查阶段使用真实 cwd 自主读取超过旧上限的大文件，提示词不装载源码', async t => {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    await writeFile(path.join(root, 'src/large.txt'), 'x'.repeat(150_000) + '\nread-marker-中文\n');
    runCommand('git', ['add', '-A'], root);
    runCommand('git', ['commit', '-qm', 'large file'], root);
    const vcs = new GitAdapter(root);
    const baseRevision = await vcs.getCurrentBase();
    const session = new AuditStageSession({
        auditId: '20261126-120000-large',
        root,
        scope: '.',
        baseRevision,
        trigger: 'manual',
        owner: 'tester',
        note: '',
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        vcs,
        store: new ReviewStore(root),
        source: await GitHeadCandidateSource.create(root),
        stageExecutors: ['codex'],
        executor: async (input) => {
            assert.equal(input.cwd, root);
            assert.doesNotMatch(input.prompt, /固定基线只读视图|read-marker-中文/);
            const text = await readFile(path.join(input.cwd, 'src/large.txt'), 'utf8');
            assert.ok(text.length > 150_000);
            assert.ok(text.endsWith('read-marker-中文\n'));
            return { ok: true, output: scanOutput, executorUsed: 'codex' };
        },
    });
    const res = await session.runStage('scan', 'codex', scanTask, new AbortController().signal);
    assert.equal(res.ok, true);
    assert.equal(res.leads.length, 1);
});

test('SPEC §5.3 软引导 + Host 强还原：子阶段实验改写被彻底还原、.tmp 被清空且篡改源码不能冒充基线证据', async t => {
    const fixture = await createStageFixture(t, async (input) => {
        if (input.stage === 'scan') return { ok: true, output: scanOutput, executorUsed: 'codex' };
        await writeFile(path.join(input.cwd, 'src/math.js'), 'export const add = () => 999;\n');
        await mkdir(path.join(input.cwd, '.tmp'), { recursive: true });
        await writeFile(path.join(input.cwd, '.tmp/scratch.txt'), 'temp scratch');
        return {
            ok: true,
            executorUsed: 'codex',
            output: {
                verdict: 'confirmed',
                reason: '实验现象',
                evidence: [{ path: 'src/math.js', line: 1, excerpt: 'export const add = () => 999;', reason: '实验文件' }],
            },
        };
    });
    const original = await readFile(path.join(fixture.root, 'src/math.js'), 'utf8');
    const mode = (await stat(path.join(fixture.root, 'src/math.js'))).mode;
    await fixture.run('scan', scanTask);
    const verdict = await fixture.run('verify', verifyTask);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verdict, 'insufficient_evidence');
    assert.equal(await readFile(path.join(fixture.root, 'src/math.js'), 'utf8'), original);
    assert.equal((await stat(path.join(fixture.root, 'src/math.js'))).mode, mode);
    await assert.rejects(stat(path.join(fixture.root, '.tmp/scratch.txt')));
});

for (const failure of [false, true]) test(`子阶段失败或未完成初审时安全隔离且阻断非法发布（执行器${failure ? '抛异常' : '返回失败'}）`, async t => {
    let stageStates = [];
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, '.ai-review'), { recursive: true });
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', 'init reviewers'], root);
    const vcs = new GitAdapter(root);
    const session = new AuditStageSession({
        auditId: '20261126-120000-fail',
        root,
        scope: '.',
        baseRevision: await vcs.getCurrentBase(),
        trigger: 'manual',
        owner: 'tester',
        note: '',
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        vcs,
        store: new ReviewStore(root),
        source: await GitHeadCandidateSource.create(root),
        stageExecutors: ['codex'],
        onStageStateChange: async (active) => { stageStates.push(active); },
        executor: async () => {
            if (failure) throw new Error('执行器异常');
            return { ok: false, reason: 'runner_failed', diagnostic: '子进程失败' };
        },
    });
    if (failure) {
        await assert.rejects(session.runStage('scan', 'codex', scanTask, new AbortController().signal), /执行器异常/);
    } else {
        const res = await session.runStage('scan', 'codex', scanTask, new AbortController().signal);
        assert.equal(res.ok, false);
    }
    assert.deepEqual(stageStates, [true, false]);
    await assert.rejects(session.publish(emptyPublication, new AbortController().signal), /至少需要完成一次初审/);
});

test('UTF-8 JSON 跨输出 chunk 保留中文原文', async () => {
    const lines = [];
    const program = String.raw`const b=Buffer.from(JSON.stringify({excerpt:'中文证据'})+'\n');const i=b.indexOf(Buffer.from('中'));process.stdout.write(b.subarray(0,i+1));setTimeout(()=>process.stdout.end(b.subarray(i+1)),30);`;
    const result = await runProcess(process.execPath, ['-e', program], { cwd: process.cwd(), timeoutMs: 10_000, killTreeOnExit: true,
        onLine: line => lines.push(line) });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.processTreeStopped, true);
    assert.equal(JSON.parse(lines[0]).excerpt, '中文证据');
});

for (const mode of ['normal', 'timeout', 'cancel']) test(`原生进程组结束并清理遗留子进程：${mode}`, async () => {
    const controller = new AbortController();
    const program = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});console.log(child.pid);child.unref();${mode === 'normal' ? '' : 'setInterval(()=>{},1000);'}`;
    let timer;
    if (mode === 'cancel') timer = setTimeout(() => controller.abort(), 1500);
    try {
        const result = await runProcess(process.execPath, ['-e', program], { cwd: process.cwd(), killTreeOnExit: true,
            timeoutMs: mode === 'timeout' ? 1500 : 10_000, signal: controller.signal });
        assert.equal(result.processTreeStopped, true, JSON.stringify(result));
        assert.equal(result.timedOut, mode === 'timeout');
        assert.equal(result.aborted, mode === 'cancel');
        const pid = Number(result.stdout.trim());
        assert.ok(pid > 0, JSON.stringify(result));
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally { clearTimeout(timer); }
});

test('I18 / D02：patch 阶段未复核拒绝、畸形 optionId 不占死 2 方案名额、禁止修改 .ai-review 路径', async t => {
    let callIdx = 0;
    const fixture = await createStageFixture(t, async (input) => {
        if (input.stage === 'scan') return { ok: true, output: scanOutput, executorUsed: 'codex' };
        if (input.stage === 'verify') {
            return {
                ok: true,
                executorUsed: 'codex',
                output: {
                    verdict: 'confirmed',
                    reason: '确认运算符写反',
                    evidence: [{ path: 'src/math.js', line: 1, excerpt: 'export const add = (a, b) => a - b;', reason: '减号' }],
                },
            };
        }
        callIdx += 1;
        if (callIdx === 1) {
            // 第一次返回畸形 optionId：不应占用 2 方案名额
            return {
                ok: true,
                executorUsed: 'codex',
                output: { status: 'ready', optionId: 'INVALID_ID!', patchPath: 'x.patch', summary: 'bad', tradeoff: 't', confidence: 80, humanDecisions: [], reason: 'r' },
            };
        }
        const patchFile = path.join(input.artifactDir, `opt-${callIdx}.patch`);
        if (callIdx === 2) {
            // 第二次返回越界路径（.ai-review/reviewers.yml）
            await writeFile(patchFile, 'diff --git a/.ai-review/reviewers.yml b/.ai-review/reviewers.yml\n--- a/.ai-review/reviewers.yml\n+++ b/.ai-review/reviewers.yml\n@@ -1 +1 @@\n-default_owner: tester\n+default_owner: evil\n', 'utf8');
            return {
                ok: true,
                executorUsed: 'codex',
                output: { status: 'ready', optionId: 'opt-evil', patchPath: path.relative(fixture.root, patchFile), summary: 'evil', tradeoff: 't', confidence: 80, humanDecisions: [], reason: 'r' },
            };
        }
        // 第三、四次返回两个合法互斥方案，仍能成功占满 2 方案名额
        const to = callIdx === 3 ? 'export const add = (a, b) => a + b;' : 'export const add = (a, b) => Number(a) + Number(b);';
        await writeFile(patchFile, `diff --git a/src/math.js b/src/math.js\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+${to}\n`, 'utf8');
        return {
            ok: true,
            executorUsed: 'codex',
            output: {
                status: 'ready',
                optionId: callIdx === 3 ? 'opt-a' : 'opt-b',
                title: callIdx === 3 ? '直接修正' : '显式数值转换',
                patchPath: path.relative(fixture.root, patchFile),
                summary: '修复加法',
                tradeoff: '权衡说明',
                confidence: 90,
                humanDecisions: [],
                reason: 'ok',
            },
        };
    });
    const patchTask = { subjectId: 'math', auditType: 'bugfix', allowedPaths: ['src/math.js'], gateCommands: ['node --version'], acceptance: ['加法正确'] };
    await fixture.run('scan', scanTask);
    await assert.rejects(fixture.run('patch', patchTask), /独立复核确认/);
    await fixture.run('verify', verifyTask);

    const badOpt = await fixture.run('patch', patchTask);
    assert.equal(badOpt.ok, false);
    assert.match(badOpt.diagnostic, /optionId/);

    const evilPath = await fixture.run('patch', patchTask);
    assert.equal(evilPath.ok, false);
    assert.match(evilPath.diagnostic, /允许范围之外|禁止路径/);

    const optA = await fixture.run('patch', patchTask);
    assert.equal(optA.ok, true, JSON.stringify(optA));
    assert.equal(optA.registeredCount, 1);

    const optB = await fixture.run('patch', patchTask);
    assert.equal(optB.ok, true, JSON.stringify(optB));
    assert.equal(optB.registeredCount, 2);

    await assert.rejects(fixture.run('patch', patchTask), /已达上限/);
});
