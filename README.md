# dsh-code-review

> **任务来源**: 用户授权单仓拆分，并要求为中央服务和 DSH 节点提供三平台独立部署、启动脚本。
> **任务内容**: 说明包边界及交付入口，补充可重复覆盖、Git 更新和独立启动的使用方式。
> **参考文档**:
> - `SPEC.md` — 权威审核及中央模式契约。
> - `docs/central-user-guide.md` — 面向使用者的 Web 操作手册。
> - `docs/central-deployment.md` — 中央和节点的部署、配置与恢复。
> - `docs/oneclick-deployment.md` — 三平台部署、重复升级与独立启动。
> - `docs/superpowers/specs/2026-11-16-package-boundaries-design.md` — 包边界与交付设计。
> **生成日期**: 2026-11-17

新增中央托管模式：一个 TypeScript / Node.js 24 服务统一管理多个 DSH 插件节点，React Web 提供项目、报告、候选、审核和任务管理。中央使用 SQLite 保存平台状态与查询缓存，Git/SVN 中的 `.ai-review/` 仍是评审事实源。日常操作见 [使用手册](docs/central-user-guide.md)，部署与节点配置见 [中央部署说明](docs/central-deployment.md)。

DeepSeek Harness（DSH）桌面端的代码评审插件。它把产品仓库里的 `.ai-review/` 目录变成可操作的审核队列：浏览候选修复、阅读全量/增量差异、按行评论、执行合并门禁、批准并原子提交，或把意见退回给 AI 生成下一版。

插件内置「仓库审查（Audit Repo）」作为候选生产者：AI 扫描当前仓库，按正确性/安全/稳定性/可测试性/性能/精简的优先级发现问题，把无疑问的 A 类修复直接生成为候选，把存疑的 B 类只写进审查报告，从而形成「审查 → 生成候选 → 人工审核 → 批准合入」的闭环。

本地模式直接由插件提供界面与 API；中央托管模式增加独立管理服务。两种模式都以 **`review.md` + `NNN.patch` 作为共享评审事实**。

## 功能

- 与「对话」同级的「评审」标签页（`conversation.view`），自动使用当前会话的工作目录作为评审仓库，无需单独配置项目目录。
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
3. **启动审查会话**：Host 通过 `ctx.sessionController` 新建一个会话并挂到当前仓库所属工作区（侧边栏可见，标题为「仓库审查 · <范围>」），把完整审查准则作为第一条消息发送。新会话会**继承评审页所在会话的权限预设/审批策略**（例如 `danger-full-access` + `never`），因此审查里的 `gate_checks` 不会卡在无人应答的批准弹窗上。当前页面**不会自动切换或遮挡**；你可以继续工作，需要查看过程时从侧边栏打开该会话。审查会话自己会流式展示工具调用与输出；
4. **导出提示词**：不启动会话，把完整审查提示词复制到任意外部 Agent 执行。

AI 按 A/B 类自动分流：

- **A 类**（无疑问的本质修复 / 低风险明显精简）→ 直接改代码、跑门禁、生成 `.ai-review/YYYY-MM/<候选>/review.md + 001.patch`；
- **B 类**（业务取舍 / 跨模块大改 / 协议变更 / 无法本地验证）→ 只写入 `.ai-review/audits/<时间戳>-<范围>.md` 的“B 类：需人工确认”；
- **待前置合入**（依赖前序候选）→ 写入报告的“待前置合入后处理（Deferred）”。

审查会话结束时会按提示词**只提交 `.ai-review`**（`[skip ci]`，绝不提交业务代码、不 push），候选随即出现在评审队列。批准候选时插件仍会重新检查工作区、严格应用补丁并执行 `gate_checks`，再把业务代码、`review.md` 状态与补丁清理放入原子提交。

审查报告保存在 `.ai-review/audits/`，可在审查会话的最终回复中看到路径，也可直接打开该 Markdown 文件。

> UI 的审查会话使用**当前 DSH 会话的模型/工具**，不依赖设置里的「AI 修复执行器」。该执行器仍用于批准失败后的 AI 修复，以及可选的 headless `POST /audit` 自动化入口。

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

profile 里的依赖应为 `dsh-code-review link:<仓库绝对路径>/packages/dsh-plugin`。安装后刷新 DSH 页面即可在会话顶部的视图标签中看到「评审」；若 host 代码刚更新，可在插件管理中先禁用再启用该插件以重新挂载。

根目录只负责工作区管理。`npm run build:central` 单独构建中央服务和 Web；`npm run build` 构建全部组件。执行 `npm run pack:plugin` 或 `npm run pack:central`，分别生成根 `dist/` 下的插件和中央服务安装包；二者都包含各自运行依赖，中央包还包含 Web 静态资源。隔离安装、账号与节点配置见 [中央部署说明](docs/central-deployment.md)。

## 配置

首次打开「评审」标签页会要求设置：

| 字段 | 说明 |
| --- | --- |
| 评审仓库 | 自动取当前会话的工作目录（必须包含 `.git` 或 `.svn`，评审数据位于其 `.ai-review/`） |
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

## 已知边界 / 与设计文档的差异

1. **只 commit 不 push**：按当前会话选择；如需自动推送，可扩展 `GitAdapter.atomicCommit`。
2. **批准只需一次提交**：提交哈希无法写入自身，也不需要写入；Host 按 SPEC §5.5 从 VCS 历史派生业务提交版本。当前 demo 仍保留第二次回填提交，属实现差距，待切换。
3. **SVN 增量 diff 为 hunk 级**：SVN 无三方合并能力，跨版本增量直接退化为 hunk 对比并显示警告。
4. **契约数据模型已落地（schema_version 1）**：`review.md` 核心字段（module/audit_type 9 值/updated_at/target_files/human_decisions/rejection/commit_message/reopened_*）、固定键序、不变量校验（队列 broken 隔离）、负向记忆指纹与窗口阻止、批准留痕（门禁快照/逐条结果/判断项确认）、检出级写互斥均已实现并有测试（`tests/contract-*.test.mjs`）。新增的 `rejection.category` / `rejection.related_symbols`、`comments[].anchor`、`patchCheck`、`approvalCommitRevision`/`approvalCommitLookup` 与 `/comments/batch` 尚未实现（SPEC 附录 A G18、G37–G42）。
5. **仓库审查写入端仍为旧扁平报告**：`audits/<时间戳>-<范围>.md`；新目录式档案（`audits/<audit_id>/audit.md` + items/finding）的读取、投影、转换（`/convert`）已就绪，审查会话提示词改写为新格式属下一步。审查提示词已注入负向记忆摘要（§7.5/7.6）。
6. **UI 未覆盖新端点**：`/archive-stale`、`/reopen`、`/convert`、`/rebase`、`/audits`、`/findings` 目前仅 API + 测试，客户端面板待补；`/comments/batch` 与 `patchCheck` 仍是 SPEC 目标契约，尚未实现。
7. **无批量批准、无真实鉴权**：owner 是本地约定，适合小团队试点；真正的权限需要仓库/服务端能力。检出级互斥为进程内实现，多克隆并发与"批准后跨实例重复 approved 检测"（§18.8 后半）不在保证范围。Jira 等外部 Ticket 自动抓取尚未接入（远期方向）。
7a. **§14 共享事实过滤未实现**：队列/投影/负向记忆当前直接读工作区文件，未按 `git status` 排除未提交改动（本地视图）；提交失败回滚机制为主要缓解，完整实现待做。
8. **UI 使用中文文案**（locale 命名空间已注册，便于后续补英文/日文）。
9. 门禁命令由 AI 写入 `review.md`，批准时会以当前用户权限在本机执行；确认框会完整展示命令，请只批准可信候选。
10. **审查会话使用当前 DSH 模型**。长时间审查会持续占用该会话，可以在聊天界面取消或追加意见。定时审查在[中央项目详情页](docs/central-user-guide.md#6-配置定时审查)配置，由执行节点先复查历史结果，再执行本轮全量审查。
11. **UI 与 headless 双路径**：UI 的「审查仓库」走新 DSH 会话（侧边栏可见、可交互），不再使用后台 headless 模态；`POST /audit` 的 headless 审查仍保留给自动化/测试，由插件负责复核与提交。

## 验证记录

已在 Windows + DSH Desktop 实际验证：

- 插件安装、激活、「评审」标签页注册（`client-entry` 可见 `dsh-code-review` 条目；API 按 `sessionId` 解析当前会话目录，已用不同于 settings 的会话目录验证）。
- Git：队列、详情、行内评论（中文 UTF-8）、接管、放弃、批准；批准提交包含业务代码 + `review.md` + 补丁删除，过程补丁清理；目标契约为单次提交 + 历史派生，当前 demo 仍为两次提交，待切换。
- Git 增量 diff：两个版本在同一基线上真实重建并 `git diff`（`same_base_direct`）。
- 同基线/多版本候选完整走通：评论 → AI 修复（真实 `dsh headless`）→ 新版本 3 → 门禁 4/4 → 批准。
- SVN：本地 `file://` 仓库，`svn patch`、门禁、原子提交 r2、补丁删除（目标契约为单次提交；当前 demo 仍多一次回填，待切换）。
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
