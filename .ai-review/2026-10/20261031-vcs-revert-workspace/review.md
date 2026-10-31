---
schema_version: 1
title: "vcs: 修复工作区还原残留暂存改动与新增文件"
module: vcs
audit_type: bugfix
created_at: "2026-10-31T23:20:00+08:00"
owner: "cxs"
tags: [git, svn, workspace, approval, bug]
status: pending
ticket: null
current_revision: 2
revisions:
  - id: 1
    base_revision: "402012744bcdd89fba50bb60cbf6fed84785ad67"
    patch: "001.patch"
  - id: 2
    base_revision: "402012744bcdd89fba50bb60cbf6fed84785ad67"
    patch: "002.patch"
gate_checks:
  - "npm run typecheck"
  - "npm test"
comments: []
approval: null
---

# 问题与影响

- **提交失败后是假回滚**：`atomicCommit` 已 `git add` 但 `git commit` 失败（hook、gpg 等）时，旧实现用 `git checkout -- .` 从索引恢复，暂存改动原样保留。批准返回 pending，工作区却仍是 `M  src/x.txt`，下次批准在 `ensureCleanWorkspace` 就失败。
- **`git add -N` 新文件无法还原**：AI 修复按提示词用 `git add -N` 让新文件进入 diff；旧实现既不能 checkout intent-to-add，`git clean -fd` 也不会删除已登记文件，候选永久卡在 DIRTY_WORKSPACE。
- **门禁产物污染工作区**：gate_checks 若执行了 `git add` 或格式化写回后失败，旧回滚不会清索引，随后 AI 修复可能在脏工作区上生成被污染的补丁。
- **失败审批的索引残留会串到后续提交**：v1 只清业务路径的索引，`.ai-review` 的暂存项仍留在索引里；而 `atomicCommit` 用不带 pathspec 的 `git commit` 提交整个索引，下一次任意候选批准都可能顺带提交上一候选的评审数据，甚至把它的 patch 删除一并带进去。
- **SVN 新增文件还原不掉**：`svn patch` 把新文件登记为 `A`；`svn revert -R` 只取消登记，文件留在磁盘变成 `?`，之后每次 `ensureCleanWorkspace` 都失败。
- **影响面**：审批失败、门禁失败、AI 修复失败与审查复核四条路径都依赖 `revertBusinessWorkspace`，Git/SVN 两条适配器都受影响。

# 根因

- **Git（v1 遗漏）**：`GitAdapter.revertBusinessWorkspace` 的 `git reset` 排除了 `.ai-review`，所以 `git checkout -- .` 之后索引里仍可能留有该目录的暂存新增、修改或删除。
- **提交侧放大**：`GitAdapter.atomicCommit` 先 `git add -A -- <paths>`，再执行不带 pathspec 的 `git commit -m`，提交的是整个索引；残留项因此会被后续提交带走。
- **SVN**：`SvnAdapter.revertBusinessWorkspace` 只对已版本化路径 `svn revert -R`；对 `A` 状态路径只取消登记，不删除磁盘文件。

# 当前修复方案

- **Git 索引清零**：还原时先执行 `git reset -q -- .` 重置整个索引（不再排除 `.ai-review`），再 `git checkout` + `git clean`；后两步仍排除 `.ai-review`，所以刚写入的 review.md/patch 内容保留，只是不再处于暂存态。
- **SVN 保持 v1 方案**：先记录 `A` 状态路径，`svn revert -R` 后递归删除这些文件/目录，使其真正回到基线。
- **测试补齐**：`tests/vcs.test.mjs` 共 5 例；新增“失败的 `atomicCommit` + 预置失败 pre-commit hook”用例，复现提交失败后的暂存残留；把 `.ai-review` 用例加强为“索引为空 + 文件内容保留”。
- **备选取舍**：不改 `atomicCommit` 为路径受限提交（会改变所有提交路径的契约，超出本候选范围），也不删除 `.ai-review` 内容（会丢失刚写入的待审数据）。在唯一的还原入口清空索引，调用方无需改动。

# 需人工判断项

- **还原语义**：回滚现在连 `.ai-review` 的索引状态一起清空，但保留其工作区文件；请确认这正是“失败审批不得把评审数据带入后续提交”的预期。
- **提交路径仍未收紧**：`atomicCommit` 仍执行不带 pathspec 的 `git commit`；本次只保证还原后索引干净。若还有并发写入在还原与提交之间暂存文件，仍会被带入，是否改为路径受限提交需单独决策。
- **验证环境限制**：本机 DSH 沙箱禁止命名管道，直接 `npm test` 会在测试启动前报 `spawn EPERM`；本次用仅本地生效的 stdio 转文件 preload 跑通 34/34，该 shim 不在补丁内，请在普通环境复跑 `npm test` 确认。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 11 (NT 10.0.26300) · Node.js v24.1.0 · TypeScript 5.9.3 · git 2.28.0 · svn 1.14.1
- **执行结果摘要**：
  - `npm run typecheck`：exit 0，3.7s。
  - `npm test`：exit 0，19.0s，34/34 通过（基线 29 + `tests/vcs.test.mjs` 5），skip 0。在基线 `4020127` 的临时 worktree 应用 `002.patch` 后执行。
  - `tests/vcs.test.mjs` 单跑：5/5 通过，4.4s，含 SVN 用例（svn 1.14.1 实跑）。
  - `git apply --check 002.patch`：在基线 `4020127` exit 0；在当前 HEAD `5d29573` exit 0。
- **未覆盖风险**：gpg 签名失败、SVN 属性/树冲突未构造；非 Windows 平台未实机运行；`npm test` 的沙箱 shim 与普通环境存在执行差异。

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
- **基线变化**：`402012744bcdd89fba50bb60cbf6fed84785ad67` 保持不变；当前仓库 HEAD `5d29573` 只包含已批准的其他候选，`002.patch` 在其上同样 `git apply --check` 通过。
- **代码与方案调整**：`git reset` 去掉 `:(exclude).ai-review`，改为重置整个索引；新增失败 `atomicCommit` 的恢复用例；加强 `.ai-review` 用例，断言暂存区为空且文件仍在。
- **意见处理**：本轮 `comments` 为空，没有人类评论可逐条回应；据 v1「需人工判断项」中的 `.ai-review` 索引状态一项主动收敛。
### 方案说明
还原入口现在同时清业务路径与 `.ai-review` 的索引状态，但 checkout/clean 继续排除 `.ai-review`，因此待审文件内容不丢；SVN 适配器维持 v1 的 `A` 状态删除逻辑。新增用例用失败 pre-commit hook 触发真实 `atomicCommit` 失败，验证还原后 `git diff --cached` 为空且业务文件回到基线。
### 验证结果
`npm run typecheck` exit 0；`npm test` exit 0，34/34（含 5 个 vcs 用例，SVN 本机实跑）；`002.patch` 在基线与当前 HEAD 上均 `git apply --check` 通过。
