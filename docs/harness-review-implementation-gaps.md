# 七项设计的实现未对齐清单

> **任务来源**: 用户重新确认审查与修复的七项设计，要求先全面修订 SPEC.md，随后将尚未对齐设计的实现另写文档并提交。
> **任务内容**: 对照已修订规格记录当前实现缺口、源码证据、影响、修订方向与验收条件；区分已确认缺口、既有测试通过范围及未完成的真实 Harness 验收。本次不修改实现。
> **参考文档**:
> - [SPEC.md](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/SPEC.md) — 提交 `2ea7be3`；七项设计、阶段边界、格式契约及验收基准。
> - [AGENTS.md](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/AGENTS.md) — 审查后逐条复核、验证和提交纪律。
> - [原改造方案](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/docs/plans/2026-11-25-harness-review-redesign.md) — 原 17 组实施差异及范围，不能代替本次新规格验收。
> - [原实施与复审记录](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/docs/harness-review-redesign-validation.md) — 历史测试及真实 CLI 验收限制；其中“无未修复 P0/P1/P2”的判断不能代表当前完整对齐。
> - [问题工作流测试](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/tests/issue-workflow.test.mjs)、[问题记录测试](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/tests/issue-review.test.mjs)、[Harness 边界测试](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/tests/harness-review-boundaries.test.mjs) — 本次重跑的 23 项专项测试。
> **生成日期**: 2026-11-26

## 1. 基准与结论边界

规格基准为 `2ea7be3`，实现基准为 `2a6f55e`；前者只修订 SPEC，没有改变实现。下列源码位置以该实现为准，后续代码变更后须重新核验。

文中链接指向本次核验的工作副本；工作副本回收后，可按基准提交和链接中的仓库内路径从 Git 历史恢复对应源码，不能用后续同名文件的新行号直接替代本次证据。

本次先按七项设计检查实现，再逐条回到实际分支、调用方和校验器复核。确认 **12 组实现缺口，其中 P1 三组、P2 九组**；另列一组真实 Harness 验收受阻项，不将未查明的环境原因直接归为代码缺陷。部分组包含同一机制下的多处入口，不按文件重复计数。

本次仅新增本文。既有实现、测试和原实施记录均不修改；规格完成不表示本清单已修复。旧记录中“全部差异已处理”的表述应结合本文重新判断。

## 2. 七项设计的实现对照

| 已确认设计 | 当前可保留的基础 | 尚未对齐的部分 |
| --- | --- | --- |
| 1. 总调度委派独立阶段，完整 Harness 自主调查 | 已有阶段执行通道、独立上下文和原项目 cwd；已移除原源码视图裁剪 | 进程式定时历史复查仍有旧旁路；真实模型读取验收未完成；自检覆盖不完整，见 D10、D11、R01 |
| 2. 共用 cwd，全项目可读，默认写审查目录，取证归档还原 | 主审查的权限桥、取证归档恢复和停止未知时阻断已有专项测试 | 人审前提案会话没有落实相同写权限及完整占用生命周期，见 D06 |
| 3. 明确问题交付一至两个 patch 或重大文字方案，审查不应用 | 常规新审查提案与收尾采用只读预检；纯文字问题已支持 | 新项目配置阻断发现过晚；白名单被当成产出补丁的硬门禁；Deferred 信息丢失，见 D03、D04、D07 |
| 4. 每问题一份跨轮记录，补丁独立编号并保留历史 | 已支持单记录、两个方案、A001/B002 后修订 B003，批准保留 patch | 跨轮身份输入、记录完整性、队列预检、旧格式迁移仍有缺口，见 D02、D07–D09、D12 |
| 5. 人审后程序优先，Agent 可辅助应用，实质变化才重新人审 | 程序严格应用与确定性三方合并、显式方案批准已有实现 | Agent 辅助仍被强制当作新提案，缺少保持原批准继续应用的路径，见 D01；提案与执行会话边界见 D06 |
| 6. 验证通过直接关闭；失败还原、记录、待人工，不自动修正 | 常规批准验证失败会还原、提交 repair_failed 记录且不调用 Runner | 待人工状态可被其他入口绕过；定时历史路径仍主动复查已合入候选，见 D05、D10 |
| 7. 外部接手与完成反馈分开，后续代码证据关闭 | 正常 human_takeover → awaiting_verification → resolved 路径已有测试 | 人工处置状态转换未完整统一，其他提案入口仍接受接手及待核验状态，见 D05、D06 |

## 3. 已确认的实现缺口

### D01 · P1 · 获批辅助应用仍被强制转为新提案

**规格**：SPEC §0.3、§4.10.4、§7.4–§7.5；AC-REPAIR-ASSIST。

**实际代码**：

- [runner.ts:111](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/runner.ts:111) 对全部 schema3 请求返回相同提案分支，不区分 ADDRESS_FEEDBACK 与获批 RESOLVE_CONFLICT；要求追加 patch、回 pending，并禁止业务编辑和 VCS 写操作。
- [runner.ts:345](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/runner.ts:345) 按 schemaVersion 选系统提示词；[ai-proposal-system.md:10](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/assets/ai-proposal-system.md:10) 一律禁止应用业务补丁。
- [approval.ts:942](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/approval.ts:942) 冲突后调用上述 Runner，finally 在第 963 行无条件还原业务工作区，成功后在第 1105 行返回 FALLBACK_TO_PENDING，要求重新审核。
- [runner.ts:381](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/runner.ts:381) 的成功判据要求产生新版本与补丁，也无法接受仅辅助应用成功的结果。

**影响**：即使不改变获批方案，Agent 也不能帮助落地后继续门禁；需要分支合并时没有符合新设计的完整权限及收尾路径。程序三方合并已存在，不等于 Agent 辅助应用已经实现。

**修订方向**：在现有 Runner/批准事务中显式区分任务意图和批准上下文。保持获批方案的辅助结果进入原门禁、内容核验和原子提交；实质变化才还原、追加新 patch 并重新人审。不要另建一套问题存储或恢复框架。

**验收**：程序应用失败后，等价辅助可编辑业务并直接完成本次批准；实质变化回人审；辅助后的门禁失败仍还原待人工。内存取证 P01 已确认两种模式当前生成完全相同的提案提示词。

### D02 · P1 · 跨轮方案身份到发布时才检查，错误产物无法正常替换

**规格**：SPEC §4.10.2、§7.6；AC-ISSUE-OPTIONS。

**证据**：[orchestrator.md:53](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/assets/audit/orchestrator.md:53) 的 patch.task 参数说明没有 optionId；[audit-stages.ts:194](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-stages.ts:194) 仅在它被提供时校验，登记阶段也不核实既有问题的方案身份。候选在第 389 行追加，两个名额及第二方案 approach 检查位于第 209 行。直到 [issue-publication.ts:127](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-publication.ts:127) 才拒绝既有方案修订未带 optionId。

**影响**：按已公开任务说明成功生成的 patch 可以在最终发布时失败；重交正确 patch 不会替换已登记错误候选，旧候选仍随发布进入校验，还可能耗尽两个名额。

**修订方向**：派发时携带问题及已有方案身份；产物登记前核对归属、当前 patch 和 guard。允许修正失败产物，两个名额约束有效方案，不能由无效登记永久占用。

**验收**：修订 A、修订 B、增加第二方案均不按数组位置猜身份；漏传/错传在登记前拒绝，修正后可继续发布。P02 已确认无 optionId 在发布失败，同输入补齐后成功。

### D03 · P2 · 缺少负责人配置未在审查开始前阻止

**规格**：SPEC §4.2、§7.6；AC-ROUTING-01。

**证据**：[reviewers.ts:78](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/reviewers.ts:78) 在配置缺失时返回空配置；[api-audit.ts:575](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-audit.ts:575) 建立租约及第 321 行阶段初始化没有验证新问题路由可用。最终 [issue-publication.ts:81](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-publication.ts:81) 才因 owner 为空抛错。

**影响**：已有受信操作者或租约 owner 仍不等于共享路由已配置；新项目可消耗完整审查后连文字问题都不能发布。

**修订方向与验收**：新审查启动前明确检查共享 reviewers.yml/default_owner，并给出配置指引；不能由模型编造 Owner。缺失配置应在进入 Agent Loop 前诊断，已有问题仍保留当前共享 Owner。P03 已复现文字问题的最终发布失败。

### D04 · P2 · 门禁白名单仍是生成及发布 patch 的硬限制

**规格**：SPEC §4.2、§7.6、§12.2；AC-SECURITY-01、AC-AUDIT-01。

**证据**：[audit-stages.ts:239](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-stages.ts:239) 拒绝未命中白名单的任何 gateCommands；[issue-finalize.ts:48](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-finalize.ts:48) 再次阻止新提案提交；总调度参数说明也要求命中白名单。

**影响**：本来可以让人审完整确认的有效验收命令，会导致补丁不能生成或发布。白名单被提升为产物资格条件，超出“降低确认成本”的契约。

**修订方向与验收**：保留命令非空、格式和执行时确认；白名单只产生匹配信息，未命中在人审时明确确认，不能因此拒绝提案或丢掉明确问题。仅声明命令不会触发审查阶段的修复验证。

### D05 · P2 · 人工处置与待人工状态的转换不完整

**规格**：SPEC §4.10.3、§5.1、§8.3；AC-STATE-01、AC-REPAIR-FAILURE。

**证据**：[api-writers.ts:663](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-writers.ts:663) 按 disposition 拒绝部分动作，但未禁止 repair_failed 直接 resume_review。第 689–695 行追加决定后，仅显式处理接手、外部完成和恢复审核；accept_as_is 未设置 rejected 或 rejection。

**影响**：

- 本次不修改在读模型中可以显示为接受现状，但底层仍可能是 pending、rejection=null，与状态契约不一致。这里不能据此断言现有审批一定绕过人的决定，审批另有发现处置检查。
- repair_failed 可以经 resume_review 直接回 pending，绕过规定的人工接手处理边界；两端界面也根据非 undecided 处置展示“重新审核”。
- [中央界面 App.tsx:116](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/apps/web/src/App.tsx:116) 与 [本地界面 client.ts:740](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/client/client.ts:740) 按 disposition 隐藏已接手项的接手按钮。repair_failed 已被投影为 human_takeover 处置，但外部完成按钮又要求实际 issueStatus=human_takeover，因此失败页缺少正确转入接手再反馈完成的常规入口；“重新审核”不能代替这个转换。

**修订方向与验收**：按新状态表统一动作资格和状态写入，保留人工历史；本次不修改应形成一致的 rejected/rejection，失败问题不能通过通用恢复接口重回审批。P07、P08 已在实际处置分支、持久化之前用内存拦截确认转换结果。

### D06 · P1 · 人审前提案会话缺少权限、guard 和停止核验边界

**规格**：SPEC §0.3、§7.4、§8.1、§11.4；AC-AUDIT-NO-APPLY、AC-LOCK-01。

**证据**：

- [api-fix-session.ts:58](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-fix-session.ts:58) 未读取完整问题 guard；第 69 行只拒绝 approved/rejected/resolved，repair_failed、human_takeover、awaiting_verification 未被统一排除。
- [index.ts:258](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/index.ts:258) 对“修复”标签继承原会话预设，只对“审查”标签安装 restrictAuditSession。当前 /fix-session 实际产物是人审前提案，仍可能继承原会话的宽写权限。
- [api-fix-session.ts:87](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-fix-session.ts:87) 一小时直接释放内存占用；第 114 行 turn-end 也直接释放，没有根/子任务停止和工作区核验。该占用未形成可恢复的持久状态。

**影响**：提案会话的提示词限制不等于实际权限边界；旧页面可以不带 guard 启动会话，待人工状态也能启动；超时、根 turn 结束或 Host 重启后，尚未核实的执行可能失去互斥保护。本次未用真实模型进行越权写入攻击试验，结论是这些保护未在该路径落实，不能把它写成已验证的操作系统隔离失效。

**修订方向**：以提案意图绑定权限，复用审查权限与工作副本占用机制；受理前验证 guard 和允许状态，结束时核验根、子任务及工作区，未知则保留占用。不要把修复阶段放权反向套用于该入口。

**验收**：P06 已确认 repair_failed 且省略 guard 仍可到达创建回调，turn-end 随即清除占用。后续须补充真实会话的写目录限制、迟到子任务、超时和重启恢复测试；不能仅测试创建返回 202。

### D07 · P2 · Deferred 的前置关系没有保存在问题事实中

**规格**：SPEC §3.1、§4.10.3、I10；AC-ISSUE-RECORD。

**证据**：[audit-stages.ts:445](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-stages.ts:445) 要求 Deferred 提供 dependsOn；[issue-publication.ts:147](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-publication.ts:147) 生成问题正文时没有写入分类或 dependsOn；[issue-review.ts:167](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-review.ts:167) 仅由有无 options 推导 repair/confirm，并固定 dependsOn=null。

**影响**：如果模型没有自行将前置 ID 再抄进 repairPlan，入口接受的机器字段会消失；以后难以从唯一问题事实还原为何延迟及依赖谁。

**修订方向与验收**：在同一 review.md 明确保留分类、前置 finding_id 和方案说明，并让读模型及跨轮输入使用它；不在 audit.items 或新 YAML 另建事实。P04 用仅出现在 dependsOn 的唯一标记确认输出问题记录没有保存它。

### D08 · P2 · 记录时间、强制摘要与格式写入口径尚未统一

**规格**：SPEC §4.10.1–§4.10.2、§4.10.5、I4、I13–I14。

**证据与影响**：

- [issue-publication.ts:104](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-publication.ts:104) 直接写当前 now，既有记录时间在未来或时钟回拨时会倒退；正常 [store.ts:617](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/store.ts:617) 已有 nextUpdatedAt，发布没有复用。P05 已确认旧 updated_at=2099 时会写回较早时间。
- [issue-review.ts:194](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-review.ts:194) 没有要求每个账本项有 sha256；[store.ts:1064](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/store.ts:1064) 仅在摘要已存在时比较。正常发布会生成摘要，但外部提案缺失摘要仍可通过完整校验，P09 已确认。
- [frontmatter.ts:447](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/frontmatter.ts:447) 沿旧对象追加 schema3 字段，未遵循现行固定键序；[audit-archive.ts:198](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-archive.ts:198) 将内部目录 id 写入 issues，与现行规格的 review.md 相对路径口径不同。这两项属于较低影响的格式对齐，不能与摘要绑定缺失等量视为数据损坏。

**修订方向与验收**：统一记录时间推进；新补丁摘要必填并验证原字节；明确并统一 schema3 的序列化及索引解析。覆盖冻结时钟、回拨、缺失/错摘要、纯文字空账本和索引往返，旧记录保持明确兼容，不通过重写历史掩盖差异。

### D09 · P2 · 队列仍只预检默认方案，未形成按方案的诊断

**规格**：SPEC §8.2、§10.1；AC-ISSUE-OPTIONS、AC-UI-01。

**证据**：[api-readmodels.ts:45](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-readmodels.ts:45) 的基础缓存键只有 root/id/revision/base；第 66 行后台预检选择默认 currentReviewPatch；第 143 行队列使用基础键且只返回一个 patchCheck。

**影响与限定**：队列没有分别表达 A/B 的预检，也未标明诊断所属选择。详情第 230 行已经追加 optionId/patchId，因此不能把本问题描述成“所有详情缓存都会串方案”或“已批准了错误补丁”。

**修订方向与验收**：让队列后台任务及缓存使用与详情一致的明确方案身份，诊断与规模标明所属方案/patch；A 可应用、B 冲突时分别显示，纯文字不伪造补丁。仍保持队列请求只读缓存、不在请求内批量执行预检。

### D10 · P2 · 进程式定时审查仍有旧历史复查旁路

**规格**：SPEC §7.6、§16.11；AC-HARNESS-READ、AC-AUDIT-NO-APPLY、AC-ISSUE-HISTORY。

**证据**：[api-audit.ts:974](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-audit.ts:974) 在正式 channelPrompt 之前单独 runAgent 执行历史复查；[audit-history.ts:106](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-history.ts:106) 从上一档案收集已批准候选，随后第 119 行提示词要求不得修改任何文件，结果直接交 verifyAuditRecheck 核对。

**影响**：该历史覆盖没有与独立阶段复核、可归档取证及正常发布共用完整流程；已成功程序修复还被主动加入专门复查。schema3 的 issues 被解析到内部 candidates，因此这不只是旧格式恢复代码。

**修订方向与验收**：复用同一总调度与受租约阶段工具，历史阶段只处理适用开放问题、到期延期和外部完成待核验；允许必要取证但必须恢复。程序已关闭问题在正常扫描发现新证据时才重开，不能增加必跑的成功复核。

### D11 · P2 · 提示词残留与自检覆盖仍未跟随现行契约

**规格**：SPEC §11、§16.12；AC-PROMPT-01、AC-ISSUE-COMPAT。

**证据**：[补丁 Skill:3](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/assets/audit/patch/SKILL.md:3) 的 description 仍写“Host 在专用副本验收”，与正文和实际共享 cwd 相反。此处是误导性提示词残留，不能据此断言 Host 实际仍创建副本。

[audit-self-test.ts:90](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/audit-self-test.ts:90) 已通过大文件随机尾行验证读取，但没有要求 Agent 写入审查目录并核对写入结果，或核对默认业务写限制；第 126 行仍生成 schemaVersion=2 且没有问题记录的模拟档案。

**修订方向与验收**：清理矛盾的角色/元数据说明；自检验证真实读取、审查目录写入、默认业务写边界及 schema3 问题/索引读回。保留现有随机样本、停止和清理逻辑，不以模拟执行器通过替代真实模型验收。R01 单独记录实际环境结果。

### D12 · P2 · 旧格式升级及新建入口缺少完整适用范围核验

**规格**：SPEC §0.2、§13.2；AC-ISSUE-COMPAT。

**证据**：[issue-publication.ts:52](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/issue-publication.ts:52) 用 findingId 建立 Map；多个旧 v2 记录同属一 finding 时，第 62 行保留先遇到的旧记录，随后直接升级，未核实唯一承载目录及完整方案映射。P10 已确认调换输入遍历顺序就改变升级目录。

[api-writers.ts:1105](/C:/Users/Administrator/.codex/worktrees/a333/dsh-review/packages/dsh-plugin/src/host/api-writers.ts:1105) 后的独立 finalize 分支仍按本地旧候选、版本 1 等条件收尾，没有证明它是已按旧契约启动的恢复任务。

**影响**：多候选旧问题可能被静默择首升级，其他方案与人工历史的映射未证明完整；另一路仍可作为新建 v1 产物入口，与“旧格式兼容不等于新任务降级”不符。

**修订方向与验收**：唯一且可核验时才原地迁移；多旧记录映射不明交人处理，保留旧读取，不猜测合并。旧任务恢复需有可核验的开始上下文；新问题统一 v3。保留已经通过的旧补丁恢复和旧人工决定迁移用例，再补歧义映射和伪装旧恢复的新任务拒绝用例。

## 4. R01 · 真实 Harness 验收仍受阻

源码已有原 cwd、正常工具事件流及读写权限相关改造，但完整实际执行尚不能标为完成：

- 前一轮在同一实现基准上使用真实 Codex 执行器，要求读取 180 KB 文件末尾未预注入提示词的随机内容，并写 `.ai-review/proof.txt`。执行器确认停止，但文件读取和审查目录写入均未成功，业务原文件未变；模型诊断提到工具不可用或策略拒绝。该诊断不足以单独确定根因，不能直接写成某个模块必然配置错误。
- 原实施记录中的 150 KB 真实读取 smoke 也未通过。Claude Code 的真实模型读取、写入及边界验收尚未完成。
- 本轮没有重新运行真实模型 smoke；保留既往观测及来源，不将它写成本轮新产生的失败。当前 23 项专项通过也不能消除此验收阻塞。

后续须在实际部署 Harness/CLI 环境，按 AC-HARNESS-READ、AC-AUDIT-NO-APPLY 和 SPEC §16.12 验证独立阶段、同一 cwd、未注入随机大文件读取、审查目录写入、业务写限制及停止证明；同时核对主调度的真实委派。不得以放开审查业务写权限或复制凭据绕过失败。

## 5. 本轮验证及逐条复核

### 5.1 专项测试

本次执行：

```powershell
node --test --test-concurrency=1 --test-reporter=tap tests/issue-review.test.mjs tests/issue-workflow.test.mjs tests/harness-review-boundaries.test.mjs
```

结果为 **23 项通过、0 失败、0 跳过**，约 52.7 秒。测试使用现有构建产物，本轮未重新构建或修改实现；源码和调用分支另行逐条核对。没有重跑原约 30 分钟的全量测试，也不把原 608 项结果登记为本轮新验收。

已验证的基础包括显式选择 B、保留历史补丁、门禁失败还原且不调用 Runner、单方案跨轮修订、旧补丁恢复、当前 Owner 授权、正常外部完成关闭、Windows 进程树清理及权限桥相关行为。

大文件专项使用注入执行器读取文件，权限桥专项也有受控服务依赖；这些测试可以证明相应边界，不能证明真实模型可用。

### 5.2 十组附加内存取证

使用现有 dist 模块直接调用实际函数；问题数据、VCS 视图、创建会话及持久化边界由内存夹具提供。未写项目文件、未启动真实 Agent；处置测试在 store.write 前以哨兵异常中止，恢复临时替换的探针方法。它们证明指定分支的行为，不冒充完整 HTTP/OS 集成验收。

| 编号 | 输入及复现方法 | 实际结果 | 对应缺口 |
| --- | --- | --- | --- |
| P01 | 同一 schema3 问题及选择，分别调用 buildFixPrompt 的 ADDRESS_FEEDBACK / RESOLVE_CONFLICT | 两份提案提示词完全相同 | D01 |
| P02 | 既有 A001，prepareIssuePublication 接收不带 optionId 的新提案，再补齐 a 重试 | 前者最终发布失败，后者成功 | D02 |
| P03 | 新文字问题、有效租约 owner、空 reviewers 配置 | 问题发布报缺少有效负责人 | D03 |
| P04 | Deferred 仅在 dependsOn 放唯一前置 ID，repairPlan 不重复该 ID | 生成的 review.md 找不到该 ID | D07 |
| P05 | 既有记录 updated_at 为 2099，按当前时间生成观察和修订 | 输出 updated_at 比旧值更早 | D08 |
| P06 | repair_failed 且有未解决评论，不传完整 guard 调 FixSessions.create；模拟 turn-end | 创建回调到达并返回 202，turn-end 清除占用 | D06 |
| P07 | pending 问题走 findingDecision/accept_as_is，在持久化前截获 | 决定已追加，status 仍 pending、rejection 仍 null | D05 |
| P08 | repair_failed 问题走 findingDecision/resume_review，在持久化前截获 | status 被置为 pending | D05 |
| P09 | 正常 schema3 账本删去 sha256，调用 validateFullCandidate 并提供对应 patch | 完整校验错误为空 | D08 |
| P10 | 同 finding 的两份旧 v2 记录，分别以正序/倒序传给 prepareIssuePublication | 升级目录随首条记录改变，未要求确认映射 | D12 |

所有写入本报告的结论均再次核对了分支、位置及触发条件。已确认正确的详情方案缓存、原生 SVN 批准定位、常规失败回退和外部完成闭环不列为缺陷。上述计数不是对所有实现细节已经穷尽的保证，后续修订仍须执行相同的审查与复核。

## 6. 后续实施顺序与架构约束

1. **先补阶段与执行边界**：D01、D06；复用 Runner、批准事务、权限桥和占用，避免继续按 schema 或“修复”标签推断权限。验证失败分支始终不自动启动 Agent。
2. **再补问题事实及交付链**：D02–D05、D07–D09、D12；统一稳定身份、时间和摘要校验，前置配置检查，保留单记录和原子提交，不新增第二套发现事实。
3. **统一历史覆盖与自检**：D10、D11，并完成 R01；历史覆盖复用现有阶段机制，不能为修复效果创建审查副本。
4. **每组补反例并回归**：将本报告的触发输入转成可复现行为测试，保留既有正向用例；完成后重跑类型、构建、全量测试及真实环境验收，再重新评定七项设计是否全部完成。

不把文档完成、字符串匹配、模拟执行器通过或旧全量测试通过等同于实现已对齐。提交、同步或还原结果不明时继续保留现场与互斥；不引入自动门禁失败修正、额外成功复核、无授权推送或发布。
