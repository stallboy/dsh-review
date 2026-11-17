# 插件中央连接与项目接入实施计划

> **任务来源**: 用户认可本机托管、已有中央连接、项目选择接入及生命周期规则，要求补充文档后开始实现。
> **任务内容**: 落实已认可设计，完成回归验证与独立审查，仅提交任务分支。
> **参考文档**:
> - `../specs/2026-11-17-plugin-central-design.md` — 本轮设计与验收要求。
> - `../../../SPEC.md` — 唯一权威契约。
> - `../../../AGENTS.md` — 工作区、测试及两阶段审查纪律。
> **生成日期**: 2026-11-17

执行方式：使用 subagent-driven-development 按文件边界分派独立组件，主执行者负责连接控制器、集成与验证。用户已明确要求开始实施，不重复请求实施许可。

## 目标与约束

中央提供持久身份、受鉴权的节点项目接入、私有 IPC 启动入口；插件控制连接、进程、项目及网关；既有审核核心与包边界保持。Node.js >=24，UTF-8，新代码四空格缩进，默认不加注释。新增中央能力先同步 SPEC，任何测试不得减少或放宽断言。

## 审查重点

1. 中央更换或不可达时，旧执行记录不能丢失或被新的中央接管。
2. 快速连续应用、停止、插件重载与进程异常不能产生重复节点或孤儿进程。
3. 网关只能访问固定中央，Cookie/Token 不跨中央、浏览器会话或 DSH 路由泄露。
4. 同名不同目录、嵌套会话目录、链接路径及同远端不同副本不能错误合并。
5. 整合包不能借助源码路径或 workspace 链接才能运行。

## 任务 1：中央身份、接入接口与私有启动入口

文件：`apps/server/src/database.ts`、`app.ts`、新增 `owned.ts`，`tests/plugin-central-server.test.mjs`。

接口：公开 `GET /api/v1/info` 返回 `{centralId, protocolVersion}`；节点鉴权 `POST /node-api/v1/status` 返回 `{centralId, nodeId, projects, pending}`；`POST /node-api/v1/projects/ensure` 接收 `{instanceId, workspaceId, name, enabled, restore?}`，恢复已有绑定只返回中央现值，显式请求才变更；`POST /node-api/v1/disconnect` 释放自身实例在线标记并保留恢复。

复核裁定：新增 `/quiesce` 原子检查未决并暂停受理；配置注册使用 `x-dsh-review-admission: paused`，ensure 完成后 `/activate`。同实例续注册保持中央暂停状态，新实例依靠独立租约防抢占。

私有入口接收 IPC `{type:'start',dataDir,reviewIdentity,password,node?:{nodeId,token}}`，只监听 127.0.0.1 动态端口，回复 `{type:'ready',centerUrl,centralId,nodeId,token}`；停止消息或父 IPC 断开后退出。首次本地账号固定 username=local，已有身份不静默改写。

- [x] 先新增测试并确认失败：身份持久、信息无秘密、节点越权拒绝、接入幂等及未决阻止、IPC 生命周期。
- [x] 实现上述最小接口，保持现有用户/节点鉴权隔离。
- [x] 构建后运行 `node --test tests/plugin-central-server.test.mjs`，预期零失败。

## 任务 2：连接控制器、进程监督器与网关

文件：新增 `packages/dsh-plugin/src/connection/{config,local-process,controller,gateway}.ts`，修改 `managed-config.ts`、`managed-node.ts`、`managed-journal.ts`，新增 `tests/plugin-central-connection.test.mjs`、`plugin-central-gateway.test.mjs`。

接口：控制器 `init()` 恢复已启用配置，`status(sessionId?)` 返回脱敏设置/运行状态/候选/项目与 controlToken；`handle(req,res)` 处理 `/dsh-code-review/connection` 前缀管理接口及 `/dsh-code-review/central` 网关；`stop()` 终止其资源。管理接口 GET 根状态；POST `/test` 测试地址和节点凭据；POST `/apply` 保存并启用连接；POST `/stop` 持久停用；POST `/projects` 通过候选 ID 接入或启停。

实例化输入：`{directory, candidates(sessionId?):Promise<Candidate[]>, resolveCredential, localEntry?}`。新连接配置不存在时不取代原本地/legacy 节点；已保存新配置即由控制器接管。检测旧托管配置时从服务端拒绝直接覆盖并说明迁入步骤；原本地写入口在任何已配置中央状态下均不开放。

- [x] 先测试编辑不启动、真实子进程启动/停止、零项目、重启恢复与显式停用、外部中央不受进程停止影响。
- [x] 测试未决指令、本地未确认 outbox/执行记录阻止切换，中央身份变化拒绝旧身份，配置秘密不回传。
- [x] 实现真实目录候选与稳定 ID、串行配置变更、每中央独立数据目录和单实例保护。
- [x] 先测试真实 HTTP 登录/CSRF/资源，再实现固定目标网关、会话 Cookie 容器、子路径和节点 API 拒绝。
- [x] 新增用例与既有 central-node/operations 用例运行，预期零失败。

## 任务 3：插件界面、Host 集成与前端基础路径

文件：`packages/dsh-plugin/src/client/client.ts`、`host/index.ts`、`tsconfig.host.json`；`apps/web/index.html`、`vite.config.ts`、`src/api.ts`、`src/main.tsx`；`tests/client-bundle.test.mjs`、新增 UI 回归。

接口：插件控制台调用任务 2 的固定接口；所有管理写请求携带 `x-dsh-review-control`。连接表单只在点击“应用并启动/连接”后生效。项目列表允许用户接入/停用，iframe 使用 `/dsh-code-review/central/`，当前项目通过既有中央项目 URL 定位。原本地 App 保留在“本地评审”入口。

Host 从 workspaceRegistry 与 session.cwd 提供可信候选，浏览器不能指定任意路径。新配置存在时只启动新控制器节点；卸载调用 stop。Web 从 HTML base 获取基础路径，Router、API、静态资源统一适配；根路径访问不回归。

- [x] UI 测试先失败，覆盖表单选择无启动请求、按钮明确应用、项目各自标识、工作台 iframe 与管理请求令牌。
- [x] 集成 Host 生命周期及候选发现，保持已有 API 与 legacy 配置行为。
- [x] 构建并运行客户端与中央 Web 回归，预期零失败。

## 任务 4：整合包、全量验证与交付记录

文件：`scripts/pack.mjs`、根 `package.json`、新增整合包测试；更新部署/用户指南，新增本轮验证记录。

- [x] 新增 `pack:local`，在暂存插件包内加入独立中央运行目录；普通插件包继续不含中央。
- [x] 隔离安装整合包并通过私有入口实际启动中央，验证父进程停止后退出。
- [x] 执行 `npm run typecheck`、`npm run build`、`node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`；记录与基线数量比较。
- [x] 独立契约/架构审查，逐条复核后修复成立问题，再运行受影响验证。
- [x] 清理本任务 `.tmp`，更新计划完成状态与验证文档，提交中文变更说明；不 push、不合并主副本。

## 修改后审查修复阶段

任务来源：用户要求对提交 `3a7a042` 修改后审查，确认两项 P1 和两项 P2 后，明确要求执行修复。延续原计划，仅增加本阶段。

参考：`SPEC.md` 的 AC-PLUGIN-CENTRAL-02/03/04/05/06、原设计和验证记录；审查定位为 `connection/controller.ts:125/211`、`client/client.ts:758`、`connection/gateway.ts:67`（修复前行号）。

- [x] 先红后绿：失效锁并发恢复与进程退出释放测试；采用 SQLite 排他事务维护配置所有权，不再删除基于旧 PID 读取结果的锁文件。
- [x] 先红后绿：停用项目目录缺失仍恢复其他项目；故障状态允许在确认无未决任务后停用坏项目，保留历史和中央已有配置。
- [x] 先红后绿：legacy 配置仍可访问已有中央，保留本地写隔离及禁止直接覆盖配置。
- [x] 先红后绿：同 hostname 不同端口网关共用浏览器 Cookie 存储时互不挤掉登录；Cookie 按 DSH 实例命名空间隔离。
- [x] 同步设计、契约和验证记录；执行类型检查、完整构建和全量测试，344 项全部通过，既有测试不减少、断言不放宽。
- [x] 独立两阶段复核修复，无未决 P0/P1/P2；清理临时文件并提交本分支，不推送或合并。

## 实际冒烟反馈后的界面优化

原实现及修改后审查修复完成并合并后，用户实际使用反馈四项界面问题，已确认修复方案。后续任务继续记录在 [评审界面冒烟反馈修复计划](2026-11-17-review-ui-smoke-fixes.md)，不替换上述已完成阶段。
