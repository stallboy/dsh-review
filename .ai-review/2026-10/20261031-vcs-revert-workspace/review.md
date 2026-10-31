---
schema_version: 1
title: 'vcs: 修复工作区还原残留暂存改动与新增文件'
created_at: '2026-10-31T23:20:00+08:00'
owner: cxs
tags:
  - git
  - svn
  - workspace
  - approval
  - bug
status: approved
ticket: null
current_revision: 3
revisions:
  - id: 1
    base_revision: 402012744bcdd89fba50bb60cbf6fed84785ad67
    patch: 001.patch
  - id: 2
    base_revision: 402012744bcdd89fba50bb60cbf6fed84785ad67
    patch: 002.patch
  - id: 3
    base_revision: 402012744bcdd89fba50bb60cbf6fed84785ad67
    patch: 003.patch
gate_checks:
  - npm run typecheck
  - npm test
comments:
  - id: cmvwnsvxof0ye
    revision: 2
    file: ''
    line: 0
    author: cxs
    content: 检查下应该提交吗？应该的话就提交
    status: partial
    created_at: '2026-10-31T17:12:39.084Z'
approval:
  approved_by: cxs
  approved_at: '2026-10-31T17:45:11.650Z'
  commit_revision: null
module: vcs
audit_type: bugfix
---

# 问题与影响

- **失败提交后是假回滚**：`atomicCommit` 已暂存但 `git commit` 失败（hook/gpg）时，旧实现用 `git checkout -- .` 从索引恢复，暂存改动仍原样保留。
- **`git add -N` 新文件无法还原**：旧实现既不能 checkout intent-to-add，`git clean -fd` 也不删已登记文件，候选会卡在 DIRTY_WORKSPACE。
- **索引残留会串到后续提交**：`atomicCommit` 提交整个索引，残留的 `.ai-review` 暂存项可能被下一次批准顺带提交，甚至把 patch 删除一并带入。
- **SVN 新增文件还原不掉**：`svn revert -R` 只取消 `A` 登记，文件留在磁盘变成 `?`，后续工作区检查持续失败。
- **影响面**：审批失败、门禁失败、AI 修复失败与审查复核四条路径共用 `revertBusinessWorkspace`，Git/SVN 适配器都受影响。

# 根因

- **Git**：`checkout` 从索引恢复；v1 的 `reset` 排除 `.ai-review`，该目录的暂存新增/修改/删除仍会残留。
- **提交侧放大**：`GitAdapter.atomicCommit` 先 `git add -A -- <paths>`，再不限 pathspec 执行 `git commit`，提交整个索引。
- **SVN**：`SvnAdapter.revertBusinessWorkspace` 仅对已版本化路径 `svn revert -R`，`A` 状态取消登记后不删除磁盘文件。

# 当前修复方案

- **Git 索引清零**：还原时先 `git reset -q -- .` 重置整个索引，再 `git checkout` + `git clean`；后两步仍排除 `.ai-review`，待审文件内容保留但不再暂存。
- **SVN 清理新增**：先记录 `A` 状态路径，`svn revert -R` 后递归删除这些文件/目录，使其真正回到基线。
- **测试覆盖**：`tests/vcs.test.mjs` 共 5 例，含失败 `atomicCommit` + 失败 pre-commit hook 用例，以及 `.ai-review` 索引为空、文件内容保留的断言。
- **v3 未改代码**：仅复核可提交性并重新导出全量补丁；`003.patch` 与 `002.patch` 逐字节一致，版本号递增用于记录本轮审核意见处理。

# 需人工判断项

- **提交动作**：改动已满足提交条件，但 AI 流程禁止 `git commit`；请在审核面板点击“批准”，由 `approval.ts` 的 `atomicCommit` 完成提交。
- **基线错位**：记录基线仍是 `4020127`，当前 HEAD 已到 `c674152`；补丁只含本候选两个文件，已在两端验证可干净应用，是否需重建到最新基线请确认。
- **还原语义**：回滚会清空 `.ai-review` 的索引状态但保留工作区文件内容，请确认这正是“失败审批不把评审数据带入后续提交”的预期。
- **提交路径未收紧**：`atomicCommit` 仍提交整个索引；本次只保证还原后索引干净，是否改为路径受限提交需单独决策。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`（补丁基准）；当前 HEAD `c674152783174b73cba1df28c3f299e5092a9248`（批准时实际应用基线）。
- **执行环境**：Windows 11 (NT 10.0.26300) · Node.js v24.1.0 · npm 11.3.0 · TypeScript 5.9.3 · git 2.28.0 · svn 1.14.1。
- **执行结果摘要**：
  - `npm run typecheck`：exit 0，2.6s（HEAD + 003）。
  - `npm test` @ HEAD `c674152` + 003：exit 0，15.5s，55/55 通过，skip 0。
  - `npm test` @ base `4020127` + 003（临时 worktree）：exit 0，16.5s，34/34 通过，skip 0。
  - `git apply --check --binary 003.patch`：base `4020127` exit 0；HEAD `c674152` exit 0。
  - 沙箱内直接 `npm test` 会在测试启动前 `spawn EPERM`；上述结果用 `NODE_OPTIONS=--experimental-test-isolation=none --require <本地 stdio shim>` 运行同一命令取得，shim 不在补丁内。
- **未覆盖风险**：gpg 签名失败、SVN 属性/树冲突未构造；非 Windows 平台未实机运行；shim 使用进程内测试隔离，与默认逐文件隔离存在差异；真实批准提交链路本轮未执行。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
在 `GitAdapter.revertBusinessWorkspace` 增加 `git reset` 清索引（排除 `.ai-review`），在 `SvnAdapter.revertBusinessWorkspace` 对 `A` 状态路径在 revert 后删除；新增 `tests/vcs.test.mjs` 覆盖 Git 暂存、intent-to-add、`.ai-review` 保留与 SVN scheduled add。
### 验证结果
`npm run typecheck` 通过；`npm test` 33/33 通过（含 4 个新用例，SVN 用例本机实跑）；旧实现的三种残留均用探针复现；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无

## 版本 2 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 相对上一版的变化
- **基线变化**：`402012744bcdd89fba50bb60cbf6fed84785ad67` 保持不变；当前仓库 HEAD 已包含其他已批准改动，`002.patch` 在基线与当前 HEAD 上均 `git apply --check` 通过。
- **代码与方案调整**：`git reset` 去掉 `:(exclude).ai-review`，改为重置整个索引；新增失败 `atomicCommit` 的恢复用例；加强 `.ai-review` 用例，断言暂存区为空且文件仍在。
- **意见处理**：本轮 `comments` 为空，没有人类评论可逐条回应；据 v1「需人工判断项」中的 `.ai-review` 索引状态一项主动收敛。
### 方案说明
还原入口现在同时清业务路径与 `.ai-review` 的索引状态，但 checkout/clean 继续排除 `.ai-review`，因此待审文件内容不丢；SVN 适配器维持 v1 的 `A` 状态删除逻辑。新增用例用失败 pre-commit hook 触发真实 `atomicCommit` 失败，验证还原后 `git diff --cached` 为空且业务文件回到基线。
### 验证结果
`npm run typecheck` exit 0；`npm test` exit 0，34/34（含 5 个 vcs 用例，SVN 本机实跑）；`002.patch` 在基线与当前 HEAD 上均 `git apply --check` 通过。

## 版本 3 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 相对上一版的变化
- **基线变化**：记录基线保持 `4020127` 不变；当前 HEAD 为 `c674152`（含其他候选的已批准改动），`003.patch` 在两端均 `git apply --check` 通过。
- **代码与方案调整**：无业务代码改动；`003.patch` 与 `002.patch` 逐字节一致（6871 字节，LF 换行），仅按流程重新导出全量补丁。
- **意见处理 `cmvwnsvxof0ye`**：已核对可提交性——类型检查通过、55/55 测试通过、无业务脏改、补丁可干净应用，具备批准提交条件。
- **未执行提交**：按工作流硬性约束，AI 不执行 `git commit`/`svn commit`；提交须由负责人点击“批准”触发原子提交，故该评论标记 `partial`。
### 方案说明
沿用 v2 的 Git 索引清零与 SVN `A` 状态删除方案，代码未变。v3 只补充可提交性核查、重新导出补丁并更新评审记录；`.ai-review` 的还原语义与提交路径风险仍在“需人工判断项”中保留。
### 验证结果
`npm run typecheck` exit 0（2.6s）；`npm test` 在 HEAD + 003 上 exit 0（55/55，15.5s），在 base `4020127` + 003 上 exit 0（34/34，16.5s）；`003.patch` 在 base 与 HEAD 上均通过 `git apply --check`。

## 版本 3 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)

### 验证结果

<!-- ai-review:validation -->
### 门禁执行结果

- 工作目录: D:\work\mygithub\dsh-review · 基线: 116f46fc380cdf8d19eeed20f78c762b1027d503 · 平台: win32 / node v24.21.0 · 执行时间: 2026-10-31T17:45:11.647Z

| 结果 | 命令 | 退出码 | 耗时 |
| --- | --- | --- | --- |
| 通过 | `npm run typecheck` | 0 | 2.1s |
| 通过 | `npm test` | 0 | 11.2s |
<!-- /ai-review:validation -->

### 人类总体意见

批准（cxs）
