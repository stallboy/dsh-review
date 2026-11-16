# DSH 代码评审插件

> **任务来源**: 用户授权将插件、中央服务与 Web 整理成边界清晰的独立包。
> **任务内容**: 说明插件安装入口及本地、中央托管两种运行方式。
> **参考文档**:
> - `../../SPEC.md` — 审核、DSH 集成和中央模式契约。
> - `../../docs/central-deployment.md` — 中央服务部署与节点配置。
> **生成日期**: 2026-11-16

本包提供 DeepSeek Harness 的评审标签、审核执行能力和中央托管节点。插件标识仍为 `dsh-code-review`。未配置托管节点时使用本地模式；配置后由中央工作台统一发起操作，节点执行实际门禁、Agent 和 Git/SVN 写入。

在仓库根目录执行 `npm ci`、`npm run build:plugin`，然后通过 DSH Plugin Manager 安装 `packages/dsh-plugin` 的绝对路径。也可执行 `npm run pack:plugin`，分发根目录 `dist/dsh-code-review-0.3.0.tgz`；安装包自带所需协议依赖，不包含中央服务或中央 Web。

`src/host` 保存审核执行能力与 DSH 接入，`src/managed` 保存中央通信、持久化执行记录和交付适配，`src/client` 保存 DSH 内嵌界面。插件加载入口为 `dist/index.js`，浏览器入口为 `dist/client.js`。
