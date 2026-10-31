---
schema_version: 1
title: 'patch: 修复 unified diff 解析，避免重命名漏提交、引号路径错乱与 hunk 回退空白'
created_at: '2026-10-31T23:16:00+08:00'
owner: cxs
tags:
  - git
  - svn
  - diff
  - patch
  - approval
  - bug
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
  approved_at: '2026-10-31T17:11:33.231Z'
  commit_revision: f458a3484ea080d268310bc9397f6aa2f3c74402
module: patch
audit_type: bugfix
---

# 问题与影响

- **重命名候选漏提交删除**：`git diff` 默认开启 rename detection，旧解析只记录 b 侧路径；批准时 `git add -- src/b.ts` 不会暂存 `src/a.ts` 的删除，提交后工作区残留 `D src/a.ts`。
- **引号路径无法批准**：`core.quotepath=true` 时 git 输出 `"a/\344..."` 形式；旧解析不识别引号头，也不按八进制解码，得到伪路径。二进制引号路径甚至得到 `paths=[]`，业务改动被静默留在工作区。
- **hunk 内文件头误判**：删除 SQL/Lua 注释产生的 `--- foo`、新增 `+++ ...` 行会被当成文件头，导致行数统计错误、`paths` 出现伪文件；二进制 base85 载荷也会被误计。
- **SVN 增量回退空白**：`extractFileSection` 只识别 `diff --git`，不识别 `svn diff` 的 `Index:` 分段；跨版本回退时每个文件都显示“（该版本未修改此文件）”。
- **影响面**：上述解析是所有候选（Git/SVN）的公共入口，错误会同时污染队列统计、批准提交和增量审核视图。

# 根因

- `patch.ts` 的 `diffHeader` 只匹配未加引号的 `a/... b/...`，且只保留 b 侧路径。
- `unquoteGitPath` 只去掉反斜杠，未按 git 的 C 风格/八进制 UTF-8 转义解码；`headerPath` 在解引号之前就剥 `a/`/`b/`。
- 解析器没有 hunk 与二进制载荷状态，`---` / `+++` 行在任意位置都被当成文件头。
- `paths` 只从结果文件统计得出，重命名旧侧完全丢失；`extractFileSection` 不识别 SVN `Index:`。
- 这些假设共同成立时，批准链路的“待提交路径集合”与真实 diff 不一致。

# 当前修复方案

- **路径解码**：`unquoteGitPath` 按 git 规则解码引号路径：`\ooo` 按字节收集后统一 UTF-8 解码，并支持 `\t`/`\"`/`\\` 等 C 转义。
- **头部解析**：新增 `diffHeaderPaths`，处理两侧都加引号、仅一侧加引号、以及未加引号的 `diff --git` 头；同路径含空格时先用长度对称切分。
- **状态机**：`parsePatch` 增加 `inHunk` / `inBinaryPayload` 状态；`@@` 之后只按 `+`/`-` 计数，`GIT binary patch` 之后跳过 base85 载荷。
- **路径语义**：`paths` 改为“补丁触及的全部路径”，重命名同时记录 a/b 两侧；`stats.entries` 仍按结果文件聚合，队列统计语义不变。
- **回退视图**：`extractFileSection` 复用新的头部解析，并新增 SVN `Index:` 分段识别。
- **测试**：新增 `tests/patch.test.mjs` 的 10 个回归用例，覆盖引号 CJK 路径、引号二进制、重命名、hunk 内伪头、SVN 分段与 `/dev/null`。
- **为什么不在审批层兜底**：审批、复核、队列、增量 diff 四处都消费该解析；在解析层修根因可同时消除漏提交与误判，避免 `git add -A` 把用户其他改动一并提交。

# 需人工判断项

- **`paths` 语义扩展**：从“结果文件列表”变为“补丁触及的全部路径（含重命名旧侧）”。当前客户端未消费 `patchPaths`，队列统计走 `stats.entries`；若后续 UI 把 `paths` 当变更文件列表，需要按 `stats.entries` 过滤。请确认该语义可接受。
- **兼容性与理论歧义**：兼容 `core.quotepath` 开关与 SVN 格式；未改补丁应用调用方式。裸 `diff --git` 头中两侧路径都含 ` b/` 的重命名仍存在理论歧义，需要人工评估。
- **未端到端覆盖**：未用真实 rename 候选夹具跑完整 `ApprovalOrchestrator`，也未跑 `SvnAdapter.computeInterRevisionDiff` 的 UI 路径；建议重点阅读 `approval.ts` 的 `businessPaths` 消费点。

# 验证证据

- **验证基线**：`402012744bcdd89fba50bb60cbf6fed84785ad67`
- **执行环境**：Windows 10 · Node.js v24.1.0 · git 2.28.0 · svn（TortoiseSVN）· TypeScript 5.9.3
- **门禁结果**：`npm run typecheck` exit 0；`npm test` exit 0，39/39（原 29 + 新增 `tests/patch.test.mjs` 10 项），约 12s。
- **旧实现探针**：引号 CJK 路径得到 2 条伪路径；SQL 注释删除行未计入 deletions；引号二进制 `paths=[]`；SVN hunk 回退为空占位。
- **新实现探针**：重命名头返回 `["src/a.ts","src/b.ts"]`；按新 `paths` 执行 `git apply` + `git add` + commit，`git show --name-status` 为 `M line.txt / A new name.sql / D old name.sql`，提交后 `git status` 干净。
- **补丁校验**：`git apply --check .ai-review/2026-10/20261031-patch-diff-header/001.patch` exit 0。
- **未覆盖风险**：Windows 之外平台未实机运行；见“未端到端覆盖”。

# 审核记录

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)
### 方案说明
重写 `src/host/patch.ts` 的路径解码与头部状态机：引号路径按字节解码为 UTF-8，`diff --git` 同时记录两侧路径，hunk/二进制载荷内不再识别文件头；`paths` 变为“触及路径全集”，`stats.entries` 仍按结果文件聚合；`extractFileSection` 支持 SVN `Index:` 分段与引号路径。新增 `tests/patch.test.mjs` 回归用例。
### 验证结果
`npm run typecheck` 通过；`npm test` 39/39 通过；四类旧缺陷均用探针复现并在修复后验证；`001.patch` 在干净基线上 `git apply --check` 通过。
### 人类总体意见
待审核
### 意见处理结果
无

## 版本 1 (base: 402012744bcdd89fba50bb60cbf6fed84785ad67)

### 验证结果

<!-- ai-review:validation -->
### 门禁执行结果

- 工作目录: D:\work\mygithub\dsh-review · 基线: 316b0a207b2702df909dcba8de6363283e911562 · 平台: win32 / node v24.21.0 · 执行时间: 2026-10-31T17:11:33.230Z

| 结果 | 命令 | 退出码 | 耗时 |
| --- | --- | --- | --- |
| 通过 | `npm run typecheck` | 0 | 2.2s |
| 通过 | `npm test` | 0 | 9.6s |
<!-- /ai-review:validation -->

### 人类总体意见

批准（cxs）
