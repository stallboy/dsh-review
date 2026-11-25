# 固定候选基线与三方合并审批实施计划

> **任务来源**: 用户确认逐项三方合并并原生交付的方向，要求更新文档后制定实施计划。
> **任务内容**: 先修复 SVN 拒绝块漏判，再接入可验证的三方合并和原生审批交付。
> **参考文档**:
> - `docs/plans/2026-11-25-approval-three-way-merge-design.md` — 已确认的设计和首期范围。
> - `docs/2026-11-25-svn-approval-patch-conflict.md` — SVN 复现和验收条件。
> - `SPEC.md` §3.2、§7.5、§7.7、§16.7、AC-APPROVE-MERGE-01 — 交付契约及回归范围。
> - `https://git-scm.com/docs/git-merge` — 三方合并语义。
> **生成日期**: 2026-11-25

**目标**：修复 SVN 部分应用误判，让独立文本候选能在同一文件发生上下文漂移时逐项安全交付。

**实现结构**：Host 在审批事务内读取原生快照，计算并验证待交付改动。使用临时 Git 环境完成三方合并，通过现有 Git/SVN 事务提交。实现使用 TypeScript、Node.js 24、Git、SVN 和 `node:test`。

**实施边界**：沿用审批入口、工作副本锁、候选状态、原子提交和中央交付。先走原生严格应用的只读预检，能证明完整应用时复用现有提交路径。只有上下文失配且属于首期范围时才启动隔离合并。禁止将已拒绝的合并结果转回严格路径继续提交。

## 任务 1　独立关闭 SVN 部分应用误判

涉及 `packages/dsh-plugin/src/host/vcs.ts`、`packages/dsh-plugin/src/host/scheduled-audit-vcs.ts`、`packages/dsh-plugin/src/host/approval.ts`、`tests/vcs.test.mjs` 和新增的 `tests/contract-svn-approval-conflict.test.mjs`。

1. 用 `svnadmin` 创建本地测试仓库，生成两个补丁块。在目标分别预置不同内容、其中一块已生效、所有块已生效，验证退出码均可能为 `0`。补跳过目标、输出不可完整判定和完整应用成功的用例。
2. 抽出 SVN 输出分类，识别拒绝、跳过、`already applied`、工具失败与结果不明。审批据此拒绝部分或全部已应用的补丁。收尾、逆补丁和显式 Rebase 如复用分类，应保留各调用方既有契约，避免为了修审批而改变其他入口策略。预检和实际应用均须核验，不能用日志尾部判断成功。回退仅撤销本任务可归属的文件和调度，并验证恢复；遇到外部改动或无法证明归属时保留现场。
3. 回归断言覆盖 `FALLBACK_TO_PENDING / PATCH_CONFLICT`、未进入门禁、业务工作区恢复、旧候选仍为 `pending`、原生仓库没有业务提交。分别运行下面的验证命令，结果应全部通过。把修复独立提交，合并通过后更新 SVN 缺口记录。

```bash
npm run build:plugin
node --test --test-concurrency=1 tests/vcs.test.mjs tests/contract-svn-approval-conflict.test.mjs tests/central-scheduled-audit-integrity.test.mjs
```

## 任务 2　固定候选来源并读取原生目标快照

涉及 `packages/dsh-plugin/src/host/vcs.ts`、`packages/dsh-plugin/src/host/store.ts`、`packages/dsh-plugin/src/host/auditor.ts`、`packages/dsh-plugin/src/host/api-writers.ts` 和新增的 `tests/approval-merge-snapshots.test.mjs`。仅在既有可信事实无法验证基线绑定时增加必要的元数据及兼容读取。

1. 先写用例覆盖 Rebase 和修复后的新 `base_revision`、浅克隆缺失历史、SVN 同 revision 切换路径、SVN 根 revision 不变而目标文件的版本变化。加入旧候选和未安装 Git 的 SVN 工作副本，确认原生严格批准仍可用。
2. 从受信的项目绑定及历史建立来源。需要增加记录时，由 Host 在审查收尾、Rebase 和 AI 修复写入当前版本的绑定，禁止用当下的 SVN URL 推断历史来源。目标快照从实际原生工作副本建立，记录 Git 提交或 SVN 工作副本绑定与目标路径级基线。已知的仓库身份或目标不匹配必须拒绝。
3. 读取层只输出候选路径的字节、路径级基线和必要元数据。现有 `readFileAt` 返回字符串，适合历史元数据读取，审批验证使用独立的有界字节读取，区分文件缺失、读取失败及输出超限。对 Git 过滤器和换行转换、SVN 属性或工作文件字节与原生内容不一致的情况，继续使用原生严格路径。快照读取不更改正式工作区，也不为合并自动拉取缺失历史。

```bash
npm run build:plugin
node --test --test-concurrency=1 tests/approval-merge-snapshots.test.mjs tests/contract-business-base.test.mjs tests/contract-vcs-derived.test.mjs
```

## 任务 3　隔离合并并核对最终差异

新增 `packages/dsh-plugin/src/host/approval-merge.ts` 和 `tests/approval-merge.test.mjs`。复用 `packages/dsh-plugin/src/host/patch.ts` 的补丁路径解析和现有路径校验。

1. 先用 20 行文本测试第 5 行和第 7 行分属两个候选。要求两个批准顺序的最终内容相同，且每次只加入当前候选的修改。另写同一行冲突、插入引发行号变化、重复文本位置不唯一、部分已生效、全量已生效、额外变化和首期范围外变更的用例。
2. 在正式工作副本之外构造最小临时 Git 环境，严格将补丁应用到来源并验证涉及路径，再计算合并。隔离 Git 配置、hooks、合并驱动和过滤器。设定可验证的输入与命令输出边界，复用现有超时、取消和进程清理机制。原生路径可完整处理的审批不创建临时 Git 环境。超时、取消、工具异常和清理失败分别验证，保证正式工作区和共享记录未被改写。
3. 以来源到候选、目标到合并结果两份逐路径编辑序列做等价性校验。比较修改前后内容与可唯一映射的定位。插入须能映射到同一边界。行号不同可以通过，只比较行内容或补丁块统计不足以沿用批准。对重排、移动或重复内容，只有能证明是同一修改位置才允许通过。先证明能接受第 5 行与第 7 行的相邻改动，再接入审批。

```bash
npm run build:plugin
node --test --test-concurrency=1 tests/approval-merge.test.mjs
```

## 任务 4　接入审批、门禁和原生交付

涉及 `packages/dsh-plugin/src/host/approval.ts`、`packages/dsh-plugin/src/host/api.ts`、`packages/dsh-plugin/src/host/vcs.ts`、`packages/dsh-plugin/src/client/client.ts` 和新增的 `tests/contract-approval-merge.test.mjs`。

1. 先添加 Git 和 SVN 端到端审批用例，验证 A→B、B→A、同期目标修改、真实冲突、合并结果改变、组合门禁失败和审批期间的目标漂移。使用真实的本地 Git 与 `file://` SVN 仓库，断言原生版本历史和实际文件内容。
2. 将计算接入 §7.5 的持锁审批事务。区分文本上下文失配、补丁已应用、补丁无效和工具异常。只有首种情况尝试三方合并。SVN 报告非零 fuzz 时视为上下文失配，行号偏移且上下文完整匹配时沿用严格应用。工作副本锁只约束 Host 写入。写入前及门禁后检查目标绑定、原生基线和涉及路径的基线或属性。正式写入后立即核对文件内容、路径和模式与计算结果相符，再跑门禁并沿用既有 guard 和原子提交核验。覆盖门禁或外部 VCS 改动 SVN 子路径但根 revision 不变的情况。撞车后仅在证明未提交并完成恢复时重算，已进入远端交付的提交继续走原交付核验。
3. 复用 `fixOrFallback` 和候选版本校验。文本冲突或改动不等价时，关闭自动修复则保持 `pending`，启用时只允许提交新候选版本，等待重新审批。核对同一发现只批准一个选项、无额外业务文件落库、中央仍按 §16.7 呈现业务结果和远端交付状态。补并发、取消、提交结果不明和门禁改写内容的回归检查。
4. 更新本地工作台的预检提示，说明严格应用预检只是诊断。分阶段验收，先放行 SVN 修复，再上线审批合并。除全量测试外，对新增用例核对无历史、无 Git、超限或取消时的拒绝和恢复路径，以及无需合并的审批未启动额外 Git 工作区。分别审查 SVN-only 环境、Windows、Ubuntu 和 macOS 的行为。实现阶段按仓库约定在独立 worktree 提交并保存验证结果。

```bash
npm run typecheck
npm run build
node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
```

完成标准为 Git 与 SVN 的两种批准顺序均得到相同的预期业务内容，冲突和变更不能沿用旧批准，门禁、原生原子提交及恢复语义通过回归。完整测试应在 Node.js 24 且 `git`、`svn`、`svnadmin` 均可用的环境执行。
