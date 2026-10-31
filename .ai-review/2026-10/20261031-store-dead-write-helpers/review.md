---
schema_version: 1
title: "store: 删除无引用的候选写入门面与补丁读取包装"
module: store
audit_type: delete
created_at: "2026-10-31T23:26:00+08:00"
owner: "cxs"
tags: [dead-code, store, vcs, cleanup]
status: pending
ticket: null
current_revision: 1
revisions:
  - id: 1
    base_revision: "402012744bcdd89fba50bb60cbf6fed84785ad67"
    patch: "001.patch"
gate_checks:
  - "npm run typecheck"
  - "npm test"
comments: []
approval: null
---

# 问题与影响
- **触发场景（Concrete Case）**：以下 7 个成员在当前仓库中没有任何调用者，属于被后续实现取代后遗留的写入门面。删除前用 `git grep` 对全仓（`src/`、`tests/`、`scripts/`、client 半）逐个符号检索，均只命中定义自身：
  - `ReviewStore.renamePatch`：只计算补丁路径并 `mkdir`，现在补丁由 AI 直接写入候选目录，无调用者；
  - `ReviewStore.savePatch`：唯一调用者是同批删除的 `bumpRevision`，删除后不再被引用；
  - `ReviewStore.deletePatchFiles`：补丁清理已改为 `vcs.atomicCommit({ deletePaths })` 的原子提交（`approval.ts` 与 `api.ts` 的 reject 路径），旧的非原子删除路径无调用者；
  - `ReviewStore.bumpRevision`：版本递增现在由 AI 直接更新 `review.md` + `NNN.patch`，并由 `Runner.verifyOutcome` 校验，无调用者；
  - `ReviewStore.readPatchStats`：队列/详情都直接 `parsePatch(await readFile(...))`，该重复实现无调用者；
  - `ReviewStore.writeGateEvidence`：批准证据已由 `validator.runGateChecks().formattedEvidenceMarkdown` 经 `applyApproval` 写入，旧 `ai-review:gate-evidence` 标记无调用者；
  - `vcs.readPatchText`：注释写着“exposed for the API/runner”，但 API/runner 实际使用 `store.readPatch` 或直接 `readFile`，无调用者。
- **不修复的影响**：后续维护者容易误以为存在第二条写入门面（`bumpRevision`/`deletePatchFiles` 与真实审批路径不同，误用会绕过原子提交）；同时为了这些死方法保留 `mkdir`、`unlink`、`GateCheckResult`、`readFile` 等 import，增加阅读与类型依赖面积。

# 根因
历史演进遗留：早期 `ReviewStore` 承担“写补丁、递增版本、删除补丁、写门禁证据”的写入门面；后来流程改为“AI 直接写 `review.md` + `NNN.patch`，插件用 VCS 原子提交并删除补丁”。新流程上线后旧方法没有调用者，但一直保留。

# 当前修复方案
删除 7 个无引用成员（`renamePatch`、`savePatch`、`deletePatchFiles`、`bumpRevision`、`readPatchStats`、`writeGateEvidence`、`readPatchText`），并移除只服务于它们的 `mkdir`、`unlink`、`GateCheckResult`、`readFile` import。共删除 72 行、修改 2 行，无行为变化：所有真实写入路径（`write`/`applyApproval`/`reject`/`readPatch`/`currentPatch`/`listStatusCounts` 等）保持不变。删除前用全仓字面量检索确认无静态、测试或脚本引用，删除后以 `npm run typecheck` 证明无编译期残留引用。

# 需人工判断项
- **业务逻辑与产品取舍**：无。删除的是无调用者的旧写入门面；若团队计划恢复“由 Store 写补丁/递增版本”的设计，应重新设计并引入，而不是保留会误导人的死代码。
- **架构、兼容性与性能影响**：`ReviewStore` 不是包的导出 API（`package.json` 只导出 `dist/index.js` 与 `dist/client.js`），删除不改变公开契约；无运行时与性能影响。
- **无法由自动化测试验证的边界条件**：动态调用（如 `store['writeGateEvidence']`）已由全仓字面量检索覆盖，未发现；若仓库外有脚本直接 `import('.../dist/store.js')` 调用这些方法会失效（仓库内无此用法，README 也未承诺）。

# 验证证据
- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · TypeScript 5.9.3
- **执行结果摘要**：
  - 删除前逐符号 `git grep`：`renamePatch`/`deletePatchFiles`/`readPatchStats`/`writeGateEvidence`/`readPatchText`/`bumpRevision` 各仅 1 处命中（定义自身）；`savePatch` 仅被 `bumpRevision` 引用。
  - `npm run typecheck`：exit 0（host + client 双 program）。
  - `npm test`：exit 0，29 项通过（无不新增测试：删除类改动由编译期引用检查 + 现有 29 项测试自证），耗时约 12s。
  - `git diff --stat`：`2 files changed, 2 insertions(+), 72 deletions(-)`（`src/host/store.ts`、`src/host/vcs.ts`）。
  - 导出后 `git apply --check .ai-review/2026-10/20261031-store-dead-write-helpers/001.patch`（干净基线上）：exit 0。
- **未覆盖风险**：仓库外直接 import `dist/store.js` 的消费者（不存在于本仓库）。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
删除 `src/host/store.ts` 中 6 个无引用方法与 `src/host/vcs.ts` 中 1 个无引用函数，并清理只为它们存在的 import。修改文件：`src/host/store.ts`、`src/host/vcs.ts`。
### 验证结果
删除前全仓符号检索均无调用者；`npm run typecheck` 通过；`npm test` 29/29 通过；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无
