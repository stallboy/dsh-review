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

- **提交失败后是假回滚**：`atomicCommit` 已 `git add` 但 `git commit` 失败（hook、gpg 等）时，旧实现用 `git checkout -- .` 从索引恢复，暂存改动原样保留。批准返回 pending，工作区却仍是 `M  src/x.txt`，下次批准在 `ensureCleanWorkspace` 就失败。
- **`git add -N` 新文件无法还原**：AI 修复按提示词用 `git add -N` 让新文件进入 diff；旧实现既不能 checkout intent-to-add，`git clean -fd` 也不会删除已登记文件，候选永久卡在 DIRTY_WORKSPACE。
- **门禁产物污染工作区**：gate_checks 若执行了 `git add` 或格式化写回后失败，旧回滚不会清索引，随后 AI 修复可能在脏工作区上生成被污染的补丁。
- **SVN 新增文件还原不掉**：`svn patch` 把新文件登记为 `A`；`svn revert -R` 只取消登记，文件留在磁盘变成 `?`，之后每次 `ensureCleanWorkspace` 都失败。
- **影响面**：审批失败、门禁失败、AI 修复失败与审查复核四条路径都依赖 `revertBusinessWorkspace`，Git/SVN 两条适配器都受影响。

# 根因

- `GitAdapter.revertBusinessWorkspace` 只做 `git checkout -- .` + `git clean -fd`：checkout 从索引恢复，不会丢弃暂存改动；clean 不处理 intent-to-add 条目。
- `SvnAdapter.revertBusinessWorkspace` 只对已版本化路径 `svn revert -R`；对 `A` 状态路径只取消登记，不删除磁盘文件。

# 当前修复方案

- **Git**：恢复前先 `git reset -q -- . ':(exclude).ai-review'` 清除业务路径的暂存/意图添加状态，再按原逻辑 checkout + clean。
- **SVN**：先记录状态为 `A` 的路径，`svn revert -R` 后递归删除这些文件/目录，使其真正回到基线。
- **保留 `.ai-review`**：两条路径都排除 `.ai-review`，AI 刚写入、尚待人工/AI 复核的 review.md 与 patch 不会被回滚。
- **测试**：新增 `tests/vcs.test.mjs` 4 个用例：Git 暂存改动、Git `add -N` 新文件、`.ai-review` 保留、SVN scheduled add（无 svn/svnadmin 时自动 skip）。
- **为什么不在审批层兜底**：`revertBusinessWorkspace` 是唯一的“还原业务工作区”契约，审批、AI 修复、审查复核三处共用；在实现内修正根因可一次覆盖所有调用点。

# 需人工判断项

- **还原语义**：本补丁把“还原”明确为“丢弃业务工作区全部未提交改动（含索引）并保留 `.ai-review`”。请确认回滚时是否也应清理 `.ai-review` 的索引状态（当前仍排除它，以便保留刚写入的 review.md/patch）。
- **兼容性与前置条件**：每次还原多一次 `git reset`（纯索引操作，无工作区 I/O 放大）；SVN 对 `A` 状态多一次递归删除。`git reset -- <pathspec>` 要求仓库已有 HEAD，而批准流程本身要求存在基线提交。
- **未覆盖的失败链路**：pre-commit hook 拒绝、gpg 签名失败等真实提交失败未构造；SVN 用例在无 svn 环境会 skip；Windows 之外平台未实机运行。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · git 2.28.0 · svn（TortoiseSVN）· TypeScript 5.9.3
- **门禁结果**：`npm run typecheck` exit 0；`npm test` exit 0，33/33（原 29 + 新增 `tests/vcs.test.mjs` 4 项），约 12s；SVN 用例本机实际执行。
- **旧实现探针**：commit 失败后仍为 `M  src/x.txt`；`git add -N` 后仍为 ` A new.txt`；`svn revert` 后 `A new.txt` 变 `? new.txt`。
- **新实现**：4 个用例全部通过（Git 工作区干净、intent-to-add 被删除、`.ai-review` 保留、SVN 状态为空且新增文件删除）。
- **补丁校验**：`git apply --check .ai-review/2026-10/20261031-vcs-revert-workspace/001.patch` exit 0。
- **未覆盖风险**：见“未覆盖的失败链路”。

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
