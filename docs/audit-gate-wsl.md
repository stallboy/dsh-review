# Windows DSH 审查的 WSL2 隔离门禁

> **任务来源**: 用户要求将已验证的 WSL2 + bubblewrap 门禁做成可复用的本地启动器，并接入日常 DSH 审查。
> **任务内容**: 安装用户级启动器，验证隔离，在重试样例中执行真实 Codex 三阶段审查和 Host 收尾。
> **参考文档**:
> - `SPEC.md` — 分阶段审查、受限门禁和 Host 收尾契约。
> - `docs/plans/2026-11-20-dsh-multi-runner-audit-prompt-design.md` — 重试样例源码和审查验收流程。
> - `https://github.com/containers/bubblewrap/blob/main/bwrap.xml` — bubblewrap 命名空间和进程回收参数。
> **生成日期**: 2026-11-20

## 安装到日常 DSH

使用包含分阶段审查功能的 DSH 评审插件，并在本地 Git 审查模式启用。安装仅写入当前用户的门禁配置。中央托管入口的模式由其现有连接设置决定。在 Windows 上准备 WSL2 发行版。发行版内需要 `/usr/bin/bwrap`、`/usr/bin/python3`、`/usr/bin/sh` 和支持仓库门禁的 Linux Node。编译 Windows 启动器使用系统的 64 位 .NET Framework 4.x C# 编译器。

在仓库根目录 PowerShell 中运行安装脚本。把发行版名和 Node 路径换成实际值。

```powershell
wsl.exe --list --verbose
wsl.exe -d Ubuntu-22.04 --exec sh -lc 'command -v bwrap; command -v python3; command -v node'
.\scripts\install-audit-gate-wsl.ps1 -Distribution Ubuntu-22.04 -LinuxNodePath /usr/bin/node
$gateLauncher = [Environment]::GetEnvironmentVariable('DSH_AUDIT_GATE_SANDBOX', 'User')
& $gateLauncher --probe
```

安装器将启动器和 WSL 脚本放入 `%LOCALAPPDATA%/dsh-audit-gate-wsl/` 下的版本目录。隔离自检通过后，才更新当前 Windows 用户的 `DSH_AUDIT_GATE_SANDBOX`。新启动的 DSH 进程读取这一配置。已打开的 DSH 会话结束后，再重新启动日常 DSH。安装器会输出此前的用户级值，回退时可用该值恢复，下例清除用户级配置。

```powershell
[Environment]::SetEnvironmentVariable('DSH_AUDIT_GATE_SANDBOX', $null, 'User')
```

在 DSH 里预览本地 Git 仓库的分阶段审查提示词。出现 `"automaticCandidates": true` 表示该 Host 已识别启动器。用 `--probe` 或实际门禁确认隔离正常。

## 门禁执行范围

Host 把专用 Windows 副本路径和受信配置中的门禁命令传给启动器。启动器复制普通文件和目录，跳过 `.git`、`.ai-review`，遇到重解析点、越界路径或传输超限时返回错误。传输上限为 20,000 个目录及文件和 256 MiB。启动器把候选副本送入 WSL 临时目录，并在 bubblewrap 内用 Linux `sh` 执行门禁。

沙箱使用独立的用户、进程和网络命名空间。命令可写入 `/work` 和沙箱临时目录。WSL 工具链以只读方式提供。Windows 工作区和 WSL 用户目录没有挂入沙箱，也不会传入宿主的凭据环境。门禁复用 Linux 语法和工具链。依赖应能从快照或已安装的工具链取得，网络安装步骤不适用。门禁退出码传回 Host，取消时关闭桥接管道并回收进程。Windows 副本和真实工作区仍由 Host 管理。

## 用重试案例验收

1. 按[重试案例](plans/2026-11-20-dsh-multi-runner-audit-prompt-design.md#71-准备独立样本仓库)建立独立 Git 仓库并提交两个样本文件。在 `.ai-review/reviewers.yml` 设置实际负责人，将 `node --test tests/retry.test.cjs` 放入 `allowed_gate_commands`，将 `verify_gate_on_audit_finalize` 设置为 `declared`。记录 `git rev-parse HEAD`。
2. 在新启动的 DSH 上下文为样本发起审查。附加要求逐行填写「同一请求最多写一次」和「保持现有 API 和存储接口」。要求三个阶段分别调用 Codex，检查后台重复写入，并为后台同 ID 重试新增回归测试。
3. 检查会话工具日志。应依次出现 Codex 初审、独立复核和生成补丁，复核为 `confirmed`，补丁为 `ready`。等待产物发布及会话回合结束。宿主未提供自动收尾事件时，使用审查面板的「收尾并提交」或调用 `POST /audit/finalize`。
4. 检查 Host Job 的结果为 `COMMITTED`。门禁证据应显示新测试和基线三项测试共 4 项通过，档案中的复算模式应为 `declared`，结果 1 个候选通过。审核期间观察两个桥接输出的传输包 SHA-256，或独立比较两次执行所用文件字节。
5. 用 `git diff --name-only <基线> HEAD` 检查共享提交应只有本轮 `.ai-review/audits/<auditId>/audit.md`、候选 `review.md` 和 `001.patch`。用 `git diff <基线> HEAD -- src tests` 确认无业务差异，并运行 `git status --short`。可在另一合成副本把新增测试应用到旧实现，确认能复现失败。

隔离自检会验证工作目录可写，副本外的探针文件不可读写，且无法连接 WSL 宿主的探针监听端口。它可以在发起模型审查前单独执行。

## 本机验收记录

2026-11-20 在 Ubuntu-22.04、bubblewrap 0.6.1 和 Linux Node 24.15.0 上完成验证。日常入口按用户选择保留，安装器设置当前用户的门禁环境变量。临时 DSH 实例从相同用户配置读取启动器。

- 真实 DSH 会话为 `session-2a628a47-0c43-4320-889c-b54e7c1d3fa4`，审查 ID 为 `20261120-052422-repo`。总调度由本地验收脚本驱动，初审、独立复核和补丁生成分别执行一次真实 Codex 调用。Host 核验通过 8 条基线证据。
- 样本基线为 `74639d24aabfa21ce43d389bb9f64b2cee767010`，Host 收尾提交为 `d82c2ee6c0054f0e3d139c0931d79c858432bcb4`。提交恰好包含本轮档案及候选的 `review.md`、`001.patch`，`src`、`tests` 无提交差异，工作树干净。
- 候选在隔离副本中的四条测试全部通过，Host 以 `declared` 复算通过。另一个独立副本重新应用补丁后四条通过，旧实现配合新增回归用例出现一条预期失败。
- 启动器单独验证了中文文件名、退出码 37 原样返回、稳定传输包哈希、排除评审和 Git 数据、沙箱写入不回传 Windows 副本、凭据环境不继承。取消探针先确认 Linux 进程存在，断开 Windows 桥接后确认进程消失。
- 仓库类型检查和构建通过，全量回归 467 项中 465 项通过、2 项跳过。新增的 ZIP 编码与边界检查、沙箱窄挂载两项回归另行通过。现有测试断言保持原有要求。
