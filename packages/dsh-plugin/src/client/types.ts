import type {
  ApprovalInfo,
  CandidateSummary,
  HumanDecision,
  IssueFindingView,
  OptionPatchCheck,
  PatchEntry,
  PatchStats,
  RepairAttempt,
  RepairOption,
  ReviewComment,
  ReviewStatus,
} from '@dsh-review/protocol';

export type {
  ApprovalInfo,
  CandidateSummary,
  HumanDecision,
  IssueFindingView,
  OptionPatchCheck,
  PatchEntry,
  PatchStats,
  RepairAttempt,
  RepairOption,
  ReviewComment,
  ReviewStatus,
};

export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useLayoutEffect?: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void];
}

export interface Slots {
  inject(name: string, callback: () => void | (() => void)): void;
  register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): void | (() => void);
}

export interface LocaleService {
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string) => string;
}

export interface ClientCtx {
  slots: Slots;
  locale: LocaleService;
  effect(callback: () => void | (() => void), label?: string): void;
  get(name: string): unknown;
}

export interface Loader {
  load(spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): void;
}

export interface Settings {
  repoRoot: string;
  owner: string;
  vcsType: 'auto' | 'git' | 'svn';
  baseBranch: string;
  runner: 'dsh' | 'manual' | 'external';
  dshCommand: string;
  externalCommand: string;
  autoFixOnFailure: boolean;
  gateTimeoutMs: number;
  syncBeforeApprove: boolean;
  stageExecutors: string[];
}

export interface ConnectionDraft {
  mode: 'local' | 'external';
  centerUrl: string;
  nodeId: string;
  token: string;
  reviewIdentity: string;
  label?: string;
  expectedCentralId?: string;
}

export interface SavedConnection {
  centralId: string;
  centerUrl: string;
  nodeId: string;
  label?: string;
}

export interface RuntimeProgress {
  stage: 'preparing' | 'requesting' | 'downloading' | 'verifying' | 'unpacking' | 'switching' | 'starting';
  received?: number;
  total?: number;
  error?: string;
}

export type RegistrationCompatibility = 'supported' | 'unknown' | 'incompatible';

export interface ConnectionIssue {
  stage: 'address' | 'server' | 'credentials' | 'registration' | 'startup';
  code: string;
  detail?: string;
  blockers?: Array<{
    commandId: string;
    projectId?: string;
    project?: string;
    operation?: string;
    state?: string;
    detail?: string;
    events?: { count: number; first: number; last: number };
  }>;
  registrationCompatibility?: RegistrationCompatibility;
}

export interface ConnectionCheck {
  authenticated: boolean;
  registrationCompatibility: RegistrationCompatibility;
}

export interface ConnectionFailure {
  message: string;
  issue?: ConnectionIssue;
  forDraft?: boolean;
  stopFailed?: boolean;
}

export interface ConnectionStatus {
  controlToken: string;
  configured: boolean;
  enabled: boolean;
  mode: 'local' | 'external';
  centerUrl: string;
  centralId: string;
  nodeId: string;
  reviewIdentity: string;
  localReviewIdentity?: string;
  savedConnections?: SavedConnection[];
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  serverReachable?: boolean;
  nodeOnline: boolean;
  error?: string;
  issue?: ConnectionIssue;
  generation: number;
  candidates: { id: string; label: string; root: string; vcsType?: string; target?: string; error?: string }[];
  projects: { workspaceId: string; root: string; label: string; enabled: boolean; projectId?: string; vcsType: string; target: string; workspaceIssue?: string }[];
  logs: string[];
  hasCredentials: boolean;
  localAvailable: boolean;
  localRuntimeDownload?: { version: string; url: string; size: number; sha256: string };
  runtimeProgress?: RuntimeProgress;
  localRuntimeUpdate?: { currentVersion: string; latestVersion: string };
  legacy?: boolean;
}

export interface Health {
  managed?: { centerUrl: string; nodeId: string };
  app: string;
  version: string;
  configured: boolean;
  repoRoot: string;
  owner: string;
  vcsType: 'git' | 'svn' | null;
  currentBase: string | null;
  diagnostics: string[];
  counts: Record<string, number>;
}

export interface SettingsResponse {
  settings: Settings;
  validation: { ok: boolean; errors: string[]; vcsType: 'git' | 'svn' | null };
  suggestedOwner: string;
  runners: { value: string; label: string }[];
}

export interface AuditLeaseInfo {
  auditId: string;
  state: 'active' | 'releasable';
  trigger: string;
  createdAt: string;
  owner: string;
  baseRevision: string;
  targetPath: string;
  sessionId?: string;
  commitOutcomeUnknown?: true;
}

export interface FixSessionInfo {
  candidateId: string;
  optionId: string;
  patchId: number;
  sessionId: string;
  owner: string;
  createdAt: string;
  state: string;
}

export interface Queue {
  configured: boolean;
  items: CandidateSummary[];
  errors: string[];
  currentBase: string | null;
  counts: Record<string, number>;
  owner: string;
  me: string;
  repoRoot?: string;
  auditLease?: AuditLeaseInfo;
  fixSession?: FixSessionInfo;
}

export interface CandidateMeta {
  schemaVersion: 1;
  findingId: string;
  issueKind: 'repair' | 'confirm' | 'deferred';
  dependsOn: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
  module: string;
  priority: string;
  tags: string[];
  status: ReviewStatus;
  ticket: string | null;
  recordRevision: number;
  targetFiles: string[];
  humanDecisions: HumanDecision[];
  patches: PatchEntry[];
  options: RepairOption[];
  repairAttempts: RepairAttempt[];
  comments: ReviewComment[];
  approval: ApprovalInfo | null;
  approvalHistory: ApprovalInfo[];
  commitMessage: string | null;
}

export interface Detail {
  selection?: { optionId: string; patchId: number };
  selectedOption?: RepairOption;
  selectedPatch?: PatchEntry;
  selectedPatchBanned?: boolean;
  finding?: IssueFindingView;
  candidate: {
    id: string;
    month: string;
    slug: string;
    dirPath: string;
    reviewPath: string;
    meta: CandidateMeta;
    sections: { problem: string; rootCause: string; solution: string; humanJudgment: string; evidence: string; history: string };
    humanJudgment: { label: string; text: string }[];
    humanJudgmentDeclared: boolean;
  };
  currentBase: string | null;
  isBaseBehind: boolean;
  patchText: string;
  patchStats: PatchStats;
  patchPaths: string[];
  comments: ReviewComment[];
  validation: string[];
  revisionStats: Record<string, { patch: string; baseRevision: string; stats: PatchStats | null }>;
  approvalCommitRevision?: string;
  approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown';
  /** 预检只用于提示冲突，批准时仍须重新验证补丁。 */
  patchCheck?: OptionPatchCheck;
  canAct: boolean;
  me: string;
}

export interface DiffResult {
  mode: 'full' | 'incremental';
  unifiedDiff: string;
  fromRevision: number | null;
  toRevision: number;
  fromBase: string | null;
  toBase: string;
  resolutionMode: string | null;
  notes: string[];
}

export interface ReviewDataFileValidation {
  path: string;
  errors: string[];
}

export interface JobResultPayload {
  status?: string;
  reason?: string;
  message?: string;
  detail?: string;
  commitRevision?: string | null;
  manualPrompt?: string;
  prompt?: string;
  dataValidation?: ReviewDataFileValidation[];
  newPatchId?: number;
  optionId?: string;
}

export interface Job {
  id: string;
  type: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  result?: JobResultPayload;
  error?: string;
}

export interface GuardSnapshot {
  revision: number;
  owner: string;
  updatedAt: string;
}

export interface DetailState {
  id: string;
  detail: Detail | null;
  stale: boolean;
  guard: GuardSnapshot | null;
}

export type DetailAction =
  | { type: 'open'; id: string }
  | { type: 'leave' }
  | { type: 'loaded'; detail: Detail }
  | { type: 'rebind' };

export const EMPTY_DETAIL_STATE: DetailState = { id: '', detail: null, stale: false, guard: null };
export const EMPTY_STATS: PatchStats = { files: 0, additions: 0, deletions: 0, entries: [] };

/** AC-LOCK-01：评论可在版本和负责人不变时推进 updatedAt，旧页面也须判为过期。 */
export function isGuardStale(
  snapshot: GuardSnapshot | null,
  meta: { recordRevision: number; owner: string; updatedAt: string },
): boolean {
  if (!snapshot) return false;
  return snapshot.revision !== meta.recordRevision
    || snapshot.owner !== meta.owner
    || snapshot.updatedAt !== meta.updatedAt;
}

/** 集中管理详情与 guard，避免切换候选或刷新时沿用旧快照。 */
export function detailReducer(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case 'open':
      return { id: action.id, detail: null, stale: false, guard: null };
    case 'leave':
      return EMPTY_DETAIL_STATE;
    case 'loaded': {
      const meta = action.detail.candidate.meta;
      const nextGuard: GuardSnapshot = { revision: meta.recordRevision, owner: meta.owner, updatedAt: meta.updatedAt };
      if (!state.guard) return { ...state, detail: action.detail, guard: nextGuard };
      const stale = isGuardStale(state.guard, meta) || state.stale;
      return { ...state, detail: action.detail, stale };
    }
    case 'rebind':
      return { ...state, stale: false, guard: null };
    default:
      return state;
  }
}
