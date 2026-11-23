import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withTrustedActor } from '../packages/dsh-plugin/dist/host/api-context.js';
import { AuditArchive } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { renderPromptText } from '../packages/dsh-plugin/dist/host/audit-prompts.js';
import { buildAuditPrompt } from '../packages/dsh-plugin/dist/host/auditor.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { createGitFixture, runCommand } from './helpers.mjs';

// 迁移前由原 buildAuditPrompt 采集，用于校验包括空行在内的完整输出。
const baselineHashes = {
    'v1-headless': '9de1ae0fa30838d4c1ef2cefce92e5f94c9f534ed00d0e7b3097376cc69aa405',
    'v1-session': '6a0ba1fc268e24cb446680ba951f8ebaecb1139960ad445e0f4cd8216ef6fcbd',
    'v2-headless': '00b48abba904b0fd1984f40919e25c74e9eb44dbdbf4eac8731e3fe3e1854a7a',
    'v2-session': '8698d2c137e7440ec7f5a2a355f9be0888b2a94e7453a5b68ac1e165ae378a16',
    'v2-headless-history': 'd1d2e16aabed4c66e32d895ac51021f2c500628f8b8698313e8e4bcbd592fc93',
    'v2-session-history': '8637460852cddaf7cab84dfbfc2c86353a0360faf78e373ed86c78d31a67bb3e',
};

test('直接执行提示词迁移前后逐字等价，并保留作为数据输入的模板语法', async t => {
    const root = await createGitFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const baseRevision = 'a'.repeat(40);
    const note = '变量 {{taskJson}} 与 {{baseRevision}}\n保留第二行。';
    const input = {
        repoRoot: root, vcsType: 'git', owner: 'tester', targetPath: 'src', note, baseRevision,
        reportPath: '.ai-review/audits/20261111-120000-src/audit.md', now: new Date('2026-11-11T12:00:00Z'),
    };
    const render = async (findingWorkflow, mode, source) => {
        const actual = await withTrustedActor({ userId: 'tester', reviewIdentity: 'tester', findingWorkflow },
            () => buildAuditPrompt({ ...input, mode, source }));
        assert.ok(actual.includes(note));
        if (source) assert.ok(actual.includes('历史方案中的 {{taskJson}}'));
        const label = (findingWorkflow ? 'v2' : 'v1') + '-' + mode + (source ? '-history' : '');
        const normalized = actual.replaceAll('\r\n', '\n').replaceAll(path.resolve(root), '<仓库根目录>');
        const digest = createHash('sha256').update(normalized).digest('hex');
        assert.equal(digest, baselineHashes[label], label);
    };

    for (const mode of ['headless', 'session']) {
        await render(false, mode);
        await render(true, mode);
    }

    const archive = new AuditArchive(root);
    await archive.write({
        schemaVersion: 2, auditId: '20261110-120000-src', createdAt: '2026-11-10T12:00:00Z',
        baseRevision, scope: 'src', trigger: 'manual', previousAudit: null, candidates: [],
        items: [{
            findingId: 'addition-result', kind: 'confirm', title: '加法结果错误',
            summary: '正数相加的结果不正确', targetFiles: ['src/math.js'],
            dependsOn: null, status: 'pending', candidate: null, repairPlan: '历史方案中的 {{taskJson}}',
        }],
    }, '# 审查报告\n');
    runCommand('git', ['add', '.ai-review'], root);
    runCommand('git', ['commit', '-qm', 'audit history'], root);
    const source = await GitHeadCandidateSource.create(root);
    assert.ok(source);
    for (const mode of ['headless', 'session']) await render(true, mode, source);
});

test('提示词渲染拒绝越界占位符和变量，并且只替换一遍', () => {
    const fields = ['baseRevision', 'note'];
    const values = { baseRevision: 'abc', note: '{{baseRevision}} 和 {{taskJson}}' };
    assert.equal(renderPromptText('{{baseRevision}} {{note}} {{baseRevision}}', fields, values),
        'abc {{baseRevision}} 和 {{taskJson}} abc');
    assert.throws(() => renderPromptText('{{baseRevision}} {{note}}', fields, { note: '' }), /缺失或越界/);
    assert.throws(() => renderPromptText('{{baseRevision}} {{note}}', fields, { ...values, extra: '' }), /缺失或越界/);
    assert.throws(() => renderPromptText('{{baseRevision}} {{extra}}', fields, values), /占位符/);
    assert.throws(() => renderPromptText('{{baseRevision}}', fields, values), /占位符/);
});
