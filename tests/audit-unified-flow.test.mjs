import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compatibleAuditBase, readSvnAuditUrl } from '../packages/dsh-plugin/dist/host/audit-stage-artifacts.js';
import { SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { fullPatch, taskData } from './fixtures/proposal-patch.mjs';
import { runAuditChannel } from './fixtures/phased-audit-agent.mjs';

const source = 'export const add = (a, b) => a - b;';

async function workspace(t, vcsType) {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-unified-audit-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const root = vcsType === 'git' ? await createGitFixture() : path.join(temp, 'working-copy');
    if (vcsType === 'git') t.after(() => rm(root, { recursive: true, force: true }));
    else {
        const repo = path.join(temp, 'repo');
        runCommand('svnadmin', ['create', repo], temp);
        runCommand('svn', ['checkout', pathToFileURL(repo).href, root], temp);
        await mkdir(path.join(root, 'src'));
        await writeFile(path.join(root, 'src/math@case.js'), source + '\n');
        runCommand('svn', ['add', 'src'], root);
    }
    await mkdir(path.join(root, '.ai-review'));
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: tester\nrules: []\n');
    runCommand(vcsType, vcsType === 'git' ? ['add', '-A'] : ['add', '.ai-review'], root);
    runCommand(vcsType, ['commit', '-m', 'audit baseline'], root);
    if (vcsType === 'svn') runCommand('svn', ['update'], root);
    return { root, temp };
}

test('SVN 同 revision 切换目录后不能沿用原审查基线', async t => {
    const { root, temp } = await workspace(t, 'svn');
    const repo = pathToFileURL(path.join(temp, 'repo')).href;
    runCommand('svn', ['copy', repo + '/src', repo + '/alternate', '-m', 'create alternate'], root);
    runCommand('svn', ['update'], root);
    const vcs = new SvnAdapter(root);
    const revision = await vcs.getCurrentBase();
    const original = await readSvnAuditUrl(root);
    assert.equal(await compatibleAuditBase(vcs, revision, original), true);
    runCommand('svn', ['switch', '--ignore-ancestry', '-r', revision, repo + '/alternate'], root);
    assert.equal(await vcs.getCurrentBase(), revision);
    assert.equal(await compatibleAuditBase(vcs, revision, original), false);
});

test('外部通道随 Host 关闭撤销，重启后的未封存租约仍可核验释放', async t => {
    const { root, temp } = await workspace(t, 'git');
    const deps = {
        settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git' },
        statePath: path.join(temp, 'runtime.json'),
        saveSettings: async settings => settings,
        auditStageExecutor: async () => { throw new Error('测试不会派发阶段'); },
    };
    const api = new ReviewApi(deps);
    await api.init();
    const request = (api, endpoint, body = {}) => api.invoke({ method: 'POST', path: endpoint, body });
    const start = await request(api, '/audit/manual');
    const { auditId, prompt } = start.body;
    const address = /http:\/\/127\.0\.0\.1:\d+\//.exec(prompt)?.[0];
    assert.ok(address);
    await api.closeAudit();
    await assert.rejects(fetch(address, { method: 'POST' }));
    const restarted = new ReviewApi(deps);
    await restarted.init();
    assert.equal((await request(restarted, '/audit/release', { auditId, confirmStopped: true })).status, 409);
    await restarted.leaseTransition(auditId, 'releasable');
    assert.equal((await request(restarted, '/audit/release', { auditId, confirmStopped: true })).status, 200);
    const next = await request(restarted, '/audit/manual', { targetPath: 'src' });
    assert.equal(next.status, 202);
    await assert.rejects(api.leaseTransition(auditId, 'released'), /Host 已停止/);
    assert.equal(JSON.parse(await readFile(deps.statePath, 'utf8')).leases.some(
        lease => lease.auditId === next.body.auditId && lease.state === 'active'), true);
    await restarted.closeAudit();
});

async function waitForJob(api, id) {
    for (let attempt = 0; attempt < 500; attempt++) {
        const { body } = await api.invoke({ method: 'GET', path: '/jobs/' + id });
        if (body.status !== 'running') return body;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('审查任务未结束');
}

for (const vcsType of ['git', 'svn']) {
    for (const mode of ['external', 'headless']) {
        test(vcsType + ' ' + mode + ' 共用原目录阶段、纯索引档案和提案预检', { timeout: 35_000 }, async t => {
            const { root, temp } = await workspace(t, vcsType);
            const sourceFile = vcsType === 'svn' ? 'src/math@case.js' : 'src/math.js';
            const external = fileURLToPath(new URL('./fixtures/phased-audit-agent.mjs', import.meta.url));
            const api = new ReviewApi({
                settings: {
                    ...DEFAULT_SETTINGS,
                    repoRoot: root,
                    owner: 'tester',
                    vcsType,
                    runner: 'external',
                    externalCommand: '"' + process.execPath + '" "' + external + '" hold',
                },
                statePath: path.join(temp, 'runtime.json'),
                saveSettings: async settings => settings,
                auditStageExecutor: async ({ stage, runner, artifactDir, prompt }) => {
                    if (stage === 'scan') return {
                        ok: true,
                        executorUsed: runner,
                        output: {
                            leads: ['local-fix', 'policy-fix', 'future-fix'].map(leadId => ({
                                leadId,
                                entry: leadId,
                                path: sourceFile,
                                line: 1,
                                precondition: '运行加法',
                                expected: '正确计算',
                                impact: '计算错误',
                            })),
                            coverage: [],
                            limits: [],
                        },
                    };
                    if (stage === 'verify') return {
                        ok: true,
                        executorUsed: runner,
                        output: {
                            verdict: 'confirmed',
                            reason: '基线中实际执行减法',
                            evidence: [{ path: sourceFile, line: 1, excerpt: source, reason: '计算表达式' }],
                        },
                    };
                    const data = taskData(prompt);
                    const patchRel = path.posix.join(data.candidate.artifactRelDir, 'proposal.patch');
                    await writeFile(path.join(artifactDir, 'proposal.patch'), fullPatch(sourceFile, source + '\n', source.replace('a - b', 'a + b') + '\n'));
                    return {
                        ok: true,
                        executorUsed: runner,
                        output: {
                            status: 'ready',
                            optionId: 'opt-fix',
                            title: '直接修正表达式',
                            patchPath: patchRel,
                            confidence: 95,
                            tradeoff: '直接修正表达式',
                            humanDecisions: [],
                            summary: '修正加法',
                            reason: '',
                        },
                    };
                },
            });
            await api.init();
            t.after(() => api.closeAudit());
            const post = (endpoint, body = {}) => api.invoke({ method: 'POST', path: endpoint, body });
            const start = await post(mode === 'external' ? '/audit/manual' : '/audit');
            assert.equal(start.status, 202, JSON.stringify(start.body));
            let job = start.body.jobId;
            if (mode === 'external') {
                const { auditId, prompt } = start.body;
                const result = await runAuditChannel(prompt);
                assert.equal(result.reportPath, start.body.reportPath);
                const final = await post('/audit/finalize', { auditId });
                assert.equal(final.status, 202, JSON.stringify(final.body));
                job = final.body.jobId;
            }
            const completed = await waitForJob(api, job);
            assert.equal(completed.result?.status, 'COMMITTED', JSON.stringify(completed));
            const report = await readFile(path.join(root, completed.result.report.path), 'utf8');
            assert.ok(report.indexOf('政策仍需确认') < report.indexOf('等待政策落地'));
            assert.ok(report.indexOf('等待政策落地') < report.indexOf('加法结果错误'));
            assert.match(report, /schema_version: 1/);
            const { body: findings } = await api.invoke({ method: 'GET', path: '/findings' });
            assert.equal(findings.findings.length, 3);
            assert.ok(findings.findings.every(item => item.id));
        });
    }
}
