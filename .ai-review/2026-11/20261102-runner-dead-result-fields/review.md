---
schema_version: 1
title: "runner: 删除无消费方的执行结果字段"
module: runner
audit_type: delete
created_at: "2026-11-02T11:53:00+08:00"
owner: "cxs"
tags: [dead-code, runner, cleanup]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "57213ddaa833d73be212721ce53bc961be35c3aa"
    patch: "001.patch"
gate_checks:
  - "npm run typecheck"
  - "npm test"
comments: []
approval: null
---

# 问题与影响
- **结论**：`RunnerExecutionResult.schemeChanged` 与 `newPatchPath` 只被赋值，没有任何消费方。
- **触发场景**：每次 AI 修复成功后，`verifyOutcome()` 都会把整段“当前修复方案”做一次字符串比较以计算 `schemeChanged`，并回传补丁绝对路径。
- **实际消费**：`approval.ts` 的回退分支只读取 `success`、`newRevisionId`；`api.ts` 的 AI 修复 job 也只记录版本号。
- **不修复的影响**：结果类型暗示“方案变化会参与批准失效判定”，但该判定并不存在，后续调用方容易误以为信号可信。

# 根因
- **代码位置**：`src/host/runner.ts` 的 `verifyOutcome()` 与 `src/host/types.ts` 的 `RunnerExecutionResult`。
- **触发链**：设计文档曾计划用 `schemeChanged` 判断旧批准是否失效；实现改为“AI 生成新版本即回到 pending”，字段失去消费者。
- **检索证据**：全仓仅命中字段声明与赋值处，无读取表达式。

# 当前修复方案
- **核心改动**：删除 `newPatchPath`、`schemeChanged` 两个可选字段，以及只为后者服务的 `previousSolution` 计算和返回值。
- **无行为变化**：补丁存在性、`.ai-review` 污染校验、版本号递增校验全部保留；仅去掉未被读取的结果数据。
- **备选取舍**：没有把 `schemeChanged` 接入批准流程。真正的“方案变化使旧批准失效”需要新的状态迁移规则，属于产品决策，不宜混入本次死字段清理。

# 需人工判断项
- **方案变化信号**：若后续确实要按“方案是否实质变化”决定旧批准是否失效，应为该信号补上消费方，而不是保留无读取方的字段。

# 验证证据
- **验证基线**：`57213ddaa833d73be212721ce53bc961be35c3aa`
- **执行环境**：Windows 11（10.0.22621）· Node.js v24.11.1 · TypeScript 5.9.3
- **执行结果摘要**：`npm run typecheck` exit 0；`npm test` exit 0，55/55 通过，约 13s。
- **补丁校验**：还原工作区后 `git apply --check` exit 0；2 个文件、5 行删除。
- **未覆盖风险**：若仓库外脚本消费 job 结果中的 `schemeChanged`/`newPatchPath`，会读不到值；仓库内无此用法，README 也未承诺。

# 审核记录

## 版本 1 (base: 57213ddaa833d73be212721ce53bc961be35c3aa)
### 方案说明
删除 `RunnerExecutionResult` 中无消费方的 `newPatchPath`、`schemeChanged`，并移除只为后者服务的方案文本比较。
### 验证结果
`npm run typecheck` 与 `npm test`（55/55）均通过；补丁可在基线干净应用。
### 人类总体意见
待审核
### 意见处理结果
无
