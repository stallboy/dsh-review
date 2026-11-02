---
schema_version: 1
title: "api: 删除只写不读的仓库状态字段"
module: api
audit_type: delete
created_at: "2026-11-02T11:47:00+08:00"
owner: "cxs"
tags: [dead-code, api, cleanup]
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
- **结论**：`ReviewApi` 的 `store` 与 `vcs` 字段只有赋值、没有任何读取，属于死状态。
- **触发场景**：插件初始化或每次 `PUT /settings` 时，`reconfigure()` 都会为 `settings.repoRoot` 构造一个 `ReviewStore` 与一个 `VcsAdapter`，随后再也不会使用。
- **真正路径**：每个请求都经 `runtimeFor(url)` 按 `sessionId` 的工作目录另建 `Runtime`，与这两个字段无关。
- **不修复的影响**：读者会误以为存在“配置仓库级 store/vcs”和“会话级 runtime”两套权威来源；未来若误用字段，会把操作落到 `settings.repoRoot` 而不是当前会话仓库。

# 根因
- **代码位置**：`src/host/api.ts` 的 `ReviewApi.reconfigure()` 与字段声明。
- **触发链**：早期实现按 `settings.repoRoot` 建单例 store/vcs；后来引入会话级 `runtimeFor()`，字段保留下来只写不读。
- **检索证据**：全文件检索 `this.store` / `this.vcs`，仅命中声明、置空和赋值，没有任何读取表达式。

# 当前修复方案
- **核心改动**：删除两个字段、`reconfigure()` 中的置空与构造，以及只为构造服务的 `if (!validation.vcsType) return;` 尾段；`vcsType` 与 `configErrors` 仍按原逻辑保留。
- **无行为变化**：`runtimeFor()`、`health()`、`queue()` 等真实路径不变，仍使用会话级 `Runtime`。
- **备选取舍**：没有把字段改成 `runtimeCache` 的别名，因为请求根目录取决于 `sessionId`，不存在单一“当前仓库”可供缓存复用。

# 需人工判断项
- 无

# 验证证据
- **验证基线**：`57213ddaa833d73be212721ce53bc961be35c3aa`
- **执行环境**：Windows 11（10.0.22621）· Node.js v24.11.1 · TypeScript 5.9.3
- **执行结果摘要**：`npm run typecheck` exit 0；`npm test` exit 0，55/55 通过，约 12s。
- **补丁校验**：还原工作区后 `git apply --check` exit 0；改动 1 个文件、8 行删除。
- **未覆盖风险**：字段为 `private`，不属于导出契约；仓库外无法引用。

# 审核记录

## 版本 1 (base: 57213ddaa833d73be212721ce53bc961be35c3aa)
### 方案说明
删除 `ReviewApi` 中只写不读的 `store`/`vcs` 字段及其在 `reconfigure()` 中的构造与清理。
### 验证结果
`npm run typecheck` 与 `npm test`（55/55）均通过；补丁可在基线干净应用。
### 人类总体意见
待审核
### 意见处理结果
无
