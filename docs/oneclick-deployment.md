# 一键部署与一键启动

> **任务来源**: 用户要求 Windows、Linux、macOS 的中央服务和 DSH 节点脚本，并明确部署与启动分开、允许重复覆盖、`--git` 先拉取最新源码，目标机已有 Node.js 24。
> **任务内容**: 说明首次部署、独立启动、重复升级、离线包与节点连接配置，列明数据保留和验收方式。
> **参考文档**:
> - `../scripts/deploy.mjs` — 部署参数、安装与替换流程。
> - `../scripts/start.mjs` — 独立启动与进程记录。
> - `central-deployment.md` — HTTPS、账号、备份与故障恢复。
> - `../packages/dsh-plugin/src/managed/managed-config.ts` — 节点配置与凭据引用。
> **生成日期**: 2026-11-17

部署和启动是两个独立操作：`deploy` 安装或覆盖程序，`start` 运行已部署程序。更新前先停止原进程，完成部署后再运行启动脚本。启动采用前台运行，使用 Ctrl+C 停止；脚本不安装系统服务。

## 准备与入口

机器需要 Node.js 24 或更新版本以及随 Node 安装的 npm；版本不满足时退出，不会自动安装。源码构建需要访问 npm，`--git` 还需要 Git 与仓库访问权限。节点另需已安装的 DSH、业务 Git/SVN 工作副本、模型和项目工具链。

在仓库根目录使用对应入口：

| 平台 | 部署 | 启动 |
| --- | --- | --- |
| Windows / PowerShell | `.\deploy.cmd` | `.\start.cmd` |
| Linux | `./deploy.sh` | `./start.sh` |
| macOS | `./deploy.command` | `./start.command` |

所有入口参数相同，也可用 `node scripts/deploy.mjs`、`node scripts/start.mjs`，或 `npm run deploy -- ...`、`npm start -- ...`。从 ZIP 解压后若可执行权限丢失，运行 `chmod +x deploy.sh start.sh deploy.command start.command`。先在终端完成首次配置；部署目标中的启动入口可直接运行。

默认中央目录是 `~/dsh-review/central`，节点目录是 `~/dsh-review/node`；`~` 表示运行脚本的系统账号主目录。推荐显式指定 `--target`，并在后续更新时使用同一路径。部署目录必须在源码仓库外，也不能是磁盘根目录。

## 首次部署中央

Windows：

```powershell
.\deploy.cmd --role central --target C:/dsh-review/central
C:/dsh-review/central/start.cmd
```

Linux：

```sh
./deploy.sh --role central --target "$HOME/dsh-review/central"
"$HOME/dsh-review/central/start.sh"
```

macOS：

```sh
./deploy.command --role central --target "$HOME/dsh-review/central"
"$HOME/dsh-review/central/start.command"
```

部署使用当前源码安装构建依赖并打包。首次没有账号时，终端提示输入 12～256 字符密码，输入不回显；默认登录名及审核身份为 `reviewer`，可用 `--username`、`--review-identity` 修改。无人值守部署须预设 `DSH_REVIEW_PASSWORD` 环境变量，完成后清除。已有账号时不会重建账号或修改密码。

默认数据目录为 `<target>/data`，监听 `127.0.0.1:3081`；启动后访问 `http://127.0.0.1:3081`。可在部署时提供 `--data-dir <绝对目录>`、`--host`、`--port`。正式访问还需 `--public-url https://review.example.com` 与 TLS 反向代理，具体见[对外访问](central-deployment.md#25-正式对外访问)。公开 URL 参数不会建立 TLS。

## 首次部署 DSH 节点

先登录中央，在“执行节点”创建凭据，保存节点 ID 与一次性 Token。以下路径和 ID 要换成实际值。

Windows：

```powershell
.\deploy.cmd --role node --target C:/dsh-review/node --dsh-home C:/dsh-state --dsh C:/DSH/dsh.exe --center-url https://review.example.com --node-id node-id --workspace C:/repos/project --workspace-id project
$secureToken = Read-Host '节点 Token' -AsSecureString
$env:DSH_REVIEW_NODE_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
C:/dsh-review/node/start.cmd
Remove-Item Env:DSH_REVIEW_NODE_TOKEN
Remove-Variable secureToken
```

Linux/macOS 终端以 Bash 或 Zsh 为例，macOS 把 `.sh` 换成 `.command`：

```sh
./deploy.sh --role node --target "$HOME/dsh-review/node" --dsh-home "$HOME/.dsh" --dsh /opt/dsh/bin/dsh --center-url https://review.example.com --node-id node-id --workspace "$HOME/repos/project" --workspace-id project
printf '节点 Token：'
read -r -s DSH_REVIEW_NODE_TOKEN
printf '\n'
export DSH_REVIEW_NODE_TOKEN
"$HOME/dsh-review/node/start.sh"
unset DSH_REVIEW_NODE_TOKEN
```

DSH 启动程序通过 `--dsh` 指定已有的原生可执行文件或 Node CLI 文件绝对路径。Windows 支持 `.exe`、`.js`、`.mjs`、`.cjs`，不接受 `.cmd`、`.bat`、`.ps1`；若 `dsh` 命令指向 npm 包装脚本，改用它背后的 JavaScript CLI 路径。额外参数可用 `--dsh-args '["参数1","参数2"]'`，其内容是 JSON 字符串数组。

首次还要在 **DSH 插件管理器**安装并启用部署输出的路径 `<target>/app/node_modules/dsh-code-review`。请通过脚本启动与 `--dsh-home` 相同的 DSH 实例完成此步骤；以后不要改装到暂存路径。再次部署会保留此固定安装路径，更新后重新启动 DSH。脚本不会自动操作插件管理器，部署成功不等于插件已启用或节点在线。

连接配置写入 `<DSH_HOME>/dsh-code-review/managed-node.json`。Token 原文不写入部署配置；默认 `tokenReference` 为 `DSH_REVIEW_NODE_TOKEN`，启动 DSH 时从同名环境变量读取，也可用 `--token-reference` 指定 DSH 凭据服务中的引用。若使用环境变量，每次启动都要让 DSH 继承它。

已有节点配置、工作副本和执行记录会保留。使用原目录再次部署时无需重复输入这些参数；同一节点不能通过覆盖部署改换中央地址或节点 ID，同一 `workspaceId` 不能改指另一目录。更详细的多工作副本配置见[节点配置](central-deployment.md#33-写入节点配置)。

## 重复部署与更新

先处理未决任务、备份数据，并停止该部署的中央或 DSH 进程。以下以中央为例，节点使用原节点 `--target`：

```powershell
.\deploy.cmd --target C:/dsh-review/central
.\deploy.cmd --target C:/dsh-review/central --git
C:/dsh-review/central/start.cmd
```

前两行是两种部署方式，按需要执行其中一行：不带 `--git` 使用当前源码；带 `--git` 在临时目录重新克隆仓库最新 `master` 后构建，再替换程序及该版本的启动文件。此方式不会对本地源码执行 pull、reset 或清理。默认仓库是 `https://github.com/stallboy/dsh-review.git`，可用 `--repository <仓库URL或本地路径> --branch <分支>` 改变来源，这两个参数只能与 `--git` 一起使用。仓库目标版本须包含本说明中的启动脚本；缺少文件或 Git 失败时退出，旧部署保留。

重复部署替换整个 `<target>/app`，旧版多余程序文件也会移除；数据目录、原账号、未显式修改的监听配置、节点连接配置及执行记录保留。数据和工作副本不能位于 `app` 内，也不能包含 `app`。不要在 `app` 内手工保存需要保留的文件。

`start` 只读部署结果，不安装依赖、不构建、不获取 Git。部署目录内自带启动脚本和必要文件，启动时无需保留源码仓库。也可从源码用 `start.* --target <目录>` 启动任意已有部署。

## 安装包部署与目录布局

构建机在源码根运行 `npm run pack:central` 或 `npm run pack:plugin`，生成自带运行依赖的 `.tgz`。把包、六个根入口（`deploy.*` 与 `start.*`）及 `scripts/` 一并复制到目标机并保留相对目录结构，执行：

```powershell
.\deploy.cmd --role central --target C:/dsh-review/central --package C:/packages/dsh-review-server-0.1.0.tgz
```

节点使用插件包并增加首次配置参数。`--package` 使用离线安装，不构建源码；不能与 `--git` 同时使用，包的版本和文件名以实际产物为准。

| 位置 | 用途 |
| --- | --- |
| `<target>/app` | 每次部署替换的程序与依赖。 |
| `<target>/data` 或显式数据目录 | 中央数据库及附件，需备份。 |
| `<target>/deployment.json` | 部署角色、启动参数、包版本；Git 模式还记录提交号。 |
| `<target>/start.*` 与 `scripts/` | 脱离源码仍可使用的启动入口。 |
| `<DSH_HOME>/dsh-code-review/` | 节点配置及 `managed/` 执行记录，需独立保留。 |

脚本使用 `.deploy.lock` 互斥部署/启动，用 `.running.json` 检查由脚本启动的进程。手工或服务管理器启动的程序仍需自行停止。异常断电后如遇锁文件，先核验相关部署/启动进程均已停止，再手工移除 `.deploy.lock`；不要绕过仍在运行的进程。不要删除节点执行数据库来解除业务占用。

部署失败会返回非零退出码，构建和安装失败不会替换原程序。程序发布阶段出错会尝试恢复旧程序和启动文件；恢复本身失败时保留备份并输出路径，请保留现场处理。这不能替代升级前的数据库和节点备份，也不承诺跨版本降级兼容。

## 验收

中央启动后检查 `/health`、页面和原账号登录。节点启动后检查插件已启用、中央“执行节点”在线、协议兼容、工作副本及项目同步正确。后续业务测试按[部署与运维](central-deployment.md#4-接入项目与首次验收)执行。

三平台 CI 定义在 `.github/workflows/deployment.yml`，会在 Windows、Ubuntu、macOS 上运行 Node 24 的构建、类型检查和部署集成测试。本次三平台原生 CI 均已通过，具体提交、运行链接及真实 DSH/模型环境的验收边界见[部署验证记录](oneclick-deployment-validation.md)。
