# 中央评审服务部署与运维

> **任务来源**: 用户要求修订拆包后的部署文档，提供三平台独立部署脚本，并增加插件内本机中央、已有中央连接及多项目接入。
> **任务内容**: 说明普通插件、本机整合包与可下载版的选择、显式连接与恢复、脚本及手工安装、节点接入和备份恢复。
> **参考文档**:
> - `../SPEC.md` — 中央模式职责、身份、执行与恢复契约。
> - `../package.json` — 构建、打包及启动命令。
> - `../scripts/pack.mjs` — 普通插件、独立中央与本机整合包的依赖收集。
> - `superpowers/specs/2026-11-17-plugin-central-design.md` — 插件内中央连接、项目接入与进程生命周期设计。
> - `superpowers/plans/2026-11-17-plugin-central.md` — 本轮实施与验收计划。
> - `superpowers/plans/2026-11-18-central-runtime-download.md` — 可下载版的实施与验收计划。
> - `../packages/dsh-plugin/src/connection/controller.ts` — 连接持久化、恢复、旧配置保护及工作台网关。
> - `../apps/server/src/cli.ts` — 中央 CLI 参数及环境变量。
> - `../packages/dsh-plugin/src/managed/managed-config.ts` — 节点配置与凭据加载。
> - `../packages/dsh-plugin/src/managed/managed-operations.ts` — 工作副本绑定与执行配置。
> - `../packages/dsh-plugin/src/managed/managed-delivery.ts` — Git/SVN 交付核验。
> - `package-boundaries-validation.md` — 拆包后的实际验证范围。
> - `oneclick-deployment.md` — 三平台脚本、参数及数据保留方式。
> **生成日期**: 2026-11-17

本页面向部署和维护人员。日常审核见[中央 Web 手册](central-user-guide.md)；只在本机 DSH 中使用插件，见[本地插件指南](dsh-code-review-guide.md)。

同一机器、同一 DSH 内的少量项目可使用下面的本机整合插件，在插件内启动中央。独立长期运行的中央与远程节点可使用[一键部署与启动](oneclick-deployment.md)；`deploy` 负责部署，`start` 单独启动。本文保留手工安装方式，并说明 HTTPS、节点配置与恢复。

本文 `npx --no-install dsh-review-central ...` 管理命令以手工安装目录为例。一键脚本部署后，对应入口是 `node <target>/app/node_modules/@dsh-review/server/dist/cli.js ...`，其中 `--data-dir` 使用 `<target>/deployment.json` 记录的 `dataDir`，确保管理命令和运行服务读写同一份数据。

## 1. 先确定安装在哪里

| 位置 | 需要准备 | 负责什么 |
| --- | --- | --- |
| 中央机器 | Node.js 24、中央安装包、持久化数据目录 | 提供 Web、账号登录、节点和项目管理，保存任务与查询缓存。 |
| 执行节点 | 使用 Node.js 24 或更新运行时的 DSH、评审插件、Git/SVN、模型与项目工具链 | 持有代码目录，执行审查、修复、门禁、提交和远端交付。 |
| 审核人员电脑 | 浏览器、中央网址和账号 | 查看候选、提意见、批准并核对任务结果。 |

中央是独立进程，不需要安装 DSH 或业务代码工作副本。节点主动连接中央，不需要对外开放 DSH Web 端口。一个节点可以管理多个独立工作副本，同一真实目录不能重复配置。

当前中央采用单实例 SQLite，不需要额外部署数据库或消息队列。中央账号具有相同的平台管理能力，尚无细粒度项目权限、角色或 SSO；候选负责人仍在节点执行时校验。

以下以 PowerShell 和 Windows 路径为例，按实际机器修改。Linux 使用相同 CLI 参数和对应绝对路径，但须在目标环境另行验收。JSON 中的 Windows 路径建议使用 `/`。

### 1.1 同一机器上的插件内中央

| 安装包 | 使用场景 |
| --- | --- |
| `dsh-code-review-0.3.0.tgz` | 普通插件，不包含中央运行目录；可使用原本地评审或连接已有中央。 |
| `dsh-code-review-downloadable-0.3.0.tgz` | 首次启动本机中央时确认下载，之后可离线启动。 |
| `dsh-code-review-local-0.3.0.tgz` | 本机整合插件，包含独立中央服务、Web 和运行依赖；可在插件内启动本机中央，也可连接已有中央。 |
| `dsh-review-server-0.1.0.tgz` | 独立中央，适合长期运行或供其他机器访问，继续使用本文第 2 节的安装方式。 |

#### 通过 DSH 市场预览安装

在仓库根目录运行 `npm ci`，再运行 `npm run preview:market`。构建结束后会输出 `http://127.0.0.1:<端口>/index.json`。该地址只在命令运行期间可用。

如果使用 Windows 上的 DSH Web，可在另一个 PowerShell 窗口启动临时环境。

```powershell
$env:DSH_HOME = Join-Path ([IO.Path]::GetTempPath()) ('dsh-review-market-' + [Guid]::NewGuid().ToString('N'))
dsh web --port 0
```

1. 在同一台机器上用独立的 `DSH_HOME` 运行 DSH 测试 profile。连接配置按 `DSH_HOME` 保存，仅切换 profile 仍会读取原来的连接配置。打开「插件」，启用实验插件「自定义插件索引」，再到「发现 → 添加索引源」粘贴输出地址。
2. 找到「代码评审」，确认安装来源为本机预览仓库，完成安装并启用。DSH 会按索引中的版本下载完整整合包。
3. 在「评审 → 中央连接」选择「本机托管」，填写审核身份，点击「应用并启动」。服务就绪后即可打开中央工作台。

每轮预览使用新的测试环境，以首次安装为验收目标。预览仓库会随命令停止，重启后会使用新的地址。DSH 版本没有「发现」页时，可按下节安装整合包。[DSH 自定义插件索引说明](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)

#### 预览轻量插件的首次启动

```powershell
npm run preview:market -- --lightweight
```

按同样的步骤在 DSH 添加这次输出的索引并安装插件。保持预览进程运行，选择「本机托管」、填写审核身份后点击「应用并启动」。确认框显示中央运行包的版本、来源和大小。确认后插件下载、校验 SHA-256 并启动中央。取消或下载失败可从同一入口重试，原连接配置会保留。已成功下载的运行包在 `<DSH_HOME>/dsh-code-review/central-runtimes/` 缓存，完整且协议兼容的缓存可在插件升级后和离线时继续使用。发现缓存损坏时，可在原启动入口再次确认下载。

#### 构建可通过 HTTPS 分发的轻量插件

```powershell
npm run pack:downloadable -- 'https://github.com/stallboy/dsh-review/releases/download/<固定标签>' 'https://github.com/stallboy/dsh-review/releases/latest/download/dsh-review-central-version.json'
```

把示例地址替换为计划使用的 HTTPS 地址。命令在 `dist/` 生成可下载版插件、中央归档和 `dsh-review-central-version.json`。分发时，中央归档的文件名和内容必须与这一轮打包结果一致，放在指定附件目录；版本 JSON 放在第二个地址。版本文件的 `version` 使用 `主版本.次版本.修订号` 格式。本机中央启动后会在后台读取该文件，新版仅显示提示。上述命令在本仓库内生成产物，实际上传由发布流程执行。

#### 使用整合包安装

在构建机器的仓库根目录执行：

```powershell
npm ci
npm run pack:local
```

把 `dist/dsh-code-review-local-0.3.0.tgz` 复制到目标机器的独立安装目录，例如 `C:/dsh-review-local`，执行：

```powershell
Set-Location C:/dsh-review-local
npm init -y
npm install ./dsh-code-review-local-0.3.0.tgz --offline --omit=dev --ignore-scripts --no-audit --no-fund
```

在 DSH Plugin Manager 中安装 `C:/dsh-review-local/node_modules/dsh-code-review`。普通插件与整合插件安装后的包名都为 `dsh-code-review`，同一实例选择其中一种。目标机器仍需要使用 Node.js 24 或更新运行时的 DSH、Git/SVN 和项目工具链；运行时不会下载依赖、构建中央或更新源码。

打开 DSH 的“评审”标签，默认进入“中央连接”。选择“本机托管”，填写与候选 owner 对应的审核身份，点击“应用并启动”。仅选择模式、编辑配置或打开工作台不会启动中央。没有项目时也能启动；服务就绪后，打开“项目接入”，核对真实目录、VCS 和目标，再逐项接入。

“中央工作台”在插件内打开中央页面；本机模式会为首次填写的本地审核身份建立用户会话。已有中央使用管理员提供的地址、节点 ID 与 Token，点击“测试连接”只测试，点击“应用并连接”才保存并启用；浏览工作台仍使用中央用户登录。节点 Token 留空会保留已保存凭据，界面不会回填秘密。审核身份初始化后不能靠编辑连接表单静默改为另一个本地用户。

已启用连接在插件下次启动时自动恢复。点击“停止连接”会持久停用并保留配置，下次插件启动不自动连接，需再次明确应用或重试。关闭页面、切换会话或接入其他项目不改变中央生命周期；停止或重载插件会终止其自行拉起的中央，已有中央进程由外部维护。异常退出后显示故障，需显式重试。

连接配置、凭据、本机中央数据及各中央的执行记录保存在 `<DSH_HOME>/dsh-code-review/`，不写入业务仓库。备份应包含整个目录；不要仅复制 `connection.json`，也不要删除执行记录来解除未决状态。存在未决业务任务、未核验执行或未确认事件时，切换中央、停用连接及修改接入会被拒绝，应先在原中央处理任务。

实例所有权由 `connection-owner.sqlite` 的排他事务保护，进程退出时自动释放，不能通过删除文件解除活动实例互斥。旧版 `connection.lock` 仅作活动进程兼容检查，不自动回收删除；升级前先正常停止旧插件。停用项目保留声明，不要求目录持续可用；中央重新启用后实际访问前仍校验原目录和固定目标。修改后审查修复的验证见[修复记录](plugin-central-fixes-validation.md)。

尚未保存新连接时，原 `managed-node.json` 继续兼容。检测到旧托管配置后，插件界面展示诊断并禁止直接覆盖连接：先在原中央处理完旧任务，停用旧托管配置，再重启插件，随后配置新连接。旧节点凭据、执行记录与项目绑定不会自动迁移。存在中央配置或旧托管配置时，顶部隐藏“本地评审”；连接停止或故障也不能绕过中央进行本地写入。

同一真实工作副本的多个会话复用接入记录；不同目录即使名称或远端相同，也分别接入。项目停用保留历史和目录，关闭会话不会取消接入；发现或接入项目不会自动开始审查。

整合包的隔离离线安装与中央 IPC 启停测试用于验证交付物可脱离源码运行。真实 DSH 宿主界面、宿主内 Node/Electron 行为及 Windows、macOS、Linux 三平台仍须分别实际验收，不能以自动化测试替身代替。

## 2. 安装并启动中央服务

### 2.1 生成安装包

在有完整源码和构建依赖的机器上，从**仓库根目录**执行：

```powershell
npm ci
npm run pack:central
npm run pack:plugin
```

当前版本生成：

- `dist/dsh-review-server-0.1.0.tgz`：中央服务、Web 静态资源和运行依赖。
- `dist/dsh-code-review-0.3.0.tgz`：DSH 插件、资源和协议依赖。

中央包发到中央机器，插件包发到各节点；版本变化时使用实际文件名。请使用以上打包入口，直接对 workspace 执行 `npm pack` 不能替代运行依赖收集。

### 2.2 在中央机器安装

先建立独立安装目录，例如 `C:/dsh-review-central`，并把中央包放入其中，再执行：

```powershell
Set-Location C:/dsh-review-central
npm init -y
npm install ./dsh-review-server-0.1.0.tgz --offline --omit=dev --no-audit --no-fund
```

部署机器需要 Node.js/npm，不需要 TypeScript、源码目录或旁边的 `apps/web`。静态资源位于中央包自身的 `dist/public/`。

### 2.3 创建第一个账号

选择一个独立于安装目录的持久化数据目录，例如 `C:/dsh-review-data`。所有管理命令和服务进程必须指向同一目录。在刚才的安装目录中执行：

```powershell
$securePassword = Read-Host '设置登录密码（12～256 个字符）' -AsSecureString
$env:DSH_REVIEW_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
npx --no-install dsh-review-central user-add --data-dir C:/dsh-review-data --username reviewer --review-identity reviewer
Remove-Item Env:DSH_REVIEW_PASSWORD
Remove-Variable securePassword
```

`username` 用于登录；`reviewIdentity` 用于候选负责人、评论作者和审核记录，应与业务仓库的 owner 约定一致。创建其他账号时重复此命令并使用不同登录名。当前没有 Web 账号创建或密码修改入口。

Linux/Bash 可先用 `read -r -s DSH_REVIEW_PASSWORD` 输入密码，再 `export DSH_REVIEW_PASSWORD`，执行相同的 `user-add` 命令，最后 `unset DSH_REVIEW_PASSWORD`。

### 2.4 启动并检查

```powershell
npx --no-install dsh-review-central serve --data-dir C:/dsh-review-data --host 127.0.0.1 --port 3081
```

保持进程运行，访问 `http://127.0.0.1:3081` 并登录。另一个终端可检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3081/health
```

预期返回 `status: ok`、`service: dsh-review-central`。这只能证明中央进程可用，不能证明节点、模型和项目工具链已就绪。

### 2.5 正式对外访问

使用反向代理提供 HTTPS，并将**整个站点**转发到中央进程，包括页面、静态资源、`/api/v1` 和 `/node-api/v1`。部署在域名根路径，例如 `https://review.example.com`，当前不使用 URL 子路径。

即使代理与中央在同一机器，也应在启动时传入公开 HTTPS 地址，以启用 Secure 登录 Cookie：

```powershell
npx --no-install dsh-review-central serve --data-dir C:/dsh-review-data --host 127.0.0.1 --port 3081 --public-url https://review.example.com
```

监听非回环地址，如 `--host 0.0.0.0`，代码会要求提供 HTTPS 的 `--public-url`。**此参数不会自动建立 TLS**，证书与 HTTPS 仍由反向代理提供。

代理请求体上限至少允许 8 MiB。中央普通 JSON 上限 2 MiB，附件上限 8 MiB。用服务管理器维护进程，并固定数据目录、启动参数与服务账号。

### 2.6 从源码开发时

在仓库根目录执行：

```powershell
npm ci
npm run build:central
$securePassword = Read-Host '设置开发账号密码（12～256 个字符）' -AsSecureString
$env:DSH_REVIEW_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
node apps/server/dist/cli.js user-add --data-dir C:/dsh-review-dev-data --username reviewer --review-identity reviewer
Remove-Item Env:DSH_REVIEW_PASSWORD
Remove-Variable securePassword
node apps/server/dist/cli.js serve --data-dir C:/dsh-review-dev-data --host 127.0.0.1 --port 3081
```

账号仅在首次使用该数据目录时创建。前端热更新可另开终端运行 `npm run dev --workspace @dsh-review/web`，按 Vite 输出的网址访问；开发代理默认连接本机 3081。`build:central` 不构建插件。

## 3. 创建并配置节点

### 3.1 安装插件与准备代码

运行插件的 **DSH Host 本身**须使用 Node.js 24 或更新版本；终端中的 `node --version` 不能证明 DSH 内部运行时符合要求。

使用独立插件包时，先在节点建立安装目录并复制插件包，例如 `C:/dsh-review-node`：

```powershell
Set-Location C:/dsh-review-node
npm init -y
npm install ./dsh-code-review-0.3.0.tgz --offline --omit=dev --no-audit --no-fund
```

然后让 DSH Plugin Manager 安装 **`C:/dsh-review-node/node_modules/dsh-code-review`**。从源码开发时，在仓库根目录执行 `npm run build:plugin`，安装 **`packages/dsh-plugin` 的绝对路径**。仓库根目录已不再是插件安装入口。

业务代码须预先 Git clone 或 SVN checkout。用运行 DSH 的同一系统账号确认：

- 工作副本有可用基线，业务工作区干净，目录是仓库或 SVN 工作副本根目录。
- Git 已切到目标分支，已有 `origin` 远端目标分支；开启批准前同步时，upstream 须正确配置。提交者与推送凭据可用。
- SVN 目标与凭据正确，非交互命令能够访问仓库。
- 项目构建、测试命令和所选模型 Runner 可用，执行能正常结束。

Web 不会自动下载仓库或安装工具链。

### 3.2 创建节点凭据

登录 Web 的“执行节点”，填写名称并点击“创建节点凭据”，保存一次性展示的节点 ID 和 Token。也可在中央安装目录执行：

```powershell
npx --no-install dsh-review-central node-add --data-dir C:/dsh-review-data --name build-node-01
```

将 Token 保存在节点环境变量或 DSH 凭据服务中。中央只存摘要，不能再次展示原文。每个 DSH 实例使用独立凭据，不写入业务仓库。

### 3.3 写入节点配置

配置文件为 `<DSH_HOME>/dsh-code-review/managed-node.json`。`DSH_HOME` 指运行 DSH 的进程环境变量；未设置时使用该系统账号主目录下的 `.dsh`，如 `C:/Users/你的账号/.dsh` 或 `/home/你的账号/.dsh`。

创建目录和文件，保存为 UTF-8 JSON：

```json
{
    "centerUrl": "https://review.example.com",
    "nodeId": "替换为中央生成的节点ID",
    "tokenReference": "DSH_REVIEW_NODE_TOKEN",
    "workspaces": [
        {
            "workspaceId": "server-core",
            "label": "服务器核心库",
            "root": "C:/repos/server-core",
            "target": "main",
            "settings": {
                "runner": "dsh",
                "syncBeforeApprove": true,
                "gateTimeoutMs": 600000
            }
        }
    ]
}
```

替换示例中的中央地址、节点 ID、目录和目标。`workspaceId` 用字母、数字、下划线或连字符标识工作副本，节点内唯一；`label` 是展示名称。`target` 可省略，首次启动时取当前分支或 SVN 相对 URL，此后持续核验，不能在运行期间自行切换目标。

SVN 可作为另一项加入 `workspaces`，例如 `root: C:/repos/game-client`、`target: ^/trunk`；Linux 使用 `/srv/review/server-core` 这样的绝对目录。SVN 目标以 `svn info --show-item relative-url .` 输出为准。

`tokenReference` 先按同名环境变量解析，未找到时再查询 DSH 凭据服务。使用环境变量时，必须让**启动 DSH 的进程或服务**继承它；在另一个终端设置不会改变已运行的 DSH。不要把 Token 原文填进 `tokenReference`。

`settings.runner` 可用 `dsh`、`external`、`manual`。`dsh` 使用进程 Runner；`external` 还需有效的 `externalCommand`；`manual` 不自动调用模型，会给出人工操作提示。托管模式不靠本地面板的可见对话判断任务结束。

重启 DSH 后，检查节点在线、协议兼容且工作副本正确。配置存在但格式错误、凭据无法解析或工作副本无效时，插件报告初始化错误，不回退为本地可写模式。

### 3.4 对齐审核身份

仓库 `.ai-review/reviewers.yml` 的 owner 应与中央账号 `reviewIdentity` 对应。例如默认交给身份 `reviewer`：

```yaml
default_owner: reviewer
```

补入项目实际门禁与路由配置，提交并同步到团队仓库。执行身份来自当前中央登录账号，不能通过改写节点本地 owner 冒充其他人。

## 4. 接入项目与首次验收

1. 在“项目管理”点击“＋ 接入项目”，选择在线且兼容的节点及工作副本。
2. 等待项目“已同步”。首次接入不会自动开始审查。
3. 在项目详情点击“开始全量审查”，到“任务记录”查看结果。
4. 检查报告、候选和补丁能打开，在可接受的测试候选上验证评论、修复和批准。
5. Git 核对原提交已进入 `origin` 目标分支；SVN 核对远端 revision。

批准、评论、接管、拒绝和候选收尾等共享写都会尝试交付远端。意见提交与 AI 修复是不同指令；已受理不表示业务成功。日常操作见[使用手册](central-user-guide.md)。

节点约每 2 秒轮询控制指令，索引约每 10 秒同步。任务执行、网络或同步错误可能使刷新延迟，在线不代表内容已更新。离线已有缓存可读，未缓存详情可能不可用，新业务写操作会被阻止。

## 5. 停止、备份和恢复

### 日常停止与备份

先处理或记录未决任务。停止中央不会自动终止节点操作；节点可能继续提交并在重连后回报。卸载插件会尝试取消执行并保留本地记录，取消不等于撤回提交。

| 位置 | 需要保留 |
| --- | --- |
| 中央数据目录 | 整个目录，包括 `central.sqlite`、仍存在的 WAL/SHM 和 `artifacts/`。 |
| 每个节点 | `managed-node.json`、`<DSH_HOME>/dsh-code-review/managed/`，以及独立保存的凭据。 |
| 业务仓库 | 代码、`.ai-review/`、Git 尚未交付的本地提交和工作副本现场。 |

停中央进程后复制整个数据目录是最容易操作的备份方式；节点执行记录应在执行停止后备份。运行中只复制 SQLite 主文件可能漏掉 WAL。远端代码不能替代尚未交付的本地提交和执行记录。

### 任务待核验时

先确认旧执行进程停止，再核对工作副本、日志和原提交。任务详情中勾选“我已确认旧执行进程停止”，点击“核验并重试原提交交付”。此入口核验原业务与交付，不重新批准或重跑 Agent。

| 情况 | 处理 |
| --- | --- |
| Git 原提交存在，网络或凭据有问题 | 修复连接后重试原交付，不再次批准。 |
| Git 远端分叉或非快进 | 保留原提交及项目占用，管理员核对并处理目标分支；工具不强推、不自动合并或改写已审提交。 |
| 找到 `Dsh-Command` 标记，完整结果丢失 | 可核验提交交付，但业务结果仍可能待核验；找到提交不证明批准成功。 |
| SVN 提交结果不明 | 查询原 revision 和内容；证据不足时保留现场，不再次提交。 |
| 节点记录丢失或结果无法证明 | 保持待核验与写阻塞，人工恢复；没有“强制成功”或直接释放占用按钮。 |

不要删除运行数据库、清除任务或复用旧节点身份绕过阻塞。吊销凭据不会停止已经运行的操作。

## 6. 升级与常见故障

脚本部署的实例：先停止旧进程，再执行 `deploy.* --target <原部署目录>`；需要远端最新源码时增加 `--git`，完成后运行部署目录里的 `start.*`。重复部署只替换程序，保留原数据目录及节点状态；首次安装的插件固定路径仍为 `<target>/app/node_modules/dsh-code-review`。

升级前备份并处理未决任务；停止待升级进程，替换或重新安装对应版本包，再使用原数据目录启动。节点升级保留 `managed/`、配置和凭据。启动后检查协议、工作副本和同步状态。当前未承诺自动跨版本数据迁移或降级兼容，应先隔离验证目标版本。

| 现象 | 优先检查 |
| --- | --- |
| 登录失败或看不到原数据 | 建账号与启动服务是否用同一绝对数据目录；当前 CLI 不提供改密命令。 |
| 静态资源未构建 | 源码执行 `npm run build:central`；独立部署使用完整中央包。只编译 server 不会暂存 Web。 |
| 节点一直离线 | 中央地址/TLS、Token 引用、DSH 继承的环境、实际 Node 运行时、工作副本和日志。 |
| 重启后实例冲突 | 确认旧实例退出；在线窗口约 30 秒，窗口内新 instanceId 可能被拒绝。 |
| 节点在线但项目未同步 | 仓库读取、目标、凭据与同步错误；在线不表示内容已更新。 |
| 项目可读但不能操作 | 项目启用、协议、新鲜度、候选负责人及未决任务。 |
| 改目录或分支后拒绝启动 | 同一 workspaceId 的真实目录、仓库类型与目标已持久绑定；先核验旧执行，再按新 workspace 接入，不删除记录强行重绑。 |

项目存在未决任务时，改名、启停等配置修改也会被拒绝。Web 不支持在线迁移节点、工作副本或目标分支，也不提供自动故障转移。

## 7. 验证范围

本轮插件中央连接、项目接入及整合包验证见[插件中央验证记录](plugin-central-validation.md)。其中明确区分真实 HTTP/进程/安装测试与尚未执行的 DSH 桌面交互及本轮三平台原生验收。

已有隔离 Git/SVN、中央 API、插件资源和 tarball 离线安装验证，见[拆包验证记录](package-boundaries-validation.md)。新增脚本已通过 Windows、Ubuntu、macOS 原生 CI 的类型检查、构建和部署集成测试，范围见[一键部署验证记录](oneclick-deployment-validation.md)。真实 DSH 加载、模型调用、跨机器 HTTPS 和各项目工具链仍需在目标环境验收。
