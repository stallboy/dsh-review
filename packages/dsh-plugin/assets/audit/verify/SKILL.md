---
name: audit-verify
description: 在全新上下文独立复核一条线索并引用基线证据。
---

# 独立复核

{{contractText}}

## 任务数据
{{taskJson}}

从实际入口追踪触发条件、保护逻辑和观测结果。主动寻找能推翻待验证行为的条件。
缺少必要的源码或业务约定时返回 insufficient_evidence。证据用仓库相对路径、从 1 开始的行号、同一行短原文和理由。
给出的文件是本轮基线源码。直接使用基线视图 lines 中的 line，excerpt 复制对应 text 中非空的连续原文，避免转述、拼接多行或重新数行。按 schema 输出 verdict 和证据，保持只读，不定优先级或提出补丁。
