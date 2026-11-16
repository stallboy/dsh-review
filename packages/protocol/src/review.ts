export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected';
export type CommentStatus = 'unresolved' | 'partial' | 'resolved';
export type VcsType = 'git' | 'svn';
export type DiffResolutionMode = 'same_base_direct' | 'cross_base_3way_clean' | 'cross_base_hunk_fallback';

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

    author?: 'ai' | 'human';

    extra?: Record<string, unknown>;
}

export interface ReviewComment {
    id: string;
    revision: number;
    file: string;
    line: number;

    side?: 'LEFT' | 'RIGHT';
    author: string;
    content: string;
    status: CommentStatus;
    createdAt?: string;

    anchor?: { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> };

    extra?: Record<string, unknown>;
}

export interface HumanDecision {
    id: string;
    question: string;
    note?: string;

    extra?: Record<string, unknown>;
}

export interface RejectionMeta {
    rejectedBy: string;
    rejectedAt: string;
    reason: string;

    extra?: Record<string, unknown>;
}

export interface WaivedDecision {
    id: string;
    reason: string;

    extra?: Record<string, unknown>;
}

export interface ApprovalMeta {
    approvedBy: string;
    approvedAt: string;

    gateChecks?: string[];

    gateResults?: Array<{ command: string; exit_code: number; duration_ms: number; extra?: Record<string, unknown> }>;

    confirmedDecisions?: string[];

    waivedDecisions?: WaivedDecision[];

    extra?: Record<string, unknown>;
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

    module: string;

    auditType: AuditType | '';
    createdAt: string;

    updatedAt: string;
    owner: string;
    tags: string[];
    status: ReviewStatus;
    ticket: string | null;

    targetFiles: string[];
    currentRevision: number;
    revisions: RevisionEntry[];
    gateChecks: string[];
    comments: ReviewComment[];
    humanDecisions: HumanDecision[];
    approval: ApprovalMeta | null;
    rejection: RejectionMeta | null;

    commitMessage: string;

    reopenedFrom?: string | null;
    reopenedReason?: string | null;

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

export interface PatchCheckDiagnostic {
    state: 'clean' | 'conflicted' | 'unknown';
    checkedBase: string;
    checkedAt: string;
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

    humanJudgmentDeclared: boolean;
    isBaseBehind: boolean;
    baseRevision: string;
    lastFeedback: string;

    isStale?: boolean;

    fingerprint?: string;

    reopenedFrom?: string | null;

    duplicateOf?: string;

    approvalCommitRevision?: string;

    approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown';
    patchCheck?: PatchCheckDiagnostic;

    local?: boolean;

    localOnly?: boolean;
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

    expectedUpdatedAt: string;
}
