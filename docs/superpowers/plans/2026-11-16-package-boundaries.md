# 单仓多包边界整理实施计划

> **任务来源**: 用户已认可架构审查建议并要求执行整理拆分。
> **任务内容**: 落实独立插件 workspace、共享类型与独立交付，完成回归验证和独立审查。
> **参考文档**:
> - `docs/superpowers/specs/2026-11-16-package-boundaries-design.md` — 本次设计与范围。
> - `SPEC.md` — 审核、DSH 和中央模式契约。
> - `AGENTS.md` — 工作区、验证和提交要求。
> - `docs/central-deployment.md` — 需同步的部署指引。
> **生成日期**: 2026-11-16

在当前隔离 worktree 的 `worktree-package-boundaries` 分支内执行。用户已批准上一轮建议并明确要求实施，直接在当前会话执行，不重复请求方案确认。按 executing-plans 工作流逐项记录验证。

## 全局约束

- 不改审核行为、HTTP 路径、插件标识及持久化格式；不创建新 Git 仓库或独立核心包。
- 既有源码整体迁移，仅修改必要导入和资源路径；新增代码使用四空格缩进，不添加描述性注释。
- 测试仅随模块位置迁移；原断言、测试数量和覆盖范围不减少。
- 所有临时文件在 `.tmp` 内；构建和安装产物不提交。
- 不推送、不从本 worktree 合并到主分支。

## 审查重点

1. 插件安装后仍可加载 Host、经典脚本 Client、locale、图标与 AI 提示词。
2. 托管模块迁移后不绕过原 API、身份、guard、锁与恢复路径。
3. Web 使用的共享类型保持字段兼容，不引入 Node 运行时依赖。
4. 中央服务脱离 `apps/web` 目录后仍能提供页面与静态资源。
5. 离线安装两个 tarball 后没有依赖工作区链接或未发布的私有包。

## 任务 1：基线与回归约束

**文件**：新增 `tests/package-boundaries.test.mjs`、`tests/package-install.test.mjs`。

**接口**：现有 `package.json`、插件导出、`createCentralApp(options)` 和 `loadAuditSystemPrompt()`。

- [x] 安装依赖，运行 typecheck、build、全量串行测试，记录用例数量与失败。
- [x] 为根包职责、Web 越界导入和两个产物隔离安装增加回归测试。
- [x] 运行新测试，确认针对当前混合布局失败。

## 任务 2：插件与共享类型边界

**文件**：迁移根 `src`、`assets`、`locale`、`icon.svg`、`cordis.patch.yml`、两个 tsconfig 到 `packages/dsh-plugin`；新增插件 `package.json`、`README.md`、`THIRD-PARTY.md`；新增 `packages/protocol/src/review.ts`；修改 Web 类型导入、根构建配置及现有测试定位。

**接口**：插件仍导出 `dist/index.js`、`dist/client.js`；protocol 导出原字段不变的公开候选类型，插件 types 模块继续兼容原内部导入。

- [x] 迁移文件；把 `managed-*.ts` 移至插件 `src/managed` 并更新必要相对导入。
- [x] 将 Web 需要的纯数据类型及依赖类型移至 protocol；内部执行配置和异常留在插件。
- [x] 调整根包为工作区管理入口，更新锁文件及测试中的真实文件位置。
- [x] 执行类型检查和构建，验证新增边界测试与原插件/中央测试。

## 任务 3：交付、文档与最终验证

**文件**：修改 `apps/server/package.json`、`apps/server/src/app.ts`、`apps/server/src/cli.ts`；新增 `scripts/stage-central-web.mjs`、`scripts/pack.mjs`；更新根 `README.md`、`THIRD-PARTY.md` 和 `docs/central-deployment.md`。

**接口**：`npm run pack:plugin`、`npm run pack:central` 分别构建并产出安装包；中央静态目录为自身 `dist/public`，可继续注入 `webDir`。

- [x] 生成包含运行依赖的独立插件包与中央服务包，验证包内文件边界。
- [x] 离线安装到隔离目录，实际导入插件与提示词，并启动中央 API/静态资源和 CLI。
- [x] 更新部署说明与源码布局；执行 typecheck、build、全量串行测试，比较基线数量。
- [x] 独立审查后逐条复核，修复成立的问题；写入验证记录并清理 `.tmp`。
- [x] 检查 diff 与工作区卫生，使用中文说明改动、原因、SPEC 条款与验证结果提交到任务分支。

## 执行记录

- 2026-11-16：已确认现有目录是 linked worktree，基线 HEAD 为 `fa1d4cd`，初始工作区干净；已创建任务分支。
- 自审：保留原插件标识和编译入口；先不把审核核心提成包；部署验证使用真实安装包，避免只检查文件清单。
- 环境记录：普通沙箱无法下载锁文件镜像依赖，提升权限后 `npm ci` 安装成功；基线 typecheck 已通过。Vite/esbuild 在沙箱中读取父目录被拒绝，改为正常权限执行相同构建及测试命令，不修改实现绕过。
- 红灯记录：新增四项包边界/安装测试均按预期失败，分别暴露根包插件身份、Web 越界导入及缺少两个独立打包入口。
- 执行裁定：编译后的 Host/managed 保留各自子目录，新增一行 `src/index.ts` 转发插件公开入口，以保持 `dist/index.js` 和 `dist/client.js` 兼容；提示词查找路径随编译目录调整。
- 执行裁定：隔离安装夹具放系统临时目录，与源码仓库无祖先关系，防止 Node 从仓库的 node_modules 回退解析而掩盖漏包；测试日志及开发脚本仍放 `.tmp`。
- 基线：原有 261 项测试全部通过（291 秒），新测试未混入基线；迁移后类型检查及全仓构建通过。
- 锁文件：新增 workspace 的自动推导产生错误的 `file:../packages/dsh-plugin` 路径；按现有 workspace 链接格式补齐元数据后，由 npm 正常校验并完成全新离线 `npm ci`。第三方锁定版本、摘要与元数据均未变化。
- 交付红灯：直接 `npm pack --workspace` 没有收集提升到根 node_modules 的运行依赖；两个真实离线安装测试分别报缺少 protocol/Fastify。打包改为在 `.tmp` 中按 `npm ls --omit=dev` 的实际依赖树物化，再交给 npm 打包，保留嵌套依赖版本，不修改源工作区链接。
- 交付绿灯：四项新增检查全部通过，包含仓库外离线安装、插件入口/经典脚本/locale/图标/提示词，以及中央 API/静态资源/SPA/CLI；中央静态暂存会清除旧文件。
- 自查：93 个既有源码/资源/测试文件均保持原内容或仅有预期路径替换，其中既有测试文件 52 个，无断言变更。
- 最终验证：`npm run typecheck` 通过；`npm test` 重新构建后 265/265 通过，零失败、取消、跳过，测试阶段约 297 秒。相比基线新增 4 项，既有断言未放宽。
- 独立审查：完成两阶段复核，无成立的行为问题或 P0/P1 阻塞项；独立复跑 9 项并检查安装包依赖闭包。尾随空格已清理，主任务复核见 `docs/package-boundaries-validation.md`。
