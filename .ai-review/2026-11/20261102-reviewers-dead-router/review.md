---
schema_version: 1
title: "reviewers: 删除未接入的 owner 路由解析器"
module: reviewers
audit_type: delete
created_at: "2026-11-02T11:32:00+08:00"
owner: "cxs"
tags: [dead-code, reviewers, cleanup]
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
- **结论**：`resolveOwner` 及其 glob 转换器在全仓没有任何调用，属于 100% 死代码。
- **触发场景**：读取候选人配置时，`api.ts` 只调用 `loadReviewers()` 把 `reviewers.yml` 原样返回；前端从未请求 `/reviewers`，也从未调用路由。
- **实际归属路径**：候选的 `owner` 由 AI 按审查提示词直接写入 `review.md`，插件侧不存在“按路径/tag 计算 owner”的执行点。
- **不修复的影响**：62 行无入口代码会让读者误以为插件已实现 owner 路由；提示词、README 与代码三处对同一能力的描述互相矛盾。

# 根因
- **代码位置**：`src/host/reviewers.ts` 中的 `resolveOwner`、`globToRegExp`、`RouteInput`、`RouteDecision`。
- **触发链**：`code.md` 规划了 `IReviewRouter.resolveOwner`，`reviewers.ts` 实现了它，但 `api.ts` 只接入了配置读取；`grep` 全仓仅命中定义自身，没有任何调用边。
- **无动态入口**：`package.json` 未导出 `dist/reviewers.js`，仓库内也没有字符串反射调用。

# 当前修复方案
- **核心改动**：删除 `resolveOwner`、`globToRegExp` 与两个仅服务于它的接口，保留 `loadReviewers`、`reviewersPath`、`ReviewersConfig`、`EMPTY_REVIEWERS`。
- **备选取舍**：没有把 `resolveOwner` 接进候选创建流程。创建动作由 AI 在会话中完成，插件侧无创建入口；强行接线会改变谁拥有候选的业务语义，属于需要人类拍板的产品变更。
- **删除依据**：全仓静态检索仅命中定义处；无测试、配置或脚本引用。

# 需人工判断项
- **路由能力是否保留**：若计划让插件按 `reviewers.yml` 自动分配 owner，应改为接线而非删除；本轮按无调用死代码处理，实现可从 Git 历史恢复。另需确认 README/`code.md` 中“owner 路由”的描述是否同步改写。

# 验证证据
- **验证基线**：`57213ddaa833d73be212721ce53bc961be35c3aa`
- **执行环境**：Windows 11（10.0.22621）· Node.js v24.11.1 · TypeScript 5.9.3
- **执行结果摘要**：`npm run typecheck` exit 0；`npm test` exit 0，55/55 通过，约 11s。
- **补丁校验**：还原工作区后 `git apply --check` exit 0；改动 1 个文件、62 行删除。
- **未覆盖风险**：仓库外若直接 `import('.../dist/reviewers.js')` 调用 `resolveOwner` 会失效；仓库内无此用法，包也未导出该模块。

# 审核记录

## 版本 1 (base: 57213ddaa833d73be212721ce53bc961be35c3aa)
### 方案说明
删除 `src/host/reviewers.ts` 中未被任何代码调用的 owner 路由解析器及其 glob 转换器。
### 验证结果
`npm run typecheck` 与 `npm test`（55/55）均通过；补丁可在基线干净应用。
### 人类总体意见
待审核
### 意见处理结果
无
