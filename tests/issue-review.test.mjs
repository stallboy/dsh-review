import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { quickReviewInvariants } from '../packages/dsh-plugin/dist/host/invariants.js';
import { defaultIssueSelection, issueVersion, selectIssuePatch, readIssueSelection } from '../packages/dsh-plugin/dist/host/issue-review.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createGitFixture } from './helpers.mjs';

function meta() {
    return {
        schemaVersion: 3, findingId: 'math-addition', title: 'math: 加法错误', module: 'math', auditType: 'bugfix',
        createdAt: '2026-11-25T08:00:00Z', updatedAt: '2026-11-25T08:00:00Z', owner: 'audit-test',
        tags: [], ticket: null, status: 'pending', targetFiles: ['src/math.js'], currentRevision: 1,
        revisions: [], gateChecks: [], comments: [], humanDecisions: [], approval: null, rejection: null,
        commitMessage: 'math: 加法错误', extra: { business_context: { retain: true } },
        issue: { priority: 'P1', baseRevision: 'a'.repeat(40), options: [], observations: [], decisions: [], repairAttempts: [] },
    };
}

function withOptions() {
    const value = meta();
    value.currentRevision = 7;
    value.revisions = [1, 2, 3].map(id => ({ id, patch: `${String(id).padStart(3, '0')}.patch`, baseRevision: 'a'.repeat(40),
        author: 'ai', extra: { option_id: id === 2 ? 'b' : 'a' } }));
    value.issue.options = [
        { id: 'a', title: '方案 A', tradeoff: '直接修正表达式', confidence: 0.95, currentPatch: 3, gateChecks: ['node --test'] },
        { id: 'b', title: '方案 B', tradeoff: '复用已有函数', confidence: 0.9, currentPatch: 2, gateChecks: ['node --test'] },
    ];
    return value;
}

test('schema3 纯文字问题独立于补丁存在，记录版本从一开始', async t => {
    const value = meta();
    const text = serializeReviewMarkdown(value, '# 问题与影响\n加法错误\n\n# 当前修复方案\n交由人工调整协议\n\n# 需人工判断项\n- 无\n');
    assert.match(text, /record_revision: 1/);
    assert.match(text, /patches: \[\]/);
    assert.doesNotMatch(text, /current_revision:|\nrevisions:/);
    const parsed = parseReviewMarkdown(text).meta;
    assert.equal(parsed.currentRevision, 1);
    assert.deepEqual(parsed.revisions, []);
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

test('schema3 问题版本、两个方案与三份历史补丁分别校验', () => {
    const value = parseReviewMarkdown(serializeReviewMarkdown(withOptions(), '# 问题与影响\n实际错误\n')).meta;
    assert.equal(value.currentRevision, 7);
    assert.equal(value.revisions.length, 3);
    assert.deepEqual(defaultIssueSelection(value), { optionId: 'a', patchId: 3 });
    assert.equal(selectIssuePatch(value, { optionId: 'b', patchId: 2 }).revision.patch, '002.patch');
    assert.deepEqual(readIssueSelection(value, { optionId: 'a' }), { optionId: 'a', patchId: 3 });
    assert.throws(() => selectIssuePatch(value, readIssueSelection(value, { optionId: 'a', patchId: 1 })), /已更新/);
    assert.throws(() => selectIssuePatch(value, { optionId: 'a', patchId: 1 }), /已更新/);
    assert.throws(() => selectIssuePatch(value, { optionId: 'b', patchId: 3 }), /已更新/);
    assert.deepEqual(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: value }), []);
    const previous = issueVersion(value);
    value.issue.options[1].currentPatch = 1;
    assert.notEqual(issueVersion(value), previous);
    assert.ok(quickReviewInvariants({ id: '2026-11/math', month: '2026-11', slug: 'math', meta: value }).some(error => /当前补丁无效/.test(error)));
});

test('schema3 拒绝第三个有效方案及混合旧版本字段', () => {
    const value = withOptions();
    value.issue.options.push({ ...value.issue.options[0], id: 'c' });
    assert.throws(() => parseReviewMarkdown(serializeReviewMarkdown(value, '')), /不超过两个/);
    assert.throws(() => parseReviewMarkdown(serializeReviewMarkdown(meta(), '').replace('schema_version: 3', 'schema_version: 3\ncurrent_revision: 1')), /不得混入/);
});

test('旧格式的未知问题字段仍原样保留', () => {
    const value = meta();
    value.schemaVersion = 1;
    delete value.findingId;
    delete value.issue;
    value.revisions = [{ id: 1, patch: '001.patch', baseRevision: 'a'.repeat(40), author: 'ai' }];
    value.gateChecks = ['node --test'];
    value.extra.priority = '自定义旧字段';
    const parsed = parseReviewMarkdown(serializeReviewMarkdown(value, '')).meta;
    assert.equal(parsed.extra.priority, '自定义旧字段');
    assert.deepEqual(parsed.extra.business_context, { retain: true });
});
