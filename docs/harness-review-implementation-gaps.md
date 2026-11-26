# 当前实现与新版 SPEC 的差距清单

> **文档用途**：对照 2026-11-26 定稿的唯一权威规格 [SPEC.md](../SPEC.md)，用通俗易懂的语言说明「目前代码已经做好了什么」「还有哪些地方没对齐」「为什么要改」以及「怎么改、怎么验收」。
> **核验基准**：实现代码基于提交 `2a6f55e`；规格基于 2026-11-26 新版 [SPEC.md](../SPEC.md)（首版正式契约，统一 `schema_version: 1`，无任何历史格式包袱）。
> **本次范围**：仅同步修订本差距清单，不修改业务代码；代码改造需按 [AGENTS.md](../AGENTS.md) 在独立 worktree 分支中完成。

---

## 1. 一句话看懂现状

先说两个贯穿全文的基础概念：
- **完整 Harness**：让 AI 自己调用读文件、搜索、执行命令等工具开展多轮调查（而不是程序提前截取几段源码拼进提示词做单轮问答）。
- **三种 AI 产码模式**：**Mode A**（审查出初始补丁/文字方案）、**Mode B**（人审前按评论改补丁或 Rebase，改完仍待人审）、**Mode C**（人审批准后程序打补丁冲突，唤起 AI 在完整权限下辅助落地或分支合并）。

经过上一轮改造，**系统的大骨架已经跑通了**：多阶段审查、共享工作目录、单问题多方案补丁（如 A 用 `001.patch`、B 用 `002.patch`、修订 A 追加 `003.patch`）、程序性三方合并、批准后保留补丁、以及门禁失败还原不重试，这些核心基础都已有代码和专项测试支撑。

但对照最新定稿的 [SPEC.md](../SPEC.md)，当前实现还有 **12 处差距（4 处高优先级 P1、8 处中优先级 P2）**，外加 **1 项真机模型实测（R01）尚未补齐**。相比早先清单，2026-11-26 新对齐的 5 项核心变化已全部反映到下文：
1. **零旧格式包袱**：本项目从未正式发布，不再保留任何 v1/v2 读写兼容、废弃端点或 `expectedFindingVersion`，统一精简为单一格式 `schema_version: 1` 与统一并发守卫（见 D12）；
2. **去掉门禁白名单拦截**：不再用 `allowed_gate_commands` 卡死补丁产出或批准，批准面板直接明文展示所有待执行门禁命令（见 D04）；
3. **审查阶段采用「软引导 + Host 强还原」策略**：不靠沙箱硬拦项目目录写入，提示词引导优先在 `.ai-review/` 和 `.tmp/` 工作、允许必要取证，由 Host 在结束与收尾前强制确认停止并彻底还原非 `.ai-review/` 改动（见 D06、D11、R01）；
4. **获批辅助应用（Mode C）不限制 Harness 权限**：允许编辑业务、分支合并乃至必要 `push`（仅禁改 `.ai-review/`），由 Agent 申报是否实质改了方案 + Host 物理拓扑硬护栏决定直接门禁落地还是导出新补丁回人审（见 D01）；
5. **外部 Agent 优先，本 Harness 子代理兜底**：Codex / Claude Code 可用时优先调起增强审查效果，调不起时优雅降级给本 Harness 自身独立子代理，不卡死审查或自检（见 D11、R01）。

---

## 2. 七项核心设计的完成度总览

| 核心设计 | 目前已经做好的基础 | 还没对齐的地方（对应编号） |
| --- | --- | --- |
| **1. 总调度委派独立阶段 + 完整 Harness + 子代理降级** | 阶段执行通道、独立上下文、共享项目 cwd 已建好，已去掉旧的源码视图裁剪 | 外部 Agent 调不起时缺少自动降级到本 Harness 子代理的配置与自检；定时审查还有旧历史复查旁路；真机实测未补（D10、D11、R01） |
| **2. 共享 cwd、「软引导 + Host 强还原」** | 主审查的归档还原、进程树清理和停止核验已有基础测试 | 交互式 `/fix-session` 缺并发守卫、状态校验、持久占用和结束还原核验；旧权限桥仍按硬拦写目录思路编写（D06、D11） |
| **3. 交付 1–2 个补丁或完整文字方案，审查不应用** | 常规审查采用只读预检、不应用补丁；纯文字问题已能表达 | 缺 `reviewers.yml` 时没在开跑前拦住且缺初始化接口；旧白名单仍在拦补丁；Deferred 依赖写入时丢了（D03、D04、D07） |
| **4. 唯一问题记录 + 不可变补丁账本** | 单 `review.md`、最多 2 方案、补丁递增编号、批准保留补丁已实现 | 跨轮 `optionId` 查得太晚；缺 `issue_kind`/`depends_on`/`approval_history` 且 `module` 被硬编码；`sha256` 未强制、时间可能倒退；仍背着 v1/v2 与 `schema_version: 3` 历史包袱（D02、D07、D08、D09、D12） |
| **5. 人审后程序优先，Mode C 辅助放开权限** | 程序严格应用、确定性三方合并、显式选方案批准已有实现 | 程序失败唤起 Agent 时，代码仍强行当成“只出新提案”模式，没实现完整权限辅助应用与物理拓扑硬护栏直通门禁（D01） |
| **6. 门禁通过直接关闭；失败还原封禁待人工** | 常规批准门禁失败会还原业务、写 `repair_failed` 记录且不调 Agent | `repair_failed` 缺失败补丁永久封禁与完整状态机，存在绕过与死锁；UI 缺失败页正确入口；定时审查还会回头查已 `approved` 问题（D05、D10） |
| **7. 外部人工接手、完成反馈、代码证据关闭** | `human_takeover → awaiting_verification → resolved` 主路径已有测试 | `accept_as_is` 未同步置 `rejected`/`rejection` 与符号提取；`human_takeover` 缺放弃出口；提案入口未排除接手/待核验状态（D05、D06） |

---

## 3. 待修复的 12 项具体差距

### 差距总览速查表

> 说明：编号 `D01–D12` 沿用首轮代码审计序，下文正文按 **P1（高优先）→ P2（中优先）** 分组展开，方便按实施顺序查阅。

| 编号 | 级别 | 所属模块 | 一句话问题 | 建议阶段 |
| --- | --- | --- | --- | --- |
| D12 | **P1** | 协议 / API / 存储 | 仍停留在 `schema_version: 3` 并残留 v1/v2 兼容、废弃端点与 `expectedFindingVersion` | 第 1 步 |
| D01 | **P1** | 批准 / Runner | 程序应用受阻时，Mode C 被强行当成重新出提案，无法完整权限辅助并直通门禁 | 第 2 步 |
| D06 | **P1** | 提案会话 / 锁 | `/fix-session` 缺完整并发守卫、状态校验、持久占用与结束还原核验 | 第 2 步 |
| D02 | **P1** | 审查阶段 / 发布 | 跨轮修订 `optionId` 到发布时才检查，错产物会占死 2 个方案名额 | 第 3 步 |
| D07 | **P2** | 问题记录 / 发布 | 丢了 `Deferred` 依赖、缺新 Frontmatter 字段，且新建问题把 `module` 写死为 `'audit'` | 第 1 步 |
| D08 | **P2** | 校验 / 序列化 | 发布 `updated_at` 可能倒退、`patches[].sha256` 未强制校验、键序未统一 | 第 1 步 |
| D04 | **P2** | 审查 / 门禁 | 已废弃的 `allowed_gate_commands` 白名单仍在硬拦截正常补丁生成与发布 | 第 1 步 |
| D05 | **P2** | 状态机 / 两端 UI | `accept_as_is` 写盘不全、`repair_failed` 缺永久封禁与防死锁流转、失败页缺入口 | 第 2 步 |
| D03 | **P2** | 配置 / 审查入口 | 缺 `reviewers.yml` 未在审查启动前拦截，且缺少一键初始化接口 | 第 3 步 |
| D09 | **P2** | 队列读模型 | 队列只预检默认方案未分方案显示，且 `counts` 缺少 4 个新状态计数 | 第 3 步 |
| D10 | **P2** | 定时审查 | 进程式定时审查仍有旧历史旁路，会回头复查已 `approved` 关闭的问题 | 第 3 步 |
| D11 | **P2** | 提示词 / 自检 | 提示词残留旧副本描述；自检未接入“外部优先 + 本 Harness 子代理兜底”与新格式验证 | 第 4 步 |

---

### 高优先级（P1）— 直接影响核心主流程与架构边界

#### D01 · P1 · 获批后 Agent 辅助应用（Mode C）被强制当成了“重新出提案”
- **对应规格**：[SPEC.md](../SPEC.md) §0.2、§5.4、§5.5、§7.3；`AC-REPAIR-ASSIST`
- **现在代码怎么干的**：
  - [runner.ts](../packages/dsh-plugin/src/host/runner.ts) 第 111 行把所有请求塞进同一套提案分支，不区分 Mode B（人审前改提案）与 Mode C（人审后解冲突落地）；
  - [ai-proposal-system.md](../packages/dsh-plugin/assets/ai-proposal-system.md) 第 10 行一刀切禁止修改业务源码和执行 VCS 操作；
  - [approval.ts](../packages/dsh-plugin/src/host/approval.ts) 第 942–963 行在冲突后调起 Runner，但 `finally` 无条件还原了业务工作区，第 1105 行直接返回 `FALLBACK_TO_PENDING`，逼着人重审一遍。
- **会导致什么坑**：哪怕冲突只是几行上下文微调、完全没改原方案意图，Agent 也帮不上忙，更没法做分支合并；用户点完批准还是会被踢回“重新审核”。
- **按新版 SPEC 应该怎么改**：
  - 彻底拆分 Mode B 与 Mode C；Mode C **不额外限制 Harness 权限（允许修改业务、分支合并乃至必要 `push`）**，仅禁止修改 `.ai-review/`；
  - 要求 Mode C 输出结构化 JSON（`verdict: equivalent | material_change`、`summary`、`gitActions`），Host 根据进入前快照 `(preHead, preBranch, preRemoteTip, approvedPatchPaths, preAiReviewDigest)` 按物理状态分流：
    - 净改动非空且全部落在所选补丁原文件集合 `approvedPatchPaths` 内（分支合并自动排除上游父提交未二次修改的文件）、未碰 `.ai-review/` 与禁止路径且声明 `equivalent` → 直接进步骤 8 门禁（未推送走单次原子提交/amend，已推送则创建关闭提交并写 `approval.business_commit`）；
    - `material_change` 或仅业务文件越界（未推送）→ **先**导出新补丁、**再**还原业务工作区并提交 `.ai-review/` 回 `pending` 重审；
    - 触犯禁止路径/篡改 `.ai-review/`/非法 JSON → 还原并报 `ABORTED / RUNNER_FAILED`（不出新补丁）；
    - 已推送远端后遇门禁失败或护栏违例 → 绝不强推覆盖远端，保留现场返回 `RECOVERY_REQUIRED / REMOTE_PUSH_UNREVERTIBLE`。
- **怎么验证改对了**：覆盖 5 类测试——① 工作区等价适配直通门禁关闭；② 本地分支合并等价适配（含上游无关文件不误杀）经 amend 单次原子提交关闭；③ 实质变化/越界先导补丁再还原回 `pending`；④ 触犯 `.ai-review/` 或非法输出直接报 `RUNNER_FAILED` 不出补丁；⑤ 已推送后门禁失败进入 `RECOVERY_REQUIRED`。

---

#### D02 · P1 · 跨轮修订方案时，`optionId` 查得太晚，错产物还会占死名额
- **对应规格**：[SPEC.md](../SPEC.md) §5.6；`AC-ISSUE-OPTIONS`
- **现在代码怎么干的**：
  - 总调度提示词 [orchestrator.md](../packages/dsh-plugin/assets/audit/orchestrator.md) 第 53 行的 `patch.task` 参数里漏掉了 `optionId`；
  - [audit-stages.ts](../packages/dsh-plugin/src/host/audit-stages.ts) 第 194 行只在传了 `optionId` 时才校验，第 389 行直接往候选列表里追加；
  - 直到最后发布 [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 127 行才报错说“改旧方案没带 `optionId`”。
- **会导致什么坑**：Agent 照着任务说明把补丁做完了，最后收尾才炸；而且错误登记的那条记录已经占掉了“最多 2 个方案”的名额，重交正确的也会被卡死。
- **按新版 SPEC 应该怎么改**：
  - 派发方案任务时，Host 必须显式传入已有 `finding_id`、已有 `option_id` 列表、各自 `current_patch` 和共享并发守卫（guard）；
  - 登记产物前就校验 `option_id` 归属与格式，不合法直接拒收且不占名额，允许 Agent 修正后重交。
- **怎么验证改对了**：测试修订方案 A、修订方案 B、新增第二方案都不靠数组下标猜身份；故意漏传或传错 `optionId` 在登记前被拒，补齐后可正常发布且不超名额。

---

#### D06 · P1 · 交互式提案会话（`/fix-session`）缺并发守卫、状态校验与持久化占用
- **对应规格**：[SPEC.md](../SPEC.md) §0.2、§5.4、§5.7、§6.3；`AC-AUDIT-NO-APPLY`、`AC-LOCK-01`、`AC-API-01`
- **现在代码怎么干的**：
  - [api-fix-session.ts](../packages/dsh-plugin/src/host/api-fix-session.ts) 第 58 行没有校验完整的并发守卫（guard，即 `expectedRevision + expectedOwner + expectedUpdatedAt`）；
  - 第 69 行只挡掉了 `approved / rejected / resolved`，漏掉了 `human_takeover` 和 `awaiting_verification`；第 72–74 行虽查了是否有未解决评论，但没按“总体或所选方案”过滤，且 `optionId`/`patchId` 拖到第 78 行 `fixPrompt` 内才查；
  - 第 87 行靠 1 小时内存定时器自动清占用，第 114 行在根会话 `turn-end` 时也直接清占用，既未持久化到磁盘，也没确认子任务停了、业务目录还原干净；
  - [index.ts](../packages/dsh-plugin/src/host/index.ts) 第 258–262 行对审查会话（第 259–262 行 `restrictAuditSession`）和修复会话（第 258 行 `inheritOwnerPolicy`）的处理仍停留在旧的硬拦截思路。
- **会导致什么坑**：旧页面能不带并发守卫乱起会话；已人工接手的问题会被莫名拉起 AI 修改；一旦超 1 小时、根 turn 提前结束或插件重启，工作目录互斥占用锁就没了，别的审批或同步可能直接撞上正在干活的 Agent。
- **按新版 SPEC 应该怎么改**：
  - 受理前强制校验：完整 `ConcurrencyGuard`、显式 `optionId`/`patchId`、Owner 匹配、至少一条总体或所选方案的未解决评论、工作区干净；合法状态仅限 `pending`、`changes_requested` 或人类显式带评论发起的 `repair_failed`；
  - 提示词明确 Mode B 的「软引导 + Host 强还原」纪律（优先写 `.ai-review/` 与 `.tmp/`，不应用补丁验证修复，不执行 VCS commit/push/切分支）；
  - 复用**持久化工作副本占用锁**（重启不丢），仅在确认根会话及子任务树全部停止、且业务目录非 `.ai-review/` 改动归零后才释放占用，取消 1 小时盲目自动释放。
- **怎么验证改对了**：测试缺 guard 或在 `human_takeover`/`awaiting_verification` 上调用被拒；测试 `repair_failed` 无评论被拒、带评论显式发起可创建；测试迟到子任务、超时、Host 重启后占用锁仍生效，直至确认停止且工作区还原才释放。

---

#### D12 · P1 · 清理未发布历史包袱：统一 `schema_version: 1`、移除 v1/v2 兼容与统一 API 守卫
- **对应规格**：[SPEC.md](../SPEC.md) 顶部声明、§3、§6.1、§6.3、§10.1（`I2`）；`AC-DATA-01`、`AC-API-01`
- **现在代码怎么干的**：
  - 代码目前用 `schema_version: 3` 表示新版记录，同时背着大量 v1/v2 读取、审批、迁移分支（如 [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 60–62 / 90–100 行的 v2 自动择首升级、[api-writers.ts](../packages/dsh-plugin/src/host/api-writers.ts) 第 1106 行起的独立 v1 finalize 旁路，以及 `/reject`、`/archive-stale`、`/reopen`、`/convert`、`/dismiss-finding`、`/manual-revision`、`findings/<id>.yml`）；
  - API 中 `/finding/decision` 与 `/approve` 还残留着旧外置发现时代的 `expectedFindingVersion` 与 `findingId` 寻址，与其余 10 个问题写端点的 `{id, ...guard}` 不统一。
- **会导致什么坑**：本项目从未正式发布，历史兼容分支让代码和提示词极度臃肿，且不断把新逻辑带偏进旧分支；双套乐观锁字段（`guard` vs `expectedFindingVersion`）也让前端与 AI 极易传混。
- **按新版 SPEC 应该怎么改**：
  - 唯一正式格式统一为 **`schema_version: 1`**（`review.md` 与 `audit.md` 一致），读端遇任何非 `1` 版本直接报错拒绝；
  - 彻底移除 v1/v2 解析、写入、迁移代码、外置 `findings/<id>.yml`、`verify_gate_on_audit_finalize` / `audit_smoke_commands` 及所有废弃端点；
  - 彻底移除 `findingVersion` / `expectedFindingVersion`，让 `/finding/decision` 与 `/approve` 及全部 11 个问题写端点统一使用 `{id, ...guard}`；
  - 清理历史 v1/v2 夹具，把有效行为测试全面切换到 `schema_version: 1`。
- **怎么验证改对了**：全仓仅存一套 `schema_version: 1` 模型；非 `1` 版本文件被拒绝；废弃端点不可达；全部 11 个问题写端点统一使用 `{id, ...guard}`；类型、构建与全量测试通过。

---

### 中优先级（P2）— 数据精确性、配置体验与前后端细节对齐

#### D03 · P2 · 新仓库缺少 `reviewers.yml` 没在开跑前拦住，且缺一键初始化接口
- **对应规格**：[SPEC.md](../SPEC.md) §3.2、§5.6、§6.3；`AC-ROUTING-01`、`AC-API-01`
- **现在代码怎么干的**：[reviewers.ts](../packages/dsh-plugin/src/host/reviewers.ts) 第 78 行在文件缺失时返回空配置，[api-audit.ts](../packages/dsh-plugin/src/host/api-audit.ts) 第 321/575 行启动审查时没拦截，跑完全部 Agent 后在 [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 81 行才因 `owner` 为空抛错；且目前没有供 UI 一键创建初始 `reviewers.yml` 的写接口。
- **会导致什么坑**：白耗十几分钟 Token 和时间，最后连纯文字问题都发不出来。
- **按新版 SPEC 应该怎么改**：审查启动前（进入 Agent Loop 之前）先校验共享 `reviewers.yml` 与有效 `default_owner`，缺失直接返回 412 `not_configured` 并引导配置；新增 `POST /reviewers/init` 接口供 UI 用当前操作者一键初始化并提交 `reviewers.yml`；已有问题继续保留各自共享 `owner`。
- **怎么验证改对了**：无 `reviewers.yml` 的仓库启动审查在进 Agent Loop 前即返回 412；调用 `POST /reviewers/init` 初始化后可正常开跑审查。

---

#### D04 · P2 · 旧的门禁白名单（`allowed_gate_commands`）仍在拦截正常补丁产出
- **对应规格**：[SPEC.md](../SPEC.md) §3.2、§6.5、§8.2；`AC-SECURITY-01`
- **现在代码怎么干的**：[audit-stages.ts](../packages/dsh-plugin/src/host/audit-stages.ts) 第 239 行与 [issue-finalize.ts](../packages/dsh-plugin/src/host/issue-finalize.ts) 第 48 行强行拒绝不在 `allowed_gate_commands` 里的任何门禁命令。
- **会导致什么坑**：只要 AI 写的单测命令没逐字抄进白名单（比如只跑单个测试文件），合法补丁就直接被拒，根本产不出来。
- **按新版 SPEC 应该怎么改**：**彻底移除门禁白名单拦截逻辑**（生成、发布、批准均不校验白名单，配置文件若残留该键仅忽略）；只保留 `gate_checks` 非空校验，并确保批准面板明文完整展示全部待执行门禁命令。
- **怎么验证改对了**：仓库未配置任何白名单时，任意合法非空测试命令均可正常产出补丁、发布并在批准面板明文展示执行。

---

#### D05 · P2 · 人工处置写盘不完整，`repair_failed` 缺永久封禁与防死锁流转，界面缺正确入口
- **对应规格**：[SPEC.md](../SPEC.md) §4.1、§4.2、§6.5；`AC-STATE-01`、`AC-REPAIR-FAILURE`
- **现在代码怎么干的**：
  - [api-writers.ts](../packages/dsh-plugin/src/host/api-writers.ts) 第 663–695 行处理 `accept_as_is` 时，只追加了 `decisions[]`，没同步把 `status` 改为 `rejected`、没填 `rejection` 对象，也没落盘 `category` 与从补丁 hunk header 提取的 `related_symbols`；
  - 未实现“失败补丁永久封禁”与完整状态门禁，导致 `repair_failed` 能通过 `resume_review` 直接退回 `pending` 重复审批；同时 `human_takeover` 缺少直接转 `accept_as_is` 的出口，形成状态死锁；
  - 本地界面 [client.ts](../packages/dsh-plugin/src/client/client.ts) 第 740 行和中央界面 [App.tsx](../apps/web/src/App.tsx) 第 116 行把 `repair_failed` 投影成了“已接手”处置，藏掉了接手按钮，而“外部完成”按钮又要求真实状态是 `human_takeover`，导致失败页卡死。
- **会导致什么坑**：状态机和读模型自相矛盾；失败补丁可绕开人工处理重跑；人工接手后若想放弃修复没有退路；用户在失败页点不到正确按钮。
- **按新版 SPEC 应该怎么改**：
  - `accept_as_is` 同步写入 `decisions[]`（含 `category` 和合并当前方案补丁提取的 `related_symbols`）、置 `status: rejected` 并填充 `rejection`，且允许从 `human_takeover` 直接转入；
  - 落实失败补丁 `(option_id, patch_id)` 永久封禁、`repair_failed` 新增评论保持 `repair_failed`、解除 `defer` 恢复原状态；`repair_failed` 仅当存在另一未失败方案（双方案场景）时才允许 `resume_review` 回到 `pending` 改选另一方案；同时支持 `awaiting_verification → human_takeover` 撤回误点的外部完成；
  - 修正两端 UI，在 `repair_failed` 页直接提供清晰入口并标明已封禁补丁，绝不显示自动重试按钮。
- **怎么验证改对了**：覆盖 `accept_as_is` 三字段同步与符号提取；验证单方案 `repair_failed` 拒绝直接/两步 `resume_review` 与基线漂移绕过；验证双方案可改选未失败方案；验证 `human_takeover → accept_as_is` 与两端 UI 按钮一致。

---

#### D07 · P2 · `Deferred` 依赖与新 Frontmatter 字段缺失，且新问题把 `module` 写死了
- **对应规格**：[SPEC.md](../SPEC.md) §3.3、§10.1（`I7`–`I9`）；`AC-DATA-01`、`AC-ISSUE-RECORD`
- **现在代码怎么干的**：
  - [audit-stages.ts](../packages/dsh-plugin/src/host/audit-stages.ts) 第 445 行要求 Deferred 提供 `dependsOn`，但 [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 147 行写 `review.md` 时根本没存；[issue-review.ts](../packages/dsh-plugin/src/host/issue-review.ts) 第 165 行读取时直接写死 `dependsOn: null`；
  - [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 84 行把所有新建问题的 `module` 硬编码为 `'audit'`、标题硬拼 `'audit: '` 前缀；
  - 尚未落地 `issue_kind`、`approval_history`、`repair_attempts[].id` 及纯文字零补丁允许 `commit_message: null`。
- **会导致什么坑**：延迟问题写完就丢依赖；按 `module` 分组的负向记忆和筛选全部失灵；已关闭问题重开时历史批准无处存放；纯文字问题被迫凑假提交信息。
- **按新版 SPEC 应该怎么改**：在 `review.md` 正式读写 `issue_kind`、`depends_on`、`approval_history: []`、`repair_attempts[].id` 与可空 `commit_message`，并按真实模块名写入 `module` 与 `title` 前缀（不再硬编码 `'audit'`）；已 `approved` 问题重开时清空旧活跃补丁。
- **怎么验证改对了**：新建 A 类、B 类纯文字、Deferred 与重开问题，核对 Frontmatter 往返、`module` 准确性、`depends_on` 与 `approval_history` 保留。

---

#### D08 · P2 · 发布时间可能倒退、补丁 `sha256` 未强制校验、键序与小写 `slug` 未统一
- **对应规格**：[SPEC.md](../SPEC.md) §3.1、§3.3、§3.5、§10.1（`I1`、`I4`、`I13`）；`AC-DATA-01`、`AC-LOCK-01`
- **现在代码怎么干的**：
  - [issue-publication.ts](../packages/dsh-plugin/src/host/issue-publication.ts) 第 104 行直接填当前系统时间 `now`，没复用 [store.ts](../packages/dsh-plugin/src/host/store.ts) 第 617 行的单调递增 `nextUpdatedAt`，时钟回拨或旧时间靠后时会倒退；
  - [issue-review.ts](../packages/dsh-plugin/src/host/issue-review.ts) 第 208–211 行校验补丁账本时未强制要求 `sha256` 必填，[store.ts](../packages/dsh-plugin/src/host/store.ts) 第 1064 行只在摘要存在时才比对，删掉 `sha256` 竟能通过完整校验；
  - [frontmatter.ts](../packages/dsh-plugin/src/host/frontmatter.ts) 第 447 行未按新版固定顶层键序序列化；目录 `slug` 正则仍允许大写字母（跨平台易碰撞）。
  - *(注：[audit-archive.ts](../packages/dsh-plugin/src/host/audit-archive.ts) 第 198 行已将目录 ID `YYYY-MM/<slug>` 写入 `audit.md.issues`，与新版 SPEC §3.5 一致，只需同步 `schema_version: 1`。)*
- **会导致什么坑**：时间倒退会破坏乐观锁并发校验；缺 `sha256` 可能导致补丁文件被静默替换却不被察觉；大小写目录在 Windows/macOS 下易撞名。
- **按新版 SPEC 应该怎么改**：全部写入口统一走 `nextUpdatedAt`；校验器强制 `patches[].sha256` 必填且与文件原始字节一致；按新版 SPEC §3.3 固定键序输出 Frontmatter；将问题目录 `slug` 统一收紧为小写 `^[a-z0-9][a-z0-9._-]*$`。
- **怎么验证改对了**：用冻结时钟/未来时钟测试发布时间严格递增；测试删掉或篡改 `sha256` 被完整校验拒绝；测试大写 `slug` 被拒、固定键序与纯文字空账本往返。

---

#### D09 · P2 · 队列页只预检默认方案，且状态统计 `counts` 漏了 4 个新状态
- **对应规格**：[SPEC.md](../SPEC.md) §6.2、§6.5；`AC-ISSUE-OPTIONS`、`AC-UI-01`、`AC-API-01`
- **现在代码怎么干的**：[api-readmodels.ts](../packages/dsh-plugin/src/host/api-readmodels.ts) 第 45、66、143 行的队列缓存键只有 `root/id/revision/base`，后台预检只跑默认补丁，列表只返回一个笼统的 `patchCheck`（详情页第 230 行已分方案，队列没跟上）；同时第 148 行的 `counts` 只初始化了 4 个旧状态，缺少 `repair_failed / human_takeover / awaiting_verification / resolved`。
- **会导致什么坑**：方案 A 干净、方案 B 冲突时，队列页看不出哪个冲突；队列顶部各状态筛选统计缺项。
- **按新版 SPEC 应该怎么改**：队列缓存键与后台异步预检统一按 `(candidateId, recordRevision, optionId, patchId, base)` 分方案保存与展示；`counts` 补齐全部 8 个规范状态键（统计非 `local` 共享问题）；仍保持队列请求只读缓存、后台低优先级异步预检。
- **怎么验证改对了**：双方案一干净一冲突时队列分别返回准确诊断；纯文字不伪造预检；`counts` 准确包含全部 8 个状态计数。

---

#### D10 · P2 · 进程式定时审查仍保留旧的历史复查旁路，会回头查已 `approved` 关闭的问题
- **对应规格**：[SPEC.md](../SPEC.md) §9.11；`AC-CENTRAL-SCHEDULE-01..06`、`AC-ISSUE-HISTORY`
- **现在代码怎么干的**：[api-audit.ts](../packages/dsh-plugin/src/host/api-audit.ts) 第 974 行在正式总调度之前单独跑了一轮 `runAgent` 做历史复查；[audit-history.ts](../packages/dsh-plugin/src/host/audit-history.ts) 第 106 行把上一轮**已经程序批准关闭**的候选也捞出来重新复查，还给了一条“禁止修改任何文件”的旧提示词。
- **会导致什么坑**：违背“程序修复门禁通过即关闭、不追加复核”的原则，而且没走统一总调度和独立复核阶段。
- **按新版 SPEC 应该怎么改**：删掉这条旧历史旁路，定时审查全程复用同一总调度与受租约阶段工具；历史覆盖阶段只处理本轮范围内的开放问题、到期延期项和 `awaiting_verification`（外部完成待核验项）；已 `approved` 关闭的问题仅在正常全仓扫描发现新证据时才沿原记录重开。
- **怎么验证改对了**：定时审查用例确认不再主动复查已 `approved` 问题；外部完成项经独立代码证据关闭为 `resolved`，仍存在回 `human_takeover`。

---

#### D11 · P2 · 提示词残留旧副本描述，且自检未接入“外部优先 + 子代理兜底”与新格式验证
- **对应规格**：[SPEC.md](../SPEC.md) §5.4、§6.4、§7、§9.12；`AC-PROMPT-01`、`AC-SELF-TEST-01`
- **现在代码怎么干的**：
  - [patch/SKILL.md](../packages/dsh-plugin/assets/audit/patch/SKILL.md) 第 3 行元数据还写着“Host 在专用副本验收”，和现行共享 cwd 矛盾；
  - [audit-self-test.ts](../packages/dsh-plugin/src/host/audit-self-test.ts) 第 90–126 行只测了大文件读取，没有验证写入 `.ai-review/` 和临时文件还原，生成的模拟档案还是旧的 `schemaVersion=2` 且没有问题记录，也未实现 `stageExecutors` 优先尝试 Codex/Claude Code 并在不可用时优雅降级给本 Harness 独立子代理的逻辑。
- **会导致什么坑**：误导模型行为；节点即使本 Harness 自己完全能跑，也会因为没装或跑不通某个外部 CLI 而被自检误判不可用，或测不出 `schema_version: 1` 读写问题。
- **按新版 SPEC 应该怎么改**：
  - 清理提示词里所有旧副本、旧版本号和旧白名单残留，按新版 SPEC 展开 Mode A/B/C 与「软引导 + Host 强还原」指引；
  - 落地 `stageExecutors` 探测与优雅降级（Codex / Claude Code 可用时优先调起，不可用时自动降级给本 Harness 独立子代理并如实记录状态）；
  - 更新 `POST /api/v1/test` 自检：必验「大文件未预注入读取 + `.ai-review/` 写入 + 临时文件还原零残留 + `schema_version: 1` 问题与索引写入读回」。
- **怎么验证改对了**：验证外部执行器不可用时降级本 Harness 子代理仍能走通完整自检并返回 `SUCCEEDED`（附降级状态）；任一必验项失败返回 `ABORTED`。

---

## 4. R01 · 真实 Harness 端到端验收尚未完成

除了上面 12 项代码差距，还有一项**真机验收**不能跳过：

- **既往观测**：此前在同一代码基线上用真实 Codex alpha 执行器跑 180 KB 大文件读取 + 写 `.ai-review/proof.txt` 时失败了（模型回报工具不可用或策略拒绝），Claude Code 真机也未实测。
- **新设计已消除的架构阻力**：
  1. 新版 SPEC 明确审查阶段采用 **「软引导 + Host 强还原」策略**（不靠沙箱硬拦项目写、提示词引导优先 `.ai-review/` 与 `.tmp/`、Host 收尾强还原），消除了权限沙箱与工具循环打架的隐患；
  2. 新版 SPEC 明确 **Codex / Claude Code 为优先增强执行器，不可用时优雅降级为本 Harness 独立子代理**，不再被单一 alpha CLI 环境卡死。
- **待补验收**：完成上述代码改造后，必须在真实部署环境中端到端跑通 `AC-HARNESS-READ`、`AC-AUDIT-NO-APPLY` 与 `AC-SELF-TEST-01`——至少实测通过「本 Harness 独立子代理完整链路（大文件尾部读取 + `.ai-review/` 写入 + 临时取证还原 + `schema_version: 1` 发布）」；同时在具备 Codex / Claude Code 的环境实测其优先调起与降级上报。绝不用 mock 执行器冒充真机通过。

---

## 5. 既有测试与代码复现验证（供回归参考）

在代码基准 `2a6f55e` 上，此前已跑过 23 项专项测试（[issue-review.test.mjs](../tests/issue-review.test.mjs)、[issue-workflow.test.mjs](../tests/issue-workflow.test.mjs)、[harness-review-boundaries.test.mjs](../tests/harness-review-boundaries.test.mjs)，23/23 通过），并用 10 组直接调用真实模块函数的复现验证用例（不启动外部模型，仅检验代码分支行为）证实了上述问题真实存在：

| 复现用例 | 复现出的代码行为 | 对应差距项 |
| --- | --- | --- |
| Case 1 | `buildFixPrompt` 对评论修订（Mode B）与冲突辅助（Mode C）生成完全相同的提案提示词 | D01 |
| Case 2 | 修订既有方案不带 `optionId` 到发布阶段才报错，补齐后成功 | D02 |
| Case 3 | 空 `reviewers.yml` 配置下，纯文字问题到最终发布才报缺负责人 | D03 |
| Case 4 | Deferred 只填 `dependsOn` 时，落盘的 `review.md` 里完全丢失该依赖 ID | D07 |
| Case 5 | 旧记录 `updated_at` 靠后时，审查发布写回了一个更早的时间戳 | D08 |
| Case 6 | `repair_failed` 不传并发守卫仍可创建 `/fix-session`，且 `turn-end` 直接清除占用 | D06 |
| Case 7 / 8 | `accept_as_is` 未置 `rejected`/`rejection`；`repair_failed` 走 `resume_review` 被改回 `pending` | D05 |
| Case 9 | 删掉补丁 `sha256` 仍能通过 `validateFullCandidate` | D08 |
| Case 10 | 同 `finding_id` 多份旧 v2 记录升级目录随输入顺序摇摆 *(新版已彻底取消 v1/v2 兼容，由 D12 直接移除)* | D12 |

---

## 6. 建议的落地实施顺序

按风险与依赖关系，建议分 4 步推进（每步都在独立 worktree 分支开发、独立审查并跑全量验证）：

1. **第一步：减负与定型（D12、D07、D08、D04）**
   先把格式统一为 `schema_version: 1`，删掉所有 v1/v2 兼容代码、废弃端点、`expectedFindingVersion` 和门禁白名单拦截，补齐 `issue_kind / depends_on / approval_history / repair_attempts[].id / commit_message`、修正 `module` 硬编码、强制 `sha256`、收紧小写 `slug` 和严格递增 `updated_at`。先卸掉历史包袱，后面所有改动都会干净很多。
2. **第二步：打通执行与权限核心边界（D01、D06、D05）**
   落实 Mode C 完整权限获批辅助应用与物理拓扑硬护栏直通门禁（含情况 A、B-本地、B-已推送闭环）；加固 `/fix-session` 的并发守卫、状态校验、持久化占用锁与结束还原；补全 `repair_failed` 永久封禁与无死锁状态机、同步 `accept_as_is` 落盘并修复两端 UI 失败页入口。
3. **第三步：补齐审查体验与统一调度（D02、D03、D09、D10）**
   前置 `reviewers.yml` 检查并新增 `POST /reviewers/init`、前置 `optionId` 登记校验、队列按方案异步预检并补齐 8 状态 `counts`、清理定时审查旧历史旁路。
4. **第四步：提示词、自检降级与真机收口（D11、R01）**
   清理提示词残留，接入 `stageExecutors` 的“外部 Agent 优先 + 本 Harness 独立子代理兜底”及 `POST /api/v1/test` 完整自检；把所有差距项写成可复现自动化测试，跑通 `npm run typecheck`、`npm run build`、全量测试以及真实环境端到端验收。
