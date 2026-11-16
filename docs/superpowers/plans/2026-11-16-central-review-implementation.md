# 中央评审 Web 实施计划

> **任务来源**: 用户完成方案讨论、原型审阅和中央服务讲解后明确认可方案，进入已授权的实施阶段。
> **任务内容**: 实现中央单体服务、多机器 DSH 节点、真实 Web 管理及审核闭环；逐阶段验证，完成独立审查。
> **参考文档**:
> - `docs/superpowers/specs/2026-11-16-central-review-web-design.md` — 已认可的架构、范围及工程默认值。
> - `docs/plans/2026-11-16-central-web-discussion.md` — 原始决策、原型位置和延期事项。
> - `SPEC.md` — 实施中同步扩展的权威契约。
> - `AGENTS.md` — worktree、独立审查、全量验证及提交约定。
> - `https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/` — HTTP schema 校验。
> - `https://vite.dev/guide/` — 前端构建；具体依赖锁定到实际兼容版本。
> **生成日期**: 2026-11-16

> **执行方式**: 在当前会话逐项推进；遵循 test-driven-development、executing-plans，完成后由独立代理审查。既有设计确认已提供实施授权，常规实现步骤不重复请求确认。

**目标**: 一个中央进程服务多个独立 DSH 插件节点，Web 查询真实评审数据并执行经节点验证的审核操作。

**架构**: 中心只管理身份、节点、项目、持久化指令及只读查询视图；节点继续执行现有审核核心和 VCS 操作。中央单实例 SQLite，节点主动 HTTP 通信，工作副本固定绑定。

**技术**: TypeScript、Node 24、Fastify、SQLite；React、Vite、React Router、TanStack Query、CSS Modules。

## 全局约束

- 当前分支 `worktree-central-review-web`，基线 `36ce954`。当前目录已是独立 Git worktree，不创建嵌套副本。
- `.ai-review/` 是评审事实源，中心缓存不可用于批准依据。
- 首期同时支持 Git/SVN；所有共享写同步远端，Git 本地提交与远端交付分离。
- HTTP 写操作经可信身份、版本 guard、节点工作副本校验和现有锁/租约执行。
- 指令、受理及结果持久化；断线、取消和重启不等于可重跑或可释放占用。
- 同一项目至多一个未决写指令，首期固定节点，不自动故障转移。
- 已有本地模式和测试保留；4 空格缩进，默认不新增解释做什么的注释。
- 临时脚本和测试输出放 `.tmp/`，最终清除；不提交构建产物、node_modules 或凭据。
- 不实现延期的历史复查及定时审查编排。

## 文件边界

| 路径 | 职责 |
| --- | --- |
| `packages/protocol/src/index.ts` | 节点、项目、指令、快照、事件与查询的共享类型和验证 |
| `apps/server/src/database.ts` | SQLite 平台状态、事务、身份和持久化记录 |
| `apps/server/src/auth.ts` | 密码校验、用户会话、CSRF、节点 Token |
| `apps/server/src/app.ts`、`cli.ts` | Fastify API、静态页面、启动与管理员引导 |
| `src/host/managed-node.ts`、`managed-journal.ts` | 主动通信、受理防重、回报、快照同步和恢复 |
| `src/host/managed-operations.ts` | 类型化审核入口及受信操作者上下文 |
| `src/host/index.ts`、`api.ts`、`api-context.ts`、`jobs.ts`、`vcs.ts` | 必要的宿主接线、项目隔离、任务记录和远端交付 |
| `apps/web/src` | 已认可原型的正式 React 页面及接口层 |
| `tests/central-*.test.mjs` | 中心及节点新增的行为和集成测试 |
| `docs/central-review-deployment.md` | 部署、项目接入、凭据和恢复操作说明 |

## 审查重点

1. 节点凭据、项目绑定、instanceId 或配置版本错配必须拒绝执行，不能靠客户端自报身份。
2. 重复 HTTP 请求、重复投递、ACK/终态回报丢失与中央重启不得重复业务提交。
3. 节点重启或掉线时，未决任务和工作副本占用保留；取消控制仍可被忙碌节点接收。
4. 快照乱序、旧绑定、缺失附件和缓存版本漂移不得混入同一次审核读取。
5. Git 远端已收但响应丢失、非快进拒绝，以及 SVN 提交结果不明，不得被当作普通失败重做。

## 任务 1：契约、共享协议和构建边界

**文件**: `SPEC.md`、根 `package.json`/lockfile、新增协议 workspace 及其 tsconfig；`tests/central-protocol.test.mjs`。

**接口**: 导出 `PROTOCOL_VERSION`、`ManagedCommand`、`NodeRegistration`、`ProjectSnapshot`、`NodeEvent`、`validateCommand(value): ManagedCommand`、`validateSnapshot(value): ProjectSnapshot`。指令字段按设计 §7.1，实体 ID 使用非空受限字符串，操作使用固定枚举。

- [x] 写协议测试：缺 guard 的批准、非法操作、不同参数复用幂等键输入、跨项目快照字段不合法均拒绝；有效指令可完整传递身份、配置版本和 guard。
- [x] 运行新测试确认功能缺失导致失败，记录输出。
- [x] 同步 SPEC 的中央/托管模式扩展及 AC-CENTRAL 标识；增加 workspace 构建，保持插件现有 dist 导出。
- [x] 构建协议并运行测试通过；运行既有 typecheck/build。
- [x] 提交契约与协议改动并更新进度。

## 任务 2：中央持久化、身份和项目/节点 API

**文件**: `apps/server/src/database.ts`、`auth.ts`、`app.ts`、`cli.ts`；`tests/central-server.test.mjs`。

**接口**: `createCentralApp({dataDir, clock?}): Promise<FastifyInstance>`；`CentralDatabase(path)` 提供 `createUser`、`createNode`、`bindProject` 和 `close`。CLI 创建账号、节点及启动服务；Token 只展示一次，中心只存摘要。

- [x] 写 HTTP 行为测试：登录/注销、未登录拒绝、CSRF 拒绝、节点 Token 限定、两节点注册与项目归属、instanceId 冲突、配置修改遇未决任务拒绝。
- [x] 运行失败测试。
- [x] 使用 SQLite 短事务、密码派生、随机会话与节点凭据实现；HTTP schema 不接受额外的权限或路径提升。
- [x] 测试中心重开数据库后账号、节点和项目仍在；凭据不出现在查询响应中。
- [x] 提交并更新进度。

## 任务 3：可靠指令、事件与查询快照

**文件**: `apps/server/src/commands.ts`、`snapshots.ts`、`app.ts`；`tests/central-commands.test.mjs`、`central-snapshots.test.mjs`。

**接口**: 用户项目操作创建 `ManagedCommand`；节点 poll/ack/events 使用协议类型。`submitSnapshot(snapshot)` 按绑定代数和持久化序号切换视图；详情查询缺失返回 202 与查询 ID，附件按 SHA-256 寻址。

- [x] 写测试：两项目可并行、同项目阻塞、防重键冲突、重复领取返回原任务、事件去重/乱序、重启保持占用、离线拒绝新写。
- [x] 写快照测试：旧序号/旧绑定不覆盖、附件缺失不切换、详情 snapshot_moved 不误缓存、离线已有缓存仍可读。
- [x] 运行失败测试。
- [x] 实现受理事务、事件流和有界日志、只读查询请求与内容寻址附件；取消控制独立于普通写名额。
- [x] 所有新测试通过后提交，记录协议路由和状态码。

## 任务 4：节点通信和本地执行记录

**文件**: `src/host/managed-node.ts`、`managed-journal.ts`；`tests/central-node.test.mjs`。

**接口**: `ManagedNode({config, execute, read, journal, fetch?, clock?})`；`start(): Promise<void>`、`tick(): Promise<void>`、`stop(): Promise<void>`。`execute(command, signal, emit): Promise<ManagedResult>`；`read(query): Promise<ManagedQueryResult>`。日志、指令阶段及快照序号持久化。

- [x] 写测试：注册/心跳、两节点各自领取、重复 commandId 只执行一次、回报丢失后重传、受理后重启转恢复而不重跑、忙碌时收到取消、旧配置拒绝。
- [x] 运行失败测试。
- [x] 实现主动轮询、凭据引用、workspace 目录核验、持久化受理与事件 ACK、恢复握手。
- [x] 完成真实中央进程与双节点 HTTP 集成；重开持久化由中央回归覆盖，真实跨机器重连留待部署验收。
- [x] 提交并更新进度。

## 任务 5：接入审核核心及远端交付

**文件**: `src/host/managed-operations.ts`、`api.ts`、`api-context.ts`、`jobs.ts`、`vcs.ts`、`index.ts`；`tests/central-review.test.mjs`、`central-delivery.test.mjs`。

**接口**: 节点按 workspace 获得审核 runtime；执行上下文解析 userId/reviewIdentity，不写全局 owner。原业务结果保留独立判别联合，新增交付维度。`GitAdapter` 在核验目标后推送并证明远端包含原提交；SVN 沿用提交探针。

- [x] 写测试：真实 Git/SVN 夹具的查询、评论、修复、批准；旧 guard 不能执行；取消和恢复沿用既有语义。
- [x] 写交付测试：本地成功/推送失败、远端已收响应丢失、非快进冲突；重试只交付原提交，不重复批准；未决交付持续阻塞。
- [x] 运行失败测试。
- [x] 提取必要的类型化入口并接线；托管模式使用进程 Runner 收尾，纯本地模式行为保留。
- [x] 完成新测试及相关既有契约测试，通过后提交。

## 任务 6：正式 Web 与管理流程

**文件**: `apps/web`；中心静态资源路由；`tests/central-web.test.mjs` 和浏览器行为检查。

**接口**: Web 仅调用中心 `/api/v1`；API/页面路由共享 projectId；TanStack Query 的缓存键包含项目及资源版本。202 展示临时进度而不覆盖评审事实。

- [x] 写关键行为检查：未登录进入登录、跨项目筛选、离线只读、旧 guard 保留草稿、判断项未完成不能批准。
- [x] 建立 React/Vite 构建并实现原型页面，加执行节点管理；项目接入选择节点已声明的 workspace。
- [x] 接入真实报告、候选、并排差异、评论与修复、批准、任务日志和恢复诊断，完善空/错误/加载状态。
- [x] 浏览器验证桌面、窄屏、登录与审核关键路径；确认没有示例数据或伪成功提示留在正式流程。
- [x] 提交并更新进度。

## 任务 7：部署、全量验证与独立审查

**文件**: 部署说明、README、必要的收尾修复；验证输出在 `.tmp/`。

- [x] 写部署说明：中央引导、HTTPS、节点凭据与 workspace 配置、项目绑定、启动停止、备份及恢复。
- [x] 运行 `npm run typecheck`、`npm run build` 和 `node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`；测试数量不减少。
- [x] 运行双节点隔离目录集成、浏览器检查；真实 DSH/跨机器不可用的环境限制单列，不宣称验收。
- [x] 独立审查当前分支，逐条复核结论，修复全部 P0/P1 并重新验证。
- [x] 清除自己的临时脚本和输出，提交变更；不 push、不 merge，报告实际完成边界及剩余环境验收。

## 进度与执行记录

- 2026-11-16：用户认可方案；当前 linked worktree 已创建任务分支 `worktree-central-review-web`，未触碰主副本。
- 既有依赖已按 lockfile 安装；基线 typecheck/build 通过。普通沙箱全量基线 226 项：218 通过、8 失败（SVN 临时目录权限、默认 DSH_HOME 权限及进程终止约束）；正在隔离 DSH_HOME 后以适当权限复核失败文件，未放宽断言。
- 任务 1：协议新增 4 项测试已完成 RED→GREEN，workspace 及依赖锁已建立，SPEC 扩展尚待补齐。
- 任务 2/3：中央身份、节点、项目、指令、事件与快照初步实现；新增 8 项 HTTP 行为测试已完成 RED→GREEN（加协议共 12 项通过）。CLI、更多安全/异常覆盖及独立复核待完成，不视为整个任务已交付。
- 基线复核：隔离 DSH_HOME 并授予临时 SVN/进程测试所需权限后，失败用例所属 5 个文件共 69 项全部通过；原基线未发现代码缺陷。后续全量验证使用相同隔离环境。
- SPEC §16 与 AC-CENTRAL-01 至 AC-CENTRAL-10 已新增，本地模式的内存 Job、操作隔离及 commit-only 约束保留为本地语义。
- Ruling：测试的 DSH_HOME 必须指向当前工作区 `.tmp/` 隔离目录；不得为了绕过沙箱而运行会污染真实 DSH_HOME 的测试。新测试的多连接清理已修正，断言未放宽。
- 计划自审：协议由任务 1 定义；任务 2/3 消费协议并向任务 4 提供 HTTP；任务 5 实现任务 4 的 execute/read；任务 6 仅消费中央 API。命名与边界一致。
- Ruling：按用户已经提供的实施授权连续执行，常规任务不增加审批轮次；涉及实际外部部署、主副本合并及推送仍按既有规则处理。
- 任务 1–3 已提交为 `e42d66c`：中央服务、协议与 SPEC 扩展落地；后续独立审查发现的编码路径鉴权、已提交结果保护、失败详情重试及快照时效问题均已修复并增加回归。
- 任务 4–5 已实现：节点主动连接、本地 SQLite 受理/检查点/outbox、类型化审核入口、受信用户身份、Git 原提交推送和 SVN 原远端版本核验。ACK 响应丢失会重试受理，不重复执行；无原业务结果时不会仅凭提交标记推断批准成功。真实 SVN 子路径提交及工作副本根目录核验通过。
- 任务 6 已实现正式 React Web：登录/注销、工作台、项目/节点接入、报告、候选、并排/版本差异、评论与状态、AI/人工修复、人工判断、完整门禁确认、批准、任务日志与恢复。评论草稿按用户/项目/候选保存，异步回报不会清除后写草稿或其他候选草稿。
- 浏览器验证使用一个真实 HTTP 中央进程和两个独立 Git 节点/远端夹具，已走通登录、跨项目筛选、差异查看、评论提交、门禁确认、批准提交/推送、最终日志、manual Runner 提示和注销；390px 窄屏检查已完成，viewport 已恢复。夹具服务已停止，系统临时仓库已清理。
- Ruling：总体评论保留 I11 的 `file:''/line:0`；协议测试原先虚构的 `decisions` 字段改为真实 `confirmedDecisions/waivedDecisions`，属于跟随规范收紧，未放宽断言。
- Ruling：增量比较的左侧不是当前版本基线，首期只允许在增量右侧添加定位意见；完整补丁两侧均可定位。差异解析器按 hunk 范围处理 `+++`/`---` 代码，新增真实文本回归。
- Ruling：同工作副本新读取等待写事务安全窗口，独立工作副本读取及取消控制继续进行；设计 §7.2 和部署说明已同步记载该取舍。大于 256 KiB 的详情使用内容寻址附件，8 MiB 上限显式报错，换行与 UTF-8 已回归验证。
- 任务 7：部署说明 `docs/central-deployment.md` 已落地；最终验证及独立审查记录见 `docs/central-validation.md`。当前环境 PATH 未找到 `dsh`，不宣称真实宿主、模型调用或跨机器 HTTPS/构建工具链已验收。

- 最终代码冻结验证：typecheck、完整 build、261 项全量测试全部通过（0 失败、0 跳过，约 270 秒）。独立审查无未决 P0/P1。具体证据和目标环境待验收项已写入验证记录。
