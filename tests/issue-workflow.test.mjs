import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { GitAdapter, SvnAdapter } from '../packages/dsh-plugin/dist/host/vcs.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { ApprovalOrchestrator } from '../packages/dsh-plugin/dist/host/approval.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { prepareIssuePublication } from '../packages/dsh-plugin/dist/host/issue-publication.js';
import { publishStageArtifacts } from '../packages/dsh-plugin/dist/host/audit-stage-artifacts.js';
import { finalizeIssueAudit } from '../packages/dsh-plugin/dist/host/issue-finalize.js';
import { serializeFindingEvents } from '../packages/dsh-plugin/dist/host/finding-decisions.js';
import { Readable } from 'node:stream';
import { ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { Writers } from '../packages/dsh-plugin/dist/host/api-writers.js';
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
    await writeFile(path.join(root, '.ai-review/reviewers.yml'), `default_owner: audit-test\nrules: []\nallowed_gate_commands: [${JSON.stringify(gate)}, 'node -e "process.exit(7)"']\n`);
    commit('prepare baseline');
    const vcs = new GitAdapter(root);
    const base = await vcs.getCurrentBase();
    const patches = proposed.map(after => fullPatch('src/math.js', original, after));
    const commands = failGate ? ['node -e "process.exit(7)"'] : [gate];
    const meta = { schemaVersion: 3, findingId: 'math-addition', module: 'math', title: 'math: 修复加法', auditType: 'bugfix', owner: 'audit-test',
        tags: [], ticket: null, status: 'pending', createdAt: timestamp, updatedAt: timestamp, currentRevision: 5,
        targetFiles: ['src/math.js'], gateChecks: commands, comments: [], humanDecisions: [], approval: null, rejection: null,
        commitMessage: 'math: 修复加法', extra: {},
        revisions: patches.map((patch, index) => ({ id: index + 1, baseRevision: base, patch: `00${index + 1}.patch`, author: 'ai',
            extra: { option_id: ['a', 'b'][index], sha256: createHash('sha256').update(patch).digest('hex') } })),
        issue: { priority: 'P1', baseRevision: base, options: patches.map((_, index) => ({ id: ['a', 'b'][index], title: '方案 ' + index,
            tradeoff: '明确计算行为', confidence: 0.95 - index / 10, currentPatch: index + 1, gateChecks: commands })), observations: [], decisions: [], repairAttempts: [] } };
    const review = () => serializeReviewMarkdown(meta, '# 问题与影响\n实际计算错误\n\n# 根因\n表达式错误\n\n# 当前修复方案\n修正表达式\n\n# 需人工判断项\n- 无\n\n# 验证证据\n读取表达式\n\n# 审核记录\n原记录\n');
    const dir = path.join(root, '.ai-review', id);
    for (const [index, patch] of patches.entries()) await writeFile(path.join(dir, `00${index + 1}.patch`), patch);
    await writeFile(path.join(dir, 'review.md'), review());
    commit('issue proposals');
    const store = new ReviewStore(root);
    let runnerCalls = 0;
    const orchestrator = new ApprovalOrchestrator({ store, vcs, settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'audit-test',
        vcsType: 'git', autoFixOnFailure: true, syncBeforeApprove: false }, sharedSource: () => GitHeadCandidateSource.create(root),
        makeRunner: () => { runnerCalls++; throw new Error('verification failure must not invoke Agent'); },
        checkFinding: async () => null, beginFindingCommit: async () => {}, finishFindingCommit: async () => {} });
    const approve = selection => orchestrator.approve(id, { expectedRevision: meta.currentRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt },
        'issue-test', () => {}, { confirmed: [], waived: [] }, meta.owner, undefined, selection ? { selection } : undefined);
    return { root, vcs, store, patches, meta, commit, review, dir, approve, runnerCalls: () => runnerCalls };
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
    assert.equal(candidate.meta.currentRevision, 6);
    assert.equal(candidate.meta.approval.extra.option_id, 'b');
    assert.equal(candidate.meta.approval.extra.patch_id, 2);
    assert.equal(candidate.meta.approval.extra.record_revision, 5);
    assert.equal(candidate.meta.issue.repairAttempts.at(-1).result, 'applied');
    assert.equal(f.runnerCalls(), 0);
    for (let index = 0; index < f.patches.length; index++) assert.equal(await readFile(path.join(f.dir, `00${index + 1}.patch`), 'utf8'), f.patches[index]);
    const lookup = await f.vcs.deriveApprovalCommit({ reviewPath: `.ai-review/${id}/review.md`, patchPaths: [1, 2].map(index => `.ai-review/${id}/00${index}.patch`), targetFiles: ['src/math.js'] });
    assert.equal(lookup.lookup, 'found', JSON.stringify(lookup));
    assert.equal(lookup.revision, result.commitRevision);
});

test('验证失败还原业务、提交失败记录并改变状态，不再次调用 Agent', async t => {
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
    assert.deepEqual(candidate.meta.issue.repairAttempts.map(item => [item.optionId, item.patchId, item.result, item.restored]), [['b', 2, 'verification_failed', true]]);
    assert.match(candidate.meta.issue.repairAttempts[0].evidence, /7/);
    assert.equal(await readFile(path.join(f.dir, '002.patch'), 'utf8'), f.patches[1]);
});

async function publication(f, options = {}) {
    const createdAt = new Date().toISOString();
    const auditId = createdAt.slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-') + '-test';
    const lease = { root: f.root, auditId, createdAt, baseRevision: await f.vcs.getCurrentBase(), targetPath: '', owner: 'audit-test', trigger: 'manual' };
    return prepareIssuePublication({ lease, vcs: f.vcs, source: await GitHeadCandidateSource.create(f.root),
        reviewers: { defaultOwner: 'audit-test', rules: [] }, findings: [{ subjectId: 'math', findingId: 'math-addition', title: '加法错误', priority: 'P1', kind: 'A',
            decision: '', dependsOn: '', repairPlan: '修正表达式并检查计算输出' }], reviews: new Map([['math', { reason: '真实代码证据', observedBehavior: '计算错误', impact: '返回错误值', preconditions: [], limits: [],
            evidence: [{ path: 'src/math.js', line: 1, excerpt: original.trim(), reason: '表达式错误' }] }]]),
        proposals: new Map([['math', [{ id: 'proposal', title: '仅修订 B', patch: f.patches[1], review: '', proposal: { optionId: 'b',
            auditType: 'bugfix', commands: [gate], confidence: 0.99, tradeoff: '保留明确转换', humanDecisions: [] } }]]]), coverage: [], history: [], ...options });
}

test('只修订方案 B 时保持 A001，将 B 推进到 003，记录版本单独推进', async t => {
    const f = await fixture(t);
    const output = await publication(f);
    assert.equal(output.candidates[0].id, id);
    const meta = parseReviewMarkdown(output.candidates[0].review).meta;
    assert.equal(meta.currentRevision, 6);
    assert.deepEqual(meta.issue.options.map(item => [item.id, item.currentPatch]), [['a', 1], ['b', 3]]);
    assert.deepEqual(meta.revisions.map(item => item.id), [1, 2, 3]);
    assert.deepEqual(Object.keys(output.candidates[0].patches), ['003.patch']);
});

test('遗留已批准问题复发沿用原路径，从 VCS 恢复已删除补丁', async t => {
    const f = await fixture(t);
    f.meta.schemaVersion = 2;
    delete f.meta.issue;
    f.meta.currentRevision = 1;
    f.meta.revisions = [f.meta.revisions[0]];
    f.meta.status = 'approved';
    f.meta.approval = { approvedBy: 'audit-test', approvedAt: timestamp, gateChecks: [gate], gateResults: [{ command: gate, exit_code: 0, duration_ms: 1 }], confirmedDecisions: [], waivedDecisions: [] };
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    await unlink(path.join(f.dir, '001.patch'));
    await unlink(path.join(f.dir, '002.patch'));
    f.commit('legacy approved record');
    const output = await publication(f);
    const artifact = output.candidates[0];
    assert.equal(artifact.id, id);
    assert.equal(artifact.patches['001.patch'], f.patches[0]);
    const meta = parseReviewMarkdown(artifact.review).meta;
    assert.equal(meta.schemaVersion, 3);
    assert.equal(meta.status, 'pending');
    assert.equal(meta.extra.approval_history.length, 1);
    assert.match(meta.revisions[0].extra.sha256, /^[a-f0-9]{64}$/);
});

test('遗留人工接手与修复线索迁入同一 review.md', async t => {
    const f = await fixture(t);
    f.meta.schemaVersion = 2;
    delete f.meta.issue;
    f.meta.currentRevision = 1;
    f.meta.revisions = [f.meta.revisions[0]];
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    await unlink(path.join(f.dir, '002.patch'));
    await mkdir(path.join(f.root, '.ai-review/findings'));
    await writeFile(path.join(f.root, '.ai-review/findings/math-addition.yml'), serializeFindingEvents('math-addition', [
        { revision: 1, auditId: '20261125-080000-original', actor: 'audit-test', at: timestamp, action: 'human_takeover', reason: '人工核对业务取舍' },
        { revision: 2, auditId: '20261125-080000-original', actor: 'audit-test', at: timestamp, action: 'add_repair_hint', hint: '查看数值转换' },
    ]));
    f.commit('legacy human decisions');
    const output = await publication(f);
    const meta = parseReviewMarkdown(output.candidates[0].review).meta;
    assert.equal(meta.status, 'human_takeover');
    assert.deepEqual(meta.issue.decisions.map(item => item.reason), ['人工核对业务取舍', '查看数值转换']);
});

async function finalizePublication(f, output) {
    let seal;
    await publishStageArtifacts(f.root, output.path, output.body, output.candidates, async value => { seal = value; });
    const auditId = output.path.split('/')[2];
    const base = await f.vcs.getCurrentBase();
    return finalizeIssueAudit({ store: f.store, vcs: f.vcs, candidateSource: await GitHeadCandidateSource.create(f.root) }, {
        auditId, startedAt: Date.parse(auditId.slice(0, 4) + '-' + auditId.slice(4, 6) + '-' + auditId.slice(6, 8) + 'T' + auditId.slice(9, 11) + ':' + auditId.slice(11, 13) + ':' + auditId.slice(13, 15) + 'Z'),
        baseRevision: base, targetPath: '', trigger: 'manual', beforeIds: new Set([id]), phasedSeal: seal,
    });
}

test('外部完成后按真实代码复查关闭原问题，历史补丁不重新应用', async t => {
    const f = await fixture(t);
    f.meta.owner = 'human-owner';
    await writeFile(path.join(f.root, '.ai-review/reviewers.yml'), 'default_owner: audit-test\nrules: []\nallowed_gate_commands: []\n');
    f.meta.status = 'awaiting_verification';
    f.meta.issue.decisions.push({ action: 'external_completed', actor: 'audit-test', at: timestamp, reason: '执行人已完成' });
    await writeFile(path.join(f.dir, 'review.md'), f.review());
    await writeFile(path.join(f.root, 'src/math.js'), proposed[0]);
    f.commit('external human repair');
    const output = await publication(f, { findings: [], reviews: new Map(), proposals: new Map(),
        recheck: { observations: [{ findingId: 'math-addition', status: 'resolved', summary: '真实代码已改为加法' }] },
        recheckEvidence: [{ id: 'math-addition', status: 'resolved', evidence: { file: 'src/math.js', line: 1, excerpt: proposed[0].trim(), reason: '表达式已修复' } }] });
    f.vcs.checkPatch = async () => { throw new Error('不能重检已经由外部修复的历史补丁'); };
    const result = await finalizePublication(f, output);
    const auditId = output.path.split('/')[2];
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    const { candidate } = await f.store.get(id, null);
    assert.equal(candidate.meta.status, 'resolved');
    await assert.rejects(f.store.addComment(id, 'audit-test', { content: '关闭后不可直接修改' }, {
        expectedRevision: candidate.meta.currentRevision, expectedOwner: candidate.meta.owner, expectedUpdatedAt: candidate.meta.updatedAt,
    }), /已归档/);
    assert.equal(candidate.meta.issue.observations.at(-1).verdict, 'resolved');
    assert.equal(candidate.meta.revisions.length, 2);
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), proposed[0]);
    const report = await new AuditArchive(f.root).read(auditId);
    assert.equal(report.meta.schemaVersion, 3);
    assert.deepEqual(report.meta.candidates, [id]);
    assert.deepEqual(report.meta.items, []);
});

test('外部反馈提案严格收尾并回到共享审核，旧guard不提交', async t => {
    const f = await fixture(t);
    const next = structuredClone(f.meta);
    next.currentRevision++;
    next.updatedAt = new Date().toISOString();
    next.revisions.push({ ...next.revisions[1], id: 3, patch: '003.patch' });
    next.issue.options[1].currentPatch = 3;
    const previousBody = parseReviewMarkdown(f.review()).body;
    await writeFile(path.join(f.dir, '003.patch'), f.patches[1]);
    await writeFile(path.join(f.dir, 'review.md'), serializeReviewMarkdown(next, previousBody));
    const runtime = { root: f.root, store: f.store, vcs: f.vcs, vcsType: 'git' };
    let running;
    const writers = new Writers({ runtimeFor: async () => runtime, ownerFor: async () => 'audit-test',
        withWriteLock: async (_root, fn) => fn(), jobManager: { start: (_kind, fn) => { running = fn(() => {}, 'proposal-finalize'); return { id: 'proposal-finalize' }; } } }, {});
    const invoke = async expectedRevision => {
        const req = Readable.from([Buffer.from(JSON.stringify({ id, optionId: 'b', patchId: 2, expectedRevision,
            expectedOwner: f.meta.owner, expectedUpdatedAt: f.meta.updatedAt }))]);
        await writers.candidateFinalize(req, { setHeader() {}, end() {} }, new URL('http://localhost/candidate/finalize'));
        return running;
    };
    const before = await f.vcs.getCurrentBase();
    assert.equal((await invoke(4)).reason, 'CONCURRENCY_MISMATCH');
    assert.equal(await f.vcs.getCurrentBase(), before);
    const result = await invoke(5);
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result));
    const shared = (await f.store.get(id, null, await GitHeadCandidateSource.create(f.root))).candidate;
    assert.equal(shared.meta.currentRevision, 6);
    assert.deepEqual(shared.meta.issue.options.map(option => option.currentPatch), [1, 3]);
    assert.equal(shared.meta.status, 'pending');
    assert.equal(await readFile(path.join(f.root, 'src/math.js'), 'utf8'), original);
    assert.equal((await f.vcs.ensureCleanWorkspace()).clean, true);
});

test('SVN 从保留历史补丁的 schema3 批准记录派生原业务提交', async t => {
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
    meta.revisions.forEach(revision => { revision.baseRevision = '1'; });
    meta.issue.baseRevision = '1';
    await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, parseReviewMarkdown(f.review()).body));
    for (let index = 0; index < f.patches.length; index++) await writeFile(path.join(dir, `00${index + 1}.patch`), f.patches[index]);
    runCommand('svn', ['add', 'src', '.ai-review'], root);
    runCommand('svn', ['commit', '-m', 'issue baseline'], root);
    runCommand('svn', ['update'], root);
    meta.status = 'approved';
    meta.currentRevision++;
    meta.approval = { approvedBy: meta.owner, approvedAt: timestamp, gateChecks: [gate], gateResults: [{ command: gate, exit_code: 0, duration_ms: 1 }], confirmedDecisions: [], waivedDecisions: [],
        extra: { option_id: 'b', patch_id: 2, record_revision: 5, base_revision: '1', patch_sha256: createHash('sha256').update(f.patches[1]).digest('hex') } };
    await writeFile(path.join(root, 'src/math.js'), proposed[1]);
    await writeFile(path.join(dir, 'review.md'), serializeReviewMarkdown(meta, parseReviewMarkdown(f.review()).body));
    runCommand('svn', ['commit', '-m', 'apply approved B'], root);
    runCommand('svn', ['update'], root);
    const vcs = new SvnAdapter(root);
    const lookup = await vcs.deriveApprovalCommit({ reviewPath: `.ai-review/${id}/review.md`, patchPaths: [1, 2].map(n => `.ai-review/${id}/00${n}.patch`), targetFiles: ['src/math.js'] });
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

test('人工接管后的处置按共享Owner授权，旧路由Owner不能代为反馈', async t => {
    const f = await fixture(t);
    await f.store.transferOwner(id, 'human-owner', { expectedRevision: f.meta.currentRevision,
        expectedOwner: f.meta.owner, expectedUpdatedAt: f.meta.updatedAt });
    f.commit('human takes ownership');
    const api = new ReviewApi({ settings: { ...DEFAULT_SETTINGS, repoRoot: f.root, owner: 'audit-test', vcsType: 'git' },
        saveSettings: async value => value, statePath: path.join(f.root, '.ai-review/runtime-state.json') });
    await api.init();
    t.after(() => api.closeAudit());
    const findings = async () => (await api.invoke({ method: 'GET', path: '/findings' })).body.findings;
    const decide = async (actor, action) => {
        const finding = (await findings()).find(item => item.findingId === 'math-addition');
        api.deps.settings.owner = actor;
        return api.invoke({ method: 'POST', path: '/finding/decision', body: { findingId: finding.findingId,
            expectedFindingVersion: finding.findingVersion, action, reason: '人工完成业务确认' } });
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
    assert.deepEqual(shared.meta.issue.decisions.map(item => item.actor), ['human-owner', 'human-owner']);
});
