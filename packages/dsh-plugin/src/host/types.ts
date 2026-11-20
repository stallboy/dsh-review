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
  /** 仅手动模式返回，交给用户在外部 Agent 中执行。 */
  prompt?: string;
  outputTail?: string;
  manual?: boolean;
  aborted?: boolean;
}

export type ApprovalOutcomeStatus = 'COMMITTED' | 'FALLBACK_TO_PENDING' | 'ABORTED' | 'RECOVERY_REQUIRED';
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
export type ApprovalRecoveryReason = 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN';

export interface ApprovalDecisions {
  confirmed: string[];
  waived: WaivedDecision[];
}

export interface ApprovalOutcome {
  status: ApprovalOutcomeStatus;
  reason?: ApprovalAbortReason | ApprovalFallbackReason | ApprovalRecoveryReason;
  message: string;
  /** 恢复状态须给出需要人工确认的具体事实。 */
  detail?: string;
  commitRevision?: string;
  newRevision?: number;
  manualPrompt?: string;
  jobId?: string;
}

export type AiFixOutcomeStatus = 'COMMITTED' | 'MANUAL_REQUIRED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';

export type AiFixAbortReason =
    /** 三方应用产生冲突，且没有可用的自动修复结果。 */
  | 'REBASE_CONFLICT'
  | 'GATE_CHECK_FAILED'
  /** 两个 VCS 版本之间只有评审元数据变化时，也视为业务基线未变。 */
  | 'BASE_UNCHANGED'
  | 'DIRTY_WORKSPACE'
  | 'CONCURRENCY_MISMATCH'
  | 'STATE_CONFLICT'
  | 'INVALID_CANDIDATE'
  | 'SYNC_FAILED'
  /** 已证明提交未落地且已恢复时使用。 */
  | 'COMMIT_FAILED'
  | 'RUNNER_FAILED'
  | 'CANCELLED';

export type AiFixRecoveryReason = 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN';

export interface AiFixOutcome {
  status: AiFixOutcomeStatus;
  reason?: AiFixAbortReason | AiFixRecoveryReason;
  message: string;
  detail?: string;
  commitRevision?: string | null;
  newRevision?: number;
  manualPrompt?: string;
  errors?: string[];
  jobId?: string;
}

export interface ApprovalCommitLookup {
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

export interface AuditCandidateResult {
  id: string;
  title: string;
  owner: string;
  status: ReviewStatus;
  patch: string;
  baseRevision: string;
  patchStats: PatchStats;
  gateChecks: number;
  errors: string[];
}

export interface ReviewDataFileValidation {
    path: string;
    errors: string[];
}

export interface AuditDeferredItem {
  label: string;
  text: string;
  category: 'confirm' | 'deferred';
}

export interface AuditReportInfo {
  path: string;
  text: string;
  deferred: AuditDeferredItem[];
}

export interface AuditOutcome {
  /** 审查业务结果须单独判定。跟踪任务成功结束时仍可能需要人工收尾。 */
  status: 'MANUAL_REQUIRED' | 'COMMITTED' | 'VALIDATION_FAILED' | 'ABORTED' | 'RECOVERY_REQUIRED';
  manual: boolean;
  auditId: string;
  prompt?: string;
  created: AuditCandidateResult[];
  deferred: AuditDeferredItem[];
  report: AuditReportInfo | null;
  dataValidation?: ReviewDataFileValidation[];
  commitRevision: string | null;
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
  /** 截断日志时继续累加，以便轮询端识别已经丢弃的行。 */
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
