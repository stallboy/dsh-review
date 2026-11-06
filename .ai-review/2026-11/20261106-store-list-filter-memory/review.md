---
schema_version: 1
title: "store: 修复队列过滤提前丢弃被拒候选导致负向记忆失效"
module: store
audit_type: bugfix
created_at: "2026-11-06T17:19:07+08:00"
owner: "cxs"
tags: [store, api, memory, filter, bug]
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

队列带过滤条件时，`duplicateOf` 可能整体丢失，负向记忆（§7.4 重复阻止）失效。

- **触发场景**：存在一个窗口内的 rejected 候选 A 与指纹完全相同的活跃候选 B；调用 `store.list` 时传入会排除 A 的过滤条件。
- **可见后果**：B 的 `duplicateOf` 为 undefined，`/approve` 的重复检查（`src/host/api.ts:approve`）不会报 409，B 可被直接批准。
- **受影响入口**：`/approve` 内部以 `store.list({}, …, rejectionMemoryDays)` 查询（过滤为空，风险低）；任何新增的带过滤消费方（`/queue` 之后的复用、外部脚本）都会静默失守。
- **不易察觉**：无报错、无日志，只是重复阻止安静消失。

# 根因

- **代码位置**：`src/host/store.ts:ReviewStore.list` 的扫描循环。
- **缺陷写法**：循环内先 `if (!matchesReviewFilter(summary, filter)) continue;` 丢弃不匹配候选，再在循环外仅对 `items` 标注 `duplicateOf`。
- **触发链**：`statuses`/`owner`/`text` 等过滤条件先把 rejected 候选 A 从 `items` 移除 → 循环外的记忆标注只看 `items` → 活跃候选 B 找不到 A 的指纹 → `duplicateOf` 不设置。
- **对照**：同文件 `listStatusCounts` 与 `api.queue` 已依赖“过滤后仍保留全量摘要”的行为，说明过滤入口应当只有一个。

# 当前修复方案

- **核心改动**：循环内把所有摘要先收进局部数组 `summaries`，循环结束后统一过滤成 `items`，再做排序与负向记忆标注。
- **语义收敛**：过滤判断从 3 处（broken 分支、正常分支、异常分支）合并为 1 处，三类候选走同一过滤路径。
- **行为不变**：`items` 内容、排序、`errors`、broken 隔离、记忆窗口逻辑均保持原样，仅改变“何时过滤”。
- **顺带补测**：新增 `tests/store-list-filter.test.mjs`，用 `statuses: ['pending']` 过滤复现该缺陷。
- **备选取舍**：未改成“调用方自行保留全量”，因为那会把 §7 的阻止语义泄漏到 API 层，属更大改动。

# 需人工判断项

- **过滤语义**：修复假定 `filter` 只应影响返回列表、不应影响负向记忆计算；若将来产品希望“过滤掉的被拒候选也不再阻止”，需在 §7 明确后再改。

# 验证证据

- **验证基线**：`4f2b5a6e0b8e9a0593a0a28b2971503ce84c4088`
- **执行环境**：Windows / Node v24.15.0 / TypeScript 5.9（`npm run build` 产物 `dist/`）/ git 2.45.1
- **执行结果摘要**：
  - `npm run typecheck`：exit 0。
  - `npm test`：exit 0，100/100 通过（基线 99 项 + 本补丁新增 1 项）。
- **未覆盖风险**：新增用例覆盖 `statuses` 过滤路径；`owner`/`text`/`dir` 过滤走同一段合并逻辑，未逐条单独断言。

# 审核记录

## 版本 1 (base: 4f2b5a6e0b8e9a0593a0a28b2971503ce84c4088)
### 方案说明

把 `ReviewStore.list` 的过滤从扫描循环内部移到循环之后，新增一条回归测试。

- `src/host/store.ts`：新增 `summaries` 暂存数组，删除 3 处循环内过滤，循环后统一过滤。
- `tests/store-list-filter.test.mjs`：新增用例，断言被拒候选被 `statuses` 过滤排除后 `duplicateOf` 仍然生效。

### 验证结果

`npm run typecheck` 与 `npm test` 均 exit 0，100/100 通过。

### 人类总体意见

待审核

### 意见处理结果

无
