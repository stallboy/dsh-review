/**
 * Browser half of dsh-code-review. Compiled as a classic script (module: none);
 * React is the only runtime dependency and comes from the module-loader factory.
 */

const PACKAGE_ID = 'dsh-code-review';
const NS = 'dsh-code-review';
const API_ROOT = '/dsh-code-review/api';

interface ReactLike {
  createElement(type: any, props?: any, ...children: any[]): any;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
  useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
}
interface Slots {
  inject(name: string, callback: () => void | (() => void)): void;
  register(options: Record<string, unknown>, component: (props: any) => unknown): void | (() => void);
}
interface LocaleService {
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string) => string;
}
interface ClientCtx {
  slots: Slots;
  locale: LocaleService;
  effect(callback: () => void | (() => void), label?: string): void;
  get(name: string): unknown;
}
interface Loader {
  load(spec: { id: string; factory: (require: (id: string) => any) => unknown }): void;
}

interface Settings {
  repoRoot: string; owner: string; vcsType: 'auto' | 'git' | 'svn'; baseBranch: string;
  runner: 'dsh' | 'manual' | 'external'; dshCommand: string; externalCommand: string;
  autoFixOnFailure: boolean; gateTimeoutMs: number; syncBeforeApprove: boolean;
}
interface Health {
  app: string; version: string; configured: boolean; repoRoot: string; owner: string;
  vcsType: 'git' | 'svn' | null; currentBase: string | null; diagnostics: string[];
  counts: Record<string, number>;
}
interface SettingsResponse {
  settings: Settings;
  validation: { ok: boolean; errors: string[]; vcsType: 'git' | 'svn' | null };
  suggestedOwner: string;
  runners: { value: string; label: string }[];
}
interface Stats {
  files: number; additions: number; deletions: number;
  entries: { path: string; additions: number; deletions: number; binary: boolean }[];
}
interface Comment {
  id: string; revision: number; file: string; line: number; author: string;
  content: string; status: 'unresolved' | 'partial' | 'resolved'; createdAt?: string;
}
interface QueueItem {
  id: string; title: string; owner: string; status: string; tags: string[]; ticket: string | null;
  currentRevision: number; createdAt: string; patchStats: Stats; unresolvedComments: number;
  humanJudgmentCount: number; humanJudgmentDeclared: boolean; isBaseBehind: boolean; baseRevision: string; lastFeedback: string; parseError?: string;
}
interface Queue {
  configured: boolean; items: QueueItem[]; errors: string[]; currentBase: string | null;
  counts: Record<string, number>; owner: string; me: string; repoRoot?: string;
}
interface CandidateMeta {
  schemaVersion: number; title: string; createdAt: string; owner: string; tags: string[]; status: string;
  ticket: string | null; currentRevision: number;
  revisions: { id: number; baseRevision: string; patch: string }[];
  gateChecks: string[]; comments: Comment[];
  approval: { approvedBy: string; approvedAt: string; commitRevision: string | null } | null;
}
interface Detail {
  candidate: {
    id: string; month: string; slug: string; dirPath: string; reviewPath: string; meta: CandidateMeta;
    sections: { problem: string; rootCause: string; solution: string; humanJudgment: string; evidence: string; history: string };
    humanJudgment: { label: string; text: string }[];
    humanJudgmentDeclared: boolean;
  };
  currentBase: string | null; isBaseBehind: boolean; patchText: string; patchStats: Stats; patchPaths: string[];
  comments: Comment[]; validation: string[];
  revisionStats: Record<string, { patch: string; baseRevision: string; stats: Stats | null }>;
  canAct: boolean; me: string;
}
interface DiffResult {
  mode: 'full' | 'incremental'; unifiedDiff: string; fromRevision: number | null; toRevision: number;
  fromBase: string | null; toBase: string; resolutionMode: string | null; notes: string[];
}
interface Job {
  id: string; type: string; status: 'running' | 'succeeded' | 'failed'; startedAt: string;
  finishedAt?: string; log: string[]; result?: any; error?: string;
}
interface DiffLine { kind: 'context' | 'add' | 'del' | 'meta'; oldNo: number | null; newNo: number | null; text: string }
interface DiffFile { path: string; lines: DiffLine[]; binary: boolean }

const EMPTY_STATS: Stats = { files: 0, additions: 0, deletions: 0, entries: [] };
let activeSessionId = '';

function apiUrl(path: string): string {
  const base = typeof document === 'undefined' ? '/' : document.baseURI;
  const url = new URL(`${API_ROOT}${path}`, base);
  if (activeSessionId) url.searchParams.set('sessionId', activeSessionId);
  return url.toString();
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: init?.method ?? 'GET',
    cache: 'no-store',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${String(response.status)}`);
  return payload as T;
}

function short(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 12 ? value.slice(0, 12) : value;
}
function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function statusText(status: string): string {
  return status === 'pending' ? '待审核' : status === 'changes_requested' ? '待修改' : status === 'approved' ? '已批准' : status === 'rejected' ? '已放弃' : status;
}
function statsText(stats: Stats | null | undefined): string {
  if (!stats) return '—';
  return `+${String(stats.additions)} / -${String(stats.deletions)} · ${String(stats.files)} files`;
}
function commentText(status: string): string {
  return status === 'resolved' ? '已处理' : status === 'partial' ? '部分处理' : '未处理';
}

function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let hunk = false;
  const pathOf = (raw: string): string => {
    const tab = raw.split('\t')[0] ?? '';
    const value = tab.trim();
    return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) { current = { path: header[2] ?? '', lines: [], binary: false }; files.push(current); hunk = false; continue; }
    const index = /^Index: (.+)$/.exec(raw);
    if (index) { current = { path: pathOf(index[1] ?? ''), lines: [], binary: false }; files.push(current); hunk = false; continue; }
    const minus = /^--- (.+)$/.exec(raw);
    if (minus) {
      const path = pathOf(minus[1] ?? '');
      if (path !== '/dev/null' && current === null) { current = { path, lines: [], binary: false }; files.push(current); }
      continue;
    }
    const plus = /^\+\+\+ (.+)$/.exec(raw);
    if (plus) {
      const path = pathOf(plus[1] ?? '');
      if (path !== '/dev/null' && current === null) { current = { path, lines: [], binary: false }; files.push(current); }
      else if (current && current.path.length === 0) current.path = path;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch') || raw.startsWith('Cannot display: file marked as a binary type')) { current.binary = true; current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw }); continue; }
    if (/^(index |new file |deleted file |similarity |rename )/.test(raw)) continue;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (match) { oldNo = Number(match[1] ?? 0); newNo = Number(match[2] ?? 0); hunk = true; current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw }); continue; }
    if (!hunk) continue;
    if (raw.startsWith('\\')) { current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw }); continue; }
    if (raw.startsWith('+')) { current.lines.push({ kind: 'add', oldNo: null, newNo, text: raw.slice(1) }); newNo += 1; }
    else if (raw.startsWith('-')) { current.lines.push({ kind: 'del', oldNo, newNo: null, text: raw.slice(1) }); oldNo += 1; }
    else { current.lines.push({ kind: 'context', oldNo, newNo, text: raw.slice(1) }); oldNo += 1; newNo += 1; }
  }
  return files;
}

function createPlugin(requireModule: (id: string) => any) {
  const React = requireModule('react') as ReactLike;
  const h = React.createElement;
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  const CSS = `
.dcr{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dcr-top{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dcr-top h1{margin:0;font-size:16px;font-weight:650}
.dcr-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-grow{flex:1;min-width:0}
.dcr-body{flex:1;min-height:0;overflow:auto;padding:18px}
.dcr-wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.dcr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 11px;font:inherit;cursor:pointer;line-height:18px;white-space:nowrap}
.dcr-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dcr-btn:disabled{opacity:.45;cursor:not-allowed}
.dcr-btn.p{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dcr-btn.d{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-btn.g{border-color:transparent;background:transparent}
.dcr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.dcr-card h3{margin:0 0 8px;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-secondary);letter-spacing:.2px}
.dcr-pre{white-space:pre-wrap;word-break:break-word;line-height:1.55;margin:0;font-family:inherit}
.dcr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dcr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dcr-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dcr-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcr-chip.pending,.dcr-chip.changes_requested,.dcr-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcr-chip.approved{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcr-chip.rejected{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-list{display:flex;flex-direction:column;gap:10px}
.dcr-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px;cursor:pointer}
.dcr-item:hover{border-color:var(--dsw-alias-brand-primary)}
.dcr-item h2{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.dcr-meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px}
.dcr-input,.dcr-select,.dcr-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font:inherit;min-width:0}
.dcr-textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;line-height:1.5}
.dcr-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.dcr-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcr-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dcr-checks{display:flex;gap:14px;flex-wrap:wrap;font-size:12px}
.dcr-check{display:flex;gap:6px;align-items:flex-start;font-size:12px}
.dcr-banner{border:1px solid;border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.5}
.dcr-banner.info{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.dcr-banner.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dcr-banner.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.dcr-judge{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent);border-radius:10px;padding:13px 15px}
.dcr-judge h3{color:var(--dsw-alias-state-warn-primary)}
.dcr-judge-item{display:flex;gap:10px;padding:7px 0;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,transparent)}
.dcr-judge-item:first-of-type{border-top:0}
.dcr-judge-label{font-weight:600;min-width:140px}
.dcr-diff{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dcr-diff-bar{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dcr-diff-body{max-height:620px;overflow:auto}
.dcr-file{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l1);padding:6px 10px;font-size:12px;font-weight:600}
.dcr-line{display:grid;grid-template-columns:42px 42px 16px 1fr 18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;min-height:20px}
.dcr-line:hover{background:var(--dsw-alias-bg-layer-2)}
.dcr-num{text-align:right;padding-right:6px;color:var(--dsw-alias-state-idle-primary);user-select:none}
.dcr-sign{text-align:center;color:var(--dsw-alias-label-secondary)}
.dcr-code{white-space:pre-wrap;word-break:break-all;padding-right:8px}
.dcr-line.add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dcr-line.del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.dcr-line.add .dcr-sign{color:var(--dsw-alias-state-success-primary)}
.dcr-line.del .dcr-sign{color:var(--dsw-alias-state-error-primary)}
.dcr-line.meta{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dcr-plus{opacity:0;color:var(--dsw-alias-brand-primary);cursor:pointer;font-weight:700;text-align:center}
.dcr-line:hover .dcr-plus{opacity:1}
.dcr-thread{margin:2px 10px 6px 106px;padding:7px 10px;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:0 6px 6px 0}
.dcr-thread-head{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.dcr-st-unresolved{color:var(--dsw-alias-state-error-primary)}.dcr-st-partial{color:var(--dsw-alias-state-warn-primary)}.dcr-st-resolved{color:var(--dsw-alias-state-success-primary)}
.dcr-approve{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,var(--dsw-alias-bg-layer-1))}
.dcr-approve-acks{display:flex;flex-direction:column;gap:4px;margin:8px 0 4px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dcr-approve-acks .dcr-small{margin-bottom:2px}
.dcr-approve-steps{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.dcr-step{display:flex;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dcr-step-no{flex:none;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:11px;display:flex;align-items:center;justify-content:center;font-weight:700}
.dcr-step-title{font-weight:600;font-size:12px}
.dcr-step-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.45;margin-top:2px}
.dcr-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
.dcr-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-base)}
.dcr-kpi-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.4px;text-transform:uppercase}
.dcr-kpi-value{font-size:13px;font-weight:600;margin-top:2px}
.dcr-kpi-value.warn{color:var(--dsw-alias-state-warn-primary)}
.dcr-kpi-value.ok{color:var(--dsw-alias-state-success-primary)}
.dcr-rt{max-width:78ch;line-height:1.68;font-size:13px}
.dcr-rt p{margin:0 0 9px}
.dcr-rt p:last-child{margin-bottom:0}
.dcr-rt ul,.dcr-rt ol{margin:4px 0 10px;padding-left:20px}
.dcr-rt li{margin:3px 0;padding-left:2px}
.dcr-rt strong{font-weight:650}
.dcr-rt a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.dcr-rt a:hover{text-decoration:underline}
.dcr-rt-h{font-weight:650;margin:12px 0 6px;font-size:13px}
.dcr-rt-h:first-child{margin-top:0}
.dcr-rt-h1{font-size:14px}
.dcr-rt-h2{font-size:13.5px}
.dcr-rt-h3,.dcr-rt-h4{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dcr-rt code,.dcr-inline-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 3px}
.dcr-codeblock{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:9px 10px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;margin:6px 0 10px}
.dcr-gate-item{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;margin-bottom:5px;background:var(--dsw-alias-bg-base);overflow-wrap:anywhere}
.dcr-job{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dcr-job.failed{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dcr-joblog{margin-top:8px}
.dcr-joblog summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}
.dcr-joblog[open] summary{margin-bottom:6px}
.dcr-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none;margin-bottom:6px}
.dcr-details[open] summary{margin-bottom:8px}
.dcr-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:40px 20px}
.dcr-log{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;max-height:330px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap}
.dcr-small{font-size:11.5px}.dcr-muted{color:var(--dsw-alias-label-secondary)}
.dcr-hist{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;margin-bottom:7px}
.dcr-raw{white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5}
.dcr-sep{height:1px;background:var(--dsw-alias-border-l1);margin:8px 0}
@media(max-width:760px){.dcr-grid{grid-template-columns:1fr}.dcr-line{grid-template-columns:32px 32px 14px 1fr 18px}.dcr-thread{margin-left:80px}}
`;

  /** Inline markdown-lite: bold, code spans and links; everything stays a React node. */
  function inlineNodes(text: string, keyPrefix: string): any[] {
    const nodes: any[] = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      const token = match[0];
      if (token.startsWith('**')) {
        nodes.push(h('strong', { key: `${keyPrefix}-b-${String(index)}` }, token.slice(2, -2)));
      } else if (token.startsWith('`')) {
        nodes.push(h('code', { key: `${keyPrefix}-c-${String(index)}` }, token.slice(1, -1)));
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        if (link) {
          nodes.push(h('a', { key: `${keyPrefix}-a-${String(index)}`, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
        } else {
          nodes.push(token);
        }
      }
      last = match.index + token.length;
      index += 1;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  /**
   * Review bodies are Markdown-ish. Rendering headings, lists, bold and code as
   * real blocks keeps long audit text scannable instead of one wall of `<pre>`.
   */
  function RichText(props: { text: string; className?: string }) {
    const text = (props.text || '').replace(/\r\n/g, '\n').trim();
    if (!text) return h('div', { className: 'dcr-muted dcr-small' }, '未填写');
    const blocks: any[] = [];
    const lines = text.split('\n');
    let seq = 0;
    const nextKey = (): string => `rt-${String(seq++)}`;
    const isBlockStart = (line: string): boolean =>
      /^#{1,4}\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || line.startsWith('```');
    let index = 0;
    while (index < lines.length) {
      const line = (lines[index] ?? '').trim();
      if (!line) { index += 1; continue; }
      if (line.startsWith('```')) {
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
          code.push(lines[index] ?? '');
          index += 1;
        }
        index += 1;
        blocks.push(h('pre', { key: nextKey(), className: 'dcr-codeblock' }, code.join('\n')));
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        blocks.push(h('div', { key: nextKey(), className: `dcr-rt-h dcr-rt-h${String(level)}` }, ...inlineNodes(heading[2] ?? '', nextKey())));
        index += 1;
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (index < lines.length) {
          const bullet = /^[-*]\s+(.+)$/.exec((lines[index] ?? '').trim());
          if (!bullet) break;
          let item = bullet[1] ?? '';
          index += 1;
          while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? '') && !isBlockStart((lines[index] ?? '').trim())) {
            item += ` ${(lines[index] ?? '').trim()}`;
            index += 1;
          }
          items.push(item);
        }
        blocks.push(h('ul', { key: nextKey() }, ...items.map((item, itemIndex) =>
          h('li', { key: `${String(itemIndex)}` }, ...inlineNodes(item, nextKey())))));
        continue;
      }
      if (/^\d+[.)]\s+/.test(line)) {
        const items: string[] = [];
        while (index < lines.length) {
          const ordered = /^\d+[.)]\s+(.+)$/.exec((lines[index] ?? '').trim());
          if (!ordered) break;
          items.push(ordered[1] ?? '');
          index += 1;
        }
        blocks.push(h('ol', { key: nextKey() }, ...items.map((item, itemIndex) =>
          h('li', { key: `${String(itemIndex)}` }, ...inlineNodes(item, nextKey())))));
        continue;
      }
      const paragraph: string[] = [line];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? '').trim();
        if (!next || isBlockStart(next)) break;
        paragraph.push(next);
        index += 1;
      }
      blocks.push(h('p', { key: nextKey() }, ...inlineNodes(paragraph.join(' '), nextKey())));
    }
    return h('div', { className: `dcr-rt ${props.className ?? ''}`.trim() }, ...blocks);
  }

  function App(props: { t: (key: string) => string; sessionId: string }) {
    activeSessionId = props.sessionId || '';
    const [health, setHealth] = useState<Health | null>(null);
    const [settingsResponse, setSettingsResponse] = useState<SettingsResponse | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [screen, setScreen] = useState<'loading' | 'setup' | 'queue' | 'detail' | 'settings'>('loading');
    const [queue, setQueue] = useState<Queue | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [selectedId, setSelectedId] = useState('');
    const [diff, setDiff] = useState<DiffResult | null>(null);
    const [diffMode, setDiffMode] = useState<'full' | 'incremental'>('full');
    const [diffFrom, setDiffFrom] = useState(1);
    const [diffLoading, setDiffLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [stale, setStale] = useState(false);
    const [job, setJob] = useState<Job | null>(null);
    const [panel, setPanel] = useState<'' | 'approve' | 'reject'>('');
    const [ack, setAck] = useState<Record<number, boolean>>({});
    const [general, setGeneral] = useState('');
    const [rejectReason, setRejectReason] = useState('');
    const [draft, setDraft] = useState<{ file: string; line: number; text: string } | null>(null);
    const [auditOpen, setAuditOpen] = useState(false);
    const [auditTarget, setAuditTarget] = useState('');
    const [auditNote, setAuditNote] = useState('');
    const [auditPrompt, setAuditPrompt] = useState('');
    const [auditPromptLoading, setAuditPromptLoading] = useState(false);
    const [auditLaunching, setAuditLaunching] = useState(false);
    const [auditCopied, setAuditCopied] = useState(false);
    const [auditSessionId, setAuditSessionId] = useState('');
    const [filter, setFilter] = useState({ owner: '', statuses: '', text: '', tag: '' });
    const guardRef = useRef<{ revision: number; owner: string } | null>(null);
    const diffFiles = useMemo(() => parseDiff(diff?.unifiedDiff ?? ''), [diff]);

    const refreshHealth = useCallback(async (): Promise<Health | null> => {
      try {
        const value = await api<Health>('/health');
        setHealth(value);
        return value;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    }, []);

    const loadSettings = useCallback(async (): Promise<SettingsResponse> => {
      const value = await api<SettingsResponse>('/settings');
      setSettingsResponse(value);
      setSettings(value.settings);
      return value;
    }, []);

    const loadQueue = useCallback(async (): Promise<void> => {
      setLoading(true);
      try {
        const value = await api<Queue>('/queue');
        setQueue(value);
        setFilter((prev) => ({ ...prev, owner: prev.owner || value.me }));
        setError('');
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    }, []);

    const loadDetail = useCallback(async (id: string): Promise<void> => {
      setLoading(true);
      try {
        const value = await api<Detail>(`/candidate?id=${encodeURIComponent(id)}`);
        const snapshot = guardRef.current;
        if (snapshot && (snapshot.revision !== value.candidate.meta.currentRevision || snapshot.owner !== value.candidate.meta.owner)) setStale(true);
        else if (!snapshot) guardRef.current = { revision: value.candidate.meta.currentRevision, owner: value.candidate.meta.owner };
        setDetail(value);
        setError('');
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    }, []);

    const loadDiff = useCallback(async (id: string, mode: 'full' | 'incremental', from: number): Promise<void> => {
      setDiffLoading(true);
      try {
        const query = mode === 'full' ? `?id=${encodeURIComponent(id)}&from=0` : `?id=${encodeURIComponent(id)}&from=${String(from)}`;
        setDiff(await api<DiffResult>(`/diff${query}`));
      } catch (e) {
        setDiff({ mode, unifiedDiff: '', fromRevision: null, toRevision: 0, fromBase: null, toBase: '', resolutionMode: null, notes: [e instanceof Error ? e.message : String(e)] });
      } finally { setDiffLoading(false); }
    }, []);

    useEffect(() => {
      void (async () => {
        const current = await refreshHealth();
        try { await loadSettings(); } catch { /* keep defaults */ }
        setScreen(current?.configured ? 'queue' : 'setup');
      })();
    }, [refreshHealth, loadSettings]);

    useEffect(() => {
      if (screen !== 'queue') return;
      void loadQueue();
      const timer = setInterval(() => { void loadQueue(); }, 7000);
      return () => clearInterval(timer);
    }, [screen, loadQueue]);

    useEffect(() => {
      if (!settings?.owner) return;
      setFilter((prev) => (prev.owner === '' ? { ...prev, owner: settings.owner } : prev));
    }, [settings?.owner]);

    useEffect(() => {
      if (screen !== 'detail' || !selectedId) return;
      void loadDetail(selectedId);
      const timer = setInterval(() => { void loadDetail(selectedId); }, 7000);
      return () => clearInterval(timer);
    }, [screen, selectedId, loadDetail]);

    useEffect(() => {
      if (screen !== 'detail' || !selectedId) return;
      void loadDiff(selectedId, diffMode, diffFrom);
    }, [screen, selectedId, diffMode, diffFrom, loadDiff]);

    useEffect(() => {
      setAck({});
      setGeneral('');
      setDraft(null);
      setPanel('');
    }, [detail?.candidate.id, detail?.candidate.meta.currentRevision]);

    useEffect(() => {
      if (!panel) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setPanel('');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [panel]);

    useEffect(() => {
      if (!job || job.status !== 'running') return;
      const timer = setInterval(() => {
        void (async () => {
          try {
            const value = await api<Job>(`/jobs/${encodeURIComponent(job.id)}`);
            setJob(value);
            if (value.status !== 'running') {
              setBusy(false);
              if (selectedId) {
                guardRef.current = null;
                setStale(false);
                await loadDetail(selectedId);
                await loadDiff(selectedId, diffMode, diffFrom);
              }
              await loadQueue();
              await refreshHealth();
            }
          } catch { /* transient */ }
        })();
      }, 1200);
      return () => clearInterval(timer);
    }, [job, selectedId, diffMode, diffFrom, loadDetail, loadDiff, loadQueue, refreshHealth]);

    const startJob = async (path: string, body: unknown): Promise<void> => {
      setBusy(true); setError('');
      try {
        const response = await api<{ jobId: string; job: Job }>(path, { method: 'POST', body });
        setJob(response.job);
      } catch (e) { setBusy(false); setError(e instanceof Error ? e.message : String(e)); }
    };

    const guard = (): { expectedRevision: number; expectedOwner: string } => {
      if (!detail) throw new Error('候选未加载');
      return { expectedRevision: detail.candidate.meta.currentRevision, expectedOwner: detail.candidate.meta.owner };
    };

    const afterWrite = async (): Promise<void> => {
      if (selectedId) await loadDetail(selectedId);
      await loadQueue();
    };

    const addComment = async (file: string, line: number, text: string, autoFix = false): Promise<void> => {
      if (!detail || !text.trim()) return;
      setBusy(true); setError('');
      try {
        const response = await api<{ job?: Job; autoFixError?: string }>('/comments', {
          method: 'POST',
          body: { id: detail.candidate.id, ...guard(), file, line, content: text, autoFix },
        });
        await afterWrite();
        if (response.autoFixError) {
          setError(`意见已保存，但 AI 修复未能启动：${response.autoFixError}`);
          setBusy(false);
          return;
        }
        if (response.job) {
          setJob(response.job);
          setBusy(response.job.status === 'running');
          return;
        }
        setBusy(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    };

    const setCommentStatus = async (commentId: string, status: Comment['status']): Promise<void> => {
      if (!detail) return;
      setBusy(true);
      try {
        await api('/comment-status', { method: 'POST', body: { id: detail.candidate.id, ...guard(), commentId, status } });
        await afterWrite();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    };

    const saveSettings = async (): Promise<void> => {
      if (!settings) return;
      setBusy(true); setError('');
      try {
        await api('/settings', { method: 'PUT', body: settings });
        await loadSettings();
        const current = await refreshHealth();
        setScreen(current?.configured ? 'queue' : 'setup');
        if (current?.configured) await loadQueue();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    };

    const takeover = async (): Promise<void> => {
      if (!detail) return;
      setBusy(true);
      try {
        await api('/takeover', { method: 'POST', body: { id: detail.candidate.id, ...guard(), owner: detail.me } });
        guardRef.current = null; setStale(false);
        await afterWrite();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    };

    const reject = async (): Promise<void> => {
      if (!detail || !rejectReason.trim()) return;
      setBusy(true);
      try {
        await api('/reject', { method: 'POST', body: { id: detail.candidate.id, ...guard(), reason: rejectReason } });
        setPanel(''); setRejectReason('');
        setScreen('queue'); setSelectedId(''); setDetail(null);
        await loadQueue();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    };

    const approve = (): void => {
      if (!detail) return;
      setPanel('');
      void startJob('/approve', { id: detail.candidate.id, ...guard() });
    };

    const aiFix = (): void => {
      if (!detail) return;
      void startJob('/ai-fix', { id: detail.candidate.id, ...guard() });
    };

    const toggleAudit = (): void => {
      setAuditOpen((prev) => !prev);
      setAuditPrompt('');
      setAuditCopied(false);
      setError('');
    };

    const openAudit = (): void => {
      setAuditOpen(true);
      setAuditPrompt('');
      setAuditCopied(false);
      setError('');
    };

    const fetchAuditPrompt = async (): Promise<string> => {
      const query = new URLSearchParams({ targetPath: auditTarget, note: auditNote, mode: 'session' });
      const value = await api<{ prompt: string }>(`/audit/prompt?${query.toString()}`);
      return value.prompt;
    };

    const exportAuditPrompt = async (): Promise<void> => {
      setAuditPromptLoading(true);
      setError('');
      try {
        setAuditPrompt(await fetchAuditPrompt());
        setAuditCopied(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuditPromptLoading(false);
      }
    };

    const copyAuditPrompt = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(auditPrompt);
        setAuditCopied(true);
      } catch {
        setAuditCopied(false);
        setError('复制失败，请手动选择提示词文本');
      }
    };

    const launchAuditSession = async (): Promise<void> => {
      setAuditLaunching(true);
      setError('');
      try {
        const value = await api<{ sessionId: string }>('/audit/session', {
          method: 'POST',
          body: { targetPath: auditTarget, note: auditNote },
        });
        setAuditSessionId(value.sessionId);
        setAuditOpen(false);
        setAuditPrompt('');
        setAuditCopied(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuditLaunching(false);
      }
    };

    const openCandidate = (id: string): void => {
      guardRef.current = null; setStale(false); setDetail(null); setDiff(null);
      setDiffMode('full'); setDiffFrom(1); setSelectedId(id); setScreen('detail');
    };

    const auditReady = Boolean(queue?.currentBase ?? health?.currentBase);

    const filteredItems = useMemo(() => {
      const items = queue?.items ?? [];
      const statuses = filter.statuses ? filter.statuses.split(',') : [];
      return items.filter((item) => {
        if (filter.owner && item.owner !== filter.owner) return false;
        if (statuses.length > 0 && !statuses.includes(item.status)) return false;
        if (filter.tag && !item.tags.some((tag) => tag.toLowerCase() === filter.tag.toLowerCase())) return false;
        if (filter.text) {
          const needle = filter.text.toLowerCase();
          if (!`${item.title} ${item.id} ${item.ticket ?? ''}`.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
    }, [queue, filter]);

    const renderSettings = (): any => {
      if (!settings) return h('div', { className: 'dcr-empty' }, '加载设置…');
      const update = (patch: Partial<Settings>): void => setSettings({ ...settings, ...patch });
      return h('div', { className: 'dcr-body' },
        h('div', { className: 'dcr-wrap' },
          h('div', { className: 'dcr-card' },
            h('h3', null, screen === 'setup' ? '首次配置' : '本地设置'),
            h('div', { className: 'dcr-grid' },
              h('div', { className: 'dcr-field', style: { gridColumn: '1 / -1' } },
                h('label', null, '当前会话目录（自动作为评审仓库）'),
                h('input', { className: 'dcr-input', readOnly: true, value: health?.repoRoot ?? '', placeholder: '会话没有工作目录' }),
              ),
              h('div', { className: 'dcr-field' },
                h('label', null, '审核者（owner）'),
                h('input', { className: 'dcr-input', value: settings.owner, placeholder: settingsResponse?.suggestedOwner ?? '', onChange: (e: any) => update({ owner: e.target.value }) }),
              ),
              h('div', { className: 'dcr-field' },
                h('label', null, 'VCS'),
                h('select', { className: 'dcr-select', value: settings.vcsType, onChange: (e: any) => update({ vcsType: e.target.value }) },
                  h('option', { value: 'auto' }, '自动检测'), h('option', { value: 'git' }, 'Git'), h('option', { value: 'svn' }, 'SVN')),
              ),
              h('div', { className: 'dcr-field' },
                h('label', null, 'AI 修复执行器'),
                h('select', { className: 'dcr-select', value: settings.runner, onChange: (e: any) => update({ runner: e.target.value }) },
                  ...(settingsResponse?.runners ?? [{ value: 'dsh', label: 'DSH headless（默认）' }, { value: 'manual', label: '手动修复' }, { value: 'external', label: '外部命令' }]).map((r) => h('option', { key: r.value, value: r.value }, r.label))),
              ),
              h('div', { className: 'dcr-field' },
                h('label', null, '门禁超时（秒）'),
                h('input', { className: 'dcr-input', type: 'number', value: Math.round(settings.gateTimeoutMs / 1000), onChange: (e: any) => update({ gateTimeoutMs: Math.max(60, Number(e.target.value) || 600) * 1000 }) }),
              ),
              h('div', { className: 'dcr-field' },
                h('label', null, 'DSH CLI 路径（留空自动检测）'),
                h('input', { className: 'dcr-input', value: settings.dshCommand, placeholder: '…\\\\runtime\\\\cli\\\\bin\\\\dsh.cmd', onChange: (e: any) => update({ dshCommand: e.target.value }) }),
              ),
              h('div', { className: 'dcr-field', style: { gridColumn: '1 / -1' } },
                h('label', null, '外部修复命令（prompt 从 stdin 传入）'),
                h('input', { className: 'dcr-input', value: settings.externalCommand, placeholder: 'codex exec -', onChange: (e: any) => update({ externalCommand: e.target.value }) }),
              ),
            ),
            h('div', { className: 'dcr-checks' },
              h('label', { className: 'dcr-check' }, h('input', { type: 'checkbox', checked: settings.autoFixOnFailure, onChange: (e: any) => update({ autoFixOnFailure: Boolean(e.target.checked) }) }), h('span', null, '批准失败时自动尝试 AI 修复')),
              h('label', { className: 'dcr-check' }, h('input', { type: 'checkbox', checked: settings.syncBeforeApprove, onChange: (e: any) => update({ syncBeforeApprove: Boolean(e.target.checked) }) }), h('span', null, '批准前同步最新基线')),
            ),
            h('div', { className: 'dcr-row', style: { marginTop: 12 } },
              h('button', { className: 'dcr-btn p', disabled: busy, onClick: () => { void saveSettings(); } }, busy ? '保存中…' : '保存'),
              screen === 'settings' && health?.configured ? h('button', { className: 'dcr-btn', onClick: () => setScreen('queue') }, '返回评审') : null,
            ),
            settingsResponse && !settingsResponse.validation.ok ? h('div', { className: 'dcr-banner err', style: { marginTop: 10 } }, settingsResponse.validation.errors.join('；') || '配置不完整') : null,
          ),
          h('div', { className: 'dcr-card dcr-small dcr-muted' }, '评审仓库取当前会话的工作目录（需为 Git/SVN 仓库），无需单独配置项目目录。owner 用于乐观锁与操作隔离；AI 修复默认调用本机 DSH headless profile。'),
        ),
      );
    };

    const renderQueue = (): any => h('div', { className: 'dcr-body' },
      h('div', { className: 'dcr-wrap' },
        renderJob(),
        h('div', { className: 'dcr-card' },
          h('div', { className: 'dcr-row' },
            h('input', { className: 'dcr-input', style: { width: 140 }, placeholder: '负责人', value: filter.owner, onChange: (e: any) => setFilter({ ...filter, owner: e.target.value }) }),
            h('select', { className: 'dcr-select', value: filter.statuses, onChange: (e: any) => setFilter({ ...filter, statuses: e.target.value }) },
              h('option', { value: '' }, '全部状态'), h('option', { value: 'pending' }, '待审核'), h('option', { value: 'changes_requested' }, '待修改'),
              h('option', { value: 'pending,changes_requested' }, '待处理'), h('option', { value: 'approved' }, '已批准'), h('option', { value: 'rejected' }, '已放弃')),
            h('input', { className: 'dcr-input', style: { flex: 1, minWidth: 170 }, placeholder: '搜索标题 / ticket / 目录', value: filter.text, onChange: (e: any) => setFilter({ ...filter, text: e.target.value }) }),
            h('input', { className: 'dcr-input', style: { width: 110 }, placeholder: 'tag', value: filter.tag, onChange: (e: any) => setFilter({ ...filter, tag: e.target.value }) }),
            h('button', { className: 'dcr-btn', disabled: loading, onClick: () => { void loadQueue(); } }, loading ? '加载中…' : '刷新'),
            h('button', { className: 'dcr-btn p', disabled: busy, onClick: toggleAudit }, auditOpen ? '收起审查' : '审查仓库'),
          ),
          h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 8 } }, `当前基线 ${short(queue?.currentBase)} · 共 ${String(filteredItems.length)} 项`),
        ),
        auditOpen ? h('div', { className: 'dcr-card' },
          h('h3', null, '在新会话中审查当前仓库'),
          h('div', { className: 'dcr-small dcr-muted', style: { marginBottom: 10 } },
            '点击“启动审查会话”会新建一个 DSH 会话并在侧边栏显示；审查过程以对话形式流式展示，你可以随时切到其他会话，不会用弹窗遮挡当前页面。'),
          !auditReady ? h('div', { className: 'dcr-banner warn', style: { marginBottom: 10 } }, '当前仓库还没有基线提交（Git HEAD / SVN revision）。请先完成一次提交，再启动审查会话。') : null,
          h('div', { className: 'dcr-field' },
            h('label', null, '审查范围（留空 = 全仓库）'),
            h('input', { className: 'dcr-input', value: auditTarget, placeholder: '例如 src/ 或 packages/core/', onChange: (e: any) => setAuditTarget(e.target.value) }),
          ),
          h('div', { className: 'dcr-field' },
            h('label', null, '补充关注点（可选）'),
            h('textarea', { className: 'dcr-textarea', value: auditNote, placeholder: '例如：重点关注并发关闭竞态与资源泄漏；不要修改公开 API。', onChange: (e: any) => setAuditNote(e.target.value) }),
          ),
          h('div', { className: 'dcr-row' },
            h('button', { className: 'dcr-btn p', disabled: busy || auditLaunching || auditPromptLoading || !auditReady, onClick: () => { void launchAuditSession(); } }, auditLaunching ? '正在创建会话…' : '启动审查会话'),
            h('button', { className: 'dcr-btn', disabled: auditPromptLoading || !auditReady, onClick: () => { void exportAuditPrompt(); } }, auditPromptLoading ? '生成中…' : '导出提示词'),
            h('button', { className: 'dcr-btn g', onClick: () => setAuditOpen(false) }, '取消'),
            h('span', { className: 'dcr-grow' }),
            h('span', { className: 'dcr-small dcr-muted' }, `基线 ${short(queue?.currentBase ?? health?.currentBase)} · 使用当前 DSH 会话模型`),
          ),
          auditSessionId ? h('div', { className: 'dcr-banner info', style: { marginTop: 10 } }, `审查会话已创建（${short(auditSessionId)}）。请在侧边栏打开「仓库审查 · ${auditTarget.trim() || '全仓库'}」查看实时过程；当前页面不会被遮挡。`) : null,
          auditPrompt ? h('div', { className: 'dcr-field', style: { marginTop: 10 } },
            h('div', { className: 'dcr-row' },
              h('label', { className: 'dcr-grow' }, '审查提示词（可复制到任意外部 Agent）'),
              h('button', { className: 'dcr-btn', onClick: () => { void copyAuditPrompt(); } }, auditCopied ? '已复制' : '复制'),
            ),
            h('textarea', { className: 'dcr-textarea', style: { minHeight: 220 }, readOnly: true, value: auditPrompt }),
          ) : null,
        ) : null,
        error ? h('div', { className: 'dcr-banner err' }, error) : null,
        filteredItems.length === 0 ? h('div', { className: 'dcr-empty' },
          h('div', null, queue?.items.length === 0 ? '队列为空：仓库 .ai-review 中还没有候选修复。' : '没有符合筛选条件的候选。'),
          queue?.items.length === 0 ? h('div', { style: { marginTop: 12 } },
            h('button', { className: 'dcr-btn p', disabled: busy, onClick: openAudit }, '审查当前仓库并生成候选'),
          ) : null,
        ) :
          h('div', { className: 'dcr-list' }, ...filteredItems.map((item) => h('div', { key: item.id, className: 'dcr-item', onClick: () => openCandidate(item.id) },
            h('div', { className: 'dcr-row', style: { alignItems: 'flex-start' } },
              h('div', { className: 'dcr-grow' },
                h('h2', null, item.title),
                h('div', { className: 'dcr-meta' },
                  h('span', { className: `dcr-chip ${item.status}` }, statusText(item.status)),
                  h('span', null, `rev ${String(item.currentRevision)}`),
                  h('span', null, item.ticket ? `#${item.ticket}` : '无 ticket'),
                  h('span', null, `owner ${item.owner}`),
                  h('span', null, statsText(item.patchStats)),
                  item.isBaseBehind ? h('span', { className: 'dcr-chip warn' }, `基线落后 ${short(item.baseRevision)}`) : h('span', { className: 'dcr-chip approved' }, '基线最新'),
                  item.humanJudgmentCount > 0
                    ? h('span', { className: 'dcr-chip warn' }, `${String(item.humanJudgmentCount)} 项需人工判断`)
                    : item.humanJudgmentDeclared
                      ? h('span', { className: 'dcr-chip approved' }, '无需人工判断')
                      : h('span', { className: 'dcr-chip warn' }, '人工判断项未填写'),
                  item.unresolvedComments > 0 ? h('span', { className: 'dcr-chip warn' }, `${String(item.unresolvedComments)} 条未处理意见`) : null,
                  ...item.tags.map((tag) => h('span', { key: tag, className: 'dcr-chip' }, tag)),
                ),
                item.lastFeedback ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 6 } }, `最近意见：${item.lastFeedback}`) : null,
                item.parseError ? h('div', { className: 'dcr-small', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 } }, item.parseError) : null,
              ),
            ),
          ))),
        h('div', { className: 'dcr-small dcr-muted', style: { textAlign: 'center' } }, '仅当前 owner 可操作；其他人只读，可先“接管审核”。'),
      ),
    );

    const renderDetail = (): any => {
      if (!detail) return h('div', { className: 'dcr-body' }, error ? h('div', { className: 'dcr-banner err' }, error) : h('div', { className: 'dcr-empty' }, '加载候选…'));
      const candidate = detail.candidate;
      const canAct = detail.canAct && !stale && candidate.meta.status !== 'approved' && candidate.meta.status !== 'rejected';
      const items = candidate.humanJudgment;
      const ackCount = items.filter((_, index) => ack[index]).length;
      const allAck = items.length === 0 || ackCount === items.length;
      const files = diffFiles;
      const baseRevision = candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision)?.baseRevision ?? '';
      const steps = [
        { title: '同步基线', desc: settings?.syncBeforeApprove ? '先 pull --ff-only / svn update；失败即中止。' : '按当前基线验证，不自动同步远端。' },
        { title: '应用补丁', desc: `严格应用 rev ${String(candidate.meta.currentRevision)} 的 ${candidate.meta.revisions.find((revision) => revision.id === candidate.meta.currentRevision)?.patch ?? '补丁'}。` },
        { title: '执行门禁', desc: `${String(candidate.meta.gateChecks.length)} 条命令逐条执行，任一失败即回滚。` },
        { title: '原子提交', desc: '业务代码、review.md 状态与补丁清理进入同一个提交。' },
      ];
      const approvalPanel = (): any => h('div', { className: 'dcr-card dcr-approve' },
        h('div', { className: 'dcr-row' },
          h('h3', { className: 'dcr-grow', style: { margin: 0 } }, '确认批准并提交'),
          h('button', { className: 'dcr-btn g', onClick: () => setPanel('') }, '取消'),
        ),
        h('div', { className: 'dcr-approve-steps' },
          ...steps.map((step, index) => h('div', { key: index, className: 'dcr-step' },
            h('div', { className: 'dcr-step-no' }, String(index + 1)),
            h('div', null,
              h('div', { className: 'dcr-step-title' }, step.title),
              h('div', { className: 'dcr-step-desc' }, step.desc),
            ),
          )),
        ),
        h('div', { className: `dcr-banner ${items.length === 0 || allAck ? 'info' : 'warn'}` },
          items.length === 0
            ? (candidate.humanJudgmentDeclared ? 'AI 已确认无需额外人工判断，可直接批准。' : 'AI 未填写需人工判断项，批准前请先补全。')
            : allAck
              ? `已确认全部 ${String(items.length)} 项需人工判断点。`
              : `还有 ${String(items.length - ackCount)} 项需人工判断项未确认；请先在上方逐项勾选。`,
        ),
        items.length > 0 ? h('div', { className: 'dcr-approve-acks' },
          h('div', { className: 'dcr-small dcr-muted' }, '逐项确认（与下方“需人工判断项”同步）：'),
          ...items.map((item, index) => h('label', { key: index, className: 'dcr-check' },
            h('input', { type: 'checkbox', checked: Boolean(ack[index]), onChange: (e: any) => setAck({ ...ack, [index]: Boolean(e.target.checked) }) }),
            h('span', null, item.label),
          )),
        ) : null,
        h('details', { className: 'dcr-details', open: true, style: { marginTop: 10 } },
          h('summary', null, `合并门禁（${String(candidate.meta.gateChecks.length)} 条）`),
          candidate.meta.gateChecks.length === 0
            ? h('div', { className: 'dcr-banner warn' }, '门禁为空，无法批准；请让 AI 修复补全 gate_checks。')
            : h('div', null, ...candidate.meta.gateChecks.map((command, index) => h('div', { key: index, className: 'dcr-gate-item dcr-mono dcr-small' }, command))),
        ),
        h('div', { className: 'dcr-row', style: { marginTop: 12 } },
          h('button', { className: 'dcr-btn p', disabled: busy || !allAck || candidate.meta.gateChecks.length === 0, onClick: approve }, busy ? '执行中…' : '确认批准并提交'),
          h('button', { className: 'dcr-btn', onClick: () => setPanel('') }, '再想想'),
          h('span', { className: 'dcr-grow' }),
          h('span', { className: 'dcr-small dcr-muted' }, settings?.syncBeforeApprove ? '批准前自动同步基线' : '不自动同步基线'),
        ),
        h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 8 } }, '批准过程在页内显示实时日志，不弹窗、不锁定其他页面。'),
      );
      const rejectPanel = (): any => h('div', { className: 'dcr-card' },
        h('div', { className: 'dcr-row' },
          h('h3', { className: 'dcr-grow', style: { margin: 0 } }, '放弃候选'),
          h('button', { className: 'dcr-btn g', onClick: () => setPanel('') }, '取消'),
        ),
        h('div', { className: 'dcr-banner warn', style: { marginTop: 8 } }, '放弃会删除所有过程补丁并提交 .ai-review 变更，仅保留 review.md 归档。'),
        h('textarea', { className: 'dcr-textarea', autoFocus: true, placeholder: '放弃原因（必填）', value: rejectReason, onChange: (e: any) => setRejectReason(e.target.value) }),
        h('div', { className: 'dcr-row', style: { marginTop: 8 } },
          h('button', { className: 'dcr-btn d', disabled: busy || !rejectReason.trim(), onClick: () => { void reject(); } }, busy ? '执行中…' : '确认放弃'),
          h('button', { className: 'dcr-btn', onClick: () => setPanel('') }, '取消'),
        ),
      );
      return h('div', { className: 'dcr-body' },
        h('div', { className: 'dcr-wrap' },
          renderJob(),
          stale ? h('div', { className: 'dcr-banner err' }, '该候选已在其他窗口更新（版本或 owner 变化），当前页面已锁定，请刷新后重新审核。') : null,
          detail.isBaseBehind ? h('div', { className: 'dcr-banner warn' }, `仓库基线 ${short(detail.currentBase)} 已不同于候选基线 ${short(baseRevision)}；批准时会先同步再严格应用补丁。`) : null,
          h('div', { className: 'dcr-card' },
            h('div', { className: 'dcr-row', style: { alignItems: 'flex-start' } },
              h('div', { className: 'dcr-grow' },
                h('h2', { style: { margin: '0 0 7px', fontSize: 18 } }, candidate.meta.title),
                h('div', { className: 'dcr-meta' },
                  h('span', { className: `dcr-chip ${candidate.meta.status}` }, statusText(candidate.meta.status)),
                  h('span', null, `rev ${String(candidate.meta.currentRevision)}`),
                  h('span', null, candidate.meta.ticket ? `#${candidate.meta.ticket}` : '无 ticket'),
                  h('span', null, `owner ${candidate.meta.owner}`),
                  h('span', null, `创建 ${dateText(candidate.meta.createdAt)}`),
                  ...candidate.meta.tags.map((tag) => h('span', { key: tag, className: 'dcr-chip' }, tag)),
                ),
                h('div', { className: 'dcr-small dcr-muted dcr-mono', style: { marginTop: 6 } }, candidate.id),
                candidate.meta.approval ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 4 } }, `批准：${candidate.meta.approval.approvedBy} · ${dateText(candidate.meta.approval.approvedAt)} · commit ${short(candidate.meta.approval.commitRevision)}`) : null,
              ),
              h('div', { className: 'dcr-row' },
                !detail.canAct ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => { void takeover(); } }, '接管审核') : null,
                canAct ? h('button', { className: 'dcr-btn', disabled: busy, title: '不新增意见，直接读取未解决意见并生成下一版', onClick: aiFix }, 'AI 再修一版') : null,
                canAct ? h('button', { className: 'dcr-btn d', disabled: busy, onClick: () => setPanel(panel === 'reject' ? '' : 'reject') }, panel === 'reject' ? '收起放弃' : '放弃') : null,
                canAct ? h('button', {
                  className: 'dcr-btn p',
                  disabled: busy || detail.validation.length > 0,
                  title: detail.validation.length > 0 ? detail.validation.join('；') : !allAck ? '打开审批面板，逐项确认人工判断项' : '确认批准并提交',
                  onClick: () => setPanel(panel === 'approve' ? '' : 'approve'),
                }, panel === 'approve' ? '收起审批' : '批准并提交') : null,
              ),
            ),
            h('div', { className: 'dcr-kpis' },
              h('div', { className: 'dcr-kpi' },
                h('div', { className: 'dcr-kpi-label' }, '基线'),
                h('div', { className: `dcr-kpi-value ${detail.isBaseBehind ? 'warn' : 'ok'}` }, detail.isBaseBehind ? `落后 ${short(baseRevision)}` : '最新'),
              ),
              h('div', { className: 'dcr-kpi' },
                h('div', { className: 'dcr-kpi-label' }, '人工确认'),
                h('div', { className: `dcr-kpi-value ${items.length > 0 && !allAck ? 'warn' : !candidate.humanJudgmentDeclared ? 'warn' : 'ok'}` },
                  items.length > 0 ? `${String(ackCount)}/${String(items.length)}` : candidate.humanJudgmentDeclared ? '无需' : '未填写'),
              ),
              h('div', { className: 'dcr-kpi' },
                h('div', { className: 'dcr-kpi-label' }, '门禁'),
                h('div', { className: `dcr-kpi-value ${candidate.meta.gateChecks.length > 0 ? 'ok' : 'warn'}` }, `${String(candidate.meta.gateChecks.length)} 条`),
              ),
              h('div', { className: 'dcr-kpi' },
                h('div', { className: 'dcr-kpi-label' }, '补丁'),
                h('div', { className: 'dcr-kpi-value' }, statsText(detail.patchStats)),
              ),
            ),
            !detail.canAct ? h('div', { className: 'dcr-banner info', style: { marginTop: 10 } }, `当前负责人为 ${candidate.meta.owner}，您处于只读模式；需要操作请先“接管审核”。`) : null,
            detail.validation.length > 0 ? h('div', { className: 'dcr-banner err', style: { marginTop: 10 } }, `评审数据不完整：${detail.validation.join('；')}`) : null,
          ),
          panel === 'approve' ? approvalPanel() : null,
          panel === 'reject' ? rejectPanel() : null,
          items.length === 0
            ? (candidate.humanJudgmentDeclared
                ? null
                : h('div', { className: 'dcr-banner warn' }, 'AI 未填写需人工判断项；批准前请让 AI 修复或在 review.md 中补全该章节。'))
            : h('div', { className: 'dcr-judge' },
                h('h3', null, `需人工判断项 · ${String(ackCount)}/${String(items.length)} 已确认`),
                ...items.map((item, index) => h('div', { key: index, className: 'dcr-judge-item' },
                  h('div', { className: 'dcr-grow' },
                    h('div', { className: 'dcr-judge-label' }, item.label),
                    h(RichText, { text: item.text, className: 'dcr-small' }),
                  ),
                  h('label', { className: 'dcr-check' }, h('input', { type: 'checkbox', checked: Boolean(ack[index]), disabled: !canAct, onChange: (e: any) => setAck({ ...ack, [index]: Boolean(e.target.checked) }) }), h('span', null, '已审阅')),
                )),
              ),
          h('div', { className: 'dcr-card' }, h('h3', null, '问题与影响'), h(RichText, { text: candidate.sections.problem })),
          h('div', { className: 'dcr-card' }, h('h3', null, '根因'), h(RichText, { text: candidate.sections.rootCause })),
          h('div', { className: 'dcr-card' }, h('h3', null, '当前修复方案'), h(RichText, { text: candidate.sections.solution })),
          h('div', { className: 'dcr-card' },
            h('h3', null, '合并门禁与验证证据'),
            candidate.meta.gateChecks.length === 0
              ? h('div', { className: 'dcr-banner warn' }, '尚未定义 gate_checks。')
              : h('div', null, ...candidate.meta.gateChecks.map((command, index) => h('div', { key: index, className: 'dcr-gate-item dcr-mono dcr-small' }, command))),
            h('div', { className: 'dcr-small dcr-muted' }, '点击批准即代表确认并在本机执行以上命令；任一失败会阻止合并。'),
            candidate.sections.evidence
              ? h('details', { className: 'dcr-details', style: { marginTop: 8 } },
                  h('summary', null, '验证证据'),
                  h(RichText, { text: candidate.sections.evidence }),
                )
              : null,
          ),
          h('div', { className: 'dcr-card' },
            h('h3', null, '总体意见'),
            h('div', { className: 'dcr-small dcr-muted', style: { marginBottom: 6 } },
              '提交后默认立即让 AI 读取这条意见和所有未解决的行内意见，生成下一版；也可以只提交意见，稍后再点顶部「让 AI 修复」。'),
            h('textarea', { className: 'dcr-textarea', value: general, disabled: !canAct, placeholder: canAct ? '写给 AI/作者的整体意见…' : '仅 owner 可提交意见', onChange: (e: any) => setGeneral(e.target.value) }),
            h('div', { className: 'dcr-row', style: { marginTop: 8 } },
              h('button', {
                className: 'dcr-btn p',
                disabled: !canAct || busy || !general.trim(),
                onClick: () => { const value = general; setGeneral(''); void addComment('', 0, value, true); },
              }, busy ? '执行中…' : '提交意见并让 AI 修复'),
              h('button', {
                className: 'dcr-btn',
                disabled: !canAct || busy || !general.trim(),
                onClick: () => { const value = general; setGeneral(''); void addComment('', 0, value, false); },
              }, '仅提交意见'),
              h('span', { className: 'dcr-grow' }),
              h('span', { className: 'dcr-small dcr-muted' }, '提交后状态变为“待修改”，并写入仓库 review.md。'),
            ),
          ),
          h('div', { className: 'dcr-diff' },
            h('div', { className: 'dcr-diff-bar' },
              h('strong', null, '代码差异'),
              h('button', { className: `dcr-btn ${diffMode === 'full' ? 'p' : ''}`, onClick: () => setDiffMode('full') }, '完整差异'),
              candidate.meta.currentRevision >= 2 ? h('button', { className: `dcr-btn ${diffMode === 'incremental' ? 'p' : ''}`, onClick: () => { setDiffFrom(Math.max(1, candidate.meta.currentRevision - 1)); setDiffMode('incremental'); } }, '版本增量') : null,
              diffMode === 'incremental' ? h('select', { className: 'dcr-select', value: String(diffFrom), onChange: (e: any) => setDiffFrom(Number(e.target.value)) },
                ...candidate.meta.revisions.filter((r) => r.id < candidate.meta.currentRevision).map((r) => h('option', { key: r.id, value: String(r.id) }, `rev ${String(r.id)}`)),
              ) : null,
              diffMode === 'incremental' ? h('span', { className: 'dcr-small dcr-muted' }, `→ rev ${String(candidate.meta.currentRevision)}`) : null,
              h('span', { className: 'dcr-grow' }),
              diffLoading ? h('span', { className: 'dcr-small dcr-muted' }, '加载差异…') : null,
            ),
            diff?.notes?.length ? h('div', { className: 'dcr-banner info', style: { margin: 8 } }, diff.notes.join(' ')) : null,
            diff?.resolutionMode === 'cross_base_hunk_fallback' || /^# 跨基线 Hunk 对比/m.test(diff?.unifiedDiff ?? '') ?
              h('div', { style: { padding: 10 } },
                h('div', { className: 'dcr-banner warn', style: { marginBottom: 8 } }, '跨基线且旧补丁无法三方应用：当前为 Hunk 级近似对比，不代表逐行真实 diff。'),
                h('pre', { className: 'dcr-raw' }, diff?.unifiedDiff || '（无差异）'),
              ) :
              h('div', { className: 'dcr-diff-body' }, ...files.map((file) => h('div', { key: file.path },
                h('div', { className: 'dcr-file' }, file.path),
                ...file.lines.map((line, index) => {
                  const lineNo = line.newNo ?? line.oldNo;
                  const comments = lineNo === null ? [] : detail.comments.filter((c) => c.file === file.path && c.line === lineNo);
                  return h('div', { key: `${file.path}-${String(index)}` },
                    h('div', { className: `dcr-line ${line.kind}` },
                      h('span', { className: 'dcr-num' }, line.oldNo === null ? '' : String(line.oldNo)),
                      h('span', { className: 'dcr-num' }, line.newNo === null ? '' : String(line.newNo)),
                      h('span', { className: 'dcr-sign' }, line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''),
                      h('span', { className: 'dcr-code' }, line.text),
                      canAct && line.newNo !== null && line.kind !== 'meta' ? h('span', { className: 'dcr-plus', title: '添加行内意见', onClick: () => setDraft({ file: file.path, line: line.newNo ?? 0, text: '' }) }, '+') : null,
                    ),
                    ...comments.map((comment) => h('div', { key: comment.id, className: 'dcr-thread' },
                      h('div', { className: 'dcr-thread-head' },
                        h('span', null, comment.author),
                        h('span', null, `rev ${String(comment.revision)}`),
                        h('span', { className: comment.status === 'resolved' ? 'dcr-st-resolved' : comment.status === 'partial' ? 'dcr-st-partial' : 'dcr-st-unresolved' }, commentText(comment.status)),
                        h('span', { className: 'dcr-grow' }),
                        canAct ? h('select', { className: 'dcr-select', style: { padding: '0 3px', fontSize: 11 }, value: comment.status, onChange: (e: any) => { void setCommentStatus(comment.id, e.target.value); } },
                          h('option', { value: 'unresolved' }, '未处理'), h('option', { value: 'partial' }, '部分处理'), h('option', { value: 'resolved' }, '已处理')) : null,
                      ),
                      h(RichText, { text: comment.content }),
                    )),
                  );
                }),
              ))),
            draft ? h('div', { style: { padding: '0 10px 10px' } },
              h('div', { className: 'dcr-card' },
                h('h3', null, `行内意见 ${draft.file}:${String(draft.line)}`),
                h('textarea', { className: 'dcr-textarea', autoFocus: true, value: draft.text, onChange: (e: any) => setDraft({ ...draft, text: e.target.value }) }),
                h('div', { className: 'dcr-row', style: { marginTop: 8 } },
                  h('button', { className: 'dcr-btn p', disabled: !draft.text.trim(), onClick: () => { const value = draft.text; setDraft(null); void addComment(draft.file, draft.line, value); } }, '提交行内意见'),
                  h('button', { className: 'dcr-btn', onClick: () => setDraft(null) }, '取消'),
                ),
              ),
            ) : null,
          ),
          h('div', { className: 'dcr-card' },
            h('h3', null, '评论与历史'),
            detail.comments.length === 0 ? h('div', { className: 'dcr-muted dcr-small' }, '暂无评论') :
              h('div', null, ...detail.comments.map((comment) => h('div', { key: comment.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 7, marginTop: 7 } },
                h('div', { className: 'dcr-row dcr-small' },
                  h('strong', null, comment.author),
                  comment.file ? h('span', { className: 'dcr-mono' }, `${comment.file}:${String(comment.line)}`) : h('span', null, '总体'),
                  h('span', { className: comment.status === 'resolved' ? 'dcr-st-resolved' : comment.status === 'partial' ? 'dcr-st-partial' : 'dcr-st-unresolved' }, commentText(comment.status)),
                  h('span', { className: 'dcr-grow' }),
                  canAct ? h('select', { className: 'dcr-select', style: { padding: '0 3px', fontSize: 11 }, value: comment.status, onChange: (e: any) => { void setCommentStatus(comment.id, e.target.value); } },
                    h('option', { value: 'unresolved' }, '未处理'), h('option', { value: 'partial' }, '部分处理'), h('option', { value: 'resolved' }, '已处理')) : null,
                ),
                h(RichText, { text: comment.content, className: 'dcr-small' }),
              ))),
            h('div', { className: 'dcr-sep' }),
            ...candidate.meta.revisions.map((revision) => h('div', { key: revision.id, className: 'dcr-hist' },
              h('div', { className: 'dcr-row' },
                h('strong', null, `rev ${String(revision.id)}`),
                h('span', { className: 'dcr-small dcr-muted' }, `base ${short(revision.baseRevision)}`),
                h('span', { className: 'dcr-small' }, statsText(detail.revisionStats[String(revision.id)]?.stats ?? EMPTY_STATS)),
                h('span', { className: 'dcr-grow' }),
                h('button', { className: 'dcr-btn g', onClick: () => { setDiffMode('incremental'); setDiffFrom(revision.id); } }, '查看增量'),
              ),
              h('div', { className: 'dcr-small dcr-mono dcr-muted' }, revision.patch),
            )),
            candidate.sections.history
              ? h('details', { className: 'dcr-details', style: { marginTop: 8 } },
                  h('summary', null, '版本审核记录'),
                  h(RichText, { text: candidate.sections.history }),
                )
              : null,
          ),
          h('div', { style: { height: 8 } }),
        ),
      );
    };

    const renderJob = (): any => {
      if (!job) return null;
      const result = job.result;
      const running = job.status === 'running';
      const failed = job.status === 'failed';
      const lastLine = job.log.length > 0 ? job.log[job.log.length - 1] : '等待输出…';
      return h('div', { className: `dcr-card dcr-job ${failed ? 'failed' : ''}` },
        h('div', { className: 'dcr-row' },
          h('strong', null, job.type === 'approve' ? '批准与验证' : 'AI 修复'),
          h('span', { className: `dcr-chip ${job.status === 'succeeded' ? 'approved' : failed ? 'rejected' : 'pending'}` }, running ? '执行中' : job.status === 'succeeded' ? '完成' : '失败'),
          h('span', { className: 'dcr-small dcr-muted' }, dateText(job.startedAt)),
          h('span', { className: 'dcr-grow' }),
          !running ? h('button', { className: 'dcr-btn g', onClick: () => setJob(null) }, '关闭') : null,
        ),
        running ? h('div', { className: 'dcr-small dcr-muted dcr-mono', style: { marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lastLine) : null,
        job.error ? h('div', { className: 'dcr-banner err', style: { marginTop: 8 } }, job.error) : null,
        result?.message ? h('div', { className: `dcr-banner ${result?.success === false ? 'err' : 'info'}`, style: { marginTop: 8 } }, result.message) : null,
        result?.commitRevision ? h('div', { className: 'dcr-small dcr-mono dcr-muted', style: { marginTop: 6 } }, `commit ${short(result.commitRevision)}`) : null,
        h('details', { className: 'dcr-joblog', open: running ? true : undefined },
          h('summary', null, `${running ? '实时日志' : '运行日志'}（${String(job.log.length)} 行）`),
          h('div', { className: 'dcr-log' }, job.log.length ? job.log.join('\n') : '等待输出…'),
        ),
        result?.prompt ? h('details', { className: 'dcr-joblog' },
          h('summary', null, '修复提示词'),
          h('textarea', { className: 'dcr-textarea', style: { minHeight: 180, marginTop: 6 }, readOnly: true, value: result.prompt }),
        ) : null,
      );
    };

    let content: any;
    if (screen === 'loading') content = h('div', { className: 'dcr-empty' }, '加载评审…');
    else if (screen === 'setup' || screen === 'settings') content = renderSettings();
    else if (screen === 'queue') content = renderQueue();
    else content = renderDetail();

    return h('div', { className: 'dcr' },
      h('div', { className: 'dcr-top' },
        h('div', { className: 'dcr-grow' },
          h('div', { className: 'dcr-row' },
            h('h1', null, '评审'),
            h('span', { className: 'dcr-chip' }, `${String((health?.counts.pending ?? 0) + (health?.counts.changes_requested ?? 0))} 个候选待处理`),
            health?.vcsType ? h('span', { className: 'dcr-chip' }, health.vcsType.toUpperCase()) : null,
            health?.currentBase ? h('span', { className: 'dcr-chip dcr-mono' }, short(health.currentBase)) : null,
          ),
          h('div', { className: 'dcr-sub' }, `${health?.repoRoot || '会话没有工作目录'} · 审核者 ${health?.owner || settings?.owner || '未设置'}`),
        ),
        screen === 'detail' ? h('button', { className: 'dcr-btn g', onClick: () => setScreen('queue') }, '← 队列') : null,
        h('button', { className: 'dcr-btn', onClick: () => { void refreshHealth(); if (screen === 'queue') void loadQueue(); if (screen === 'detail' && selectedId) void loadDetail(selectedId); } }, '刷新'),
        h('button', { className: 'dcr-btn', onClick: () => { void (async () => { try { await loadSettings(); } finally { setScreen('settings'); } })(); } }, '设置'),
      ),
      content,
    );
  }

  return {
    inject: ['slots', 'locale'],
    apply(ctx: ClientCtx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: { nav: '评审' },
        en: { nav: 'Review' },
        ja: { nav: 'レビュー' },
      }), 'dsh-code-review: dictionaries');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-code-review', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-code-review: styles');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('conversation.view', () => {
        const off = ctx.slots.register(
          { name: 'conversation.view', id: 'code-review', order: 40, label: () => t('nav'), locale: NS, inject: () => ({ t }) },
          (props: any) => h(App, {
            t,
            sessionId: typeof props?.sessionId === 'string' ? props.sessionId : '',
          }),
        );
        return typeof off === 'function' ? off : undefined;
      });
    },
  };
}

const loader = (window as unknown as { __ModuleLoader__: Loader }).__ModuleLoader__;
loader.load({ id: PACKAGE_ID, factory: createPlugin });
