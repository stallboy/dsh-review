import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const reportMatch = /审查报告文件（相对仓库根目录）[:：]\s*(\S+)/.exec(prompt);
const reportPath = reportMatch ? reportMatch[1] : '.ai-review/audits/fallback.md';
const reportFile = path.join(process.cwd(), reportPath);
mkdirSync(path.dirname(reportFile), { recursive: true });
writeFileSync(
  reportFile,
  [
    '# 仓库审查报告',
    '',
    '## A 类：已生成候选',
    '- 无',
    '',
    '## B 类：需人工确认（未改代码）',
    '- **跨模块拆分**：需要产品确认边界后再拆。',
    '',
    '## 待前置合入后处理（Deferred）',
    '- 无',
    '',
  ].join('\n'),
  'utf8',
);
console.log('DONE');
