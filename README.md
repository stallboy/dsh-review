# dsh-code-review

DeepSeek Harness（DSH）桌面端的代码评审插件。它把产品仓库里的 `.ai-review/` 目录变成可操作的审核队列：浏览候选修复、阅读全量/增量差异、按行评论、执行合并门禁、批准并原子提交，或把意见退回给 AI 生成下一版。

插件内置「仓库审查（Audit Repo）」作为候选生产者：AI 扫描当前仓库，按正确性/安全/稳定性/可测试性/性能/精简的优先级发现问题，把无疑问的 A 类修复直接生成为候选，把存疑的 B 类只写进审查报告，从而形成「审查 → 生成候选 → 人工审核 → 批准合入」的闭环。

不引入独立后端，不复制一份评审数据库：**`review.md` + `NNN.patch` 就是唯一的共享数据**。

## 功能

- 与「对话」同级的「评审」标签页（`conversation.view`），自动使用当前会话的工作目录作为评审仓库，无需单独配置项目目录。
- **仓库审查（Audit Repo）**：在审核队列点击「审查仓库」会通过 Host 的会话控制服务 `sessionController`（客户端 `session.create` 的 Host 端）在 DSH 中**新建一个审查会话**（侧边栏可见），审查过程以对话流式展示，不弹窗、不遮挡其他工作；AI 生成 A 类候选与 B 类/Deferred 审查报告，候选自动进入评审队列。
- 审核队列：按 owner/状态/tag/目录/标题筛选，显示变更规模、基线落后、需人工判断项数量、最近意见。
- 审核详情：
  - 问题与影响、根因、当前修复方案；
  - 「需人工判断项」琥珀色高亮 + 逐项确认（未全部确认不能批准）；
  - 合并门禁 `gate_checks` 明文展示；
  - 完整补丁 + 版本增量差异（Git 用临时 worktree 真实重建；跨基线先 3-way，失败退 hunk 级并显著提示）；
  - 按行内联评论、总体意见、评论状态（未处理/部分处理/已处理）；
  - 版本历史与审核记录。
- 操作隔离：只有 `owner` 能操作；其他人只读，可「接管审核」。
- 乐观锁：每次提交带 `expectedRevision + expectedOwner`，旧页面操作会被拒绝并要求刷新。
- 批准：检查工作区干净 → 同步基线 → 严格应用补丁 → 依次执行 `gate_checks` → 业务代码 + `review.md` 状态/证据 + 删除过程补丁放入同一个原子提交；成功后追加一个仅 `.ai-review` 的提交回填 `commit_revision`（CI 忽略这类提交）。
- 失败回退：补丁冲突或门禁失败时还原工作区，按设置尝试 AI 修复；AI 生成下一版后候选回到 `pending`，旧批准失效。
- AI 修复执行器三选一：
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
node scripts/verify-audit-session.mjs --commit --target src/host --wait-audit 300
```

脚本会：

1. 工作区有改动时自动 `git add -A && git commit`（`--commit`，提交信息可用 `--message` 覆盖）；
2. 校验 `/health` 已按当前 `sessionId` 把评审仓库解析为当前目录，且有基线提交；
3. `POST /audit/session` 创建审查会话并提交审查提示词；
4. 轮询 `$DSH_HOME/sessions/**` 确认会话日志出现，`$DSH_HOME/storages/workspace.json` 确认会话已挂到当前工作区（侧边栏可见），会话日志中出现审查提示词与 `turn/start`；
5. 可选等待审查会话真正结束（会话日志 `turn/end`），并列出 `.ai-review/audits/` 新报告或 `.ai-review/YYYY-MM/` 下带 `review.md` 的新候选（`--wait-audit`）。

host 代码更新后仍需在插件管理中禁用再启用一次 `dsh-code-review` 才会重新加载；只改 client 时刷新页面即可。

## 安装

```powershell
npm install
npm run build
```

然后在 DSH 中用 Plugin Manager 安装本目录（绝对路径），或由代理执行：

```text
plugin_manager install_bundle target=D:\work\mygithub\dsh-review
```

安装后刷新 DSH 页面即可在会话顶部的视图标签中看到「评审」；若 host 代码刚更新，可在插件管理中先禁用再启用该插件以重新挂载。

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
  reviewers.yml                 # 目录 / tag → owner 路由
  audits/                       # 仓库审查报告（不参与审核队列）
    20261031-214800-repo.md
  2026-10/
    fix-login-token-refresh/
      review.md                 # YAML Frontmatter + Markdown 正文
      001.patch
      002.patch                 # 编号最大的是当前版本；批准/放弃后删除
```

`review.md` Frontmatter 字段：`schema_version, title, created_at, owner, tags, status, ticket, current_revision, revisions[{id,base_revision,patch}], gate_checks[], comments[], approval`。仓库审查候选还会带 `module`、`audit_type` 等额外字段，插件解析时保留。状态只有 `pending | changes_requested | approved | rejected`。

每次写入都会经过前端并发锁校验；`.ai-review` 变更会立即 commit（不 push），保证同一仓库的其他 DSH 实例能同步看到。

## 本机 API

Host 端在 `/dsh-code-review/api` 下注册：

- `GET /health`、`GET/PUT /settings`
- `GET /queue`、`GET /candidate?id=`、`GET /patch`、`GET /diff?id=&from=&to=`
- `POST /comments`、`POST /comment-status`、`POST /takeover`、`POST /reject`
- `POST /approve`（返回 jobId）、`POST /ai-fix`（返回 jobId）、`GET /jobs/:id`、`POST /sync`
- `GET /audit/prompt?mode=session|headless&targetPath=&note=`（导出审查提示词；session 为独立会话模式，headless 为旧的无交互模式）
- `POST /audit/session`（通过 Host `sessionController` 创建真实 DSH 审查会话并发送提示词，返回 sessionId；UI 使用）
- `POST /audit`（可选 headless 审查，返回 jobId；插件负责复核与提交，UI 不使用）
- `GET /fix-prompt?id=`、`GET /reviewers`、`GET /client-entry`

## 已知边界 / 与设计文档的差异

1. **只 commit 不 push**：按当前会话选择；如需自动推送，可扩展 `GitAdapter.atomicCommit`。
2. **`commit_revision` 回填需要第二个提交**：提交哈希无法写入自身；第二个提交只改 `.ai-review`，CI 规则已忽略这类提交。
3. **SVN 增量 diff 为 hunk 级**：SVN 无三方合并能力，跨版本增量直接退化为 hunk 对比并显示警告。
4. **仓库审查只处理仓库自闭环**：A 类自动生成候选，B 类只写报告；Jira 等外部 Ticket 自动抓取尚未接入（远期方向）。
5. **审查的运行前提**：业务工作区必须干净且仓库已有基线提交。UI 通过 Host `sessionController` 新建一个 DSH 审查会话（侧边栏可见，不自动切换当前页面），AI 在会话中直接修改工作区；会话模式下由 AI 按提示词只提交 `.ai-review`，不做 headless 插件复核。批准候选时插件会重新验证补丁并执行门禁。
6. **审查报告位于 `.ai-review/audits/`**：headless 模式由插件解析报告中的 B 类/Deferred 并生成回退报告；会话模式由 AI 写入报告并在最终回复中给出摘要。
7. **无批量批准、无真实鉴权**：owner 是本地约定，适合小团队试点；真正的权限需要仓库/服务端能力。
8. **UI 使用中文文案**（locale 命名空间已注册，便于后续补英文/日文）。
9. 门禁命令由 AI 写入 `review.md`，批准时会以当前用户权限在本机执行；确认框会完整展示命令，请只批准可信候选。
10. **审查会话使用当前 DSH 模型**：长时间审查会持续占用该会话；可以在聊天界面取消或追加意见，不影响其他会话。
11. **UI 与 headless 双路径**：UI 的「审查仓库」走新 DSH 会话（侧边栏可见、可交互），不再使用后台 headless 模态；`POST /audit` 的 headless 审查仍保留给自动化/测试，由插件负责复核与提交。

## 验证记录

已在 Windows + DSH Desktop 实际验证：

- 插件安装、激活、「评审」标签页注册（`client-entry` 可见 `dsh-code-review` 条目；API 按 `sessionId` 解析当前会话目录，已用不同于 settings 的会话目录验证）。
- Git：队列、详情、行内评论（中文 UTF-8）、接管、放弃、批准；批准提交包含业务代码 + `review.md` + 补丁删除，过程补丁清理，`commit_revision` 回填。
- Git 增量 diff：两个版本在同一基线上真实重建并 `git diff`（`same_base_direct`）。
- 同基线/多版本候选完整走通：评论 → AI 修复（真实 `dsh headless`）→ 新版本 3 → 门禁 4/4 → 批准。
- SVN：本地 `file://` 仓库，`svn patch`、门禁、原子提交 r2、回填提交 r3、补丁删除。
- 仓库审查（自动化夹具）：临时 Git 仓库 + 假执行器/假 `dsh` 命令完整走通「审查 → 生成 A 类候选 → 解析 B/Deferred → 复核补丁 → 还原工作区 → 提交 `.ai-review`」；仅 B 类时只提交报告；无效候选会回传校验错误；失败且无候选时不产生提交。`/audit/session` 使用假的 `createAuditSession` 验证了 sessionId、标题、owner 会话与 session 提示词；Host 侧 `createDshAuditSession` 用假 `sessionController` 覆盖了工作区挂载、cwd 回退、改名失败、错误码、提示词受理，以及权限预设/审批策略继承（含 `custom` 回退）。`npm test` 29 项通过。
- 仓库审查（真实 DSH 会话，`scripts/verify-audit-session.mjs` 实跑）：`POST /audit/session` 创建会话 → 写入 `workspace.json` 挂到 `dsh-review` 工作区（侧边栏可见，标题「仓库审查 · src/host」）→ 继承 `danger-full-access` + `never` → 审查代理完成 132 次工具调用 / 104 步、基线 `npm test` 29/29 通过 → 在 `src/host` 生成 4 个独立候选与 `.ai-review/audits/20261031-230629-src-host.md` → 只提交 `.ai-review`（`audit(src/host): 仓库审查生成 4 个候选 [skip ci]`，commit `2bfbb86`），业务工作区保持干净。
- `npm run typecheck`（host + client 双 program）通过；`node --check dist/client.js` 通过。

未自动验证：浏览器中的视觉/交互（本机没有可用浏览器自动化工具）；点击链路用 API 调用等价触发，并直接校验 DSH 会话日志、`workspace.json` 挂载与 `turn/end` 完成信号。

## 目录

```text
src/host/            TypeScript Host 半（ESM，编译到 dist/）
  index.ts           插件入口、webServer 路由挂载、sessionController 审查会话创建
  api.ts             JSON API 与 job 编排
  auditor.ts         仓库审查：提示词、A/B 报告解析、候选复核与提交
  store.ts           review.md 解析/写入、队列、并发锁
  frontmatter.ts     YAML frontmatter + 正文分段
  vcs.ts             Git/SVN 适配器、增量 diff
  validator.ts       gate_checks 执行与证据
  runner.ts          dsh headless / manual / external（修复与审查共用）
  approval.ts        批准状态机
  jobs.ts            内存 job 日志
src/client/client.ts 浏览器半（classic script，React.createElement）
assets/              AI Fixer / Repo Auditor system prompts
scripts/             端到端验证脚本（verify-audit-session.mjs）
tests/               Node 内置测试运行器（夹具 + 假审查执行器）
src/host/vendor/      内置 js-yaml 4.3.2（MIT，见 THIRD-PARTY.md）
locale/              插件显示名称/描述
```
