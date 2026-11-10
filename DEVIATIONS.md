# 当前实现与 SPEC.md 的偏差清单

> **历史批次记录（只读）**：本文件记录第一轮 SPEC 对齐过程中的偏差与修复声明。
> 其中“提交三分支 / 租约互斥已完成”等旧结论已被后续对抗性审查证伪，并已在
> 2026-11-10 第二轮修补中关闭。**当前权威状态以 [SESSION-STATE.md](SESSION-STATE.md) 第 4、6 节为准**；
> 引用本文“已完成”声明前请先核对该文件。

对照基准：SPEC.md（v0.3.0，2026-11-09 契约修订版）。
审查范围：src/host 全部模块、src/client/client.ts、tests/。
本清单经源码逐条复核，引用格式为 `文件:行号`（以本次审查时点为准）。

## 总体结论

附录 A 的 42 项差距中绝大多数仍原样未修；2026-11-09 契约修订的核心变化
（单次原子提交 + VCS 派生、RECOVERY_REQUIRED、判别联合 outcome、
评论锚点、批量评论、拒绝分类、patchCheck、收尾门禁）实现与测试双双缺失。
实现整体停留在旧契约：仍写 `approval.commit_revision` 并做第二次回填提交、
仍用扁平 `audits/*.md`、ConcurrencyGuard 仍只有两字段。

## 一、最高危偏差（共享事实 / 安全语义受损或主流程不可用）

### D1. 提交失败三分支完全未实现（§5.6，G17）
- **批准路径已修复（2026-11-09）**：approval.ts 提交失败后新增 `classifyCommitFailure`——查询 HEAD/提交主题三分支判定（提交已落地→COMMITTED；HEAD 未前进→证明不存在，恢复快照，非撞车返回 COMMIT_FAILED、撞车重试/耗尽；HEAD 前进但主题不符→RECOVERY_REQUIRED/COMMIT_OUTCOME_UNKNOWN，禁止回滚）；提交成功但版本号不可读也返回 RECOVERY_REQUIRED。
- **仍开**：评论/状态/接管/重开等共享写仍不检查 commit.success（api.ts）；Rebase、/convert 仍无三分支；三分支无自动化测试（AC-RECOVERY-01 部分）。

### D2. 批准仍是"两次提交 + 回填"旧模型（§3.4/§5.5，G18）
- **已修复（2026-11-09）**：approval.ts 改为单次原子提交（无回填提交）；store.applyApproval 不再写 commitRevision；frontmatter 移除 commit_revision 序列化（旧值作为未知键落入 extra 只读保留）；/backfill 端点删除；新增 Git `deriveApprovalCommit`（first-parent + --diff-filter=D + git show 父子验证 + diff-tree 核对 target_files），/queue 与 /candidate 为 approved 项附带 `approvalCommitRevision`/`approvalCommitLookup`（内存缓存键 repoRoot|id|快照）；Client 批准信息改用派生字段并区分 ambiguous/unknown 诊断。
- **仍开**：SVN 派生定位返回 unknown（未实现 svn log/cat 验证）；派生无 ambiguous 场景测试（AC-RECOVERY-01 部分）。

### D3. 共享事实 vs 本地视图未区分（§7.1，G10）
- **候选读路径已修复（2026-11-09）**：store.ts 引入 CandidateSource 抽象；新增 GitHeadCandidateSource（绑定单次请求的 HEAD 快照：ls-tree 列目录 + git show 读 review/补丁 + status 检测本地改动）。/queue、/candidate、/patch、/diff、/fix-prompt、批准前重复检查与派生读模型全部改用共享快照；本地草稿/本地改动候选标记 `local: true`（Client 已有徽标），不计入共享 KPI、不作负向记忆来源。
- **仍开**：finding 投影（audit-archive）仍读工作区；SVN 无共享源（回退文件系统）；批准 Orchestrator 内部 reload 仍用文件系统（同锁内，风险有限）。

### D4. 门禁后快照核验缺失（§7.5 步骤 9，G26）
- approval.ts:166-175：门禁后只重读 guard；无业务文件内容/存在性/模式快照对比，
  无索引/提交树逐路径核验，无 `BUSINESS_CONTENT_CHANGED`。
- shell.ts:28-43,102-113：进程组终止不达标——POSIX 仅 kill 直接子进程（无进程组），
  Windows taskkill /t /f 为 fire-and-forget 未等待退出；主进程退出后不清理残留子进程。

### D5. 审查编排整体缺失（§7.6，G20）
- `/audit/manual`、`/audit/finalize`、`/audit/release` 无路由（api.ts:346-387 dispatch）。
- `/audit/session`（api.ts:709-755）不创建 audit 跟踪 Job、无收尾；不参与互斥
  （ensureNoAuditRunning api.ts:1232-1237 只检查 type='audit'）。
- 无执行租约持久化（DSH_HOME 运行时状态），Host 重启互斥无从谈起。

### D6. 人工判断项批准链路断裂（§10.2，G2）
- client.ts:923-969：approve() 仅上行 `{id, expectedRevision, expectedOwner}`，
  不发送 confirmedDecisions/waivedDecisions；无 waive 理由 UI。
- 数据源为正文章节而非 Frontmatter `human_decisions`（store.ts:115 extractHumanJudgment）。
- Host 端 api.ts:1122-1125 已支持两字段，链路断在 Client。

## 二、按附录 A 差距项状态

### 未修复（实现缺失）
| 项 | 现状证据 |
| --- | --- |
| G1 目录式 audit.md 生产者 | **已修复（2026-11-10）**：Auditor 收尾统一经 `finalize()` 生成目录式档案（AuditArchive.writeExisting：frontmatter schema_version/audit_id/created_at(UTC)/base_revision/scope/trigger/previous_audit/candidates/items + 复核块）；audit_id 由 Host 生成（UTC + 同秒追加 -2）；candidates 只含合法候选、A 类正文列表同步过滤（filterAClassSection）；收尾提交只含档案目录 + 合法候选目录 +（首次创建的）reviewers.yml。items[] 由 B/Deferred 解析（finding_id=kind+标题 sha1 前缀，deferred 依赖尽力匹配，未命中用占位依赖并告警——已知限制） |
| G2 人工判断 UI 链路 | 见 D6 |
| G12 /resume | api.ts dispatch 无路由 |
| G17 提交三分支 | 见 D1 |
| G18 单次提交+派生 | 见 D2 |
| G20 会话/手动审查编排 | **已修复（2026-11-10）**：/audit/manual 创建持久化执行租约（DSH_HOME/dsh-code-review/runtime-state.json，statePath 可注入）并返回 auditId+提示词；/audit/finalize 以租约快照执行 Host 收尾并释放；/audit/release 需 confirmStopped:true 且工作区干净；/audit/session 创建跟踪 audit Job（挂起至 finalize/release）+ 租约 + 完整 202 响应；租约参与 ensureNoAuditRunning 互斥，Host 重启后经 init 加载继续阻塞；会话提示词改为严禁 Agent 自行提交（§11.4）。**仍开**：会话 turn 结束事件驱动的自动收尾（现由用户手动 finalize）；/jobs/:id/cancel 不自动置租约 releasable |
| G22 /dismiss-finding | api.ts dispatch 无路由 |
| G23 /ai-fix 前置校验 | api.ts:1174-1223 不检查 unresolved/partial 评论 |
| G29 /candidate/finalize | api.ts dispatch 无路由 |
| G30 /jobs/:id/cancel | 无路由；jobs.ts 无取消能力 |
| G31 非 approve Job result.status | ai_fix 返回 {manual,prompt}/{result,commitRevision}（api.ts:1213-1221）；audit 无 status（auditor.ts:660-675） |
| G32 回退新版本共享提交 | approval.ts:340-346 Runner 成功后新版本只留本地 |
| G33 Rebase 新基线导出 | api.ts:950-956 旧补丁文本+新基线，未导出新 diff 未验证可应用 |
| G35 批准三处重复复检 | **已修复（2026-11-10）**：ApprovalDeps.checkDuplicate 闭包（基于共享快照 list 的 duplicateOf）；批准流程在受理后（步骤 1）、同步后（步骤 6 重跑前置检查时）、门禁后（步骤 9）三处复检，命中返回 ABORTED/DUPLICATE_CANDIDATE + detail duplicateOf。**仍开**：无并发注入场景的自动化测试 |
| G37 /comments/batch | 无路由；store.addComment 无 anchor 支持 |
| G38 拒绝分类/相关符号 | memory.ts:22-32,96-99 无 category/related_symbols，无分组与 stale 弱信号 |
| G39 评论锚点 | 全仓无 anchor 实现（仅靠 I14 extra 意外保留） |
| G40 patchCheck 预检 | 全仓无 patchCheck/checkedBase/checkedAt |
| G41 投影缓存 | audit-archive.ts:305-357 每次全量计算 |
| G42 收尾门禁 | reviewers.ts:11-31 不读取 verify_gate_on_audit_finalize/audit_smoke_commands |

### 未修复（实现有但语义错）
| 项 | 现状证据 |
| --- | --- |
| G3 Owner 路由未接入 | **已修复（2026-11-10）**：收尾校验（verifyCandidates）强制 owner == resolveOwner(reviewers, target_files, tags)，填错即 error → 候选不进入共享提交（有自动化测试：G3 填错 owner → VALIDATION_FAILED + 目录留本地） |
| G6/G24 重开链 | memory.ts:73-76、store.ts:281 只看 reopenedFrom 非空即豁免；投影 converted+rejected 一律 'reopened'（audit-archive.ts:334-339）不沿链；链异常不报 errors；/reopen 不查替代唯一性（store.ts:511-530） |
| G8 操作者/Owner 隔离 | **已修复（2026-11-09）**：api.ts requireOwnerOf——全部候选共享写端点（/comments、/comment-status、/reject、/archive-stale、/reopen、/rebase、/manual-revision、/approve、/ai-fix 含 autoFix 链）校验当前操作者（settings.owner 或 git config 兜底），非 Owner 403 forbidden；takeover 唯一例外。approval.ts approvedBy 仍取 expectedOwner（待改为操作者，低危遗留） |
| G11 guard 完整性 | **已修复（2026-11-09）**：types.ts ConcurrencyGuard 含 expectedUpdatedAt；api.ts guardFrom 解析并校验；store.ts ensureWriteAllowed 按时间点比较；store.ts write 严格单调（nextUpdatedAt：同刻度/回拨 +1ms，UTC Z）；approval.ts reload 与 startAiFixJob 均复检；client.ts guard 上行与 stale 检测已含 updated_at；新增 tests/contract-lock.test.mjs（AC-LOCK-01） |
| G14 判断项精确集合 | approval.ts:20-40 只查覆盖与 waive 理由，无未知/重复/交叉/多余 |
| G15 补丁禁止路径 | patch.ts:183-186 只覆盖 .ai-review/；缺 .tmp/、node_modules/、.git/、.svn/、.git 管理文件、符号链接逃逸（vcs.ts:451-453） |
| G16 ApprovalOutcome 判别 | **部分修复（2026-11-09）**：types.ts 已建完整判别——RECOVERY_REQUIRED（reason: COMMIT_OUTCOME_UNKNOWN/SYNC_STATE_UNKNOWN）、FALLBACK_TO_PENDING 专属 PATCH_CONFLICT/GATE_CHECK_FAILED、ABORTED 补齐 STATE_CONFLICT/DUPLICATE_CANDIDATE/INVALID_CANDIDATE/SYNC_FAILED/BUSINESS_CONTENT_CHANGED/COMMIT_FAILED 并移除非规格值；approval.ts 已改用 INVALID_CANDIDATE/SYNC_FAILED，manual 回退改用 manualPrompt 字段。**仍开**：STATE_CONFLICT/DUPLICATE_CANDIDATE/BUSINESS_CONTENT_CHANGED 等流程分支尚未接入（G19/G35/G26） |
| G19 pending-only 批准 | **已修复（2026-11-10）**：approve 受理前 guard 完整预检（409 stale，含三字段 details）+ 非 pending 409 conflict；Orchestrator reload 区分 guard/状态冲突——非 pending 返回 ABORTED/STATE_CONFLICT（新增 reason）；新增 contract-approve-guard.test.mjs |
| G25 指纹 | memory.ts:18-19 仍 join(',')/join('|')、默认字典序排序（非 UTF-8 字节序） |
| G26 门禁后核验 | **已修复（2026-11-10）**：步骤 7 记录业务文件 sha1/存在性快照；步骤 9 门禁后重算快照比对 + ensureCleanWorkspace 额外脏文件检测，任一不一致返回 ABORTED/BUSINESS_CONTENT_CHANGED 并还原（有自动化测试：篡改目标文件/生成额外文件两例）。shell.ts 进程清理改进：POSIX detached 进程组 + kill(-pid)，Windows taskkill 改为等待完成（仅超时路径，正常退出跳过以避免每命令 +2.5s）。/sync 已入 repo 锁。**仍开**：提交树/暂存 blob 逐路径核验（临时 index）未做 |
| G27 Runner 提交前校验 | 新版本完整校验未在共享提交前完成（与 G32 叠加） |
| G28 baseBranch | vcs.ts:111-131 不接收 baseBranch，固定当前分支 upstream；settings.ts:13,41 从未传入 |
| G36 Job 日志绝对偏移 | jobs.ts:22-25 截断丢最旧行；api.ts:1243-1253 slice(since) 回显、无 earliestLogOffset/logResetRequired |

### 部分修复 / 低危
- G13：audit_id UTC 校验仍用读取机本地时区（audit-archive.ts:179-181；auditor.ts:151 生成侧同为本地时区）。
- G9：完整校验已查 reopened_from 直接目标存在且 rejected（invariants.ts:157-161），但未查"每 rejected 最多一个替代"与成环。

## 三、新发现（附录 A 之外）的偏差

1.【高】会话模式提示词要求 Agent 自行执行 git/svn commit 提交 .ai-review
  （auditor.ts:292-297,341），直接违反 §11.4"Agent 不负责提交，Host 统一收尾提交"。
2.【高】收尾提交 paths:['.ai-review'] 整目录（auditor.ts:640-643），校验失败候选也被提交；
  audit Job 候选校验失败不返回 VALIDATION_FAILED（auditor.ts:660-675）；提交失败仅记 warning 仍按成功返回（auditor.ts:647-651）。
3.【高】/convert 不校验"最新有效观察"（api.ts:1058-1064），旧档案 pending item 可被转换后被新观察覆盖。
4.【高】Owner 路由 AND 语义错：reviewers.ts:127 用 `||`，paths+tags 规则单类命中即参与并可能获胜；
  两类都缺省的规则未显式判无效；default_owner 未强制非空（reviewers.ts:66）。
5.【高】/sync 不经 repo 锁（api.ts:371）；ai_fix Job 体、POST /audit 的 Auditor.run 也不持锁
  （api.ts:1186-1222、776-790）——互斥语义大面积缺口。
6.【中】不变量细节：slug 正则允许 `.` 开头（invariants.ts:45，违反 I1/§4.1）；
  tags 无 trim/ASCII 小写/去重（frontmatter.ts:235-236）；I3 未校验补丁文件名编号一致（invariants.ts:51-64）；
  I5 活跃候选 target_files 可为空（invariants.ts:148-155）；I11 评论 id 候选内唯一性未校验（invariants.ts:74-86）；
  I16 链唯一/成环未校验（invariants.ts:118-122）；reopen_reason 可序列化为 null（frontmatter.ts:364-366）。
7.【中】Git atomicCommit 未带 pathspec 提交（vcs.ts:290 `git commit -m` 无 pathspec/临时 index），
  索引中先前已暂存的其他改动会被一并提交；撞车正则含宽泛 EACCES/EBUSY 可能误分类（vcs.ts:296）。
8.【中】同步成功后未重新绑定快照、未重跑步骤 1-4（approval.ts:123-134）；
  同步失败靠 `/同步失败/` 正则匹配 message，无 SYNC_FAILED/SYNC_STATE_UNKNOWN。
9.【中】Client：队列无 stale/duplicate/local/基线冲突四徽标（client.ts:64-68,895-911）；
  Job 结果按外层 succeeded 显示"完成"（client.ts:1186-1203）；行内评论无 side（client.ts:60-63,624-631 固定 RIGHT）；
  guard 无 expectedUpdatedAt（client.ts:479,514-517）；无 /resume 等端点 UI 入口；非白名单门禁二次确认未实现（G4）；
  顶部无粘性头；approved 读旧 approval.commitRevision（client.ts:1006）。
10.【低】approval.ts:225-226 commitRevision 为空仍返回 COMMITTED；manual runner 提示词嵌 message 而非 manualPrompt 字段；
  /queue configured:false 响应缺 me/repoRoot（api.ts:489-497）；scheduleIntervalMinutes 不过滤 Infinity（api.ts:196-200）；
  PUT /settings 先保存后验证仍返回 200（api.ts:461-482）；/audit/prompt 预览强制工作区干净且缺 auditId（api.ts:674-706）；
  /convert 空字段走 500 而非 400（api.ts:1054-1056）；broken 候选队列显示 pending（store.ts:130-179）。

## 四、测试覆盖缺口（§14.2）

- contract-p5.test.mjs:195 仍断言"commit_revision 回填"提交顺序——**旧契约断言，修复 D2 时必须重写**。
- 全部 21 个测试文件无 AC- 验收 id 引用；多处引用已不存在的旧章节号（§2.3/§4.9/§6.2-6.5/§18.1/§18.8）。
- 完全无测试的验收项：AC-READ-01、AC-LOCK-01、AC-RECOVERY-01、AC-RETRY-01、AC-SETTINGS-01、AC-UI-01。
- 新契约六项（批量评论、评论锚点、拒绝分类、patchCheck、收尾门禁 smoke/declared、提交派生）实现与测试双缺。
- client-bundle.test.mjs 仅覆盖注册/HMR/卸载，不覆盖 UI 行为。

## 五、已符合契约的部分（无需改动）

- 顶层固定键序、未知键往返保留（I14）、空数组/null 表达（frontmatter.ts:299-368）。
- YAML 裸时间对象→UTC Z 规范化；base_revision 裸数字拒绝（frontmatter.ts:33,48-52）。
- VCS：180s 超时、8MiB 有界缓冲、Git 撞车识别（index.lock 等）/SVN out-of-date、严格应用不带 --3way、
  worktree 还原保留 .ai-review/、Git 只 commit 不 push（vcs.ts）。
- 门禁执行器：gateTimeoutMs 逐条、超时 exitCode=null、outputTail 120 行、空列表拦截（validator.ts、shell.ts）。
- Runner：dsh `--profile headless --json -` + stdin、manual/external、默认 30 分钟（runner.ts）。
- 会话权限预设继承（index.ts:135-176）、queue 模式 60s 接受超时（index.ts:224-233）。
- 应用设置默认值、gateTimeoutMs 夹取、temp+rename 原子写（settings.ts）。
- 会话级仓库解析：sessionId 优先、缓存 8 个 FIFO、412 not_configured、200 configured:false（api.ts:301-325）。
- guard 三字段顶层展开（不含 expectedUpdatedAt）、2MiB 上限 413、错误码框架（api.ts/types.ts）。

### 追加批次 5（2026-11-10 终）
- ✅ **G37（Client）**：总体评论草稿列表——多条加入草稿后一次 `/comments/batch` 批量提交（全有或全无、一次共享写入；可选批量+AI 修复）。
- ✅ **G39（Client）**：跨版本重定位展示——行内评论先按 file+line+side 匹配，未匹配且带 anchor 的评论按 `anchor.snippet` 在当前差异中重定位展示（不改写原评论）。
- 全量 121 项测试通过（分组）。

## 最终剩余（环境/平台限制，非实现缺口）

1. **会话 turn 事件自动收尾**：需要 DSH sessionController 提供 turn 结束事件钩子；当前由用户在会话完成后手动执行 `/audit/finalize`（租约与互斥语义完整）。
2. **SVN 真机集成验收**：本机无 SVN 服务器/仓库环境；共享源与派生定位已实现，需在具备 SVN 的环境按 §14.2 AC-READ-01/AC-APPROVE-01 补验收。
3. **Deferred 依赖解析启发式**：B/Deferred 来自自由文本报告，依赖 finding 的精确 id 需 Agent 在报告中按规范标注；未命中时用占位依赖并告警（阻塞转换直到真实 finding 出现）。

## 测试运行注意
本机并行/多文件连跑曾在 TEMP 累积 4000+ 夹具目录时出现假挂起；长跑前清理 `%TEMP%\dsh-*`，并使用 `node --test --test-concurrency=1`。
### 追加批次 4（2026-11-10 下午四）
- ✅ **SVN 共享源**：SvnBaseCandidateSource（svn cat -r BASE 读共享事实、svn list 列目录、svn status 检测本地改动/未版本化目录）；sharedSourceFor 按 VCS 分派（Git=HEAD、SVN=BASE）。
- ✅ **SVN 派生定位**：svn log -v --xml 路径历史查找「M review.md + D 全部补丁」revision，svn cat -r N/(N-1) 验证 approved 状态迁移，target_files 命中；found/ambiguous/unknown 三态。
- ✅ **批准提交暂存集核验（G26 补全）**：Git atomicCommit 在 git add 后逐路径核对 `git diff --cached --name-only` ⊆ 指定路径+删除集合，越界条目 reset 并拒绝提交（防 clean filter/门禁夹带）。
- ✅ **G36（Client）**：Job 轮询使用绝对偏移 `?since=` 增量合并；logResetRequired 丢弃旧日志按快照重建。
- ✅ **G39（Client）**：行内评论提交时从差异行自动构造锚点（被评行原文 + 前后各一行）上行。
- ✅ **I16（读端）**：队列扫描检测"每个 rejected 候选最多一个直接替代"，重复替代报告为队列错误。
- 全量 121 项测试通过（分组）。

**仍开（增强/受环境限制）**：Client 批量评论草稿 UI（Host /comments/batch 已就绪）、G39 跨版本重定位展示（Client 渲染回退）、会话 turn 事件自动收尾（需 DSH session 事件钩子）、Deferred 依赖解析启发式、SVN 真机集成验收（本机无 SVN 仓库环境，仅有实现与单元级路径）。
### 追加批次 3（2026-11-10 下午三）
- ✅ **G24（投影沿重开链）**：projectFindings 重写——converted+rejected 沿 reopened_from 查找**唯一**替代候选（approved→closed、pending/changes_requested→open、无替代→reopened、再次被拒→继续沿链），candidate/candidateStatus 指向链上当前候选；多替代/候选缺失/成环 → errors 报告且不参与正常投影；/findings、/convert、/dismiss-finding 统一经 findingProjection。
- ✅ **G32/G27（回退新版本共享提交）**：fixOrFallback Runner 成功路径先跑全部提交前校验（validateCandidate），通过后由 Host 原子提交新候选目录，成功才返回 FALLBACK_TO_PENDING+newRevision；校验失败恢复备份 RUNNER_FAILED；提交结果不明 RECOVERY_REQUIRED；HEAD 未前进恢复并 COMMIT_FAILED。
- ✅ **G17（其余共享写端点三分支）**：/comments、/comment-status、/takeover、/resume、/comments/batch、/reopen 统一 commitSharedWrite——提交失败时 HEAD 未前进即证明不存在，恢复操作前 review.md 并 500；HEAD 前进不可核对 → 409 conflict（RECOVERY 语义）保留现场。
- ✅ **G41（投影缓存）**：findingProjection 内存缓存（键 repoRoot|VCS 快照，上限 32 条，不跨快照复用）。
- ✅ **I3/I5/I11 细节**：补丁文件名必须为 NNN.patch 与 revision id 一致；活跃候选 target_files 非空；评论 id 候选内唯一、anchor 形态校验（仅行内、snippet 非空）。
- 附带修复：本机"测试假挂起"根因确认为 TEMP 累积 4000+ 个 dsh-* 夹具目录造成文件系统压力（清理后全量一次通过）；夹具补齐 target_files 以符合 I5。
- 全量 121 项测试通过。

**仍开**：SVN 派生定位与共享读取源、批准提交树逐路径核验（临时 index）、G36 Client 增量日志轮询、Client 批量评论草稿、G39 Client 锚点捕获/重定位展示、会话 turn 事件自动收尾、I16 完整层"每 rejected 最多一个替代"读端校验（投影已覆盖运行时判定）、Deferred 依赖解析启发式。

### 追加批次 2（2026-11-10 下午二）
- ✅ **G15**：补丁禁止路径扩展为 .ai-review/.tmp/node_modules/.git/.svn 前缀 + 名为 .git/.svn 的管理文件（patch.ts isAiReviewPath，文本/二进制/删除/重命名解析沿用）。
- ✅ **G29**：/candidate/finalize——无共享 guard，repo 锁 + 本地候选完整性（pending/rev1/approval null/不变量/补丁干净应用/owner 路由/禁止路径）+ 共享目录冲突检查，通过后规范化序列化（tags 去重等）并仅提交该候选目录；ai_fix Job 返回 COMMITTED/VALIDATION_FAILED/ABORTED。
- ✅ **G30**：/jobs/:id/cancel 幂等——已结束返回原结果；运行中置 cancelRequested，批准流程在两个安全检查点（尝试开始/门禁后提交前）读取并安全 ABORTED（已证明无共享提交）；租约不随取消释放。
- ✅ **G39（Host）**：评论 anchor（snippet 非空、仅行内、可选 before/after）解析/校验/序列化往返；/comments 接受 anchor（总体评论携带 → 400）。Client 捕获与跨版本重定位展示未做。
- ✅ **G42**：reviewers.yml 读取 verify_gate_on_audit_finalize/audit_smoke_commands；smoke/declared 模式在收尾对合法候选应用补丁后复算门禁，失败候选剔除（candidates/提交/A 类列表一致），档案收尾说明明确区分“是否由 Host 复算”；默认 none 有明确文案。
- ✅ **G28**：baseBranch 传入 GitAdapter——非空时 fetch + ff-only 推进该分支（当前分支同名则 pull --ff-only），基线取该分支 HEAD；空时沿用 upstream 规则。
- ✅ **细节**：tags 解析 trim/ASCII 小写/去重（§4.3）；slug 正则收紧为不得以 `.` 开头（store.resolveCandidateDir）。
- 新增 tests/contract-round2.test.mjs（5 项）+ contract-gaps；全量 121 项测试分组通过。

### 追加批次 6（2026-11-10 下午，第三轮修复）
- ✅ **提交树核对（P0）**：`vcs.atomicCommit` 的 `verifyEntries/verifyDeletions` 逐路径核对暂存 blob/模式/删除集合，核对失败 fail-closed；批准/收尾/共享写传入已验证内容哈希。
- ✅ **批准共享快照（P0）**：批准补丁从共享快照读取并物化后应用；业务快照含模式；禁止路径应用前拒绝。
- ✅ **精确 decisions/I8**：未知/重复/交叉/遗漏均拒绝；读端 I8 校验 approval 覆盖集合。
- ✅ **全量不变量**：批准、审查收尾、独立 finalize 统一 `validateFullCandidate`（I4/I5/I16 引用目标）。
- ✅ **评论契约**：revision/line/file/side/I12 写端校验；batch 严格全有或全无；Host anchor 兜底提取；/reopen 唯一替代。
- ✅ **审查编排**：Rebase 新基线导出 + 可应用验证；G42 复核块在门禁复算后渲染；finalize 三分支恢复；/audit/manual Job；租约 releasable/release 409；headless audit/ai_fix 纳入 repo 锁；cancel 审查 Job 置 releasable。
- ✅ **其余**：Owner AND/default_owner；同步失败结构化；SVN 共享源本地优先；Windows 门禁/Runner 正常退出清理；负向记忆摘要字段/未知分类；Client stale/patchCheck/Rebase/批量草稿修复；Job 取消信号终止 dsh/external Runner 并等待进程树清理。
- 验证：typecheck/build 通过；全量 145 项测试通过。
- **仍开**：audit 历史复查未解析 items；审计档案未知键 I14；SVN 真机自动化仍缺；会话 turn 自动收尾依赖手动 finalize。

### 追加批次 1（2026-11-10 下午）
- ✅ **G25/G6/G24（负向记忆）**：指纹改规范 JSON 数组 + UTF-8 字节序排序；豁免改为**按候选各自重开链**计算（链上候选只豁免自己的全部被拒祖先，链外同指纹仍阻止，环/缺失链保守停止）；duplicateOf 取 rejected_at 倒序第一条未豁免匹配。
- ✅ **G38**：/reject 接受 category（人工用 stale 422）；Host 删除补丁前从 hunk header 提取 related_symbols 一并留痕；提示词摘要按 category 分组、stale 弱信号标注。
- ✅ **G22**：/dismiss-finding 端点（非空理由、仅最新有效观察 pending、正文 `# 审查项处理记录` 留痕、独立提交）。
- ✅ **G40**：/candidate 附带 patchCheck 三态诊断（git apply --check dry-run；SVN 返回 unknown）。
- ✅ **G34（Client）**：行内评论按行类型创建 LEFT/RIGHT，展示匹配 file+line+side。
- ✅ **G4**：Client 拉取 reviewers 白名单，非白名单门禁命令批准前二次确认。
- 新增 tests/contract-gaps.test.mjs（G38/G22/G40）+ p4 指纹/链豁免更新；全量 116 项测试分组通过。

**仍开**：G29 /candidate/finalize、G30 /jobs/:id/cancel、G39 评论锚点、G24 投影沿重开链、G28 baseBranch、G15 补丁禁止路径全集、G32 回退新版本提交、G27、其余共享写端点三分支、SVN 派生/共享源、提交树核验、G36 Client 增量轮询、Client 批量草稿、G41 投影缓存、G42 收尾门禁、tags 规范化/slug 正则等 I 系细节。

## 六、建议修复顺序

1. ~~**数据层地基**：guard 补 expectedUpdatedAt + updated_at 严格单调（G11）。~~ **已完成**（2026-11-09；全量 103 项测试通过）。
2. ~~**提交事务模型**：三分支恢复 + 单次原子提交 + 派生读模型（G17/G18）。~~ **批准路径已完成**（2026-11-09）：单次原子提交、Git 派生 found/ambiguous/unknown、RECOVERY_REQUIRED/COMMIT_FAILED/MAX_RETRIES_EXCEEDED 语义区分；剩余：其余共享写端点三分支、SVN 派生、三分支自动化测试。contract-p5 旧回填断言已重写。
3. ~~**共享事实读取**（G10）与 Owner 隔离（G8）。~~ **已完成（2026-11-09）**：候选读路径（队列/详情/补丁/差异/重复检查/派生）绑定同一 HEAD 快照，local 诊断不计共享 KPI；全部共享写端点非 Owner 403。剩余：finding 投影共享化、SVN 共享源（全量 106 项测试通过）。
2. **提交事务模型**：三分支恢复 + 单次原子提交 + 派生读模型（G17/G18），同步重写 contract-p5 旧断言。
3. **共享事实读取**（G10）与 Owner 隔离（G8）。
4. ~~**批准编排**（G19/G26/G35/G16）与进程组清理。~~ **已完成（2026-11-10）**：pending-only + STATE_CONFLICT、门禁前后业务快照核验 + BUSINESS_CONTENT_CHANGED、三处重复复检 DUPLICATE_CANDIDATE、同步后重跑步骤 1-4 + SYNC_STATE_UNKNOWN、/sync 入 repo 锁、进程组终止等待（POSIX 组清理 / Windows taskkill 等待）。剩余：提交树逐路径核验、G35 并发注入测试（全量 110 项测试通过）。
5. ~~**审查编排三入口 + 收尾**（G20/G1/G3）。~~ **已完成（2026-11-10）**：目录式档案生产、收尾 owner 路由复核、手动租约三端点 + 持久化 + 互斥、会话跟踪 Job、audit Job result.status（COMMITTED/VALIDATION_FAILED/MANUAL_REQUIRED/ABORTED）、I13 双侧 UTC 语义。已知限制：deferred 依赖解析为启发式；会话收尾需手动 finalize。全量 113 项测试通过（本机需 `node --test --test-concurrency=1` 串行）。
6. **Client 端与体验项（2026-11-10 部分完成）**：✅ G12（/resume 端点 + Client"转回待审核"按钮）；✅ G23（/ai-fix 无未解决评论 409）；✅ G37 Host 侧（/comments/batch 全有或全无、一次提交、状态单次转换；Client 批量草稿 UI 未做）；✅ G2 主体（Client 人工判断改用 Frontmatter human_decisions、上行 confirmed/waived、放弃理由、精确覆盖解锁批准）；✅ G21（Client 按 result.status 展示 COMMITTED/FALLBACK/ABORTED/RECOVERY/MANUAL/VALIDATION_FAILED）；✅ G36 Host 侧（Job 日志绝对序号 + earliestLogOffset + logResetRequired；Client 增量轮询未接）。**仍开**：G34（Client 评论 side/LEFT 创建与匹配）、G39（评论锚点）、G4（非白名单门禁二次确认）、G22/G29/G30（/dismiss-finding、/candidate/finalize、/jobs/:id/cancel）、Client 批量草稿与日志增量、粘性头等 UI 细节。
