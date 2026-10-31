import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const source = path.join(process.cwd(), 'src', 'math.js');
writeFileSync(source, '// reviewed by audit\n' + execFileSync('git', ['show', `HEAD:src/math.js`], { encoding: 'utf8' }), 'utf8');
const patch = execFileSync('git', ['diff', '--binary'], { encoding: 'utf8' });

const candidateDir = path.join(process.cwd(), '.ai-review', '2026-10', '20261031-invalid');
mkdirSync(candidateDir, { recursive: true });
writeFileSync(path.join(candidateDir, '001.patch'), patch, 'utf8');
writeFileSync(
  path.join(candidateDir, 'review.md'),
  `---
schema_version: 1
title: "math: 无效候选"
created_at: "2026-10-31T21:00:00+08:00"
owner: tester
tags: [math]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "${base}"
    patch: "001.patch"
gate_checks: []
comments: []
approval: null
---

# 问题与影响
测试用。

# 根因
测试用。

# 当前修复方案
测试用。

# 需人工判断项
- 无

# 验证证据
未执行。

# 审核记录
无。
`,
  'utf8',
);
execFileSync('git', ['checkout', '--', 'src/math.js']);
console.log('DONE');
