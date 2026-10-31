---
schema_version: 1
title: 'store: 删除无引用的候选写入门面与补丁读取包装'
created_at: '2026-10-31T23:26:00+08:00'
owner: cxs
tags:
  - dead-code
  - store
  - vcs
  - cleanup
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
  approved_at: '2026-10-31T15:35:43.746Z'
  commit_revision: e95100d6b100f685c483cc9271aadd5074f62e2a
module: store
audit_type: delete
---

# 问题与影响

- **7 个死成员**：`renamePatch`、`savePatch`、`deletePatchFiles`、`bumpRevision`、`readPatchStats`、`writeGateEvidence`、`vcs.readPatchText` 在全仓无调用者。
- **保留的代价**：旧写入门面与真实审批路径不同，误用会绕过 VCS 原子提交；同时为死方法保留 `mkdir`、`unlink`、`GateCheckResult`、`readFile` 等 import，增加阅读与类型依赖面积。
- **删除范围**：`src/host/store.ts` 与 `src/host/vcs.ts`，共 2 个文件、72 行删除、2 行修改。

# 根因

- 早期 `ReviewStore` 承担“写补丁、递增版本、删除补丁、写门禁证据”的写入门面。
- 后来流程改为“AI 直接写 `review.md` + `NNN.patch`，插件用 VCS 原子提交并删除补丁”，旧方法没有调用者，但一直保留。

# 当前修复方案

- 删除上述 7 个无引用成员，并清理只服务于它们的 `mkdir`、`unlink`、`GateCheckResult`、`readFile` import。
- 删除前用 `git grep` 逐符号检索：6 个成员各只命中定义自身，`savePatch` 仅被同批删除的 `bumpRevision` 引用。
- 无行为变化：`write`、`applyApproval`、`reject`、`readPatch`、`currentPatch`、`listStatusCounts` 等真实路径保持不变。

# 需人工判断项

- **公开契约**：`ReviewStore` 不是包的导出 API（`package.json` 只导出 `dist/index.js` 与 `dist/client.js`），删除不改变公开契约。
- **仓库外动态引用**：已用全仓字面量检索覆盖，未发现 `store['writeGateEvidence']` 之类的动态调用；若仓库外脚本直接 `import('.../dist/store.js')` 调用这些方法会失效（仓库内无此用法，README 也未承诺）。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · TypeScript 5.9.3
- **符号检索**：删除前逐符号 `git grep`，均无调用者。
- **门禁结果**：`npm run typecheck` exit 0；`npm test` exit 0，29/29，约 12s。
- **改动规模**：`git diff --stat` 为 2 files changed, 2 insertions(+), 72 deletions(-)。
- **补丁校验**：`git apply --check .ai-review/2026-10/20261031-store-dead-write-helpers/001.patch` exit 0。
- **未覆盖风险**：仓库外直接 import `dist/store.js` 的消费者（仓库内不存在）。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
删除 `src/host/store.ts` 中 6 个无引用方法与 `src/host/vcs.ts` 中 1 个无引用函数，并清理只为它们存在的 import。
### 验证结果
<!-- ai-review:validation -->
### 门禁执行结果

- 工作目录: D:\work\mygithub\dsh-review · 基线: bd1f174f244f0be58e7c9b403b1dd2f1a2e2dc1c · 平台: win32 / node v24.21.0 · 执行时间: 2026-10-31T15:35:43.744Z

| 结果 | 命令 | 退出码 | 耗时 |
| --- | --- | --- | --- |
| 通过 | `npm run typecheck` | 0 | 2.0s |
| 通过 | `npm test` | 0 | 8.2s |
<!-- /ai-review:validation -->

### 人类总体意见

批准（cxs）

### 文案整理

2026-10-31：仅调整段落与列表可读性，未改变结论、补丁或批准记录。
