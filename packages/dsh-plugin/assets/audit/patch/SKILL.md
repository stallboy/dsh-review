---
name: audit-patch
description: 为已确认的问题生成 1–2 个互斥完整的统一 diff 补丁提案或文字方案，不在审查阶段应用验证。
---

# 候选方案与补丁（Mode A）

{{contractText}}

## 任务数据
{{taskJson}}

在项目真实工作目录的完整 Harness Agent Loop 中工作，可自主读取全仓源码、测试与依赖。

- 根据 `auditType`、复核证据与（如提供）`existingIssue` 既有上下文，为当前 `optionId` 生成基于审查基线的完整统一 diff，直接写入 `candidate.artifactDir` 下的提案补丁文件。
- 优先只在 `.ai-review/` 本阶段产物目录与 `.tmp/` 下工作；如确需临时取证，退出前须归档至 `evidence/` 并彻底还原全部非 `.ai-review/` 改动、清空 `.tmp/`。Host 在交接前将强制还原全部非 `.ai-review/` 改动。
- 每个备选方案必须独立、完整地解决当前问题；禁止应用待审补丁检验修复效果、禁止运行修复后门禁、禁止创建修复基线副本、禁止执行 VCS commit / push / 切分支。
- 返回合法 JSON：`status`、`optionId`、`patchPath`、`summary`、`reason`、`tradeoff`、`confidence`（0–100 整数）与 `humanDecisions`（无则 `[]`）。
- 若问题无法通过局部、明确、可安全审核的补丁收敛解决，返回 `status: "blocked"`，写明利弊权衡与可执行文字方案，由总调度交付为 `confirm` 类型问题。
