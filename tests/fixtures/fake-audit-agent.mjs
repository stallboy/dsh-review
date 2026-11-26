import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const reportMatch = /审查报告文件（相对仓库根目录）[:：]\s*(\S+)/.exec(prompt)
  ?? /"reportPath"\s*:\s*"([^"]+)"/.exec(prompt);
const reportPath = reportMatch ? reportMatch[1] : '.ai-review/audits/20261031-130000-repo/audit.md';
const trigger = /"trigger"\s*:\s*"scheduled"/.test(prompt) ? 'scheduled' : 'manual';
const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const source = path.join(process.cwd(), 'src', 'math.js');
writeFileSync(source, 'export const add = (a, b) => a + b;\n', 'utf8');
const patch = execFileSync('git', ['diff', '--binary'], { encoding: 'utf8' });
const patchSha = createHash('sha256').update(Buffer.from(patch, 'utf8')).digest('hex');

const candidateId = '2026-10/20261031-math-fix';
const candidateDir = path.join(process.cwd(), '.ai-review', '2026-10', '20261031-math-fix');
mkdirSync(candidateDir, { recursive: true });
writeFileSync(path.join(candidateDir, '001.patch'), patch, 'utf8');
writeFileSync(
  path.join(candidateDir, 'review.md'),
  `---
schema_version: 1
finding_id: "addition-operator"
title: "math: 修复加法实现"
module: math
audit_type: bugfix
issue_kind: repair
depends_on: null
priority: P2
base_revision: "${base}"
created_at: "2026-10-31T21:00:00+08:00"
updated_at: "2026-10-31T21:00:00+08:00"
owner: tester
tags: [math, bug]
ticket: null
status: pending
target_files: [src/math.js]
record_revision: 1
patches:
  - id: 1
    patch: "001.patch"
    option_id: opt-a
    base_revision: "${base}"
    author: ai
    sha256: "${patchSha}"
options:
  - id: opt-a
    title: "修正运算符"
    tradeoff: "最小改动"
    confidence: 0.95
    current_patch: 1
    gate_checks:
      - "node --version"
observations: []
decisions: []
repair_attempts: []
comments: []
human_decisions: []
approval: null
approval_history: []
rejection: null
commit_message: "math: 修复加法实现"
---

# 问题与影响
- 触发条件与现象：add(2, 2) 返回 0。

# 根因
减法写成了加法。

# 当前修复方案
改为加法。

# 需人工判断项
- 无

# 验证证据
- 验证基线：${base}
- 执行结果摘要：仅只读预检。

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
const auditDirName = path.basename(path.dirname(reportFile));
const tsMatch = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(auditDirName);
const createdAtUtc = tsMatch
  ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}.000Z`
  : '2026-10-31T13:00:00.000Z';
writeFileSync(
  reportFile,
  [
    '---',
    'schema_version: 1',
    `audit_id: "${auditDirName}"`,
    `created_at: "${createdAtUtc}"`,
    `base_revision: "${base}"`,
    'scope: "."',
    `trigger: ${trigger}`,
    'previous_audit: null',
    'issues:',
    `  - "${candidateId}"`,
    '---',
    '',
    '# 仓库审查报告',
    '',
    '## 优先级总览',
    '| 优先级 | 问题 | 处置 |',
    '| --- | --- | --- |',
    `| P2 | math: 修复加法实现 | repair (${candidateId}) |`,
    '',
  ].join('\n'),
  'utf8',
);

console.log(JSON.stringify({ type: 'status', phase: 'done' }));
console.log('DONE');
