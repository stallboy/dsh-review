/** Cross-cutting domain types for the AI review host half. */

export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected';
export type CommentStatus = 'unresolved' | 'partial' | 'resolved';
export type VcsType = 'git' | 'svn';
export type RunnerKind = 'dsh' | 'manual' | 'external';
export type DiffResolutionMode = 'same_base_direct' | 'cross_base_3way_clean' | 'cross_base_hunk_fallback';
export type RunnerMode = 'ADDRESS_FEEDBACK' | 'RESOLVE_CONFLICT';

export interface RevisionEntry {
  id: number;
  baseRevision: string;
  patch: string;
}

export interface ReviewComment {
  id: string;
  revision: number;
  file: string;
  line: number;
  author: string;
  content: string;
  status: CommentStatus;
  createdAt?: string;
}

export interface ApprovalMeta {
  approvedBy: string;
  approvedAt: string;
  commitRevision: string | null;
}

export interface GateCheckResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface ReviewFrontmatter {
  schemaVersion: number;
  title: string;
  createdAt: string;
  owner: string;
  tags: string[];
  status: ReviewStatus;
  ticket: string | null;
  currentRevision: number;
  revisions: RevisionEntry[];
  gateChecks: string[];
  comments: ReviewComment[];
  approval: ApprovalMeta | null;
  /** Unknown frontmatter keys are preserved so an AI-authored file is never truncated. */
  extra: Record<string, unknown>;
}

export interface HumanJudgmentItem {
  label: string;
  text: string;
}

export interface ReviewSections {
  problem: string;
  rootCause: string;
  solution: string;
  humanJudgment: string;
  evidence: string;
  history: string;
  rawBody: string;
}

export interface ReviewCandidate {
  id: string;
  month: string;
  slug: string;
  dirPath: string;
  reviewPath: string;
  meta: ReviewFrontmatter;
  sections: ReviewSections;
  humanJudgment: HumanJudgmentItem[];
  /** Present when the file is readable but not valid; the UI shows it as broken. */
  parseError?: string;
}

export interface PatchFileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface PatchStats {
  files: number;
  additions: number;
  deletions: number;
  entries: PatchFileStat[];
}

export interface CandidateSummary {
  id: string;
  title: string;
  owner: string;
  status: ReviewStatus;
  tags: string[];
  ticket: string | null;
  currentRevision: number;
  createdAt: string;
  dirPath: string;
  patchStats: PatchStats;
  unresolvedComments: number;
  humanJudgmentCount: number;
  isBaseBehind: boolean;
  baseRevision: string;
  lastFeedback: string;
  parseError?: string;
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
}

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
}

export type ApprovalOutcomeStatus = 'COMMITTED' | 'FALLBACK_TO_PENDING' | 'ABORTED';
export type ApprovalAbortReason =
  | 'CONCURRENCY_MISMATCH'
  | 'DIRTY_WORKSPACE'
  | 'MAX_RETRIES_EXCEEDED'
  | 'RUNNER_FAILED'
  | 'PATCH_CONFLICT'
  | 'GATE_CHECK_FAILED'
  | 'NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

export interface ApprovalOutcome {
  status: ApprovalOutcomeStatus;
  reason?: ApprovalAbortReason;
  message: string;
  commitRevision?: string;
  newRevision?: number;
  jobId?: string;
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
  manual: boolean;
  /** Manual mode only: the prompt to hand to any external agent. */
  prompt?: string;
  created: AuditCandidateResult[];
  deferred: AuditDeferredItem[];
  report: AuditReportInfo | null;
  commitRevision: string | null;
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
