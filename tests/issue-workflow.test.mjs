import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitAdapter, SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { runApprovalTransaction } from '../packages/dsh-plugin/dist/host/approval.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { buildIssuePublication } from '../packages/dsh-plugin/dist/host/issue-publication.js';
import { publishStageArtifacts } from '../packages/dsh-plugin/dist/host/audit-stage-artifacts.js';
import { finalizeIssueAudit } from '../packages/dsh-plugin/dist/host/issue-finalize.js';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { AuditArchive } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { fullPatch } from './fixtures/proposal-patch.mjs';
import { createGitFixture, runCommand } from './helpers.mjs';

const id = '2026-11/math';
const original = 'export const add = (a, b) => a - b;\n';
const proposed = ['export const add = (a, b) => a + b;\n', 'export const add = (a, b) => Number(a) + Number(b);\n'];
const timestamp = '2026-11-25T08:00:00Z';
const gate = 'node verify.mjs';

async function fixture(t, failGate = false) {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
    const commit = message => { runCommand('git', ['add', '-A'], root); runCommand('git', ['commit', '-qm', message], root); };
    await writeFile(path.join(root, 'verify.mjs'), "import {add} from './src/math.js'; if(add(4,2)!==6) throw new Error('wrong addition');\n");
    await mkdir(path.join(root, '.ai-review', id), { recursive: true });
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), 'default_owner: audit-test\nrules: []\n');
    commit('prepare baseline');
    const vcs = new GitAdapter(root);
    const base = await vcs.getCurrentBase();
    const patches = proposed.map(after => fullPatch('src/math.js', original, after));
    const commands = failGate ? ['node -e "process.exit(7)"'] : [gate];
    const meta = {
        schemaVersion: 1,
        findingId: 'math-addition',
        title: 'math: 修复加法',
        module: 'math',
        auditType: 'bugfix',
        issueKind: 'repair',
        dependsOn: null,
        priority: 'P1',
        baseRevision: base,
        createdAt: timestamp,
        updatedAt: timestamp,
        owner: 'audit-test',
        tags: [],
        ticket: null,
        status: 'pending',
        targetFiles: ['src/math.js'],
        recordRevision: 5,
        patches: patches.map((patch, index) => ({
            id: index + 1,
            patch: `00${index + 1}.patch`,
            optionId: ['a', 'b'][index],
            baseRevision: base,
            author: 'ai',
            sha256: createHash('sha256').update(patch).digest('hex'),
        })),
        options: patches.map((_, index) => ({
            id: ['a', 'b'][index],
            title: '方案 ' + index,
            tradeoff: '明确计算行为',
            confidence: 0.95 - index / 10,
            currentPatch: index + 1,
            gateChecks: commands,
        })),
        observations: [],
        decisions: [],
        repairAttempts: [],
        comments: [],
        humanDecisions: [],
        approval: null,
        approvalHistory: [],
        rejection: null,
        commitMessage: 'math: 修复加法',
    };
    const body = '# 问题与影响\n实际计算错误\n\n# 根因\n表达式错误\n\n# 当前修复方案\n修正表达式\n\n# 需人工判断项\n- 无\n\n# 验证证据\n读取表达式\n\n# 审核记录\n原记录\n';
    const review = () => serializeReviewMarkdown(meta, body);
    const dir = path.join(root, '.ai-review', id);
    for (const [index, patch] of patches.entries()) await writeFile(path.join(dir, `00${index + 1}.patch`), patch);
    await writeFile(path.join(dir, 'review.md'), review());
    commit('issue proposals');
    const store = new ReviewStore(root);
    let runnerCalls = 0;
    const approve = (selection) => runApprovalTransaction(
        {
            store,
            vcs,
            settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'audit-test', vcsType: 'git', autoFixOnFailure: true, syncBeforeApprove: false },
            sharedSource: () => GitHeadCandidateSource.create(root),
            log: () => {},
            runModeC: async () => { runnerCalls += 1; throw new Error('verification failure must not invoke Agent'); },
        },
        {
            id,
            jobId: 'issue-test',
            guard: { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt },
            optionId: selection?.optionId ?? '',
            patchId: selection?.patchId ?? 0,
            actor: meta.owner,
            confirmedDecisions: [],
            waivedDecisions: [],
        },
    );
    return { root, vcs, store, patches, meta, body, commit, review, dir, approve, runnerCalls: () => runnerCalls };
}

test('批准必须显式选择方案，选择 B 只应用 B 并保留全部历史补丁', async t => {
    const f = await fixture(t);
    const missing = await f.approve();
    assert.equal(missing.status, 'ABORTED');
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), original);
    const result = await f.approve({ optionId: 'b', patchId: 2 });
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), proposed[1]);
    const { candidate } = await f.store.get(id, null);
    assert.equal(candidate.meta.status, 'approved');
    assert.equal(candidate.meta.recordRevision, 6);
    assert.equal(candidate.meta.approval.optionId, 'b');
    assert.equal(candidate.meta.approval.patchId, 2);
    assert.equal(candidate.meta.approval.recordRevision, 5);
    assert.equal(candidate.meta.repairAttempts.at(-1).result, 'applied');
    assert.equal(f.runnerCalls(), 0);
    for (let index = 0; index < f.patches.length; index++) {
        assert.equal(await readFile(path.join(f.dir, `00${index + 1}.patch`), 'utf8'), f.patches[index]);
    }
    const lookup = await f.vcs.deriveApprovalCommit({
        reviewPath: `.ai-review/${id}/review.md`,
        patchPaths: [1, 2].map(index => `.ai-review/${id}/00${index}.patch`),
        targetFiles: ['src/math.js'],
    });
    assert.equal(lookup.lookup, 'found', JSON.stringify(lookup));
    assert.equal(lookup.revision, result.commitRevision);
});

test('验证失败还原业务、提交失败记录并改变状态（永久封禁补丁），不再次调用 Agent', async t => {
    const f = await fixture(t, true);
    const result = await f.approve({ optionId: 'b', patchId: 2 });
    assert.equal(result.status, 'REPAIR_FAILED', JSON.stringify(result));
    assert.equal(result.reason, 'GATE_CHECK_FAILED', JSON.stringify(result));
    assert.equal(await f.vcs.getCurrentBase(), result.commitRevision);
    assert.deepEqual(await f.vcs.listCommitPaths(result.commitRevision), [`.ai-review/${id}/review.md`]);
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), original);
    assert.equal((await f.vcs.ensureCleanWorkspace()).clean, true);
    assert.equal(f.runnerCalls(), 0);
    const { candidate } = await f.store.get(id, null, await GitHeadCandidateSource.create(f.root));
    assert.equal(candidate.meta.status, 'repair_failed');
    assert.equal(candidate.meta.approval, null);
    assert.deepEqual(
        candidate.meta.repairAttempts.map(item => [item.optionId, item.patchId, item.result, item.restored]),
        [['b', 2, 'verification_failed', true]],
    );
    assert.match(candidate.meta.repairAttempts[0].evidence, /7/);
    assert.equal(await readFile(path.join(f.dir, '002.patch'), 'utf8'), f.patches[1]);
});

async function publication(f, overrides = {}) {
    const now = new Date();
    const auditId = now.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-') + '-test';
    const source = await GitHeadCandidateSource.create(f.root);
    const { candidates } = await f.store.listSharedCandidates(source);
    const existingByFindingId = new Map();
    for (const candidate of candidates) {
        if (!candidate.parseError && candidate.meta.findingId) {
            existingByFindingId.set(candidate.meta.findingId, candidate);
        }
    }
    const existingDirIds = new Set(await f.store.listCandidateIds(source));
    return buildIssuePublication(f.root, {
        auditId,
        baseRevision: await f.vcs.getCurrentBase(),
        scope: '.',
        trigger: 'manual',
        previousAudit: null,
        reviewers: { defaultOwner: 'audit-test', rules: [] },
        existingByFindingId,
        existingDirIds,
        findings: [{
            findingId: 'math-addition',
            title: 'math: 加法错误',
            module: 'math',
            auditType: 'bugfix',
            issueKind: 'repair',
            dependsOn: null,
            priority: 'P1',
            reason: '真实代码证据',
            problemSummary: '计算错误',
            rootCause: '表达式错误',
            repairPlan: '修正表达式并检查计算输出',
            tags: [],
            evidence: [{ path: 'src/math.js', line: 1, excerpt: original.trim(), reason: '表达式错误' }],
            proposals: [{
                optionId: 'b',
                title: '仅修订 B',
                tradeoff: '保留明确转换',
                confidence: 0.99,
                auditType: 'bugfix',
                gateChecks: [gate],
                humanDecisions: [],
                patchText: f.patches[1],
                patchBytes: Buffer.from(f.patches[1], 'utf8'),
                summary: '仅修订 B',
            }],
        }],
        reviewedExternal: [],
        coverageLines: [],
        requirementLines: [],
        historyLines: [],
        now,
        ...overrides,
    });
}

test('只修订方案 B 时保持 A001，将 B 推进到 003，记录版本单独推进', async t => {
    const f = await fixture(t);
    const output = await publication(f);
    assert.equal(output.candidates[0].id, id);
    const meta = parseReviewMarkdown(output.candidates[0].review).meta;
    assert.equal(meta.recordRevision, 6);
    assert.deepEqual(meta.options.map(item => [item.id, item.currentPatch]), [['a', 1], ['b', 3]]);
    assert.deepEqual(meta.patches.map(item => item.id), [1, 2, 3]);
    assert.deepEqual(Object.keys(output.candidates[0].patches), ['003.patch']);
});

test('已批准问题复发沿用原目录，转存 approval_history[] 并退役旧 option_id', async t => {
    const f = await fixture(t);
    f.meta.status = 'approved';
    f.meta.repairAttempts = [{
        id: 1,
        optionId: 'b',
        patchId: 2,
        baseRevision: f.meta.baseRevision,
        actor: 'audit-test',
        at: timestamp,
        applyMode: 'program_strict',
        result: 'applied',
        restored: false,
        evidence: 'gate passed',
    }];
    f.meta.approval = {
        optionId: 'b',
        patchId: 2,
        recordRevision: 5,
        repairAttemptId: 1,
        baseRevision: f.meta.baseRevision,
        patchSha256: f.meta.patches[1].sha256,
        approvedBy: 'audit-test',
        approvedAt: timestamp,
        gateChecks: [gate],
        gateResults: [{ command: gate, exitCode: 0, durationMs: 1, passed: true }],
        confirmedDecisions: [],
        waivedDecisions: [],
    };
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    f.commit('approved record');
    const output = await publication(f, {
        findings: [{
            findingId: 'math-addition',
            title: 'math: 加法错误复发',
            module: 'math',
            auditType: 'bugfix',
            issueKind: 'repair',
            dependsOn: null,
            priority: 'P1',
            reason: '问题复发',
            problemSummary: '复发',
            rootCause: '回退引入',
            repairPlan: '新方案修复',
            tags: [],
            evidence: [{ path: 'src/math.js', line: 1, excerpt: original.trim(), reason: '减号重现' }],
            proposals: [{
                optionId: 'c-reopen',
                title: '复发后新方案',
                tradeoff: '新方案',
                confidence: 0.95,
                auditType: 'bugfix',
                gateChecks: [gate],
                humanDecisions: [],
                patchText: f.patches[0],
                patchBytes: Buffer.from(f.patches[0], 'utf8'),
                summary: '新方案',
            }],
        }],
    });
    const artifact = output.candidates[0];
    assert.equal(artifact.id, id);
    const meta = parseReviewMarkdown(artifact.review).meta;
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.status, 'pending');
    assert.equal(meta.approval, null);
    assert.equal(meta.approvalHistory.length, 1);
    assert.deepEqual(meta.options.map((o) => o.id), ['c-reopen']);
    assert.equal(meta.patches.length, 3);
});

test('跨轮合并保留人工接手状态、人类评论与修复线索', async t => {
    const f = await fixture(t);
    f.meta.status = 'human_takeover';
    f.meta.decisions = [
        { action: 'human_takeover', actor: 'audit-test', at: timestamp, reason: '人工核对业务取舍' },
        { action: 'add_repair_hint', actor: 'audit-test', at: timestamp, reason: '查看数值转换' },
    ];
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    f.commit('human takeover state');
    const output = await publication(f);
    const meta = parseReviewMarkdown(output.candidates[0].review).meta;
    assert.equal(meta.status, 'human_takeover');
    assert.deepEqual(meta.decisions.map(item => item.reason), ['人工核对业务取舍', '查看数值转换']);
});

async function finalizePublication(f, output) {
    let seal;
    await publishStageArtifacts(f.root, output.reportPath, output.reportText, output.candidates, async (manifest) => {
        seal = manifest;
    });
    const auditId = output.auditMeta.auditId;
    const base = await f.vcs.getCurrentBase();
    return finalizeIssueAudit({ store: f.store, vcs: f.vcs, log: () => {}, candidateSource: await GitHeadCandidateSource.create(f.root) }, {
        auditId,
        baseRevision: base,
        targetPath: '',
        trigger: 'manual',
        beforeIds: new Set([id]),
        publishedIssueIds: output.auditMeta.issues,
        stageSeal: seal,
        runError: null,
    });
}

test('外部完成后按真实代码复查关闭原问题，历史补丁不重新应用', async t => {
    const f = await fixture(t);
    f.meta.owner = 'human-owner';
    f.meta.status = 'awaiting_verification';
    f.meta.decisions.push({ action: 'external_completed', actor: 'human-owner', at: timestamp, reason: '执行人已完成' });
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    await writeFile(path.join(f.root, 'src/math.js'), proposed[0]);
    f.commit('external human repair');
    const output = await publication(f, {
        findings: [],
        reviewedExternal: [{
            findingId: 'math-addition',
            verdict: 'resolved',
            reason: '真实代码已改为加法',
            evidence: [{ path: 'src/math.js', line: 1, excerpt: proposed[0].trim(), reason: '表达式已修复' }],
        }],
    });
    f.vcs.checkPatch = async () => { throw new Error('不能重检已经由外部修复的历史补丁'); };
    const result = await finalizePublication(f, output);
    const auditId = output.auditMeta.auditId;
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    const { candidate } = await f.store.get(id, null);
    assert.equal(candidate.meta.status, 'resolved');
    await assert.rejects(f.store.addComment(id, {
        expectedRevision: candidate.meta.recordRevision,
        expectedOwner: candidate.meta.owner,
        expectedUpdatedAt: candidate.meta.updatedAt,
    }, { author: 'human-owner', content: '关闭后不可直接修改' }), /不允许|归档|resolved/);
    assert.equal(candidate.meta.observations.at(-1).verdict, 'resolved');
    assert.equal(candidate.meta.patches.length, 2);
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), proposed[0]);
    const report = await new AuditArchive(f.root).read(auditId);
    assert.equal(report.meta.schemaVersion, 1);
    assert.deepEqual(report.meta.issues, [id]);
});

test('外部反馈提案严格收尾并回到共享审核，旧 guard 不提交', async t => {
    const f = await fixture(t);
    const next = structuredClone(f.meta);
    next.recordRevision += 1;
    next.updatedAt = new Date().toISOString();
    next.patches.push({ ...next.patches[1], id: 3, patch: '003.patch' });
    next.options[1].currentPatch = 3;
    await writeFile(path.join(f.dir, '003.patch'), f.patches[1]);
    await writeFile(path.join(f.dir, 'review.md'), serializeReviewMarkdown(next, f.body));

    const api = new ReviewApi({
        settings: { ...DEFAULT_SETTINGS, repoRoot: f.root, owner: 'audit-test', vcsType: 'git', syncBeforeApprove: false },
        saveSettings: async (v) => v,
        statePath: path.join(f.root, '.tmp', 'runtime-state.json'),
    });
    await api.init();
    const waitJob = async (jobId) => {
        for (let i = 0; i < 100; i += 1) {
            const job = api.jobManager.get(jobId);
            if (job && job.status !== 'running') return job.result;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('job 超时');
    };
    const invoke = async (expectedRevision) => {
        const res = await api.invoke({
            method: 'POST',
            path: '/candidate/finalize',
            body: { id, optionId: 'b', patchId: 2, expectedRevision, expectedOwner: f.meta.owner, expectedUpdatedAt: f.meta.updatedAt },
        });
        if (res.status !== 202) return { httpStatus: res.status, body: res.body };
        return waitJob(res.body.jobId);
    };

    const before = await f.vcs.getCurrentBase();
    const stale = await invoke(4);
    assert.equal(stale.httpStatus, 409, JSON.stringify(stale));
    assert.equal(await f.vcs.getCurrentBase(), before);
    const result = await invoke(5);
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    const shared = (await f.store.get(id, null, await GitHeadCandidateSource.create(f.root))).candidate;
    assert.equal(shared.meta.recordRevision, 6);
    assert.deepEqual(shared.meta.options.map(option => option.currentPatch), [1, 3]);
    assert.equal(shared.meta.status, 'pending');
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), original);
    assert.equal((await f.vcs.ensureCleanWorkspace()).clean, true);
});

test('SVN 从保留历史补丁的 schema1 批准记录派生原业务提交', async t => {
    const f = await fixture(t);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'issue-svn-history-'));
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 4 }));
    const repository = path.join(temp, 'repository'), root = path.join(temp, 'working-copy');
    runCommand('svnadmin', ['create', repository], temp);
    runCommand('svn', ['checkout', pathToFileURL(repository).href, root], temp);
    const dir = path.join(root, '.ai-review', id);
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/math.js'), original);
    const meta = structuredClone(f.meta);
    meta.patches.forEach(p => { p.baseRevision = '1'; });
    meta.baseRevision = '1';
    await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, f.body));
    for (let index = 0; index < f.patches.length; index++) await writeFile(path.join(dir, `00${index + 1}.patch`), f.patches[index]);
    runCommand('svn', ['add', 'src', '.ai-review'], root);
    runCommand('svn', ['commit', '-m', 'issue baseline'], root);
    runCommand('svn', ['update'], root);
    meta.status = 'approved';
    meta.recordRevision += 1;
    meta.repairAttempts = [{
        id: 1,
        optionId: 'b',
        patchId: 2,
        baseRevision: '1',
        actor: meta.owner,
        at: timestamp,
        applyMode: 'program_strict',
        result: 'applied',
        restored: false,
        evidence: 'gate passed',
    }];
    meta.approval = {
        optionId: 'b',
        patchId: 2,
        recordRevision: 5,
        repairAttemptId: 1,
        baseRevision: '1',
        patchSha256: createHash('sha256').update(f.patches[1]).digest('hex'),
        approvedBy: meta.owner,
        approvedAt: timestamp,
        gateChecks: [gate],
        gateResults: [{ command: gate, exitCode: 0, durationMs: 1, passed: true }],
        confirmedDecisions: [],
        waivedDecisions: [],
    };
    await writeFile(path.join(root, 'src/math.js'), proposed[1]);
    await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, f.body));
    runCommand('svn', ['commit', '-m', 'apply approved B'], root);
    runCommand('svn', ['update'], root);
    const vcs = new SvnAdapter(root);
    const lookup = await vcs.deriveApprovalCommit({
        reviewPath: `.ai-review/${id}/review.md`,
        patchPaths: [1, 2].map(n => `.ai-review/${id}/00${n}.patch`),
        targetFiles: ['src/math.js'],
    });
    assert.equal(lookup.lookup, 'found', JSON.stringify(lookup));
    assert.equal(lookup.revision, '2');
    assert.equal(await readFile(path.join(dir, '001.patch'), 'utf8'), f.patches[0]);
    assert.equal(await readFile(path.join(dir, '002.patch'), 'utf8'), f.patches[1]);
});

test('跨轮更新不能借封存提案改写共享问题的人工负责人', async t => {
    const f = await fixture(t);
    f.meta.owner = 'human-owner';
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    f.commit('human owns issue');
    const output = await publication(f);
    const parsed = parseReviewMarkdown(output.candidates[0].review);
    assert.equal(parsed.meta.owner, 'human-owner');
    parsed.meta.owner = 'forged-owner';
    output.candidates[0].review = serializeReviewMarkdown(parsed.meta, parsed.body);
    const base = await f.vcs.getCurrentBase();
    const result = await finalizePublication(f, output);
    assert.equal(result.status, 'VALIDATION_FAILED', JSON.stringify(result));
    assert.ok(result.dataValidation[0].errors.some(error => /负责人/.test(error)));
    assert.equal(await f.vcs.getCurrentBase(), base);
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), original);
});

test('人工接管后的处置按共享 Owner 授权，旧路由 Owner 不能代为反馈', async t => {
    const f = await fixture(t);
    await f.store.takeover(id, {
        expectedRevision: f.meta.recordRevision,
        expectedOwner: f.meta.owner,
        expectedUpdatedAt: f.meta.updatedAt,
    }, 'human-owner');
    f.commit('human takes ownership');
    const api = new ReviewApi({
        settings: { ...DEFAULT_SETTINGS, repoRoot: f.root, owner: 'audit-test', vcsType: 'git' },
        saveSettings: async value => value,
        statePath: path.join(f.root, '.tmp/runtime-state.json'),
    });
    await api.init();
    t.after(() => api.closeAudit());
    const findings = async () => (await api.invoke({ method: 'GET', path: '/findings' })).body.findings;
    const decide = async (actor, action) => {
        const finding = (await findings()).find(item => item.findingId === 'math-addition');
        return api.invoke({
            method: 'POST',
            path: '/finding/decision',
            actor: { userId: actor, reviewIdentity: actor },
            body: {
                id: finding.id,
                expectedRevision: finding.recordRevision,
                expectedOwner: finding.owner,
                expectedUpdatedAt: finding.updatedAt,
                action,
                reason: '人工完成业务确认',
            },
        });
    };
    const denied = await decide('audit-test', 'human_takeover');
    assert.equal(denied.status, 403, JSON.stringify(denied));
    const takeover = await decide('human-owner', 'human_takeover');
    assert.equal(takeover.status, 200, JSON.stringify(takeover));
    const completed = await decide('human-owner', 'external_completed');
    assert.equal(completed.status, 200, JSON.stringify(completed));
    assert.equal(completed.body.finding.issueStatus, 'awaiting_verification');
    const shared = (await f.store.get(id, null, await GitHeadCandidateSource.create(f.root))).candidate;
    assert.equal(shared.meta.owner, 'human-owner');
    assert.deepEqual(shared.meta.decisions.map(item => item.actor), ['human-owner', 'human-owner']);
});
