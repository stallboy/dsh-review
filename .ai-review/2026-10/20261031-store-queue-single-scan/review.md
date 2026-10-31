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
  commit_revision: null
module: store
audit_type: shrink
---

# 问题与影响
- **触发场景（Concrete Case）**：客户端在队列页/详情页每 7 秒轮询一次 `GET /queue`（`src/client/client.ts` 的 `setInterval(..., 7000)`），每次操作后还会再调一次。旧实现 `ReviewApi.queue` 先执行 `store.list(filter, base)` 再执行 `store.list({ owner }, base)`；`ReviewStore.list` 对每个候选都要读取并解析 `review.md`（YAML + 正文分段 + 需人工判断项）以及读取并 `parsePatch` 当前版本补丁。于是每次轮询对 N 个候选产生 **2N 次 review.md 读取/解析 + 2N 次补丁读取/解析**，且这些解析都在 Node 主线程同步执行；候选较多、补丁较大时会成倍放大轮询开销并阻塞插件 API 的其它请求。
- **为什么第二次扫描没有信息增益**：`filterFrom(url, owner)` 第一行就是 `const filter: ReviewFilter = { owner }`，即过滤后的 `items` 必然是 `{ owner }` 扫描结果的子集；旧实现只是为了拿到 owner 维度的状态计数又完整扫了一遍。
- **不修复的影响**：队列轮询的 CPU 与磁盘 I/O 翻倍，候选越多、补丁越大越明显；这是审核队列的默认页面，属于“负载下稳定”问题而非功能错误。

# 根因
`ReviewStore` 把过滤谓词 `matchesFilter` 实现为私有方法，API 无法在同一次扫描里同时得到“过滤后的 items”和“owner 维度 counts”，只能在 `queue()` 里调用两次 `list()`。

# 当前修复方案
- 把 `matchesFilter` 原样提升为模块级导出函数 `matchesReviewFilter(summary, filter)`（无 `this` 依赖，判断逻辑逐行不变），`ReviewStore.list()` 与 API 共用同一实现。
- `ReviewApi.queue` 只调用一次 `store.list({ owner }, base)`，`items` 由 `all.items.filter((item) => matchesReviewFilter(item, filter))` 得到，`errors` 与 `counts` 均取自同一次扫描结果。
- 语义等价性：`list()` 的扫描错误在过滤之前收集、与 filter 无关；排序在 `list()` 内完成后再过滤，顺序不变；`filter.owner` 恒等于本次扫描的 owner（或为空字符串时新旧实现都不过滤 owner），因此 items 集合与旧实现一致。
- 新增 API 级回归测试（`tests/audit-api.test.mjs`）：构造 pending + approved 两个候选，`GET /queue?statuses=pending` 只返回 pending，但 `counts` 同时统计 approved；不带参数时返回 2 条且 `errors` 为空。

选择该方案而不是在 `queue()` 内保留两份扫描逻辑：过滤谓词必须与 `list()` 共用，否则两处判断容易漂移；把谓词提升为纯函数是最小改动，也避免为性能新增配置开关。

# 需人工判断项
- **业务逻辑与产品取舍**：无。响应字段、过滤语义、排序与 counts 均不变，这是一次内部去重。
- **架构、兼容性与性能影响**：`matchesReviewFilter` 成为 `store` 模块的导出函数（不是包级公开 API，`package.json` 的 exports 未变）；`/queue` 的读取与解析量从 2N 降到 N，`/health` 仍走 `listStatusCounts` 的单次扫描、未改动。本次未做基准量化，收益随候选数与补丁大小线性增长。
- **无法由自动化测试验证的边界条件**：性能收益没有基准断言（新增测试验证的是输出契约等价，它在旧实现上同样会通过，属于防回归用例而非缺陷复现）；`?owner=`（空字符串）时新旧实现都“不过滤 owner”，由同一谓词保证，未单独加用例。

# 验证证据
- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · TypeScript 5.9.3
- **执行结果摘要**：
  - `npm run typecheck`：exit 0（host + client 双 program）。
  - `npm test`：exit 0，30 项通过（原有 29 项 + 新增队列过滤回归用例 1 项），耗时约 14s。
  - 新增用例结果：`?statuses=pending` 返回 1 条 pending、`counts.pending=1`、`counts.approved=1`；无参请求返回 2 条、`errors=[]`。
  - 导出后 `git apply --check .ai-review/2026-10/20261031-store-queue-single-scan/001.patch`（干净基线上）：exit 0。
- **未覆盖风险**：见“无法由自动化测试验证的边界条件”。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
将 `ReviewStore.matchesFilter` 提升为导出的纯函数 `matchesReviewFilter`，`ReviewApi.queue` 改为一次 `list({ owner })` 扫描后本地复用谓词过滤，`errors`/`counts` 同源；新增 API 回归测试。修改文件：`src/host/store.ts`、`src/host/api.ts`、`tests/audit-api.test.mjs`。
### 验证结果
`npm run typecheck` 通过；`npm test` 30/30 通过（含新增队列过滤用例）；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)

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
