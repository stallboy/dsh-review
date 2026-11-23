# 统一仓库审查流程实施计划

> **任务来源**: 用户确认三种启动入口共用 Host 编排和报告契约，随后要求开始实施。
> **任务内容**: 接通 DSH 会话、Headless 和外部手动入口，统一发现在报告中的等级、排序和校验。
> **参考文档**:
> - `SPEC.md` — §3.1、§4.7、§7.6、§11.3、§16.11
> - `docs/plans/2026-11-20-dsh-multi-runner-audit-prompt-design.md` — 阶段工具与证据隔离
> **生成日期**: 2026-11-23

## 实施顺序

1. 在 `audit-stages.ts` 固化优先级发布规则。在 `auditor.ts` 同步过滤失效候选。给现有阶段测试补充 P0/B、P1/Deferred、P2/A 的跨分类断言。
2. 在 `api-audit.ts` 将执行与发布绑定审查租约。保留 DSH 会话归属检查。从 Headless 和外部手动入口接入相同阶段调用。验证缺少有效租约、未完成复核或无发布清单时的状态。
3. 在 `host/index.ts` 和托管节点连接层接通相同阶段能力。中央远程和本机进程共用接入逻辑。保留定时互斥、固定基线、历史复查和取消语义。为 Git 和 SVN 使用各自基线视图与候选验证。
4. 更新 `SPEC.md`、模板和入口测试。现有旧租约使用其创建时的路径完成或恢复。新租约按统一流程发布。验证历史档案读取和中央节点交付。
5. 运行 `npm run typecheck`、`npm run build` 和 `node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`，复核报告格式、契约和工作区状态。
