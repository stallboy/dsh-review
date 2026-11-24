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

// 固定包含优先级要求的模板输出，覆盖两种交付格式、两种启动方式及历史数据。
const baselineHashes = {
    'v1-headless': 'eed2fb1e54164cc5672360d8594032943f3135f6dd55b3fbaa668f7363110a73',
    'v1-session': '5b902108f7b85903a07656b5304cd7a3ea9a55ff379ec9d99942b1bdd54736bc',
    'v2-headless': '2b78b3e814bb39ecddfa705e1d437376644033b43c84e2be48ee7e594697517b',
    'v2-session': 'ec86482e55d8688a76271d2d43d0d1597b99d1c418da8d92d25b06d22f604f79',
    'v2-headless-history': 'e397c11073eb6c3887d84143a47de19c3608747262cd019ac05ef25a6fa1a076',
    'v2-session-history': 'f7c12a305d7edc5ac96e0ebaeba5e99b2b2220bc8d1c2c0a5cd807fe6b66deab',
};

test('直接执行提示词包含优先级规则，并保留作为数据输入的模板语法', async t => {
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
        assert.match(actual, /跨 A\/B\/Deferred 按 P0 → P1 → P2 → P3 排序/);
        assert.match(actual, /## 优先级总览\n\| 优先级 \| 问题 \| 处置 \|/);
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

test('提示词模板的 CRLF 换行统一为 LF，保留输入值中的换行', () => {
    const template = '## 任务数据\r\n{{taskJson}}\r\n\r\n从实际入口';
    const taskJson = '{\r\n  "question": "复核问题"\r\n}';
    assert.equal(renderPromptText(template, ['taskJson'], { taskJson }),
        '## 任务数据\n' + taskJson + '\n\n从实际入口');
});
