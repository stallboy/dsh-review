# dsh-code-review 规格说明书（SPEC）

- **包名 / 版本**：`dsh-code-review` v0.3.0（DSH 插件，host + web client 双端）
- **文档地位**：本文是本插件的**权威规格（normative spec）**。描述分为两类内容：
  - **契约**：系统应遵守的行为规范（无标注的正文）；
  - **【现状】注记**：当前实现与契约的已知偏差或实现细节，集中登记于 §15"已知差距与演进"；修正实现后应删除对应注记。
- **命名约定**：`.ai-review/` 内落盘文件一律使用 **YAML snake_case** 键名（如 `commit_message`、`base_revision`）；HTTP API 与 TypeScript 类型使用 **camelCase**（如 `commitMessage`、`baseRevision`），二者一一对应。API 出参使用 camelCase（如 `duplicateOf`）。
- **关联文档**：
  - [assets/ai-fixer-system.md](assets/ai-fixer-system.md)：AI Fixer（候选修复生成）系统提示词契约；
  - [assets/repo-audit-system.md](assets/repo-audit-system.md)：仓库审查 Agent 系统提示词契约；
  - [code.md](code.md)：早期接口与前端设计草案，**仅作历史参考，不具规范力**；本文 §10 描述 Client 的实际规范。

---

## 1. 目标与非目标

### 1.1 目标

为 DeepSeek Harness（DSH）提供一个**会话级代码审核面板**，把"AI 生成候选修复 → 人类审核 → 门禁验证 → 原子提交"变成一条可追踪、可审计、防冲突的工作流：

1. AI（Fixer 或仓库审查 Agent）在仓库的 `.ai-review/` 目录下产出候选修复包（`review.md` + `NNN.patch`）；
2. 人类审核员在 DSH Web 面板查看队列与详情，对"需人工判断项"逐项拍板，审阅差异与门禁证据；
3. 批准时插件在**批准时生效基线**（见 §6.4 步骤 6 的两种语义）上严格应用补丁、执行门禁命令，全部通过后**原子提交**业务代码与 `review.md` 并清理历史补丁；补丁冲突或门禁失败时按 §6.4.2 的判定表回退处理。

### 1.2 核心价值主张

- **降低人类审核认知负荷**：确定性验证交给 `gate_checks` 机器门禁；AI 无法自证的取舍以 `human_decisions` 结构化暴露，批准前强制逐项确认或显式 waive。
- **仓库即事实源**：所有共享状态持久化在 `.ai-review/`（随版本库走）；本地瞬态（同步中/验证中等）只存内存，不落盘。
- **乐观锁防并发冲突**：所有写操作携带 `ConcurrencyGuard`（期望版本号 + 期望 owner），与磁盘最新值不一致即拒绝。
- **拒绝留痕 + 负向记忆**：被拒候选永久归档；同指纹候选在时间窗口内无法被批准（§5）。

### 1.3 非目标（Non-Goals）

- 不做代码托管平台的 PR/MR 替代品：不感知 branch、PR、merge 语义，只依赖"基线 + 补丁 + 原子提交"。
- 不做批量批准：UI 层面强制逐个候选进入详情页审核。
- 不做隔离工作区执行门禁：门禁命令在仓库根目录原地执行（未来可扩展，当前无此配置项）。
- 不替人类做业务决策：所有 `human_decisions` 必须由人确认或显式 waive（带理由）。

### 1.4 优先级顺序

正确性（Correct） > 安全性（Safe） > 负载下稳定（Holds under load） > 经过测试（Tested） > 性能（Fast） > 精简（Lean）。本顺序同时约束 AI Agent 的审查准则（见 repo-audit-system.md）。

---

## 2. 术语与角色

| 角色 | 说明 |
| --- | --- |
| **AI Fixer** | 修复代理，按 [ai-fixer-system.md](assets/ai-fixer-system.md) 契约工作：针对缺陷/工单/审核意见生成候选或下一版本补丁（Mode A 初始生成 / Mode B 意见迭代 / Mode C 冲突与门禁修复）。 |
| **仓库审查 Agent（Auditor）** | 按 [repo-audit-system.md](assets/repo-audit-system.md) 契约对目标范围深度审查：A 类问题直接产出候选包，B 类与 Deferred 写入审查报告。 |
| **人类审核员（Reviewer / Owner）** | 候选的当前负责人。审阅、提意见、批准、拒绝、接管、重开。 |
| **插件 Host（`src/host/`）** | Cordis host 插件：HTTP API、Review Store、VCS 适配、门禁执行、Runner、批准编排、审查编排、审查档案、调度器。 |
| **插件 Client（`src/client/`）** | DSH Web 面板：审核队列、候选详情、差异视图、审批流 UI。 |
| **候选（Candidate）** | `.ai-review/YYYY-MM/<slug>/` 下的一个修复提案，含 `review.md` 与一至多个 `NNN.patch`。 |
| **基线（base_revision）** | 生成某版本补丁时的 VCS 版本（Git commit hash 或 SVN revision）。**批准时生效基线**：`syncBeforeApprove=true` 时为同步后的最新基线；`false` 时为本地当前基线。 |
| **门禁（gate_checks）** | 合并前必须在仓库根目录通过的非交互式、无副作用、确定性命令列表；**必须非空**——空列表判定为门禁失败且不允许批准（§6.2）。 |

---

## 3. 仓库数据契约（`.ai-review/`）

### 3.1 目录布局

```text
.ai-review/
├── reviewers.yml                 # 审核人路由与治理配置（§3.2）
├── YYYY-MM/
│   └── <slug>/                   # 一个候选目录（§3.3）
│       ├── review.md             # 候选元数据 + 审核正文（强校验）
│       ├── 001.patch             # 版本 1 全量补丁
│       └── 002.patch             # 版本 2 全量补丁（禁止覆盖历史补丁）
└── audits/
    ├── <YYYYMMDD>-<HHmmss>-<slug>/audit.md   # 目录式审查档案（§3.6 契约）
    └── <YYYYMMDD>-<HHmmss>-<slug>.md          # 【现状】运行时审查报告实际落盘形态（§15-G1）
```

- **候选 id**：相对 `.ai-review/` 的路径 `YYYY-MM/<slug>`；`YYYY-MM` 为四位年-两位月；`<slug>` 只允许 `ASCII 字母/数字/./_/-`（禁止中文、空格、斜杠；中文语义放在 `review.md` 的 `title`）。Store 读取时执行路径包含校验（`ensureInside`），任何越出 `.ai-review/` 的路径（含 `..` 形态）均被拒绝。
- **补丁文件**：3 位零填充编号 + `.patch`；每个补丁是相对该版本 `base_revision` 的**全量** Unified Diff（UTF-8、LF、路径相对仓库根）；**严禁触及 `.ai-review/` 自身、`.tmp/`、`node_modules/`**。
- 旧扁平 `audits/*.md` 不参与目录式档案流程（开发期数据不做迁移，按新契约重建）。

### 3.2 `reviewers.yml`（审核人路由与治理配置）

```yaml
default_owner: <账号>            # 必填；未命中规则时的负责人
rules:                            # 可选
  - owner: <账号>
    paths: ["src/auth/**"]        # 可选 glob；`**` 跨 `/`，`*` 不跨，`?` 单字符
    tags: ["net"]                 # 可选，小写比较
allowed_gate_commands: [...]       # 可选；门禁白名单（trim 后精确匹配）
stale_days: 14                    # 可选正整数；updated_at 超过该天数的活跃候选进入超时废弃流程；未配置时仅提示
rejection_memory_days: 30         # 可选正整数，默认 30；负向记忆窗口（§5）
max_anti_patterns: 20             # 可选正整数，默认 20；每模块注入提示词的负向记忆条数上限（§5）
```

**路由算法（契约）**：对每条规则统计 `target_files` 的路径命中数与 `tags` 的标签命中数；取"路径命中数最多，其次标签命中数最多"的规则为最佳匹配；无任何命中时用 `default_owner`。多条规则并列时先声明者优先（首个最佳保留）。

**门禁白名单**：`gate_checks` 命令 trim 后与 `allowed_gate_commands` 精确匹配；未命中不是禁止执行，而是要求 UI 二次确认（【现状】该二次确认 UI 尚未实现，见 §15-G4）。

**【现状】注记**：`resolveOwner()` 路由函数当前在运行时未被调用（见 §15-G3）；实际 owner 由审查/修复提示词中的路由指引块引导 AI 自行填写，`reviewers.yml` 的其余键（白名单、stale、记忆窗口）在运行时生效。

### 3.3 `review.md` Frontmatter（候选元数据）

文件 = YAML Frontmatter（`---` 围栏）+ Markdown 正文。Frontmatter 由插件**强校验解析**；未知键**原样保留**（I14：AI 写入的文件绝不被截断，嵌套对象中未建模键同样保留于 `extra`）。字段（YAML 键名）：

| 键 | 类型 / 取值 | 说明 |
| --- | --- | --- |
| `schema_version` | `1` | 唯一支持值。 |
| `title` | string | `<小写模块标志>: <中文标题>` 格式。 |
| `module` | string | 小写模块标志，用于筛选与负向记忆指纹。 |
| `audit_type` | 9 值枚举 | `bugfix / delete / shrink / reuse / merge / split / stdlib / native / yagni`。【现状】repo-audit-system.md 与审查提示词模板仍只列 6 值，ai-fixer-system.md 未枚举该字段（§15-G5）。 |
| `created_at` | ISO-8601 含时区偏移 | 初建时间；迭代保持不变。 |
| `updated_at` | ISO-8601 含时区偏移 | 最后一次共享写入时间；插件每次写盘自动维护。 |
| `owner` | string | 当前负责人账号。 |
| `tags` | string[] | 标签数组。 |
| `status` | 4 值枚举 | `pending / changes_requested / approved / rejected`。 |
| `ticket` | string \| null | 关联工单号。 |
| `target_files` | string[] | 当前（最新）版本补丁实际触及的业务文件（仓库相对路径、正斜杠）；必须与最新补丁解析结果一致（I5）。 |
| `current_revision` | 正整数 | 必须等于 `max(revisions[].id)`（I3）。 |
| `revisions[]` | 列表 | 每项：`id`（从 1 连续递增）、`base_revision`、`patch`（文件名）、`author`（`ai` = AI 修复/AI Rebase \| `human` = 人工微调）、未知键保留。 |
| `gate_checks` | string[] | 门禁命令列表；批准时顺序执行；**必须非空**（空列表判定为门禁失败，且候选完整性校验直接报错，见 §6.2）。 |
| `comments[]` | 列表 | 评论：`id`（如 `c1`）、`revision`（针对版本）、行内评论必填 `file`+`line`（正整数）+`side`（`LEFT` 基线侧 / `RIGHT` 补丁侧），总体评论三者皆空且无 `side`；`author`、`content`、`status`（§4.6）、`created_at`。 |
| `human_decisions[]` | 列表 | AI 无法自证、必须由人拍板的决策点：`id`（唯一，I8）、`question`、`note`。 |
| `approval` | object \| null | 批准快照：`approved_by`、`approved_at`、`commit_revision`（原子提交后的 VCS 版本号）、`gate_checks`（批准时生效的门禁快照，必须与当时顶层一致，I7）、`gate_results[]`（每项 `{command, exit_code, duration_ms}`，与快照一一对应且全通过）、`confirmed_decisions[]`（已确认的 `human_decisions[].id` 字符串数组）、`waived_decisions[]`（每项 `{id, reason}`，`reason` 非空）。 |
| `rejection` | object \| null | `rejected_by`（超时归档时为 `system:stale`）、`rejected_at`、`reason`（非空）。 |
| `commit_message` | string | 多行提交信息；**首行必须与 `title` 完全一致**（§4.9）。 |
| `reopened_from` / `reopen_reason` | string \| null | 人工重开字段；二者必须同时出现或同时缺省，出现时 `reason` 非空，`from` 指向真实存在的 `rejected` 候选（I16）。注意键名是 `reopen_reason`（非 `reopened_reason`）。 |

**状态-对象一致性（I6）**：`status == approved ⟺ approval != null`；`status == rejected ⟺ rejection != null`；`approval` 与 `rejection` 互斥。

**时间戳规范（I13）**：所有时间戳为含时区偏移（`Z` 或 `±HH:MM`）的可解析 ISO-8601 字符串；YAML 裸时间对象在解析层规范化为 UTC（Z）字符串。

### 3.4 `review.md` 正文

正文章节供人阅读；插件解析 `# 需人工判断项` 供 UI 高亮。章节：

- `# 问题与影响`、`# 根因`、`# 当前修复方案`、`# 需人工判断项`、`# 验证证据`、`# 审核记录`。
- `# 审核记录` 下每个版本一个 `## 版本 N (base: …)` 小节，含：方案说明、验证结果、人类总体意见、意见处理结果；`id >= 2` 的版本另含 `### 相对上一版的变化`（基线变化 + 逐条对应评论/冲突的调整）。**严禁删改历史版本的审核记录与人类评论原文。**
- 可读性：每节先一句结论再列 2–5 条短要点，每条 ≤ 2 句或 120 字；验证证据严禁粘贴超过 10 行原始日志。
- `# 需人工判断项` 的条目（`- **<短标签>**：<内容>`）由插件解析为 UI 高亮项；确无时整节只写 `- 无`。

### 3.5 补丁文件规则

1. 命名：3 位零填充数字 + `.patch`（初始 `001.patch`）；新版本编号递增，**严禁覆盖或删除历史补丁**；归档（批准/拒绝）时由插件统一清理。
2. 内容：相对该版本 `base_revision` 的全量 Unified Diff（非相对上一版增量）；UTF-8、LF；路径相对仓库根（Git 的 `a/`、`b/` 前缀正常）。
3. 生成：Git 用 `git diff <base> --binary`（新文件先 `git add -N`，但绝不能把 `.ai-review/` 加入索引）；SVN 在基线工作区用 `svn diff`。
4. 补丁不得触及 `.ai-review/` 内任何文件（`patchTouchesReviewData` 校验，含二进制路径与重命名目标）。

### 3.6 审查档案 `audits/<audit_id>/audit.md`（契约）

- **audit_id** = 目录名 = `<YYYYMMDD>-<HHmmss>-<slug>`（本地时间戳，含秒 + slug 限**小写** ASCII `^[a-z0-9][a-z0-9._-]*$`——与候选 slug 允许大小写为**有意差异**，审查档案目录名统一小写便于排序）；时间戳（**精确到秒**，14 位 `YYYYMMDDHHmmss`）必须与 `created_at` 换算的本地时刻一致（I13；源码注释写"分钟粒度"，以实现为准为秒级比较）。
- Frontmatter（YAML 键）：`schema_version: 1`、`audit_id`、`created_at`、`base_revision`、`scope`（仓库相对目录或 `.`；禁止绝对路径/`..`/`./` 前缀/反斜杠/尾斜杠）、`trigger`（`manual | scheduled`）、`previous_audit`（上一档案 id 或 null）、`candidates[]`（本次产出的候选 id）、`items[]`。
- **items[]**（finding 台账）：`finding_id`（`^[a-z0-9][a-z0-9-]{0,63}$`）、`kind`（`confirm` = B 类需人拍板 / `deferred` = 待前置合入）、`title`、`summary`、`target_files[]`、`depends_on`（仅 deferred 必填，I10）、`status`（`pending / converted / dismissed / resolved`）、`candidate`（converted ⟺ 非空，I9）。
- 正文为审查报告（A/B/Deferred 三节 + 验证与说明）；B/Deferred 顶层条目一句话，细节放缩进要点。
- **验证块**：审查报告正文中的 `<!-- ai-review:audit-verification -->…<!-- /ai-review:audit-verification -->` 标记块由审查编排器在收尾时写入/覆盖（upsert：已有标记块则原位替换，否则**追加在报告正文末尾**）：内容为"## 插件复核"章节（复核时间/基线/目标/新增候选数/AI 执行结果/工作区还原状态 + 逐候选校验结论与告警）；Agent 产出的报告原文不得伪造该块。

**【现状】注记（G1，重要）**：运行时审查编排器目前把报告写为**扁平文件** `audits/<YYYYMMDD>-<HHmmss>-<slug>.md`（无 frontmatter）；目录式档案（本节契约）当前没有运行时生产者，仅 `/convert` 等读端与测试使用。详见 §15-G1。

### 3.7 Finding 投影

`projectFindings` 把多份目录式档案的 items 投影为跨档案 finding 视图，规则：

1. **覆盖判定**：item 的 `target_files` 全部落在某档案 `scope` 内（`.` 覆盖一切；空 `target_files` 不被非 `.` scope 覆盖）才算被该档案观察过。
2. **最新观察**：同一 `finding_id` 取 `created_at` 最新的档案；同刻以 `audit_id` 字典序为次序键。
3. **状态映射**（item.status → 投影 state）：

| item.status | 关联候选状态 | 投影 state |
| --- | --- | --- |
| `dismissed` | — | `dismissed` |
| `resolved` | — | `closed` |
| `converted` | `approved` | `closed` |
| `converted` | `rejected` | `reopened` |
| `converted` | `pending` / `changes_requested` / 未知 | `open` |
| `pending`（及其他） | — | `open` |

4. 无效档案（parseError）不参与投影。投影按 `finding_id` 排序输出，供 `/findings` API 与 UI 展示"哪些 B 类/Deferred 还没消化"。

---

## 4. 生命周期与状态机

### 4.1 候选状态机

```text
pending ──提意见──> changes_requested ──AI 新版本──> pending
pending ──批准(门禁全过+原子提交成功)──> approved
pending / changes_requested ──拒绝──> rejected（rejection 留痕，补丁同提交清理）
rejected ──人工重开──> 活跃候选标记 reopened_from（I16；被拒候选保持归档）
```

- 批准途中补丁冲突或门禁失败 → 按 §6.4.2 判定表处理；凡 `FALLBACK_TO_PENDING`，本次批准自动失效，候选回到/保持 `pending` 重新审核。
- 归档候选（`approved` / `rejected`）禁止再写入（除 §4.8 的幂等补填）。

### 4.2 审查分类（audit_type）

9 值：`bugfix / delete / shrink / reuse / merge / split / stdlib / native / yagni`（2026-11-04 由 6 值扩展）。由 AI 在生成候选时声明；驱动队列筛选与负向记忆指纹。【现状】G5：提示词与 assets 契约未同步 9 值。

### 4.3 版本与作者

每个 revision 可标注 `author: ai | human`：`ai` = AI 修复或 AI Rebase（`/rebase`）；`human` = 人工微调（`/manual-revision` 上传人工补丁）。版本号从 1 连续递增（I3）。

### 4.4 本地瞬态（不落盘）

`idle / syncing / validating / ai_fixing / committing` 仅存在于内存与前端 store，表示本机正在执行的操作；共享状态一律以 `review.md` 为准。

### 4.5 人工判断项（human_decisions）

AI 必须把无法自证的取舍（业务语义、架构/性能折中、未覆盖边界）逐条列为 frontmatter `human_decisions`；正文 `# 需人工判断项` 与之呼应。诚实性要求：没有就明确写"无"，禁止编造或凑数。**批准时（§6.4 步骤 2）所有项必须 confirmed 或 waived（waive 带非空理由），否则拒绝批准**——此校验在 host 服务端强制执行。

### 4.6 评论状态（CommentStatus）

- `unresolved`：未处理（人类提出后的初始态）。
- `partial`：AI 自认部分处理——采纳了意见的一部分，或按替代方案处理并说明了理由。
- `resolved`：已完整处理。
- 迁移规则：AI 在生成新版本时可把评论标为 `resolved`/`partial` 并在审核记录中逐条回应；人类（`/comment-status`）可任意改拨三态（例如 AI 自称 `resolved` 但未改对时拨回 `unresolved` 并追加说明）。**严禁删除或篡改人类评论的 id/作者/行号/原文。**

### 4.7 批准快照

批准时把当时生效的 `gate_checks`、逐条 `gate_results`（command/exit_code/duration_ms）、`confirmed_decisions`、`waived_decisions` 写入 `approval`，作为审计证据；`approval.gate_checks` 必须与顶层一致（I7）。

### 4.8 拒绝、超时归档、重开与补填

- **拒绝**：必须留痕（`rejected_by/rejected_at/reason` 非空），补丁文件在同一提交中删除，仅保留 `review.md` 归档。
- **超时归档**：`updated_at` 超过 `stale_days` 的**活跃候选**（status ∈ {pending, changes_requested}）在队列中标记 `isStale`，只提示、不做读时写；人工确认后经 `/archive-stale` 归档，`rejected_by: system:stale`；服务端复核天数（未超期返回 409）；`reviewers.yml` 未配置 `stale_days` 时拒绝归档（409）。
- **人工重开**：`/reopen`（body：`{id, from, reason}`）在目标**活跃候选**上标记重开：写入 `reopened_from = from`（必须指向真实存在的 rejected 候选，服务端校验）与 `reopen_reason`（I16）；被拒候选本身保持归档不被恢复。重开是负向记忆阻止的唯一豁免（§5）。
- **commit_revision 补填**：`approved` 但 `commit_revision` 为空的候选在队列标记 `needsBackfill`；`/backfill` 幂等补填，产生一条仅含 `review.md` 的追加提交，提交信息 `review(<id>): record commit_revision <rev>`。

### 4.9 提交信息（normative）

- **业务原子提交（批准）使用候选的 `commit_message` 全文**（首行与 `title` 一致；空白 `commit_message` 在 §6.4 步骤 3 即被拒绝 `COMMIT_MESSAGE_MISMATCH`。实现中另有 `review(<id>): approve rev N` 的兜底表达式，属防御性分支——仅覆盖门禁执行后、提交前 `commit_message` 被外部清空的极窄竞态，正常流程不可达）。其余 `.ai-review` 元数据提交（评论、接管、评论状态、拒绝、重开、转换、补填等）统一为仅含 `.ai-review/` 文件的独立提交（`commitReviewOnly`），每次共享写操作一条。

---

## 5. 负向记忆

- **事实源**：所有 `rejected` 候选（module + target_files + audit_type + title + rejection.reason）。一切实时计算，**不持久化**。
- **指纹**：`module(小写) | 排序后 target_files(逗号连接) | audit_type | 规范化 title`；规范化 = 去首尾空白、合并连续空白、ASCII 小写。
- **窗口**：`rejection_memory_days`（`reviewers.yml`，默认 30 天），按 `rejected_at` 起算。
- **阻止语义**：窗口内指纹完全相同的活跃候选在队列中标记 `duplicateOf`（指向被拒候选）仍可浏览；**批准被服务端强制阻止**（`/approve` 返回 409）。窗口外只作 few-shot 提示，不阻止。
- **豁免**：frontmatter `reopened_from` **非空**即豁免阻止（当前不校验指向有效性；见 §15-G6）。
- **few-shot**：按 module 取最近 `max_anti_patterns`（默认 20）条被拒记录注入审查/修复提示词。

---

## 6. Host 模块架构

当前实现布局（`src/host/`，实现细节耦合注记）：

```text
index.ts（插件入口/路由注册/审查会话）   api.ts（HTTP API/Job 编排/调度）
settings.ts（应用设置）                  store.ts（ReviewStore/队列/乐观锁）
frontmatter.ts（review.md 解析序列化）    invariants.ts（I1–I16 读端校验）
patch.ts（补丁解析/统计/Hunk 退化）       vcs.ts（Git/SVN 适配器）
validator.ts（门禁执行）                 runner.ts（AI 修复 Runner）
approval.ts（批准编排器）                auditor.ts（仓库审查编排）
audit-archive.ts（审查档案/finding 投影） memory.ts（负向记忆）
reviewers.ts（reviewers.yml 加载/路由）  jobs.ts（后台 Job）
shell.ts（子进程执行/输出截断）          yaml.ts + vendor/js-yaml.ts
```

### 6.1 VCS 适配器

统一 Git 与 SVN，核心层不感知 branch/PR/merge：

1. `ensureCleanWorkspace()`：工作区必须干净（`.ai-review/`、`.tmp/`、`node_modules/` 前缀的改动被接受忽略）；脏则返回脏文件清单。
2. `syncAndGetLatestBase()`：同步远端并返回最新基线。
3. `getCurrentBase()`：当前工作区基线。
4. `applyPatch(patchPath, threeWay)`：批准快速通道 `threeWay=false`（严格原样应用，不允许静默合并掩盖冲突）；AI 修复场景可 `true`。
5. `revertBusinessWorkspace()`：彻底还原业务工作区，保留 `.ai-review/`。
6. `computeInterRevisionDiff(revA, revB, dir)`：版本间增量差异，三种解析模式——`same_base_direct`（同基线直接对比）/ `cross_base_3way_clean`（跨基线，旧补丁三方应用到新基线成功）/ `cross_base_hunk_fallback`（跨基线且冲突，退化为补丁 Hunk 级对比）。【现状】SVN 适配器恒为 hunk 回退模式。
7. `atomicCommit({message, paths, deletePaths?})`：一次提交业务代码 + 更新后的 review.md，并删除已归档补丁。**Git 适配器不执行 push**；撞车判定：Git 为本地锁冲突特征（`index.lock` / `unable to create` / `EACCES` / `EBUSY` 正则），SVN 为真正的远端 out-of-date 检测。

子进程超时统一 180s（`VCS_TIMEOUT_MS`）；VCS 命令输出捕获上限 8 MiB。

### 6.2 门禁执行器（Validator）

- 顺序执行 `gate_checks`，每条命令：仓库根目录、非交互、单条超时 `gateTimeoutMs`（默认 600 000 ms，归一化：>1000 且上限 3 600 000）。
- 结果 `ValidationReport`：逐条 `command / exitCode（超时为 null）/ passed / timedOut / durationMs / outputTail`（命令输出尾部最多 120 行；补丁应用的冲突信息摘要为 80 行截断，属 VCS 层）+ 可直接写回 `# 验证证据` 的 Markdown 摘要。
- **诚实性**：只有实际执行的命令才可写入证据；禁止编造。**空 `gate_checks` 列表判定为门禁失败**（`allPassed = 有结果且全部通过`），且候选完整性校验（`validateCandidate`）对活跃候选的空 `gate_checks` 直接报错"批准前必须定义合并门禁命令"；client 同样在门禁为空时禁用批准按钮——三处一致拦截。

### 6.3 Runner（AI 修复执行器）

- `RunnerKind`：
  - `dsh`（默认）：**headless CLI 子进程**（`dsh --profile headless --json -`），提示词经 stdin 投递，输出按 JSON 事件流解析；默认超时 30 分钟。不创建、不复用交互式 DSH 会话。
  - `manual`：不执行任何进程，返回可复制的修复提示词（`prompt`）交人工处理（`result.manual = true`）。
  - `external`：自定义外部命令（`externalCommand`），可经 host credentials 解析凭据。
- `RunnerMode`：`ADDRESS_FEEDBACK`（响应 changes_requested / ai-fix 生成下一版本）、`RESOLVE_CONFLICT`（批准时冲突/门禁失败的自动修复，输入含未 resolved 评论与失败详情，工作区从干净基线开始）。
- 执行收尾校验（`verifyOutcome`）范围：版本号推进、新补丁文件存在、补丁不含 `.ai-review/` 路径。**工作区还原由调用方无条件执行**（`revertBusinessWorkspace`）；完整 invariants 校验由后续读取路径承担。

### 6.4 批准编排器（ApprovalOrchestrator）

`MAX_COMMIT_RETRIES = 2`（最多 3 次尝试）。每次尝试按序执行，任一步失败即按该步语义返回：

1. **重读 + 乐观锁**：`current_revision` 或 `owner` 与 guard 不符 → `ABORTED / CONCURRENCY_MISMATCH`。
2. **人工判断项覆盖检查**：所有 `human_decisions` 必须 confirmed 或 waived（waive 带非空理由；decisions 来自 `/approve` 请求体的 `confirmedDecisions` / `waivedDecisions`，服务端在进入 Job 前已校验 waive 理由非空）→ 否则 `ABORTED / DECISIONS_UNCONFIRMED`。
3. **提交信息检查**：`commit_message` 非空且首行 == `title`（空白或不一致均 `ABORTED / COMMIT_MESSAGE_MISMATCH`）。
4. **候选完整性校验**（invariants）→ 失败 `ABORTED / INTERNAL_ERROR`。
5. **工作区干净检查** → 失败 `ABORTED / DIRTY_WORKSPACE`。
6. **同步与基线**：`syncBeforeApprove=true`（默认）时先 `syncAndGetLatestBase()`，失败 `ABORTED / INTERNAL_ERROR`；随后取 `getCurrentBase()` 作为本次**批准时生效基线**。`syncBeforeApprove=false` 时直接用本地当前基线。
7. **严格应用当前（最新）版本补丁**（`threeWay=false`）→ 失败则还原工作区并走 §6.4.2 判定表（`PATCH_CONFLICT`）。
8. **执行门禁** → 失败则还原工作区并走 §6.4.2 判定表（`GATE_CHECK_FAILED`）。
9. **再次乐观锁校验**（门禁执行期间候选可能被他人更新）→ 不符 `ABORTED / CONCURRENCY_MISMATCH`（已回滚）。
10. **写 approval 快照 + 原子提交**：提交信息 = `commit_message` 全文，同提交删除历史补丁；撞车（§6.1 第 7 条语义）则还原并进入下一轮重试；重试耗尽或非撞车失败 → `ABORTED / MAX_RETRIES_EXCEEDED`（detail 携带错误）。成功 → `COMMITTED` 并把 VCS 返回的版本号回填 `approval.commit_revision`。

执行前对 review.md 与全部补丁做内存备份（Backup）；AI 修复失败路径恢复备份。批准在后台 Job 中执行（§6.6），界面通过 Job 日志跟踪。

#### 6.4.2 冲突/门禁失败的回退判定表（fixOrFallback）

前置：`reason ∈ {PATCH_CONFLICT, GATE_CHECK_FAILED}`，工作区已还原。

| 条件 | 结果 |
| --- | --- |
| `autoFixOnFailure = false` | `FALLBACK_TO_PENDING`（reason 同上，**无** newRevision；候选保持 pending，提示自动修复已关闭） |
| Runner 为 `manual` | `FALLBACK_TO_PENDING`（无 newRevision；message 附带手动修复提示词） |
| Runner 执行成功 | `FALLBACK_TO_PENDING`（`newRevision` = 新版本号；AI 已生成下一版本） |
| Runner 执行失败/异常 | `ABORTED / RUNNER_FAILED`（恢复备份；message 附失败详情与输出尾部） |

即：`PATCH_CONFLICT` 与 `GATE_CHECK_FAILED` 在实践中只作为 `FALLBACK_TO_PENDING` 的 reason 出现；`ABORTED` 的 reason 实际取值集合为 `{CONCURRENCY_MISMATCH, DECISIONS_UNCONFIRMED, COMMIT_MESSAGE_MISMATCH, INTERNAL_ERROR, DIRTY_WORKSPACE, MAX_RETRIES_EXCEEDED, RUNNER_FAILED}`（类型上的 `NOT_CONFIGURED` 由 API 层以 412 抛出，不由编排器返回）。

#### 6.4.3 Job 映射

批准作为 `approve` Job 执行：task 正常返回任何 `ApprovalOutcome` → job `succeeded`，outcome 存于 `job.result`；仅当 task 抛出异常 → job `failed`。

### 6.5 仓库审查编排（Auditor）

- **触发**：手动（面板 / `POST /audit`）或定时（§6.6）。
- **目标归一化**：`normalizeAuditTarget` 把用户输入归一为 scope 路径；扫描跳过 `node_modules/`、`.git/` 等。
- **两种执行形态**：
  - **DSH 会话模式**：`createDshAuditSession` 通过 host `sessionController` 创建真实 DSH 会话（挂到 cwd 所属 workspace → 命名 → 以 queue 模式投递审查提示词，60s 接受超时）。**权限继承**：新会话优先继承发起会话的权限预设；预设不可继承时回退为继承其审批策略覆盖——避免审查跑门禁时卡在无人值守的审批提示上。定时触发的审查不继承权限（无发起会话）。
  - **手动模式**：返回组装好的审查提示词（`GET /audit/prompt`），交给任意外部 Agent。
- **提示词**：系统提示词 = [repo-audit-system.md](assets/repo-audit-system.md)（正交性铁律、A/B/Deferred 分流、review.md 严格 schema、pre-exit 自检）+ owner 路由指引块 + 按 module 注入的负向记忆 few-shot（§5）+ 目标范围/基线/输出路径。超时上限 1 小时（`AUDIT_TIMEOUT_MS`）。
- **收尾校验**：扫描磁盘产出——每个 A 类候选做插件侧强校验（frontmatter 合法、status=pending、rev1、approval=null、基线与当前一致、补丁可干净应用等；错误写入 `AuditCandidateResult.errors`，非空即需人工处理）；解析审查报告抽取 B 类（confirm）与 Deferred 条目；验证块 upsert（§3.6）。
- **finding 转候选**：`POST /convert` 把一个 confirm/deferred finding 与**已存在**的候选绑定（要求传入该候选的 candidateId）：item 置 `converted` 并回填 `candidate`；**不生成 review.md 骨架**。前置条件：`depends_on` 指向的依赖 finding 已 `resolved`，或已 `converted` 且其候选 `approved`；否则拒绝。
- **【现状】G1**：收尾产物为扁平报告文件，未写目录式档案（§3.6/§15-G1）。

### 6.6 Job、调度与互斥

- **JobManager**：类型 `approve / ai_fix / audit / reject / feedback`；状态 `running / succeeded / failed`（§6.4.3）；最多保留 40 个（超出时优先淘汰**最早开始**的已完成 job），单 job 日志 4000 行；`GET /jobs` 列表、`GET /jobs/:id?since=` 支持增量日志（logOffset/totalLogLines）。
- **repo 互斥锁**：共享写操作（comments/takeover/reject/reopen/convert/…）经 `withRepoLock`/`withWriteLock` 单进程串行化。
- **定时审查**：`scheduleIntervalMinutes`（默认 0 = 关闭）；host 未提供 `createAuditSession` 时不启动；任一 job 运行中、工作区脏或无基线时本次静默跳过；插件卸载时 `stopScheduler`。
- **互斥规则**：audit 运行中禁止 approve / ai-fix / rebase / manual-revision / sync（`ensureNoAuditRunning`）；audit 与 `/audit/session` 要求无任何运行中 job。
- **rebase**：`POST /rebase` 以 `ai_fix` Job 由**插件自身**（非 Runner）在新基线上重建当前版本补丁：读取当前基线 → 基线未变则 ABORTED（无需 Rebase）→ 工作区必须干净 → 以 three-way 在新基线应用当前补丁 → 重跑门禁 → 全部通过才以新 `base_revision` 追加 revision（`author: ai`，补丁内容沿用原全量补丁）并以 `review(<id>): rebase to <base> (rev N)` 提交 `.ai-review`。任一步失败（无基线/基线未变/脏工作区/Rebase 冲突/门禁失败/提交失败）→ `ABORTED`（message 附原因），**不产生新版本**，工作区已还原；返回 202 `{jobId, job}`。

### 6.7 会话级仓库解析与设置

- `repoRoot` 为空不等于不可用：API 优先以请求参数中的会话（sessionId）解析该评审页所属会话的 cwd 作为仓库根（`resolveSessionCwd`），每请求解析并缓存（上限 8 个仓库）；仍无法解析时返回 412 `not_configured`。
- 应用设置见 §8。

---

## 7. HTTP API

前缀 `/dsh-code-review/api`，JSON，`cache-control: no-store`，请求体上限 2 MiB（超限按 bad_request 拒绝）。错误统一 `ApiError { status, code, message, details }`，code ∈ `bad_request / not_configured / not_found / stale / forbidden / conflict / internal`；典型映射：乐观锁不符 → 409 `stale`；未配置 → 412 `not_configured`；重复阻止（§5）→ 409 `conflict`；请求体超限 → `bad_request`。（`forbidden` 当前在运行时未使用——owner 隔离现状见 §9.2 与 §15-G8。）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 应用/版本/配置状态/当前基线/诊断/队列计数。 |
| GET | `/settings` | 设置 + validation + suggestedOwner + 可用 runners。 |
| PUT | `/settings` | 保存设置（原子写落盘）。 |
| GET | `/queue` | 队列；筛选参数 `owner / statuses / tag / dir / text / createdAfter / createdBefore`；owner 默认当前用户，statuses 默认全部。 |
| GET | `/candidate?id=` | 单候选详情（frontmatter + 正文章节 + 人工判断项 + parseError）。 |
| GET | `/patch?id=&name=` | 指定补丁原文（`name` = 补丁文件名，如 `001.patch`）。 |
| GET | `/diff?id=&from=&to=` | 版本间增量差异（resolutionMode + notes）。 |
| GET | `/fix-prompt?id=` | manual runner 的修复提示词。 |
| GET | `/audit/prompt` | 手动审查提示词。 |
| POST | `/audit/session` | 创建 DSH 审查会话（权限继承；要求无运行中 job）。 |
| POST | `/audit` | 启动仓库审查（audit Job）。 |
| POST | `/comments` | 追加评论（乐观锁；独立 .ai-review 提交）。 |
| POST | `/comment-status` | 更新评论处理状态（乐观锁）。 |
| POST | `/takeover` | 接管审核（唯一允许非 owner 的共享写操作；乐观锁）。 |
| POST | `/reject` | 拒绝候选（补丁同提交清理；乐观锁）。 |
| POST | `/archive-stale` | 超时候选归档（`system:stale`；服务端复核天数）。 |
| POST | `/reopen` | 人工重开（在活跃候选上标记 `reopened_from` 指向被拒候选，I16；body：`{id, from, reason}`）。 |
| POST | `/convert` | finding 与已存在候选绑定（§6.5 前置校验）。 |
| POST | `/rebase` | AI Rebase（ai_fix Job，§6.6）。 |
| POST | `/manual-revision` | 上传人工微调补丁为新版本（`author: human`）。 |
| POST | `/backfill` | 幂等补填 `approval.commit_revision`。 |
| POST | `/approve` | 批准并提交（approve Job；§6.4）。body：`{id, expectedRevision, expectedOwner, confirmedDecisions: string[], waivedDecisions: [{id, reason}]}`——decisions 即 §6.4 步骤 2 的人工判断项处理记录，waive 缺 `reason` 返回 400；通过重复阻止检查（§5）后返回 202 `{jobId, job}`。 |
| POST | `/ai-fix` | 唤起 Runner 生成下一版本（ai_fix Job）。 |
| POST | `/sync` | 同步远端与队列。 |
| GET | `/jobs` | 后台任务列表。 |
| GET | `/jobs/:id?since=` | 任务详情 + 增量日志。 |
| GET | `/reviewers` | reviewers.yml 解析结果。 |
| GET | `/audits` | 审查档案列表（目录式）。 |
| GET | `/findings` | finding 投影（§3.7）。 |
| GET | `/client-entry` | client bundle 入口定位。 |

---

## 8. 应用设置（AppSettings）

持久化于 `DSH_HOME/dsh-code-review/settings.json`（临时文件 + rename 原子写；读取失败回退默认值）：

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `repoRoot` | string，默认 `''` | 目标仓库根目录；空时按会话 cwd 解析（§6.7）。 |
| `owner` | string，默认 `''` | 当前审核员账号（保存时校验非空）。 |
| `vcsType` | `auto / git / svn`，默认 `auto` | 保存时与实际仓库校验一致性。 |
| `baseBranch` | string，默认 `''` | 主干分支名。 |
| `runner` | `dsh / manual / external`，默认 `dsh` | Runner 形态（§6.3）。 |
| `dshCommand` / `externalCommand` | string，默认 `''` | Runner 命令行。 |
| `autoFixOnFailure` | boolean，默认 `true` | 批准失败时是否自动唤起 AI 修复（§6.4.2）。 |
| `gateTimeoutMs` | number，默认 `600000` | 单条门禁超时；归一化 >1000，上限 3600000。 |
| `syncBeforeApprove` | boolean，默认 `true` | 批准前是否同步远端。 |
| `scheduleIntervalMinutes` | number，默认 `0` | 定时审查间隔（分钟）；0 = 关闭。 |

注意：`stale_days / rejection_memory_days / max_anti_patterns / allowed_gate_commands` 属于**仓库级**配置（`reviewers.yml`，§3.2），不在应用设置内。

---

## 9. 并发、安全与错误处理语义

### 9.1 并发控制

- **乐观锁（跨机）**：所有共享写操作携带 `expectedRevision + expectedOwner`；与磁盘最新值不符 → 409 `stale`，客户端应刷新后重试。这是多客户端/多主机防覆盖的主机制。
- **repo 锁（单进程）**：`withRepoLock` 串行化本进程内的共享写，避免并发写坏 `.ai-review/`；锁内操作排队执行而非失败。
- **多主机限制**：两台主机同时操作同一仓库时，正确性依赖乐观锁 + VCS 工作区互斥；**未提供分布式锁**，同时 approve 可能互相污染对方工作区（已知边界，见 §15-G7）。
- **原子提交语义**：`atomicCommit` 为本地提交；Git 不 push（推送由人执行）。提交成功但后续步骤失败的窗口由 Backup/restore 与幂等补填（§4.8）兜底。

### 9.2 安全与授权

- API 由 DSH host 内嵌 web server 提供，仅在同机 Web GUI 上下文可达；无独立鉴权层（信任边界 = DSH 用户本人）。
- **Owner 隔离（目标契约 vs 现状）**：目标契约为服务端强制——非 owner 的共享写操作被拒绝，唯一例外 `/takeover`；UI 只读模式是同一约束的展示层。**【现状】G8**：服务端 `ensureWriteAllowed` 目前只校验乐观锁与归档状态，不比较请求者与 owner（`guard.expectedOwner` 由客户端自报，非 owner 照抄即可通过），owner 隔离实际仅由 client `canAct` 展示层承担；`forbidden` 错误码已定义但零使用。
- **路径安全**：候选 id/scope/文件路径均做仓库相对路径校验（禁 `..`、反斜杠、绝对路径），并经 `ensureInside` 目录包含校验。
- **门禁命令执行**：在用户自己的仓库、以用户自己的 DSH 权限运行；`allowed_gate_commands` 白名单未命中时要求 UI 二次确认（【现状】G4）。

### 9.3 错误处理与边界

- `review.md` YAML 解析失败：候选以 `parseError` 进入队列（broken），不参与批准/投影/负向记忆；人工修复文件后自动恢复。
- 编码：文件按 UTF-8 读取（BOM 与 CRLF 在解析层归一）。
- 空 `gate_checks`：判定为门禁失败，不允许批准（§6.2，validator / 完整性校验 / client 三重拦截）。
- Job 失败语义：见 §6.4.3；API 同步端点失败直接返回 `ApiError`。

---

## 10. Client（Web 面板）

规范布局（决策流自上而下）：

1. **队列页**：默认筛选 `owner = 当前用户`（statuses 默认全部）；卡片显示 ticket/title/rev、`+x/-y · n files`、人工判断项徽标（琥珀色）、基线状态（最新/落后，落后时提示批准将在新基线重放）、未解决评论数、本地瞬态进度。无批量批准，仅整卡点击进详情。
2. **详情页**：
   - 顶部：乐观锁过期红色横幅（版本/owner 变化 → 草稿锁定 + 加载最新）；粘性头（title/ticket/status/版本切换/接管按钮）。
   - **Owner 只读隔离**（client `canAct` 展示层；服务端强制现状见 §15-G8）：非 owner 只读，仅可 `[接管审核]`（`/takeover` 后解锁）。
   - 决策流：问题与方案 → 人工判断项高亮卡（逐项确认勾选，全部处理才解锁批准按钮）→ 门禁命令与验证证据 → 代码差异（全量/版本增量切换、跨基线三态提示条、文件树、行内评论 LEFT/RIGHT）→ 历史版本记录。
   - 底部操作坞：总体意见 + `[批准并提交]` + `[提出改进意见]` + `[放弃]`（必填原因）。
3. **批准进度**：批准以 Job 执行，UI 呈现四步说明（干净检查→同步→应用补丁+门禁→原子提交）并轮询 `/jobs/:id` 日志流。
4. **瞬态草稿**：未提交的总体意见/行内评论只存前端内存。

**【现状】注记（G2，重要）**：当前 client 未实现 stale/duplicate/needsBackfill 徽标、waive 输入、`/archive-stale` `/reopen` `/backfill` `/manual-revision` `/rebase` `/convert` `/ai-fix` `/sync` `/audits` `/findings` 的入口；`/approve` 请求目前只发送 `{id, guard}`，人工判断项勾选仅在本地解锁按钮、`confirmed/waived` 不上行——因此 `human_decisions` 非空的候选从 UI 发起批准必然 `DECISIONS_UNCONFIRMED`（且 UI 勾选数据源为正文解析项，与 frontmatter 项未打通）。详见 §15-G2。

---

## 11. AI Agent 契约要点（摘自 assets，详情以原文为准）

### 11.1 AI Fixer（ai-fixer-system.md）

- 最小侵入、工作区还原、机器字段零误差、诚实暴露边界、门禁可复现。
- Mode A 初始生成 / Mode B 意见迭代（更新评论状态、追加版本记录与审核记录，严禁删改历史）/ Mode C 批准前冲突或门禁修复。
- Pre-Exit Self-Check：补丁可在基线干净应用、YAML 合法且版本对应、门禁实际跑过、需人工判断项诚实填写、工作区彻底还原。

### 11.2 仓库审查 Agent（repo-audit-system.md）

- 优先级正确 > 安全 > 稳定 > 测试 > 性能 > 精简；先绘地图；必须有具体案例；本质修复优先删除代码；不确定降级 B 类。
- **正交性铁律**：所有候选独立基于同一基线；互不重叠拆分并还原基线；同处耦合合并；跨模块强依赖 Defer。
- 输出：候选包 + 审查报告（A/B/Deferred 三节，B 类必须含位置/风险/需要决定）。
- 默认严禁 commit；仅当用户提示词明确要求"提交 `.ai-review`"时只提交 `.ai-review/`。

**【现状】G5**：assets 两份契约与审查提示词模板中的 `audit_type` 仍为 6 值，与 §4.2 的 9 值不同步；需同步更新 assets 文档与提示词模板。

---

## 12. 插件集成（DSH Host）

- `inject: ['webServer']` 硬依赖；注册 prefix 路由 `/dsh-code-review/api`；初始化失败时路由返回 500 + 诊断。
- Client bundle 经 `dsh.client`（platform: web, immediately: true）注入；locale（zh/en）+ icon 随包分发。
- 审查会话创建依赖 host `sessionController`（create → rename → prompt），并按路径解析 workspace 挂载；权限预设/审批策略从发起会话继承（§6.5）。
- 凭据解析经 host `credentials` 服务（如外部 Runner 命令需要 token）。

---

## 13. 不变量总表（I1–I16，读端校验）

违反者标记 broken：不参与批准、投影与负向记忆，UI 显示 parseError。校验时机分三处：review 候选的快校验（quick，仅凭 review.md）覆盖 I1–I3、I6–I8、I11–I13、I16 结构形态，全校验（full，需文件系统/补丁上下文）补充 I4、I5 与 I16 引用存在性及指向状态（被指向候选必须为 rejected；I16 指向校验回调当前未接线，读端实际只拦结构形态，见 §15-G9）；audit 档案的不变量（I1 的 audit 部分、I9、I10、I13 的 audit_id 一致性）在**档案读取端**校验（`auditInvariantErrors`），无效档案不参与 finding 投影。

| # | 不变量 |
| --- | --- |
| I1 | 候选目录/审查目录命名与 id 格式合法（月份 `YYYY-MM`；slug 限 ASCII；audit_id 与目录名一致）。 |
| I2 | `schema_version == 1`。 |
| I3 | 版本号从 1 连续递增、唯一；`current_revision == max(id)`。 |
| I4 | 活跃候选每个 revision 的补丁文件**存在**（读端仅校验存在性；"可在基线干净应用"由 Auditor 对新产出候选检查，队列读取路径不做 apply 检查）。归档候选豁免。 |
| I5 | `target_files` 与当前补丁实际触及文件一致（声明非空且非归档时强制）。 |
| I6 | status 与 approval/rejection 一致且互斥；rejection 的 by/at/reason 非空。 |
| I7 | `approval.gate_checks` 快照 == 批准时顶层 gate_checks；gate_results 一一对应且全通过。 |
| I8 | `human_decisions[].id` 唯一；批准时全部 confirmed 或 waived（waive 带理由）。 |
| I9 | audit item：converted ⟺ candidate 非空。 |
| I10 | deferred 必有 depends_on；confirm 必无。 |
| I11 | 评论引用的版本存在；行内评论 file/line/side 齐备且为仓库相对路径；总体评论无 side。 |
| I12 | `target_files` 全为仓库相对路径。 |
| I13 | 所有时间戳为含时区偏移的可解析 ISO-8601；audit_id 的 14 位时间戳与 created_at 换算的本地时刻**精确到秒一致**。 |
| I14 | 未知 frontmatter 键（含嵌套对象内）原样保留，永不截断。 |
| I15 | （编号保留未使用。） |
| I16 | `reopened_from`/`reopen_reason` 同时出现或缺省；出现时 reason 非空，from 指向存在且为 rejected 的候选。**【现状】**指向存在性/状态校验运行时只在写端 `/reopen` 执行；读端全校验的 `reopenedTargetRejected` 回调当前未接线（仅测试传入，见 §15-G9），故读端只拦结构形态。 |

（I14 为序列化/写盘行为——未知键在每次读-写往返中原样保留——而非读端校验，故不列入 quick/full 时机。）

---

## 14. 测试策略

- `npm run typecheck`：host + client 双 tsconfig。
- `npm test`：build 后 `node --test`：
  - `contract-p1 … p9p10`：按契约编组的核心回归（frontmatter/不变量/记忆/投影/批准流等）；
  - `contract-fixes`：契约修复回归；
  - `audit-core / audit-api / session / patch / vcs / human-judgment / client-bundle`；
  - fixtures：`fake-audit-agent`（合法候选）、`invalid-candidate-agent`（非法候选被插件侧校验拦截）、`fail-audit-agent`、`report-only-agent`。
- `npm run verify:audit`：审查会话端到端校验脚本。

---

## 15. 已知差距与演进（【现状】登记，修正后删除）

| # | 差距 | 影响 | 方向 |
| --- | --- | --- | --- |
| G1 | 目录式审查档案（§3.6）无运行时生产者：Auditor 实际写扁平 `audits/<stamp>-<slug>.md`（无 frontmatter），`/audits`、`/findings`、`/convert` 只读目录式档案。 | 真实审查跑完后产物对档案读端不可见。 | Auditor 收尾改为产出目录式 audit.md（items 台账由报告解析填充）。 |
| G2 | Client 批准链路：服务端 `/approve` 已支持 `confirmedDecisions`/`waivedDecisions` 参数（§7），但当前 client 不上行（只发 `{id, guard}`）、勾选仅本地解锁；且 UI 勾选数据源为正文解析项，与 frontmatter `human_decisions` 未打通；多个端点无 UI 入口（§10）。 | `human_decisions` 非空的候选无法从 UI 批准（服务端契约本身完整，可经 API 直接调用）。 | client 上行 decisions 并打通数据源；UI 徽标与入口补齐。 |
| G3 | `resolveOwner()` 运行时未被调用，owner 路由靠提示词指引。 | 路由为约定而非强制。 | 在候选创建/收尾校验路径接入服务端路由复核。 |
| G4 | `allowed_gate_commands` 白名单的 UI 二次确认未实现。 | 未命中白名单的门禁无额外确认。 | Client 补齐确认交互。 |
| G5 | `audit_type` 9 值未同步到仓库审查契约与审查提示词模板：repo-audit-system.md 与 auditor 提示词模板仍为 6 值；ai-fixer-system.md 则完全未枚举 audit_type。 | Agent 可能产出旧枚举或缺失该字段。 | 同步 repo-audit-system.md、auditor 提示词模板，并在 ai-fixer-system.md 补充 9 值枚举。 |
| G6 | 负向记忆豁免只查 `reopened_from` 非空，不校验指向的候选是否真实 rejected。 | 理论上可伪造豁免。 | 豁免前执行 I16 引用校验。 |
| G7 | 无分布式锁；多主机并发 approve 依赖乐观锁 + VCS 互斥，存在工作区互污窗口。 | 单用户单机场景可接受。 | 如需多机，引入仓库级锁文件。 |
| G8 | 服务端 owner 隔离未实现：`ensureWriteAllowed` 只校验乐观锁与归档状态，不比较请求者与 owner（`forbidden` 错误码零使用）；owner 隔离仅由 client `canAct` 展示层承担。 | 自报 guard 的非 owner 请求可通过 API 绕过只读隔离。 | 在共享写端点补齐 `expectedOwner == meta.owner`（或当前用户）服务端校验并使用 `forbidden`。 |
| G9 | 读端全校验未传入 `reopenedTargetRejected` 回调：I16 的指向存在性/状态校验运行时只在写端 `/reopen` 执行，队列读取路径不拦指向非法的 `reopened_from`（仅测试覆盖该回调）。 | 外部手改的 review.md 可携带指向不存在/非 rejected 候选的重开字段进入队列而不被标记 broken。 | 在队列 full 校验处接入回调（复用 store 内已有的候选索引）。 |
| — | Schema 演进：当前仅 `schema_version: 1`；未来升版策略 = 未知键保留（I14）+ 读端兼容旧数据 + 开发期数据不迁移。 | — | 到 v2 时补充迁移规范。 |

---

## 16. 代码注释 § 编号对照表

源码注释沿用了设计讨论期的 § 编号体系；其含义以本文对应章节为准：

| 代码注释引用 | 本文对应章节 |
| --- | --- |
| §2.2 / §2.3（时间戳与 updated_at） | §3.3 |
| §3 / §3.4（审查档案、finding 投影） | §3.6 / §3.7 |
| §4.2–§4.9（review.md 字段语义） | §3.3、§4 |
| §5（reviewers.yml 治理配置） | §3.2 |
| §6.1（设计讨论期编号，两处含义：定时审查见 api.ts 调度；"创建档案前校验目录不存在"见 audit-archive.ts，属 §3.6 档案写入前置检查） | §6.6 / §3.6 |
| §6.2（B/Deferred finding 转候选，api.ts） | §6.5（`/convert`） |
| §6.4 / §6.5（人工微调与 Rebase 的版本追加，api.ts / store.ts） | §6.6（`/manual-revision`、`/rebase`）、§4.3 |
| §7 / §7.2–§7.6（负向记忆） | §5 |
| §8（设计讨论期编号，两处含义：检出级写互斥见 api.ts 审计会话与写端点；"§8 规则 6"见 store.ts / approval.ts——每次共享写更新 `updated_at`、回填不改 `updated_at`） | §6.6 / §3.3（`updated_at`）、§4.8（补填） |
| §10（开发期数据不迁移） | §3.1 |
| §13.1 / §13.2（review / audit 不变量） | §13 |
| §18.1（stale 只提示） / §18.2（reviewers 解析结果注入提示词） / §18.4（audit_type 扩展） / §18.6（重开字段） / §18.8（commit_revision 补填；含检出级写互斥引用） | §4.8 / §6.5 / §4.2 / §4.8 / §4.8、§6.6 |
| I1–I16 | §13 |
