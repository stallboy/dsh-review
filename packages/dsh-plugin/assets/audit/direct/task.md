# 任务
请你作为本轮仓库审查的执行者，先按审查准则扫描目标范围，再把「A 类：无疑问的本质缺陷 / 低风险明显精简重构」直接转化为 `.ai-review` 候选修复包；B 类只写入审查报告，不修改代码。
<!-- delivery --><!-- history -->

## 环境与范围
- 仓库根目录（同时是工作目录）：{{repoRoot}}
- VCS 类型：{{vcsType}}
- 当前基线 base_revision：{{baseRevision}}
- 审查目标：{{scope}}
- 候选目录月份：.ai-review/{{month}}/
- 本轮审查报告文件（相对仓库根目录）：{{reportPath}}
- reviewers.yml：.ai-review/reviewers.yml
- 当前时间：{{now}}
- 当前操作者 owner：{{owner}}

## reviewers.yml 当前内容
```yaml
{{reviewersText}}
```
owner 解析顺序：按 rules 的 paths/tags 匹配 → default_owner → {{ownerFallback}}。

## 已存在的候选（不要重复生成同一问题）
{{existing}}

## 负向记忆：近期被拒绝的方案（禁止重复；标题/文件/原因见下）
{{negativeMemory}}

## 仓库结构摘要（仅用于建立地图，完整内容请自行读取）
```text
{{outline}}
```

## 用户关注点（可选）
{{note}}

<!-- session -->## 硬性执行规则
1. 所有候选必须**完全独立地基于当前基线**，严禁生成需要按顺序打补丁的依赖链。每导出一个候选的 `001.patch` 后，必须立即把业务工作区还原到基线，再处理下一个问题。
2. 候选目录名为 `YYYYMMDD-<module>-<short-slug>`，放在 `.ai-review/{{month}}/` 下；`<module>` 与 `<short-slug>` 只能使用 ASCII 字母、数字、`.`、`_`、`-`（禁止中文、空格、斜杠），中文语义写入 review.md 的 title。同一函数/结构体内强耦合的清理可合并进同一个本质修复。
3. A 类必须：真正修改代码 → 实际运行 `gate_checks` 中的全部命令 → 导出 UTF-8/LF 全量 unified diff 到 `001.patch`（不得包含 `.ai-review/` 自身）→ 生成 review.md → 还原业务工作区。验证无法收敛时回滚，并降级为 B 类。
4. 问题本身证据不足时仅记入覆盖说明。B 类只记录已确认但无法安全修复、无法验证修复或需要人工取舍的问题，不创建候选目录。若改动 B 强依赖某个大改动 A 先合入主干，把 B 写入“待前置合入后处理（Deferred）”。
5. 严禁执行 `git commit` / `svn commit` / `git push` / `svn add`。审查产物由插件在收尾统一提交；结束前 `git status` / `svn status` 除 `.ai-review/` 外必须干净，不得在业务工作区留下未导出的改动或临时文件。
6. 审查报告必须最后写入上述报告文件（只写 Markdown 正文，**不要写 YAML Frontmatter**——插件收尾时会统一补全档案头）。结构见下节。优先级总览须覆盖本轮所有已确认发现，每项标注 P0–P3，跨 A/B/Deferred 按 P0 → P1 → P2 → P3 排序。没有已确认发现时，总览写 `- 无`。请严格使用本轮指定的标题、列表与附加数据格式。
7. 如果没有 A 类问题，报告 A 类写“无”，不要为了凑数生成候选；如果所有候选都验证失败，也不要留下半成品目录。
8. review.md 的 `gate_checks` 每条都必须实际运行并通过；`# 需人工判断项` 只写真正需要人类拍板的点，没有就只写一行 `- 无`，不要为“业务逻辑 / 架构 / 性能 / 边界”逐个凑“无”。
9. 正文必须便于人快速扫读：每个章节先用 1 句结论，再列 2–5 条短要点；每条不超过 2 句或 120 字；禁止连续超过 3 行的长段落。优先使用列表和 `###` 小标题，命令与日志只放 `# 验证证据`。
10. 补丁生成方式：Git 使用 `git diff <base_revision> --binary`（新增业务文件先 `git add -N <文件>`，绝不能把 `.ai-review/` 加入索引）；SVN 在工作区为对应 revision 时使用 `svn diff`。
<!-- completion -->

## review.md 完整必填字段（不得缺省；空数组写 []，无值对象写 null）
```markdown
---
schema_version: {{schemaVersion}}{{findingIdField}}
title: "<小写模块标志>: <中文标题>"
module: <小写模块标志>
audit_type: bugfix # bugfix | delete | shrink | reuse | merge | split | stdlib | native | yagni
created_at: "<含时区的 ISO-8601>"
updated_at: "<含时区的 ISO-8601；共享写入严格递增>"
owner: "<按 reviewers.yml 解析后的负责人>"
tags: []
status: pending
ticket: null
target_files: [src/example.ts] # 必须与当前补丁路径一致
current_revision: 1
revisions:
  - id: 1
    base_revision: "{{baseRevision}}"
    patch: "001.patch"
    author: ai
gate_checks:
  - "<实际执行且通过的命令>"
comments: []
human_decisions: [] # 每项含 id/question，可选 note
approval: null
rejection: null
commit_message: |
  <与 title 完全一致的首行>

  <问题、修复与实际验证摘要>
---
```
保留所有未知顶层及嵌套键；不得为严格校验丢弃它们。
正文按审查准则的章节结构生成：`# 问题与影响`、`# 根因`、`# 当前修复方案`、`# 需人工判断项`、`# 验证证据`、`# 审核记录`。

## 审查报告模板
```markdown
# 仓库审查报告
- 基线：{{baseRevision}}
- 范围：{{reportScope}}
- 执行时间：<ISO-8601>

## 优先级总览
| 优先级 | 问题 | 处置 |
| --- | --- | --- |
| <P0–P3> | <已确认的发现与具体影响> | <A、B 或 Deferred；A 类注明候选编号> |

## A 类：已生成候选
- `.ai-review/<YYYY-MM>/<候选目录>/`：<title>（<audit_type>）

## B 类：需人工确认（未改代码）
- **<标题>**：<为什么需要人工确认 / 影响面 / 建议>

## 待前置合入后处理（Deferred）
- **<标题>**：<依赖哪个候选或前置条件>

## 验证与说明
- 实际执行的命令与结果摘要；未覆盖风险；证据不足的线索及缺失的证据。
```
