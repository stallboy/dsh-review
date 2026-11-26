import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, rm, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { AuditStages } from '../packages/dsh-plugin/dist/host/audit-stages.js';
import { GitAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { runProcess } from '../packages/dsh-plugin/dist/host/shell.js';
import { restrictAuditSession, releaseAuditSessionRestrictions } from '../packages/dsh-plugin/dist/host/audit-session-permissions.js';
import { createGitFixture, runCommand } from './helpers.mjs';

const scanTask = { taskScope: ['src'], scenarios: [], questions: [], constraints: [] };
const verifyTask = { subjectId: 'math', scenario: 'reachable_behavior', navigation: [{ path: 'src/math.js', line: 1 }], expectationIndexes: [] };
const emptyPublication = { findings: [], coverage: [], requirements: [], history: [] };
const scanResult = { leads: [{ leadId: 'math', entry: 'math', navigation: verifyTask.navigation,
    preconditions: ['调用函数'], expectedBehavior: '计算结果', suspectedImpact: '错误结果' }], coverage: [], limits: [] };

async function stages(t, execute) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const vcs = new GitAdapter(root);
    const lease = { auditId: '20261126-120000-test', root, baseRevision: await vcs.getCurrentBase(), targetPath: '',
        trigger: 'manual', owner: 'tester', createdAt: new Date().toISOString(), candidateIdsBefore: [], state: 'active' };
    const stage = new AuditStages(lease, vcs, { defaultOwner: 'tester', rules: [], allowedGateCommands: ['node --version'] }, execute);
    return { stage, root, run: (phase, task) => stage.run(phase, 'codex', task, new AbortController().signal) };
}

test('审查阶段使用真实 cwd 自主读取超过旧上限的大文件，提示词不装载源码', async t => {
    const fixture = await stages(t, async input => {
        input.onProcessTreeStopped(true);
        assert.equal(input.repoRoot, fixture.root);
        assert.doesNotMatch(input.prompt, /固定基线只读视图|read-marker-中文/);
        const text = await readFile(path.join(input.repoRoot, 'src/large.txt'), 'utf8');
        assert.ok(text.length > 150_000);
        assert.ok(text.endsWith('read-marker-中文\n'));
        return scanResult;
    });
    await writeFile(path.join(fixture.root, 'src/large.txt'), 'x'.repeat(150_000) + '\nread-marker-中文\n');
    runCommand('git', ['add', 'src/large.txt'], fixture.root);
    runCommand('git', ['commit', '-qm', 'large file'], fixture.root);
    fixture.stage.lease.baseRevision = await new GitAdapter(fixture.root).getCurrentBase();
    await fixture.run('scan', scanTask);
    assert.equal(fixture.stage.uncertain, false);
});

test('取证文件先归档还原，实验改写的源码不能冒充真实问题证据', async t => {
    let original;
    const fixture = await stages(t, async input => {
        input.onProcessTreeStopped(true);
        if (input.prompt.startsWith('# 初审')) return scanResult;
        await writeFile(path.join(input.repoRoot, 'src/math.js'), 'export const add = () => 999;\n');
        return { verdict: 'confirmed', reason: '实验现象', preconditions: ['调用函数'], observedBehavior: '返回 999', impact: '计算错误',
            evidence: [{ path: 'src/math.js', line: 1, excerpt: 'export const add = () => 999;', reason: '实验文件' }], limits: [] };
    });
    original = await readFile(path.join(fixture.root, 'src/math.js'), 'utf8');
    const mode = (await stat(path.join(fixture.root, 'src/math.js'))).mode;
    await fixture.run('scan', scanTask);
    const verdict = await fixture.run('verify', { ...verifyTask, forensicPaths: ['src/math.js'] });
    assert.equal(verdict.verdict, 'insufficient_evidence');
    assert.equal(await readFile(path.join(fixture.root, 'src/math.js'), 'utf8'), original);
    assert.equal((await stat(path.join(fixture.root, 'src/math.js'))).mode, mode);
    const archived = path.join(fixture.root, '.ai-review/audits', fixture.stage.lease.auditId, 'evidence/verify-2/forensics/src/math.js');
    assert.match(await readFile(archived, 'utf8'), /999/);
});

for (const failure of [false, true]) test(`进程树停止未确认阻断发布（执行器${failure ? '抛异常' : '返回结果'}）`, async t => {
    let calls = 0;
    const fixture = await stages(t, async input => {
        input.onProcessTreeStopped(++calls === 1);
        if (calls === 1) return scanResult;
        if (failure) throw new Error('执行器异常');
        return { verdict: 'insufficient_evidence', reason: '未完成', preconditions: [], observedBehavior: '', impact: '', evidence: [], limits: [] };
    });
    await fixture.run('scan', scanTask);
    await assert.rejects(fixture.run('verify', verifyTask));
    assert.equal(fixture.stage.uncertain, true);
    assert.equal(await fixture.stage.stageStopConfirmed, false);
    await assert.rejects(fixture.stage.publication(emptyPublication), /恢复事项/);
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

test('真实 Cordis 代理按审查会话限制写根，继承子会话并在停止后卸载恢复', async t => {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const ctx = new Context();
    class Policy extends Service {
        constructor(ctx) { super(ctx, 'sandboxPolicy'); }
        resolve(input = {}) { return { mode: input.mode ?? 'read-only', workspaceRoot: input.session?.header.cwd ?? 'default', additionalWritableRoots: [root] }; }
    }
    new Policy(ctx);
    const captured = ctx.get('sandboxPolicy', false);
    const sessions = new Map([['audit', { id: 'audit', header: { cwd: root } }], ['other', { id: 'other', header: { cwd: root } }]]);
    const agents = new Map([['audit', { session: sessions.get('audit') }]]);
    const events = new EventEmitter();
    const policies = [];
    let toolGuard;
    let toolGuardCount = 0;
    const agentContext = { get: () => ({ guard: callback => { toolGuardCount++; toolGuard = callback; return () => { toolGuard = undefined; }; } }) };
    agents.get('audit').ctx = agentContext;
    let host;
    const fiber = ctx.plugin(scope => {
        host = { get(name) { return ({ sessions: { get: id => sessions.get(id) }, agents: { get: id => agents.get(id) },
            fs: { sandboxMode: 'workspace-write' }, shell: { sandboxMode: 'workspace-write' },
            tools: { guard: callback => { toolGuardCount++; toolGuard = callback; return () => { toolGuard = undefined; }; } },
            approval: { setPolicy: (agent, policy) => policies.push([agent.session.id, policy]) } })[name] ?? scope.get(name, false); },
        on(name, callback) { events.on(name, callback); return () => events.off(name, callback); } };
        scope.effect(() => async () => { agents.clear(); assert.equal(await releaseAuditSessionRestrictions(host), true); });
    });
    await fiber.inertia;
    await restrictAuditSession(host, 'audit', root);
    assert.equal(captured.resolve({ session: sessions.get('audit'), mode: 'danger-full-access' }).workspaceRoot, path.join(root, '.ai-review'));
    assert.equal(captured.resolve({ session: sessions.get('other') }).workspaceRoot, root);
    assert.deepEqual(captured.resolve({ session: sessions.get('audit') }).additionalWritableRoots, []);
    assert.deepEqual(captured.resolve({ session: sessions.get('other') }).additionalWritableRoots, [root]);
    assert.equal(captured.resolve().workspaceRoot, 'default');
    assert.match(toolGuard({ name: 'subagent_oar', agent: agents.get('audit') }), /继承工作目录和写权限/);
    assert.equal(toolGuard({ name: 'subagent_oar', agent: { session: sessions.get('other') } }), undefined);
    assert.equal(toolGuard({ name: 'shell', agent: agents.get('audit') }), undefined);
    assert.match(toolGuard({ name: 'worktree_create', agent: agents.get('audit') }), /继承工作目录和写权限/);
    assert.equal(toolGuard({ name: 'worktree_status', agent: agents.get('audit') }), undefined);
    const child = { id: 'child', header: { cwd: root, parentSession: 'audit' } };
    sessions.set('child', child);
    events.emit('agent/created', { agent: { session: child, ctx: agentContext } });
    sessions.delete('audit');
    assert.equal(captured.resolve({ session: child }).workspaceRoot, path.join(root, '.ai-review'));
    assert.match(toolGuard({ name: 'subagent_oar', agent: { session: child } }), /受控 runAuditStage/);
    assert.deepEqual(policies, [['audit', 'never'], ['child', 'never']]);
    events.emit('agent/created', { agent: { session: child, ctx: agentContext } });
    assert.equal(toolGuardCount, 3);
    child.header.cwd = path.join(root, 'src');
    assert.throws(() => captured.resolve({ session: child }), /目录已变化/);
    await fiber.dispose();
    assert.equal(captured.resolve({ session: child }).workspaceRoot, child.header.cwd);
    assert.equal(toolGuard, undefined);
});
