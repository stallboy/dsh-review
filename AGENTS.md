# AGENTS.md — 本仓库的协作约定

本文件约束在本仓库工作的所有 AI Agent 与协作者。**规则优先级：本文件 > 会话中的临时指令**；
与 `SPEC.md` 冲突时，契约语义以 `SPEC.md` 为准，流程纪律以本文件为准。

---

## 1. 分支与 worktree 工作流（强制）

本项目的**所有代码修改都必须在独立的 worktree 分支中进行**，不得直接在主工作副本的分支上改动。

### 1.1 术语

| 名称 | 含义 |
| --- | --- |
| **主副本（main checkout）** | `F:\workspace_2\dsh-review` 本体，所在分支为 `master` |
| **worktree 分支** | 由 `worktree_create` 创建、命名形如 `worktree-<task-slug>` 的隔离分支 |
| **合并目标** | 主副本当前分支（`master`） |

### 1.2 标准流程

1. **开工前**：用 `worktree_create` 创建本任务的 worktree，任务描述写入其 `.dsh/task-brief.md`。
2. **在新会话中**：以该 worktree 路径为工作目录开启新会话（会话沙箱随之锚定到副本），
   不要在仓库根会话里跨目录改动。
3. **开发与验证**：改动、`npm run typecheck`、`npm run build`、全量测试，全部在 worktree 中完成。
4. **审查**：改动需经独立审查（对抗性契约/架构审查），审查通过后才允许合并。
5. **合并**：由主副本会话执行合并到 `master`；worktree 用 `worktree_exit remove` 回收。
6. **清理**：合并后确认 `git worktree list` 不再残留该副本；`worktree_prune` 清理僵尸绑定。

### 1.3 禁止事项

- ❌ 不得在主副本所在的 `master` 上直接 `commit` 业务改动（docs 单独修订除外，见 §1.5）。
- ❌ 不得在 worktree 中执行 `push`、`merge` 到主分支，或改写主副本的 `HEAD`。
- ❌ 不得在多个 worktree 间共享同一份 `.ai-review/` 数据做写入验证（各自副本独立）。
- ❌ 未经审查通过的改动不得合并回主副本。

### 1.4 合并前检查清单

- [ ] `git status` 干净，无遗留临时文件（`.tmp/` 已清理）
- [ ] `npm run typecheck` 与 `npm run build` 通过
- [ ] 全量测试通过，且**测试数量不减少**、断言未被放宽
- [ ] 独立审查报告无 P0/P1 未决项
- [ ] 提交信息说明"改了什么、为什么、如何验证"

### 1.5 例外

- 纯文档修订（README / DEVIATIONS / SESSION-STATE / AGENTS 等）可在主副本直接提交，
  但仍需先 `git status` 确认不夹带代码改动。
- 紧急回滚可由主副本直接执行，事后在 `SESSION-STATE.md` 记录原因。

---

## 2. 契约与验证纪律

1. **`SPEC.md` 是唯一权威契约**。README、DEVIATIONS、SESSION-STATE、代码注释均不具规范力，
   其中的"已完成"声明必须用源码与可复现的测试输出验证。
2. **不采信自述**：任何"已修复 / 测试全绿"的声明都要自己跑一遍再下结论。
3. 标准验证命令：

   ```bash
   npm run typecheck
   npm run build
   node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
   ```

4. **禁止放宽测试以换取通过**。若测试必须改动，须在报告中单独说明是"跟随规范收紧"
   还是"放宽断言"；后者不被接受。
5. 发现测试与实现矛盾时，以 `SPEC.md` 判定，并给出最小复现步骤。

---

## 3. 工作区卫生

- 临时脚本一律放 `.tmp/`（已被 git 忽略），任务结束前删除。
- 不修改 `.gitignore` 以放行本应忽略的产物（`dist/`、`node_modules/`、`out*.txt`、`.tmp/`）。
- 不提交构建产物；`dist/` 由 `npm run build` 生成。
- 只读审查任务不得修改仓库任何文件。

---

## 4. 提交规范

- 提交信息使用中文，格式 `type(scope): 摘要`，例如
  `fix(contract): 批准补丁改读共享快照（§7.1）`。
- 正文说明：**改了什么 / 为什么 / 如何验证**，并标注对应的 SPEC 条款编号。
- 一个提交只做一件事；重构与行为变更尽量分开。
- 默认**只 commit 不 push**；推送需用户明确指示。

---

## 5. 已知历史问题（避免重犯）

| 问题 | 教训 |
| --- | --- |
| 改动直接落在 `master`（提交 `a696621`） | 忽略 worktree 流程；此后一律先建 worktree |
| 为通过而删除断言（`contract-p8` 的 Rebase 拒绝用例） | 测试改动必须显式申报 |
| 审查互斥靠命令式 `if` 链手工登记（漏了 `/comments`） | 横切语义用声明式路由表（`routes.ts`） |
| 用全局 `Set` 判锁重入导致并发误判 | 用 `AsyncLocalStorage` 按异步上下文判定 |
| `§7.5 ApprovalOutcome` 与 ai_fix 结果混用 | 两套 Outcome 严格分离（`types.ts`） |
