# 评审工作台迁移实施计划

> **任务来源**: 用户要求把整个 DSH「评审」工作台迁到左上角，并确认使用独立仓库设置的方案。
> **任务内容**: 迁移全局入口，移除会话上下文依赖，并运行构建、测试和浏览器验证。
> **参考文档**:
> - `SPEC.md` — 本地仓库解析、中央托管和界面契约
> - `packages/dsh-plugin/src/client/client.ts` — 现有会话入口和评审界面
> - `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md#global-panel-entries` — 左侧栏入口和主区面板注册契约
> - `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md` — 全局面板与窗口顶部留白
> **生成日期**: 2026-11-20

1. 更新 `tests/client-bundle.test.mjs` 和 `tests/plugin-central-ui.test.mjs`。验证两个全局槽的标识对应，无会话时可进入，切换会话后草稿和连接状态保持，本地设置保存所填仓库。
2. 修改 `packages/dsh-plugin/src/client/client.ts`。使用 `sidebar.panellist` 和 `main`，通过现有设置接口配置本地仓库，通过工作台管理中央项目。验证浏览器请求不传会话 ID，宿主聊天输入区不受插件 CSS 控制。
3. 更新 `SPEC.md` 和用户文档，复核现有 API 的兼容性。更新 `tests/browser/review-ui-smoke.mjs`，运行 `npm run typecheck`、`npm run build`、全量 Node 测试和 Edge 浏览器验证。
