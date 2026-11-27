import { parseUnifiedDiff, safeExternalHref } from '@dsh-review/protocol';
import { API_ROOT, createApi, dateText, short } from './api.js';
import type { DetailViewComponent } from './detail-view.js';
import type { DiffDraft } from './diff-view.js';
import type { QueueFilterState, QueueViewComponent } from './queue-view.js';
import type { SettingsViewComponent } from './settings-view.js';
import {
  detailReducer,
  EMPTY_DETAIL_STATE,
  type Detail,
  type DiffResult,
  type Health,
  type IssueFindingView,
  type Job,
  type Queue,
  type ReactLike,
  type ReviewComment,
  type ReviewDataFileValidation,
  type Settings,
  type SettingsResponse,
} from './types.js';

export function createApp(
  React: ReactLike,
  SettingsView: SettingsViewComponent,
  QueueView: QueueViewComponent,
  DetailView: DetailViewComponent,
): (props: { onRepoChange: () => void }) => unknown {
  const h = React.createElement;
  const { useState, useEffect, useMemo, useRef, useCallback, useReducer } = React;
  const useLayoutEffect = React.useLayoutEffect ?? useEffect;
  const auditJobsByRepo = new Map<string, string>();

  return function App({ onRepoChange }: { onRepoChange: () => void }) {
    const boundRepoRoot = useRef<string | null>(null);
    const api = useMemo(() => createApi(API_ROOT, undefined, () => boundRepoRoot.current), []);
    useEffect(() => () => api.dispose(), [api]);

    const [health, setHealth] = useState<Health | null>(null);
    const [settingsResponse, setSettingsResponse] = useState<SettingsResponse | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [screen, setScreen] = useState<'loading' | 'setup' | 'queue' | 'detail' | 'settings'>('loading');
    const [queue, setQueue] = useState<Queue | null>(null);
    const [findings, setFindings] = useState<IssueFindingView[]>([]);
    const [findingErrors, setFindingErrors] = useState<string[]>([]);
    const [diff, setDiff] = useState<DiffResult | null>(null);
    const [diffMode, setDiffMode] = useState<'full' | 'incremental'>('full');
    const [diffFrom, setDiffFrom] = useState(1);
    const [diffLoading, setDiffLoading] = useState(false);
    const [diffLayout, setDiffLayout] = useState<'auto' | 'split' | 'unified'>('auto');
    const [diffWidth, setDiffWidth] = useState<number | null>(null);
    const diffCardRef = useRef<unknown>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [detailState, dispatchDetail] = useReducer(detailReducer, EMPTY_DETAIL_STATE);
    const { detail, stale } = detailState;
    const selectedId = detailState.id;
    const [job, setJob] = useState<Job | null>(null);
    const [panel, setPanel] = useState<'' | 'approve'>('');
    const [selectedIssue, setSelectedIssue] = useState<{ id: string; optionId: string; patchId: number } | null>(null);
    const detailFetch = useRef(0);
    const [ack, setAck] = useState<Record<string, boolean>>({});
    const [waiveReason, setWaiveReason] = useState<Record<string, string>>({});
    const jobLogOffsetRef = useRef<number | null>(null);
    const jobLogRef = useRef<string[]>([]);
    const [general, setGeneral] = useState('');
    const [fixTarget, setFixTarget] = useState<'session' | 'export'>('session');
    const [fixLaunching, setFixLaunching] = useState(false);
    const [fixSession, setFixSession] = useState<{ sessionId: string; title: string; revision: number } | null>(null);
    const [fixPrompt, setFixPrompt] = useState<{ text: string; revision: number } | null>(null);
    const [fixPromptLoading, setFixPromptLoading] = useState(false);
    const [fixCopied, setFixCopied] = useState(false);
    const [commitDetail, setCommitDetail] = useState<'simple' | 'detailed'>('detailed');
    const [batchDrafts, setBatchDrafts] = useState<string[]>([]);
    const [draft, setDraft] = useState<DiffDraft | null>(null);
    const [auditOpen, setAuditOpen] = useState(false);
    const [auditTarget, setAuditTarget] = useState('');
    const [auditNote, setAuditNote] = useState('');
    const [auditExtra, setAuditExtra] = useState('');
    const [auditPrompt, setAuditPrompt] = useState('');
    const [auditPromptLoading, setAuditPromptLoading] = useState(false);
    const [auditLaunching, setAuditLaunching] = useState(false);
    const [auditCopied, setAuditCopied] = useState(false);
    const [auditSessionId, setAuditSessionId] = useState('');
    const [auditLeaseId, setAuditLeaseId] = useState('');
    const [releaseArmed, setReleaseArmed] = useState(false);
    const [finalizeArmed, setFinalizeArmed] = useState(false);
    const ownerInitializedRef = useRef(false);
    const [filter, setFilterState] = useState<QueueFilterState>({
      owner: '',
      statuses: '',
      text: '',
      tag: '',
      dir: '',
      createdAfter: '',
      createdBefore: '',
    });

    const setFilter = useCallback((next: QueueFilterState): void => {
      ownerInitializedRef.current = true;
      setFilterState(next);
    }, []);

    const diffFiles = useMemo(() => parseUnifiedDiff(diff?.unifiedDiff ?? ''), [diff]);

    // 宿主布局会改变面板宽度；测量不带滚动条的差异卡片可避免布局反复切换。
    useLayoutEffect(() => {
      const element = diffCardRef.current as { clientWidth?: number } | null;
      if (!element) { setDiffWidth(null); return; }
      const update = (): void => { setDiffWidth(element.clientWidth ?? 0); };
      update();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(update);
      observer.observe(element as unknown as Element);
      return () => { observer.disconnect(); };
    }, [screen, selectedId, detail?.candidate.id, diffFiles, diffMode, diffFrom]);

    const refreshHealth = useCallback(async (): Promise<Health | null> => {
      try {
        const value = await api.get<Health>('/health');
        if (boundRepoRoot.current !== null && value.repoRoot !== boundRepoRoot.current) {
          onRepoChange();
          return null;
        }
        boundRepoRoot.current = value.repoRoot;
        setHealth(value);
        return value;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    }, [api, onRepoChange]);

    const loadSettings = useCallback(async (): Promise<SettingsResponse> => {
      const value = await api.get<SettingsResponse>('/settings');
      setSettingsResponse(value);
      setSettings(value.settings);
      return value;
    }, [api]);

    const loadQueue = useCallback(async (): Promise<void> => {
      setLoading(true);
      try {
        const query = new URLSearchParams();
        // 初始化后显式携带 owner 参数（含空字符串表示“全部”），避免清空负责人后被服务端默认回填为 me。
        if (ownerInitializedRef.current || filter.owner !== '') {
          query.set('owner', filter.owner);
        }
        for (const key of ['statuses', 'tag', 'dir', 'text'] as const) {
          if (filter[key]) query.set(key, filter[key]);
        }
        if (filter.createdAfter) query.set('createdAfter', new Date(filter.createdAfter).toISOString());
        if (filter.createdBefore) query.set('createdBefore', new Date(filter.createdBefore).toISOString());
        const value = await api.get<Queue>(`/queue${query.size > 0 ? `?${query.toString()}` : ''}`);
        setQueue(value);
        if (value.configured) {
          const { findings: latest, errors } = await api.get<{ findings: IssueFindingView[]; errors: string[] }>('/findings');
          setFindings(latest);
          setFindingErrors(errors);
        } else {
          setFindings([]);
          setFindingErrors([]);
        }
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, [api, filter]);

    const loadDetail = useCallback(async (
      id: string,
      overrideSelection?: { optionId: string; patchId: number } | null,
    ): Promise<void> => {
      setLoading(true);
      try {
        const requestId = ++detailFetch.current;
        const activeSelection = overrideSelection !== undefined
          ? overrideSelection
          : (selectedIssue?.id === id ? selectedIssue : null);
        const selected = activeSelection
          ? `&optionId=${encodeURIComponent(activeSelection.optionId)}&patchId=${String(activeSelection.patchId)}`
          : '';
        const value = await api.get<Detail>(`/candidate?id=${encodeURIComponent(id)}${selected}`);
        if (requestId !== detailFetch.current) return;
        dispatchDetail({ type: 'loaded', detail: value });
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, [api, selectedIssue]);

    const reloadCurrent = (): void => {
      if (!selectedId) return;
      dispatchDetail({ type: 'rebind' });
      void loadDetail(selectedId);
    };

    const loadDiff = useCallback(async (
      id: string,
      mode: 'full' | 'incremental',
      from: number,
      overrideSelection?: { optionId: string; patchId: number } | null,
    ): Promise<void> => {
      setDiffLoading(true);
      try {
        const activeSelection = overrideSelection !== undefined
          ? overrideSelection
          : (selectedIssue?.id === id ? selectedIssue : null);
        const params = new URLSearchParams({ id, from: mode === 'full' ? '0' : String(from) });
        if (activeSelection) {
          params.set('optionId', activeSelection.optionId);
          params.set('patchId', String(activeSelection.patchId));
        }
        setDiff(await api.get<DiffResult>(`/diff?${params.toString()}`));
      } catch (e) {
        setDiff({
          mode,
          unifiedDiff: '',
          fromRevision: null,
          toRevision: 0,
          fromBase: null,
          toBase: '',
          resolutionMode: null,
          notes: [e instanceof Error ? e.message : String(e)],
        });
      } finally {
        setDiffLoading(false);
      }
    }, [api, selectedIssue]);

    useEffect(() => {
      void (async () => {
        const current = await refreshHealth();
        try { await loadSettings(); } catch { /* 健康检查已足以决定打开哪个页面。 */ }
        const auditJobId = current?.configured ? auditJobsByRepo.get(current.repoRoot) : undefined;
        if (auditJobId) {
          try {
            const restored = await api.get<Job>(`/jobs/${encodeURIComponent(auditJobId)}`);
            setJob(restored);
            setBusy(restored.status === 'running');
          } catch { /* 回到队列后仍可使用租约入口。 */ }
        }
        setScreen(current?.configured ? 'queue' : 'setup');
      })();
    }, [api, refreshHealth, loadSettings]);

    useEffect(() => {
      if (screen !== 'queue') return;
      void loadQueue();
      const timer = setInterval(() => { void loadQueue(); }, 7000);
      return () => clearInterval(timer);
    }, [screen, loadQueue]);

    useEffect(() => {
      if (!settings?.owner || ownerInitializedRef.current) return;
      ownerInitializedRef.current = true;
      setFilterState((prev) => (prev.owner === '' ? { ...prev, owner: settings.owner } : prev));
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
      setWaiveReason({});
      setBatchDrafts([]);
      setGeneral('');
      setDraft(null);
      setPanel('');
      // 修复会话和提示词绑定候选版本，换版后继续使用可能修到旧补丁。
      setFixSession(null);
      setFixPrompt(null);
      setFixCopied(false);
    }, [detail?.candidate.id, detail?.candidate.meta.recordRevision]);

    useEffect(() => {
      if (!panel) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setPanel('');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [panel]);

    // 将最新回调与视图上下文保存在 ref，防止每次日志更新重建 1.2s 定时器。
    const pollContextRef = useRef({
      selectedId,
      selectedIssue,
      diffMode,
      diffFrom,
      loadDetail,
      loadDiff,
      loadQueue,
      refreshHealth,
    });
    pollContextRef.current = {
      selectedId,
      selectedIssue,
      diffMode,
      diffFrom,
      loadDetail,
      loadDiff,
      loadQueue,
      refreshHealth,
    };

    const jobId = job?.id ?? '';
    const jobStatus = job?.status ?? '';
    useEffect(() => {
      if (!jobId || jobStatus !== 'running') return;
      let active = true;
      const timer = setInterval(() => {
        void (async () => {
          try {
            // 服务端截断日志后绝对偏移仍递增，必须按绝对 offset 增量拉取并处理 reset。
            const since = jobLogOffsetRef.current;
            const value = await api.get<Job & { logOffset?: number; logResetRequired?: boolean }>(
              `/jobs/${encodeURIComponent(jobId)}${since === null ? '' : `?since=${String(since)}`}`,
            );
            if (!active) return;
            if (since === null || value.logResetRequired) {
              jobLogRef.current = [...(value.log ?? [])];
            } else {
              jobLogRef.current = [...jobLogRef.current, ...(value.log ?? [])];
            }
            jobLogOffsetRef.current = value.logOffset ?? jobLogRef.current.length;
            setJob({ ...value, log: [...jobLogRef.current] });
            if (value.status !== 'running') {
              setBusy(false);
              const ctx = pollContextRef.current;
              if (ctx.selectedId) {
                let nextSelection: { optionId: string; patchId: number } | null | undefined;
                if (
                  value.type === 'ai_fix'
                  || (value.type === 'approve' && value.result?.status === 'FALLBACK_TO_PENDING' && value.result?.reason === 'MATERIAL_CHANGE')
                ) {
                  if (typeof value.result?.newPatchId === 'number') {
                    const optionId = value.result.optionId ?? ctx.selectedIssue?.optionId ?? '';
                    nextSelection = optionId ? { optionId, patchId: value.result.newPatchId } : null;
                  } else {
                    // 清除旧 patchId 固定选择，让详情自动回落到最新补丁。
                    nextSelection = null;
                  }
                  setSelectedIssue(nextSelection ? { id: ctx.selectedId, ...nextSelection } : null);
                }
                dispatchDetail({ type: 'rebind' });
                await ctx.loadDetail(ctx.selectedId, nextSelection);
                await ctx.loadDiff(ctx.selectedId, ctx.diffMode, ctx.diffFrom, nextSelection);
              }
              await ctx.loadQueue();
              await ctx.refreshHealth();
            }
          } catch { /* 保留轮询，容忍短暂读取失败。 */ }
        })();
      }, 1200);
      return () => { active = false; clearInterval(timer); };
    }, [api, jobId, jobStatus]);

    const startJob = async (path: string, body: unknown): Promise<void> => {
      setBusy(true); setError('');
      try {
        jobLogRef.current = [];
        jobLogOffsetRef.current = null;
        const payload = typeof body === 'object' && body !== null && ['/approve', '/ai-fix', '/rebase'].includes(path)
          ? { ...(body as Record<string, unknown>), ...(detail?.selection ?? {}) }
          : body;
        const response = await api.post<{ jobId: string; job: Job }>(path, payload);
        setJob(response.job);
      } catch (e) {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    const guard = (): { expectedRevision: number; expectedOwner: string; expectedUpdatedAt: string } => {
      if (!detail) throw new Error('问题未加载');
      return {
        expectedRevision: detail.candidate.meta.recordRevision,
        expectedOwner: detail.candidate.meta.owner,
        expectedUpdatedAt: detail.candidate.meta.updatedAt,
      };
    };

    const rebaseCandidate = async (): Promise<void> => {
      if (!detail) return;
      await startJob('/rebase', { id: detail.candidate.id, ...guard(), ...(detail.selection ?? {}) });
    };

    const afterWrite = async (): Promise<void> => {
      if (selectedId) await loadDetail(selectedId);
      await loadQueue();
    };

    const addComment = async (
      file: string,
      line: number,
      text: string,
      autoFix = false,
      side: 'LEFT' | 'RIGHT' = 'RIGHT',
      anchor?: { snippet: string; before?: string; after?: string },
    ): Promise<boolean> => {
      if (!detail || !text.trim()) return false;
      const isInline = file !== '' && line !== 0;
      setBusy(true); setError('');
      try {
        const response = await api.post<{ job?: Job; autoFixError?: string }>('/comments', {
          id: detail.candidate.id,
          ...guard(),
          ...(isInline || autoFix ? (detail.selection ?? {}) : {}),
          file,
          line,
          content: text,
          autoFix,
          ...(isInline ? { side } : {}),
          ...(isInline && anchor ? { anchor } : {}),
        });
        dispatchDetail({ type: 'rebind' });
        await afterWrite();
        if (response.autoFixError) {
          setError(`意见已保存，但 AI 修复未能启动：${response.autoFixError}`);
          setBusy(false);
          return true;
        }
        if (response.job) {
          jobLogRef.current = [];
          jobLogOffsetRef.current = null;
          setJob(response.job);
          setBusy(response.job.status === 'running');
          return true;
        }
        setBusy(false);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return false;
      }
    };

    const submitBatch = async (drafts: string[]): Promise<boolean> => {
      if (!detail || drafts.length === 0) return false;
      setBusy(true); setError('');
      try {
        const response = await api.post<{ job?: Job; autoFixError?: string }>('/comments/batch', {
          id: detail.candidate.id,
          ...guard(),
          comments: drafts.map((content) => ({ content })),
          autoFix: false,
        });
        dispatchDetail({ type: 'rebind' });
        await afterWrite();
        if (response.autoFixError) {
          setError(`意见已保存，但 AI 修复未能启动：${response.autoFixError}`);
          setBusy(false);
          return true;
        }
        if (response.job) {
          jobLogRef.current = [];
          jobLogOffsetRef.current = null;
          setJob(response.job);
          setBusy(response.job.status === 'running');
          return true;
        }
        setBusy(false);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return false;
      }
    };

    const setCommentStatus = async (commentId: string, status: ReviewComment['status']): Promise<void> => {
      if (!detail) return;
      setBusy(true);
      try {
        await api.post('/comment-status', { id: detail.candidate.id, ...guard(), commentId, status });
        dispatchDetail({ type: 'rebind' });
        await afterWrite();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const saveSettings = async (): Promise<void> => {
      if (!settings) return;
      setBusy(true); setError('');
      try {
        const repoRoot = settings.repoRoot.trim();
        await api.put('/settings', { ...settings, repoRoot });
        if (repoRoot !== settingsResponse?.settings.repoRoot) {
          onRepoChange();
          return;
        }
        await loadSettings();
        const current = await refreshHealth();
        setScreen(current?.configured ? 'queue' : 'setup');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const takeover = async (): Promise<void> => {
      if (!detail) return;
      setBusy(true);
      try {
        await api.post('/takeover', { id: detail.candidate.id, ...guard(), owner: detail.me });
        dispatchDetail({ type: 'rebind' });
        await afterWrite();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const approve = (): void => {
      if (!detail || !detail.selection) return;
      setPanel('');
      const decisions = detail.candidate.meta.humanDecisions ?? [];
      const confirmedDecisions = decisions.filter((item) => ack[item.id]).map((item) => item.id);
      const waivedDecisions = decisions
        .filter((item) => !ack[item.id] && (waiveReason[item.id] ?? '').trim().length > 0)
        .map((item) => ({ id: item.id, reason: (waiveReason[item.id] ?? '').trim() }));
      void startJob('/approve', {
        id: detail.candidate.id,
        ...guard(),
        ...detail.selection,
        confirmedDecisions,
        waivedDecisions,
        commitDetail,
      });
    };

    const initReviewers = async (): Promise<void> => {
      setBusy(true); setError('');
      try {
        await api.post('/reviewers/init', { defaultOwner: settings?.owner || health?.owner || undefined });
        await refreshHealth();
        await loadQueue();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const launchFixSession = async (
      overrideGuard?: { expectedRevision: number; expectedOwner: string; expectedUpdatedAt: string },
    ): Promise<void> => {
      if (!detail || !detail.selection) return;
      setFixLaunching(true); setError('');
      try {
        const value = await api.post<{ sessionId: string; title: string; revision: number }>('/fix-session', {
          id: detail.candidate.id,
          ...(overrideGuard ?? guard()),
          ...detail.selection,
        });
        setFixSession({ sessionId: value.sessionId, title: value.title, revision: value.revision });
        setFixPrompt(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setFixLaunching(false);
      }
    };

    const exportFixPrompt = async (overrideRevision?: number): Promise<void> => {
      if (!detail || !detail.selection) return;
      setFixPromptLoading(true); setError('');
      try {
        const query = new URLSearchParams({
          id: detail.candidate.id,
          mode: 'session',
          optionId: detail.selection.optionId,
          patchId: String(detail.selection.patchId),
        });
        const value = await api.get<{ prompt: string }>(`/fix-prompt?${query.toString()}`);
        setFixPrompt({ text: value.prompt, revision: overrideRevision ?? detail.candidate.meta.recordRevision });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setFixPromptLoading(false);
      }
    };

    /** 先保存并刷新意见，并用写回的最新并发守卫启动修复会话或导出提示词，避免旧闭包 guard 导致 409。 */
    const submitFeedbackAndFix = async (drafts: string[]): Promise<boolean> => {
      if (!detail || drafts.length === 0) return false;
      setBusy(true); setError('');
      let nextGuard: { expectedRevision: number; expectedOwner: string; expectedUpdatedAt: string } | undefined;
      try {
        const res = drafts.length > 1
          ? await api.post<{ candidate?: { meta: { recordRevision: number; owner: string; updatedAt: string } } }>('/comments/batch', {
              id: detail.candidate.id,
              ...guard(),
              comments: drafts.map((content) => ({ content })),
              autoFix: false,
            })
          : await api.post<{ candidate?: { meta: { recordRevision: number; owner: string; updatedAt: string } } }>('/comments', {
              id: detail.candidate.id,
              ...guard(),
              content: drafts[0],
              autoFix: false,
            });
        if (res?.candidate?.meta) {
          nextGuard = {
            expectedRevision: res.candidate.meta.recordRevision,
            expectedOwner: res.candidate.meta.owner,
            expectedUpdatedAt: res.candidate.meta.updatedAt,
          };
        }
        dispatchDetail({ type: 'rebind' });
        await afterWrite();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return false;
      }
      setBusy(false);
      setFixCopied(false);
      if (fixTarget === 'session') await launchFixSession(nextGuard);
      else await exportFixPrompt(nextGuard?.expectedRevision);
      return true;
    };

    const copyFixPrompt = async (): Promise<void> => {
      if (!fixPrompt) return;
      try {
        await navigator.clipboard.writeText(fixPrompt.text);
        setFixCopied(true);
      } catch {
        setFixCopied(false);
        setError('复制失败，请手动选择提示词文本');
      }
    };

    const resumeCandidate = async (): Promise<void> => {
      if (!detail) return;
      setBusy(true); setError('');
      try {
        await api.post('/resume', { id: detail.candidate.id, ...guard() });
        dispatchDetail({ type: 'rebind' });
        setAck({}); setWaiveReason({});
        if (selectedId) await loadDetail(selectedId);
        await loadQueue();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
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
      const query = new URLSearchParams({
        targetPath: auditTarget,
        note: auditNote,
        mode: 'session',
        focus: JSON.stringify(auditNote.trim() ? [auditNote.trim()] : []),
        extraRequirements: JSON.stringify(auditExtra.split(/\r?\n/).map((text) => text.trim()).filter(Boolean)),
      });
      const value = await api.get<{ prompt: string }>(`/audit/prompt?${query.toString()}`);
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
        const value = await api.post<{ sessionId: string; auditId: string; job: Job }>('/audit/session', {
          targetPath: auditTarget,
          note: auditNote,
          focus: auditNote.trim() ? [auditNote.trim()] : [],
          extraRequirements: auditExtra.split(/\r?\n/).map((text) => text.trim()).filter(Boolean),
        });
        setAuditSessionId(value.sessionId);
        setAuditLeaseId(value.auditId);
        jobLogRef.current = [];
        jobLogOffsetRef.current = null;
        if (health?.repoRoot) auditJobsByRepo.set(health.repoRoot, value.job.id);
        setJob(value.job);
        setBusy(value.job.status === 'running');
        setAuditOpen(false);
        setAuditPrompt('');
        setAuditCopied(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuditLaunching(false);
      }
    };

    const startManualAudit = async (): Promise<void> => {
      setAuditLaunching(true);
      setError('');
      try {
        const value = await api.post<{ auditId: string; prompt: string; job: Job }>('/audit/manual', {
          targetPath: auditTarget,
          note: auditNote,
        });
        setAuditLeaseId(value.auditId);
        setAuditPrompt(value.prompt);
        setAuditCopied(false);
        jobLogRef.current = [];
        jobLogOffsetRef.current = null;
        setJob(value.job);
        setBusy(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuditLaunching(false);
      }
    };

    /** 释放将解除共享写入占用，需再次确认外部执行已停止。 */
    const releaseAuditLease = async (): Promise<void> => {
      const leaseId = queue?.auditLease?.auditId ?? auditLeaseId;
      if (!leaseId) return;
      if (!releaseArmed) { setReleaseArmed(true); return; }
      setBusy(true);
      try {
        await api.post('/audit/release', {
          auditId: leaseId,
          confirmStopped: true,
          ...(queue?.auditLease?.commitOutcomeUnknown ? { confirmCommitChecked: true } : {}),
        });
        setAuditLeaseId('');
        setReleaseArmed(false);
        setJob(null);
        await loadQueue();
        await refreshHealth();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const runWrite = async (path: string, body: unknown): Promise<void> => {
      setBusy(true);
      setError('');
      try {
        await api.post(path, body);
        dispatchDetail({ type: 'rebind' });
        await loadQueue();
        if (selectedId) await loadDetail(selectedId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const openCandidate = (id: string, selection?: { optionId: string; patchId: number }): void => {
      detailFetch.current++;
      setSelectedIssue(selection ? { id, ...selection } : null);
      setPanel('');
      setAck({});
      setWaiveReason({});
      dispatchDetail({ type: 'open', id });
      setDiff(null);
      setDiffMode('full');
      setDiffFrom(1);
      setScreen('detail');
    };

    const auditReady = Boolean(queue?.currentBase ?? health?.currentBase);
    useEffect(() => { setReleaseArmed(false); setFinalizeArmed(false); }, [queue?.auditLease?.auditId, queue?.auditLease?.state]);

    /** 活跃租约要求二次确认，降低审查仍在写候选时误触收尾的风险。 */
    const finalizeAuditLease = (): void => {
      const info = queue?.auditLease;
      if (!info) return;
      if (info.state === 'active' && !finalizeArmed) { setFinalizeArmed(true); return; }
      setReleaseArmed(false);
      setFinalizeArmed(false);
      void startJob('/audit/finalize', { auditId: info.auditId });
    };

    const releaseFixSessionOccupancy = async (): Promise<void> => {
      setBusy(true); setError('');
      try {
        await api.post('/fix-session/release', { confirmStopped: true });
        await loadQueue();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const renderLeaseBanner = (): unknown => {
      const info = queue?.auditLease;
      const fixOcc = queue?.fixSession;
      if (!info && !fixOcc) return null;
      if (!info && fixOcc) {
        return h('div', { className: 'dcr-card' },
          h('div', { className: 'dcr-row' },
            h('div', { className: 'dcr-grow' },
              h('h3', { style: { margin: 0 } }, '提案修订会话占用工作副本'),
              h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 4 } },
                `${fixOcc.candidateId}（${fixOcc.optionId} / patch #${String(fixOcc.patchId)}）· 会话 ${short(fixOcc.sessionId)} · 始于 ${dateText(fixOcc.createdAt)}`),
            ),
            h('button', {
              className: 'dcr-btn',
              disabled: busy,
              onClick: () => { void releaseFixSessionOccupancy(); },
            }, '确认停止并释放占用'),
          ),
          h('div', { className: 'dcr-banner warn', style: { marginTop: 8 } },
            '交互式 Mode B 提案会话正在占用工作副本（阻塞其他共享写与审查）。完成后请回详情页收尾提交，或确认会话已停止后点击释放占用（Host 将核验停止并还原非 .ai-review/ 改动）。'),
        );
      }
      if (!info) return null;
      const active = info.state === 'active' && !info.commitOutcomeUnknown;
      return h('div', { className: 'dcr-card' },
        h('div', { className: 'dcr-row' },
          h('div', { className: 'dcr-grow' },
            h('h3', { style: { margin: 0 } }, info.commitOutcomeUnknown ? '审查提交待核验'
              : active ? '仓库审查执行中（待收尾）' : '审查待处理：执行租约等待确认'),
            h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 4 } },
              `${info.auditId} · 始于 ${dateText(info.createdAt)} · 基线 ${short(info.baseRevision)}${info.sessionId ? ` · 审查会话 ${short(info.sessionId)}` : ''}`),
          ),
          info.commitOutcomeUnknown ? null : h('button',
            {
              className: 'dcr-btn p',
              disabled: busy,
              onClick: finalizeAuditLease,
              ...(active ? { title: '审查会话可能仍在执行：再次点击确认收尾' } : {}),
            },
            active
              ? (finalizeArmed ? '确认收尾（审查仍在执行）' : '收尾并提交候选')
              : '收尾并提交候选'),
          active ? null : h('button', { className: 'dcr-btn', disabled: busy, onClick: () => { void releaseAuditLease(); } },
            info.commitOutcomeUnknown
              ? (releaseArmed ? '再次确认已核验并释放' : '确认已核验并释放')
              : (releaseArmed ? '确认释放（不提交）' : '释放租约')),
        ),
        h('div', { className: `dcr-banner ${active ? 'info' : 'warn'}`, style: { marginTop: 8 } },
          info.commitOutcomeUnknown
            ? '请核对版本历史和本轮评审文件，确认提交结果且外部执行已停止后，再释放租约。'
            : active
              ? 'Host 确认审查会话结束后会自动收尾。若未自动启动，请先确认会话已结束，再手动收尾。收尾前共享写保持互斥。'
              : '执行租约仍在阻塞共享写（approve / AI 修复 / rebase / sync 均被拒绝）。若审查会话已完成并产出候选，「收尾并提交候选」会校验并提交它们；确认外部执行已停止且不需要提交时，才释放租约（本地候选保持未提交状态）。'),
      );
    };

    const renderJob = (): unknown => {
      if (!job) return null;
      const result = job.result;
      const validation: ReviewDataFileValidation[] = job.type === 'audit' && Array.isArray(result?.dataValidation)
        ? result.dataValidation
        : [];
      const running = job.status === 'running';
      const failed = job.status === 'failed';
      const lastLine = job.log.length > 0 ? job.log[job.log.length - 1] : '等待输出…';
      // 业务结果（如 ABORTED / REPAIR_FAILED / RECOVERY_REQUIRED）可能伴随 succeeded 态的 Job 返回。
      const outcome = typeof result?.status === 'string' ? result.status : null;
      const outcomeText: Record<string, string> = {
        COMMITTED: '业务提交成功',
        REPAIR_FAILED: '修复失败，已还原',
        FALLBACK_TO_PENDING: '退回待审核',
        ABORTED: '已中止',
        RECOVERY_REQUIRED: '需人工恢复',
        MANUAL_REQUIRED: '需手动执行',
        VALIDATION_FAILED: '校验未全部通过',
      };
      const outcomeChip = outcome === 'COMMITTED' ? 'approved' : outcome && outcome !== 'MANUAL_REQUIRED' ? 'rejected' : 'pending';
      const outcomeIsErr = outcome !== null && outcome !== 'COMMITTED' && outcome !== 'MANUAL_REQUIRED';
      // ApprovalOutcome 使用 manualPrompt，而 AiFixOutcome.MANUAL_REQUIRED 与 AuditOutcome 使用 prompt。
      const promptText = result?.manualPrompt || result?.prompt || '';

      return h('div', { className: `dcr-card dcr-job ${failed || outcomeIsErr ? 'failed' : ''}` },
        h('div', { className: 'dcr-row' },
          h('strong', null, job.type === 'approve' ? '批准与验证' : job.type === 'audit' ? '仓库审查' : 'AI 修复'),
          h('span', { className: `dcr-chip ${running ? 'pending' : outcome ? outcomeChip : job.status === 'succeeded' ? 'approved' : failed ? 'rejected' : 'pending'}` },
            running ? '执行中' : outcome ? (outcomeText[outcome] ?? outcome) : job.status === 'succeeded' ? '完成' : '失败'),
          h('span', { className: 'dcr-small dcr-muted' }, dateText(job.startedAt)),
          h('span', { className: 'dcr-grow' }),
          running ? h('button', {
            className: 'dcr-btn d',
            onClick: () => {
              void api.post<{ job: Job }>(`/jobs/${encodeURIComponent(job.id)}/cancel`, {})
                .then((value) => setJob(value.job))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            },
          }, '取消任务') : null,
          !running ? h('button', {
            className: 'dcr-btn g',
            onClick: () => {
              if (health?.repoRoot && auditJobsByRepo.get(health.repoRoot) === job.id) auditJobsByRepo.delete(health.repoRoot);
              setJob(null);
            },
          }, '关闭') : null,
        ),
        running ? h('div', { className: 'dcr-small dcr-muted dcr-mono', style: { marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lastLine) : null,
        job.error ? h('div', { className: 'dcr-banner err', style: { marginTop: 8 } }, job.error) : null,
        result?.reason ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 6 } }, `reason：${String(result.reason)}`) : null,
        result?.message ? h('div', { className: `dcr-banner ${outcomeIsErr ? 'err' : 'info'}`, style: { marginTop: 8 } }, result.message) : null,
        validation.length > 0 ? h('div', { className: 'dcr-banner ' + (validation.some((file) => file.errors.length > 0) ? 'err' : 'info'), style: { marginTop: 8 } },
          h('strong', null, `评审文件校验 · ${String(validation.filter((file) => file.errors.length === 0).length)}/${String(validation.length)} 个文件通过`),
          ...validation.filter((file) => file.errors.length > 0).map((file) => h('div', { key: file.path, style: { marginTop: 8 } },
            h('code', { style: { overflowWrap: 'anywhere' } }, file.path),
            h('ul', null, ...file.errors.map((err, index) => h('li', {
              key: index,
              style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
            }, err))),
          )),
        ) : null,
        result?.commitRevision ? h('div', { className: 'dcr-small dcr-mono dcr-muted', style: { marginTop: 6 } }, `commit ${short(result.commitRevision)}`) : null,
        h('details', { className: 'dcr-joblog', open: running ? true : undefined },
          h('summary', null, `${running ? '实时日志' : '运行日志'}（${String(job.log.length)} 行）`),
          h('div', { className: 'dcr-log' }, job.log.length ? job.log.join('\n') : '等待输出…'),
        ),
        promptText ? h('details', { className: 'dcr-joblog' },
          h('summary', null, '修复提示词'),
          h('textarea', { className: 'dcr-textarea', style: { minHeight: 180, marginTop: 6 }, readOnly: true, value: String(promptText) }),
        ) : null,
      );
    };

    if (health?.managed) {
      const safeCenterUrl = safeExternalHref(health.managed.centerUrl);
      return h('div', { className: 'dcr' },
        h('h1', null, '此节点已接入中央工作台'),
        h('p', null, '项目、审查结果和任务由中央服务统一管理。'),
        safeCenterUrl
          ? h('a', { className: 'dcr-btn p', href: safeCenterUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开中央工作台')
          : h('p', { className: 'dcr-muted' }, '中央地址格式无效。'),
      );
    }

    let content: unknown;
    if (screen === 'loading') {
      content = h('div', { className: 'dcr-empty' }, '加载评审…');
    } else if (screen === 'setup' || screen === 'settings') {
      content = h(SettingsView, {
        screen,
        settings,
        setSettings,
        settingsResponse,
        health,
        busy,
        onSave: saveSettings,
        onInitReviewers: initReviewers,
        onBack: () => setScreen('queue'),
      });
    } else if (screen === 'queue') {
      content = h(QueueView, {
        health,
        queue,
        findings,
        findingErrors,
        filter,
        setFilter,
        defaultOwner: settings?.owner || health?.owner || '',
        loading,
        busy,
        error,
        auditOpen,
        auditReady,
        auditTarget,
        setAuditTarget,
        auditNote,
        setAuditNote,
        auditExtra,
        setAuditExtra,
        auditPrompt,
        auditPromptLoading,
        auditLaunching,
        auditCopied,
        auditSessionId,
        auditLeaseId,
        releaseArmed,
        renderJob,
        renderLeaseBanner,
        onRefresh: () => { void loadQueue(); },
        onInitReviewers: () => { void initReviewers(); },
        onToggleAudit: toggleAudit,
        onOpenAudit: openAudit,
        onCloseAudit: () => setAuditOpen(false),
        onLaunchAuditSession: () => { void launchAuditSession(); },
        onExportAuditPrompt: () => { void exportAuditPrompt(); },
        onCopyAuditPrompt: () => { void copyAuditPrompt(); },
        onStartManualAudit: () => { void startManualAudit(); },
        onFinalizeAudit: (auditId: string) => { void startJob('/audit/finalize', { auditId }); },
        onReleaseAuditLease: () => { void releaseAuditLease(); },
        onOpenCandidate: openCandidate,
        onSaveFindingDecision: (body: Record<string, unknown>) => { void runWrite('/finding/decision', body); },
      });
    } else {
      content = h(DetailView, {
        detail,
        stale,
        error,
        busy,
        settings,
        panel,
        setPanel,
        ack,
        setAck,
        waiveReason,
        setWaiveReason,
        commitDetail,
        setCommitDetail,
        general,
        setGeneral,
        batchDrafts,
        setBatchDrafts,
        fixTarget,
        setFixTarget,
        fixLaunching,
        fixSession,
        fixPrompt,
        fixPromptLoading,
        fixCopied,
        diff,
        diffFiles,
        diffMode,
        setDiffMode,
        diffFrom,
        setDiffFrom,
        diffLayout,
        setDiffLayout,
        diffWidth,
        diffLoading,
        diffCardRef,
        draft,
        setDraft,
        renderJob,
        onReloadCurrent: reloadCurrent,
        onTakeover: takeover,
        onResumeCandidate: resumeCandidate,
        onApprove: approve,
        onRebase: rebaseCandidate,
        onFinalizeCandidate: () => {
          if (!detail) return;
          void startJob('/candidate/finalize', { id: detail.candidate.id, ...guard(), ...(detail.selection ?? {}) });
        },
        onAddComment: addComment,
        onSubmitBatch: submitBatch,
        onSubmitFeedbackAndFix: submitFeedbackAndFix,
        onSetCommentStatus: setCommentStatus,
        onCopyFixPrompt: copyFixPrompt,
        onOpenCandidate: openCandidate,
        onSaveFindingDecision: (body: Record<string, unknown>) => { void runWrite('/finding/decision', body); },
      });
    }

    const openCount = (health?.counts.pending ?? 0)
      + (health?.counts.changes_requested ?? 0)
      + (health?.counts.repair_failed ?? 0)
      + (health?.counts.human_takeover ?? 0)
      + (health?.counts.awaiting_verification ?? 0);

    return h('div', { className: 'dcr' },
      h('div', { className: 'dcr-top' },
        h('div', { className: 'dcr-grow' },
          h('div', { className: 'dcr-row' },
            h('h1', null, '评审'),
            h('span', { className: 'dcr-chip' }, `${String(openCount)} 个问题待处理`),
            health?.vcsType ? h('span', { className: 'dcr-chip' }, health.vcsType.toUpperCase()) : null,
            health?.currentBase ? h('span', { className: 'dcr-chip dcr-mono' }, short(health.currentBase)) : null,
          ),
          h('div', { className: 'dcr-sub' }, `${health?.repoRoot || '未配置本地评审仓库'} · 审核者 ${health?.owner || settings?.owner || '未设置'}`),
        ),
        screen === 'detail' ? h('button', { className: 'dcr-btn g', onClick: () => setScreen('queue') }, '← 队列') : null,
        h('button', {
          className: 'dcr-btn',
          onClick: () => {
            void refreshHealth();
            if (screen === 'queue') void loadQueue();
            if (screen === 'detail') reloadCurrent();
          },
        }, '刷新'),
        h('button', {
          className: 'dcr-btn',
          disabled: busy,
          onClick: () => { void (async () => { try { await loadSettings(); } finally { setScreen('settings'); } })(); },
        }, '设置'),
      ),
      content,
    );
  };
}
