import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { requireExplicitSelection, resolveOptionSelection } from '../packages/dsh-plugin/dist/host/issue-review.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createGitFixture } from './helpers.mjs';

function meta() {
    return {
        schemaVersion: 1,
        findingId: 'math-addition',
        title: 'math: 加法错误',
        module: 'math',
        auditType: 'bugfix',
        issueKind: 'confirm',
        dependsOn: null,
        priority: 'P1',
        baseRevision: 'a'.repeat(40),
        createdAt: '2026-11-25T08:00:00Z',
        updatedAt: '2026-11-25T08:00:00Z',
        owner: 'audit-test',
        tags: [],
        ticket: null,
        status: 'pending',
        targetFiles: ['src/math.js'],
        recordRevision: 1,
        patches: [],
        options: [],
        observations: [],
        decisions: [],
        repairAttempts: [],
        comments: [],
        humanDecisions: [],
        approval: null,
        approvalHistory: [],
        rejection: null,
        commitMessage: 'math: 加法错误',
        extra: { business_context: { retain: true } },
    };
}

function withOptions() {
    const value = meta();
    value.issueKind = 'repair';
    value.recordRevision = 7;
    value.patches = [1, 2, 3].map(id => ({
        id,
        patch: `${String(id).padStart(3, '0')}.patch`,
        optionId: id === 2 ? 'b' : 'a',
        baseRevision: 'a'.repeat(40),
        author: 'ai',
        sha256: 'a'.repeat(64),
    }));
    value.options = [
        { id: 'a', title: '方案 A', tradeoff: '直接修正表达式', confidence: 0.95, currentPatch: 3, gateChecks: ['node --test'] },
        { id: 'b', title: '方案 B', tradeoff: '复用已有函数', confidence: 0.9, currentPatch: 2, gateChecks: ['node --test'] },
    ];
    return value;
}

test('schema1 纯文字问题（confirm）独立于补丁存在，记录版本从 1 开始', async t => {
    const value = meta();
    const text = serializeReviewMarkdown(value, '# 问题与影响\n加法错误\n\n# 当前修复方案\n交由人工调整协议\n\n# 需人工判断项\n- 无\n');
    assert.match(text, /schema_version: 1/);
    assert.match(text, /record_revision: 1/);
    assert.match(text, /patches: \[\]/);
    assert.doesNotMatch(text, /current_revision:|\nrevisions:/);
    const parsed = parseReviewMarkdown(text).meta;
    assert.equal(parsed.recordRevision, 1);
    assert.deepEqual(parsed.patches, []);
    assert.deepEqual(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: parsed }), []);
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, '.ai-review/2026-11/math');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'review.md'), text);
    const detail = await new ReviewStore(root).get('2026-11/math', null);
    assert.equal(detail.candidate.parseError, undefined);
    assert.equal(detail.patchText, '');
    assert.equal(detail.candidate.sections.solution.trim(), '交由人工调整协议');
});

test('schema1 问题版本、两个方案与三份历史补丁分别校验', () => {
    const value = parseReviewMarkdown(serializeReviewMarkdown(withOptions(), '# 问题与影响\n实际错误\n')).meta;
    assert.equal(value.recordRevision, 7);
    assert.equal(value.patches.length, 3);
    assert.deepEqual(resolveOptionSelection(value)?.selection, { optionId: 'a', patchId: 3 });
    assert.equal(requireExplicitSelection(value, { optionId: 'b', patchId: 2 }).patch.patch, '002.patch');
    assert.deepEqual(resolveOptionSelection(value, { optionId: 'a' })?.selection, { optionId: 'a', patchId: 3 });
    assert.throws(() => requireExplicitSelection(value, { optionId: 'a', patchId: 1 }), /已更新/);
    assert.throws(() => requireExplicitSelection(value, { optionId: 'b', patchId: 3 }), /已更新/);
    assert.deepEqual(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: value }), []);
    value.options[1].currentPatch = 1;
    assert.ok(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: value }).some(error => /属于|不符/.test(error)));
});

test('schema1 拒绝第三个有效方案、非法 schema_version 与顶层缺失字段', () => {
    const value = withOptions();
    value.options.push({ ...value.options[0], id: 'c' });
    assert.ok(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: value }).some(error => /1–2|上限|不超过/.test(error)));
    assert.throws(() => parseReviewMarkdown(serializeReviewMarkdown(meta(), '').replace('schema_version: 1', 'schema_version: 3')), /schema_version/);
    assert.throws(() => parseReviewMarkdown(serializeReviewMarkdown(meta(), '').replace('record_revision: 1\n', '')), /record_revision/);
});

test('未知扩展字段在 schema1 往返序列化中保持原样保留', () => {
    const value = meta();
    value.extra = { custom_flag: 'keep-me', business_context: { retain: true } };
    const parsed = parseReviewMarkdown(serializeReviewMarkdown(value, '# 需人工判断项\n- 无\n')).meta;
    assert.equal(parsed.extra.custom_flag, 'keep-me');
    assert.deepEqual(parsed.extra.business_context, { retain: true });
});
