# Harness 审查改造实施与复审记录

> **任务来源**: 用户逐项重新确认审查与修复边界后，要求将归纳对照 SPEC 和实现，制定并复审方案，实施后再次复审及测试。
> **任务内容**: 记录 17 组差异的实现结果、独立复审、测试与尚未满足的真实运行验收。
> **参考文档**:
> - `SPEC.md` — 更新后的权威契约。
> - `docs/plans/2026-11-25-harness-review-redesign.md` — 差异清单及已复审实施方案。
> - `AGENTS.md` — 逐条复核、worktree 与验证纪律。
> - `tests/harness-review-boundaries.test.mjs` — Harness、取证、原生进程和权限边界验证。
> - `tests/issue-workflow.test.mjs` — 真实 Git/SVN 的问题记录、审批、迁移与修订收尾。
> **生成日期**: 2026-11-25

## 实施结果

按独立行为计数，共发现并处理 17 组差异，未按文件数量重复计数。

| 差异 | 实施结果 | 核验位置 |
| --- | --- | --- |
| D01–D04 | 移除工具禁用、源码枚举与容量裁剪；原项目 cwd、全项目按需读取、独立复核上下文 | audit-stage-runner、audit-stages、阶段模板 |
| D05–D06 | Agent 直接交付完整 patch；审查生成、发布、收尾和独立候选收尾均只做预检 | audit-stage-artifacts、issue-finalize、api-writers |
| D07 | 默认审查目录可写；显式临时取证文件归档、恢复字节与模式，实际工作区检查；停止不明保持阻断 | audit-session-permissions、audit-stages、win32-job-runner |
| D08–D11 | schema3 一问题一记录，支持文字方案、最多两个有效方案、独立记录版本和不可变补丁账本 | protocol/review、issue-review、frontmatter、store |
| D12 | 同 ID 沿原路径追加观察与方案；档案仅索引；封存允许既有问题更新及证据子目录 | issue-publication、issue-finalize、api-audit |
| D13 | 批准保留历史 patch；Git/SVN 从实际批准记录和业务变更派生原提交 | approval、vcs |
| D14 | 验证失败恢复业务，记录证据/恢复结果并等待人工，不调用 Agent 重试 | approval、store |
| D15 | 外部接手、反馈完成、后续代码证据确认关闭；复发沿原问题重开 | finding-decisions、audit-history、issue-publication |
| D16 | 双端展示同问题多个方案和新状态；显式选择贯通审批/反馈/Rebase/评论；issueWorkflow 能力协商拒绝静默降级 | 两端客户端、protocol、中央 commands、managed-node |
| D17 | 工具事件流与最终结构化结果分别处理，不因多轮工具输出累积超限中止正常 Loop | audit-stage-runner、shell |

新增模块沿现有职责边界拆分：问题字段/选择校验、问题发布、封存收尾、宿主权限桥及 Windows 进程树管理。继续复用原 VCS 原子提交、提交结果分类、审查租约、Job 和共享快照，没有新增第二份可编辑问题事实或独立恢复状态机。

## 独立复审与逐条复核

方案阶段及实施后分别进行数据契约、Harness 执行两路独立只读复审。成立问题逐条回到代码验证并修正，包括：

- 旧已批准记录删除的补丁需从 VCS 恢复；迁移保留人类处置及修复线索。
- 只修订方案 B 时不能覆盖 A，审批、冲突处理、评论与差异不得混用记录版本和补丁编号。
- 人工接管后按共享记录 Owner 授权；跨轮更新保留该负责人，新问题才按路由分配，并拒绝提案擅自改写 Owner。
- 详情刷新追踪当前方案的新补丁，写入仍拒绝旧选择；跨方案行内意见隔离。
- 外部反馈会话的修订有严格收尾入口，只提交问题记录及新 patch。
- 取证先归档还原再核查证据，不用临时伪造的业务文件证明问题；拒绝链接逃逸。
- 正常结束和异常结束都要求进程树停止证明；Windows 通过 suspended→Job→resume 建立后代清理。
- 不继承沙箱的外部委派与工作树写工具按审查会话拒绝。清空审查会话继承的额外写根，工具守卫绑定 Agent 生命周期；插件卸载且停止未确认时保留限制；恢复同 session 的新 Agent 重新安装守卫。
- 定时审查的产物集合接受封存内的问题更新与证据，封存外改动继续阻断。
- 实际桌面 DSH 创建项目会话会采用项目路径；只登记子目录项目时提前要求登记审查根目录，避免会话悄悄改 cwd，不修改用户全局工作区配置。

两路终审当前均无已确认未修复的 P0/P1/P2。此结论是对已审代码范围的结论，不代替下面的真实运行验收。

## 验证

在 Windows、Node.js 24 环境完成以下验证：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，覆盖全部 workspace |
| `npm run build` | 通过 |
| `node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs` | 608 项：606 通过、0 失败、2 跳过；约 30 分钟 |
| 问题生命周期专项 | 10/10 通过，含真实 Git/SVN 与 Owner 授权 |
| 只读预检取消专项 | 1/1 通过 |

两项跳过是既有的历史发布包升级矩阵：未提供 `DSH_PREVIOUS_CENTRAL_PACKAGE` 与 `DSH_PREVIOUS_NODE_PACKAGE`，本次没有新增跳过。测试项从初始 583 增至 608；初始运行期间实现曾发生变化，因此仅作诊断，不称为干净基线全绿。最后一轮在实现源码保持不变的状态下完整运行，退出码为 0。

既有测试没有以删断言换取通过。以下语义更新属于跟随新契约收紧：审查收尾不运行 declared/smoke 修复门禁；验证失败允许新增仅含失败记录的提交但业务必须还原；旧中央不得触发 schema3 审查；取消测试改为在只读预检处确定性暂停，保留不提交、业务不变及租约阻塞断言；阶段 mock 显式证明停止；真实 self-test 读取随机大文件而非返回提示词内样本；UI mock 跟随方案查询参数。

新增行为验证覆盖纯文字、A/B 与 001/002/003、显式选择、失败还原且 Agent 调用数为零、旧历史恢复、外部完成后关闭、反馈修订收尾、原生 Git/SVN 提交派生、取证恢复、正常/超时/取消后的真实 Windows 后代清理及 Cordis 权限隔离。

## 尚未满足的验收

本机 Codex `0.171.0-alpha.13.2` 的真实模型大文件读取 smoke 尚未通过。一次性项目中放置 150 KB 文件和未写入提示词的随机尾行，要求模型调用实际工具读取；CLI 返回读取失败，诊断出现 bundled pwsh 的 exec_command 被 policy 拒绝。另一种受限 MXC 模式同样未取得真实尾行。Claude Code 的真实模型读写边界尚未完成本机验收，不以阶段契约测试替代。

独立 OS 沙箱试验已验证大文件可读、审查目录可写、业务覆盖被拒绝；真实 Windows Job 和 Cordis/ToolRuntime 生命周期探针也已通过。这些结果不能推导本机 CLI 的真实 Agent Loop 已可用。没有通过放开业务写权限、改全局配置或复制凭据绕过该失败。部署前仍应在支持所需逐路径权限的 Harness/CLI 环境运行项目 self-test 并通过实际读取验收。

本次结果位于任务分支 `worktree-harness-review-redesign`；仅提交该分支，不合并、不推送、不发布、不改版本号。
