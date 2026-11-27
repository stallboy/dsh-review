import type {
  ApprovalInfo,
  AuditType,
  CandidateSummary,
  CommentAnchor,
  CommentSide,
  CommentStatus,
  FindingDisposition,
  GateCheckResult,
  HumanDecision,
  HumanJudgmentItem,
  IssueDecision,
  IssueDecisionAction,
  IssueEvidence,
  IssueFindingView,
  IssueKind,
  IssueObservation,
  IssueSelection,
  OptionPatchCheck,
  OptionSummary,
  PatchEntry,
  PatchFileStat,
  PatchStats,
  RejectionInfo,
  RepairApplyMode,
  RepairAttempt,
  RepairAttemptResult,
  RepairOption,
  ReviewCandidate,
  ReviewComment,
  ReviewFrontmatter,
  ReviewPriority,
  ReviewSections,
  ReviewStatus,
  SvnApprovalSource,
  WaivedDecision,
} from '@dsh-review/protocol';
import { REVIEW_STATUSES } from '@dsh-review/protocol';

export { REVIEW_STATUSES };
export type {
  ApprovalInfo,
  AuditType,
  CandidateSummary,
  CommentAnchor,
  CommentSide,
  CommentStatus,
  FindingDisposition,
  GateCheckResult,
  HumanDecision,
  HumanJudgmentItem,
  IssueDecision,
  IssueDecisionAction,
  IssueEvidence,
  IssueFindingView,
  IssueKind,
  IssueObservation,
  IssueSelection,
  OptionPatchCheck,
  OptionSummary,
  PatchEntry,
  PatchFileStat,
  PatchStats,
  RejectionInfo,
  RepairApplyMode,
  RepairAttempt,
  RepairAttemptResult,
  RepairOption,
  ReviewCandidate,
  ReviewComment,
  ReviewFrontmatter,
  ReviewPriority,
  ReviewSections,
  ReviewStatus,
  SvnApprovalSource,
  WaivedDecision,
};

export type VcsType = 'git' | 'svn';
export type RunnerType = 'dsh' | 'manual' | 'external';

export interface AppSettings {
  repoRoot: string;
  owner: string;
  vcsType: 'auto' | VcsType;
  baseBranch: string;
  runner: RunnerType;
  dshCommand: string;
  externalCommand: string;
  /** 分阶段审查与自检优先尝试的外部专业执行器清单；不可用时自动降级为本 Harness 独立子代理。 */
  stageExecutors: string[];
  /** 仅控制批准时程序应用受阻是否唤起 Mode C 修复 Agent；门禁失败绝不自动触发 Agent。 */
  autoFixOnFailure: boolean;
  gateTimeoutMs: number;
  syncBeforeApprove: boolean;
}

export interface ReviewFilter {
  owner?: string;
  statuses?: ReviewStatus[];
  tag?: string;
  dir?: string;
  text?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface ConcurrencyGuard {
  expectedRevision: number;
  expectedOwner: string;
  expectedUpdatedAt: string;
}

export interface InterRevisionDiff {
  resolutionMode: 'same_base_direct' | 'cross_base_3way_clean' | 'cross_base_hunk_fallback';
  unifiedDiff: string;
  fromRevision: number;
  toRevision: number;
  fromBase: string;
  toBase: string;
  notes: string[];
}

export interface ApplyPatchResult {
  ok: boolean;
  conflict: boolean;
  message: string;
}

export interface AuthorStatBucket {
  name: string;
  email: string;
  commits: number;
}

export interface AuthorStats {
  buckets: AuthorStatBucket[];
  historyCommits: number;
  pendingFiles: number;
  diagnostic?: string;
  scope: 'tracked' | 'repo';
}

export interface ApprovalCommitLookup {
  revision: string | null;
  lookup: 'found' | 'ambiguous' | 'unknown';
  diagnostic?: string;
}

export type ApprovalFallbackReason = 'PATCH_CONFLICT' | 'MATERIAL_CHANGE';

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

export type ApprovalRecoveryReason =
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'SYNC_STATE_UNKNOWN'
  | 'RESTORE_INCOMPLETE'
  | 'REMOTE_PUSH_UNREVERTIBLE';

export type ApprovalOutcome =
  | { status: 'COMMITTED'; jobId: string; commitRevision: string; closingCommitRevision?: string; message: string; gateResults?: GateCheckResult[] }
  | { status: 'REPAIR_FAILED'; jobId: string; reason: 'GATE_CHECK_FAILED'; commitRevision: string; message: string; gateResults: GateCheckResult[] }
  | { status: 'FALLBACK_TO_PENDING'; jobId: string; reason: ApprovalFallbackReason; newRevision?: number; manualPrompt?: string; message: string }
  | { status: 'ABORTED'; jobId: string; reason: ApprovalAbortReason; duplicateOf?: string; detail?: string; message: string }
  | { status: 'RECOVERY_REQUIRED'; jobId: string; reason: ApprovalRecoveryReason; detail: string; message: string };

export type AiFixAbortReason =
  | 'REBASE_CONFLICT'
  | 'BASE_UNCHANGED'
  | 'DIRTY_WORKSPACE'
  | 'CONCURRENCY_MISMATCH'
  | 'STATE_CONFLICT'
  | 'INVALID_CANDIDATE'
  | 'SYNC_FAILED'
  | 'COMMIT_FAILED'
  | 'RUNNER_FAILED'
  | 'CANCELLED';

export type AiFixOutcome =
  | { status: 'COMMITTED'; newRevision: number; newPatchId?: number; optionId?: string; commitRevision: string | null; message: string }
  | { status: 'MANUAL_REQUIRED'; prompt: string; message: string }
  | { status: 'VALIDATION_FAILED'; errors: string[]; message: string }
  | { status: 'ABORTED'; reason: AiFixAbortReason; detail?: string; message: string }
  | { status: 'RECOVERY_REQUIRED'; reason: 'COMMIT_OUTCOME_UNKNOWN' | 'SYNC_STATE_UNKNOWN' | 'RESTORE_INCOMPLETE'; detail: string; message: string };

export type AuditOutcomeStatus =
  | 'COMMITTED'
  | 'MANUAL_REQUIRED'
  | 'VALIDATION_FAILED'
  | 'ABORTED'
  | 'RECOVERY_REQUIRED';

export type AuditRecoveryReason =
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'SYNC_STATE_UNKNOWN'
  | 'SCHEDULE_RECHECK_DIRTY'
  | 'SCHEDULE_SCAN_DIRTY';

export interface AuditCandidateResult {
  id: string;
  findingId?: string;
  title: string;
  owner: string;
  status: string;
  issueKind?: IssueKind;
  patch: string;
  baseRevision: string;
  patchStats: PatchStats;
  gateChecks: number;
  errors: string[];
}

export interface AuditReportInfo {
  path: string;
  text: string;
  issues: string[];
}

export interface ReviewDataFileValidation {
  path: string;
  errors: string[];
}

export interface AuditOutcome {
  manual: boolean;
  status: AuditOutcomeStatus;
  auditId: string;
  prompt?: string;
  created: AuditCandidateResult[];
  issues: string[];
  report: AuditReportInfo | null;
  commitRevision: string | null;
  baseRevision: string;
  targetPath: string;
  warnings: string[];
  dataValidation?: ReviewDataFileValidation[];
  reason?: AuditRecoveryReason;
  detail?: string;
  message: string;
  outputTail?: string;
}

export interface JobRecord {
  id: string;
  type: 'approve' | 'ai_fix' | 'audit';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  logStartOffset?: number;
  result?: unknown;
  error?: string;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'not_configured'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'stale'
  | 'internal';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
