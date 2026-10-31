---
schema_version: 1
title: 'store: 队列查询改为单次扫描，去掉重复的全量候选与补丁解析'
created_at: '2026-10-31T23:31:00+08:00'
owner: cxs
tags:
  - performance
  - queue
  - store
  - api
  - shrink
status: approved
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: 402012744bcdd89fba50bb60cbf6fed84785ad67
    patch: 001.patch
gate_checks:
  - npm run typecheck
  - npm test
comments: []
approval:
  approved_by: cxs
  approved_at: '2026-10-31T15:31:21.082Z'
  commit_revision: 5e1d4bbebb665f0a0b21c2526c5c1d000d55e18a
module: store
audit_type: shrink
---

# 问题与影响

- **重复全量扫描**：队列页/详情页每 7 秒轮询 `GET /queue`；旧 `ReviewApi.queue` 先 `store.list(filter, base)` 再 `store.list({ owner }, base)`。
- **每次轮询的代价**：`ReviewStore.list` 对每个候选读取并解析 `review.md` 和当前补丁；N 个候选会产生 2N 次读取/解析，且在 Node 主线程同步执行。
- **没有信息增益**：`filterFrom(url, owner)` 第一行就是 `{ owner }`，过滤后的 items 必然是 owner 扫描结果的子集；第二次扫描只为拿 owner 维度的状态计数。
- **影响**：候选越多、补丁越大，轮询 CPU 与磁盘 I/O 越明显，可能阻塞插件其它 API 请求。

# 根因

- `ReviewStore` 把过滤谓词 `matchesFilter` 实现为私有方法。
- API 无法在一次扫描里同时得到“过滤后的 items”和“owner 维度 counts”，只能在 `queue()` 里调用两次 `list()`。

# 当前修复方案

- 把 `matchesFilter` 提升为模块级导出函数 `matchesReviewFilter(summary, filter)`，判断逻辑逐行不变，`ReviewStore.list()` 与 API 共用。
- `ReviewApi.queue` 只调用一次 `store.list({ owner }, base)`，`items` 由 `all.items.filter((item) => matchesReviewFilter(item, filter))` 得到，`errors`/`counts` 同源。
- **语义等价**：扫描错误在过滤前收集、与 filter 无关；排序在 `list()` 内完成后过滤，顺序不变；`filter.owner` 恒等于本次扫描 owner。
- **回归测试**：新增 API 用例，构造 pending + approved 两个候选，验证 `?statuses=pending` 只返回 pending，但 counts 同时统计 approved；无参请求返回 2 条且 `errors=[]`。
- **为什么不保留两份扫描**：过滤谓词必须与 `list()` 共用，否则两处判断容易漂移；提升为纯函数是最小改动。

# 需人工判断项

- **导出范围**：`matchesReviewFilter` 成为 `store` 模块的导出函数（不是包级公开 API，`package.json` 的 exports 未变）；`/health` 仍走 `listStatusCounts` 的单次扫描，未改动。
- **性能收益未量化**：`/queue` 的读取与解析量从 2N 降到 N，但本次没有基准断言；收益随候选数与补丁大小线性增长。
- **未单独覆盖的边界**：`?owner=`（空字符串）时新旧实现都“不过滤 owner”，由同一谓词保证，未单独加用例。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · TypeScript 5.9.3
- **门禁结果**：`npm run typecheck` exit 0；`npm test` exit 0，30/30（原 29 + 新增队列过滤用例 1 项），约 14s。
- **新增用例**：`?statuses=pending` 返回 1 条 pending、`counts.pending=1`、`counts.approved=1`；无参请求返回 2 条、`errors=[]`。
- **补丁校验**：`git apply --check .ai-review/2026-10/20261031-store-queue-single-scan/001.patch` exit 0。
- **未覆盖风险**：性能收益没有基准断言；新增用例验证输出契约等价，在旧实现上同样会通过。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
将 `ReviewStore.matchesFilter` 提升为导出的纯函数 `matchesReviewFilter`，`ReviewApi.queue` 改为一次 `list({ owner })` 扫描后本地复用谓词过滤，`errors`/`counts` 同源；新增 API 回归测试。
### 验证结果
<!-- ai-review:validation -->
### 门禁执行结果

- 工作目录: D:\work\mygithub\dsh-review · 基线: 5b65c05a0aa0bc742955b4ab1b70746455990a3d · 平台: win32 / node v24.21.0 · 执行时间: 2026-10-31T15:31:21.080Z

| 结果 | 命令 | 退出码 | 耗时 |
| --- | --- | --- | --- |
| 通过 | `npm run typecheck` | 0 | 2.1s |
| 通过 | `npm test` | 0 | 8.2s |
<!-- /ai-review:validation -->

### 人类总体意见

批准（cxs）

### 文案整理

2026-10-31：仅调整段落与列表可读性，未改变结论、补丁或批准记录。
