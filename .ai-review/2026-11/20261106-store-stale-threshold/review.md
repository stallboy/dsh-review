---
schema_version: 1
title: "store: 统一超时判定，修复时间列不可解析时超时归档静默失效"
module: store
audit_type: bugfix
created_at: "2026-11-06T17:21:40+08:00"
owner: "cxs"
tags: [store, stale, queue, bug]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "4f2b5a6e0b8e9a0593a0a28b2971503ce84c4088"
    patch: "001.patch"
gate_checks:
  - "npm run typecheck"
  - "npm test"
comments: []
approval: null
---

# 问题与影响

队列显示“已过期、可归档”，实际点“超时归档”却不终止，候选长期停留在 pending。

- **触发场景**：候选的 `updated_at`（缺失时回退到 `created_at`）不是可解析的绝对时间，这类数据在多时区提交、手改 `updated_at` 时会出现。
- **错误结果**：队列 `toSummary` 的判定因 `Number.isNaN(anchor)` 直接判定“未过期”，但 `reject(requireStaleDays)` 走另一段比较，算出 `ageDays = NaN`，`NaN < staleDays` 为 false，于是按超时归档**通过**并写入 `system:stale`。
- **不修复的影响**：两端口径相反；审核者看到的是“未过期”，系统记录的是“超时废弃”，覆盖了 revision 列表的归档语义。

# 根因

- **代码位置**：`src/host/store.ts` 的 `toSummary`（`isStale` 计算）与 `reject(requireStaleDays)`。
- **缺陷写法**：同一 §18.1 的“超过 stale_days”被实现两次：队列侧写 `!archived && !Number.isNaN(anchor) && (Date.now() - anchor) / 86_400_000 >= staleDays`；归档侧写 `ageDays < requireStaleDays` 再抛错。
- **触发链**：无效时间 → 队列分支 `Number.isNaN` 短路为 false → 不提示过期；归档分支 `NaN < n` 为 false → 不抛错 → 直接写入 rejected。
- **附带缺陷**：`reject` 内先算 `ageDays` 再检查 `Number.isNaN(anchor)`，NaN 检查是死代码；错误消息里的 `ageDays.toFixed(1)` 对无效时间无意义。

# 当前修复方案

- **核心改动**：抽出模块级 `isStaleCandidate(meta, staleDays)`，队列 `isStale` 与 `reject(requireStaleDays)` 都调用它，删除两处重复实现。
- **统一口径**：`updated_at`/`created_at` 不可解析时一律视为未过期，归档侧抛 409 并省略无意义的“当前 N 天”。
- **行为保持**：`staleDays` 为 0/null 时双方仍然都不判定过期；已归档候选仍不判定过期。
- **顺带补测**：新增 `tests/store-stale-threshold.test.mjs`，断言队列提示与显式归档对同一批候选给出同一结论。

# 需人工判断项

- **无效时间的语义**：本修复把“时间不可解析”统一判为未过期（宁可不动待审数据）。若期望改为“视为过期并允许归档”，只需翻转头判定并同步两条 409 文案。

# 验证证据

- **验证基线**：`4f2b5a6e0b8e9a0593a0a28b2971503ce84c4088`
- **执行环境**：Windows / Node v24.15.0 / TypeScript 5.9（`npm run build` 产物 `dist/`）/ git 2.45.1
- **执行结果摘要**：
  - `npm run typecheck`：exit 0。
  - `npm test`：exit 0，100/100 通过（基线 99 项 + 本补丁新增 1 项）。
- **未覆盖风险**：无效 `updated_at` 的分支无法出现在合法候选中（I13 会先标记 broken），因此未单独构造该输入断言；只覆盖了正常过期/未过期两条路径与两侧口径一致。

# 审核记录

## 版本 1 (base: 4f2b5a6e0b8e9a0593a0a28b2971503ce84c4088)
### 方案说明

把超时判定收敛为一个 `isStaleCandidate` 函数，队列与显式归档共用。

- `src/host/store.ts`：新增 `isStaleCandidate`；`toSummary` 与 `reject` 改为调用它，删除重复判断与 NaN 死代码。
- `tests/store-stale-threshold.test.mjs`：新增用例，断言过期候选可归档、未过期候选被拒绝，且队列 `isStale` 与归档结论一致。

### 验证结果

`npm run typecheck` 与 `npm test` 均 exit 0，100/100 通过。

### 人类总体意见

待审核

### 意见处理结果

无
