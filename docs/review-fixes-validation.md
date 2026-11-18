# 项目审查问题修复与复审记录

> **任务来源**: 用户要求按照本轮审查结论修复问题，并在完成后复审，确保正确全面、保持设计与架构质量。
> **任务内容**: 修复基于 `1e81bc7` 确认的 11 项问题，补充回归，完成独立复审和全量验证。
> **参考文档**:
> - `AGENTS.md` — 隔离开发、契约验证、提交及两阶段审查纪律
> - `SPEC.md` — 审核、共享事实、恢复、中央托管与 Client 契约
> - 本对话上一轮审查结论 — 6 项 P1、5 项 P2 及原始复现证据
> - `https://github.com/actions/runner-images/issues/12677` — Windows 托管镜像的 SVN 工具变化
> - `https://community.chocolatey.org/packages/sliksvn` — Windows CI 使用的 SVN 命令行工具包
> **生成日期**: 2026-11-18

本次在隔离 worktree 的 `worktree-review-fixes` 分支实施。现有 VCS 适配器、仓库写锁、持久审查租约、节点执行记录、事件确认与 Runner 继续承担原职责。

| 原问题 | 修复行为 | 回归证据 |
| --- | --- | --- |
| SVN 忽略已审核内容核对集合 | 提交前核对完整集合、原始内容、删除和属性，显式非递归提交目标与必要祖先，提交后复核实际内容 | `tests/review-fixes-svn.test.mjs`、`tests/review-fixes-commit-result.test.mjs` |
| 中央模式绕过本地持久租约 | 启用连接前检查恢复错误与全部阻塞租约 | `tests/review-fixes-node.test.mjs` |
| 排队指令使用变化后的本机配置 | 节点登记执行设置摘要，中央持久化并维护配置版本，未决任务阻止真实配置变更，执行器核对摘要 | `tests/review-fixes-central.test.mjs` |
| 停止期间迟到 ACK 启动业务 | ACK 返回后及启动入口检查停止状态，保留受理记录，恢复时核验未启动证据 | `tests/review-fixes-node.test.mjs` |
| 本地 SVN 父目录 BASE 漏读已提交子目录 | 从实际版本化子路径建立固定修订，候选、补丁和档案使用同一快照 | `tests/review-fixes-svn.test.mjs` |
| 不兼容节点通过 ACK 受理新指令 | queued/dispatched 首次受理时检查协议兼容性 | `tests/review-fixes-central.test.mjs` |
| snapshot_moved 永久阻断详情重试 | 退休旧查询并创建新查询，旧回报继续隔离 | `tests/review-fixes-central.test.mjs` |
| 离线节点显示在线 | 联合核对中央、节点、活动实例及真实在线状态 | `tests/review-fixes-node.test.mjs` |
| Git 引号路径解码错误 | 按 C 转义解码 UTF-8 八进制、引号和反斜杠，保留 SVN 实际路径 | `tests/review-fixes-web.test.mjs` |
| AI 修复忽略未提交草稿 | 有意见或行定位草稿时提示先提交，并禁用直接修复入口 | `tests/review-fixes-web.test.mjs` |
| 已批准详情缺少提交定位信息 | 展示派生提交及 found/ambiguous/unknown 诊断，保留历史门禁 | `tests/review-fixes-web.test.mjs` |

独立复审分两阶段执行，先形成发现，再对契约、实际调用链、路径和行号逐项复核。复审发现的以下边界已补充测试并修正。

- 首次登记摘要保留旧配置版本。尚未执行的旧指令经取消、受理、回报与确认链结束，已受理或执行中的旧指令进入核验恢复，保留本地记录与未确认事件。
- 配置版本为 1 时兼容旧详情缓存键，并将其迁移到当前键，离线已有缓存继续可读。
- 未启动证据独立持久化。首次恢复遇到脏现场后，清理现场仍可再次核验并安全结束，已经执行或存在检查点的任务继续保持恢复语义。
- 提交已执行后的完整核验失败使用 `verificationFailed` 明确传播。批准、批准回退新版本、统一共享写和审查收尾均返回恢复状态并保留现场。
- 新 SVN 仓库、未版本化评审目录、既有执行属性、原始二进制、大文件及百分号路径均有回归。
- 提交前核验拒绝仅撤销本次新增调度，保留调用前已有调度及文件内容，追加版本恢复后保持工作副本可继续使用。

中央和节点应配套更新，以使用执行配置摘要登记。旧配置文件和持久数据可由更新后的组件读取。已有摘要不能降级为缺省，实际执行配置变化会推进版本，存在未决任务时拒绝变更。

Web 的草稿修复采用“先提交意见，再启动修复”的现有托管流程。SPEC 中批量意见与 autoFix 的完整组合能力仍受托管执行入口约束，本次通过入口保护解决草稿被忽略的问题。

| 验证项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs` | 409 项通过，0 失败、0 取消、0 跳过 |
| `node tests/browser/review-ui-smoke.mjs` | 12 项通过 |
| 独立契约与架构复审 | 审查及逐条复核通过，无未决 P0/P1/P2，未发现职责边界劣化 |
| `git diff --check` | 通过 |
| CI YAML 解析及三平台矩阵检查 | 通过 |

最终全量运行耗时约 15 分钟。测试数量从 359 项增加到 409 项，新增 50 项针对性回归。完成后复审发现的问题均已补充失败复现、修复并验证。

既有测试调整仅有 `tests/plugin-central-workspaces.test.mjs` 的登记对象精确比较。该处保留所有原字段和行为断言，并新增两个对象的固定执行配置摘要期望，属于跟随固定配置契约收紧，无断言删除或放宽。新增回归均围绕具体失败场景。

三平台 CI 已改为运行全量串行测试、显式准备并检查 SVN 命令行工具，并将超时调整为 40 分钟。本机验证环境为 Windows、Node.js 24。跨机器真实 DSH 与云端三平台运行结果需由相应环境验收。
