import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAuditTemplate, renderPromptText } from '../packages/dsh-plugin/dist/host/audit-prompts.js';

test('总调度与阶段提示词保留作为数据输入的模板语法且展开生效契约', async () => {
    const note = '变量 {{taskJson}} 与 {{contractText}}\n保留第二行。';
    const orchestrator = await renderAuditTemplate('orchestrator', {
        auditId: '20261111-120000-src',
        baseRevision: 'a'.repeat(40),
        scope: 'src',
        vcsType: 'git',
        deadlineAt: '2026-11-11T13:00:00Z',
        reportPath: '.ai-review/audits/20261111-120000-src/audit.md',
        executionMode: 'session',
        availableRunners: ['codex', 'dsh-subagent'],
        ownerRouting: { defaultOwner: 'tester' },
        history: { openIssues: [] },
        focus: [note],
        extraRequirements: ['保留 {{taskJson}} 字面值'],
    });
    assert.ok(orchestrator.includes(JSON.stringify(note)));
    assert.match(orchestrator, /schema_version: 1/);
    assert.match(orchestrator, /dsh-subagent/);
    assert.doesNotMatch(orchestrator, /allowedGateCommands/);

    const patchPrompt = await renderAuditTemplate('patch', {
        auditId: '20261111-120000-src',
        baseRevision: 'a'.repeat(40),
        scope: 'src',
        vcsType: 'git',
        taskId: 'patch-1',
        subjectId: 'local-fix',
        confirmedFact: '加法运算符错误',
        evidence: [{ path: 'src/math.js', line: 1, excerpt: 'a - b', reason: '符号错' }],
        auditType: 'bugfix',
        allowedPaths: ['src/math.js'],
        acceptance: ['add(1, 2) === 3'],
        gateCommands: ['node --version'],
        ownerRouting: { defaultOwner: 'tester' },
        candidate: { optionId: 'opt-a', artifactDir: '.ai-review/audits/20261111-120000-src/stage-artifacts/patch-1' },
        existingIssue: { id: '2026-11/local-fix', note },
    });
    assert.ok(patchPrompt.includes(JSON.stringify(note)));
    assert.doesNotMatch(patchPrompt, /专用副本/);
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
