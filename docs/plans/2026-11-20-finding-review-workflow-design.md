# 以发现为中心的审查流程设计

> **任务来源**: 审查流程设计讨论中，用户确认纳入多补丁选择、按发现记录人的决定，以及下轮审查通过工具筛选历史发现并复查。
> **任务内容**: 整理审查产物、人类处理入口和跨轮复查，明确实施文件、顺序及验收。
> **参考文档**:
> - `SPEC.md` §3.1–3.5 — 审查分流、候选正交性和人工审核
> - `SPEC.md` §4.7–4.9、§5.1 — 档案、候选、处置记录和发现投影
> - `SPEC.md` §7.5、§8、§10.2、§16.7–16.8.1、§16.11 — 审批、查询、界面、交付和复查
> - `docs/plans/2026-11-20-human-takeover-follow-up-plan.md` — 人工接手后的复查、修复归因和可选线索
> **生成日期**: 2026-11-20

实施基线为本地 `master` 的 `8d70f9c`，任务分支为 `worktree-finding-review-workflow`。本计划的目标是接入既有 TypeScript Host、DSH 全局工作台和中央 Web，保留 Git/SVN 的提交、恢复和交付适配器。

## 审查产物

每条已确认的发现使用跨轮稳定的 `finding_id`。明确、影响面小且可验证的修复交付一个补丁。存在多个简单且有实际取舍的修法时，默认交付一到两个补丁，确有必要时最多三个。每个方案基于同一基线独立生成和验证，并说明改动范围、取舍和验证结果。复杂或难以安全验证的修复交付文字方案，包含问题证据、建议步骤、待确认事项和验收条件。

## 用户界面与审批

本地插件与中央 Web 的发现详情展示同一组修复选项和三个处理入口。

| 动作 | 界面与结果 |
| --- | --- |
| 接受并应用 | 有一个可审批补丁时直接进入该版本的确认流程。有多个时先选一个，查看差异和门禁，再确认审批所选版本。没有可审批补丁时只显示另外两个处理入口，后端同步校验这一约束。 |
| 本次不修改 | 选择接受现状或延期，填写理由。延期可选填复查日期或触发条件。 |
| 人工接手 | 记录由人跟进，提供复制交接内容的入口。PR、提交号和验证结果可作为辅助线索提交。 |

同一发现的备选补丁互斥。审批在现有仓库锁内重查选中版本和同组审批结果。一个方案成功提交后，其余选项即退出审批。提交结果不明时，复用现有恢复流程，核验前阻止审批同组其他方案。中央继续分别记录业务提交与远端交付。

## 跨轮查询与复查

人的决定、理由和后续改判记录在发现上。候选沿用现有状态机，审批绑定具体补丁版本。

下一轮审查通过工具查询当前共享快照中的历史发现及人的结论，按本轮范围和处置状态筛选。查询结果包含发现编号、相关文件、最近的决定与理由，以及可用的复查条件和人工线索。到期或触发条件已满足的延期项，以及本轮覆盖范围内的人工接手项，进入复查输入。接受现状的记录也可查询，有实质新证据时再提请人判断。

复查沿用已有的只读阶段，结果写入本轮档案。人工接手项凭证据关闭，能可靠归因时补记修复提交。范围未覆盖或证据不足时保留原状态。详细规则见[人工接手后的修复核验计划](2026-11-20-human-takeover-follow-up-plan.md)。

## 实施顺序与验收

每个阶段先增加对应用例并确认旧实现无法满足新行为，再完成实现、跑通过相关用例、独立审查并提交。多补丁和两个客户端的选择界面都属于本次交付。

先接入格式读取与校验时，v2 仍须在审批和旧版档案处置入口被拦截。完成持锁互斥、未决恢复及版本能力校验后，再与产物发布一起开放新版写入。

### 1. 共享记录与投影

- 扩展 `packages/dsh-plugin/src/host/frontmatter.ts`、`types.ts` 和 `audit-archive.ts`。按 §4.9 双读 v1/v2，新增双向关联、当前选项组和处置事件的共享读取。沿用候选版本及状态枚举。
- 接入 `packages/dsh-plugin/src/host/api-readmodels.ts` 的 `/findings` 投影。按共享快照生成 `findingVersion`，保留旧列表语义及范围覆盖判定。
- 验证。扩展 `tests/review-data-validation.test.mjs` 与 `tests/spec-workflow-closure.test.mjs`，覆盖旧样本、缺失或重复选项、非法路径、处置跨轮保留及无关提交后的版本稳定性。

### 2. 审查产物与收尾

- 修改 `packages/dsh-plugin/src/host/audit-stages.ts`、`audit-stage-artifacts.ts`、`api-audit.ts`、`audit-lifecycle.ts` 和 `auditor.ts`，以及 `packages/dsh-plugin/assets/repo-audit-system.md`、`assets/audit/orchestrator.md` 和 `assets/audit/patch/SKILL.md`。让审查产出文字方案或一至三个独立候选，复用现有门禁、工作区复原、格式校验与收尾提交。分阶段会话须把经 Host 校验的发现与选项随原产物封存一起持久化，重启后按同一租约收尾。
- 验证。扩展 `tests/audit-core.test.mjs` 和 `tests/contract-audit-finalize.test.mjs`，覆盖同基线多方案、坏选项排除、零有效选项降为文字方案，以及无关候选继续收尾。

### 3. 处置写入和单选审批

- 修改 `packages/dsh-plugin/src/host/api.ts`、`api-writers.ts` 和 `approval.ts`。复用仓库锁、候选守卫和提交探针；持锁检查发现版本及组内状态，在进入 VCS 前记录待核验信息。只提交选中的候选及其业务文件。
- 修改 `packages/protocol/src/index.ts`、`apps/server/src/commands.ts`、`packages/dsh-plugin/src/managed/managed-operations.ts` 和对应能力声明。仅在两端支持时开放新版写入，复用现有任务去重和交付。
- 验证。扩展 `tests/contract-approve-guard.test.mjs`、`tests/central-commands.test.mjs` 和 `tests/central-rolling-upgrade.test.mjs`，覆盖并发选两项、提交结果不明后重启、无补丁审批、处置冲突、旧端不能绕过及旧候选正常审批。

### 4. 本地工作台和中央 Web

- 修改 `packages/dsh-plugin/src/client/client.ts` 和 `apps/web/src/App.tsx`。同一发现只展示一条主记录。单补丁直达确认，多补丁先选择并查看该版本的差异和门禁，纯文字仅显示另外两个动作。复用现有审批进度。加入交接复制及可选线索入口。
- 验证。扩展 `tests/browser/review-ui-smoke.mjs` 和 `tests/central-web.test.mjs`，检查选择改动后清空旧确认、审批请求绑定所选候选版本、两端无补丁时均无审批入口。

### 5. 跨轮查询与复查

- 修改 `packages/dsh-plugin/src/host/audit-history.ts` 和 `auditor.ts`，把绑定本轮快照的查询用于历史复查。复用同一只读阶段及预算，已解决的接手项写本轮观察，可靠时附修复版本。
- 验证。扩展 `tests/central-scheduled-audit-integrity.test.mjs`，覆盖无人工线索、错误线索、范围未覆盖、可确认解决但无法归因，以及能归因多个提交。

### 6. 全量验收

在隔离工作树内依次执行以下命令，并确认既有测试数未减少、断言未放宽。验证通过后更新两个用户手册中的功能状态。

```bash
npm run typecheck
npm run build
node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
```
