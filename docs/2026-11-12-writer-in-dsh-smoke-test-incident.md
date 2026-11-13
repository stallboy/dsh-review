# 2026-11-12 writer-in-dsh 冒烟测试事故分析与改进记录

> 状态：分析已完成；改进在本分支 `worktree-audit-finalize-ux` 实施（见 §5）。
> 关联：`SPEC.md` §7.1/§7.6/§8.2/§10.1、附录 A G43；`docs/dsh-platform-notes.md` §5。
> 性质：过程文档，不具契约效力；契约以 `SPEC.md` 为准。

---

## 1. 摘要

用户在 `F:\workspace_2\writer-in-dsh` 用会话模式做首次全仓审查冒烟测试。审查会话本身**成功完成**
（10:44:47 goal_complete、10:45:01 turn 正常结束），产出 11 个候选修复与 1 份审查档案，全部落盘
`.ai-review/`。但评审面板队列**一个条目都不显示**，且仓库随后被一条隐形租约阻塞。

这不是单点故障，而是**四个缺陷在同一场景下的叠加**：

1. 会话审查的收尾（finalize）依赖用户手动触发，而 UI 没有任何收尾入口（平台缺 turn-end 事件，实现也没补人工入口）；
2. 队列的"本地候选诊断"在**整个 `.ai-review/` 未跟踪**（首次审查的必然状态）时静默失效——`git status` 目录折叠 bug；
3. 1 小时执行超时从租约创建时刻起算，审查实际 55 分钟完成，超时在**完成后 5 分钟**才触发，把成功审查标成 `RECOVERY_REQUIRED`；
4. 租约进入 `releasable` 后**阻塞所有共享写但无任何诊断暴露**，`/health`、`/queue`、面板全部静默。

## 2. 测试过程还原（证据：会话转录 + runtime-state.json + 文件 mtime）

| 时间（本地） | 事件 | 证据 |
| --- | --- | --- |
| 09:50:26 | 面板"启动审查会话"→ `POST /audit/session`；Host 创建租约 `20261112-015026-repo`（active）、跟踪 audit Job、**上好 1 小时超时闹钟** | `~/.dsh/dsh-code-review/runtime-state.json` |
| 09:50:27 | 插件创建审查会话 `session-8d79b7cc`（"仓库审查 · 全仓库"），提示词 queue 模式送达 | 会话转录首条 user/message |
| 09:52–10:11 | 审查 Agent 建立目标 → 4 路后台子代理并行深度审计 → 报告陆续回传 | 转录 4 个 `Background subagent finished` |
| 10:14–10:43 | 逐个生成 11 个候选（改码→跑门禁→导出 001.patch→写 review.md→还原工作区），10:43:44 写完 `audit.md` | `.ai-review/2026-11/` 各目录 mtime |
| **10:45:01** | **审查会话 turn 正常结束**（10:44:47 goal_complete，与 audit.md"执行时间 10:45:00"吻合） | 转录 `turn/end` |
| 10:45–10:50 | 无人触发收尾；Host 无 turn-end 监听，什么都不发生 | — |
| 10:50:26 | 1 小时闹钟到点：租约 active→`releasable`，跟踪 Job 置 `RECOVERY_REQUIRED` | runtime-state.json 落盘 10:50:38 |
| 之后 | 用户打开评审面板：队列空（`items: []`，各状态计数全 0） | 现场 `GET /queue` 复核 |

当时 `git status` 仅一行 `?? .ai-review/`——**整个数据目录 untracked，零共享事实**。

## 3. 根因分析

### R1（直接技术原因，本次新发现）：`listLocalOnlyDirs` 的 git status 目录折叠盲区

按 §7.1 契约，未提交候选本应作为 **local 诊断**出现在队列（带"本地视图"徽标、不计共享 KPI），
`store.list()` 也确实实现了 local-only 合并逻辑。但 Git 数据源用
`git status --porcelain -- .ai-review` 枚举本地目录，而 **git 会把未跟踪内容折叠到最高的未跟踪
祖先目录**：整个 `.ai-review/` 未跟踪时只输出一行 `?? .ai-review/`，按
`月份/候选` 层级解析的正则匹配不到任何条目 → localOnly 集合恒为空 → 队列 items 为空。

- 首次审查（`.ai-review` 无任何提交）**必然**踩中——正是本次事故场景；
- 月份目录整体未跟踪（仅 reviewers.yml 先提交）同样踩中；
- `.ai-review/` 被 `.gitignore` 忽略时 status 输出为空，同样全盲；
- SVN 源同构缺陷：`svn status` 对未版本化目录同样只报目录本身；
- 既有 G10 测试只覆盖"`.ai-review` 已部分提交"场景（折叠发生在候选级、正则仍可匹配），故从未测出。

**修复**：本地视图枚举改用**文件系统 readdir**（工作树问题问工作树），由调用方扣除共享快照集合。
对上述四种情况全部免疫，还省一次 VCS 子进程。回归测试覆盖首审全 untracked、gitignore、提交后恢复三段。

### R2（流程断点）：会话审查没有自动收尾，也没有人工收尾入口

- §7.6 目标契约要求"跟踪会话直到 turn 结束或超时，**随后由 Host 执行收尾**"；
- 但 DSH `sessionController` **没有 turn 结束事件钩子**（`docs/dsh-platform-notes.md` §5，[源码]级核实），
  实现只能停在"跟踪 Job 挂着等用户"；
- `DEVIATIONS.md` 已挂账"会话 turn 事件自动收尾……当前由用户在会话完成后手动执行 `/audit/finalize`"；
- **而 Client 审查面板只有"启动审查会话"和"导出提示词"两个按钮，没有任何 finalize 入口**——
  想手动收尾也无路可走。收尾链路在 UI 层完全断裂。

### R3（语义错位）：1 小时超时从租约创建起算，误伤已完成审查

超时闹钟在租约创建（09:50:26）即上好，从提示词送达算起；审查实际 55 分钟完成，
闹钟在 **turn 结束后 5 分钟**才触发，把一次成功审查的租约打成 `releasable` 并把 Job 标为
`RECOVERY_REQUIRED / SYNC_STATE_UNKNOWN`（"结果不明需恢复"）——对已完成的审查这是误导性定性。
且当时的提示文案只引导 `/audit/release`（丢弃式放锁），只字不提 finalize（本应的默认出路）。

### R4（可观测性缺口）：releasable 租约隐形阻塞

租约 `active`/`releasable` 期间，approve / ai-fix / rebase / sync / 新审查全部 409（§7.7 互斥，
这是正确设计），但阻塞状态**不暴露在任何读端**：`/queue` 无租约字段、`/health` 诊断无此条目、
面板无横幅。Host 重启后内存 Job 列表清空（`/jobs` 为空），持久化的租约成了"看不见的锁"。

### 影响链总结

R2 让候选停留在本地（未提交）→ R1 让本地候选在队列**彻底不可见** → 用户看到"队列为空：仓库
.ai-review 中还没有候选修复"（文案在事实层面也是错的：`.ai-review/` 里明明有 11 个候选）→
R3/R4 让事后排查与恢复更加困惑。四个缺陷两两独立，任一修好都能让事故"可见"，但只有全部修复才闭环。

## 4. 事故现场恢复（writer-in-dsh）

数据完好（抽查 review.md：status=pending、rev1、base_revision 与租约一致、owner=cxs，格式规范）。
合并本分支并重建 `dist/` 后：

- **推荐**：在 writer-in-dsh 的任意会话打开评审面板 → 队列页会出现"审查待处理：执行租约已超时或被取消"
  横幅 → 点"**收尾并提交候选**"。等价 API：
  `POST /dsh-code-review/api/audit/finalize?sessionId=<writer-in-dsh 会话>` body `{"auditId":"20261112-015026-repo"}`。
  收尾会校验 11 个候选并原子提交，随后租约自动释放、条目进入队列。
- **仅当不需要这些候选时**才用"释放租约"（两段确认）：不提交、候选永远留在本地。

## 5. 本分支实施的改进

| # | 改进 | 位置 | 说明 |
| --- | --- | --- | --- |
| F1 | 本地候选枚举改文件系统，修复整目录折叠/gitignore 盲区 | `src/host/shared-facts.ts`（Git+SVN 两源） | R1；`store.list()` 原有的 local 合并逻辑由此生效 |
| F2 | 队列条目新增 `localOnly` 标记，local-only 卡片不进详情、带提示 | `src/host/store.ts`、`types.ts`、`src/client/client.ts` | 详情只读共享事实（§7.1），local-only 点开必 404，明确为不可点并提示"收尾后可用" |
| F3 | `/queue` 新增诊断字段 `auditLease`（auditId/state/trigger/createdAt/owner/baseRevision/sessionId?） | `src/host/api-readmodels.ts` | R4；无阻塞租约时省略，不构成共享事实 |
| F4 | 租约记录会话模式创建的 `sessionId` 并持久化 | `src/host/audit-lifecycle.ts`、`api-context.ts`、`api-audit.ts` | 横幅展示审查会话出处；为将来 turn-end 自动化留锚点 |
| F5 | `/health` 诊断加入阻塞租约条目（含收尾/释放指引） | `src/host/api.ts` | R4；API-only 消费者也能看到 409 的原因 |
| F6 | 队列页租约横幅：active 给收尾入口；releasable 额外给两段式确认的释放入口，并说明释放不提交候选 | `src/client/client.ts` | R2 的 UI 补丁；收尾走标准 audit Job（进度/日志复用现有 Job 卡片） |
| F7 | 队列头部汇总本地未提交条目数；local/local-only 徽标区分 | `src/client/client.ts` | 让"有候选但未提交"一眼可见 |
| F8 | 超时触发文案改为同时给出收尾与释放两条出路 | `src/host/api-audit.ts` | R3 的提示修正（RECOVERY_REQUIRED 语义按 §7.7 保留） |
| F9 | SPEC 同步：§7.6（sessionId、超时出路、G43 过渡期约定）、§8.2（`auditLease`/`localOnly`）、§10.1（横幅与 local-only 卡片）、附录 A 新增 G43 | `SPEC.md` | 契约先行，实现差距显式挂账 |

**未做**（平台依赖，已记入 G43）：turn 结束自动收尾——代码侧已由本分支与并行合并的
`b5e8e74` 共同预留 `onAuditTurnEnd` 可选依赖（宿主提供该钩子即自动收尾），剩余工作在
DSH `sessionController` 侧提供 turn-end 事件。

**与并行工作的整合说明**：本分支开发期间，master 合入了并行会话的
`b5e8e74 fix(contract): 闭合候选修复与审查工作流`（服务端队列过滤、手动租约的
面板内收尾/释放按钮〔内存态〕、`hasLocalChanges` 失败兜底收紧为保守视为 local、
`followAuditTurn` + `onAuditTurnEnd` 可选依赖等）。本分支已将 master 合入并整合：
过滤沿用服务端架构；两处 `releaseAuditLease` 合一（服务端租约优先、内存 id 兜底、
两段式确认）；本地候选枚举、`/queue.auditLease` 横幅、sessionId 入租约、`/health`
诊断、超时文案、`localOnly` 标记等为本分支独有增量。

## 6. 验证

- `npm run typecheck`：通过（host + client 两个 tsconfig）。
- `npm run build`：通过。
- 全量测试：`node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`
  —— **审查处置后 201 pass / 0 fail / 0 skipped**（含新增 2 个回归用例与 /health、/candidate 404 补测；
  断言无放宽，既有用例数量不减——master 侧 199 项 + 本分支 2 项；`waitJob` 轮询预算 160→400
  与测试树内禁用 fsmonitor 为等待/环境参数，非断言放宽）。

## 7. 独立对抗审查结论与处置（2026-11-12）

审查范围：分支 4 提交 vs master，契约符合性（§7.1/§7.6/§7.7/§8.2/§12.2）、冲突整合正确性、
测试充分性、架构安全。结论：**无 P0，修复后可合并**。处置记录：

| 项 | 审查发现 | 处置 |
| --- | --- | --- |
| P1-1 | 全量套件在本机高负载下 2 处失败（Rebase Mode C 轮询预算 8s < 实际 ~10.6s；approve 超时），master 基线同签名复现——既有 flakiness，非分支回归 | 已修：`spec-workflow-closure.test.mjs` 的 `waitJob` 轮询预算 160→400 次（纯等待时长，非断言放宽，按 AGENTS §2.4 显式申报） |
| P1-2 | master 的 `followAuditTurn` 对**任何** turn/end 触发自动收尾——多轮（goal 续轮）会话会在中间轮结束后提前收尾，G43 接线前必须解决 | 已记入 SPEC §7.6 与 G43：自动收尾必须"会话空闲（无排队续轮）"才触发，turn 确认结束时同时解除超时闹钟；接线前必须实现该语义 |
| P2-1 | `/candidate` 对 localOnly 的 404 依赖共享源创建成功；且无测试 | SPEC §8.2 已加"共享快照可建立时"限定与降级例外；新增 404 断言用例 |
| P2-2 | 超时闹钟仍从租约创建起算（仅文案已改） | 并入 G43 行动项（turn 确认结束即撤闹钟）；横幅+收尾入口已使影响可恢复 |
| P2-3 | active 态收尾按钮无防误触 | 已修：active 态两段式确认（第一击亮起"确认收尾（审查仍在执行）"），releasable 单击直收 |
| P2-4 | 本地计数与空态受筛选影响可能误导 | 已修：头部改"当前筛选下共 N 项"；空态区分"真无候选"与"被筛选滤空"两种文案 |
| P2-5 | `blockingLeaseFor` 返回类型未收窄导致读端死代码 | 已修：`BlockingLease` 类型 + 显式类型谓词，读端冗余判断删除 |
| 补测 | /health 租约诊断行无测试 | 已补：租约生命周期用例新增 active/releasable/释放后三个 health 断言 |
| 附带发现 | 全量测试四轮"挂死"（含本分支两轮、审查轮、并行会话在 writer-in-dsh 的两轮 npm test）均卡在 `git add`——本机启用 core.fsmonitor，每个临时 fixture 仓库驻留一个 fsmonitor 守护进程，累计约两千个后 git add 在 IPC 上无限阻塞（卡死时刻与最后一次输出一秒对应，如 11:52:38 / 12:45:41） | 已处置：清理全部僵死 git 进程；`tests/helpers.mjs` 在测试进程树内置禁用 fsmonitor（GIT_CONFIG_* 随子进程继承，覆盖被测插件拉起的 git；不改任何断言）。**建议用户评估全局关闭 fsmonitor**（`git config --global core.fsmonitor false`）或定期清理守护进程 |

## 8. 长期建议（超出本分支）

1. **向 DSH 诉求 turn-end 事件**：`sessionController` 增加会话/回合结束回调或可查询的运行状态
   （`sessionQuery` 投影亦可）。这是会话审查全自动收尾的唯一前置。
2. 超时语义可再进一步：有 turn-end 钩子后，闹钟应改为"turn 结束即 disarm"；在此之前可考虑
   在 releasable 转换时探测会话空闲（需平台能力，暂不做推断式实现）。
3. 空态文案与诊断联动：`.ai-review` 存在内容但队列为空时，明确区分"没有候选"与"有候选但全部
   未提交"（F7 已在头部汇总，空态分支可在 F1 生效后自然少见）。
4. 手动提示词模式（`/audit/manual`）的租约同样受益于 F3–F6，无需额外改动。
