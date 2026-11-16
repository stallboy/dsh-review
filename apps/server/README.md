# 中央评审服务

> **任务来源**: 用户授权整理插件与中央服务的包边界和交付方式。
> **任务内容**: 说明中央服务独立安装包的启动入口。
> **参考文档**:
> - `../../SPEC.md` — 中央托管模式契约。
> - `../../docs/central-deployment.md` — 账号、节点、HTTPS、备份和恢复。
> **生成日期**: 2026-11-16

在源码仓库根目录执行 `npm run pack:central`，生成 `dist/dsh-review-server-0.1.0.tgz`。安装包包含中央服务、Web 静态资源及运行依赖，运行环境需要 Node.js 24。

在独立部署目录运行：

```text
npm install /path/to/dsh-review-server-0.1.0.tgz --offline --omit=dev
npx --no-install dsh-review-central user-add --data-dir /persistent/review --username reviewer --review-identity reviewer
npx --no-install dsh-review-central serve --data-dir /persistent/review --host 127.0.0.1 --port 3081
```

创建账号前设置 `DSH_REVIEW_PASSWORD` 环境变量，完成后清除。跨机器部署须使用 HTTPS 反向代理，并传入 `--public-url https://review.example.com`。数据目录须独立于安装目录。

中央进程不执行 Agent、门禁或仓库写操作。另在各 DSH 节点安装 `dsh-code-review` 插件并配置托管连接；本服务无需安装该插件。
