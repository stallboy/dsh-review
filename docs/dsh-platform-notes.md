# DSH 平台能力核查与探针记录

> 用途：把 2026-11-03 这轮对 DSH 宿主的**实测结果**固化下来，供 `dsh-code-review` 及后续任何 DSH 插件开发复用。
> 相关文档：`docs/plans/2026-11-03-audit-two-phase-design-proposal.md`（两阶段审查设计提案，未落地）、`README.md`（插件 as-built）。
>
> **结论分级（全文遵守，不要越级当事实）**
> - **[装配]** 从 profile / `cordis.patch.yml` / 包清单直接读到
> - **[运行时]** 在独立 Node 进程加载真实包并遍历原型验证
> - **[源码]** 读了实现代码（`app.asar` 内 `dsh/node_modules/**`）
> - **[推断]** 合理推测，未验证 —— 用之前必须先跑 B0 清单（§8）

---

## 0. 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| DSH 版本 | `0.2.1-rc.5`（全部 `@deepseek-ai/*` 包同版本） | [装配] `dsh/desktop-runtime.json` 包清单 |
| 实现位置 | `<install>/resources/app.asar`（打包，约 182 MB） | 磁盘 |
| CLI | `<install>/resources/app.asar.unpacked/bin/dsh.cmd` → 实际入口 `<install>/resources/runtime/cli/bin/dsh.cmd` | 磁盘 |
| `$DSH_HOME` | `C:\Users\Administrator\.dsh`（`profiles/`、`sessions/`、`storages/`、`dsh-code-review/`） | 磁盘 |
| 运行时 | Node `v24.15.0`（已导出 `zlib.zstdDecompressSync`）、npm `11.12.1`、git `2.45.1` | 实测 |
| 本插件安装方式 | `desktop` profile 里 `dsh-code-review: "link:F:/workspace_2/dsh-review"` | [装配] `~/.dsh/profiles/desktop/package.json` |
| 插件共享依赖位置 | `~/.dsh/profiles/node_modules/@deepseek-ai/*`（200+ 包） | 磁盘 |

---

## 1. 探针方法（可复用）

### 1.1 读 `app.asar`（不需要 Electron）

asar 是"头 + 连续数据块"：偏移 `12` 处是 header JSON 的字节长度，header 从偏移 `16` 开始；文件数据区起始于 `8 + headerJsonSize`（按 4 字节对齐），每项记录自己的 `size` / `offset`。

仓库里留了一个可直接用的脚本：`.tmp/asar-probe.mjs`（被 `.gitignore` 忽略）。

```powershell
# 列出匹配的条目
node .tmp/asar-probe.mjs '<install>\resources\app.asar' list '^dsh/node_modules/@deepseek-ai/dsh-subagent/'
# 解出到目录（扁平化命名，'/' 变 '__'）
node .tmp/asar-probe.mjs '<install>\resources\app.asar' extract '^dsh/node_modules/@deepseek-ai/dsh-subagent/' .tmp/probe-out
```

**坑**：`dsh/desktop-runtime.json`（4 MB）是**包清单**（`name/version/path/bytes/sha256`），不是源码；真正的实现在 `dsh/node_modules/**` 里。

### 1.2 dump 装配树

```powershell
dsh --profile web     --dump-config   # 可用
dsh --profile headless --dump-config  # 可用（会自动就位）
dsh --profile desktop --dump-config   # 失败：profile "desktop" is managed exclusively by the Electron application
```

装配顺序：**shipped template → bundle 层（`dsh-base` → `dsh-web-app` → `experimental-*`）→ 用户覆盖 → `--patch` overlay**。
要判断"某个服务在桌面端到底挂没挂"，最可靠的做法是读 `dsh-base/cordis.patch.yml`（基线层），再确认目标 bundle 是否在 `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` 里。

### 1.3 运行时验证包 API

在独立 Node 进程里 import 真实包，遍历原型 —— 能确认"方法真的存在"，而不只是源码里有字符串：

```powershell
$code = @'
const mod = await import("file:///C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/dsh-subagent/lib/index.js");
const C = mod.default;
console.log("class:", C.name, "| base:", Object.getPrototypeOf(C)?.name);
console.log(Object.getOwnPropertyNames(C.prototype).filter(n => typeof C.prototype[n] === "function").join(", "));
console.log(C.prototype.start.toString().replace(/\s+/g, " ").slice(0, 400));
'@
Set-Content "$env:TEMP\probe.mjs" $code -Encoding utf8
node "$env:TEMP\probe.mjs"
```

bare specifier 能解析，是因为被 import 的模块位于 `~/.dsh/profiles/node_modules` 下，其同级 `node_modules` 解析链天然生效。

### 1.4 结论分级纪律

任何"平台支持 X"的结论都要标级别。**`[推断]` 一律不得写进设计的前提**，要么补一次探针升级成 `[运行时]`，要么写明降级路径。

---

## 2. 平台服务目录（与本插件相关）

| 服务名 | 提供包 | 用途 | 本插件现状 | 级别 |
|---|---|---|---|---|
| `webServer` | `dsh-host-webserver` | 挂载插件 HTTP 路由 | 已用（`register({kind:'prefix'})` + `ctx.effect` 卸载） | 源码 |
| `sessions` | `dsh-session` | `get(id).header.cwd` 解析仓库根 | 已用 | 源码 |
| `agents` | `dsh-agent` | 活体 Agent 注册表 `get(id)` | **未用**（L2 需要） | 源码（subagent 内部使用） |
| `sessionController` | `dsh-api-session-controller` | `create / rename / prompt` 创建审查会话 | 已用 | 源码 |
| `workspaceRegistry` | `dsh-workspace` | `resolveByPath / list` 把会话挂到工作区 | 已用 | 源码 |
| `permissionPresets` | `dsh-permission-presets` | `current / set` 继承权限预设 | 已用 | 源码 |
| `approval` | `dsh-user-approval` | `overrideOf / setPolicy` 继承审批策略 | 已用 | 源码 |
| `credentials` | `dsh-credentials` | `resolve('DEEPSEEK_API_KEY')` | 已用 | 源码 |
| `clientModules` | `dsh-client-modules` | `graph()` 判断客户端入口是否已注册 | 已用（仅诊断） | 源码 |
| `subagents` | `dsh-subagent` | 子代理编排（本轮重点，见 §3） | **未用**（新设计要用） | 运行时 + 源码 |
| `tools` | `dsh-tools` | 工具注册表 `get(name, agent)` | 未用 | 源码（subagent 内部使用） |
| `llm` | `dsh-llm` | `listProviders / listModels / resolveModelInfo` | 未用 | 源码 |
| `workingDirectory` | `dsh-workspace` | `ensure(parent, signal)` 解析相对 cwd | 未用 | 源码 |
| `sessionPersistence` / `sessionQuery` / `sessionProjections` | `dsh-session-*` | 会话持久化、查询、投影 | 未用 | 源码 |

> 插件通过 `ctx.get('<name>')` 取服务；本插件已成功取出 7 个服务，说明其 ctx 作用域足够宽，取 `agents` / `subagents` 属同一模式。

---

## 3. `subagents` 深挖（本轮核心）

### 3.1 装配

基线层 `dsh-base/cordis.patch.yml` `:328-352`（文件位于 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/`）：

```yaml
- id: subagent            name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process   name: '@deepseek-ai/dsh-subagent-spawn-in-process'   providerName: spawn
- id: subagent-fork-in-process    name: '@deepseek-ai/dsh-subagent-fork-in-process'    providerName: fork
- id: tool-subagent       name: '@deepseek-ai/dsh-tool-subagent'   toolName: subagent   provider: spawn
- id: tool-subagent-fork  name: '@deepseek-ai/dsh-tool-subagent'   toolName: subagent_fork   provider: fork
- id: tool-subagent-control / list-agents
```

- `desktop` profile = `dsh-base` + `dsh-web-app` + `dsh-experimental-*` + 本地插件 ⇒ **服务与 `spawn` provider 必然可用 [装配]**。
- `experimental-agent-team-profile` 会**禁用**全局 `subagent` / `subagent_fork` 工具、换成 `spawn_teammate`，但**服务与两个 provider 仍对 teammate / workflow 可用** [装配 + 该包 README]。

### 3.2 公开 API（运行时实测）

`SubagentRuntime`（包默认导出，`extends TypertRemoteService`）原型方法：

```
start, startContinuable, prompt, interrupt, interruptByParent,
list, listChildren, listDescendants, drainContinuableDescendants, drainContinuableChildren,
registerProvider, getProvider, expectProvider, prepareContinuable, requireContinuations,
observeActivation, assertCapabilities, sendMessage, remoteExportList
```

**两个表面，别搞混（这是 B0 探针抓到的第一个坑）**

| 表面 | 谁用 | 入口 | 在插件里能用吗 |
|---|---|---|---|
| **activation 表面** `ctx.get('subagents')` | 宿主内部插件 | `startActivation(spec)`、`sendMessage`、`waitForChildren`、`listChildren`… | ✅ 这才是插件要调的 |
| **remote 表面** 包的默认导出 `SubagentRuntime` | typert 远程 / UI / 工具 | `start(name, request)`、`startContinuable`、`prompt`、`interrupt` | ❌ **宿主上根本没有 `start`** |

实测的宿主方法表（`/health → adversary.methods`，20 个）：

```
assertCapabilities, drainChildren, drainDescendants, emitLifecycle, expectProvider,
getProvider, interrupt, interruptByParent, list, listChildren, listDescendants,
observeActivation, prepareContinuable, prompt, registerProvider, requireManager,
resolveMaxDepth, sendMessage, startActivation, waitForChildren
```

### 3.3 调用契约（B0 实测 + 源码）

`startActivation(spec)` 的 spec 形状（已真机跑通）：

```ts
{
  provider: 'spawn',
  label: 'audit-verifier/item-001',      // 必传字符串（见下）
  request: {
    parent,                               // 活体 Agent 实例（必须有）
    prompt: [{ type: 'text', text }],     // 内容块数组，不是字符串
    cwd: '/abs/path',                     // 绝对路径 → 直接使用
    maxDepth: 1,                          // ≥1；0 会抛错
    agentOptions?: { provider, model, reasoningEffort },
    agentPreset?: string,
  },
  delivery: 'caller',                     // 结算通知不插父会话
  signal: AbortSignal,                    // 必传
}
```

| # | 契约事实 | 依据 | 违反后果 |
|---|---|---|---|
| 1 | 宿主入口是 `startActivation(spec)`，**没有 `start`** | `/health` 实测方法表 | `undefined is not a function` |
| 2 | `spec.label` **必传字符串** | `snapshotSubagentDescriptor` 无条件带 `label`；`snapshotJsonValue({label: undefined})` 返回 `undefined` → 抛 "not losslessly JSON-serializable"（独立进程实测） | 入口即抛 |
| 3 | `spec.signal` **必传** `AbortSignal` | `startLocal()` 里 `spec.signal.throwIfAborted()` 无条件调用 | TypeError |
| 4 | `request.prompt` 是**内容块数组** | `withContinuableReturnGuidance()` 对它做 `[...prompt, {...}]` | 消息结构非法 |
| 5 | `maxDepth` **不能为 0** | `resolveChildDepth()` 算 `parentDepth + 1`，超限抛 `SubagentDepthError`；子代理本身就在深度 1 | 抛错 |
| 6 | 遍历服务原型**不能读 getter** | Cordis 服务原型的 getter `this` 绑到原型（presets 的 `selectedDefault`） | 探测时抛异常 |
| 7 | `parent` 必须是**活体** Agent：`agents.get(parent.id) === parent` | `index.js:3046` 断言 | `UNAUTHORIZED` |
| 8 | 返回 `receipt = { childId, result: Promise, dispose }` | `index.js:1511` `return this.receipt(activation)` | — |
| 9 | `delivery: 'parent'`（默认）会把结算通知**插入父会话**；`'caller'` 直接 return | `index.js:2050` `notifySettlement` | 污染用户对话 |
| 10 | 子代理**继承父的 permission roots**，内部不能扩大 | `index.js:364` 注入的 `subagent:delegation` 文本 | 验证者仍可能写文件 |
| 11 | spawn 能力齐备：`depthLimit` / `outputSchema` / `agentOptions` / `agentPreset`；`inheritsParentContext = false` | `dsh-subagent-spawn-in-process/lib/index.js:20-35` | — |
| 12 | `maxActiveSubagents` 默认 8；超限 `ACTIVATION_LIMIT_REACHED` | README + 源码 | 复核排队 |

### 3.4 真实可用的调用形状（已在本机跑通）

```ts
const parent = ctx.get('agents')?.get(launchSessionId);   // 必须是活体 Agent
if (!parent) throw new Error('no-live-parent-agent');

const controller = new AbortController();
const receipt = await ctx.get('subagents').startActivation({
  provider: 'spawn',
  label: `audit-verifier/${itemId}`,        // 必传
  request: {
    parent,
    prompt: [{ type: 'text', text: verifyPrompt }],  // 内容块数组
    cwd: worktreePath,                      // 绝对路径 → 隔离
    maxDepth: 1,                            // 1 = 有它但不能再派生
    agentOptions: { provider, model, reasoningEffort },
  },
  delivery: 'caller',                       // 不污染用户会话
  signal: controller.signal,                // 必传；超时前 abort()
});
try {
  const result = await receipt.result;      // 完成即得结果，无需轮询
} finally {
  await receipt.dispose();
}
```

**B0 实测结果（2026-11-03，真机）**

| 断言 | 结果 |
|---|---|
| `startActivation` 存在 + `getProvider('spawn')` 非空 | ✅ `available: true`、`startKind: activation`、`providers: [spawn, fork]` |
| `agents.get(launchSessionId)` 返回活体 Agent | ✅ `launchAgentResolved: true`（且 spawn 未被 `UNAUTHORIZED` 拒绝） |
| `delivery:'caller'` + 绝对 cwd 起回声子代理 | ✅ `ok: true`，2.35 s 拿到 `ECHO-OK`，`childId` 返回，`disposed: true` |
| 用户会话是否被插入结算消息 | ✅ **0 条** user-role 子代理消息；会话日志只多出 `subagent/catalog` 事件，子会话日志独立存在 |
| 预设服务 | ✅ 可用，方法含 `list/select/mount/composedPreset`；本机预设：`standard`、`ptc`、`minimal`、`cordis`、`skills` 等 |

### 3.5 对插件开发的含义

1. **不能"凭空"起子代理**：必须有活体 Agent 当 parent ⇒ 需要锚点会话（发起会话 / 专用编排会话）。
2. **拿得到 `result` promise**：比轮询产物文件或翻 zstd 会话日志确定性高一个量级 —— 这是设计里放弃 `SessionAdversary` 的直接原因。
3. **`delivery:'caller'` 必传**：实测确认不传会往父会话插结算消息。
4. **`label`/`signal`/内容块/`maxDepth≥1` 是硬约束**，四个都会在入口直接抛错。
5. **`agentPreset` 只能收窄"工具与人格"，收不窄权限根**：预设是 agent 组合层的东西（tools/persona/prompt），沙箱权限根来自父会话。所以"给验证者只读预设"能减少它能做的事，但**不能替代篡改检测**。

---

## 4. 权限与审批

- `permissionPresets.current(sessionId)` / `.set(...)`：插件用它把审查会话的权限预设继承自发起会话（`index.ts:135-176`，含 `custom` 回退与逐级 try/catch 降级）。
- `approval.overrideOf(...)` / `.setPolicy(...)`：继承审批策略。
- **事实风险**：本机实际审查会话继承到 `danger-full-access` + `never`（安全评审 `sec.md` P1）：被审仓库里的一段文本即可让 AI 在无人审批下执行命令。
- 子代理继承 permission roots 且**不能从内部扩大**（平台已注入明确提示），但**可以继承到很宽的权限** —— 所以验证者仍需要权限收窄或篡改检测。

---

## 5. 会话与持久化

- `sessions.get(id).header.cwd` 是插件解析"评审仓库"的唯一来源（优先级高于 settings 里的 `repoRoot`）。
- 会话日志落 `$DSH_HOME/sessions/**`，格式为**逐帧 zstd**（magic `28 B5 2F FD`）；Node 24 可用 `zlib.zstdDecompressSync` 解。
- `$DSH_HOME/storages/workspace.json` 记录 workspace 的 `path` 与 `sessionIds`（侧边栏可见性靠它）。
- **关键缺口**：`sessionController.prompt()` 只返回 `{accepted:true}`，**没有任何"会话/回合结束"的 API 事件**。想等一个会话跑完，只能：① 盯约定的产物文件；② 轮询并解压会话日志（`scripts/verify-audit-session.mjs` 就是这么干的，脆弱）。**这是放弃 `SessionAdversary` 的第二个理由。**

---

## 6. 客户端插件运行模型

- `dist/client.js` 是 **classic script**（`tsconfig.client.json` 里 `module: "none"`），手写 IIFE，唯一全局依赖 `window.__ModuleLoader__`，React 靠 `requireModule('react')`。
- 视图注册：`ctx.slots.inject('conversation.view', ...)` + `register({id, order, label, locale})`；样式/locale/slot 三件套都必须走 `ctx.effect` 并在卸载时回收。
- 样式须用主题令牌（`--dsw-alias-*`），产品约束是**不弹 modal / 不遮罩**。

---

## 7. 已验证的坑（清单）

1. **`desktop` profile 不能被 CLI 启动**（Electron 独占）→ 想脱离 GUI 验证只能新起 `web` / `headless` profile。
2. **重启桌面 app 会结束当前会话** → 不要把"重启 app"当作验证手段。
3. **`dist/` 可能 stale**：实测 `dist/patch.js` 与当前 `src` 不一致（审查会话应用补丁后没重建）；而插件是 `link:` 安装，GUI 直接读这棵树的 `dist/` ⇒ 改完必须 `npm run build` + 禁用/启用插件。
4. **`app.asar` 里的 `desktop-runtime.json` 是包清单不是源码**。
5. **`npm test` 实际 55 项**（README 写的 35 已过期），其中 SVN 用例在无 svn 的机器上 skip。
6. **`sessionController` 没有完成事件**（§5）。
7. **子代理默认把结算消息插进父会话**（§3.3）。
8. **`--dump-config` 只证明装配，不证明挂载成功**（服务可能因依赖缺失而挂不上）→ 关键能力仍需 B0 真机断言。

---

## 8. B0 真机验证结果（2026-11-03，已完成）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 宿主存在可用的 `startActivation`，且 `getProvider('spawn')` 非空 | ✅ 通过 | `/health → adversary`: `available:true`、`startKind:'activation'`、`providers:['spawn','fork']` |
| 2 | `ctx.get('agents').get(launchSessionId)` 返回活体 Agent | ✅ 通过 | `launchAgentResolved:true`；spawn 未被 `UNAUTHORIZED` 拒绝 |
| 3 | `delivery:'caller'` + 绝对 `cwd` 起回声子代理：拿到 `result`，且用户会话无新增消息 | ✅ 通过 | `POST /audit/probe` → `ok:true`、2.35 s、`childId` 非空、`disposed:true`；父会话日志中 **0 条** user-role 子代理消息，仅新增 `subagent/catalog` 事件；子会话日志独立存在 |
| 4 | 是否存在可用于验证者的受限预设 | ⚠️ 部分 | 预设服务可用（`list/select/mount/composedPreset`），候选 `minimal`；但**预设只改工具与人格，不改沙箱权限根** ⇒ 篡改检测仍是必需项 |

**B0 顺带修出的 6 个契约错误**（都会在 B3 变成难查的 bug）：

1. 宿主表面是 `startActivation(spec)`，不是 `start(provider, request)`（后者属 remote 表面）
2. `spec.label` 必传字符串
3. `spec.signal` 必传 AbortSignal
4. `request.prompt` 是内容块数组
5. `maxDepth` 不能为 0（子代理自身深度为 1）
6. 探测必须用属性描述符，不能读原型上的 getter

> 结论：**L2/L3 的对抗复核可以在本机落地**，不需要退化为"不复核 + 强制人工"。`parentAnchor` 的 `launch` 模式实测可用。

---

## 9. 附：本机 DSH 包清单（与本插件相关的高价值子集）

```
dsh-subagent / dsh-subagent-spawn-in-process / dsh-subagent-fork-in-process
dsh-subagent-in-process-driver / dsh-tool-subagent / dsh-tool-subagent-control
dsh-agent / dsh-agent-presets / dsh-agent-loop / dsh-agent-default-model
dsh-permission-presets / dsh-user-approval / dsh-authorization
dsh-api-session-controller / dsh-api-remotes / dsh-api-gateway
dsh-session-query / dsh-session-query-sqlite / dsh-session-projection*
dsh-plugin-manager(+ /tools) / dsh-typert-host / dsh-typert-remote
dsh-tool-workflow / dsh-workflow / dsh-workflow-worker-thread
```

完整 200+ 包清单可用 §1.1 的方法从 `dsh/desktop-runtime.json` 里提取。
