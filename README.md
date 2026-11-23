# dsh-code-review

> **任务来源**: 用户授权单仓拆分，并要求为中央服务和 DSH 节点提供三平台独立部署、启动脚本。
> **任务内容**: 说明包边界、部署入口和当前的发现级审核流程。
> **参考文档**:
> - `SPEC.md` — 权威审核及中央模式契约。
> - `docs/central-user-guide.md` — 面向使用者的 Web 操作手册。
> - `SPEC_for_human.md`、`docs/dsh-code-review-guide.md` — 流程概览和本地操作指南。
> - `docs/central-deployment.md` — 中央和节点的部署、配置与恢复。
> - `docs/oneclick-deployment.md` — 三平台部署、重复升级与独立启动。
> - `docs/superpowers/specs/2026-11-16-package-boundaries-design.md` — 包边界与交付设计。
> **生成日期**: 2026-11-23

新增中央托管模式：一个 TypeScript / Node.js 24 服务统一管理多个 DSH 插件节点，React Web 提供项目、报告、候选、审核和任务管理。中央使用 SQLite 保存平台状态与查询缓存，Git/SVN 中的 `.ai-review/` 仍是评审事实源。日常操作见 [使用手册](docs/central-user-guide.md)，部署与节点配置见 [中央部署说明](docs/central-deployment.md)。

DeepSeek Harness（DSH）桌面端的代码评审插件。它把产品仓库里的 `.ai-review/` 目录变成可操作的审核队列：浏览候选修复、阅读全量/增量差异、按行评论、执行合并门禁、批准并原子提交，或把意见退回给 AI 生成下一版。

「仓库审查（Audit Repo）」为每个确认的发现提供一个补丁、最多三个互斥补丁，或一份带验收条件的文字方案。审核人可以选一个补丁批准应用、说明理由后选择「本次不修改」，或标记「人工接手」并复制交接内容。只有文字方案时可用后两项。后续审查会按范围核验接手项，证据足够时补记修复提交。

本地模式由插件提供界面和 API，中央托管模式由中央协调节点。两种模式的共享评审事实都在仓库的 `.ai-review/` 下，包括审查档案、候选和发现处置记录。操作说明见[本地插件指南](docs/dsh-code-review-guide.md)和[中央评审使用手册](docs/central-user-guide.md)，流程概览见[人工阅读版](SPEC_for_human.md)。

## 功能

- DSH 左侧栏上方的「评审」打开独立工作台。本地模式在设置中指定 Git/SVN 工作副本，中央模式在工作台内选择项目。
- **仓库审查（Audit Repo）**：在审核队列点击「审查仓库」会通过 Host 的会话控制服务 `sessionController`（客户端 `session.create` 的 Host 端）在 DSH 中**新建一个审查会话**（侧边栏可见），审查过程以对话流式展示，不弹窗、不遮挡其他工作；AI 生成 A 类候选与 B 类/Deferred 审查报告，候选自动进入评审队列。
- 审核队列：按 owner/状态/tag/目录/标题筛选，显示变更规模、基线落后/冲突诊断（冲突诊断目标契约，当前未实现）、需人工判断项数量、最近意见。
- 审核详情：
  - 顶部 KPI：基线是否落后、人工确认进度、门禁数量、补丁规模；
  - 问题与影响、根因、当前修复方案按 Markdown 轻量渲染（标题/列表/加粗/行内代码），正文限宽 78ch，便于扫读；
  - 「需人工判断项」只展示真实决策点，自动过滤“无 / 暂无 / 无：…”占位；没有真实项时整张卡片不显示；
  - 合并门禁 `gate_checks` 明文展示；验证证据折叠在门禁卡片内；
  - **内联审批面板**：点「批准并提交」在页内展开步骤、门禁、人工确认、同步设置与确认按钮；不弹 modal、不遮罩 DSH，Esc/取消即可收起；
  - 批准或 AI 修复的运行状态与日志在页顶**内联卡片**展示，运行中可以继续浏览页面；队列页也保留该卡片；
  - 完整补丁 + 版本增量差异（Git 用临时 worktree 真实重建；跨基线先 3-way，失败退 hunk 级并显著提示）；
  - 按行内联评论、总体意见、评论状态（未处理/部分处理/已处理）；支持多条草稿一次性提交（目标契约，当前未实现）；跨版本评论按原文锚点重定位（目标契约）；
  - **总体意见可按执行方式启动下一版**：「提交意见并新建修复会话」保存意见（含所有未解决行内意见）后，新建一个**可见的 DSH 会话**并把修复提示词投递进去（侧边栏可见、可追问）；「提交意见并导出修复提示词」只生成提示词，复制后粘贴到外部 Agent（如 `codex exec -`）手动执行。两条路径都只产出候选新版本，`.ai-review/` 的提交仍由你在面板上收尾；「仅提交意见」只记录不跑修复。想再修一版时，直接在总体意见里写清要求后再次提交即可；
  - 版本历史与审核记录（可折叠）。
- 操作隔离：只有 `owner` 能操作；其他人只读，可「接管审核」。
- 乐观锁：每次提交带 `expectedRevision + expectedOwner + expectedUpdatedAt`，旧页面操作会被拒绝并要求刷新。
- 批准：内联审批面板确认 → 检查工作区干净 → 同步基线 → 严格应用补丁 → 依次执行 `gate_checks` → 业务代码 + `review.md` 状态/证据 + 删除过程补丁放入**同一个原子提交**；业务提交哈希由 Host 从 VCS 历史派生，不需要第二次回填提交。批准面板可选**提交信息详略**：`简略信息` 只写一行 `review(<候选>): <标题>`；`详细信息` 先写这一行综述，空一行后由 Host 附上作者统计（历史提交与“本次待提交”分开统计）、改动摘要、修复方案、来源候选、门禁与人工判断项等事实正文（面板会显示结构预览）。
- 失败回退：补丁冲突或门禁失败时还原工作区，按设置尝试 AI 修复；AI 生成下一版后候选回到 `pending`，旧批准失效。
- AI 修复：读取候选下所有未解决意见（总体 + 行内），把当前版本补丁应用到工作区后生成下一版 review.md/patch；成功后只提交 `.ai-review`，失败会自动还原业务工作区。执行器三选一：
  - `dsh`（默认）：spawn 本机 `dsh --profile headless --json -`，prompt 走 stdin，模型凭据通过 DSH `credentials` 服务解析 `DEEPSEEK_API_KEY`；
  - `manual`：只生成可复制的修复提示；
  - `external`：任意命令，prompt 从 stdin 传入。
- Git 与 SVN 适配器；写操作（反馈/接管/放弃/AI 修复）默认只 commit、不 push。

## 仓库审查（Audit Repo）

在「评审」队列点击「审查仓库」，队列内会展开一个**内联面板**（不是弹窗）：

1. **审查范围**：留空审查全仓库，或填 `src/`、`packages/core/` 等仓库内相对路径；
2. **补充关注点**（可选）：例如“重点关注并发关闭竞态与资源泄漏”；
3. **启动审查会话**：Host 通过 `ctx.sessionController` 新建一个会话并挂到评审仓库所属工作区（侧边栏可见，标题为「仓库审查 · <范围>」），把完整审查准则作为第一条消息发送。从全局工作台新建的会话采用 DSH 默认会话配置。需要查看过程时，从侧边栏打开该会话；
4. **外部执行**：可以先点「仅预览提示词」。交给外部 Agent 执行前，点「创建外部执行租约」，复制该租约的提示词。等 Agent 停止后回到面板收尾。

容易独立验证的发现生成一到三个互斥补丁，每个方案有自己的 `.ai-review/<月份>/<候选>/review.md` 和 `001.patch`。需要业务取舍、影响范围较大或难以验证的问题交付文字方案。有前置依赖的发现先记录该依赖，待前置问题关闭后再处理。

审查会话收尾时，Host 验证并提交 `.ai-review`，发布的发现和候选随即进入评审队列。批准选定的补丁时，插件会重新校验状态、应用补丁并执行 `gate_checks`，通过后把业务代码、批准记录和过程补丁清理放入同一个提交。

审查报告保存在 `.ai-review/audits/`，可在审查会话的最终回复中看到路径，也可直接打开该 Markdown 文件。

> UI 的审查会话使用新建 DSH 会话的模型和工具。设置里的「AI 修复执行器」用于批准失败后的 AI 修复，以及可选的 headless `POST /audit` 自动化入口。

## 端到端验证（自动点审核）

改完 Host 代码后的标准回路是：构建 → 提交 → 重载插件 → 调 `/audit/session`（等价于点「审查仓库」）→ 校验会话落盘/挂载/提示词开跑 → 看报告或候选：

```powershell
npm run build
node scripts/verify-audit-session.mjs --commit --target packages/dsh-plugin/src/host --wait-audit 300
```

脚本会：

1. 工作区有改动时自动 `git add -A && git commit`（`--commit`，提交信息可用 `--message` 覆盖）；
2. 校验 `/health` 已按当前 `sessionId` 把评审仓库解析为当前目录，且有基线提交；
3. `POST /audit/session` 创建审查会话并提交审查提示词；
4. 轮询 `$DSH_HOME/sessions/**` 确认会话日志出现，`$DSH_HOME/storages/workspace.json` 确认会话已挂到当前工作区（侧边栏可见），会话日志中出现审查提示词与 `turn/start`；
5. 可选等待审查会话真正结束（会话日志 `turn/end`），并列出 `.ai-review/audits/` 新报告或 `.ai-review/YYYY-MM/` 下带 `review.md` 的新候选（`--wait-audit`）。

host 代码更新后仍需在插件管理中禁用再启用一次 `dsh-code-review` 才会重新加载；只改 client 时刷新页面即可。

## 安装

Windows 上的本地 Git 分阶段审查可使用 [WSL2 + bubblewrap 隔离门禁](docs/audit-gate-wsl.md)。

开发时可以用 DSH 的「发现」页安装包含本机中央服务的整合包。在仓库根目录运行 `npm ci` 和 `npm run preview:market`，在使用独立 `DSH_HOME` 的测试 profile 中添加输出的本机索引地址。安装、启用与首次启动步骤见[本机整合插件](docs/central-deployment.md#11-同一机器上的插件内中央)。

中央服务和 DSH 节点均可使用[一键部署与启动脚本](docs/oneclick-deployment.md)：Windows 为 `deploy.cmd` / `start.cmd`，Linux 为 `deploy.sh` / `start.sh`，macOS 为 `deploy.command` / `start.command`。部署与启动独立；部署可反复覆盖程序并保留数据，添加 `--git` 会先获取仓库最新代码。要求 Node.js 24 或更新版本。

例如在仓库根运行 `deploy.cmd --role central --target C:/dsh-review/central`，完成后单独运行 `C:/dsh-review/central/start.cmd`。首次部署会提示设置登录密码；节点的 DSH 启动路径、连接配置与插件启用步骤见上述说明。

只开发评审插件或远程执行节点时，可以链接轻量源码包：

```powershell
npm ci
npm run build:plugin
```

然后在 DSH 中用 Plugin Manager 安装 `packages/dsh-plugin` 的**绝对路径**（不能指向仓库根目录，根目录的 `package.json` 是私有的工作区清单，没有 `dsh.bundle`，插件管理器会报「没有声明组合包」），或由代理执行：

```text
plugin_manager install_bundle target=<仓库绝对路径>/packages/dsh-plugin
```

profile 里的依赖应为 `dsh-code-review link:<仓库绝对路径>/packages/dsh-plugin`。安装后刷新 DSH 页面即可在左侧栏上方看到「评审」。若 Host 代码刚更新，可在插件管理中先禁用再启用该插件以重新挂载。

根目录只负责工作区管理。`npm run build:central` 单独构建中央服务和 Web；`npm run build` 构建全部组件。执行 `npm run pack:plugin` 或 `npm run pack:central`，分别生成根 `dist/` 下的插件和中央服务安装包；二者都包含各自运行依赖，中央包还包含 Web 静态资源。隔离安装、账号与节点配置见 [中央部署说明](docs/central-deployment.md)。

## 配置

首次使用本地模式时，从左侧栏依次打开「评审」「本地评审」，填写以下设置。

| 字段 | 说明 |
| --- | --- |
| 评审仓库 | Git/SVN 工作副本目录，评审数据位于其 `.ai-review/` |
| 审核者 owner | 用于乐观锁和操作隔离，默认取 `git config user.name` |
| AI 修复执行器 | `dsh` / `manual` / `external`；用于批准失败后的修复与可选 headless 审查，仓库审查会话本身使用当前 DSH 模型 |
| DSH CLI 路径 | 留空自动探测 `resources\runtime\cli\bin\dsh.cmd` |
| 门禁超时 | 单条 `gate_checks` 的超时 |
| 批准前同步 | 是否先 `git pull --ff-only` / `svn update` |

设置只保存在本机 `$DSH_HOME/dsh-code-review/settings.json`，不写入产品仓库。

## 数据契约

```text
.ai-review/
  reviewers.yml                 # owner 路由、门禁白名单、超时/记忆窗口、收尾门禁
  audits/                       # 仓库审查报告（不参与审核队列）
    20261031-214800-repo.md
  2026-10/
    fix-login-token-refresh/
      review.md                 # YAML Frontmatter + Markdown 正文
      001.patch
      002.patch                 # 编号最大的是当前版本；批准/放弃后删除
```

`review.md` Frontmatter 字段：`schema_version, title, module, audit_type, created_at, updated_at, owner, tags, status, ticket, target_files[], current_revision, revisions[{id,base_revision,patch,author}], gate_checks[], comments[], human_decisions[], approval, rejection, commit_message, reopened_*`。`approval` 不含提交哈希；业务提交由 Host 从 VCS 历史派生。仓库审查候选还会带 `module`、`audit_type` 等额外字段，插件解析时保留。状态只有 `pending | changes_requested | approved | rejected`。

每次写入都会经过前端并发锁校验；`.ai-review` 变更会立即 commit（不 push），保证同一仓库的其他 DSH 实例能同步看到。

### 评审数据只读校验

源码工作副本完成插件构建后，可从主会话按文件校验本轮产物。

```bash
npm run --silent validate:review-data -- "路径/review.md" "路径/audit.md"
```

在本地安装插件包后，也可使用 `npm exec --offline -- dsh-review-validate` 调用同一命令。命令输出 JSON，其中 `files` 逐个列出路径和错误。全部通过退出 0，任一文件失败退出 1，缺少文件参数退出 2。收尾前可检查候选 `review.md`，收尾后可检查 Host 生成的 `audit.md`。补丁能否应用、基线和 owner 路由由 Host 在收尾时检查。

## 本机 API

Host 端在 `/dsh-code-review/api` 下注册：

- `GET /health`、`GET/PUT /settings`
- `GET /queue`、`GET /candidate?id=`、`GET /patch`、`GET /diff?id=&from=&to=`
- `POST /comments`（保存单条意见；body 带 `autoFix: true` 时保存后自动启动 AI 修复并返回 `job`）、`POST /comments/batch`（目标契约，当前未实现；一次提交多条意见，全有或全无）、`POST /comment-status`、`POST /takeover`、`POST /reject`（支持可选 `category`）
- `POST /archive-stale`（§18.1 显式归档过期候选：`system:stale` + 乐观锁只写一次；队列 `isStale` 只提示不写）
- `POST /reopen`（§4.8 人工重开：`from` 指向 rejected 候选，理由必填，豁免负向记忆窗口）
- `POST /convert`（§6.2 B/Deferred 转候选：depends_on 满足判定 + 档案/候选两侧同一提交）
- `POST /rebase`（生成新版本并重跑门禁，返回 job）
- `GET /audits`、`GET /findings`（§3 目录式审查档案与 §3.4 finding 投影；旧扁平报告不参与）
- `POST /approve`（返回 jobId；body 支持 `confirmedDecisions`/`waivedDecisions`，§4.7 判断项全覆盖校验；可选 `commitDetail: simple|detailed` 控制业务提交信息详略）、`POST /ai-fix`（显式启动同一 AI 修复 job，返回 jobId；UI 不再单独暴露按钮，保留给自动化）、`GET /jobs/:id`、`POST /sync`
- `POST /fix-session`（§7.4：新建 DSH 会话并投递修复提示词，返回 sessionId；UI「提交意见并新建修复会话」使用，不占用审查租约、不提交候选）
- `GET /fix-prompt?id=&mode=session|headless`（修复提示词；`mode=session` 与 `/fix-session` 投递的逐字节一致，可直接粘贴到 codex 等外部 Agent）
- `GET /audit/prompt?mode=session|headless&targetPath=&note=`（导出审查提示词，含 reviewers.yml 路由注入；session 为独立会话模式，headless 为旧的无交互模式）
- `POST /audit/session`（通过 Host `sessionController` 创建真实 DSH 审查会话并发送提示词，返回 sessionId；UI 使用）
- `POST /audit`（可选 headless 审查，返回 jobId；插件负责复核与提交，UI 不使用）
- `GET /fix-prompt?id=&mode=`、`GET /reviewers`、`GET /client-entry`

> 评审员提交意见，由 AI 生成修复版本。需要人工改代码时，直接按目标仓库的流程处理。历史人工修订仍可在候选中查看。

## 使用边界

- 本地 Git 批准产生本地提交。中央 Git 还需推送到绑定目标，SVN 则直接提交到绑定的远端。业务提交版本由 Host 从 VCS 历史派生。
- 中央与节点都支持新版时才发布新版发现。旧格式及历史独立候选继续按原流程使用。
- SVN 的跨版本增量使用 hunk 比较。工作台逐项批准，并在确认前显示会以执行账号运行的门禁命令。
- 插件界面的「审查仓库」使用新建 DSH 会话，自动化可以调用 `POST /audit`。定时审查在[中央项目详情页](docs/central-user-guide.md#6-配置定时审查)配置。

## 验证记录

以下为早期 Windows + DSH Desktop 的验证记录，保留用于追溯：

- 插件安装、激活（`client-entry` 可见 `dsh-code-review` 条目）。曾用旧会话入口验证 API 显式传入 `sessionId` 时可解析与设置不同的仓库目录。
- Git：验证队列、详情、行内评论（中文 UTF-8）、接管、放弃和批准，核对批准提交中的业务代码、`review.md` 和过程补丁清理。
- Git 增量 diff：两个版本在同一基线上真实重建并 `git diff`（`same_base_direct`）。
- 同基线/多版本候选完整走通：评论 → AI 修复（真实 `dsh headless`）→ 新版本 3 → 门禁 4/4 → 批准。
- SVN：用本地 `file://` 仓库验证 `svn patch`、门禁、批准提交和补丁删除。
- 仓库审查（自动化夹具）：临时 Git 仓库 + 假执行器/假 `dsh` 命令完整走通「审查 → 生成 A 类候选 → 解析 B/Deferred → 复核补丁 → 还原工作区 → 提交 `.ai-review`」；仅 B 类时只提交报告；无效候选会回传校验错误；失败且无候选时不产生提交。`/audit/session` 使用假的 `createAuditSession` 验证了 sessionId、标题、owner 会话与 session 提示词；Host 侧 `createDshAuditSession` 用假 `sessionController` 覆盖了工作区挂载、cwd 回退、改名失败、错误码、提示词受理，以及权限预设/审批策略继承（含 `custom` 回退）；`/comments` 的 `autoFix` 链用 manual 执行器验证「保存意见 → 返回 ai_fix job → job 成功且 prompt 含该意见」。`npm test` 35 项通过（不含候选补丁里的 5 个 vcs 用例）。
- 仓库审查（真实 DSH 会话，`scripts/verify-audit-session.mjs` 实跑）：`POST /audit/session` 创建会话 → 写入 `workspace.json` 挂到 `dsh-review` 工作区（侧边栏可见，标题「仓库审查 · src/host」）→ 继承 `danger-full-access` + `never` → 审查代理完成 132 次工具调用 / 104 步、基线 `npm test` 29/29 通过 → 在 `src/host` 生成 4 个独立候选与 `.ai-review/audits/20261031-230629-src-host.md` → 只提交 `.ai-review`（`audit(src/host): 仓库审查生成 4 个候选 [skip ci]`，commit `2bfbb86`），业务工作区保持干净。
- 审批 UI：批准 / AI 修复 / 放弃改为页内面板与页内运行日志，不再使用全屏 modal 遮罩；人工判断项过滤“无 / 暂无 / 无：…”占位；正文按 Markdown-lite 渲染并限宽。用真实 `dist/client.js` + React 18 + 真实 `/queue`、`/candidate` 数据在无头 Chrome 中渲染详情、勾选人工项、打开内联审批面板并点击“确认批准并提交”（approve 用假 job 响应），确认 `.dcr-modal-mask` 数量为 0、页内 job 卡片出现，控制台 0 error。
- `npm run typecheck`（host + client 双 program）通过；`node --check dist/client.js` 通过。

未自动验证：DSH 桌面窗口内的真实鼠标点击（已用真实 client bundle + React + 真实 API 数据在无头 Chrome 渲染并自动点击验证；页面加载后仍建议刷新一次以取到新 client bundle）。

## 目录

```text
apps/server/                      中央服务，静态页面随包进入 dist/public/
apps/web/                         中央 React 工作台
packages/protocol/                节点通信及公开数据契约
packages/dsh-plugin/              独立插件及其元数据、资源
  src/host/                       审核编排、VCS、门禁、DSH 接入
  src/managed/                    中央通信、执行记录、查询同步与交付
  src/client/client.ts            DSH 内嵌经典脚本界面
  assets/                         AI 提示词
  locale/                         插件语言文件
scripts/                          打包与端到端验证脚本
tests/                            契约、隔离安装与集成测试
dist/                             安装包产物（不提交）
```
