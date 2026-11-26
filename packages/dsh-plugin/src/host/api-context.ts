/** 供各 API 子模块共用的宿主接口与请求上下文。宿主通过 ApiHost 注入，避免循环依赖。 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { ManagedCommand } from '@dsh-review/protocol';
import path from 'node:path';
import {
  ApiError,
  REVIEW_STATUSES,
  type AppSettings,
  type ConcurrencyGuard,
  type IssueSelection,
  type JobRecord,
  type ReviewFilter,
  type ReviewStatus,
  type VcsType,
} from './types.js';
import type { JobManager } from './jobs.js';
import type { AuditLifecycle, AuditLeaseRecord } from './audit-lifecycle.js';
import type { ReviewStore } from './store.js';
import type { SharedCandidateSource } from './shared-facts.js';
import { GitHeadCandidateSource, SvnBaseCandidateSource } from './shared-facts.js';
import type { VcsAdapter } from './vcs.js';
import type { RunAgentResult } from './runner.js';

export const API_PREFIX = '/dsh-code-review/api';
export const APP_VERSION = '1.0.0';
const BODY_LIMIT = 2 * 1024 * 1024;

const INTERNAL_BODY = Symbol('internal-body');

export type ApiRequest = IncomingMessage | {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  [INTERNAL_BODY]: Record<string, unknown>;
};

export interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(value?: string | Uint8Array): unknown;
}

export interface TrustedActor {
  userId: string;
  reviewIdentity: string;
  commandId?: string;
  managedAuditSession?: {
    signal: AbortSignal;
    onCreated(auditId: string, sessionId: string): void;
    reportStopping?: (line: string) => Promise<void>;
    nodeShutdown?: AbortSignal;
  };
  scheduledAudit?: NonNullable<ManagedCommand['scheduledAudit']> & { target: string; signal: AbortSignal };
}

export interface ApiInvocation {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  actor?: TrustedActor;
}

export interface ApiInvocationResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

const actorContext = new AsyncLocalStorage<TrustedActor>();
const sharedContext = new AsyncLocalStorage<{ root: string; view: SharedView }>();

export function withSharedView<T>(root: string, view: SharedView, task: () => T): T {
  return sharedContext.run({ root, view }, task);
}

export function currentTrustedActor(): TrustedActor | undefined {
  return actorContext.getStore();
}

export function withTrustedActor<T>(actor: TrustedActor, task: () => T): T {
  return actorContext.run(Object.freeze({ ...actor }), task);
}

export function internalRequest(method: string, url: string, body: Record<string, unknown>): ApiRequest {
  return { method, url, headers: {}, [INTERNAL_BODY]: body };
}

export interface ApiDeps {
  auditSessionTools?: boolean;
  auditStageExecutor?: import('./audit-stage-runner.js').ExecuteAuditStage;
  auditStageGates?: typeof import('./validator.js').runGateChecks;
  runModeC?: (input: { prompt: string; cwd: string; signal?: AbortSignal }) => Promise<RunAgentResult>;
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resolveCredential?: (reference: string) => Promise<string | undefined>;
  decorateVcs?: (vcs: VcsAdapter) => VcsAdapter;
  resolveSessionCwd?: (sessionId: string) => string | undefined;
  createAuditSession?: (input: {
    cwd: string;
    title: string;
    prompt: string;
    requestId?: string;
    requireWorkspace?: boolean;
    cwdOnly?: true;
    signal?: AbortSignal;
    ownerSessionId?: string;
    onCreated?: (sessionId: string) => Promise<void>;
  }) => Promise<{ sessionId: string }>;
  createFixSession?: (input: {
    cwd: string;
    title: string;
    prompt: string;
    ownerSessionId?: string;
  }) => Promise<{ sessionId: string }>;
  withAuditSessionIdle?: (
    sessionId: string,
    requestId: string,
    signal: AbortSignal,
    finalize: (signal: AbortSignal) => Promise<void | false>,
  ) => Promise<boolean>;
  stopAuditSession?: (sessionId: string, signal: AbortSignal, processStopped: Promise<boolean>) => Promise<boolean>;
  onAuditTurnEnd?: (sessionId: string, callback: () => void) => () => void;
  clientEntry?: () => unknown;
  /** 缺省落在 DSH_HOME/dsh-code-review/runtime-state.json，使未释放的租约与占用在宿主重启后仍能阻塞写入。 */
  statePath?: string;
}

export interface Runtime {
  root: string;
  store: ReviewStore;
  vcs: VcsAdapter;
  vcsType: VcsType;
}

export interface SharedView {
  source: SharedCandidateSource;
  snapshot: string | null;
}

export async function sharedViewFor(runtime: Runtime): Promise<SharedView | undefined> {
  const managed = sharedContext.getStore();
  if (managed?.root === runtime.root) return managed.view;
  if (runtime.vcsType === 'git') {
    const source = await GitHeadCandidateSource.create(runtime.root).catch(() => null);
    return source ? { source, snapshot: await source.snapshotId() } : undefined;
  }
  if (runtime.vcsType === 'svn') {
    const source = new SvnBaseCandidateSource(runtime.root);
    return { source, snapshot: await source.snapshotId() };
  }
  return undefined;
}

export async function sharedSourceFor(runtime: Runtime): Promise<SharedCandidateSource | undefined> {
  return (await sharedViewFor(runtime))?.source;
}

export function sendJson(res: ApiResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

export function sendError(res: ApiResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? {} } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: { code: 'internal', message, details: {} } });
}

export async function readJson(req: ApiRequest): Promise<Record<string, unknown>> {
  if (INTERNAL_BODY in req) return req[INTERNAL_BODY];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'bad_request', '请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApiError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request', '请求体不是合法 JSON');
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function guardFrom(body: Record<string, unknown>): ConcurrencyGuard {
  const expectedRevision = numberField(body, 'expectedRevision');
  const expectedOwner = stringField(body, 'expectedOwner');
  const expectedUpdatedAt = stringField(body, 'expectedUpdatedAt');
  if (expectedRevision <= 0 || !expectedOwner) {
    throw new ApiError(400, 'bad_request', '缺少并发校验信息（expectedRevision / expectedOwner）');
  }
  if (!expectedUpdatedAt || Number.isNaN(new Date(expectedUpdatedAt).getTime())) {
    throw new ApiError(400, 'bad_request', '缺少或非法的并发校验信息（expectedUpdatedAt）');
  }
  return { expectedRevision, expectedOwner, expectedUpdatedAt };
}

export function selectionFrom(body: Record<string, unknown>): IssueSelection | undefined {
  const optionId = stringField(body, 'optionId').trim();
  const patchId = numberField(body, 'patchId');
  if (!optionId && patchId === 0) return undefined;
  if (!optionId || !Number.isInteger(patchId) || patchId <= 0) {
    throw new ApiError(400, 'bad_request', '必须同时提供合法的 optionId 与正整数 patchId');
  }
  return { optionId, patchId };
}

export function requireSelectionFrom(body: Record<string, unknown>): IssueSelection {
  const selection = selectionFrom(body);
  if (!selection) {
    throw new ApiError(400, 'bad_request', '必须显式指定 optionId 与 patchId');
  }
  return selection;
}

export function isAnchor(value: unknown): value is { snippet: string; before?: string; after?: string; extra?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['snippet'] === 'string' && record['snippet'].trim().length > 0
    && (record['before'] === undefined || typeof record['before'] === 'string')
    && (record['after'] === undefined || typeof record['after'] === 'string');
}

export function idFrom(url: URL): string {
  const id = url.searchParams.get('id') ?? '';
  if (!id) throw new ApiError(400, 'bad_request', '缺少问题 id');
  return id;
}

export function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

export function filterFrom(url: URL, owner: string): ReviewFilter {
  const statusParam = url.searchParams.get('statuses') ?? '';
  const statuses = statusParam
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is ReviewStatus => REVIEW_STATUSES.includes(item as ReviewStatus));
  const tag = url.searchParams.get('tag')?.trim();
  const dir = url.searchParams.get('dir')?.trim();
  const text = url.searchParams.get('text')?.trim();
  const createdAfter = url.searchParams.get('createdAfter')?.trim();
  const createdBefore = url.searchParams.get('createdBefore')?.trim();
  const filter: ReviewFilter = { owner };
  if (statuses.length > 0) filter.statuses = statuses;
  if (tag) filter.tag = tag;
  if (dir) filter.dir = dir;
  if (text) filter.text = text;
  if (createdAfter) filter.createdAfter = createdAfter;
  if (createdBefore) filter.createdBefore = createdBefore;
  return filter;
}

export class RepoLock {
  private writeLocks = new Map<string, Promise<unknown>>();
  private readonly lockContext = new AsyncLocalStorage<string>();

  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(repoRoot) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.writeLocks.set(repoRoot, next.catch(() => undefined));
    return next;
  }

  async withRepoLock<T>(url: URL, runtimeFor: (url: URL) => Promise<Runtime>, fn: () => Promise<T>): Promise<T> {
    return runtimeFor(url).then(
      (runtime) => {
        if (this.lockContext.getStore() === runtime.root) {
          throw new ApiError(500, 'internal', 'repo 锁重入：该路由已在锁定临界区内再次取锁');
        }
        return this.lockContext.run(runtime.root, () => this.withWriteLock(runtime.root, fn));
      },
      (error) => {
        if (url.searchParams.has('expectedRepoRoot')) throw error;
        return fn();
      },
    );
  }
}

export interface FixSessionOccupancy {
  root: string;
  candidateId: string;
  optionId: string;
  patchId: number;
  sessionId: string;
  owner: string;
  createdAt: string;
  state: 'creating' | 'active' | 'verifying';
}

export interface ApiHost {
  readonly deps: ApiDeps;
  currentSettings(): AppSettings;
  updateSettings(next: AppSettings): void;
  readonly jobManager: JobManager;
  readonly lastConfigErrors: readonly string[];
  readonly detectedVcsType: VcsType | null;

  runtimeFor(url: URL): Promise<Runtime>;
  ownerFor(root: string): Promise<string>;
  withWriteLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;

  readonly auditLifecycle: AuditLifecycle;
  ensureNoAuditRunning(root?: string): void;
  leaseLookup(auditId: string): AuditLeaseRecord | undefined;
  leaseTransition(auditId: string, state: 'released' | 'releasable'): Promise<void>;
  readonly auditJobFinishes: Map<string, (result?: unknown) => void>;
  readonly auditJobLeases: Map<string, string>;

  startAiFixJob(
    runtime: Runtime,
    id: string,
    guard: ConcurrencyGuard,
    selection: IssueSelection,
    intent?: 'revise' | 'rebase',
  ): Promise<JobRecord>;

  readonly fixSessionGuard: {
    activeFor(root: string): FixSessionOccupancy | undefined;
    releaseVerified(root: string, runtime: Runtime): Promise<boolean>;
  };
}
