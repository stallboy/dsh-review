# dsh-code-review 会话状态快照（2026-11-10 终，第二轮契约修补）

> 本文件如实记录本轮多会话修复工作结束时的仓库状态，供后续审查会话作为基线。
> 所有结论均以本会话实际执行过的命令与测试输出为依据；未验证之处已明确标注。
> **第 6 节是当前唯一权威的“已修/未修”清单**；DEVIATIONS.md 为历史批次记录，
> 其中“三分支、租约互斥已完成”等旧声明已被对抗审查证伪，并已在本轮补齐。

## 1. 仓库与构建状态

- 工作目录：`F:\workspace_2\dsh-review`（dsh-code-review v0.3.0，Host + Web Client）。
- `npm run typecheck`：Host 与 Client 双 tsconfig 通过（本轮末次执行无错误）。
- `npm run build`：通过，`dist/` 为最新构建产物。
- 本轮全部变更已提交到 `master`（含上一轮未提交的 SPEC 对齐修复）；提交后工作区仅剩测试输出等被忽略文件。

## 2. 测试状态

- 全量测试：**137 项，全部通过**（`node --test --test-timeout=90000 --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`，输出落盘）。
- 运行方式约束（重要）：必须 `--test-concurrency=1` 且输出重定向到文件；
  多文件并行或 TEMP 脏时会出现“假挂起”——根因是 `%TEMP%` 累积的 `dsh-*` 夹具目录造成文件系统压力。
  长跑前先清理：`Remove-Item $env:TEMP\dsh-* -Recurse -Force`。
- 测试租约状态文件：测试必须显式注入 `statePath`，且**放在仓库目录之外**——
  `revertBusinessWorkspace()` 的 `git clean` 会删除仓库内的 `.tmp/`，导致租约“凭空消失”；
  默认真实 `DSH_HOME/dsh-code-review/runtime-state.json` 不得被测试污染。
- 测试文件（23 个）：contract-p1~p9p10、contract-fixes、contract-lock、contract-shared、
  contract-approve-guard、contract-audit-finalize、contract-round2、contract-gaps、
  contract-three-branch、contract-lease-mutex、contract-projection-shared、contract-vcs-derived
  （以上为本会话新增/大改）、audit-core、audit-api、session、client-bundle、human-judgment、patch、vcs。

## 3. 本轮（第二轮）完成的契约修补

按 SESSION-STATE 旧第 6 节“已确认仍未修”清单逐项处理，均有代码 + 测试证据：

- **H1（高危）SVN 三分支**：`VcsAdapter` 新增统一接口 `getCommitProbe(paths)`（Git=HEAD；
  SVN=路径级 `last-changed-revision`，未版本化时上溯最近已版本化祖先，绝不用工作副本根 revision）
  与 `readFileAt(revision, relPath)`（Git `show` / SVN `cat -r`）。所有共享写的提交失败判定
  改为路径级探针 + 提交内容核对；`/reject`、`/convert`、`/dismiss-finding`、`/rebase`、
  `/manual-revision`、`/ai-fix`、`/candidate/finalize`、批准与 AI 修复回退、审查收尾
  全部接入“提交存在→成功 / 证明不存在→恢复 / 不明→RECOVERY_REQUIRED”三分支。
  测试 `contract-vcs-derived.test.mjs` 覆盖 SVN 真机（svn 1.14.3）：探针前进而根 revision 不变、
  失败提交探针不变、派生 found；Git merge 场景派生 found。
- **租约互斥**：`/audit`、`/audit/session`、`/audit/manual` 统一检查未释放租约（按仓库根）；
  定时审查自身创建持久化租约 + 跟踪 Job，并加内存防重入；`/audit/finalize` 进入 repo 锁，
  仅 `COMMITTED` / `VALIDATION_FAILED` 释放租约，`ABORTED` / `RECOVERY_REQUIRED` 保留现场。
  测试 `contract-lease-mutex.test.mjs` 覆盖定时租约创建与跳过、租约阻塞新审查、
  finalize 失败保留租约/成功释放。
- **共享事实**：`/queue`、`/candidate`、`/findings`、`/audits`、负向记忆、已存在候选注入、
  批准流程 reload、批准提交派生全部绑定同一共享快照源；投影缓存键与读取源同源（Git HEAD），
  SVN 无法证明快照时不缓存；SVN 共享源显式 `svn list -r BASE`、`svn cat -r BASE`；
  `store.list` 错误路径也标记 `local`（此前本地 broken 草稿会漏标）。测试
  `contract-projection-shared.test.mjs` 覆盖本地篡改不可见、新提交后缓存失效、
  本地草稿不进入负向记忆/已存在候选、`/audits` 只列共享档案。
- **buildAuditItems target_files**：从 B/Deferred 报告文本尽力提取业务路径（反引号/裸路径、
  去行号、排除 URL/绝对路径/`..`/`.ai-review`），非 `.` scope 提取为空时写明确告警
  （否则覆盖判定会使 items 全部失效）。
- **G42**：收尾门禁复算失败的候选从正文 A 类列表重新过滤（与 frontmatter `candidates` 一致）。
- **/convert**：补“最新有效观察”校验（`projection.lastObservedAudit === auditId`），
  空字段 400；**/dismiss-finding** 补失败回滚与三分支。
- **派生规则**：Git 去 `--first-parent`，`git log -m` + 全父提交 approved 验证 + `diff-tree -m`
  处理 merge；SVN 修 `[AMDR]` 字符类、用 `relative-url` 前缀做精确路径匹配（删除 endsWith），
  并改 `svn log -r HEAD:1` 以覆盖刚提交的 revision。
- **提交结果内容核对**：`classifyCommitFailure` 不再用 `headSubject` 字符串匹配，改为读取
  提交版本中的 `review.md` 验证 approved（Git/SVN 通用）。
- **批准编排**：门禁后比对基线漂移（`CONCURRENCY_MISMATCH`）；`/approve` 读取并应用请求体
  `commitMessage`（替换 `review.md` 的 `commit_message`、作为业务提交说明、首行不符返回
  `COMMIT_MESSAGE_MISMATCH`）；rebase/manualRevision/ai-fix 提交失败时恢复操作前版本。
- **低危/边界**：`scheduleIntervalMinutes` 过滤非有限值并限幅；`/queue` 未配置响应补
  `me`/`repoRoot`；删除 dead code（`commitReviewOnly`、`headSubject`）。

## 4. 已知残留（环境/平台限制或低优先级）

1. 会话 turn 事件自动收尾：需 DSH sessionController turn 结束钩子；现为手动 `/audit/finalize`。
2. 提交树核验仍采用“暂存集合 ⊆ 指定路径”的 add 后核对，未使用临时 index（SPEC 允许二选一）。
3. Deferred 依赖解析为启发式（标题匹配 + 占位依赖告警）。
4. 会话模式提示词仍依赖 Agent 遵守“不写 Frontmatter/不自行提交”的指令；收尾有 frontmatter
   剥离与“非法候选不提交”的防御，但未做强校验。
5. Client 组报告的低危展示项与 §8 错误码边界仅处理了本轮明确列出的部分（其余不阻塞本契约）。
6. SVN 沙箱限制已用真机测试覆盖（svn 1.14.3）；更复杂的远端 out-of-date/merge 场景仍建议真机验收。

## 5. 其他注意事项

- 共享写端点的 `paths` 与 `probePaths` 可能不同：SVN 下目录的 `last-changed-revision`
  不随子文件内容修改前进，探针必须指向 `review.md`/`audit.md` 等具体文件。
- `contract-fixes` / `audit-api` / `p2` / `p6` / `p7` / `p4` 等测试曾按新契约改写（含 UTC audit_id、
  target_files 必填、指纹格式、共享档案需先提交）——审查时如见与旧断言不符属预期。
- DEVIATIONS.md 中六步计划与批次 1–5 章节记录了每项的验证证据位置；其“已完成”声明以本文件为准。

## 6. 实现后审查结论（2026-11-10 终，第二轮对抗性审查后修补）

- **验证基线**：`npm run typecheck` / `npm run build` 通过；全量 **137 项测试通过**；
  本轮新增 4 个契约测试文件（三分支、租约互斥、投影共享源、VCS 派生/SVN 真机）
  与 2 个 `/approve commitMessage` 用例。
- **上一轮审查确认的未修项：全部关闭**——H1 SVN 路径级三分支、租约互斥（含定时审查）、
  共享事实（投影/负向记忆/已存在候选/approve reload/投影缓存同源）、buildAuditItems
  target_files、/convert 最新观察、/dismiss 恢复+三分支、G42 正文重过滤、auditFinalize
  持锁与释放条件、SVN 源 `-r BASE`、Git 派生 first-parent/merge、SVN 派生精确路径与
  字符类、headSubject 内容核对、门禁后基线漂移、rebase/manualRevision/ai-fix 提交失败恢复、
  `/approve` commitMessage；均为“代码 + 测试”或“代码 + 明确真机验证”。
- **仍未修（低优先，不阻塞契约）**：Client 组低危展示项与 §8 错误码边界的剩余细节；
  会话 turn 自动收尾钩子（平台能力限制）。这些不影响共享事实、批准主流程与三分支语义。
- 本文件自此为唯一权威状态；后续审查请以第 4、6 节为输入，勿再引用 DEVIATIONS 的旧“已完成”声明。

## 7. 第三轮修复（2026-11-10 下午，按独立审查报告 D 节顺序）

- **P0 提交完整性**：`vcs.atomicCommit` 新增 `verifyEntries`/`verifyDeletions`，在 `git add -A` 后读取 `git ls-files -s -z` 逐路径核对暂存 blob、模式与删除集合；核对命令失败或内容不符一律 fail-closed 并清空暂存。批准、审查收尾、共享写提交均传入“已审核内容”的 blob 哈希；批准步骤 7 记录业务文件内容 blob + 模式快照。
- **P0 共享快照**：批准补丁改为从 `sharedSource` 读取并物化到仓库外临时文件后应用，不再读取本地 `.ai-review` 补丁；补丁应用前拒绝 `.ai-review/.tmp/node_modules/.git/.svn` 路径。
- **P1**：decisions 精确集合（未知/重复/交叉/遗漏）与 I8 读端；批准/收尾/独立 finalize 统一 `validateFullCandidate`（I4/I5/I16 引用目标）；评论写端校验 revision/line/file/side 与 I12；`/comments/batch` 严格 422 且不再静默过滤；Host 从 Hunk 兜底提取 anchor；`/reopen` 强制每个 rejected 最多一个直接替代；Rebase 基于新基线导出完整 diff 并验证可应用；G42 在门禁复算后再渲染复核块且失败错误入块；audit finalize 证明未提交时清理本地写入并回滚 Git 暂存；`/audit/manual` 创建可追踪 audit Job；租约新增 releasable 迁移，active 租约 release 返回 409；headless `/audit` 与 `ai_fix` 纳入 repo 锁；`/jobs/:id/cancel` 对审查 Job 置 releasable 并结束跟踪；Owner 路由 AND 语义与 default_owner 复核；同步失败改为结构化标志；SVN 共享源改为本地 info/status 证明后读本地文件、无法证明才回退 BASE；Windows 门禁/Runner 正常退出也 taskkill 清理（VCS 命令默认跳过以避免误杀与开销）；写入 review.md/补丁前用 realpath 校验仍在仓库 `.ai-review` 内并拒绝符号链接；负向记忆摘要补 target_files/audit_type 且未知 category 归 unspecified；Client stale 刷新解锁、patchCheck/Rebase 入口、草稿+AI 修复走 `/comments/batch(autoFix)`、粘性头。
- **测试**：新增 `contract-round3.test.mjs`（评论字段/anchor、manual Job/租约、Owner AND、记忆摘要、提交树核对、取消终止 Runner）；更新 `contract-p4/p5/p6/p8`、`contract-audit-finalize`、`contract-round2`、`audit-api` 中固化旧行为的断言。
- **验证**：`npm run typecheck` / `npm run build` 通过；全量 **145 项测试通过**（`node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs`，输出落盘）。
- **仍开（已记录，非本轮目标）**：audit 报告“历史问题复查”未解析为 `items[]`；审计档案未知 Frontmatter 键未保留（I14 的 audit 侧）；SVN 共享源/派生仍缺真机自动测试（实现已按 §7.1 调整）；会话 turn 结束自动收尾仍依赖手动 `/audit/finalize`。
