---
schema_version: 1
title: "patch: 修复 unified diff 解析，避免重命名漏提交、引号路径错乱与 hunk 回退空白"
module: patch
audit_type: bugfix
created_at: "2026-10-31T23:16:00+08:00"
owner: "cxs"
tags: [git, svn, diff, patch, approval, bug]
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
  1. **重命名候选漏提交删除**：候选补丁由 `git diff <base> --binary` 生成（git 默认开启 rename detection），纯重命名会输出 `diff --git a/src/a.ts b/src/b.ts` + `rename from/to`。`parsePatch` 只把 b 侧写入 `paths`，而 `ApprovalOrchestrator.approve` 正是用 `parsePatch(patch.text).paths` 作为待提交业务路径；于是 `git add -A -- src/b.ts` 只暂存新文件，`src/a.ts` 的删除不进入提交。批准仍返回 `COMMITTED`，但工作区残留 `D src/a.ts`，仓库里新旧文件同时存在（提交中只有 `A src/b.ts`）。实测按旧 `paths` 暂存后 `git show --name-status` 只有 `A src/b.ts`，`git status` 仍为 `D src/a.ts`。
  2. **非 ASCII 文件名的引号路径**：`core.quotepath` 默认 `true` 时 git 输出 `diff --git "a/\344\270\255\346\226\207..." "b/..."`、`+++ "b/..."`。旧解析不识别引号形式的 `diff --git` 头，且先剥 `a/`/`b/` 再解引号、不解码八进制字节，得到 `b/344270255346226207.txt` 之类的伪路径（探针显示 files=2、paths 为两条伪路径）。批准时 `businessPaths` 全是伪路径，`git add` 因 pathspec 不匹配失败，候选永远无法批准；若是引号路径的二进制文件，旧解析连一条路径都得不到（探针显示 `paths=[]`），此时审批提交只包含 `review.md` 与补丁删除，业务改动被静默留在工作区。
  3. **hunk 内容被当成文件头**：删除 SQL/Lua/Haskell 注释（`-- foo`）产生的 diff 行是 `--- foo`，新增以 `++ ` 开头的行产生的 diff 行是 `+++ ...`；旧解析在 hunk 内也把这些行当文件头。表现为行数统计错误、`paths` 出现伪文件（如 `foo`），批准时 `git add` 因伪路径失败。二进制补丁的 base85 载荷行以 `+`/`-` 开头时也会被错误计为增删行。
  4. **hunk 回退视图空白**：SVN 候选版本 ≥2 时 `/diff?from=1&to=2` 走 `SvnAdapter.computeInterRevisionDiff`，只能返回 `buildHunkFallbackDiff`（Git 跨基线冲突也走它）。`extractFileSection` 只识别 `diff --git` 头，而 `svn diff` 使用 `Index:` 分段，导致每个文件都输出“(该版本未修改此文件)”。实测：用两个 SVN 风格补丁调用 `buildHunkFallbackDiff`，报告里 `a.txt` 的旧/新两段都是空占位，看不到任何 hunk。Git 引号路径同理（`diff --git "a/..."` 不匹配），跨基线回退时该文件内容为空。
- **不修复的影响**：涉及文件重命名的候选会以“已批准”状态漏提交删除，形成半提交并在工作区留下脏状态；涉及非 ASCII 路径的候选无法批准或静默漏提交业务文件；队列变更统计与批准路径集合被污染；SVN（以及 Git 跨基线冲突回退）的增量审核视图完全看不到改动。`parsePatch`/`extractFileSection` 是所有候选包（Git/SVN）的公共解析入口。

# 根因
`src/host/patch.ts` 的差异解析假设“diff 只可能是未加引号的 git 格式、头部只出现在 hunk 外、分段只可能是 `diff --git`”：
- `diffHeader` 正则 `^diff --git a\/(.+?) b\/(.+)$` 不匹配 `diff --git "a/..." "b/..."`，且只保留 b 侧路径；
- `unquoteGitPath` 只做 `\\(.)` 去反斜杠，未按 git 的 C 风格/八进制 UTF-8 转义解码，且 `headerPath` 在解引号之前就剥 `a/`/`b/`；
- 没有 hunk 状态与二进制载荷状态，`--- ` / `+++ ` 行在任何位置都会被当成文件头；
- 返回的 `paths` 只来自 stats 条目，重命名旧侧（被删除的路径）完全丢失；
- `extractFileSection` 只按 `diff --git` 切段，不识别 SVN 的 `Index:` 分段，也不支持引号路径。

# 当前修复方案
在 `src/host/patch.ts` 内收敛为一套头部解析：
1. `unquoteGitPath` 按 git 规则解码引号路径：`\ooo` 按字节收集后用 UTF-8 解码（`Buffer.from(bytes).toString('utf8')`），并支持 `\t`/`\"`/`\\` 等 C 转义；`headerPath` 改为“先去 tab 后缀 → 解引号 → 再剥 `a/`/`b/`”。
2. 新增 `diffHeaderPaths`：分别处理两侧都被引号包裹、仅一侧被引号包裹、以及不加引号的 `diff --git` 头；不加引号时先用“两侧同路径”的长度对称切分（可正确处理含空格路径），失败再退回首个 ` b/` 边界。
3. `parsePatch` 增加 `inHunk` 与 `inBinaryPayload` 状态：`@@` 之后只按 `+`/`-` 计数，`GIT binary patch` 之后跳过 base85 载荷；文件头只在 hunk 外识别。
4. `paths` 改为“补丁触及的全部路径”集合（重命名/删除同时记录 a、b 两侧），`stats.entries` 仍按 b 侧（结果文件）聚合，因此队列统计与目录筛选语义不变；`buildHunkFallbackDiff` 改用 `stats.entries` 枚举文件，保持原有 hunk 回退输出不变。
5. `extractFileSection` 复用 `diffHeaderPaths` 识别 git（含引号）头，并新增 SVN `Index:` 分段识别；hunk 回退报告因此能真正渲染 SVN 与引号路径的差异。
6. `tests/patch.test.mjs` 新增 10 个回归用例：引号 CJK 路径、引号二进制路径 + 载荷行、重命名两侧、hunk 内 `--- `/`+++ `、SVN 风格 unified diff、`/dev/null` 新建/删除、SVN hunk 回退分段、引号路径 hunk 回退、未触及文件的占位符。

选择该方案而不是在审批层打补丁：审批、复核、队列、增量 diff 四处都消费这套解析，在解析层修正根因可以同时消除漏提交、无法批准、统计错误与回退视图空白；在 `approval.ts` 里额外 `git add -A` 全量暂存会引入把用户其它改动一并提交的新风险。

# 需人工判断项
- **业务逻辑与产品取舍**：`ParsedPatch.paths` 的语义从“结果文件列表”扩展为“补丁触及的全部路径（含重命名旧侧）”。当前 `src/client/client.ts` 未消费 `/candidate` 返回的 `patchPaths`，队列统计走 `stats.entries`，因此现有行为不变；若后续 UI 把 `paths` 当作“变更文件列表”，需按 `stats.entries` 过滤。请确认该语义扩展可接受。
- **架构、兼容性与性能影响**：解析器现在兼容 git 默认的 `core.quotepath=true` 引号输出、`core.quotepath=false` 输出与 SVN 的 `Index:`/`---`/`+++` 形式；不改动补丁应用的调用方式。审批提交会新增重命名旧侧的删除路径，行为变化仅限“把旧实现漏掉的删除纳入提交”。裸 `diff --git` 头中含空格路径依赖“两侧同路径”的长度切分；两侧路径都包含 ` b/` 的重命名仍存在理论歧义。
- **无法由自动化测试验证的边界条件**：测试覆盖到 `parsePatch`/`buildHunkFallbackDiff` 与真实 `git apply`/`git add -- paths`/`git commit` 命令层；未在完整 `ApprovalOrchestrator` 流程中用真实的 rename 候选夹具跑通（缺少对应的候选夹具），也未跑 `SvnAdapter.computeInterRevisionDiff` 的端到端 UI 路径（单测直接覆盖 `buildHunkFallbackDiff`），建议人工重点阅读 `approval.ts` 的 `businessPaths` 消费点与 SVN 增量 diff 展示。

# 验证证据
- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · git 2.28.0.windows.1 · svn（TortoiseSVN）· TypeScript 5.9.3
- **执行结果摘要**：
  - `npm run typecheck`：exit 0（host + client 双 program）。
  - `npm test`：exit 0，39 项通过（原有 29 项 + 新增 `tests/patch.test.mjs` 10 项），耗时约 12s。
  - 旧实现探针：引号 CJK 路径得到 2 条伪路径（files=2）；SQL 注释删除行未被计入 deletions；引号二进制路径 `paths=[]`；SVN hunk 回退对每个文件输出“(该版本未修改此文件)”。
  - 新实现探针：重命名头返回 `["src/a.ts","src/b.ts"]`；按新 `paths` 执行 `git apply --binary` + `git add -A -- <paths>` + commit，`git show --name-status` 为 `M line.txt / A new name.sql / D old name.sql`，提交后 `git status --porcelain` 为空。
  - 导出后 `git apply --check .ai-review/2026-10/20261031-patch-diff-header/001.patch`（干净基线上）：exit 0。
- **未覆盖风险**：见“无法由自动化测试验证的边界条件”；Windows 之外的平台未实机运行。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
重写 `src/host/patch.ts` 的路径解码与头部状态机：引号路径按字节解码为 UTF-8、`diff --git` 同时记录两侧路径、hunk/二进制载荷内不再识别文件头；`paths` 变为“触及路径全集”，`stats.entries` 仍按结果文件聚合；`extractFileSection` 支持 SVN `Index:` 分段与引号路径。新增 `tests/patch.test.mjs` 回归用例。修改文件：`src/host/patch.ts`、`tests/patch.test.mjs`。
### 验证结果
`npm run typecheck` 通过；`npm test` 39/39 通过；旧实现的四类缺陷（重命名漏删除、引号路径、hunk 误判、SVN 回退空白）均已用探针复现，修复后用单测 + 真实 git 命令链验证；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无
