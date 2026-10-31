import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const reportMatch = /审查报告文件（相对仓库根目录）[:：]\s*(\S+)/.exec(prompt);
const reportPath = reportMatch ? reportMatch[1] : '.ai-review/audits/fallback.md';
const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const source = path.join(process.cwd(), 'src', 'math.js');
writeFileSync(source, 'export const add = (a, b) => a + b;\n', 'utf8');
const patch = execFileSync('git', ['diff', '--binary'], { encoding: 'utf8' });

const candidateDir = path.join(process.cwd(), '.ai-review', '2026-10', '20261031-math-fix');
mkdirSync(candidateDir, { recursive: true });
writeFileSync(path.join(candidateDir, '001.patch'), patch, 'utf8');
writeFileSync(
  path.join(candidateDir, 'review.md'),
  `---
schema_version: 1
title: "math: 修复加法实现"
created_at: "2026-10-31T21:00:00+08:00"
owner: tester
tags: [math, bug]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "${base}"
    patch: "001.patch"
gate_checks:
  - "node --version"
comments: []
approval: null
---

# 问题与影响
- 触发条件与现象：add(2, 2) 返回 0。

# 根因
减法写成了加法。

# 当前修复方案
改为加法。

# 需人工判断项
- 业务逻辑与产品取舍：无。

# 验证证据
- 验证基线：${base}
- 执行结果摘要：node --version 通过。

# 审核记录

## 版本 1 (base: ${base})
### 方案说明
修正运算符。
`,
  'utf8',
);
execFileSync('git', ['checkout', '--', 'src/math.js']);

const reportFile = path.join(process.cwd(), reportPath);
mkdirSync(path.dirname(reportFile), { recursive: true });
writeFileSync(
  reportFile,
  [
    '# 仓库审查报告',
    '',
    '## A 类：已生成候选',
    '- .ai-review/2026-10/20261031-math-fix：修复加法实现',
    '',
    '## B 类：需人工确认（未改代码）',
    '- **公开 API 语义**：加法修正会改变异常输入下的返回值，需要产品确认。',
    '',
    '## 待前置合入后处理（Deferred）',
    '- **缓存层重构**：依赖 math 候选先合入。',
    '',
  ].join('\n'),
  'utf8',
);

console.log(JSON.stringify({ type: 'status', phase: 'done' }));
console.log('DONE');
