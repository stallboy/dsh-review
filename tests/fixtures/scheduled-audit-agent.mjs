import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeCandidate } from './contract.mjs';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

if (prompt.includes('DSH_AUDIT_RECHECK=')) {
    if (process.argv.includes('require-plan-note')) assert.doesNotMatch(prompt, /重点检查新增接口的兼容行为/);
    if (process.argv.includes('write-business-during-recheck')) {
        writeFileSync('src/math.js', '// 复查期间出现的业务改动\n');
        writeFileSync('local-note.txt', '复查期间出现的未跟踪文件\n');
        console.log('DSH_AUDIT_RECHECK={"findings":[],"candidates":[]}');
        process.exit(0);
    }
    if (process.argv.includes('write-during-recheck')) {
        const base = /^当前基线：(\w+)$/m.exec(prompt)?.[1];
        assert.ok(base);
        await writeCandidate(process.cwd(), 'stage-one-candidate', {
            review: { owner: '配置人', baseRevision: JSON.stringify(base), bodyLines: ['修复加法。', '# 需人工判断项', '- 无'] },
        });
        console.log('DSH_AUDIT_RECHECK={"findings":[],"candidates":[]}');
        process.exit(0);
    }
    assert.match(prompt, /20261117-090000-repo/);
    assert.match(prompt, /2026-11\/approved-last-round/);
    assert.match(prompt, /historical-fixed/);
    assert.match(prompt, /historical-unverified/);
    assert.doesNotMatch(prompt, /historical-dismissed/);
    assert.doesNotMatch(prompt, /uncommitted-placeholder/);
    assert.equal(readFileSync('src/math.js', 'utf8').trim(), 'export const add = (a, b) => a + b;');
    const evidence = { file: 'src/math.js', line: 1, excerpt: 'export const add = (a, b) => a + b;', reason: '加法实现已经使用加号。' };
    console.log('DSH_AUDIT_RECHECK=' + JSON.stringify({
        findings: [
            { id: 'historical-fixed', status: 'resolved', evidence },
            { id: 'historical-unverified', status: 'resolved', evidence: { ...evidence, excerpt: '没有出现在基线中的代码' } },
            { id: 'historical-linked', status: 'pending', evidence: { ...evidence, reason: '相关边界仍需在候选中处理。' } },
            { id: 'historical-unrelated-file', status: 'resolved', evidence: { file: 'UNRELATED.md', line: 1, excerpt: '# 无关说明', reason: '这个标题存在。' } },
            { id: 'unknown-id', status: 'resolved', evidence },
        ],
        candidates: [{ id: '2026-11/approved-last-round', status: 'verified', evidence }],
    }));
    process.exit(0);
}

if (process.argv.includes('require-plan-note')) assert.match(prompt, /重点检查新增接口的兼容行为/);
const reportPath = /审查报告文件（相对仓库根目录）[:：]\s*(\S+)/.exec(prompt)?.[1];
assert.ok(reportPath);
if (prompt.includes('本轮定时审查') && !process.argv.includes('write-during-recheck') && !process.argv.includes('write-business-during-recheck')) {
    assert.match(prompt, /历史复查已结束/);
    assert.match(prompt, /historical-fixed/);
    assert.match(prompt, /当前操作者 owner：审核者甲/);
}
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, [
    '# 仓库审查报告', '',
    '## A 类：已生成候选', '- 无', '',
    '## B 类：需人工确认（未改代码）',
    '- **未知边界**：仍缺少决定。', '',
    '- **已人工排除**：请再次处理。', '',
    '## 待前置合入后处理（Deferred）', '- 无', '',
    '## 历史问题复查', '- AI 报告不应覆盖已验证的结论。', '',
].join('\n'));
console.log('DONE');
