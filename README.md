# dsh-code-review

DeepSeek Harness（DSH）桌面端的代码评审插件。它把产品仓库里的 `.ai-review/` 目录变成可操作的审核队列：浏览候选修复、阅读全量/增量差异、按行评论、执行合并门禁、批准并原子提交，或把意见退回给 AI 生成下一版。

插件内置「仓库审查（Audit Repo）」作为候选生产者：AI 扫描当前仓库，按正确性/安全/稳定性/可测试性/性能/精简的优先级发现问题，把无疑问的 A 类修复直接生成为候选，把存疑的 B 类只写进审查报告，从而形成「审查 → 生成候选 → 人工审核 → 批准合入」的闭环。

不引入独立后端，不复制一份评审数据库：**`review.md` + `NNN.patch` 就是唯一的共享数据**。

## 功能

- 与「对话」同级的「评审」标签页（`conversation.view`），自动使用当前会话的工作目录作为评审仓库，无需单独配置项目目录。
- **仓库审查（Audit Repo）**：在审核队列一键触发，支持指定目录、补充关注点、直接驱动或导出提示词；AI 生成 A 类候选与 B 类/Deferred 审查报告，插件复核补丁并提交 `.ai-review`。
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

在「评审」队列点击「审查仓库」：

1. **审查范围**：留空审查全仓库，或填 `src/`、`packages/core/` 等仓库内相对路径；
2. **补充关注点**（可选）：例如“重点关注并发关闭竞态与资源泄漏”；
3. **开始审查**：用当前执行器扫描、验证并生成候选；或点「导出提示词」复制到任意外部 Agent 执行。

AI 按 A/B 类自动分流：

- **A 类**（无疑问的本质修复 / 低风险明显精简）→ 直接改代码、跑门禁、生成 `.ai-review/YYYY-MM/<候选>/review.md + 001.patch`；
- **B 类**（业务取舍 / 跨模块大改 / 协议变更 / 无法本地验证）→ 只写入 `.ai-review/audits/<时间戳>-<范围>.md` 的“B 类：需人工确认”；
- **待前置合入**（依赖前序候选）→ 写入报告的“待前置合入后处理（Deferred）”。

审查结束后插件会：复核每个新候选的 `review.md`、补丁可应用性、`gate_checks` 定义与人工判断项 → 尝试把补丁应用到基线 → 还原业务工作区 → 把复核结果追加进审查报告 → 原子提交 `.ai-review`（不 push）。门禁命令由 AI 在审查期间实际执行，批准时插件会再执行一遍；审查要求业务工作区干净，且仓库已有基线提交（Git HEAD / SVN revision）。

审查报告保存在 `.ai-review/audits/`，任务完成后可在结果面板展开查看，也可直接打开该 Markdown 文件。

审查执行器与配置中的「AI 修复执行器」共用：

- `dsh`：真实调用本机 DSH headless（默认）；
- `external`：任意命令，提示词从 stdin 传入；
- `manual`：不执行，只返回提示词（等同「导出提示词」）。

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
| AI 修复执行器 | `dsh` / `manual` / `external`；仓库审查也复用该执行器 |
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
- `GET /audit/prompt?targetPath=&note=`（导出审查提示词）、`POST /audit`（启动审查，返回 jobId）
- `GET /fix-prompt?id=`、`GET /reviewers`、`GET /client-entry`

## 已知边界 / 与设计文档的差异

1. **只 commit 不 push**：按当前会话选择；如需自动推送，可扩展 `GitAdapter.atomicCommit`。
2. **`commit_revision` 回填需要第二个提交**：提交哈希无法写入自身；第二个提交只改 `.ai-review`，CI 规则已忽略这类提交。
3. **SVN 增量 diff 为 hunk 级**：SVN 无三方合并能力，跨版本增量直接退化为 hunk 对比并显示警告。
4. **仓库审查只处理仓库自闭环**：A 类自动生成候选，B 类只写报告；Jira 等外部 Ticket 自动抓取尚未接入（远期方向）。
5. **审查的运行前提**：业务工作区必须干净且仓库已有基线提交；审查启动时会拒绝已有任务，审查运行期间批准/修复/同步也会被拒绝；审查期间 AI 会临时修改工作区，结束后插件强制还原。
6. **审查报告位于 `.ai-review/audits/`**：B 类与 Deferred 由报告中的固定标题和列表解析；AI 未写报告时插件会生成回退报告。
7. **无批量批准、无真实鉴权**：owner 是本地约定，适合小团队试点；真正的权限需要仓库/服务端能力。
8. **UI 使用中文文案**（locale 命名空间已注册，便于后续补英文/日文）。
9. 门禁命令由 AI 写入 `review.md`，批准时会以当前用户权限在本机执行；确认框会完整展示命令，请只批准可信候选。

## 验证记录

已在 Windows + DSH Desktop 实际验证：

- 插件安装、激活、「评审」标签页注册（`client-entry` 可见 `dsh-code-review` 条目；API 按 `sessionId` 解析当前会话目录，已用不同于 settings 的会话目录验证）。
- Git：队列、详情、行内评论（中文 UTF-8）、接管、放弃、批准；批准提交包含业务代码 + `review.md` + 补丁删除，过程补丁清理，`commit_revision` 回填。
- Git 增量 diff：两个版本在同一基线上真实重建并 `git diff`（`same_base_direct`）。
- 同基线/多版本候选完整走通：评论 → AI 修复（真实 `dsh headless`）→ 新版本 3 → 门禁 4/4 → 批准。
- SVN：本地 `file://` 仓库，`svn patch`、门禁、原子提交 r2、回填提交 r3、补丁删除。
- 仓库审查（自动化夹具）：临时 Git 仓库 + 假执行器/假 `dsh` 命令完整走通「审查 → 生成 A 类候选 → 解析 B/Deferred → 复核补丁 → 还原工作区 → 提交 `.ai-review`」；仅 B 类时只提交报告；无效候选会回传校验错误；失败且无候选时不产生提交。`npm test` 17 项通过。
- `npm run typecheck`（host + client 双 program）通过；`node --check dist/client.js` 通过。

未自动验证：浏览器中的视觉/交互（当前会话无法绕过 DSH 页面的连接鉴权）；仓库审查的新按钮/弹窗/结果面板只做了 TypeScript 与 `node --check` 校验。请刷新 DSH 页面，在会话顶部的视图标签中点击「评审」确认；host 代码更新后需在插件管理中先禁用再启用插件。

## 目录

```text
src/host/            TypeScript Host 半（ESM，编译到 dist/）
  index.ts           插件入口、webServer 路由挂载
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
tests/               Node 内置测试运行器（夹具 + 假审查执行器）
src/host/vendor/      内置 js-yaml 4.3.2（MIT，见 THIRD-PARTY.md）
locale/              插件显示名称/描述
```
