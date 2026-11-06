/** Cross-cutting domain types for the AI review host half. */

export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected';
export type CommentStatus = 'unresolved' | 'partial' | 'resolved';
export type VcsType = 'git' | 'svn';
export type RunnerKind = 'dsh' | 'manual' | 'external';
export type DiffResolutionMode = 'same_base_direct' | 'cross_base_3way_clean' | 'cross_base_hunk_fallback';
export type RunnerMode = 'ADDRESS_FEEDBACK' | 'RESOLVE_CONFLICT';
/** §4.2：审查分类枚举（9 值，2026-11-04 §18.4 扩展）。 */
export type AuditType =
  | 'bugfix' | 'delete' | 'shrink' | 'reuse' | 'merge' | 'split'
  | 'stdlib' | 'native' | 'yagni';
export const AUDIT_TYPES: readonly AuditType[] = [
  'bugfix', 'delete', 'shrink', 'reuse', 'merge', 'split', 'stdlib', 'native', 'yagni',
];

export interface RevisionEntry {
  id: number;
  baseRevision: string;
  patch: string;
  /** §4.3：ai = AI 修复 / AI Rebase；human = 人工微调。 */
  author?: 'ai' | 'human';
  /** I14：本版本对象中未建模的键原样保留。 */
  extra?: Record<string, unknown>;
}

export interface ReviewComment {
  id: string;
  revision: number;
  file: string;
  line: number;
  /** §4.6：行内评论必填 LEFT（基线旧代码）/ RIGHT（补丁新代码）；总体评论省略。 */
  side?: 'LEFT' | 'RIGHT';
  author: string;
  content: string;
  status: CommentStatus;
  createdAt?: string;
  /** I14：本评论对象中未建模的键原样保留。 */
  extra?: Record<string, unknown>;
}

/** §4.5：AI 无法自证、必须由人拍板的决策点。 */
export interface HumanDecision {
  id: string;
  question: string;
  note?: string;
  /** I14：未建模键保留。 */
  extra?: Record<string, unknown>;
}

/** §4.8：拒绝留痕；超时归档时 rejectedBy 为 `system:stale`。 */
export interface RejectionMeta {
  rejectedBy: string;
  rejectedAt: string;
  reason: string;
  /** I14：未建模键保留。 */
  extra?: Record<string, unknown>;
}

export interface WaivedDecision {
  id: string;
  reason: string;
}

export interface ApprovalMeta {
  approvedBy: string;
  approvedAt: string;
  commitRevision: string | null;
  /** §4.7：批准时生效的门禁快照（必须与当时顶层 gate_checks 一致）。P5 起写入。 */
  gateChecks?: string[];
  /** §4.7：逐条执行结果（command/exit_code/duration_ms）。P5 起写入。 */
  gateResults?: Array<{ command: string; exit_code: number; duration_ms: number }>;
  /** §4.7：已确认的 human_decisions[].id。P5 起写入。 */
  confirmedDecisions?: string[];
  /** §4.7：知悉但接受风险的判断项（id + 非空 reason）。P5 起写入。 */
  waivedDecisions?: WaivedDecision[];
  /** I14：approval 对象中未建模的键原样保留。 */
  extra?: Record<string, unknown>;
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
  /** §4.2：小写模块标志，用于路由、筛选与负向记忆。开发期旧数据可能缺失。 */
  module: string;
  /** §4.2：9 值审查分类。开发期旧数据可能缺失。 */
  auditType: AuditType | '';
  createdAt: string;
  /** §2.3：最后一次共享写入时间；每次 write 自动维护。 */
  updatedAt: string;
  owner: string;
  tags: string[];
  status: ReviewStatus;
  ticket: string | null;
  /** §4.2：当前补丁实际触及的业务文件（长期事实）。 */
  targetFiles: string[];
  currentRevision: number;
  revisions: RevisionEntry[];
  gateChecks: string[];
  comments: ReviewComment[];
  humanDecisions: HumanDecision[];
  approval: ApprovalMeta | null;
  rejection: RejectionMeta | null;
  /** §4.9：多行提交信息；首行必须与 title 一致。 */
  commitMessage: string;
  /** §4.8/§18.6：人工重开字段，可选；二者必须同时出现或同时缺省。 */
  reopenedFrom?: string | null;
  reopenedReason?: string | null;
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
  /** True when the AI actually wrote the `# 需人工判断项` section (even if it only says “无”). */
  humanJudgmentDeclared: boolean;
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
  /** True when the candidate declares the human-judgment section; false means it was never filled. */
  humanJudgmentDeclared: boolean;
  isBaseBehind: boolean;
  baseRevision: string;
  lastFeedback: string;
  /** §18.1：超过 stale_days 的活跃候选——队列只提示，不做读时写。 */
  isStale?: boolean;
  /** §7：负向记忆指纹（module+排序 target_files+audit_type+规范化 title）。 */
  fingerprint?: string;
  /** §4.8：人工重开指向的被拒候选；null 表示非重开。 */
  reopenedFrom?: string | null;
  /** §7.4：窗口内完全重复的被拒候选 id——该候选被阻止进入审核。 */
  duplicateOf?: string;
  /** §18.8：approved 但 commit_revision 未回填——队列提示幂等补填。 */
  needsBackfill?: boolean;
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
  | 'DECISIONS_UNCONFIRMED'
  | 'COMMIT_MESSAGE_MISMATCH'
  | 'NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

/** §4.7：批准时人工判断项的处理记录。 */
export interface ApprovalDecisions {
  confirmed: string[];
  waived: WaivedDecision[];
}

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
  /** §6.1 定时审查间隔（分钟）；0 = 关闭。 */
  scheduleIntervalMinutes: number;
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
