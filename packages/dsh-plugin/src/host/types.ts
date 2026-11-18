import type { DiffResolutionMode, GateCheckResult, PatchStats, ReviewStatus, VcsType, WaivedDecision } from '@dsh-review/protocol';

export { AUDIT_TYPES } from '@dsh-review/protocol';
export type {
    ReviewStatus,
    CommentStatus,
    VcsType,
    DiffResolutionMode,
    AuditType,
    RevisionEntry,
    ReviewComment,
    HumanDecision,
    RejectionMeta,
    WaivedDecision,
    ApprovalMeta,
    AuthorStatBucket,
    AuthorStats,
    GateCheckResult,
    ReviewFrontmatter,
    HumanJudgmentItem,
    ReviewSections,
    ReviewCandidate,
    PatchFileStat,
    PatchStats,
    PatchCheckDiagnostic,
    CandidateSummary,
    ReviewFilter,
    ConcurrencyGuard,
} from '@dsh-review/protocol';

export type RunnerKind = 'dsh' | 'manual' | 'external';
export type RunnerMode = 'ADDRESS_FEEDBACK' | 'RESOLVE_CONFLICT';

export interface ApplyPatchResult {
  ok: boolean;
  conflict: boolean;
  message: string;
}

export interface InterRevisionDiff {
  resolutionMode: DiffResolutionMode;
  unifiedDiff: string;
  fromRevision: number;
  toRevision: number;
  fromBase: string;
  toBase: string;
  notes: string[];
}

export interface ValidationReport {
  allPassed: boolean;
  baseRevision: string;
  environmentSummary: string;
  results: GateCheckResult[];
  formattedEvidenceMarkdown: string;
}

export interface RunnerExecutionResult {
  success: boolean;
  newRevisionId?: number;
  newPatchPath?: string;
  schemeChanged?: boolean;
  errorMessage?: string;
  /** Manual runner: the ready-to-copy fix prompt. */
  prompt?: string;
  /** Last part of the runner's output, for the UI log panel. */
  outputTail?: string;
  /** True when nothing was run because the user must act manually. */
  manual?: boolean;
  /** §7.7：Runner 被 Job 取消信号终止。 */
  aborted?: boolean;
}

export type ApprovalOutcomeStatus = 'COMMITTED' | 'FALLBACK_TO_PENDING' | 'ABORTED' | 'RECOVERY_REQUIRED';
/** §7.5：FALLBACK_TO_PENDING 专属原因（不属于 ABORTED）。 */
export type ApprovalFallbackReason = 'PATCH_CONFLICT' | 'GATE_CHECK_FAILED';
export type ApprovalAbortReason =
  | 'CONCURRENCY_MISMATCH'
  | 'STATE_CONFLICT'
  | 'DUPLICATE_CANDIDATE'
  | 'DECISIONS_UNCONFIRMED'
  | 'COMMIT_MESSAGE_MISMATCH'
  | 'INVALID_CANDIDATE'
  | 'DIRTY_WORKSPACE'
  | 'SYNC_FAILED'
  | 'BUSINESS_CONTENT_CHANGED'
  | 'COMMIT_FAILED'
  | 'MAX_RETRIES_EXCEEDED'
  | 'RUNNER_FAILED';
/** §7.5：提交/同步结果不明，必须人工确认 VCS 与工作区状态。 */
export type ApprovalRecoveryReason = 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN';

/** §4.7：批准时人工判断项的处理记录。 */
export interface ApprovalDecisions {
  confirmed: string[];
  waived: WaivedDecision[];
}

export interface ApprovalOutcome {
  status: ApprovalOutcomeStatus;
  reason?: ApprovalAbortReason | ApprovalFallbackReason | ApprovalRecoveryReason;
  message: string;
  /** RECOVERY_REQUIRED 必含：说明需要人工确认的具体状态。 */
  detail?: string;
  /** COMMITTED 必含非空提交版本号。 */
  commitRevision?: string;
  newRevision?: number;
  /** FALLBACK_TO_PENDING + manual runner：可复制的人工修复提示词。 */
  manualPrompt?: string;
  jobId?: string;
}

/**
 * §7.7：`ai_fix` 类型 Job 的业务结果（/rebase、/manual-revision、/candidate/finalize、/ai-fix）。
 *
 * 类型边界（重要，勿混用）：
 * - **§7.5 的 `ApprovalOutcome` 只属于 approve Job**：批准遇到补丁冲突/门禁失败时必须是
 *   `FALLBACK_TO_PENDING`（reason 为 PATCH_CONFLICT / GATE_CHECK_FAILED），绝不能是
 *   `ABORTED`（附录 A G16）。其 ABORTED 原因表是封闭枚举，**不得**加入 REBASE_CONFLICT。
 * - **本类型属于 ai_fix Job**：只使用 §7.7 第二条的通用业务取值
 *   （COMMITTED / MANUAL_REQUIRED / VALIDATION_FAILED / ABORTED / RECOVERY_REQUIRED），
 *   ABORTED 的 reason 由本枚举定义。
 */
export type AiFixOutcomeStatus = 'COMMITTED' | 'MANUAL_REQUIRED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';

/** §7.7：ai_fix Job 的 ABORTED 原因（与 §7.5 ApprovalAbortReason 相互独立）。 */
export type AiFixAbortReason =
  /** /rebase：三方应用冲突，且未自动消解（runner=manual 或消解失败）。 */
  | 'REBASE_CONFLICT'
  /** 门禁未通过，未产生新版本。 */
  | 'GATE_CHECK_FAILED'
  /** /rebase：有效业务基线未变（业务代码在两基线间没有任何变化）。 */
  | 'BASE_UNCHANGED'
  /** 工作区不干净。 */
  | 'DIRTY_WORKSPACE'
  /** 候选在排队期间被更新（guard 失配）或状态不再是 pending。 */
  | 'CONCURRENCY_MISMATCH'
  | 'STATE_CONFLICT'
  /** 候选数据不合法、补丁不可应用或导出的新补丁不可用。 */
  | 'INVALID_CANDIDATE'
  /** 无法读取基线。 */
  | 'SYNC_FAILED'
  /** 提交新版本失败（已证明提交不存在并已恢复）。 */
  | 'COMMIT_FAILED'
  /** Runner 失败或被取消。 */
  | 'RUNNER_FAILED'
  | 'CANCELLED';

/** §7.7：ai_fix Job 的 RECOVERY_REQUIRED 原因。 */
export type AiFixRecoveryReason = 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN';

export interface AiFixOutcome {
  status: AiFixOutcomeStatus;
  /** ABORTED / RECOVERY_REQUIRED 必含。 */
  reason?: AiFixAbortReason | AiFixRecoveryReason;
  message: string;
  /** RECOVERY_REQUIRED 必含：需要人工确认的具体状态。 */
  detail?: string;
  /** COMMITTED 必含非空提交版本号。 */
  commitRevision?: string | null;
  /** 追加了新版本时给出新版本号。 */
  newRevision?: number;
  /** manual runner 或冲突时给出可复制的人工修复提示词。 */
  manualPrompt?: string;
  /** VALIDATION_FAILED 的逐项错误。 */
  errors?: string[];
  jobId?: string;
}

/** §5.5：业务提交版本的派生定位结果（只读诊断）。 */export interface ApprovalCommitLookup {
  revision: string | null;
  lookup: 'found' | 'ambiguous' | 'unknown';
  diagnostic?: string;
}

export interface AppSettings {
  repoRoot: string;
  owner: string;
  vcsType: 'auto' | VcsType;
  baseBranch: string;
  runner: RunnerKind;
  dshCommand: string;
  externalCommand: string;
  autoFixOnFailure: boolean;
  gateTimeoutMs: number;
  syncBeforeApprove: boolean;
}

/** One A-class candidate that the repo auditor actually produced on disk. */
export interface AuditCandidateResult {
  id: string;
  title: string;
  owner: string;
  status: ReviewStatus;
  patch: string;
  baseRevision: string;
  patchStats: PatchStats;
  gateChecks: number;
  /** Authoritative plugin checks; an empty list means the candidate is ready to review. */
  errors: string[];
}

export interface AuditDeferredItem {
  label: string;
  text: string;
  /** B-class "needs a human decision now" vs "must wait for a prerequisite candidate". */
  category: 'confirm' | 'deferred';
}

export interface AuditReportInfo {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
  deferred: AuditDeferredItem[];
}

export interface AuditOutcome {
  /** §7.7 判别字段：Client 按 result.status 解释业务结果，不得只看外层 Job 状态。 */
  status: 'MANUAL_REQUIRED' | 'COMMITTED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';
  manual: boolean;
  /** 本轮审查档案 id（目录式 .ai-review/audits/<audit_id>/）。 */
  auditId: string;
  /** Manual mode only: the prompt to hand to any external agent. */
  prompt?: string;
  created: AuditCandidateResult[];
  deferred: AuditDeferredItem[];
  report: AuditReportInfo | null;
  commitRevision: string | null;
  /** §7.7：RECOVERY_REQUIRED 必含 reason/detail。 */
  reason?: 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN' | 'SCHEDULE_RECHECK_DIRTY' | 'SCHEDULE_SCAN_DIRTY';
  detail?: string;
  baseRevision: string;
  targetPath: string;
  warnings: string[];
  message: string;
  outputTail?: string;
}

export interface JobRecord {
  id: string;
  type: 'approve' | 'ai_fix' | 'audit' | 'reject' | 'feedback';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  /** §8.2/G36：log[0] 的绝对行序号（截断后递增）；未截断为 0。 */
  logStartOffset?: number;
  result?: unknown;
  error?: string;
}

export interface HealthInfo {
  app: string;
  version: string;
  configured: boolean;
  repoRoot: string;
  owner: string;
  vcsType: VcsType | null;
  currentBase: string | null;
  diagnostics: string[];
}

export type ApiErrorCode =
  | 'bad_request'
  | 'not_configured'
  | 'not_found'
  | 'stale'
  | 'forbidden'
  | 'conflict'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
