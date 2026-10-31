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
- **触发场景（Concrete Case）**：
  1. **提交失败后的回滚是假回滚**：批准流程里 `atomicCommit` 已经 `git add` 成功、而 `git commit` 失败（仓库配置了拒绝提交的 pre-commit hook、gpg 签名失败、hook 环境错误等），`approval.ts` 随即调用 `revertBusinessWorkspace`。旧实现用 `git checkout -- .` 恢复，**不带 tree-ish 的 checkout 从索引恢复**，暂存区里的业务改动原样留在工作区。实测：commit 失败后 `git status --porcelain` 为 `M  src/x.txt`，调用旧实现后仍是 `M  src/x.txt`，文件内容仍是修改后的值。下一次批准在第一步 `ensureCleanWorkspace` 就被判为 DIRTY_WORKSPACE，用户看到“已回滚到 pending”，实际工作区没有回滚。
  2. **`git add -N` 新文件无法被还原**：AI 修复提示词（`runner.ts` `buildFixPrompt`）明确要求用 `git add -N <新文件>` 让新文件进入 `git diff`。任务结束/失败后若新文件还在工作区，`git checkout -- .` 对 intent-to-add 条目无能为力，`git clean -fd` 也不会删除已登记在索引中的文件。实测：`git add -N new.txt` 后调用旧实现，`git status` 仍为 ` A new.txt`、文件仍在；候选之后永久卡在 DIRTY_WORKSPACE，必须人工清理。
  3. **门禁命令污染工作区**：gate_checks 里的命令如果执行了 `git add` 或格式化写回文件后失败，旧实现回滚后这些暂存内容仍在；随后 `fixOrFallback` 以 `workingTree: 'clean_base'` 调用 AI 修复，但工作区实际是脏的，下一版补丁可能混入门禁产物。
  4. **SVN 新增文件还原不掉**：`svn patch` 新增文件会把文件登记为 `A`；旧实现只执行 `svn revert -R`，而 SVN 的 revert 仅取消登记、文件留在磁盘变成 `?`，`svn cleanup` 后仍是 `?`。实测：`svn status` 从 `A       new.txt` 变成 `?       new.txt`，文件仍存在；之后每次批准的 `ensureCleanWorkspace` 都失败。
- **不修复的影响**：批准失败/门禁失败/AI 修复失败后的“还原工作区”契约不成立，候选被永久卡在 DIRTY_WORKSPACE，需要用户手工清理；AI 修复可能在脏工作区上生成被污染的补丁；Git（含文档化 `git add -N` 流程）与 SVN 两条路径都受影响。

# 根因
`src/host/vcs.ts`：
- `GitAdapter.revertBusinessWorkspace` 只执行 `git checkout -- .`（从索引恢复）与 `git clean -fd`。索引里的暂存改动不会被 checkout 丢弃，intent-to-add 条目也不被 clean 处理，因此工作区没有真正回到 `HEAD`。
- `SvnAdapter.revertBusinessWorkspace` 只对已版本化路径 `svn revert -R`；对 `svn patch`/`svn add` 产生的计划新增（`A`）路径，revert 只取消登记，文件留在磁盘成为未版本化文件。

# 当前修复方案
- Git：恢复前先 `git reset -q -- . ':(exclude).ai-review'` 清除业务路径的暂存/意图添加状态，再按原逻辑 checkout + clean。`.ai-review` 全程排除，AI 刚生成、尚待提交的 review.md/patch 不会被回滚破坏（原注释的意图保持不变）。
- SVN：对状态为 `A` 的路径，`svn revert -R` 之后删除对应文件/目录（递归），使其真正回到基线；`?` 与已版本化路径的处理保持原样。
- 新增 `tests/vcs.test.mjs` 4 个回归用例：Git 暂存改动、Git `add -N` 新文件、保留 `.ai-review`、SVN scheduled add（未安装 svn/svnadmin 时自动 skip）。

选择该方案而不是在 `approval.ts` 增加更强的清理：`revertBusinessWorkspace` 是唯一的“还原业务工作区”契约实现，审批、AI 修复、审查复核三处都依赖它；在实现内部修正根因可以同时覆盖所有调用点，也不会引入“审批层再兜底一次”的重复逻辑。

# 需人工判断项
- **业务逻辑与产品取舍**：无业务语义变化；本补丁把“还原”明确为“丢弃业务工作区全部未提交改动（含索引）并保留 `.ai-review`”。需要确认：回滚时是否也应清理 `.ai-review` 的**索引状态**（本补丁仍排除 `.ai-review`，因为批准失败时刚写入的 review.md/patch 需要保留给人工/AI 复核）。
- **架构、兼容性与性能影响**：每次还原多一次 `git reset`（纯索引操作，无工作区 I/O 放大）；SVN 分支对 `A` 状态多做一次递归删除。`git reset -- <pathspec>` 要求仓库已有 HEAD，而批准/审查流程本身要求存在基线提交，因此无新增前置条件。
- **无法由自动化测试验证的边界条件**：pre-commit hook 拒绝提交、gpg 签名失败等真实提交失败链路未构造（测试直接构造 staged/index 状态）；SVN 用例在无 svn/svnadmin 的环境会自动跳过，需在评审环境确认实际执行；Windows 之外平台未实机运行。

# 验证证据
- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · git 2.28.0.windows.1 · svn（TortoiseSVN，按 `svn --version` 可用）· TypeScript 5.9.3
- **执行结果摘要**：
  - `npm run typecheck`：exit 0（host + client 双 program）。
  - `npm test`：exit 0，33 项通过（原有 29 项 + 新增 `tests/vcs.test.mjs` 4 项），耗时约 12s；SVN 用例在本机实际执行而非 skip。
  - 旧实现探针：commit 失败后旧还原仍为 `M  src/x.txt` 且内容未恢复；`git add -N` 后旧还原仍为 ` A new.txt` 且文件存在；`svn revert` 后新文件状态由 `A` 变 `?` 且文件存在。
  - 新实现：4 个用例全部通过（工作区 `git status` 为空、intent-to-add 文件被删除、`.ai-review` 内容保留、SVN `status` 为空且新增文件删除）。
  - 导出后 `git apply --check .ai-review/2026-10/20261031-vcs-revert-workspace/001.patch`（干净基线上）：exit 0。
- **未覆盖风险**：见“无法由自动化测试验证的边界条件”。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
在 `GitAdapter.revertBusinessWorkspace` 增加 `git reset` 清索引（排除 `.ai-review`），在 `SvnAdapter.revertBusinessWorkspace` 对 `A` 状态路径在 revert 后删除；新增 `tests/vcs.test.mjs` 覆盖 Git 暂存、intent-to-add、`.ai-review` 保留与 SVN scheduled add。修改文件：`src/host/vcs.ts`、`tests/vcs.test.mjs`。
### 验证结果
`npm run typecheck` 通过；`npm test` 33/33 通过（含 4 个新用例，SVN 用例在本机实跑）；旧实现的三种残留均用探针复现；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无
