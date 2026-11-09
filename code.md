> **状态：早期接口草案（superseded）**。契约以 `SPEC.md` 为准；以下 TypeScript 定义仅作历史参考。批准元数据不再包含 `commit_revision`，业务提交由 Host 从 VCS 历史派生。

以下为 DSH Web 审核插件内部核心模块（数据模型、Review Store、Router、VCS 接口、Validator、Runner 及核心审批编排器）的完整 TypeScript 接口与数据结构定义。

该设计遵循**强类型约束**、**无状态服务抽象**与**VCS 底层隔离**原则，可直接作为项目的 `src/core/types.ts` 基础契约。

---

## 一、核心领域模型与数据结构 (`domain.ts`)

对应 `review.md`（YAML Frontmatter + Markdown 正文）及 `reviewers.yml` 的内存映射。

```typescript
/** 共享工作流状态（严禁将本地执行态写入文件） */
export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected';

/** 本地 DSH 实例瞬态（仅保留在内存/前端 store，不落盘） */
export type LocalTransientState =
  | 'idle'
  | 'syncing'
  | 'validating'
  | 'ai_fixing'
  | 'committing';

/** 内联评论处理状态 */
export type CommentStatus = 'unresolved' | 'partial' | 'resolved';

/** 版本与基线映射记录 */
export interface RevisionEntry {
  /** 版本递增编号：1, 2, 3... */
  id: number;
  /** 生成该版本补丁时的 VCS 基线（Git Commit Hash 或 SVN Revision） */
  base_revision: string;
  /** 补丁文件名，如 "001.patch" */
  patch: string;
}

/** 结构化代码内联评论 */
export interface ReviewComment {
  /** 唯一标识，如 "c1", "c2" */
  id: string;
  /** 评论针对的版本号 */
  revision: number;
  /** 相对仓库根目录的文件路径 */
  file: string;
  /** 关联行号（整体文件评论可为 0 或 null） */
  line: number | null;
  /** 评论作者账号 */
  author: string;
  /** 评论正文 */
  content: string;
  /** AI 或人工标记的处理状态 */
  status: CommentStatus;
}

/** 批准与提交元数据 */
export interface ApprovalMeta {
  approved_by: string | null;
  /** ISO-8601 时间戳 */
  approved_at: string | null;
  // 业务提交版本不进 review.md；由 Host 从 VCS 历史派生（SPEC §5.5）。
}

/** review.md 的 YAML Frontmatter 强类型结构 */
export interface ReviewFrontmatter {
  schema_version: 1;
  title: string;
  /** ISO-8601 时间戳 */
  created_at: string;
  owner: string;
  tags: string[];
  status: ReviewStatus;
  ticket: string | null;
  current_revision: number;
  revisions: RevisionEntry[];
  /** 合并前必过的非交互式门禁命令列表 */
  gate_checks: string[];
  comments: ReviewComment[];
  approval: ApprovalMeta;
}

/** 需人工判断项（从正文 # 需人工判断项 解析，供 UI 高亮展示） */
export interface HumanJudgmentItems {
  businessLogicAndTradeoffs: string;
  architectureAndPerformance: string;
  untestedBoundaryConditions: string;
  rawMarkdown: string;
}

/** 单个历史版本的 Markdown 章节解析结构 */
export interface RevisionHistorySection {
  revisionId: number;
  baseRevision: string;
  changesFromPrevious?: string;
  solutionDescription: string;
  validationResult: string;
  humanFeedback?: string;
  feedbackResolution?: string;
}

/** 完整候选修复实体（Review Store 读写单元） */
export interface ReviewCandidate {
  /** 候选修复唯一标识，即相对 .ai-review 的路径，如 "2026-10/20261031-fix-login" */
  id: string;
  /** 候选目录绝对路径或相对仓库根目录路径 */
  dirPath: string;
  /** Frontmatter 元数据 */
  meta: ReviewFrontmatter;
  /** 正文结构化解析结果 */
  body: {
    problemAndImpact: string;
    rootCause: string;
    currentSolution: string;
    humanJudgment: HumanJudgmentItems;
    validationEvidence: string;
    history: RevisionHistorySection[];
    /** 完整原始 Markdown 正文（不含 Frontmatter） */
    rawBody: string;
  };
}

/** 队列列表轻量摘要项（用于审核队列高性能渲染与筛选） */
export interface ReviewQueueItem {
  id: string;
  meta: ReviewFrontmatter;
  /** 变更统计摘要（由最新补丁解析计算） */
  diffStats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    modifiedDirs: string[];
  };
  /** 是否有未解决评论 */
  unresolvedCommentCount: number;
  /** 当前最新版本的 base_revision 是否落后于仓库最新 HEAD */
  isBaseBehind: boolean;
  /** 本地执行瞬态 */
  localState: LocalTransientState;
}

```

---

## 二、Review Store 与 Router 接口 (`store.ts` & `router.ts`)

负责读写 `.ai-review/`、并发乐观锁校验（防旧页面覆盖）、Owner 权限检查与归档补丁清理。

```typescript
/** 队列筛选条件 */
export interface ReviewFilter {
  owner?: string;
  status?: ReviewStatus[];
  directoryPrefix?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
}

/** 并发与权限校验期望值（乐观锁） */
export interface ConcurrencyGuard {
  /** 页面加载时的 current_revision，若与最新文件不一致则拒绝操作 */
  expectedRevision: number;
  /** 当前操作人账号，必须等于文件内的 owner（除非是接管操作） */
  operator: string;
}

export interface IReviewStore {
  /**
   * 同步仓库 `.ai-review` 目录并列出符合筛选条件的队列项
   */
  listQueue(filter?: ReviewFilter): Promise<ReviewQueueItem[]>;

  /**
   * 同步并读取单个候选修复详情（包含最新状态）
   */
  getCandidate(id: string): Promise<ReviewCandidate>;

  /**
   * 读取指定版本的原始补丁内容
   */
  getPatchContent(id: string, revisionId: number): Promise<string>;

  /**
   * 接管/转交负责人（唯一允许非当前 owner 调用的写操作）
   * 内部流程：vcs.sync() -> 检查 expectedRevision -> 更新 owner -> vcs.commit(".ai-review/...")
   */
  transferOwnership(
    id: string,
    newOwner: string,
    expectedRevision: number
  ): Promise<ReviewCandidate>;

  /**
   * 提交审核改进意见（状态流转：pending -> changes_requested）
   * 内部流程：校验 ConcurrencyGuard -> 写入新内联 comments 与总体意见 -> 提交 review.md
   */
  submitFeedback(
    id: string,
    guard: ConcurrencyGuard,
    feedback: {
      generalComment: string;
      newInlineComments: Omit<ReviewComment, 'id' | 'revision' | 'status'>[];
      updatedGateChecks?: string[];
    }
  ): Promise<ReviewCandidate>;

  /**
   * 放弃候选修复（状态流转：* -> rejected，并在同一提交中删除所有 .patch 文件）
   */
  rejectCandidate(
    id: string,
    guard: ConcurrencyGuard,
    reason: string
  ): Promise<void>;

  /**
   * 准备批准提交（在内存中更新 status: approved、approval 元数据、追加最终验证证据，
   * 并返回待原子提交的文件变更列表及待删除的历史 .patch 路径列表）
   */
  prepareApprovalMutation(
    candidate: ReviewCandidate,
    approver: string,
    finalEvidenceSummary: string
  ): {
    updatedReviewMdContent: string;
    patchFilesToDelete: string[];
  };
}

/** reviewers.yml 配置结构与路由接口 */
export interface ReviewerRule {
  owner: string;
  paths?: string[];
  tags?: string[];
}

export interface ReviewersConfig {
  default_owner: string;
  rules: ReviewerRule[];
}

export interface IReviewRouter {
  loadConfig(): Promise<ReviewersConfig>;
  /** 根据补丁涉及的文件路径列表和标签，计算唯一负责人 */
  resolveOwner(modifiedFiles: string[], tags: string[]): Promise<string>;
}

```

---

## 三、VCS 适配器接口 (`vcs.ts`)

隔离 Git 与 SVN 的差异，核心层不感知 branch、PR 或 merge，仅依赖**基线、补丁应用、跨版本增量计算与原子提交**。

```typescript
export type VcsType = 'git' | 'svn';

/** 补丁应用结果 */
export interface ApplyPatchResult {
  success: boolean;
  /** 是否存在冲突 */
  hasConflicts: boolean;
  /** 冲突文件列表 */
  conflictFiles: string[];
  /** 底层命令行报错摘要 */
  errorOutput?: string;
}

/** 版本间增量差异计算结果 */
export interface InterRevisionDiffResult {
  fromRevision: number;
  toRevision: number;
  fromBase: string;
  toBase: string;
  /** 是否发生了基线迁移（fromBase !== toBase） */
  baseMigrated: boolean;
  /** 差异计算策略说明（供 UI 顶部 Banner 展示） */
  resolutionMode:
    | 'same_base_direct'        // 同基线直接对比
    | 'cross_base_3way_clean'   // 跨基线，旧补丁三方应用到新基线成功
    | 'cross_base_hunk_fallback'; // 跨基线且旧补丁在新基线冲突，退化为补丁 Hunk 级对比
  /** 计算出的 Unified Diff 文本 */
  unifiedDiff: string;
}

export interface IVcsAdapter {
  readonly type: VcsType;

  /**
   * 1. 检查本地业务工作区是否干净（无未提交修改、无残留冲突文件）
   */
  ensureCleanWorkspace(): Promise<{ isClean: boolean; dirtyFiles: string[] }>;

  /**
   * 2. 从远端同步最新代码并返回最新主干基线版本号（Git HEAD SHA / SVN Revision）
   */
  syncAndGetLatestBase(): Promise<string>;

  /**
   * 3. 获取当前本地工作区的基线版本号
   */
  getCurrentBase(): Promise<string>;

  /**
   * 4. 在当前工作区尝试应用补丁
   * @param threeWay 是否启用三方合并尝试（批准快速通道设为 false 要求严格原样适用；AI 修复时可设为 true）
   */
  applyPatch(patchFilePath: string, threeWay?: boolean): Promise<ApplyPatchResult>;

  /**
   * 5. 彻底还原业务工作区（丢弃补丁产生的所有未提交改动与新增临时文件，保留 .ai-review）
   */
  revertBusinessWorkspace(): Promise<void>;

  /**
   * 6. 计算两个候选版本之间的增量差异（处理同基线与跨基线场景）
   */
  computeInterRevisionDiff(
    revA: RevisionEntry,
    revB: RevisionEntry,
    candidateDirPath: string
  ): Promise<InterRevisionDiffResult>;

  /**
   * 7. 原子提交（同时提交业务代码改动、更新后的 review.md，并删除过程 .patch 文件）
   * 若因远端有新提交导致推送/提交失败，返回 { success: false, outOfDate: true }
   */
  atomicCommitAndPush(params: {
    message: string;
    filesToAddOrModify: string[];
    filesToDelete: string[];
  }): Promise<{
    success: boolean;
    commitRevision?: string;
    outOfDate?: boolean;
    errorOutput?: string;
  }>;
}

```

---

## 四、Validator 门禁验证接口 (`validator.ts`)

在当前工作区（预留可选独立工作区配置）顺序执行 `review.md` 中的 `gate_checks`。

```typescript
export interface SingleCheckResult {
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  /** 截断后的关键输出摘要（不保存大段原始日志） */
  summaryOutput: string;
}

export interface ValidationReport {
  allPassed: boolean;
  baseRevision: string;
  environmentSummary: string;
  results: SingleCheckResult[];
  /** 格式化后可直接写回 review.md `# 验证证据` 的 Markdown 摘要 */
  formattedEvidenceMarkdown: string;
}

export interface ValidatorOptions {
  /** 第一版默认 false（直接在当前本地工作区运行）；后续可扩展 git worktree / shadow copy */
  useIsolatedWorkspace?: boolean;
  /** 单条门禁命令超时时间（毫秒），默认如 300_000 (5分钟) */
  timeoutMsPerCommand?: number;
}

export interface IValidator {
  /**
   * 顺序执行 gate_checks 中的所有命令（遇错即停或全部跑完由实现决定，通常遇错即停）
   */
  runGateChecks(
    gateChecks: string[],
    baseRevision: string,
    options?: ValidatorOptions
  ): Promise<ValidationReport>;
}

```

---

## 五、Runner 执行器接口 (`runner.ts`)

抽象对 `dsh-codex` 或其他修复器的调用，保持审核核心与具体大模型解耦。

```typescript
export type RunnerTaskMode =
  | 'CREATE_INITIAL'    // 模式 A：前置任务生成初始候选修复
  | 'ADDRESS_FEEDBACK'  // 模式 B：根据人类 changes_requested 意见生成下一版本
  | 'RESOLVE_CONFLICT'; // 模式 C：批准时遇到基线冲突或门禁失败，生成下一版本

export interface RunnerInvocationContext {
  mode: RunnerTaskMode;
  vcsType: VcsType;
  currentBaseRevision: string;
  candidateDirPath: string;
  ticketId?: string | null;
  /** 问题描述、审核意见汇总、或冲突与门禁失败日志 */
  taskPayload: string;
}

export interface RunnerExecutionResult {
  success: boolean;
  /** 执行后最新生成的版本号（如 2） */
  newRevisionId?: number;
  /** 新生成的补丁文件路径 */
  newPatchPath?: string;
  /** 候选方案是否发生了实质变化（用于批准流程判定是否使旧批准失效） */
  schemeChanged: boolean;
  errorMessage?: string;
}

export interface IRunner {
  readonly runnerName: string; // 如 "dsh-codex"

  /**
   * 调用外部 AI 修复器执行任务，并在完成后校验工作区是否已按契约还原
   */
  invoke(context: RunnerInvocationContext): Promise<RunnerExecutionResult>;
}

```

---

## 六、批准与提交核心状态机编排 (`approval-orchestrator.ts`)

将上述 5 个模块串联起来，精确实现方案第五节的“批准与提交算法”：

```typescript
export type ApprovalOutcome =
  | {
      /** 快速放行成功：无冲突、门禁通过、已原子提交并清理补丁 */
      status: 'COMMITTED';
      commitRevision: string;
    }
  | {
      /** 发生冲突或门禁失败，AI 已介入生成新版本，当前批准自动失效，退回 pending 重新审核 */
      status: 'FALLBACK_TO_PENDING';
      newRevision: number;
      reason: 'PATCH_CONFLICT' | 'GATE_CHECK_FAILED';
    }
  | {
      /** 并发冲突（版本号或 Owner 已变）、工作区脏、或超出最大重试次数 */
      status: 'ABORTED';
      reason: 'CONCURRENCY_MISMATCH' | 'DIRTY_WORKSPACE' | 'MAX_RETRIES_EXCEEDED' | 'RUNNER_FAILED';
      detail: string;
    };

export class ApprovalOrchestrator {
  private readonly MAX_COMMIT_RETRIES = 2;

  constructor(
    private readonly store: IReviewStore,
    private readonly vcs: IVcsAdapter,
    private readonly validator: IValidator,
    private readonly runner: IRunner
  ) {}

  async approveAndCommit(
    candidateId: string,
    guard: ConcurrencyGuard
  ): Promise<ApprovalOutcome> {
    // 0. 检查本地工作区干净度
    const cleanCheck = await this.vcs.ensureCleanWorkspace();
    if (!cleanCheck.isClean) {
      return {
        status: 'ABORTED',
        reason: 'DIRTY_WORKSPACE',
        detail: `本地存在未提交文件: ${cleanCheck.dirtyFiles.join(', ')}`,
      };
    }

    for (let attempt = 0; attempt <= this.MAX_COMMIT_RETRIES; attempt++) {
      // 1. 同步产品仓库取得最新基线，并重读 review.md 校验并发锁
      const latestBase = await this.vcs.syncAndGetLatestBase();
      const candidate = await this.store.getCandidate(candidateId);

      if (
        candidate.meta.current_revision !== guard.expectedRevision ||
        candidate.meta.owner !== guard.operator
      ) {
        return {
          status: 'ABORTED',
          reason: 'CONCURRENCY_MISMATCH',
          detail: '候选修复版本或负责人已发生变化，请刷新页面重新审核。',
        };
      }

      const currentRevEntry = candidate.meta.revisions.find(
        (r) => r.id === candidate.meta.current_revision
      )!;
      const patchFullPath = `${candidate.dirPath}/${currentRevEntry.patch}`;

      // 2. 在本地工作区严格应用当前补丁（threeWay = false，不允许静默合并掩盖冲突）
      const applyRes = await this.vcs.applyPatch(patchFullPath, false);

      if (!applyRes.success || applyRes.hasConflicts) {
        // 补丁冲突 -> 还原工作区 -> 唤醒 AI 生成下一版本 -> 批准失效，退回 pending
        await this.vcs.revertBusinessWorkspace();
        const runnerRes = await this.runner.invoke({
          mode: 'RESOLVE_CONFLICT',
          vcsType: this.vcs.type,
          currentBaseRevision: latestBase,
          candidateDirPath: candidate.dirPath,
          ticketId: candidate.meta.ticket,
          taskPayload: `补丁在最新基线 ${latestBase} 上冲突: ${applyRes.errorOutput}`,
        });
        return runnerRes.success
          ? { status: 'FALLBACK_TO_PENDING', newRevision: runnerRes.newRevisionId!, reason: 'PATCH_CONFLICT' }
          : { status: 'ABORTED', reason: 'RUNNER_FAILED', detail: runnerRes.errorMessage ?? '冲突解决失败' };
      }

      // 3. 补丁无冲突适用 -> 执行合并必过测试与检验 (gate_checks)
      const report = await this.validator.runGateChecks(
        candidate.meta.gate_checks,
        latestBase
      );

      if (!report.allPassed) {
        // 门禁测试失败 -> 还原工作区 -> 唤醒 AI 修复并生成下一版本 -> 批准失效，退回 pending
        await this.vcs.revertBusinessWorkspace();
        const runnerRes = await this.runner.invoke({
          mode: 'RESOLVE_CONFLICT',
          vcsType: this.vcs.type,
          currentBaseRevision: latestBase,
          candidateDirPath: candidate.dirPath,
          ticketId: candidate.meta.ticket,
          taskPayload: `合并门禁测试在基线 ${latestBase} 上未通过:\n${report.formattedEvidenceMarkdown}`,
        });
        return runnerRes.success
          ? { status: 'FALLBACK_TO_PENDING', newRevision: runnerRes.newRevisionId!, reason: 'GATE_CHECK_FAILED' }
          : { status: 'ABORTED', reason: 'RUNNER_FAILED', detail: runnerRes.errorMessage ?? '门禁修复失败' };
      }

      // 4. 无冲突且通过门禁 -> 准备批准元数据与归档补丁清理列表，执行原子提交
      const mutation = this.store.prepareApprovalMutation(
        candidate,
        guard.operator,
        report.formattedEvidenceMarkdown
      );

      const commitRes = await this.vcs.atomicCommitAndPush({
        message: `[AI-Review] ${candidate.meta.title} (rev ${candidate.meta.current_revision}, approved by ${guard.operator})`,
        filesToAddOrModify: [`${candidate.dirPath}/review.md`], // 连同工作区已修改的业务文件一并提交
        filesToDelete: mutation.patchFilesToDelete,
      });

      if (commitRes.success) {
        return { status: 'COMMITTED', commitRevision: commitRes.commitRevision! };
      }

      // 5. 若因远端刚好有新提交导致撞车，先还原业务工作区，进入下一轮循环重新同步和验证
      await this.vcs.revertBusinessWorkspace();
      if (!commitRes.outOfDate) {
        return {
          status: 'ABORTED',
          reason: 'MAX_RETRIES_EXCEEDED',
          detail: commitRes.errorOutput ?? '原子提交失败',
        };
      }
    }

    return {
      status: 'ABORTED',
      reason: 'MAX_RETRIES_EXCEEDED',
      detail: `提交并发冲突重试超过上限 (${this.MAX_COMMIT_RETRIES} 次)，已安全回滚本地工作区。`,
    };
  }
}

```


DSH Web 审核插件的前端设计围绕“决策优先级排序”**、**“Owner 操作隔离”**以及**“乐观锁防冲突”三个核心原则展开，确保审核员能在几分钟内完成“看问题 -> 拍板人工判断项 -> 审门禁 -> 看代码 -> 批准/提意见”的闭环。

---

## 一、整体布局与视图树结构 (Component Hierarchy)

插件采用左右分栏（Master-Detail）或列表-详情单页路由切换布局，顶部常驻仓库同步与本地工作区状态栏。

```text
<AiReviewPluginApp>
 ├── <TopWorkspaceBar />            # 显示当前登录账号、本地VCS基线、工作区是否干净、手动同步按钮
 ├── <ReviewQueueView />            # 【视图1：审核队列】
 │    ├── <QueueFilterBar />        # 按 Owner(默认当前用户)、状态、目录前缀、Tag、时间筛选
 │    └── <QueueCandidateList />
 │         └── <QueueItemCard />    # 单条候选卡片（含基线落后警告、人工判断项徽标、本地瞬态进度）
 │
 └── <ReviewDetailView />           # 【视图2：审核详情页】
      ├── <StaleAlertBanner />      # 乐观锁冲突提示（当远端 current_revision 或 owner 变化时弹出）
      ├── <DetailStickyHeader />    # 标题、Ticket、状态、Owner接管栏、版本切换器
      │
      ├── <DecisionFlowContainer>   # 严格按人类决策顺序由上至下排列
      │    ├── <SectionProblemAndFix />     # 1&2. 问题、影响、根因、当前修复方案
      │    ├── <HumanJudgmentCallout />     # 3. 【高优高亮】需人工判断项（琥珀色警示卡片 + 逐项确认勾选）
      │    ├── <GateChecksAndEvidence />    # 4. 合并门禁命令列表（可编辑追加）与验证证据摘要
      │    ├── <CodeDiffWorkspace />        # 5&6. 代码导览、全量/增量差异对比、内联评论区
      │    │    ├── <DiffToolbar />         # 视图切换：完整差异 vs 版本间增量差异 (Rev A -> Rev B)
      │    │    ├── <CrossBaseBanner />     # 跨基线迁移提示（same_base | 3way_clean | hunk_fallback）
      │    │    ├── <FileTreeSidebar />     # 变更文件树（标注增删行数、未解决评论数）
      │    │    └── <DiffViewer />          # 代码行渲染 + <InlineCommentThread /> + <NewCommentForm />
      │    └── <RevisionHistoryTimeline />  # 历史版本折叠面板（方案演变与历史意见处理记录）
      │
      └── <BottomActionDock />      # 固定底部操作栏：总体意见输入、草稿评论汇总、[批准] [提意见] [放弃]

```

---

## 二、前端核心状态模型 (`ReviewUIStore`)

前端状态严格区分“从 `review.md` 读取的共享持久化状态”**与**“仅存在于当前浏览器会话的草稿/执行瞬态”。

```typescript
export interface DiffComparisonMode {
  type: 'full' | 'incremental';
  /** type === 'full' 时对应选中的目标版本；type === 'incremental' 时为对比的起止版本 */
  fromRevision?: number;
  toRevision: number;
}

export interface DraftInlineComment {
  tempId: string;
  file: string;
  line: number;
  content: string;
}

export interface ReviewDetailUIState {
  // 1. 共享数据快照與乐观锁基准
  candidate: ReviewCandidate | null;
  loadedRevisionSnapshot: number; // 页面加载时的 current_revision，用于提交前比对
  loadedOwnerSnapshot: string;    // 页面加载时的 owner

  // 2. 本地瞬态与权限计算
  currentUser: string;            // 当前 DSH 登录程序员账号
  isCurrentUserOwner: boolean;    // currentUser === candidate.meta.owner
  localState: LocalTransientState; // 'idle' | 'syncing' | 'validating' | 'ai_fixing' | 'committing'
  executionLogStream: string[];   // 本地执行 gate_checks 或 AI 修复时的实时终端输出摘要

  // 3. 人工判断项阅读确认状态（前端强制防呆：需全部勾选才解锁“批准”按钮）
  humanJudgmentAck: {
    businessLogic: boolean;
    architecture: boolean;
    boundaryConditions: boolean;
  };

  // 4. 差异对比视图状态
  diffMode: DiffComparisonMode;
  activeDiffData: InterRevisionDiffResult | null;
  selectedFile: string | null;

  // 5. 审核草稿箱（未点击“提出改进意见”前仅保存在本地内存）
  draftGeneralComment: string;
  draftInlineComments: DraftInlineComment[];
  draftGateChecks: string[] | null; // 若审核人修改了门禁命令则暂存于此
}

```

---

## 三、核心视图与关键组件交互设计

### 1. 审核队列页 (`<ReviewQueueView/>`)

* **默认聚焦视角**：打开插件时，`FilterBar` 默认筛选 `owner = 当前用户` 且 `status = ['pending', 'changes_requested']`，让程序员第一时间处理分给自己的待审单。
* **卡片信息密度 (`<QueueItemCard/>`)**：
* **主信息**：`[Ticket]` + **语义标题** + `rev N` 徽标。
* **变更规模与目录**：`+48 / -12 lines · 3 files (src/auth, src/network)`。
* **风险与人工判断提示**：提取 `# 需人工判断项` 中的非空条目数，显示醒目的琥珀色标签（如 `⚠️ 2 项需人工拍板`）。
* **基线状态指示器**：
* 若 `latest_rev.base_revision === current_head`：显示绿色 `● 基线最新 (r112)`；
* 若落后：显示黄色 `⏳ 基线落后 (基于 r108, 当前 r112)`，提醒审核员批准时将触发在最新基线上重新应用补丁与验证。


* **无批量批准**：列表项仅提供整卡点击进入详情页，从 UI 层面杜绝不看代码直接批量放行。



---

### 2. 审核详情页：权限隔离与乐观锁栏 (`<DetailStickyHeader/>`)

* **Owner 只读隔离模式**：
* 当 `currentUser !== candidate.meta.owner` 时，页面顶部显示灰色锁提示栏：*“当前负责人为 **zhangsan**，您处于只读浏览模式。”*
* 底部所有操作按钮（批准、提意见、放弃）及代码行内添加评论入口全部禁用，仅开放右上角的 **`[接管审核 (Transfer to Me)]`** 按钮。
* 点击`[接管审核]`后，调用 `store.transferOwnership()`，将 `review.md` 的 `owner` 更新为当前用户并提交，随后立即解锁页面全部操作权限。


* **版本过期拦截 (`<StaleAlertBanner/>`)**：
* 当后台轮询或点击操作前的预检发现磁盘上的 `current_revision !== loadedRevisionSnapshot` 或 `owner !== loadedOwnerSnapshot` 时，顶部弹出红色横幅：*“该候选修复已被更新至版本 N（或已被他人接管），当前页面草稿已锁定。”* 并提供 **`[加载最新版本]`** 按钮。



---

### 3. 决策核心区：需人工判断项与门禁确认

#### A. `<HumanJudgmentCallout/>`（琥珀色高亮决策卡）

位于“修复方案”正下方、“代码 Diff”正上方。将 AI 总结的三个维度渲染为带复选框的醒目卡片：

* `[ ]` **业务逻辑与产品取舍**：*（展示 AI 提炼的具体取舍点）*
* `[ ]` **架构、兼容性与性能影响**：*（展示跨模块或性能影响说明）*
* `[ ]` **未覆盖的边界条件**：*（展示需重点看代码的边界路径）*
* **交互约束**：审核员必须逐项勾选确认（或点击右上角“全部确认已审阅”），底部的 **`[批准并提交]`** 按钮才会从禁用态变为可点击态；若只是“提出改进意见”或“放弃”，则无需勾选。

#### B. `<GateChecksAndEvidence/>`（合并门禁与验证面板）

* **明文命令授权框**：以代码块形式展示 `gate_checks` 数组中的每条命令，旁注提示：*“点击批准后，将在本机按顺序自动执行以下命令并通过后方可提交”*。
* **支持在线增补门禁**：提供 `[+ 编辑门禁命令]` 按钮。若审核员认为 AI 写的测试范围不够，可直接添加一行测试命令（计入 `draftGateChecks`，随“提出改进意见”一起写回 Frontmatter）。

---

### 4. 代码差异与版本增量对比 (`<CodeDiffWorkspace/>`)

#### A. 版本对比切换器 (`<DiffToolbar/>`)

当 `current_revision >= 2` 时，工具栏提供两种切换模式：

1. **完整差异模式 (Full Patch)**：`Base (r112) ↔ Rev 2`（查看当前版本最终要合入主干的全部代码改动）。
2. **版本增量模式 (Incremental Diff)**：`Rev 1 ↔ Rev 2`（默认在审核第 2 版及以上时自动选中，帮助审核员只看“AI 针对我上一轮意见改了哪里”）。

#### B. 跨基线迁移提示 (`<CrossBaseBanner/>`)

当处于 `Rev 1 (base: 108) ↔ Rev 2 (base: 112)` 增量模式时，根据 `IVcsAdapter.computeInterRevisionDiff` 返回的 `resolutionMode` 渲染顶部状态条：

* `same_base_direct`：不显示警告，直接展示纯净差异。
* `cross_base_3way_clean`：显示蓝色提示条 —— *“ℹ️ 基线已从 108 迁移至 112。已通过三方合并在共同基线 112 上重建对比，已过滤主干其他人的提交。”*
* `cross_base_hunk_fallback`：显示橙色警告条 —— *“⚠️ 基线已从 108 迁移至 112，且旧补丁在新基线上存在冲突，当前已降级为补丁文件 Hunk 级对比。”*

#### C. 内联评论与状态追踪 (`<InlineCommentThread/>`)

* **既有评论展示**：根据 Frontmatter `comments` 数组中的 `file` + `line` 挂载到对应代码行下方。
* 状态标签：`unresolved`（红底“未处理”）、`partial`（黄底“部分处理”）、`resolved`（绿底“已处理”）。
* 审核员可在阅读新版本代码后，手动切换既有评论的状态（例如 AI 自称 `resolved`，但审核员看代码发现没改对，可将其一键拨回 `unresolved` 并追加说明）。


* **新增内联评论**：鼠标悬停代码行号显示 `+` 按钮，点击展开输入框，保存后进入本地 `draftInlineComments`（显示虚线边框 `草稿` 标签），待点击底部“提出改进意见”时一次性原子写入 `review.md`。

---

## 四、三大核心操作的交互流转时序

底部操作栏 `<BottomActionDock/>` 固定包含总体意见输入框与三个主按钮，点击任意操作前均先触发 `preCheckSync()`。

### 1. 点击【提出改进意见 (`Submit Feedback`)】

1. **校验**：要求 `draftGeneralComment` 非空，或 `draftInlineComments.length > 0`，或既有评论被标记为 `unresolved`，或修改了 `draftGateChecks`。
2. **乐观锁与落盘**：调用 `store.submitFeedback()`，同步仓库并校验 `expectedRevision`，将所有草稿内联评论分配唯一 ID（`c3`, `c4`...）写入 `review.md` 的 Frontmatter `comments`，将总体意见追加至正文 `## 版本 N -> ### 人类总体意见`，状态改为 `changes_requested` 并提交。
3. **可选立即唤醒 AI**：提交成功后，底部弹出轻量确认项（或勾选框默认勾选）：*“已变更为 changes_requested，是否立即在本地调用 Runner (Codex) 生成下一版本？”*
* 若确认，本地进入 `localState = 'ai_fixing'`，运行结束后自动刷新详情页加载 `current_revision + 1`。



### 2. 点击【批准并提交 (`Approve & Commit`)】

1. **前置条件**：`humanJudgmentAck` 已全部勾选，且当前无未提交的草稿评论（若有草稿评论未发出，弹窗提醒“您有未发送的内联评论草稿，是否确认忽略并批准？”）。
2. **执行进度抽屉（Modal / Drawer）**：界面锁定，弹出实时步进器（Stepper）：
* `Step 1`: 检查本地工作区干净度 & 同步最新基线...
* `Step 2`: 在最新基线应用 `NNN.patch`...
* `Step 3`: 顺序执行 `gate_checks`（实时滚动展示每条测试命令的耗时与通过状态）...
* `Step 4`: 清理历史 `.patch` 文件并执行代码与 `review.md` 原子提交...


3. **分支结果处理**：
* **成功 (`COMMITTED`)**：显示绿色成功提示与最终 `commitRevision`，2 秒后返回审核队列。
* **冲突或门禁失败回退 (`FALLBACK_TO_PENDING`)**：步进器切换为琥珀色警告：*“在最新基线上发现补丁冲突 / 门禁测试未通过，AI 已自动介入修复并生成了 **版本 N+1**，本次批准已失效，请对新版本重新审核。”* 点击确认后，页面直接刷新为 `版本 N+1` 的增量对比视图。
* **异常中断 (`ABORTED`)**：弹窗展示具体原因（如本地工作区有脏文件、远端版本已变更），安全还原工作区。



### 3. 点击【放弃 (`Reject`)】

1. 弹出确认框，要求填写简短的放弃原因（如“需求已取消”或“AI 修复方向完全错误，已人工另行修复”）。
2. 调用 `store.rejectCandidate()`，将状态设为 `rejected`，删除该候选目录下的所有 `.patch` 文件，仅保留 `review.md` 归档，提交后返回队列页。