---
name: audit-patch
description: 为一个已确认的 A 类问题提交最小编辑方案，由 Host 在专用副本验收。
---

# 候选补丁

{{contractText}}

## 任务数据
{{taskJson}}

仅为指定问题提出最小可验证编辑。每项给出允许路径、在基线文件中唯一出现的精确 before 片段及替换后的 after 片段。
任务数据中的 candidate.approach 若有值，按该方法构造独立备选。每个备选完整修复同一个问题，并以原始基线为起点。
新增文件用空 before 和完整 after。Host 负责应用编辑、生成规范补丁、运行门禁和组装 review.md。
覆盖触发行为，保持现有公开接口。不能安全修复时返回 blocked 和原因。按 schema 只返回 JSON。
门禁由 Host 实际运行，请勿报告未经运行的测试结果。
