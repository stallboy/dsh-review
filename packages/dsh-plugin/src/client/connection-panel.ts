import { safeExternalHref } from '@dsh-review/protocol';
import { ApiResponseError, createApi, runtimeBytes, type ApiClient } from './api.js';
import type {
  ConnectionCheck,
  ConnectionDraft,
  ConnectionFailure,
  ConnectionStatus,
  ReactLike,
  RegistrationCompatibility,
  RuntimeProgress,
  SavedConnection,
} from './types.js';

export type AppComponent = (props: { onRepoChange: () => void }) => unknown;

export function createReviewPanel(React: ReactLike, App: AppComponent): () => unknown {
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback } = React;

  return function ReviewPanel() {
    const [tab, setTab] = useState<'connection' | 'projects' | 'central' | 'local'>('connection');
    const [status, setStatus] = useState<ConnectionStatus | null>(null);
    const [draft, setDraft] = useState<ConnectionDraft>({ mode: 'local', centerUrl: '', nodeId: '', token: '', reviewIdentity: '' });
    const [failure, setFailure] = useState<ConnectionFailure | null>(null);
    const [loadError, setLoadError] = useState('');
    const [check, setCheck] = useState<ConnectionCheck | null>(null);
    const [copyNotice, setCopyNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [pendingAction, setPendingAction] = useState('');
    const [runningLocalStart, setRunningLocalStart] = useState(false);
    const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null);
    const [downloadConfirmation, setDownloadConfirmation] = useState<{
      source: NonNullable<ConnectionStatus['localRuntimeDownload']>;
      submit: () => void;
    } | null>(null);
    const [forceConfirmation, setForceConfirmation] = useState<string | null>(null);
    const [deleteConfirmation, setDeleteConfirmation] = useState<{ centralId: string; name: string; stopCurrent: boolean } | null>(null);
    const [downloadNotice, setDownloadNotice] = useState('');
    const [centralSession, setCentralSession] = useState<{ generation: number; identity: string } | null>(null);
    const [editing, setEditing] = useState(false);
    const [confirmed, setControlReady] = useState(false);
    const [frameProject, setFrameProject] = useState<{ centralId: string; projectId?: string; commandId?: string } | null>(null);
    const [localRepoRevision, setLocalRepoRevision] = useState(0);
    const reloadLocalRepo = useCallback(() => setLocalRepoRevision((value) => value + 1), []);
    const initialized = useRef(false);
    const edited = useRef(false);
    const confirmationPanel = useRef<HTMLElement | null>(null);
    const draftRevision = useRef(0);
    const scopeRef = useRef<{
      api: ApiClient;
      reads: ApiClient;
      active: boolean;
      loading: boolean;
      writing: boolean;
      ready: boolean;
      revision: number;
      token: string;
    } | null>(null);

    const progress = runningLocalStart ? runtimeProgress : status?.runtimeProgress;
    const working = busy || status?.phase === 'starting' || Boolean(progress && !progress.error);
    const controlsLocked = working || Boolean(downloadConfirmation || deleteConfirmation || forceConfirmation);
    const hasConnection = Boolean(status?.configured && (status.mode === 'local' || (status.centralId && status.centerUrl)));
    const localIdentity = status?.localReviewIdentity || (status?.mode === 'local' && status.configured && status.centralId ? status.reviewIdentity : '');
    const centralHome = '/dsh-code-review/central/';
    const framePath = frameProject && frameProject.centralId === status?.centralId
      ? frameProject.commandId
        ? `${centralHome}tasks?${new URLSearchParams({ commandId: frameProject.commandId, ...(frameProject.projectId ? { projectId: frameProject.projectId } : {}) })}`
        : `${centralHome}projects/${encodeURIComponent(frameProject.projectId!)}`
      : centralHome;
    const showLocal = Boolean(confirmed && !working && status && !status.configured && !status.legacy);

    useEffect(() => {
      if (status && !showLocal && tab === 'local') setTab('connection');
    }, [showLocal, tab, status]);

    useEffect(() => {
      if ((downloadConfirmation || deleteConfirmation || forceConfirmation) && tab === 'connection') {
        confirmationPanel.current?.focus();
      }
    }, [downloadConfirmation, deleteConfirmation, forceConfirmation, tab]);

    const refresh = useCallback(async (afterWrite = false): Promise<void> => {
      const scope = scopeRef.current;
      if (!scope?.active || scope.loading || (scope.writing && !afterWrite)) return;
      const revision = scope.revision;
      scope.loading = true;
      try {
        const value = await scope.reads.get<ConnectionStatus>('');
        if (!scope.active || revision !== scope.revision) return;
        scope.token = value.controlToken;
        scope.ready = true;
        setStatus(value);
        setControlReady(true);
        setLoadError('');
        if (!initialized.current) {
          initialized.current = true;
          if (!edited.current) {
            setDraft({
              mode: value.mode,
              centerUrl: value.centerUrl,
              nodeId: value.nodeId,
              token: '',
              reviewIdentity: value.localReviewIdentity || (value.mode === 'local' ? value.reviewIdentity : ''),
            });
          }
        }
      } catch (reason) {
        if (scope.active && revision === scope.revision) {
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (revision === scope.revision) scope.loading = false;
      }
    }, []);

    useEffect(() => {
      const scope = {
        api: null as unknown as ApiClient,
        reads: null as unknown as ApiClient,
        active: true,
        loading: false,
        writing: false,
        ready: false,
        revision: 0,
        token: '',
      };
      scope.api = createApi('/dsh-code-review/connection', () => scope.token);
      scope.reads = createApi('/dsh-code-review/connection', () => scope.token);
      scopeRef.current = scope;
      setBusy(false);
      setPendingAction('');
      setCheck(null);
      setFailure(null);
      setCopyNotice('');
      setControlReady(false);
      void refresh();
      const timer = setInterval(() => { void refresh(); }, 3000);
      return () => {
        scope.active = false;
        clearInterval(timer);
        scope.api.dispose();
        scope.reads.dispose();
        if (scopeRef.current === scope) scopeRef.current = null;
      };
    }, [refresh]);

    useEffect(() => {
      if (!runningLocalStart) return;
      const api = createApi('/dsh-code-review/connection');
      let active = true;
      let reading = false;
      const timer = setInterval(async () => {
        if (reading) return;
        reading = true;
        try {
          const value = await api.get<RuntimeProgress | null>('/progress');
          if (active && value) setRuntimeProgress(value);
        } catch {
          // 完整错误及连接状态由写请求和写后刷新处理。
        } finally {
          reading = false;
        }
      }, 750);
      return () => { active = false; clearInterval(timer); api.dispose(); };
    }, [runningLocalStart]);

    const externalGeneration = tab === 'connection' && status?.mode === 'external' && status.phase === 'ready'
      ? status.generation
      : undefined;
    useEffect(() => {
      setCentralSession(null);
      if (externalGeneration === undefined) return;
      const api = createApi('/dsh-code-review/central');
      let active = true;
      void api.get<{ user: { reviewIdentity: string } }>('/api/v1/auth/session').then((value) => {
        if (active && typeof value?.user?.reviewIdentity === 'string') {
          setCentralSession({ generation: externalGeneration, identity: value.user.reviewIdentity });
        }
      }).catch(() => {});
      return () => { active = false; api.dispose(); };
    }, [externalGeneration]);

    const clearDraftFeedback = (): void => {
      draftRevision.current += 1;
      setCheck(null);
      setFailure((previous) => (previous?.forDraft ? null : previous));
    };
    const edit = (change: Partial<ConnectionDraft>): void => {
      edited.current = true;
      clearDraftFeedback();
      setDownloadNotice('');
      setDraft((previous) => ({ ...previous, ...change }));
    };
    const write = async (path: string, body: unknown, forDraft = false): Promise<boolean> => {
      const scope = scopeRef.current;
      if (!scope?.active || !scope.token || !scope.ready || scope.writing || working || status?.legacy) return false;
      const revision = draftRevision.current;
      scope.writing = true;
      scope.ready = false;
      scope.revision += 1;
      scope.reads.dispose();
      scope.reads = createApi('/dsh-code-review/connection', () => scope.token);
      scope.loading = false;
      setControlReady(false);
      setBusy(true);
      setPendingAction(path);
      setFailure(null);
      if (forDraft) setCheck(null);
      try {
        const result = await scope.api.post<ConnectionCheck>(path, body);
        if (!scope.active) return false;
        if (forDraft && revision === draftRevision.current) {
          if (path === '/test') setCheck(result);
          if (path === '/apply') setDraft((previous) => ({ ...previous, token: '' }));
        }
        await refresh(true);
        return scope.active && scope.ready;
      } catch (reason) {
        if (scope.active && (!forDraft || revision === draftRevision.current)) {
          setFailure({
            message: reason instanceof Error ? reason.message : String(reason),
            issue: reason instanceof ApiResponseError ? reason.issue : undefined,
            forDraft,
            stopFailed: path === '/stop' || path === '/force-stop',
          });
          if (forDraft && path === '/apply') setEditing(true);
        }
        if (scope.active) await refresh(true);
        return false;
      } finally {
        scope.writing = false;
        if (scope.active) { setBusy(false); setPendingAction(''); }
      }
    };

    const credentials = {
      centerUrl: draft.centerUrl.trim(),
      ...(draft.nodeId.trim() ? { nodeId: draft.nodeId.trim() } : {}),
      ...(draft.token ? { token: draft.token } : {}),
      ...(draft.expectedCentralId ? { expectedCentralId: draft.expectedCentralId } : {}),
    };
    const currentSaved = status?.savedConnections?.find((connection) => connection.centralId === status.centralId);
    const unchanged = Boolean(hasConnection && status && draft.mode === status.mode
      && (draft.mode === 'local' || (draft.centerUrl.trim() === status.centerUrl && draft.nodeId.trim() === status.nodeId && !draft.token
        && (!draft.expectedCentralId || status.centralId === draft.expectedCentralId)
        && (draft.label?.trim() ?? '') === (currentSaved?.label ?? ''))));
    const savedDraft = (): ConnectionDraft => ({
      mode: status!.mode,
      centerUrl: status!.centerUrl,
      nodeId: status!.nodeId,
      token: '',
      reviewIdentity: localIdentity || (status!.mode === 'local' ? status!.reviewIdentity : ''),
      label: currentSaved?.label,
      expectedCentralId: currentSaved?.centralId,
    });
    const editSavedConnection = (connection?: SavedConnection): void => {
      clearDraftFeedback();
      setDownloadNotice('');
      setDraft({
        mode: 'external',
        centerUrl: connection?.centerUrl ?? '',
        nodeId: connection?.nodeId ?? '',
        token: '',
        reviewIdentity: localIdentity || '',
        label: connection?.label,
        expectedCentralId: connection?.centralId,
      });
      edited.current = true;
      setEditing(true);
    };
    const editConnection = (): void => {
      clearDraftFeedback();
      setDownloadNotice('');
      setDraft(savedDraft());
      edited.current = false;
      setEditing(true);
    };
    const cancelEditing = (): void => {
      clearDraftFeedback();
      setDownloadNotice('');
      setDraft(savedDraft());
      edited.current = false;
      setEditing(false);
    };

    const localDownload = status?.localRuntimeDownload;
    const localUnavailable = status?.localAvailable === false && !localDownload;
    const startConnection = (body: { mode: ConnectionDraft['mode']; reviewIdentity: string; centerUrl?: string; nodeId?: string; expectedCentralId?: string; token?: string; label?: string }, forDraft = false): void => {
      if (scopeRef.current?.writing || controlsLocked) return;
      const download = body.mode === 'local' ? localDownload : undefined;
      setDownloadNotice('');
      const submit = async (): Promise<void> => {
        if (scopeRef.current?.writing) return;
        setDownloadConfirmation(null);
        setRuntimeProgress(null);
        setRunningLocalStart(body.mode === 'local');
        try {
          const applied = await write('/apply', { ...body, ...(download ? { confirmRuntimeDownload: download.sha256 } : {}) }, forDraft);
          if (applied && forDraft) { setEditing(false); edited.current = false; }
        } finally {
          setRunningLocalStart(false);
        }
      };
      if (download) setDownloadConfirmation({ source: download, submit: () => { void submit(); } });
      else void submit();
    };
    const apply = (): void => {
      if ((status?.phase === 'ready' && unchanged) || (draft.mode === 'external' && check?.registrationCompatibility === 'incompatible')) return;
      startConnection({
        mode: draft.mode,
        ...(draft.mode === 'external' ? { ...credentials, ...(draft.label !== undefined ? { label: draft.label.trim() } : {}) } : {}),
        reviewIdentity: draft.mode === 'local' && localIdentity ? localIdentity : draft.reviewIdentity.trim(),
      }, true);
    };
    const openProject = (projectId: string, event: { preventDefault(): void }): void => {
      event.preventDefault();
      if (!status || starting) return;
      setFrameProject({ centralId: status.centralId, projectId });
      setTab('central');
    };
    const projectLink = (projectId: string, label: string): unknown => h('a', {
      className: 'dcr-btn',
      href: `/dsh-code-review/central/projects/${encodeURIComponent(projectId)}`,
      onClick: (event: { preventDefault(): void }) => openProject(projectId, event),
    }, label);

    const disabled = controlsLocked || !status || !confirmed || Boolean(status.legacy);
    const showForm = Boolean(status && !status.legacy && (!status.configured || editing));
    const localStartLabel = localDownload ? '正在下载并启动…' : '正在启动…';
    const switchingConnection = Boolean(status?.configured && (draft.mode !== status.mode
      || (draft.expectedCentralId && draft.expectedCentralId !== status.centralId)));
    const applyLabel = busy && pendingAction === '/apply'
      ? (draft.mode === 'local' ? localStartLabel : '正在连接…')
      : hasConnection && switchingConnection
        ? '切换并连接'
        : hasConnection
          ? '应用更改'
          : draft.mode === 'local' ? '应用并启动' : '保存并连接';
    const starting = status?.phase === 'starting' || (busy && pendingAction === '/apply') || Boolean(progress && !progress.error);
    const runtimeStage = {
      preparing: '准备本机运行包',
      requesting: '请求下载',
      downloading: '下载运行包',
      verifying: '校验运行包',
      unpacking: '解包运行包',
      switching: '检查原连接状态',
      starting: '启动本机中央并连接节点',
    };
    const showProgress = Boolean(progress || runningLocalStart);
    const showBytes = !progress?.error && progress?.received !== undefined && progress.total !== undefined;
    const phaseTitle = !status
      ? '正在读取状态…'
      : status.legacy
        ? '旧托管配置'
        : starting
          ? '正在连接…'
          : status.phase === 'error'
            ? '连接失败'
            : status.phase === 'ready'
              ? (status.nodeOnline ? '中央已连接' : status.serverReachable === false ? '连接状态待确认' : '节点离线')
              : hasConnection ? '连接已停止' : status.configured ? '未选择中央连接' : '尚未配置';
    const savedFailure: ConnectionFailure | null = loadError
      ? { message: loadError }
      : status?.error
        ? { message: status.error, issue: status.issue }
        : !busy && progress?.error ? { message: progress.error } : null;
    const visibleFailure = failure ?? savedFailure;
    const formFailure = visibleFailure?.forDraft ? visibleFailure : null;
    const issue = formFailure?.issue;
    const fieldError = issue?.stage === 'address'
      ? 'centerUrl'
      : issue?.stage === 'credentials'
        ? (issue.code === 'node_id_mismatch' || issue.code === 'invalid_node_id' ? 'nodeId' : 'token')
        : undefined;
    const feedbackId = 'dcr-connection-feedback';
    const selectedSaved = status?.savedConnections?.find((connection) => connection.centralId === draft.expectedCentralId);
    const credentialSource = selectedSaved ?? (status?.mode === 'external' && status.hasCredentials ? status : undefined);
    const savedCredentials = credentialSource
      && draft.centerUrl.trim().replace(/\/+$/, '') === credentialSource.centerUrl.replace(/\/+$/, '')
      && (!draft.nodeId.trim() || draft.nodeId.trim() === credentialSource.nodeId);

    const field = (label: string, key: 'centerUrl' | 'nodeId' | 'token' | 'reviewIdentity' | 'label'): unknown => h('label', { className: 'dcr-field' },
      h('span', null, label),
      h('input', {
        className: 'dcr-input',
        'aria-label': label,
        type: key === 'token' ? 'password' : 'text',
        autoComplete: key === 'token' ? 'new-password' : 'off',
        inputMode: key === 'centerUrl' ? 'url' : undefined,
        placeholder: key === 'centerUrl' ? 'https://review.example.com' : undefined,
        'aria-invalid': fieldError === key || undefined,
        'aria-describedby': fieldError === key ? feedbackId : undefined,
        value: draft[key] ?? '',
        disabled: controlsLocked,
        maxLength: key === 'label' ? 80 : undefined,
        onChange: (event: { target: { value: string } }) => edit({ [key]: event.target.value }),
      }),
    );

    type CheckStep = [string, 'passed' | 'failed' | 'waiting'];
    const compatibilityStep = (compatibility?: RegistrationCompatibility): CheckStep => (
      compatibility === 'supported'
        ? ['支持工作副本注册协议', 'passed']
        : compatibility === 'incompatible'
          ? ['不支持工作副本注册协议', 'failed']
          : compatibility === 'unknown'
            ? ['注册兼容性将在连接时验证', 'waiting']
            : ['节点注册未开始', 'waiting']
    );
    const steps = (items: CheckStep[]): unknown => h('ul', { className: 'dcr-connection-checks', 'aria-label': '连接检查结果' },
      ...items.map(([label, state]) => h('li', { key: label, className: state },
        h('span', { 'aria-hidden': true }, { passed: '✓', failed: '!', waiting: '·' }[state]),
        label,
      )),
    );

    const feedback = (problem: ConnectionFailure): unknown => {
      const stage = problem.issue?.stage;
      const code = problem.issue?.code;
      const guidance = code === 'workspace_rejected' ? '中央版本可能较旧。请管理员核对中央服务与插件的构建版本，然后重试。'
        : code === 'registration_incompatible' || code === 'protocol_mismatch' ? '请管理员升级中央服务，使它与插件兼容。'
        : code === 'instance_conflict' ? '确认使用此节点凭据的旧实例已停止，再重试。'
        : code === 'binding_mismatch' ? '请核对原工作副本及其分支，恢复原目标后重试。'
        : code === 'connection_busy' ? '在原中央处理未决任务。事件未确认时，保持原连接在线以便自动补报。'
        : code === 'project_busy' ? '请先到中央工作台处理该项目的未决任务，再重试。'
        : code === 'configuration_required' ? '请管理员核对中央服务与插件的构建版本，并检查节点执行配置。'
        : code === 'registration_field_invalid' ? '展开诊断详情查看被拒绝的字段，请管理员核对节点配置后重试。'
        : stage === 'registration' ? '请在中央工作台确认此节点的状态，核对后重试。'
        : stage === 'server' ? '请核对中央地址、服务状态和网络，再重新检查。'
        : code === 'credential_check_failed' ? '请确认中央服务正常，再重新检查。'
        : stage === 'credentials' ? '请核对中央管理员签发的节点 ID 和 Token。'
        : code === 'local_start_failed' ? '展开诊断详情，检查本机中央的运行包和数据目录。' : '';
      const states: Record<string, string> = {
        queued: '排队中',
        dispatched: '已分派',
        accepted: '已受理',
        executing: '执行中',
        recovery_required: '待核验',
      };
      return h('div', { className: 'dcr-connection-feedback' },
        stage === 'registration' ? steps([['服务器可访问', 'passed'], ['节点凭据有效', 'passed'], code === 'registration_incompatible'
          ? compatibilityStep('incompatible') : ['节点注册失败', 'failed']]) : null,
        stage === 'credentials' ? steps([['服务器可访问', 'passed'], ['凭据验证失败', 'failed'], compatibilityStep(problem.issue?.registrationCompatibility)]) : null,
        h('div', { className: 'dcr-banner err', role: 'alert', id: feedbackId }, h('strong', null, problem.message), guidance ? h('p', null, guidance) : null),
        problem.issue?.blockers?.length ? h('ul', { 'aria-label': '阻塞任务' }, ...problem.issue.blockers.map((blocker) =>
          h('li', { key: blocker.commandId },
            h('strong', null, blocker.project || blocker.projectId || '项目未知'),
            h('div', null, [blocker.operation, blocker.state && states[blocker.state], blocker.commandId].filter(Boolean).join(' · ')),
            blocker.detail ? h('p', null, blocker.detail) : null,
            blocker.events ? h('p', null, `${blocker.events.count} 条事件待中央确认（序号 ${blocker.events.first}${blocker.events.last === blocker.events.first ? '' : `–${blocker.events.last}`}）`) : null,
            status?.phase === 'ready' && blocker.projectId ? h('button', {
              className: 'dcr-btn',
              disabled: controlsLocked,
              onClick: () => {
                setFrameProject({ centralId: status.centralId, projectId: blocker.projectId, commandId: blocker.commandId });
                setTab('central');
              },
            }, '查看原任务') : null,
          ))) : null,
      );
    };

    const diagnostics = (status?.logs ?? []).map((line) => (draft.token.trim() ? line.replaceAll(draft.token.trim(), '[已隐藏]') : line)).join('\n');
    const copyDiagnostics = async (): Promise<void> => {
      try { await navigator.clipboard.writeText(diagnostics); setCopyNotice('诊断已复制'); }
      catch { setCopyNotice('无法自动复制，请选择下方文本进行复制。'); }
    };
    const diagnosticDetails = diagnostics ? h('details', { className: 'dcr-connection-diagnostics' },
      h('summary', null, '诊断详情'),
      h('pre', { className: 'dcr-log' }, diagnostics),
      h('div', { className: 'dcr-connection-actions' },
        h('button', { className: 'dcr-btn', onClick: () => { void copyDiagnostics(); } }, '复制诊断'),
        h('span', { role: 'status' }, copyNotice),
      ),
    ) : null;

    const projectRegistrationFailure = tab === 'projects' && visibleFailure?.issue?.stage === 'registration' ? visibleFailure : null;
    const safeLegacyCenterUrl = status?.centerUrl ? safeExternalHref(status.centerUrl) : null;

    let content: unknown;
    if (tab === 'local') {
      content = !status || !confirmed || working
        ? h('div', { className: 'dcr-empty' }, '正在检查中央连接状态…')
        : status.configured || status.legacy
          ? h('div', { className: 'dcr-body' }, h('section', { className: 'dcr-card' },
              h('h2', null, '此节点由中央管理'),
              h('p', null, '请通过中央工作台查看项目并执行评审。已保存中央配置时，本地评审写入保持停用。'),
              h('button', { className: 'dcr-btn p', onClick: () => setTab('central') }, '进入中央工作台'),
            ))
          : h(App, { key: localRepoRevision, onRepoChange: reloadLocalRepo });
    } else if (tab === 'central') {
      content = status?.legacy
        ? safeLegacyCenterUrl
          ? h('div', { className: 'dcr-body' }, h('section', { className: 'dcr-card' },
              h('h2', null, '既有中央工作台'),
              h('p', null, '请在已有中央处理未决任务，再停用旧托管配置并重启插件。'),
              h('a', { className: 'dcr-btn p', href: safeLegacyCenterUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开已有中央工作台'),
            ))
          : h('div', { className: 'dcr-empty' }, '旧托管配置中的中央地址无效，请检查 managed-node.json。')
        : status?.phase === 'ready' && !starting
          ? h('iframe', { className: 'dcr-central-frame', title: '中央工作台', src: framePath, key: `${status.generation}:${framePath}` })
          : h('div', { className: 'dcr-empty' }, '中央尚未就绪，请在中央连接中应用配置或重试。');
    } else if (tab === 'projects') {
      content = h('div', { className: 'dcr-body' }, h('div', { className: 'dcr-wrap' },
        projectRegistrationFailure ? h('section', { className: 'dcr-card dcr-connection-card' }, feedback(projectRegistrationFailure), diagnosticDetails) : null,
        h('div', { className: 'dcr-card' }, h('h2', null, '选择接入项目'), h('p', { className: 'dcr-muted' }, '按工作副本目录独立接入；接入后不会自动发起审查。')),
        ...(status?.candidates ?? []).map((candidate) => {
          const project = status?.projects.find((value) => value.root === candidate.root);
          return h('section', { className: 'dcr-card', key: candidate.id },
            h('strong', null, candidate.label),
            h('p', { className: 'dcr-mono dcr-central-path' }, candidate.root),
            h('p', { className: 'dcr-muted' }, `${candidate.vcsType?.toUpperCase() ?? '未识别 VCS'} · ${candidate.target ?? '目标未确定'}`),
            candidate.error ? h('div', { className: 'dcr-banner err' }, candidate.error) : null,
            project
              ? h('span', { className: 'dcr-chip' }, project.enabled ? '已接入' : '已停用')
              : h('button', {
                  className: 'dcr-btn p',
                  disabled: disabled || Boolean(candidate.error) || status?.phase !== 'ready',
                  onClick: () => { void write('/projects', { candidateId: candidate.id, enabled: true }); },
                }, '接入项目'),
          );
        }),
        !status?.candidates.length ? h('div', { className: 'dcr-empty' }, '未发现可接入的工作副本。请将仓库目录添加到 DSH 工作区后刷新。') : null,
        h('h2', null, '已保存的项目'),
        ...(status?.projects ?? []).map((project) => h('section', { className: 'dcr-card', key: project.workspaceId },
          h('div', { className: 'dcr-row' },
            h('strong', { className: 'dcr-grow' }, project.label),
            h('span', { className: 'dcr-chip' }, project.workspaceIssue ? '不可执行' : project.enabled ? '已启用' : '已停用'),
          ),
          h('p', { className: 'dcr-mono dcr-central-path' }, project.root),
          h('p', { className: 'dcr-muted' }, `${project.vcsType.toUpperCase()} · ${project.target}`),
          project.workspaceIssue ? h('p', { className: 'dcr-banner warn', role: 'status' }, project.workspaceIssue) : null,
          h('div', { className: 'dcr-row' },
            h('button', { className: 'dcr-btn', disabled, onClick: () => { void write('/projects', { workspaceId: project.workspaceId, enabled: !project.enabled }); } }, project.enabled ? '停用项目' : '启用项目'),
            project.projectId ? projectLink(project.projectId, '打开项目') : h('span', { className: 'dcr-muted' }, '等待中央绑定'),
          ),
        )),
      ));
    } else {
      const hasProjects = status?.projects.some((project) => project.enabled);
      const canEnterWorkbench = status?.legacy || status?.phase === 'ready';
      const firstProject = status?.phase === 'ready' && status.nodeOnline && !hasProjects;
      const modeOption = (mode: ConnectionDraft['mode'], label: string, description: string): unknown => {
        const id = `${feedbackId}-${mode}`;
        return h('button', {
          className: 'dcr-connection-mode',
          'aria-label': label,
          'aria-pressed': draft.mode === mode,
          'aria-describedby': id,
          disabled: controlsLocked,
          onClick: () => edit({ mode }),
        },
        h('strong', null, label),
        h('span', { id, className: 'dcr-muted' }, description),
        );
      };
      content = h('div', { className: 'dcr-body' }, h('div', { className: 'dcr-wrap dcr-connection' },
        h('header', { className: 'dcr-connection-head' },
          h('h1', null, '中央连接'),
          h('span', { 'aria-live': 'polite', className: `dcr-chip ${!starting && status?.nodeOnline ? 'approved' : !starting && status?.phase === 'error' ? 'rejected' : 'pending'}` }, phaseTitle),
        ),
        downloadConfirmation ? h('section', { className: 'dcr-card dcr-connection-card', ref: confirmationPanel, tabIndex: -1, 'aria-labelledby': 'dcr-download-title' },
          h('h2', { id: 'dcr-download-title' }, '下载本机中央运行包'),
          h('p', null, `版本 ${downloadConfirmation.source.version} · ${runtimeBytes(downloadConfirmation.source.size, downloadConfirmation.source.size)}`),
          h('p', { className: 'dcr-muted dcr-mono' }, downloadConfirmation.source.url),
          h('div', { className: 'dcr-connection-actions' },
            h('button', { className: 'dcr-btn p', onClick: downloadConfirmation.submit }, '下载并启动'),
            h('button', { className: 'dcr-btn', onClick: () => { setDownloadConfirmation(null); setDownloadNotice('已取消，未开始下载。'); } }, '取消'),
          ),
        ) : null,
        forceConfirmation ? h('section', { className: 'dcr-card dcr-connection-card', ref: confirmationPanel, tabIndex: -1, 'aria-labelledby': 'dcr-force-stop-title' },
          h('h2', { id: 'dcr-force-stop-title' }, '强制退出当前连接'),
          h('p', null, '本机节点将停止。未决任务、执行记录和待确认事件会保留，再次接入原中央后继续核验或补报。已启动的 DSH 会话或外部工具可能继续运行，恢复前须确认它们已经停止。'),
          h('div', { className: 'dcr-connection-actions' },
            h('button', {
              className: 'dcr-btn d',
              onClick: () => {
                setForceConfirmation(null);
                void write('/force-stop', { confirm: true, centralId: forceConfirmation });
              },
            }, '确认强制退出'),
            h('button', { className: 'dcr-btn', onClick: () => setForceConfirmation(null) }, '取消'),
          ),
        ) : null,
        deleteConfirmation ? h('section', { className: 'dcr-card dcr-connection-card', ref: confirmationPanel, tabIndex: -1, 'aria-labelledby': 'dcr-delete-connection-title' },
          h('h2', { id: 'dcr-delete-connection-title' }, `删除连接「${deleteConfirmation.name}」`),
          h('p', null, `${deleteConfirmation.stopCurrent ? '此操作会先停止插件连接。' : ''}本机保存的地址、名称和节点凭据将被移除。审核历史和项目绑定会保留。`),
          h('div', { className: 'dcr-connection-actions' },
            h('button', {
              className: 'dcr-btn d',
              onClick: () => {
                const { centralId, stopCurrent } = deleteConfirmation;
                setDeleteConfirmation(null);
                void write('/forget', { centralId, stopCurrent });
              },
            }, deleteConfirmation.stopCurrent ? '确认停止并删除' : '确认删除'),
            h('button', { className: 'dcr-btn', onClick: () => setDeleteConfirmation(null) }, '取消'),
          ),
        ) : null,
        downloadNotice ? h('p', { className: 'dcr-banner info', role: 'status' }, downloadNotice) : null,
        showProgress ? h('section', { className: 'dcr-card dcr-connection-card', 'aria-label': '本机中央启动进度' },
          h('h2', { role: 'status' }, progress ? `${progress.error ? '' : '正在'}${runtimeStage[progress.stage]}${progress.error ? '失败' : '…'}` : '正在准备启动本机中央…'),
          progress?.error ? null : h('progress', { 'aria-label': '运行包下载与启动进度', ...(showBytes ? { value: progress!.received, max: progress!.total } : {}) }),
          showBytes ? h('p', null, `已下载 ${runtimeBytes(progress!.received!, progress!.total!)} / ${runtimeBytes(progress!.total!, progress!.total!)}`) : null,
        ) : null,
        status && (hasConnection || status.legacy) ? h('section', { className: 'dcr-card dcr-connection-card' },
          h('h2', null, currentSaved?.label || (status.mode === 'local' ? '本机托管' : '已有中央')),
          h('dl', { className: 'dcr-connection-meta' },
            h('dt', null, '中央地址'), h('dd', { className: 'dcr-mono' }, status.centerUrl || '等待中央启动'),
            h('dt', null, '节点 ID'), h('dd', { className: 'dcr-mono' }, status.nodeId || '未分配'),
            h('dt', null, '审核身份'),
            h('dd', null, status.mode === 'local'
              ? localIdentity || status.reviewIdentity || '未设置'
              : centralSession?.generation === status.generation ? centralSession.identity : '由中央工作台的登录账号决定'),
          ),
          visibleFailure && !formFailure ? feedback(visibleFailure) : null,
          status.localRuntimeUpdate ? h('p', { className: 'dcr-banner info', role: 'status' },
            `中央运行包有新版本 ${status.localRuntimeUpdate.latestVersion}，当前运行 ${status.localRuntimeUpdate.currentVersion}。`) : null,
          status.phase === 'ready' && !status.nodeOnline ? h('p', { className: 'dcr-banner info', role: 'status' }, status.serverReachable === false
            ? '无法确认中央服务可用。请检查服务和网络，再刷新连接状态。'
            : '中央服务可访问，节点暂时离线。节点恢复后可继续执行评审。') : null,
          firstProject && !showForm ? h('p', { className: 'dcr-muted' }, '选择要接入中央评审的工作副本。') : null,
          h('div', { className: 'dcr-connection-actions' },
            firstProject && !showForm ? h('button', { className: 'dcr-btn p', onClick: () => setTab('projects') }, '接入项目') : null,
            canEnterWorkbench && !showForm ? h('button', { className: `dcr-btn${firstProject ? '' : ' p'}`, onClick: () => setTab('central') }, '进入中央工作台') : null,
            status.phase === 'ready' && hasProjects && !showForm ? h('button', { className: 'dcr-btn', onClick: () => setTab('projects') }, '管理项目') : null,
            !status.legacy && (status.phase === 'error' || status.phase === 'stopped') ? h('button', {
              className: `dcr-btn${showForm ? '' : ' p'}`,
              disabled: disabled || (status.mode === 'local' && localUnavailable),
              onClick: () => startConnection({
                mode: status.mode,
                reviewIdentity: status.reviewIdentity,
                ...(status.mode === 'external' ? { centerUrl: status.centerUrl, nodeId: status.nodeId, expectedCentralId: status.centralId || undefined } : {}),
              }),
            },
            busy && pendingAction === '/apply' && status.mode === 'local' && localDownload
              ? localStartLabel
              : status.phase === 'error' ? '重试已保存连接' : '启动已保存连接') : null,
            !status.legacy && (!showForm || visibleFailure?.issue?.code === 'connection_busy') && canEnterWorkbench
              && (status.mode === 'external' || visibleFailure?.issue?.code === 'connection_busy')
              ? h('button', { className: 'dcr-btn', onClick: () => { setFrameProject(null); setTab('central'); } },
                  visibleFailure?.issue?.code === 'connection_busy' ? '返回原中央处理任务' : '前往工作台切换账号') : null,
            !status.legacy && !showForm ? h('button', { className: 'dcr-btn', disabled, onClick: editConnection }, '修改连接') : null,
            status.configured && !status.legacy && !showForm ? h('button', { className: 'dcr-btn d', disabled: disabled || !status.enabled, onClick: () => { void write('/stop', {}); } },
              busy && (pendingAction === '/stop' || pendingAction === '/force-stop') ? '正在停止…' : '停止连接') : null,
            status.enabled && !status.legacy && !showForm && visibleFailure?.stopFailed ? h('button', {
              className: 'dcr-btn d',
              disabled,
              onClick: () => setForceConfirmation(status.centralId),
            }, '强制退出连接') : null,
            !status.legacy && !showForm && status.mode === 'external' ? h('button', {
              className: 'dcr-btn d',
              disabled,
              onClick: () => setDeleteConfirmation({ centralId: status.centralId, name: currentSaved?.label || status.centerUrl, stopCurrent: status.enabled }),
            }, '删除当前配置') : null,
          ),
        ) : visibleFailure && !showForm ? feedback(visibleFailure) : null,
        status?.configured && !status.legacy && !showForm ? h('section', { className: 'dcr-card dcr-connection-card' },
          h('h2', null, '管理连接'),
          ...(status.savedConnections ?? []).filter((connection) => connection.centralId !== status.centralId).map((connection) =>
            h('div', { className: 'dcr-saved-connection', key: connection.centralId },
              h('div', null, h('strong', null, connection.label || '已有中央'), h('small', { className: 'dcr-muted' }, connection.centerUrl)),
              h('div', { className: 'dcr-connection-actions' },
                h('button', {
                  className: 'dcr-btn p',
                  'aria-label': `切换到 ${connection.label || connection.centerUrl}`,
                  disabled,
                  onClick: () => { void write('/apply', { savedCentralId: connection.centralId }); },
                }, '切换'),
                h('button', {
                  className: 'dcr-btn',
                  'aria-label': `编辑连接 ${connection.label || connection.centerUrl}`,
                  disabled,
                  onClick: () => editSavedConnection(connection),
                }, '编辑'),
                h('button', {
                  className: 'dcr-btn d',
                  'aria-label': `删除连接 ${connection.label || connection.centerUrl}`,
                  disabled,
                  onClick: () => setDeleteConfirmation({ centralId: connection.centralId, name: connection.label || connection.centerUrl, stopCurrent: false }),
                }, '删除'),
              ),
            )),
          status.mode !== 'local' && localIdentity ? h('div', { className: 'dcr-saved-connection' },
            h('div', null, h('strong', null, '本机托管'), h('small', { className: 'dcr-muted' }, localIdentity)),
            h('button', {
              className: 'dcr-btn p',
              'aria-label': '切换到本机托管',
              disabled: disabled || localUnavailable,
              onClick: () => startConnection({ mode: 'local', reviewIdentity: localIdentity }),
            }, '切换')) : null,
          h('div', { className: 'dcr-connection-actions' },
            h('button', { className: 'dcr-btn', disabled, onClick: () => editSavedConnection() }, '添加连接'),
          ),
        ) : null,
        showForm ? h('section', { className: 'dcr-card dcr-connection-card', 'aria-busy': working },
          h('h2', null, hasConnection ? '修改配置' : '选择连接方式'),
          h('div', { className: 'dcr-connection-modes', role: 'group', 'aria-label': '连接方式' },
            modeOption('local', '本机托管', '由插件在这台机器上启动中央服务。'),
            modeOption('external', '连接已有中央', '使用管理员提供的地址和节点凭据。'),
          ),
          draft.mode === 'external'
            ? h('div', { className: 'dcr-connection-section' },
                h('div', { className: 'dcr-connection-fields' }, field('中央地址', 'centerUrl'), field('节点 ID', 'nodeId'), field('节点 Token', 'token'), field('连接名称（可选）', 'label')),
                savedCredentials
                  ? h('p', { className: 'dcr-muted' }, 'Token 留空时使用为此节点保存的凭据。')
                  : selectedSaved ? h('p', { className: 'dcr-muted' }, '修改地址时，请填写节点 Token 以核验原中央。') : null,
              )
            : h('div', { className: 'dcr-connection-section' },
                localIdentity
                  ? h('dl', { className: 'dcr-connection-meta' }, h('dt', null, '本机审核身份'), h('dd', null, localIdentity))
                  : h('div', { className: 'dcr-connection-fields' }, field('审核身份', 'reviewIdentity')),
                localDownload
                  ? h('p', { className: 'dcr-muted' }, '首次启动需确认下载本机中央运行包。')
                  : localUnavailable ? h('p', { className: 'dcr-muted' }, '此插件包未包含本机中央服务。请使用本机整合包，或连接已有中央。') : null,
              ),
          visibleFailure && (formFailure || !status?.configured) ? feedback(visibleFailure) : null,
          check ? h('div', { className: 'dcr-connection-feedback', role: 'status' },
            steps([
              ['服务器可访问', 'passed'],
              check.authenticated ? ['节点凭据有效', 'passed'] : ['节点凭据未验证', 'waiting'],
              compatibilityStep(check.registrationCompatibility),
            ]),
            check.registrationCompatibility === 'incompatible' ? h('p', { className: 'dcr-banner warn' }, '请管理员升级中央服务，再重新检查。') : null,
          ) : null,
          h('div', { className: 'dcr-connection-actions' },
            h('button', {
              className: 'dcr-btn p',
              disabled: disabled || (status?.phase === 'ready' && unchanged)
                || (draft.mode === 'local'
                  ? localUnavailable || (!localIdentity && !draft.reviewIdentity.trim())
                  : !draft.centerUrl.trim() || check?.registrationCompatibility === 'incompatible'),
              onClick: apply,
            }, applyLabel),
            draft.mode === 'external' ? h('button', {
              className: 'dcr-btn',
              disabled: disabled || !draft.centerUrl.trim(),
              onClick: () => { void write('/test', credentials, true); },
            }, pendingAction === '/test' ? '正在检查…' : '检查连接') : null,
            editing && status?.configured ? h('button', { className: 'dcr-btn g', disabled: controlsLocked, onClick: cancelEditing }, '取消修改') : null,
          ),
        ) : null,
        diagnosticDetails,
      ));
    }

    return h('div', { className: 'dcr dcr-workbench' },
      h('nav', { className: 'dcr-central-nav', 'aria-label': '评审入口' },
        ...([['connection', '中央连接'], ['projects', '项目接入'], ['central', '中央工作台'], ...(showLocal ? [['local', '本地评审']] : [])] as [typeof tab, string][]).map(([key, label]) =>
          h('button', {
            className: 'dcr-btn',
            key,
            'aria-selected': tab === key,
            onClick: () => {
              if (key === 'central') setFrameProject(null);
              setTab(key);
            },
          }, label)),
        h('span', { className: 'dcr-grow' }),
        h('button', { className: 'dcr-btn g', disabled: busy, onClick: () => { void refresh(); } }, '刷新连接'),
      ),
      tab !== 'connection' && visibleFailure && !projectRegistrationFailure ? h('div', { className: 'dcr-banner err', role: 'alert' }, visibleFailure.message) : null,
      status?.legacy ? h('div', { className: 'dcr-banner info', role: 'status' }, '当前正在使用旧托管配置（managed-node.json）。请先在原中央处理未决任务，再停用旧托管配置并重启插件，然后设置新中央连接。') : null,
      content,
    );
  };
}
