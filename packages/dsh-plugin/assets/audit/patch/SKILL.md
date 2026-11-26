---
name: audit-patch
description: 为一个已确认的 A 类问题提交最小编辑方案，由 Host 在专用副本验收。
---

# 候选补丁

{{contractText}}

## 任务数据
{{taskJson}}

按 auditType 为已确认的问题生成完整统一 diff，直接写入 candidate.artifactDir 下的提案文件。必要时自主读取任意项目上下文。
每个备选完整解决同一问题，基于当前真实工作目录的审查基线；禁止应用补丁、编辑业务源码或创建基线副本。
返回 status、patchPath、summary、reason、tradeoff、confidence 和 humanDecisions。confidence 为 0–100 的整数；tradeoff 说明主要收益和局限；humanDecisions 列出需人类明确判断的事项。
无法提供局部、明确、可审核补丁时返回 blocked，并说明方案利弊和建议，交付文字方案。
补丁审查只做格式、路径、基线和只读应用预检。不得运行修复后门禁或声称修复效果已经通过验证。
