# 契约实施计划（2026-11-05 起）

目标：把 `2026-11-03-review-workflow-data-design.md`（commit `bda37f6` 时的契约）落进 `src/host` 实现。
回滚节点：git tag `pre-contract-impl-20261105`（`36aaa12`）。
约束：`schema_version` 保持 1；未知字段保留；每阶段测试全绿后提交一次；只 commit 不 push。

## 阶段与验收标准

| 阶段 | 内容 | 验收标准（全部需有测试用例） |
| --- | --- | --- |
| P1 数据模型与读写层 | types.ts 扩展 review.md 全字段：`module`、`audit_type`(9 值)、`updated_at`、`human_decisions[]`、`rejection`、`commit_message`、`revisions[].author`、`comments[].side`、可选 `reopened_from/reopen_reason`；§2.3 固定键序序列化；reviewers.yml 增 `allowed_gate_commands/stale_days/rejection_memory_days/max_anti_patterns` | ① 往返序列化不丢任何字段（含未知嵌套键）② 键序断言符合 §2.3 ③ I2/I3/I11/I14 有正反用例 |
| P2 校验层（§13） | 独立 invariants 模块；队列读取时 broken 隔离（I1–I5、I11–I14、I16）；audit 校验（I1、I9、I10、I12、I13） | 每条不变量至少 1 正 1 反用例；无效候选不使队列崩溃 |
| P3 拒绝与超时归档 | reject 写完整 `rejection`；新增显式「归档过期候选」API（`system:stale`，乐观锁只写一次）；队列加载只提示不写 | 拒绝后无补丁残留；重复归档被拒；提示不产生共享提交 |
| P4 负向记忆与重开 | 指纹（module+排序 target_files+audit_type+规范化 title）；窗口过滤；队列阻止；`reopened_from/reopen_reason` 人工重开（I16，仅人工） | 窗口内完全重复被阻止；带重开字段的放行且注入仍生效；AI/自动路径无法写重开字段 |
| P5 批准强化 | `approval` 扩展：gate_checks 快照 + gate_results + confirmed/waived_decisions；commit_message 首行==title 校验；human_decisions 全覆盖校验 | 未确认判断项不能批准；批准记录含快照与逐条结果；标题不一致不能批准 |
| P6 audit.md 新契约 | 目录式 `audits/<audit_id>/audit.md`；批次字段 + items（finding_id/kind/status/candidate）；§3.4 投影（覆盖判定/最新观察/当前状态/可见性）；旧扁平报告不参与投影 | 投影规则 4 条各有用例；converted↔candidate 一致性（I9）；历史 audit 不被重写 |
| P7 B/Deferred 转候选 | 转换 API：depends_on 满足判定、两侧同一提交、失败恢复 | 单边成功被阻止；未满足 depends_on 拒绝转换 |
| P8 人工微调与 Rebase | 隔离工作区人工微调（author: human）；Rebase 新版本（author: ai，重跑门禁） | 新版本基线正确；半版本不留存 |
| P9 定时审查 + 会话路由注入 | 定时触发入队；审查会话启动时把 reviewers 解析结果注入提示词 | trigger 字段正确；路由结果出现在提示词 |
| P10 流程保证收口 | 检出级写互斥；审查提交前目录不存在校验；`commit_revision: null` 回填恢复提示；批准后重同步重复检测 | 并发写被串行化；同秒目录冲突失败重试；null 回填被提示 |

## 总验收

1. `npm test` 与 `npm run typecheck` 全绿。
2. §12 验收重点逐条映射到测试（文档化在测试注释或名称）。
3. README「已知边界」按实际落地情况更新。
4. 每阶段一次独立提交，diff 只含本阶段范围。

## 进度

- [x] P1 数据模型与读写层（commit `c7ab2d8`，6 项验收测试）
- [x] P2 校验层 §13 不变量与 broken 隔离（`35c3d8f`，9 项验收测试）
- [x] P3 拒绝与超时归档（`5546abd`，3 项验收测试：只提示不写 / system:stale 只写一次 / 未过期与未配置拒绝）
- [x] P4 负向记忆与人工重开（`9caf840`，5 项验收测试：指纹/窗口/阻止/重开豁免/重开 API）
- [x] P5 批准强化（`25bf501`，2 项端到端验收：判断项全覆盖+标题一致拒绝路径；快照/结果/决定留痕+业务提交用 commit_message）
- [x] P6 audit.md 新契约与投影（`f87741d`，5 项验收：往返+不变量正反例、目录冲突、updateItem 不重写历史、投影四规则、/audits /findings API）
- [x] P7 B/Deferred 转候选（`c225bf6`，3 项验收：confirm 两侧同一提交、deferred depends_on 门控（resolved/approved 满足，pending/无观察/归档候选阻塞）、投影联动）
- [x] P8 人工微调与 Rebase（`776a9c7`，2 项验收：Rebase 基线门控+新版本 author ai+工作区干净；manual-revision 坏补丁不留半版本+author human）
- [x] P9 定时审查 + 会话路由注入（`5c4ae1a`：审查提示词注入 reviewers 解析结果；scheduleIntervalMinutes 定时创建 scheduled 会话）
- [x] P10 流程保证收口（`5c4ae1a`：检出级写互斥——并发归档恰好一次成功；目录冲突校验见 P6；approved+commit_revision=null 队列 needsBackfill 提示）

## 总验收

- `npm test` 94/94 全绿（含 34 项契约验收测试 contract-p1…p9p10），`npm run typecheck` 双 program 通过。
- README「本机 API」「已知边界」已按实际落地更新（新端点清单、落地状态、剩余边界：审查会话改写新档案格式、UI 面板、多克隆互斥）。
