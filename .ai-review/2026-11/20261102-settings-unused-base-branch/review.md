---
schema_version: 1
title: "settings: 移除从未生效的 baseBranch 配置与无调用 helper"
module: settings
audit_type: delete
created_at: "2026-11-02T11:40:00+08:00"
owner: "cxs"
tags: [dead-code, settings, cleanup]
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
- **结论**：`baseBranch` 会被保存与合并，但全仓没有任何读取点；`resolveRepoRoot` 也没有调用者。
- **触发场景**：用户或脚本通过 `PUT /settings` 写入 `baseBranch`，或手工编辑 `$DSH_HOME/dsh-code-review/settings.json`，批准流程仍然只对当前分支执行 `pull --ff-only`，行为完全不变。
- **误导成本**：配置项、类型与 API 合并分支共同暗示“可以指定基线分支”，但 UI 没有该输入，代码也没有分支选择。
- **附带死代码**：`resolveRepoRoot` 仅做 `path.resolve`，`api.ts` 早已直接调用 `path.resolve`。

# 根因
- **代码位置**：`src/host/settings.ts` 的 `DEFAULT_SETTINGS` / `normalizeSettings` / `resolveRepoRoot`，以及 `src/host/types.ts`、`src/host/api.ts`、`src/client/client.ts` 中的字段声明与合并分支。
- **触发链**：早期设计预留了“基分支”设置；后来改为“评审仓库 = 当前会话工作目录 + 当前分支 `pull --ff-only`”，字段与 helper 没有随之删除。
- **无动态读取**：全仓 `grep` 仅命中字段声明、默认值、序列化和 PUT 合并，没有任何 `settings.baseBranch` 读取。

# 当前修复方案
- **核心改动**：删除 `AppSettings.baseBranch`、默认值、`normalizeSettings` 的解析、`PUT /settings` 的合并分支、前端 `Settings` 接口字段，并删除无调用的 `resolveRepoRoot`。
- **兼容性**：旧 `settings.json` 里残留的 `baseBranch` 仍能正常加载（未知键被忽略），下次保存时自然消失；因为从未被读取，行为不变。
- **备选取舍**：没有改为“真正支持基分支”，那需要改造 `syncAndGetLatestBase` 与批准语义，属于产品/架构变更，不适合本轮低风险精简。

# 需人工判断项
- **配置兼容**：若仓库外有脚本读取 `settings.json` 的 `baseBranch`，删除后会丢失该键；插件自身从未消费它，仓库内无此用法。

# 验证证据
- **验证基线**：`57213ddaa833d73be212721ce53bc961be35c3aa`
- **执行环境**：Windows 11（10.0.22621）· Node.js v24.11.1 · TypeScript 5.9.3
- **执行结果摘要**：`npm run typecheck` exit 0；`npm test` exit 0，55/55 通过，约 11s。
- **补丁校验**：还原工作区后 `git apply --check` exit 0；4 个文件，+1/-10。
- **未覆盖风险**：旧客户端若仍发送 `baseBranch`，服务端会忽略该字段，无副作用。

# 审核记录

## 版本 1 (base: 57213ddaa833d73be212721ce53bc961be35c3aa)
### 方案说明
删除从未被读取的 `baseBranch` 设置及其在类型、API 合并、前端接口中的残留，并移除无调用的 `resolveRepoRoot`。
### 验证结果
`npm run typecheck` 与 `npm test`（55/55）均通过；补丁可在基线干净应用。
### 人类总体意见
待审核
### 意见处理结果
无
