# DSH Review 工作流程与数据契约设计

| 项 | 内容 |
| --- | --- |
| 状态 | 已按 2026-11-04 评审结论修订并规范化，§18 待决事项已全部落定，可进入实现 |
| 日期 | 2026-11-03（2026-11-04 按评审结论修订） |
| 适用范围 | 手动审查、定时审查、B/Deferred 转换、候选审核、批准、拒绝与归档 |
| 关联文档 | `dsh_web.md`（原始设计）、`README.md`（当前实现）、`SPEC.md`（当前权威契约） |

> **2026-11-09 契约修订（开发期）**：本文是历史设计记录，契约以 `SPEC.md` 为准。
> - 批准改为单次原子提交；`approval.commit_revision` 字段移除，业务提交由 Host 从 VCS 历史派生（SPEC §5.5）。本文 §4.7、§6.6、§8、§12.3、§13.2 中关于第二次回填提交、`needsBackfill`、`/backfill` 的描述作废。
> - 新增可选 `rejection.category` / `rejection.related_symbols`、`comments[].anchor`、`/comments/batch`、`candidate.patchCheck`、`queue.approvalCommitRevision` 与可选 `verify_gate_on_audit_finalize`；见 SPEC §4.3、§5.5、§6、§7.6、§8.2、§8.3。
> - 负向记忆的确定性指纹仍只使用 module + target_files + audit_type + 规范化 title；分类与符号只用于提示词/展示。
> - 批准门禁在仓库根目录原地执行；worktree 仅作为未来可选能力，不是 v1 默认（SPEC §1.4）。

## 文档结构

| 章节 | 内容 |
| --- | --- |
| 1 | 目标、原则与术语 |
| 2 | 存储结构、编码与标识规范 |
| 3 | `audit.md`：审查事实契约 |
| 4 | `review.md`：候选事实契约 |
| 5 | `reviewers.yml` 契约 |
| 6 | 端到端工作流程 |
| 7 | 负向记忆与重复阻止 |
| 8 | 共享写入与事务边界 |
| 9 | 共享状态与本地状态 |
| 10 | 开发期数据策略 |
| 11 | 明确不引入的内容 |
| 12 | 验收重点 |
| 13 | 不变量与校验矩阵 |
| 14 | 读取口径：共享事实与本地视图 |
| 15 | 演进策略 |
| 16 | 安全边界 |
| 17 | 变更记录 |
| 18 | 已决事项（原待决事项） |

## 1. 目标与原则

本设计闭合的不只是“生成候选 → 批准”的单次路径，还包括：

- 每轮审查做了什么、得到什么结论；
- B 类与 Deferred 如何经人工决策转为候选；
- 定时审查如何复查历史问题是否仍然存在；
- 候选如何经历评论、AI 修复、人工微调、冲突 Rebase、批准或拒绝；
- 拒绝如何成为后续审查的负向约束；
- 每一次共享写入何时才算真正完成。

核心原则：

1. **仓库是唯一共享事实源，不开发独立后端。**
2. **候选与审查项分开存储。** 候选承载修复审核，审查档案承载发现、结论和跨轮追踪。
3. **不引入共享 `index.json`。** 查询、关联和摘要由插件从事实数据计算。
4. **能计算的不持久化，能放进现有文件的不新增文件。**
5. **`schema_version` 保持为 1。** 本次是功能与数据格式扩展，不切换协议版本。
6. **共享提交成功才算共享操作完成。** 本地文件写入成功不等于其他实例已经能够获得该事实。
7. **AI 生产候选，机器复算证据，人类决定业务与方案是否合入。**

### 1.1 与 `dsh_web.md` 的关系

本契约保留 `dsh_web.md` 的核心原则：仓库是唯一共享事实源、不开发独立后端、候选 4 个共享状态、全量正交补丁、批准原子提交、只 commit 不 push、归档清理过程补丁。新增或强化的是：审查档案与 finding 身份、B/Deferred 的跨轮追踪、人工判断项留痕、门禁执行结果结构化、rejection 负向记忆、开发期数据策略。两者冲突时，以本文档为准。

### 1.2 术语

| 术语 | 含义 |
| --- | --- |
| 审查 / audit | 一次针对某个 `scope` 的仓库审查，对应 `audits/<audit_id>/audit.md`。 |
| 审查项 / finding | 审查发现的、跨轮可追踪的问题身份，由 `finding_id` 标识。 |
| 候选 / candidate | 一个可独立审核与合入的修复包，对应 `.ai-review/<YYYY-MM>/<slug>/`。 |
| 版本 / revision | 候选的一个完整方案，含基线、全量补丁和作者。 |
| 门禁 / gate | 批准前必须实际执行且全部通过的命令集合。 |
| Owner | 当前唯一有权操作该候选的人；是本地约定，不是鉴权。 |
| 共享事实 | 已进入仓库提交、其他实例同步后可见的 `.ai-review` 数据。 |
| 本地状态 | 只存在于当前实例内存/缓存中的执行、预检、日志、勾选状态。 |
| 投影 / projection | 从历史审查与候选事实计算出的当前问题状态，不持久化。 |
| 负向记忆 | 从 rejected 候选提取的“不要重复”约束。 |
| A 类 / B 类 / Deferred | 直接生成候选 / 需人工确认 / 等前置合入后处理。 |

## 2. 存储结构

```text
.ai-review/
  reviewers.yml

  audits/
    20261103-020000-repo/
      audit.md
      ...                              # 仅在真实产生附件时增加
    20261104-020000-repo/
      audit.md

  2026-11/
    20261103-net-fix-close-race/
      review.md
      001.patch
      002.patch
```

### 2.1 数据分类

| 类型 | 内容 | 是否共享 | 是否事实源 |
| --- | --- | --- | --- |
| 候选事实 | `review.md`、`NNN.patch` | 是 | 是 |
| 审查事实 | `audits/<audit_id>/audit.md` 及真实附件 | 是 | 是 |
| 全局规则 | `reviewers.yml` | 是 | 是 |
| 派生视图 | 队列摘要、审查项与候选关联、负向记忆摘要、问题指纹 | 否 | 否 |
| 本地瞬态 | 执行中、日志、预检结果、页面勾选状态 | 否 | 否 |

不建立共享索引。插件可以建立内存缓存，但缓存不得改变流程裁决，也不得成为唯一关联记录。

### 2.2 通用编码与标识约定

- 所有文本文件使用 UTF-8 和 LF。
- 时间使用 ISO 8601，必须包含时区偏移。契约示例统一写成加引号的字符串（如 `"2026-11-03T02:00:00+08:00"`）；解析器必须同时接受 YAML 把裸 ISO 解析成的时间对象，不得因未加引号而报错。
- 所有时间比较、过滤和排序一律按解析后的时间点，禁止对 `created_at` 等字符串做字典序比较；解析器把时间对象规范化为 UTC（`Z`）ISO 字符串，字符串输入原样保留。
- `created_at` 表示本轮或本候选开始时间（生成 ID 时确定），一经写入不改变；同一时间点的次序以 `audit_id` 或候选目录名作为次序键。
- 仓库路径使用相对仓库根目录的 `/` 分隔形式，不使用 `./`，不允许绝对路径或 `..`。
- `audit_id` 使用 `YYYYMMDD-HHMMSS-<scope-slug>`，必须与所属目录名完全一致。
- `candidate_id` 使用 `YYYY-MM/YYYYMMDD-<module>-<short-slug>`。
- `finding_id` 使用 `<module>-<short-slug>`，在同一仓库内跨轮稳定；同一问题再次出现时沿用原 ID。
- Frontmatter 中的数组和对象使用标准 YAML，不把结构化数据编码进字符串。

### 2.3 标识、字段与序列化

- 字段名统一 `snake_case`；布尔值用 `true/false`；空数组写 `[]`，无值对象写 `null`；不要用空字符串代替缺失对象或数组。
- 除明确标注可选的字段外，字段必须存在；不要用“省略字段”表达语义。
- 序列化键序固定，未知字段追加在末尾：
  - `review.md`：`schema_version, title, module, audit_type, created_at, updated_at, owner, tags, ticket, status, target_files, current_revision, revisions, gate_checks, comments, human_decisions, approval, rejection, commit_message, reopened_from, reopen_reason`（`reopened_from`/`reopen_reason` 为可选字段，缺省时不写，出现时位于未知字段之前）；
  - `audit.md`：`schema_version, audit_id, created_at, base_revision, scope, trigger, previous_audit, candidates, items`。
- `candidate_id` 就是相对 `.ai-review/` 的目录路径 `<YYYY-MM>/<YYYYMMDD>-<module>-<short-slug>`；`module`、`short-slug` 仅允许 ASCII 字母、数字、`.`、`_`、`-`。创建后不得改名或移动；同日同 module 同 slug 冲突时追加 `-2`、`-3`。
- `finding_id` 为 `<module>-<short-slug>`，全仓库唯一且永久不复用，格式 `^[a-z0-9][a-z0-9-]{0,63}$`；问题迁移模块时沿用原 ID。
- `scope` 只写 `.` 或仓库相对路径：`/` 分隔，不以 `/` 开头或结尾，不含 `./`、`..`、反斜杠。`audit_id` 的 `<scope-slug>` 只用于可读性，唯一性由时间戳保证。
- 文件使用 UTF-8、LF、末尾一个换行；不使用制表符；YAML 不使用锚点或别名。
- 未知顶层与嵌套字段必须原样保留；写端不得只重建已知字段（见 §10、§13）。

## 3. `audit.md`：审查事实契约

每轮审查使用独立目录。当前可以只有 `audit.md`；目录用于容纳未来真实产生的复现脚本、检索证据或性能数据，不预建空文件。

`audit.md` 同时包含：

- YAML Frontmatter：机器读取的审查事实；
- Markdown 正文：人类可读的审查报告。

机器处理以 Frontmatter 为准；正文用于解释、证据摘要和决策记录，不承担唯一的状态解析职责。

### 3.1 完整示例

```markdown
---
schema_version: 1
audit_id: 20261104-020000-src-host
created_at: "2026-11-04T02:00:00+08:00"
base_revision: "116f46fc380cdf8d19eeed20f78c762b1027d503"
scope: src/host
trigger: scheduled
previous_audit: 20261103-020000-src-host
candidates:
  - 2026-11/20261104-api-prevent-double-approval
items:
  - finding_id: api-double-approval
    kind: confirm
    title: "同一候选的并发批准需要确定互斥语义"
    summary: "两个批准任务可能同时修改工作区；数据契约已定为检出级串行化 + 提交后冲突检测（§6.6），代码需实现该互斥"
    target_files:
      - src/host/api.ts
      - src/host/approval.ts
    depends_on: null
    status: pending
    candidate: null
  - finding_id: auth-remove-legacy-adapter
    kind: deferred
    title: "旧 Token 适配层等待协议隔离候选合入"
    summary: "当前改动依赖前置候选，本轮不生成补丁"
    target_files:
      - src/host/auth/legacy.ts
    depends_on: auth-token-protocol-isolation
    status: pending
    candidate: null
  - finding_id: store-missing-human-section
    kind: confirm
    title: "候选缺少人工判断章节"
    summary: "批准路径已补充强校验，当前代码与测试中未再发现该问题"
    target_files:
      - src/host/store.ts
    depends_on: null
    status: resolved
    candidate: null
---

# 仓库审查报告

## 本轮范围与执行

## A 类：已生成候选

## B 类：需人工确认

## 待前置合入后处理（Deferred）

## 历史问题复查

## 验证证据与未覆盖风险

## 审查项处理记录
```

### 3.2 批次级字段

| 字段 | 类型 | 必填 | 功能与流程 |
| --- | --- | --- | --- |
| `schema_version` | `1` | 是 | 固定为 1；当前只有一代格式，见 §10、§15。 |
| `audit_id` | string | 是 | 本轮稳定身份；用于 `previous_audit`、附件归属和人工引用。 |
| `created_at` | ISO time | 是 | 本轮开始时间，一经写入不改变；排序按解析后的时间点，同一时间点以 `audit_id` 为次序键。 |
| `base_revision` | string | 是 | 本轮开始时的仓库基线；本轮直接生成的 A 类候选必须使用同一基线。 |
| `scope` | string | 是 | `.` 表示全仓，否则为仓库内相对路径（规范见 §2.3）。定时任务按相同或包含关系寻找历史审查。 |
| `trigger` | `manual \| scheduled` | 是 | 区分手动与定时触发；不改变后续审核权限和门禁要求。 |
| `previous_audit` | string \| null | 是 | 指向本轮参考的前一次相关审查；首轮为 null。只记录直接前驱，仅作提示，不承担完整性校验。 |
| `candidates` | candidate_id[] | 是 | 本轮直接生成的 A 类候选；无候选时为 `[]`。B 类后续转换不追加到这里，而记录在对应 item 的 `candidate` 中。 |
| `items` | AuditItem[] | 是 | B 类、Deferred 及历史问题复查结论；无条目时为 `[]`。 |

批次级 Frontmatter 不保存补丁规模、运行中状态或日志全文。这些信息分别由补丁、任务系统和正文证据承担。

### 3.3 `AuditItem` 字段

| 字段 | 类型 | 必填 | 功能与流程 |
| --- | --- | --- | --- |
| `finding_id` | string | 是 | 跨轮稳定的问题身份。后续审查通过它说明同一问题仍存在、已解决或已转换。 |
| `kind` | `confirm \| deferred` | 是 | `confirm` 表示需要人工决策；`deferred` 表示存在明确前置依赖。复查旧项时保持原类别。 |
| `title` | string | 是 | 简洁的问题标题，不要求与候选提交标题相同。 |
| `summary` | string | 是 | 当前结论；B 类必须说明需要决定什么，Deferred 必须说明等待什么，resolved 必须说明复核依据。 |
| `target_files` | string[] | 是 | 问题涉及的文件；用于上下文裁剪、复查和关联。真正全仓级问题才允许为空。 |
| `depends_on` | finding_id \| null | 是 | 仅 Deferred 使用，指向另一个稳定问题 ID；无依赖时为 null；满足判定见 §6.2。 |
| `status` | `pending \| converted \| dismissed \| resolved` | 是 | 当前工作项结论，详见状态规则。 |
| `candidate` | candidate_id \| null | 是 | `converted` 时必填且指向真实候选；其他状态必须为 null。候选不保存反向引用。 |

字段刻意保持精简：位置、风险、需要决定的事项如果可以用一条 `summary` 表达，就不再拆成多组重复字段；需要详细说明时写入正文。

### 3.4 审查项状态语义

```text
pending
  ├─ 人工确认并生成候选 → converted（同时填写 candidate）
  ├─ 人工确认无需处理 → dismissed
  └─ 后续审查确认问题已不存在 → resolved

deferred 仍使用 pending 表示等待，不增加 waiting/blocked 状态。
```

- `converted` 只表示“曾经转成候选”，不随候选批准或拒绝反向改写。
- 候选之后的结果由 `review.md` 记录；下一轮审查可用新的同 `finding_id` 条目记录 `resolved`。
- `dismissed` 是审查项决策，不等于候选 `rejected`，不自动进入候选负向记忆。
- 历史 `audit.md` 不因新一轮审查而重写。人工转换旧审查项时，只更新该 item 的 `status/candidate`，并在正文“审查项处理记录”追加记录。
- 查询当前问题时，按 `finding_id` 取最新观察，并结合已转换候选的真实状态，而不是修改所有历史记录。

审查项不强制完整性：本轮未写某个历史 finding，只表示本轮没有提供新观察，不表示问题已消失，也不使 `audit.md` 无效。查询与提示词注入使用以下投影规则：

- **覆盖判定**：finding 的 `target_files` 全部落在某轮 `scope` 内，才算该轮观察过它；
- **最新观察**：取覆盖它的审查中时间点最新的一条；`previous_audit` 仅作参考；
- **当前状态**：以最新观察的 `status` 为准；若为 `converted`，再结合 `candidate` 的当前状态——候选 `approved` 视为闭合，候选 `pending/changes_requested` 视为仍开启，候选 `rejected` 视为重新开启（下一轮应重新评估）；
- **可见性**：队列与详情显示“上次观察：`audit_id` / 时间”，让长期未复查可见，但不自动判定问题消失。

### 3.5 审查附件扩展

- 小型、需要查询的元数据放入 Frontmatter。
- 复现脚本、独立检索结果等较大产物放入本轮目录，并在正文记录相对路径。
- 可以从候选或报告计算的数据不重复保存。
- 新增可选附件不得改变 `audit.md` 路径，也不要求修改旧审查记录。

## 4. `review.md`：候选事实契约

候选文件同时保存机器元数据和完整人类审核历史。活跃候选的每个版本都有独立全量补丁；批准、拒绝或超时废弃后删除过程补丁，保留 `review.md`。

### 4.1 完整示例

```markdown
---
schema_version: 1
title: "net: 修复连接关闭竞态"
module: net
audit_type: bugfix
created_at: "2026-11-03T14:30:00+08:00"
updated_at: "2026-11-03T15:10:00+08:00"
owner: zhangsan
tags: [net, concurrency, bug]
ticket: null
status: pending
target_files:
  - internal/net/session.go
  - internal/net/session_test.go
current_revision: 2
revisions:
  - id: 1
    base_revision: "108"
    patch: 001.patch
    author: ai
  - id: 2
    base_revision: "112"
    patch: 002.patch
    author: human
gate_checks:
  - "go vet ./internal/net/..."
  - "go test -race ./internal/net/..."
comments:
  - id: c1
    revision: 1
    file: internal/net/session.go
    line: 42
    side: RIGHT
    author: zhangsan
    content: "并发请求时这里会触发多次关闭，需要收敛关闭入口"
    status: resolved
    created_at: "2026-11-03T15:00:00+08:00"
human_decisions:
  - id: h1
    question: "并发关闭时是否允许丢弃仍在发送的消息？"
  - id: h2
    question: "该修复是否需要在发布说明中标注行为变化？"
approval: null
rejection: null
commit_message: |
  net: 修复连接关闭竞态

  问题证据：并发 Close 与 Send 可能触发 send on closed channel。
  关键修复：统一关闭状态流转并补充竞态测试。
  实际验证：go test -race ./internal/net/... 通过。
---

# 问题与影响

# 根因

# 当前修复方案

# 需人工判断项
- 并发关闭时是否允许丢弃仍在发送的消息？
- 该修复是否需要在发布说明中标注行为变化？

# 验证证据

# 审核记录
```

### 4.2 身份与路由字段

| 字段 | 类型 | 新候选必填 | 功能与流程 |
| --- | --- | --- | --- |
| `schema_version` | `1` | 是 | 固定为 1（见 §10、§15）。 |
| `title` | string | 是 | 格式为 `<module>: <中文标题>`；是标题唯一权威，`commit_message` 首行必须与之一致。 |
| `module` | string | 是 | 小写模块标志；用于路由、筛选、负向记忆裁剪和重复判断。 |
| `audit_type` | enum | 是 | `bugfix \| delete \| shrink \| reuse \| merge \| split \| stdlib \| native \| yagni`；用于审查分类与负向记忆。`stdlib`（标准库替换）、`native`（原生实现替代）、`yagni`（删除过度设计）与 `dsh_web.md` 审查分类 1:1 对应，映射决定见 §18.4。旧读端遇到未知枚举值按未知字段容忍，不判 broken（§15）。 |
| `created_at` | ISO time | 是 | 候选创建时间，版本迭代不改变。 |
| `updated_at` | ISO time | 是 | 最后一次共享写入时间，创建时等于 `created_at`；评论、接管、新版本、批准、拒绝都会更新；用于 `stale_days` 与排序。 |
| `owner` | string | 是 | 唯一当前操作者；接管时更新，所有写操作使用乐观锁检查；批准时 `approved_by` 必须等于当时 owner。 |
| `tags` | string[] | 是 | 用于路由与筛选，可为空数组。 |
| `ticket` | string \| null | 是 | 可选外部单号，不影响仓库自闭环。 |
| `target_files` | string[] | 是 | 当前补丁实际触及的业务文件，必须唯一且使用仓库相对路径；重命名同时记录旧、新路径。补丁删除后仍保留。 |

`target_files` 是长期事实，不从当前补丁临时推断后丢弃。生成或更新版本时，候选声明文件必须与实际补丁路径一致；审查项原有的 `target_files` 不因转换后补丁范围变化而自动改写。

### 4.3 工作流与版本字段

| 字段 | 类型 | 规则 | 功能与流程 |
| --- | --- | --- | --- |
| `status` | `pending \| changes_requested \| approved \| rejected` | 必填 | 仅表达共享审核状态；冲突、执行中、验证中不进入该字段。 |
| `current_revision` | positive integer | 必须是最高版本 ID | 指向当前版本；用于乐观锁、补丁选择和批准绑定。 |
| `revisions` | Revision[] | 至少一项，ID 连续递增且不重复 | 保存每个完整方案版本的基线、补丁和来源。 |

`Revision`：

| 字段 | 类型 | 规则 | 功能与流程 |
| --- | --- | --- | --- |
| `id` | positive integer | 与三位补丁编号一致 | 新版本追加，不覆盖旧版本。 |
| `base_revision` | string | 非空 VCS 基线 | 当前补丁必须能基于该基线独立重建。Rebase 会更新为新基线。 |
| `patch` | string | `NNN.patch`，仅文件名 | 活跃候选必须存在；归档后允许文件已清理。 |
| `author` | `ai \| human` | 必填 | AI 修复和 AI Rebase 使用 `ai`，人工微调使用 `human`。 |

每个补丁都是相对本版本 `base_revision` 的全量 Unified Diff，不是相对上一版的增量。候选之间禁止 Stacked Patches。

候选状态语义：

| 状态 | 含义 | 进入条件 | 离开 |
| --- | --- | --- | --- |
| `pending` | 等待 Owner 复核；允许仍有未解决意见（例如人工微调后） | 新建、AI 修复产出新版本、人工微调、Rebase | 评论→`changes_requested`；批准→`approved`；放弃/超时→`rejected` |
| `changes_requested` | 已提交意见，等待 AI 修复 | 新增未解决意见 | 新版本→`pending`；放弃→`rejected`；Owner 可手动转回 `pending` |
| `approved` | 已批准并原子提交 | 批准成功 | 终态 |
| `rejected` | 已放弃或超时 | 人工放弃/超时 | 终态 |

- `changes_requested` 是工作流标志，不是“存在未解决意见”的派生值；`pending` 也可以带未解决意见。
- AI 修复失败不写共享状态，候选保持 `changes_requested`；Owner 可重试或手动转回 `pending`。
- `approved` 与 `rejected` 为终态，不再接受评论、修复、接管或状态修正。

### 4.4 门禁字段

`gate_checks` 是非空命令字符串数组：

- 生产候选时，每条命令必须实际执行并记录真实结果；
- 批准时插件必须重新执行，不能仅采信 AI 的验证叙述；
- 匹配 `allowed_gate_commands` 的命令按普通批准确认执行；
- 非白名单命令必须在 UI 中显著二次确认；
- 门禁内容发生变化属于方案变化，必须生成新版本并回到 `pending`；
- 验证证据正文只记录实际执行摘要，不写未执行的命令结果，不粘贴大段日志；
- 批准阶段的执行结果写入 `approval`：`approval.gate_checks` 保存门禁快照，`approval.gate_results` 保存每条命令的退出码与耗时，见 §4.7。
- 门禁的历史声明不逐版持久化：`review.md` 的每次变更都在 Git 历史中，需要回放时按提交读取；当前不引入独立门禁版本。
- 批准完成后，若文件中的 `gate_checks` 与 `approval.gate_checks` 不一致，视为外部改写，UI 必须标记（不自动改状态）。

### 4.5 `human_decisions` 字段

`human_decisions` 保存 AI 无法自证、必须由人拍板的决策点；无判断项时为 `[]`。

| 字段 | 类型 | 规则 | 功能与流程 |
| --- | --- | --- | --- |
| `id` | string | 候选内唯一且稳定 | 被 `approval.confirmed_decisions` / `waived_decisions` 引用。 |
| `question` | string | 非空 | 需要人回答的具体问题。 |
| `note` | string | 可选 | 背景、选项或影响说明。 |

- Frontmatter 为权威；正文 `# 需人工判断项` 只做人类可读呈现，两者应保持一致，不一致时以 Frontmatter 为准并在 UI 提示。
- 批准时，每个 `id` 必须出现在 `confirmed_decisions` 或 `waived_decisions` 中（见 §4.7）。

### 4.6 `comments` 字段

| 字段 | 类型 | 规则 | 功能与流程 |
| --- | --- | --- | --- |
| `id` | string | 稳定且候选内唯一 | AI 回复意见时不得改写 ID。 |
| `revision` | positive integer | 指向已有版本 | 表明评论针对哪个方案版本。 |
| `file` | string | 总体评论为空字符串，行内评论为仓库相对路径 | 定位评论文件。 |
| `line` | integer | 总体评论为 0，行内评论为正整数 | 与 `side` 共同定位代码行。 |
| `side` | `LEFT \| RIGHT` | 行内评论必填；总体评论省略 | LEFT 表示基线旧代码，RIGHT 表示补丁新代码。 |
| `author` | string | 非空 | 记录实际评论人。 |
| `content` | string | 非空且不可被 AI 改写 | 保存人类原始意见。 |
| `status` | `unresolved \| partial \| resolved` | 必填 | AI 修复后逐条更新处理状态，并在正文解释处理结果。 |
| `created_at` | ISO time | 可选 | 用于展示和排序，不参与工作流裁决。 |

新增总体评论使 `pending` 候选进入 `changes_requested`；已在 `changes_requested` 的保持，已归档候选不可评论。AI 根据所有未解决和部分处理意见生成新版本后，状态回到 `pending`，`approval` 清空。

### 4.7 `approval` 字段

> **已废弃（2026-11-09）**：本节的 `commit_revision` 字段与第二次回填提交已移除；批准只产生一次原子提交，业务提交由 Host 从 VCS 历史派生（SPEC §5.5）。

`approval` 在候选未批准时为 null；批准时为：

| 字段 | 类型 | 功能与流程 |
| --- | --- | --- |
| `approved_by` | string | 实际执行批准的 Owner。 |
| `approved_at` | ISO time | 共享批准提交的时间。 |
| ~~`commit_revision`~~ | ~~string \| null~~ | 已废弃（2026-11-09）：不再写入 `review.md`；业务提交由 Host 从 VCS 历史派生（SPEC §5.5）。 |
| `gate_checks` | string[] | 批准时生效的门禁快照，必须与当时的顶层 `gate_checks` 完全一致。 |
| `gate_results` | object[] | 实际执行结果，每项含 `command`、`exit_code`、`duration_ms`；批准必须全部通过。 |
| `confirmed_decisions` | string[] | 已确认的 `human_decisions[].id`；无判断项时为 `[]`。 |
| `waived_decisions` | object[] | 知悉但接受风险的判断项，每项含 `id` 与非空 `reason`；无时为 `[]`。 |

示例：

```yaml
approval:
  approved_by: zhangsan
  approved_at: "2026-11-04T10:00:00+08:00"
  gate_checks:
    - "go test ./internal/net/..."
  gate_results:
    - command: "go test ./internal/net/..."
      exit_code: 0
      duration_ms: 18234
  confirmed_decisions: [h1]
  waived_decisions:
    - id: h2
      reason: "已知：发布说明由产品另行补充，已确认"
```

约束：

- 只有业务代码、批准状态和过程补丁删除成功进入同一原子提交后，`approved` 才对外成立。
- 任何实质方案变化都会清空批准并回到 `pending`。
- ~~仅上下文偏移、方案与语义不变且门禁重新通过时，可以沿用本次批准。~~ 已废弃（2026-11-09）：任何新版本都必须人工复审。
- ~~`commit_revision` 回填失败与回填中断恢复~~：已废弃（2026-11-09）；批准只有一次原子提交，业务提交由 Host 从 VCS 历史派生（SPEC §5.5）。
- 批准时 `human_decisions` 中每个 `id` 必须被确认或标记知悉，否则拒绝批准；`waived` 必须写明原因。
- `gate_results` 的命令集合与顺序必须与 `approval.gate_checks` 一致，且全部通过。
- 批准后若文件顶层 `gate_checks` 与 `approval.gate_checks` 不一致，视为外部改写并标记。

### 4.8 `rejection` 字段

`rejection` 在未拒绝时必须为 `null`；新产生的 rejected 候选必须为：

| 字段 | 类型 | 功能与流程 |
| --- | --- | --- |
| `rejected_by` | string | 执行放弃的 Owner，或超时处理的系统身份 `system:stale`。 |
| `rejected_at` | ISO time | 拒绝事实发生时间。 |
| `reason` | string | 非空、可用于后续审查的具体原因；超时废弃使用明确的超时原因。 |

示例：

```yaml
status: rejected
approval: null
rejection:
  rejected_by: "system:stale"
  rejected_at: "2026-11-20T02:00:00+08:00"
  reason: "超过 stale_days 未审核，按超时废弃处理"
```

拒绝操作在同一提交中更新 `rejection`、`status`、`updated_at`，并删除过程补丁。`review.md` 永久保留，作为负向记忆事实源。

#### 重开被拒方案（可选字段）

当 Owner 判断某个 rejected 候选其实是正确方案、需要在负向记忆窗口内重新生成时，新候选可写入两个可选顶层字段（决定见 §18.6）：

| 字段 | 类型 | 规则 | 功能与流程 |
| --- | --- | --- | --- |
| `reopened_from` | candidate_id | 可选；指向真实存在的 rejected 候选；必须与 `reopen_reason` 同时出现或同时缺省 | 声明本候选是对某次拒绝的人工重开；使该候选绕过 §7 第 4 步的确定性重复阻止。 |
| `reopen_reason` | string | 可选；出现时非空；必须与 `reopened_from` 同时出现或同时缺省 | 记录人工判断“此前拒绝为误判”的具体理由，供审计与误判率统计。 |

- 仅允许 Owner 通过 UI 人工写入，禁止 AI 自动填写；UI 必须强制填写理由。
- 重开只豁免确定性重复阻止，负向记忆提示词注入仍然生效；AI 应在验证证据中说明与被拒方案的差异。
- 约束见不变量 I16（§13.1）。

### 4.9 `commit_message` 字段

- 新候选必填，内容是多行字符串。
- 首行必须与 `title` 完全一致，格式为 `<module>: <中文标题>`。
- 正文只包含问题证据、关键修复和实际验证，不得声称未执行的验证。
- Owner 可以在批准面板中微调；文字微调只写 `review.md`，不增加补丁版本。
- 版本方案或验证发生变化时，AI 必须同步更新提交信息。
- 批准时使用当前文件中的最新值，不使用插件重新拼接的固定标题。
- `title` 是标题唯一权威；修改标题必须同批修改 `commit_message` 首行。
- 缺少该字段或首行与 `title` 不一致的候选视为格式错误，读端标记 broken，不能批准。

### 4.10 Markdown 正文

固定章节：

```text
# 问题与影响
# 根因
# 当前修复方案
# 需人工判断项
# 验证证据
# 审核记录
```

正文用于人类理解决策，不重复承载 Frontmatter 已有状态；`# 需人工判断项` 是 `human_decisions` 的人类可读呈现，两者应保持一致。每个版本在审核记录中追加方案说明、相对变化、实际验证和意见处理结果，不删改历史意见。

## 5. `reviewers.yml` 契约

```yaml
default_owner: zhangsan
rules:
  - owner: zhangsan
    paths:
      - internal/net/**
    tags: [net, concurrency]
allowed_gate_commands:
  - "go test ./..."
  - "go vet ./..."
stale_days: 14
rejection_memory_days: 30
max_anti_patterns: 20
```

| 字段 | 功能 |
| --- | --- |
| `default_owner` | 无规则命中时的兜底 Owner；仍为空时由创建时的当前操作者填写。 |
| `rules[]` | 按目录和 tag 确定唯一初始 Owner；匹配顺序：路径命中数 > tag 命中数 > 配置顺序；无命中用 `default_owner`，仍为空则由创建时的当前操作者填写。 |
| `allowed_gate_commands` | 门禁白名单；trim 后精确匹配；未命中不是禁止，而是 UI 必须二次确认。 |
| `stale_days` | `updated_at` 超过该天数后进入超时废弃流程；超时以 `system:stale` 写 rejection 并清理补丁。 |
| `rejection_memory_days` | rejected 仍参与重复阻止的时间窗，默认 30；窗口外只作 few-shot，不阻止。 |
| `max_anti_patterns` | 每模块最多注入的负向摘要数量，默认 20，按 `rejected_at` 倒序取最近。 |

- `rules[]` 只决定初始 Owner；接管后以 `review.md.owner` 为准。
- 白名单只降低确认成本，不改变执行权限；非白名单命令仍可执行，但必须在 UI 完整展示并二次确认。
- `stale_days` 与 `rejection_memory_days` 都按解析后的时间点计算，不按字符串。

## 6. 端到端工作流程

### 6.1 手动或定时审查

1. 解析范围、当前基线和触发方式，确定 `audit_id` 与 `previous_audit`。
2. 读取相关历史审查 Frontmatter，按 §3.4 的投影规则整理未关闭 finding；读取当前范围相关的 rejected 候选摘要。
3. 只把少量摘要注入 AI，不读取或注入全部历史正文。
4. AI 建立仓库地图并执行审查：
   - A 类实际改代码、跑门禁、导出独立候选；
   - B/Deferred 不直接改代码，写入 `items`；
   - 历史 finding 应复查：能确认已解决时写 `resolved`，仍存在时写 `pending`，未复查的保持上次观察，不阻断本轮。
5. 插件验证候选格式、基线、补丁范围和可应用性。
6. 同一共享提交只包含本轮新审查目录、本轮新候选目录和必要的 scaffold，不夹带已有 `.ai-review` 改动。
7. 提交成功后本轮才对外完成；定时审查也遵循同一契约。

审查会话模式（AI 直接产出候选并提交）的补充约定（决定见 §18.2、§18.3）：

- 会话启动时，插件解析 `reviewers.yml` 并把初始 Owner 路由结果（命中规则、初始 owner、兜底值）作为提示词参数传入会话，AI 据此写 `review.md` 的 `owner`。
- 会话结束后插件只做只读校验：实际 `owner` 与解析结果不一致时仅告警，不自动改写共享事实。
- 无效候选由队列加载时的 §13.2 只读校验兜住：标 broken、不参与批准/投影/负向记忆/提示词注入；另保留一个自动化校验入口（`POST /audit/verify`）供 CI 或会话结束钩子主动调用，属插件接口，不新增共享数据。

### 6.2 B/Deferred 转候选

1. Owner 从审查项发起转换，系统重新同步并读取该 `audit.md`。
2. Deferred 必须先确认 `depends_on` 已满足：前置 finding 的最新投影为 `resolved`，或其 converted 候选状态为 `approved`；候选 `rejected` 视为未满足。未满足时拒绝转换，item 保持 `pending` 并在 UI 显示阻塞原因。
3. AI 或人工基于**转换时的最新基线**生成候选，不沿用已经过期的审查基线。
4. 候选的 `target_files` 以真实补丁为准，审查项保留原始发现范围。
5. 新候选目录与原审查目录中的 `status: converted`、`candidate` 必须在同一个共享提交中完成。
6. 提交失败则恢复两边文件，不能留下“显示已转换但候选不存在”的关联。

### 6.3 评论与 AI 修复

1. 所有评论带 `expectedRevision + expectedOwner`。
2. 保存评论并提交候选目录成功后，才启动自动 AI 修复。
3. AI 生成下一全量补丁，追加 Revision，更新意见状态和审核记录。
4. 新版本候选目录提交成功后，UI 才显示新版本和 `pending`。
5. 任一共享提交失败，操作返回失败并恢复本地事实文件，不以成功响应掩盖。
6. AI 修复失败不写共享状态；候选保持 `changes_requested`，Owner 可重试或手动转回 `pending`。

### 6.4 人工微调

1. 在隔离工作区基于当前 Revision 的基线应用当前补丁。
2. 人工直接修改代码并运行门禁。
3. 生成下一全量补丁，`author: human`，状态回到 `pending`。
4. 人工微调不自动 Rebase；如需最新基线，走显式 Rebase 流程。
5. 提交候选目录成功后完成；失败则恢复，不留下半版本。

### 6.5 补丁预检与 Rebase

- 队列加载时只对活跃候选的最新补丁执行非破坏性预检。
- 展示“基线最新”“基线落后但可应用”“基线冲突”，这些均为本地派生状态。
- 冲突时禁用直接批准，Owner 可发起 Rebase。
- Rebase 在最新基线上生成下一 Revision，`author: ai`，重跑门禁并回到 `pending`。
- 预检结果、运行中和冲突详情不写入 Frontmatter。

### 6.6 批准

> **已废弃（2026-11-09）**：本节第 2 步的隔离工作区、第 6 步的第二次回填提交均已废弃；批准在仓库根目录原地执行，只产生一次原子提交，业务提交由 Host 从 VCS 历史派生（SPEC §1.4、§5.5）。

1. 重新同步并读取候选，校验 Revision、Owner、`human_decisions` 的确认/知悉覆盖和提交信息；存在未确认且未标记知悉的判断项，或批准人不是当时 owner 时拒绝批准。
2. ~~在隔离工作区同步最新基线并应用当前补丁。~~ SPEC v1 在仓库根目录原地执行（§1.4）。
3. 校验并执行门禁，记录实际证据（命令、退出码、耗时）到本次批准。
4. 无冲突且全绿则继续；实质变化则产生新版本并重新审核。
5. 业务代码、`status: approved`、`approval`（含门禁快照、执行结果、确认/知悉记录）、验证证据、过程补丁删除和 `updated_at` 更新进入同一原子提交。
6. ~~第二个仅 `.ai-review` 提交回填 `commit_revision`。~~ 已废弃（2026-11-09）。
7. 基线竞争最多重试两次；超过上限则不产生共享 approved 状态。
8. 批准互斥语义（见 §18.8）：所有共享写操作经由同一共享检出串行化执行（检出级互斥，同一时刻只允许一个共享提交流程）；批准提交后立即重新同步，若发现同一候选已存在另一条 approved 记录，显式报告冲突并交由人工裁决，不自动改写状态。多克隆分布式并发不在本期保证范围（§16：owner 非鉴权）。

### 6.7 拒绝与超时

- 人工放弃必须填写具体原因，`rejected_by` 写执行人。
- 超时根据 `stale_days`（锚点 `updated_at`）进入相同 rejected 归档路径；`rejected_by` 写 `system:stale`，`reason` 写超时说明。
- 超时归档由定时任务或队列中的显式「归档过期候选」操作执行，二者写同一 rejected 路径；队列加载只检测并提示过期，不做“读时写”（决定见 §18.1）；同一候选只允许一次 rejected 写入（乐观锁）。
- 状态、`rejection`、补丁删除和 `updated_at` 在同一共享提交中完成。
- 已拒绝候选不可继续评论、修复或批准。

## 7. 负向记忆与重复阻止

> **2026-11-09 补充**：拒绝记录可带 `category` 与 `related_symbols`；分类用于提示词分组，`stale` 只作弱信号；两者都不进入确定性指纹。

不建立独立负向记忆文件。事实来源为 rejected 候选的：

```text
module + target_files + audit_type + title + rejection.reason
```

流程：

1. 插件按当前审查范围和模块筛选 `rejected_at` 在 `rejection_memory_days` 内的 rejected 候选；窗口外只作为少量 few-shot。
2. 对确定性重复计算临时指纹：`module + 排序后的 target_files + audit_type + 规范化 title`。
3. 规范化仅包括去除首尾空白、合并连续空白和 ASCII 小写化；指纹不持久化。
4. 与窗口内 rejected 记录完全相同的候选由插件阻止进入队列，并在本轮审查报告中说明；窗口外不阻止。唯一例外：候选带有 `reopened_from`/`reopen_reason`（§4.8、I16）时不阻止，但仍注入被拒记录，由 AI 说明差异并最终由人审核。
5. 语义相近但指纹不同的情况，只把少量标题、文件和拒绝原因注入提示词，由 AI 避免重复，最终仍由人审核。
6. 按 `rejected_at` 倒序取每模块最近 `max_anti_patterns` 条注入。
7. 不用标题相似度替代人工裁决，也不把 dismissed 的 B 类自动当作 rejected 候选。

## 8. 共享写入与事务边界

> **已废弃（2026-11-09）**：本节表格中的 `commit_revision` 回填行不再适用；批准只有一次业务提交，后续读取按 SPEC §5.5 派生。

| 操作 | 同一共享提交必须包含 |
| --- | --- |
| 审查完成 | 本轮 audit 目录 + 本轮新候选目录 |
| B/Deferred 转换 | 原 audit 目录 + 新候选目录 |
| 评论/评论状态/接管/提交信息微调/人工判断项确认 | 当前候选目录 |
| 状态修正（如 AI 修复失败后转回 `pending`） | 当前候选目录 |
| AI 修复/人工微调/Rebase | 当前候选目录及新增补丁 |
| 批准 | 业务代码 + 当前候选目录 + 补丁删除 |
| ~~commit_revision 回填~~ | 已废弃（2026-11-09）：批准只有一次业务提交。 |
| 拒绝/超时 | 当前候选目录 + 补丁删除 |

通用规则：

1. 写入前同步并重新读取事实文件，校验 Revision 和 Owner。
2. 只提交本操作拥有的路径，不使用全量 `.ai-review` 提交夹带其他改动。
3. 本地写入后提交失败，恢复操作前文件并返回失败。
4. Job 只有在共享提交成功后才能报告成功。
5. 默认只 commit 不 push；其他实例通过既定仓库同步获得事实。
6. 每次共享写入更新 `updated_at`；批准/拒绝后为终态时间。
7. 只对已提交事实做流程裁决；未提交改动按 §14 视为本地视图。
8. 共享写操作经由同一共享检出串行化执行（检出级互斥锁）；批准提交后重新同步，检测同候选重复 approved 记录，发现即显式报告、人工裁决（见 §6.6、§18.8）。

## 9. 共享状态与本地状态

候选共享状态仍只有：

```text
pending | changes_requested | approved | rejected
```

审查项共享状态只有：

```text
pending | converted | dismissed | resolved
```

候选另维护 `updated_at`：记录最后一次共享写入，由每次写操作维护，不作为状态机输入。

以下状态只保存在本地：

- AI/人工任务执行中；
- 门禁正在运行；
- 基线落后、可应用或冲突的预检结果；
- 页面人工判断项的临时勾选（最终确认或知悉记录写入 `approval`）；
- AI 修复失败原因、重试次数；
- 任务日志与临时工作区路径。

## 10. 开发期数据策略

- `schema_version` 保持 1：它只表示当前读写端属于同一代格式，不再承担跨版本兼容职责。
- 本项目尚未正式投入使用，本次契约不提供历史迁移：现有 `.ai-review/` 下的开发期数据（旧扁平 `audits/*.md`、缺字段的旧候选）在启用新格式时删除重建，`reviewers.yml` 保留并按 §5 扩展。
- 需要重置的路径：`.ai-review/audits/*.md`（旧扁平报告）与 `.ai-review/<YYYY-MM>/` 下缺新字段的候选；`.ai-review/reviewers.yml` 不删除。
- 不为旧字段写缺省或降级规则，不实现迁移脚本；被删除的数据仍可在 Git 历史中追溯。
- 所有读端与写端必须与本次契约同批升级；混用不同代写端不在支持范围。
- 正式试点多人共用前，重新评估是否需要写端版本闸门或版本号区分。
- 正式启用后不得再删除数据；届时按 §15 演进策略处理。
- 实现必须保留不认识的顶层字段；新增内层字段必须由写端完整建模，未知嵌套键原样保留，避免任何一次写入丢字段。

## 11. 明确不引入的内容

- 不引入共享 `index.json` 或独立数据库。
- 不引入候选与审查项的双向来源字段。
- 不引入 Stacked Patches。
- 不引入冲突、执行中、验证中等共享状态。
- 不引入逐版门禁快照或独立门禁版本；历史门禁查 Git（A 方案）。
- 不强制 finding 完整性校验；投影规则见 §3.4。
- 不持久化未解决意见数、验证状态等派生值。
- 不提供绕过负向记忆的静默入口。
- 不为假想的审查附件预建空文件。
- 不用模型判断纯机械的字段完整性、路径越界或完全重复。
- 不让本地写入成功替代共享提交成功。

## 12. 验收重点

### 12.1 格式与不变量

- 时间字段的裸 ISO、带引号 ISO 与 `Z` 三种写法解析为同一时间点；排序与过滤按时间点而非字符串；所有时间含时区偏移。
- Frontmatter 往返序列化不丢失任何字段，包括 `revisions[].author`、`comments[].side`、`human_decisions`、`approval.gate_checks/gate_results` 及未知嵌套键；键序符合 §2.3。
- 空数组写 `[]`、无值对象写 `null`；字段不因“省略”而改变语义。
- `target_files` 与真实补丁路径一致；LEFT/RIGHT、human/ai 均可保留。
- 审查目录均可读取，finding_id 能跨轮关联；旧扁平 `audits/*.md` 不参与新流程。
- §13 的不变量全部有对应测试用例。

### 12.2 流程

- 手动和定时审查生成同构的 audit.md。
- 下一轮能识别上一轮问题仍存在或已解决；未复查的 finding 保持上次观察，不判 audit 无效。
- B/Deferred 转换原子产生候选和关联，不允许单边成功；`depends_on` 未满足时拒绝转换。
- 评论、AI 修复、人工微调、Rebase、批准失败回退均只有在共享提交后才报告成功。
- 批准提交只包含本候选业务代码与审核事实，commit_message 使用最新确认文本；标题与首行不一致时不能批准。
- 人工判断项未确认且未标记知悉时批准被拒绝；确认/知悉记录写入 `approval`。
- 批准记录包含门禁快照与逐条执行结果；批准后文件门禁与快照不一致能被发现。
- 拒绝后无补丁残留，窗口内完全重复候选被阻止，相似候选保留人工判断。
- `changes_requested` 在 AI 修复失败后可重试或由 Owner 转回 `pending`，不会永久卡死。

### 12.3 校验与失败

- 无效 `review.md` 在队列中显示为 broken，不使整个队列崩溃；无效 `audit.md` 被拒绝，不进入 finding 投影。
- 任何写操作在并发不匹配、补丁冲突、门禁失败或提交失败时返回失败，并恢复操作前文件；不得以成功响应掩盖。
- 未提交的工作区改动被视为本地视图，不参与批准、负向记忆和提示词注入。
- 超过 `stale_days` 的候选能按 `system:stale` 归档，且只产生一次 rejected 写入。
- 共享写操作经检出级互斥串行化；批准提交后能发现同候选重复 approved 记录并显式报告，不自动改写。
- ~~`approved` 且 `commit_revision == null` 的候选在队列加载时被提示回填；回填幂等可重试。~~ 已废弃（2026-11-09）：改为从 VCS 历史派生，见 SPEC §5.5。
- broken 候选经 Owner 人工修复提交后能恢复流转；修复前不参与批准、投影与负向记忆，且不可被 AI 自动改写。
- 带 `reopened_from` 的候选不被确定性重复阻止，但负向记忆注入仍生效；`reopened_from` 不指向 rejected 候选或 `reopen_reason` 为空时按 broken 处理。

### 12.4 简洁性

- 删除任何本地缓存后，仅扫描事实文件即可恢复队列、关联和负向摘要。
- 无共享索引、无双向关联、无重复持久化派生状态。
- 新增审查附件不改变既有 audit.md 路径和解析结果。

## 13. 不变量与校验矩阵

### 13.1 不变量

读端必须能检出以下不变量；写端必须在同一共享提交中维持它们。违反时读端标记 broken 或跳过该条，写端拒绝写入。

| # | 不变量 |
| --- | --- |
| I1 | `audit_id` 等于目录名；`candidate_id` 等于相对 `.ai-review/` 的目录路径；二者创建后不可改名或移动。 |
| I2 | `review.md` 与 `audit.md` 都含 `schema_version: 1`。 |
| I3 | `current_revision` 等于 `max(revisions[].id)`；版本 ID 为正整数、唯一、连续递增。 |
| I4 | 活跃候选的每个 Revision 都有补丁文件；当前补丁能基于其 `base_revision` 干净应用。 |
| I5 | 活跃候选的 `target_files` 与当前补丁实际触及的业务文件一致（重命名记录旧、新路径）。 |
| I6 | `status == approved` 等价于 `approval != null`；`status == rejected` 等价于 `rejection != null`；二者互斥。 |
| I7 | `approval.gate_checks` 等于批准时的顶层 `gate_checks`；`gate_results` 与之一一对应且全部通过。 |
| I8 | `human_decisions[].id` 唯一；批准时每个 id 出现在 `confirmed_decisions` 或 `waived_decisions`，`waived` 的 `reason` 非空。 |
| I9 | `status == converted` 等价于 `candidate != null`；其他审查项状态的 `candidate` 必须为 `null`。 |
| I10 | `kind == deferred` 的 `depends_on` 非 null；`kind == confirm` 的 `depends_on` 为 null。 |
| I11 | `comments[].revision` 指向已有版本；行内评论 `file` 非空、`side` 为 LEFT/RIGHT、`line > 0`；总体评论 `file == ""`、`line == 0` 且省略 `side`。 |
| I12 | 所有路径为仓库相对、`/` 分隔、不含绝对路径或 `..`；`scope` 为 `.` 或合法相对路径。 |
| I13 | 所有时间可解析且含时区偏移；`audit_id` 的时间戳与 `created_at` 指向同一开始时刻。 |
| I14 | 顶层未知字段与未知嵌套键原样保留；写端不得只重建已知字段。 |
| I15 | `status == pending` 允许存在未解决意见；`changes_requested` 表示等待 AI 修复，不是意见状态的派生值。 |
| I16 | `reopened_from` 与 `reopen_reason` 同时出现或同时缺省；出现时 `reopened_from` 指向真实存在的 rejected 候选、`reopen_reason` 非空；二者仅允许人工操作写入，禁止 AI 自动填写。 |

### 13.2 校验矩阵

| 操作 | 写前/提交前必须校验 | 失败处理 |
| --- | --- | --- |
| 读取候选/队列 | I1（candidate 部分）、I2–I5、I11–I14、I16；`review.md` 可解析；当前补丁存在（非归档） | 该项标记 broken，继续处理队列，不崩溃 |
| 读取审查/投影 | I1（audit 部分）、I2、I9、I10、I12–I14；`audit.md` 可解析 | 跳过该 audit 并报错，不参与投影 |
| 审查完成提交 | finding 的 `target_files`、candidate 引用、补丁可应用、base_revision 一致；本轮 audit 目录及新候选目录不存在（同秒并发冲突时本轮失败返回并重试，新目录名随时间戳自然区分）；提交范围只含本轮目录 | 不提交；返回失败；候选不进入队列 |
| B/Deferred 转换 | item.status == pending、`depends_on` 满足、新候选目录不存在、两侧同一提交 | 恢复两侧文件；不报告成功 |
| 评论/接管/提交信息 | expectedRevision + expectedOwner、content 非空、revision 存在；更新 `updated_at` | 返回 409/400；不写入 |
| AI 修复/人工微调/Rebase | 新版本 ID 连续、补丁相对新基线全量、`author` 正确、门禁重跑；更新 `updated_at` | 恢复工作区与候选目录；不留下半版本 |
| 批准 | §13.1 中适用于该候选的不变量、I7/I8、工作区干净、补丁可应用、门禁全绿、commit_message 首行 == title；更新 `updated_at` | 回滚工作区；候选回 pending 或返回失败；不产生 approved |
| 拒绝/超时 | expectedRevision + expectedOwner、`rejection.reason` 非空、`rejected_by` 合法；只写一次 | 返回失败；不删除补丁 |
| 重开被拒方案 | I16：`reopened_from` 指向真实 rejected 候选、`reopen_reason` 非空、操作者为 Owner 且非 AI 自动填写 | 拒绝写入；按普通新候选处理或返回失败 |
| ~~commit_revision 回填~~ | 已废弃（2026-11-09）：批准只有一次原子提交；业务提交由 Host 从 VCS 历史派生（SPEC §5.5） | — |
| 读端容错 | 不自动修复；未知字段保留 | 标记 broken 或提示升级 |

broken 候选的出口（决定见 §18.8）：

- broken 候选不参与批准、投影、负向记忆与提示词注入，补丁不删除、不计入队列 KPI。
- 唯一恢复路径：Owner 人工修复 `review.md` 后，通过一次仅含该候选目录的显式修复提交恢复；恢复后重新按 §13.2 校验，通过才回到正常流转。
- 禁止 AI 自动改写 broken 文件；无法修复的候选保持 broken 只读展示，由 Owner 决定是否走人工废弃（补一份合法的 `rejection` 后即退出 broken 展示）。

## 14. 读取口径：共享事实与本地视图

设计原则 6 要求“共享提交成功才算完成”，因此读端必须区分两类数据：

- **共享事实**：`.ai-review/` 中已进入当前分支 HEAD 的内容。队列、批准、负向记忆、finding 投影、审查提示词注入只使用共享事实。
- **本地视图**：工作区中尚未提交的 `review.md`/`audit.md`/patch。可以在 UI 中显示为 `local` 诊断项，但必须显著标记，且：
  - 不参与批准、拒绝、转换等写操作；
  - 不参与负向记忆与重复阻止；
  - 不参与 finding 投影与提示词注入；
  - 不计入队列 KPI。

实现可以用 `git status --porcelain` / `git diff --name-only` 与 `svn status` 判断路径是否已提交，不要求读端直接解析对象库。提交失败的写入必须回滚工作区，避免留下长期 `local` 项。

SVN 环境的判定规则（决定见 §18.5）：

- **本地视图**：`svn status --xml` 中该路径存在任何本地改动条目（modified/added/deleted/replaced/属性改动）即视为本地视图。
- **共享事实**：路径已在仓库中且 `svn status` 无任何本地改动条目。
- 未版本化（unversioned）条目不属于共享事实，按本地视图处理。
- 增量 diff：SVN 无 worktree 概念，无法像 Git 一样切换基线重建；保持 hunk 级降级——无法在目标基线上干净应用时按 hunk 丢弃并显著提示，不阻塞整份读取。

## 15. 演进策略

`schema_version` 表示 Frontmatter 格式代际，不是插件版本。

- **兼容性变更**（可保持 1）：新增可选字段；新增枚举值但旧读端可忽略；新增正文章节。读端必须保留未知字段，写端必须保留未知嵌套键。
- **破坏性变更**（必须升 2）：删除或重命名字段、改变字段语义、把可选字段改为必填、改变路径/ID 规则、改变状态集合。
- 破坏性变更必须提供迁移脚本与至少一个版本的读兼容；开发期例外见 §10。
- 新字段默认可选；确需必填时按破坏性变更处理。
- 读端只接受自己支持的 `schema_version`；遇到更高版本应拒绝该文件并提示升级，而不是猜测解析。
- 写端不得写自己读端不支持的版本。

## 16. 安全边界

- `gate_checks` 会在批准时以当前用户权限执行任意 shell 命令；白名单只降低确认成本，不改变权限。只批准可信来源的候选。
- `reviewers.yml` 的 `allowed_gate_commands` 必须 trim 后精确匹配；非白名单命令必须在 UI 完整展示并二次确认。
- 路径类字段（`scope`、`target_files`、`patch`、`file`）必须校验为仓库相对路径，禁止绝对路径、`..`、反斜杠和符号链接逃逸。
- 禁止在 Frontmatter、正文或附件中写入密钥、Token、个人凭证；验证证据只保留摘要。
- `owner` 是本地约定，不是鉴权；真正的权限需要仓库/服务端能力，当前版本不提供。
- 默认只 commit 不 push；插件不主动访问网络；批准路径不执行未在 `gate_checks` 中声明的命令。

## 17. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-03 | 初版：候选与审查分离、finding 身份、事务边界、状态规则。 |
| 2026-11-04 | 按评审结论修订：门禁采用“批准时快照 + 执行结果”（历史查 Git）；`human_decisions` 结构化并记录确认/知悉；时间戳示例加引号、解析器兼容裸 ISO 并按时间点比较；`schema_version` 保持 1 且不做历史迁移（§10）；finding 不强制完整性，改为投影规则；开发期数据删除重建。 |
| 2026-11-04 | 规范化完善：新增文档结构、术语、标识与序列化规范、`updated_at`、候选状态语义、`depends_on` 判定、负向记忆时间窗、不变量与校验矩阵、读取口径、演进策略、安全边界、待决事项；统一 key 序与数组/null 规则。 |
| 2026-11-04 | 落定 §18 全部 7 项待决事项：超时归档禁止读时写（定时任务/显式归档操作）；会话模式 owner 路由走提示词注入 + 会话后只读告警；插件校验收口在队列加载（broken 隔离）并留 `POST /audit/verify`；`audit_type` 扩展 `stdlib\|native\|yagni`（additive）；§14 补 SVN 已提交判定与 hunk 级降级；新增可选字段 `reopened_from`/`reopen_reason` 及不变量 I16 作为负向记忆人工覆盖；批量操作与真实鉴权标记 deferred。 |
| 2026-11-04 | 流程保证补全（§18.8）：并发批准互斥定为检出级串行化 + 提交后冲突检测；`commit_revision` 回填中断由队列加载触发幂等补填；broken 候选定义唯一人工修复出口；审查完成提交增加 audit/候选目录不存在校验。同步更新 §3.1 示例、§4.7、§6.6、§8、§12.3、§13.2。 |

## 18. 已决事项（原待决事项）

以下 7 项于 2026-11-04 全部落定。所有决定均不改变 `schema_version`（保持 1）；仅第 4、6 项引入 additive 变更（新增枚举值与可选字段，§15 允许），其余 5 项无数据影响。

### 18.1 超时废弃由谁触发

- **决定**：不做“读时写”。队列加载只检测并提示过期（本地视图）；实际归档由两条路径执行——定时任务，或用户在队列中对过期候选发起显式「归档过期候选」操作。归档写 `rejected_by: system:stale`，走 §6.7 同一 rejected 提交路径，乐观锁保证同一候选只写一次。
- **理由**：读时写会让纯读操作产生共享提交副作用，违反 §8 事务边界与 §14 读取口径；显式操作 + 可选定时任务在无调度能力的环境也成立。
- **实现影响**：无新字段；需实现一个显式归档动作与可选定时任务；§6.7 已同步更新。

### 18.2 会话审查的 owner 路由

- **决定**：审查会话启动时，插件解析 `reviewers.yml` 并把解析结果（命中规则、初始 owner、兜底值）作为提示词参数传入会话，AI 据此写 `owner`。会话后插件只做只读校验：实际 owner 与解析结果不一致时仅告警，不自动改写共享事实。
- **理由**：自动改写会话产物违反“共享写入由操作拥有”的边界且可能与乐观锁冲突；提示词注入使 §5 的“插件解析 owner”在 AI 直接提交的主路径上成立。
- **实现影响**：无新字段；审查会话启动参数增加 reviewers 解析结果；队列加载增加一条只读一致性告警；§6.1 已同步补充。

### 18.3 会话审查的插件校验职责

- **决定**：队列加载时执行 §13.2 只读校验；无效候选标 broken，不参与批准、投影、负向记忆与提示词注入。不提供“会话中强制拦截”；另保留 `POST /audit/verify` 类自动化校验入口供 CI 或会话结束钩子调用——属插件接口，不新增共享文件。
- **理由**：主路径是 AI 会话直接提交，插件无法在共享提交前强制拦截；把校验放在所有共享事实的必经入口（队列加载）保证无效候选无法继续流转。
- **实现影响**：无新字段；broken 候选需 UI 展示与修复指引；§6.1 已同步补充。

### 18.4 `audit_type` 与审查分类的映射

- **决定**：采用方案 A——扩展枚举为 `bugfix | delete | shrink | reuse | merge | split | stdlib | native | yagni`（§4.2 已更新）。`stdlib`（标准库替换）、`native`（原生实现替代）、`yagni`（删除过度设计）与 `dsh_web.md` 审查分类 1:1 对应，无映射歧义。属 §15 兼容性变更（新增枚举值），schema_version 保持 1；旧读端遇到未知枚举值按未知字段容忍，不判 broken。
- **理由**：分类是指标统计与负向记忆指纹（§7）的输入，映射到 shrink/delete 会丢失粒度且 yagni 的映射归属存在歧义；1:1 对应让两侧统计可直接对账。
- **实现影响**：§4.2 枚举与 §7 指纹输入更新；读端须容忍未知 `audit_type` 值；生成候选的提示词需包含 9 类定义。

### 18.5 SVN 的“已提交”判定与增量 diff

- **决定**：§14 已补充规则——`svn status --xml` 中路径存在任何本地改动条目即本地视图；无本地改动即共享事实；unversioned 按本地视图处理。增量 diff 无 worktree 可切换，保持 hunk 级降级：无法干净应用时按 hunk 丢弃并显著提示，不阻塞整份读取。
- **理由**：SVN 单工作副本、无对象库基线切换能力，不能照搬 Git 的判定与重建路径；hunk 级降级在保住可用性的同时明确损失边界。
- **实现影响**：无新字段；§14 已同步补充；读端需按 VCS 类型选择判定实现。

### 18.6 负向记忆误判的人工覆盖

- **决定**：采用方案 A——新增可选顶层字段 `reopened_from`（指向 rejected 候选）与 `reopen_reason`（非空理由），二者同时出现或同时缺省（§4.8、I16）。仅 Owner 人工写入、UI 强制填写理由、禁止 AI 自动填写；带该字段的候选绕过 §7 第 4 步确定性重复阻止，但负向记忆注入仍生效，AI 须在验证证据中说明与被拒方案的差异。
- **理由**：缩短 `rejection_memory_days` 是削弱所有模块负向记忆的全局副作用，且无留痕、无法统计误判率；可选字段属 §15 兼容性变更，人工判断留痕符合本设计原则。
- **实现影响**：§2.3 键序末尾、§4.8、§7、§12.3、§13（I16 与校验矩阵）已同步更新。

### 18.7 批量操作与真实鉴权

- **决定**：一期不做，标记 deferred。§16 已声明 owner 是本地约定、不是鉴权；并发操作冲突由乐观锁（expectedRevision + expectedOwner）兜底。多人试点前再评估写端版本闸门、服务端鉴权与批量操作原子性；在此之前不设计批量操作的数据结构。
- **理由**：当前单人/小范围使用，提前设计批量操作会引入未经验证的事务边界与权限模型。
- **实现影响**：无新字段、无新章节；§16 维持现状。

### 18.8 流程保证补全（2026-11-04 第二轮）

按“保证流程、不打磨细节”的口径复查端到端流程后补定的 4 项缺口，均无数据结构变更：

- **并发批准互斥**：共享写操作经同一共享检出的检出级互斥串行化；批准提交后重新同步，发现同候选重复 approved 记录时显式报告、人工裁决，不自动改写。多克隆分布式并发不在本期范围（规范见 §6.6 第 8 步、§8 通用规则 8）。
- ~~**`commit_revision` 回填中断恢复**~~：已废弃（2026-11-09）；批准单次提交，业务提交由 Host 从 VCS 历史派生（SPEC §5.5）。
- **broken 候选出口**：Owner 人工修复 + 仅含该候选目录的显式修复提交是唯一恢复路径；不可修复者保持 broken 只读展示或人工补合法 `rejection` 退出；禁止 AI 自动改写（规范见 §13.2）。
- **审查目录冲突校验**：审查完成提交前校验本轮 audit 目录及新候选目录不存在；同秒并发冲突时本轮失败重试，目录名随时间戳自然区分（规范见 §13.2）。
