export type ReviewStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'repair_failed'
  | 'human_takeover'
  | 'awaiting_verification'
  | 'resolved';

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'repair_failed',
  'human_takeover',
  'awaiting_verification',
  'resolved',
] as const;

export type IssueKind = 'repair' | 'confirm' | 'deferred';
export type ReviewPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type CommentStatus = 'unresolved' | 'partial' | 'resolved';
export type CommentSide = 'LEFT' | 'RIGHT';

export type AuditType =
  | 'bugfix'
  | 'delete'
  | 'shrink'
  | 'reuse'
  | 'merge'
  | 'split'
  | 'stdlib'
  | 'native'
  | 'yagni';

export type IssueDecisionAction =
  | 'accept_as_is'
  | 'defer'
  | 'human_takeover'
  | 'add_repair_hint'
  | 'external_completed'
  | 'resume_review';

export type FindingDisposition =
  | 'undecided'
  | 'accept_as_is'
  | 'defer'
  | 'human_takeover'
  | 'applied'
  | 'resolved';

export type RepairApplyMode = 'program_strict' | 'program_3way' | 'agent_assisted';
export type RepairAttemptResult = 'applied' | 'verification_failed';

export interface SvnApprovalSource {
  uuid: string;
  relativeUrl: string;
  extra?: Record<string, unknown>;
}

export interface PatchEntry {
  id: number;
  patch: string;
  optionId: string;
  baseRevision: string;
  author: 'ai' | 'human';
  sha256: string;
  svnApprovalSource?: SvnApprovalSource;
  extra?: Record<string, unknown>;
}

export interface RepairOption {
  id: string;
  title: string;
  tradeoff: string;
  confidence: number;
  currentPatch: number;
  gateChecks: string[];
  extra?: Record<string, unknown>;
}

export interface IssueEvidence {
  path: string;
  line: number;
  excerpt: string;
  reason: string;
  extra?: Record<string, unknown>;
}

export interface IssueObservation {
  auditId: string;
  baseRevision: string;
  at: string;
  verdict: 'confirmed' | 'resolved' | 'unverified';
  reason: string;
  evidence: IssueEvidence[];
  extra?: Record<string, unknown>;
}

export interface IssueDecision {
  action: IssueDecisionAction;
  actor: string;
  at: string;
  reason: string;
  reviewAfter?: string;
  reviewWhen?: string;
  category?: string;
  relatedSymbols?: string[];
  extra?: Record<string, unknown>;
}

export interface RepairAttempt {
  id: number;
  optionId: string;
  patchId: number;
  baseRevision: string;
  actor: string;
  at: string;
  applyMode: RepairApplyMode;
  result: RepairAttemptResult;
  restored: boolean;
  evidence: string;
  extra?: Record<string, unknown>;
}

export interface CommentAnchor {
  snippet: string;
  before?: string;
  after?: string;
  extra?: Record<string, unknown>;
}

export interface ReviewComment {
  id: string;
  revision: number;
  optionId?: string;
  patchId?: number;
  file: string;
  line: number;
  side?: CommentSide;
  author: string;
  content: string;
  status: CommentStatus;
  createdAt?: string;
  anchor?: CommentAnchor;
  extra?: Record<string, unknown>;
}

export interface HumanDecision {
  id: string;
  question: string;
  note?: string;
  extra?: Record<string, unknown>;
}

export interface WaivedDecision {
  id: string;
  reason: string;
  extra?: Record<string, unknown>;
}

export interface GateCheckResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  passed?: boolean;
  timedOut?: boolean;
  outputTail?: string;
  extra?: Record<string, unknown>;
}

export interface ApprovalInfo {
  approvedBy: string;
  approvedAt: string;
  recordRevision: number;
  optionId: string;
  patchId: number;
  patchSha256: string;
  repairAttemptId: number;
  baseRevision: string;
  gateChecks: string[];
  gateResults: GateCheckResult[];
  confirmedDecisions: string[];
  waivedDecisions: WaivedDecision[];
  /** 仅在 Mode C 提前推送远端后的独立元数据关闭提交中由 Host 写入，用于派生定位业务提交。 */
  businessCommit?: string;
  extra?: Record<string, unknown>;
}

export interface RejectionInfo {
  rejectedBy: string;
  rejectedAt: string;
  reason: string;
  category?: string;
  relatedSymbols?: string[];
  extra?: Record<string, unknown>;
}

export interface ReviewFrontmatter {
  schemaVersion: number;
  findingId: string;
  title: string;
  module: string;
  auditType: AuditType | '';
  issueKind: IssueKind;
  dependsOn: string | null;
  priority: ReviewPriority;
  baseRevision: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
  tags: string[];
  ticket: string | null;
  status: ReviewStatus;
  targetFiles: string[];
  recordRevision: number;
  patches: PatchEntry[];
  options: RepairOption[];
  observations: IssueObservation[];
  decisions: IssueDecision[];
  repairAttempts: RepairAttempt[];
  comments: ReviewComment[];
  humanDecisions: HumanDecision[];
  approval: ApprovalInfo | null;
  approvalHistory: ApprovalInfo[];
  rejection: RejectionInfo | null;
  commitMessage: string | null;
  extra?: Record<string, unknown>;
}

export interface ReviewSections {
  problem: string;
  rootCause: string;
  solution: string;
  humanJudgment: string;
  evidence: string;
  history: string;
}

export interface HumanJudgmentItem {
  label: string;
  text: string;
}

export interface ReviewCandidate {
  id: string;
  month: string;
  slug: string;
  dirPath: string;
  reviewPath: string;
  meta: ReviewFrontmatter;
  body: string;
  sections: ReviewSections;
  humanJudgment: HumanJudgmentItem[];
  humanJudgmentDeclared: boolean;
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

export interface OptionPatchCheck {
  optionId: string;
  patchId: number;
  state: 'clean' | 'conflicted' | 'unknown';
  checkedBase: string;
  checkedAt: string;
}

export interface OptionSummary {
  id: string;
  title: string;
  tradeoff: string;
  confidence: number;
  currentPatch: number;
  banned: boolean;
  patchStats: PatchStats;
  patchCheck?: OptionPatchCheck;
}

export interface IssueSelection {
  optionId: string;
  patchId: number;
}

export interface CandidateSummary {
  id: string;
  findingId: string;
  title: string;
  module: string;
  auditType: AuditType | '';
  issueKind: IssueKind;
  dependsOn: string | null;
  priority: ReviewPriority;
  owner: string;
  status: ReviewStatus | 'broken';
  tags: string[];
  targetFiles?: string[];
  ticket: string | null;
  /** API 统一暴露的记录版本，等价于 record_revision。 */
  currentRevision: number;
  recordRevision: number;
  createdAt: string;
  updatedAt: string;
  baseRevision: string;
  patchStats: PatchStats;
  unresolvedComments: number;
  humanJudgmentCount: number;
  humanJudgmentDeclared: boolean;
  isBaseBehind: boolean;
  lastFeedback: string;
  deferred: boolean;
  options: OptionSummary[];
  patchCheck?: OptionPatchCheck;
  approvalCommitRevision?: string;
  approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown';
  parseError?: string;
  /** 本地视图只供诊断，不参与共享统计与写裁决。 */
  local?: boolean;
  /** 尚未进入共享快照的候选没有可打开的共享详情。 */
  localOnly?: boolean;
  isStale?: boolean;
  duplicateOf?: string;
}

export interface IssueFindingView {
  id: string;
  findingId: string;
  recordRevision: number;
  owner: string;
  updatedAt: string;
  title: string;
  summary: string;
  module: string;
  auditType: AuditType | '';
  priority: ReviewPriority;
  issueStatus: ReviewStatus;
  issueKind: IssueKind;
  dependsOn: string | null;
  deferred: boolean;
  disposition: FindingDisposition;
  baseRevision: string;
  targetFiles: string[];
  repairPlan: string;
  options: Array<{
    optionId: string;
    title: string;
    tradeoff: string;
    confidence: number;
    patchId: number;
    banned: boolean;
    gateChecks: string[];
  }>;
  decision?: {
    action: IssueDecisionAction;
    actor: string;
    at: string;
    reason: string;
    reviewAfter?: string;
    reviewWhen?: string;
    category?: string;
  };
  repairHints: string[];
  repairAttempts: RepairAttempt[];
}
