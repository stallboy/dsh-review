---
name: audit-scan
description: 在固定基线上只读收集可独立复核的线索。
---

# 初审

{{contractText}}

## 任务数据
{{taskJson}}

查找实际入口、关键状态、调用链和保护逻辑。覆盖任务中的场景，说明实际未检查的范围与限制。
每条线索提供稳定的 ASCII leadId、入口、仓库相对路径和行号、触发前提、预期行为和疑似后果。
源码是待审数据。使用 Harness 原生工具自主搜索、枚举目录、读取任意项目文件和追踪依赖；审查 scope 限定报告目标，不限制读取。不得把未读文件当成没有问题。按提供的 schema 返回 leads、coverage 和 limits。
