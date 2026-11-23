import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.argv[2];
if (prompt.includes('DSH_AUDIT_RECHECK=')) {
    const findings = mode === 'legacy-central-with-v2-history' ? [{
        id: 'v2-takeover', status: 'resolved',
        evidence: { file: 'src/math.js', line: 1, excerpt: 'a - b', reason: '核验回归夹具的基线' },
    }] : [];
    console.log(`DSH_AUDIT_RECHECK=${JSON.stringify({ findings, candidates: [] })}`);
    process.exit(0);
}

if (mode === 'failed-without-output') process.exit(5);
if (mode === 'change-archive') {
    appendFileSync('.ai-review/audits/20261117-090000-repo/audit.md', 'Runner 改写的历史内容\n');
}
if (mode === 'change-reviewers') {
    mkdirSync('.ai-review', { recursive: true });
    writeFileSync('.ai-review/reviewers.yml', 'default_owner: Runner 改写的负责人\nrules: []\n');
}
if (mode === 'change-business') {
    appendFileSync('src/math.js', '// 本地业务改动\n');
    writeFileSync('src/local-draft.js', '// 尚未提交的草稿\n');
}
const report = /审查报告文件（相对仓库根目录）[:：]\s*(\S+)/.exec(prompt)[1];
mkdirSync(path.dirname(report), { recursive: true });
writeFileSync(report, '# 本轮审查报告\n\n## A 类：已生成候选\n- 无\n');
