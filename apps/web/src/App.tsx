import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import {
    entityId,
    REVIEW_STATUSES,
    type AuditPlanSettings,
    type AuditRecurrence,
    type OptionPatchCheck,
    type PatchEntry,
    type RepairOption,
    type ReviewCandidate,
    type ReviewComment,
} from '@dsh-review/protocol';
import {
    ApiError,
    clearSession,
    command,
    deleteAuditPlan,
    detail,
    request,
    saveAuditPlan,
    setAuditPlanEnabled,
    setSession,
    triggerSelfTest,
    type AuditPlan,
    type CommandRecord,
    type FindingView,
    type NodeRecord,
    type ProjectDetail,
    type ProjectView,
    type QueueItem,
    type Session,
} from './api.js';
import { Diff, type Anchor } from './Diff.js';
import s from './App.module.css';

const UserContext = createContext<Session['user']>(null!);

const labels: Record<string, string> = {
    online: '在线',
    unresolved: '未解决',
    partial: '部分处理',
    resolved: '已解决',
    pending: '待审核',
    changes_requested: '待修订',
    repair_failed: '修复失败',
    human_takeover: '人工接手',
    awaiting_verification: '待复查验证',
    approved: '已批准',
    rejected: '已接受现状',
    deferred: '已延期',
    queued: '排队中',
    dispatched: '已分派',
    accepted: '已受理',
    executing: '执行中',
    completed: '已结束',
    recovery_required: '待核验',
    waiting: '等待执行条件',
    skipped: '已跳过',
    synced: '已同步',
    stale: '同步延迟',
    offline: '离线',
    not_synced: '未同步',
    delivered: '已交付远端',
    not_required: '无需交付',
    conflict: '交付冲突',
    unknown: '结果待核验',
    COMMITTED: '已提交',
    REPAIR_FAILED: '修复失败，已还原',
    FALLBACK_TO_PENDING: '退回待审核',
    ABORTED: '已中止',
    RECOVERY_REQUIRED: '需要恢复',
    SUCCEEDED: '已完成',
    MANUAL_REQUIRED: '需要人工处理',
    VALIDATION_FAILED: '校验未通过',
    repair: '补丁修复',
    confirm: '文字方案',
};

const label = (value: string) => labels[value] ?? value;
const time = (value?: string | null, timeZone?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone }) : '尚无记录';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const candidateUrl = (projectId: string, id: string) => `/projects/${projectId}/candidates/${id.split('/').map(encodeURIComponent).join('/')}`;

function Badge({ value, delivery = false }: { value: string; delivery?: boolean }) {
    return <span className={`${s.badge} ${s[value] ?? ''}`}>{delivery && value === 'pending' ? '待交付远端' : label(value)}</span>;
}
function ErrorBox({ error }: { error: unknown }) { return error ? <div className={s.error} role="alert">{message(error)}</div> : null; }
function Empty({ children }: { children: ReactNode }) { return <div className={s.empty}><span className={s.emptyMark}>◇</span>{children}</div>; }
function Heading({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
    return <div className={s.heading}><div><div className={s.eyebrow}>{eyebrow}</div><h1>{title}</h1>{children && <p>{children}</p>}</div><div className={s.actions}>{actions}</div></div>;
}
function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
    return <section className={s.panel}><div className={s.panelHead}><h2>{title}</h2>{extra}</div>{children}</section>;
}
function useProjects() { return useQuery({ queryKey: ['projects'], queryFn: () => request<{ projects: ProjectView[] }>('/projects'), refetchInterval: 5000 }); }

export function App() {
    const queryClient = useQueryClient();
    const session = useQuery({ queryKey: ['session'], queryFn: ({ signal }) => request<Session>('/auth/session', 'GET', undefined, signal), refetchInterval: 60000 });
    useEffect(() => {
        if (session.error instanceof ApiError && session.error.status === 401) clearSession(queryClient);
        else setSession(session.data ?? null);
    }, [session.data, session.error, queryClient]);
    if (session.isPending) return <main className={s.login}><Empty>正在连接评审中心…</Empty></main>;
    if (!session.data) return <Login onLogin={value => { setSession(value); queryClient.setQueryData(['session'], value); }} error={session.error instanceof ApiError && session.error.status === 401 ? null : session.error} />;
    const onLogout = session.data.localAccess ? undefined : async () => { await request('/auth/logout', 'POST'); clearSession(queryClient); };
    return <UserContext.Provider value={session.data.user}><Shell onLogout={onLogout} /></UserContext.Provider>;
}

function Login({ onLogin, error }: { onLogin(value: Session): void; error: unknown }) {
    const [username, setUsername] = useState(''), [password, setPassword] = useState('');
    const login = useMutation({ mutationFn: () => request<Session>('/auth/login', 'POST', { username, password }), onSuccess: onLogin });
    return (
        <main className={s.login}>
            <form className={s.loginCard} onSubmit={event => { event.preventDefault(); login.mutate(); }}>
                <div className={s.mark}>R</div>
                <div className={s.eyebrow}>DSH REVIEW CENTER</div>
                <h1>让每一次修改<br />都有据可审。</h1>
                <p>登录中央工作台，查看项目、审查与执行状态。</p>
                <label>账号<input autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} /></label>
                <label>密码<input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
                <ErrorBox error={login.error ?? error} />
                <button className={s.primary} disabled={login.isPending}>{login.isPending ? '正在登录…' : '登录工作台 →'}</button>
                <small>账号由管理员在中央服务创建。</small>
            </form>
        </main>
    );
}

function Shell({ onLogout }: { onLogout?: () => Promise<void> }) {
    const user = useContext(UserContext), location = useLocation();
    const [error, setError] = useState('');
    const navigation = [['/', '◫', '工作台'], ['/projects', '▤', '项目管理'], ['/reports', '≡', '审查报告'], ['/queue', '◇', '问题队列'], ['/tasks', '↗', '任务记录'], ['/nodes', '⌘', '执行节点']];
    return (
        <div className={s.shell}>
            <aside className={s.sidebar}>
                <Link className={s.brand} to="/"><span className={s.mark}>R</span><span>评审中心<small>DSH REVIEW</small></span></Link>
                <div className={s.navLabel}>工作空间</div>
                <nav>{navigation.map(([path, icon, title]) => <NavLink key={path} to={path!} end={path === '/'} className={({ isActive }) => isActive ? s.activeNav : ''}><span aria-hidden>{icon}</span>{title}</NavLink>)}</nav>
                <div className={s.sidebarFoot}><b>审查 · 决策 · 交付</b><p>事实随仓库保存<br />执行由节点完成</p></div>
            </aside>
            <div className={s.main}>
                <header className={s.topbar}>
                    <span className={s.crumb}>工作空间 <span>/ {navigation.find(([path]) => path === location.pathname)?.[2] ?? '项目详情'}</span></span>
                    <div className={s.actions}>
                        <span className={s.avatar}>{user.reviewIdentity.slice(0, 1)}</span>
                        <span>{user.reviewIdentity}</span>
                        {onLogout && <button className={s.textButton} onClick={() => void onLogout().catch(error => setError(message(error)))}>退出</button>}
                    </div>
                </header>
                <main className={s.body}>
                    <ErrorBox error={error} />
                    <Routes>
                        <Route path="/" element={<Workbench />} />
                        <Route path="/projects" element={<Projects />} />
                        <Route path="/reports" element={<Reports />} />
                        <Route path="/queue" element={<Queue />} />
                        <Route path="/tasks" element={<Tasks />} />
                        <Route path="/nodes" element={<Nodes />} />
                        <Route path="/projects/:projectId/candidates/*" element={<CandidatePage />} />
                        <Route path="/projects/:projectId" element={<ProjectPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </main>
            </div>
        </div>
    );
}

function Workbench() {
    const projects = useProjects();
    const views = projects.data?.projects ?? [];
    const queue = views.flatMap(view => (view.snapshot?.queue ?? []).map(item => ({ ...item, projectId: view.project.projectId, projectName: view.project.name } as unknown as QueueItem)));
    const actionable = queue.filter(item => !item.local && ['pending', 'changes_requested', 'repair_failed', 'human_takeover', 'awaiting_verification'].includes(item.status));
    return (
        <>
            <Heading eyebrow="OVERVIEW" title="工作台" actions={<Link className={s.button} to="/projects">管理项目 ↗</Link>}>先看需要决策的事，再进入具体代码。</Heading>
            <ErrorBox error={projects.error} />
            <div className={s.metrics}>
                {[
                    ['待处理问题', actionable.length, '待审核、修订、修复失败或人工跟进'],
                    ['接入项目', views.length, '统一查看项目进展'],
                    ['在线项目', views.filter(view => view.online).length, '执行节点保持连接'],
                    ['未同步 / 延迟', views.filter(view => view.freshness !== 'synced').length, '保留最后已知结果'],
                ].map(([title, value, note]) => <div key={title} className={s.metric}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>)}
            </div>
            <div className={s.twoColumns}>
                <Panel title="需要关注" extra={<Link to="/queue">全部问题 →</Link>}><CandidateList items={actionable.slice(0, 8)} loading={projects.isPending} /></Panel>
                <Panel title="项目状态">
                    <div className={s.stack}>
                        {views.length ? views.map(view => (
                            <Link className={s.projectRow} to={`/projects/${view.project.projectId}`} key={view.project.projectId}>
                                <span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span>
                                <span className={s.grow}><b>{view.project.name}</b><small>{view.project.vcsType.toUpperCase()} · {view.project.target}</small></span>
                                <Badge value={view.freshness} />
                            </Link>
                        )) : <Empty>还没有接入项目。先注册节点，再绑定工作副本。</Empty>}
                    </div>
                </Panel>
            </div>
        </>
    );
}

function CandidateList({ items, loading }: { items: QueueItem[]; loading?: boolean }) {
    if (!items.length) return <Empty>{loading ? '正在加载问题…' : '当前没有匹配的问题。'}</Empty>;
    return (
        <div className={s.candidateList}>
            {items.map(item => (
                <div className={s.candidateRow} key={`${item.projectId}/${item.id}`}>
                    <div className={s.grow}>
                        {item.localOnly ? <b>{item.title}</b> : <Link className={s.rowTitle} to={candidateUrl(item.projectId, item.id)}>{item.title || item.id}</Link>}
                        <div className={s.rowMeta}>
                            <span>{item.projectName}</span>
                            <span>{item.priority}</span>
                            <span>{label(item.issueKind)}</span>
                            <span>{item.owner}</span>
                            <span>记录 {item.recordRevision}</span>
                            <span>{item.unresolvedComments ?? 0} 条待处理意见</span>
                        </div>
                        {item.parseError && <p className={s.dangerText}>{item.parseError}</p>}
                    </div>
                    <div className={s.end}>
                        <Badge value={item.status} />
                        {item.deferred && <Badge value="deferred" />}
                        {item.local && <small>本地诊断</small>}
                        <span className={s.diffStat}>+{item.patchStats?.additions ?? 0} <em>−{item.patchStats?.deletions ?? 0}</em></span>
                    </div>
                </div>
            ))}
        </div>
    );
}

function FindingCard({ finding, projectId, writable, selected, selectedOption }: {
    finding: FindingView;
    projectId: string;
    writable?: boolean;
    selected?: string;
    selectedOption?: string;
}) {
    const navigate = useNavigate();
    const [action, setAction] = useState('');
    const [reason, setReason] = useState('');
    const [reviewAfter, setReviewAfter] = useState('');
    const [reviewWhen, setReviewWhen] = useState('');
    const [copied, setCopied] = useState('');
    const closed = finding.issueStatus === 'approved' || finding.issueStatus === 'resolved';
    const guard = {
        expectedRevision: finding.recordRevision,
        expectedOwner: finding.owner,
        expectedUpdatedAt: finding.updatedAt,
    };
    const run = useMutation({
        mutationFn: (payload: Record<string, unknown>) => command(projectId, 'finding-decision', { id: finding.id, ...payload }, guard),
        onSuccess: () => { setAction(''); setReason(''); navigate(`/tasks?projectId=${projectId}`); },
    });
    const disabled = !writable || run.isPending;
    const canResumeFromRepairFailed = finding.options.some(option => !option.banned);
    const canAcceptAsIs = !closed && ['pending', 'changes_requested', 'repair_failed', 'human_takeover'].includes(finding.issueStatus);
    const canDefer = !closed && ['pending', 'changes_requested', 'repair_failed'].includes(finding.issueStatus) && !finding.deferred;
    const canHumanTakeover = !closed && ['pending', 'changes_requested', 'repair_failed', 'awaiting_verification'].includes(finding.issueStatus);
    const canResumeReview = !closed && (
        finding.deferred
        || finding.issueStatus === 'rejected'
        || finding.issueStatus === 'human_takeover'
        || (finding.issueStatus === 'repair_failed' && canResumeFromRepairFailed)
    );
    const reasonRequired = ['accept_as_is', 'defer', 'resume_review', 'add_repair_hint', 'external_completed'].includes(action)
        || (action === 'human_takeover' && finding.issueStatus === 'awaiting_verification');

    return (
        <Panel title={`${finding.priority} · ${finding.title}`} extra={<div className={s.actions}><Badge value={finding.issueStatus} />{finding.deferred && <Badge value="deferred" />}<Badge value={finding.issueKind} /></div>}>
            <div className={s.form}>
                <p>{finding.summary}</p>
                {finding.dependsOn && <small>依赖前置问题：{finding.dependsOn}</small>}
                {finding.id !== selected && <Link to={candidateUrl(projectId, finding.id)}>查看问题详情、证据与历史 →</Link>}
                {finding.decision?.reason && <p>处置说明：{finding.decision.reason}</p>}
                {(finding.decision?.reviewAfter || finding.decision?.reviewWhen) && (
                    <small>延期复查：{[finding.decision.reviewAfter, finding.decision.reviewWhen].filter(Boolean).join(' · ')}</small>
                )}
                {finding.repairPlan && <details><summary>修复方案与验收</summary><Markdown skipHtml>{finding.repairPlan}</Markdown></details>}
                {finding.options.length > 0 && (
                    <div className={s.actions}>
                        {finding.options.map((option, index) => {
                            const isSelected = finding.id === selected && option.optionId === selectedOption;
                            const tag = option.banned ? ' [已封禁]' : '';
                            return isSelected ? (
                                <strong key={option.optionId}>{option.optionId}（patch {option.patchId}）· {option.tradeoff}{tag}</strong>
                            ) : (
                                <Link
                                    key={option.optionId}
                                    className={s.button}
                                    to={`${candidateUrl(projectId, finding.id)}?optionId=${encodeURIComponent(option.optionId)}&patchId=${option.patchId}`}
                                >
                                    {finding.options.length === 1 ? '查看补丁' : `方案 ${index + 1} (${option.optionId})`} · {option.tradeoff}{tag}
                                </Link>
                            );
                        })}
                    </div>
                )}
                <ErrorBox error={run.error} />
                <div className={s.actions}>
                    {canAcceptAsIs && <button disabled={disabled} onClick={() => setAction('accept_as_is')}>接受现状</button>}
                    {canDefer && <button disabled={disabled} onClick={() => setAction('defer')}>延期</button>}
                    {canHumanTakeover && (
                        <button
                            disabled={disabled}
                            onClick={() => finding.issueStatus === 'awaiting_verification' ? setAction('human_takeover') : run.mutate({ action: 'human_takeover' })}
                        >
                            {finding.issueStatus === 'awaiting_verification' ? '撤回至人工接手' : '人工接手'}
                        </button>
                    )}
                    {canResumeReview && <button disabled={disabled} onClick={() => setAction('resume_review')}>{finding.deferred ? '解除延期' : '恢复审核'}</button>}
                    {finding.issueStatus === 'human_takeover' && <button disabled={disabled} onClick={() => setAction('add_repair_hint')}>提交修复线索</button>}
                    {finding.issueStatus === 'human_takeover' && <button disabled={disabled} onClick={() => setAction('external_completed')}>反馈外部完成</button>}
                    <button onClick={() => void navigator.clipboard.writeText([
                        finding.title,
                        finding.findingId,
                        `基线 ${finding.baseRevision ?? ''}`,
                        finding.targetFiles.join('\n'),
                        finding.summary,
                        finding.repairPlan ?? '',
                    ].join('\n\n')).then(() => setCopied('已复制')).catch(() => setCopied('复制失败'))}>复制交接内容</button>
                    <span role="status">{copied}</span>
                </div>
                {finding.repairHints.length > 0 && <ul>{finding.repairHints.map((hint, index) => <li key={index}>{hint}</li>)}</ul>}
                {action && (
                    <form
                        className={s.form}
                        onSubmit={event => {
                            event.preventDefault();
                            run.mutate({
                                action,
                                ...(action === 'add_repair_hint' ? { hint: reason.trim() } : reason.trim() ? { reason: reason.trim() } : {}),
                                ...(action === 'defer' && reviewAfter ? { reviewAfter } : {}),
                                ...(action === 'defer' && reviewWhen.trim() ? { reviewWhen: reviewWhen.trim() } : {}),
                            });
                        }}
                    >
                        <label>
                            {action === 'add_repair_hint' ? '修复线索' : action === 'external_completed' ? '外部完成说明' : '处置理由'}
                            <textarea required={reasonRequired} value={reason} onChange={event => setReason(event.target.value)} />
                        </label>
                        {action === 'defer' && (
                            <>
                                <label>复查日期<input type="date" value={reviewAfter} onChange={event => setReviewAfter(event.target.value)} /></label>
                                <label>复查条件<input value={reviewWhen} onChange={event => setReviewWhen(event.target.value)} /></label>
                            </>
                        )}
                        <div className={s.actions}>
                            <button disabled={disabled || (reasonRequired && !reason.trim())}>保存</button>
                            <button type="button" onClick={() => { setAction(''); setReason(''); }}>取消</button>
                        </div>
                    </form>
                )}
            </div>
        </Panel>
    );
}

function Queue() {
    const projects = useProjects();
    const [projectId, setProjectId] = useState(''), [status, setStatus] = useState(''), [search, setSearch] = useState('');
    const views = projects.data?.projects ?? [];
    const selectedViews = views.filter(view => !projectId || view.project.projectId === projectId);
    const findings = selectedViews.flatMap(view => (view.snapshot?.findings ?? []).map(item => ({
        finding: item as unknown as FindingView,
        projectId: view.project.projectId,
        writable: view.writable,
    })));
    const items = selectedViews.flatMap(view => (view.snapshot?.queue ?? []).map(item => ({
        ...item,
        projectId: view.project.projectId,
        projectName: view.project.name,
    } as unknown as QueueItem)))
        .filter(item => (!status || item.status === status) && `${item.title} ${item.id} ${item.owner} ${item.findingId}`.toLowerCase().includes(search.toLowerCase()));

    const filteredFindings = findings.filter(({ finding }) =>
        (!status || finding.issueStatus === status)
        && `${finding.title} ${finding.findingId} ${finding.id} ${finding.owner}`.toLowerCase().includes(search.toLowerCase()),
    );

    return (
        <>
            <Heading eyebrow="REVIEW QUEUE" title="问题队列">从问题出发，逐项查看方案、代码与人工判断。</Heading>
            <ErrorBox error={projects.error} />
            <div className={s.filters}>
                <label className={s.search}>搜索<input placeholder="标题、编号或负责人" value={search} onChange={event => setSearch(event.target.value)} /></label>
                <label>
                    项目
                    <select value={projectId} onChange={event => setProjectId(event.target.value)}>
                        <option value="">全部项目</option>
                        {views.map(view => <option key={view.project.projectId} value={view.project.projectId}>{view.project.name}</option>)}
                    </select>
                </label>
                <label>
                    状态
                    <select value={status} onChange={event => setStatus(event.target.value)}>
                        <option value="">全部状态</option>
                        {REVIEW_STATUSES.map(value => <option key={value} value={value}>{label(value)}</option>)}
                    </select>
                </label>
            </div>
            {filteredFindings.map(entry => <FindingCard key={`${entry.projectId}/${entry.finding.id}/${entry.finding.recordRevision}`} {...entry} />)}
            <Panel title={`全部问题列表（${items.length}）`}><CandidateList items={items} loading={projects.isPending} /></Panel>
        </>
    );
}

function Projects() {
    const client = useQueryClient(), projects = useProjects();
    const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'), refetchInterval: 5000 });
    const [open, setOpen] = useState(false), [name, setName] = useState(''), [nodeId, setNodeId] = useState(''), [workspaceId, setWorkspaceId] = useState('');
    const add = useMutation({ mutationFn: () => request('/projects', 'POST', { name, nodeId, workspaceId }), onSuccess: () => { setOpen(false); setName(''); void client.invalidateQueries({ queryKey: ['projects'] }); } });
    const selected = nodes.data?.nodes.find(node => node.nodeId === nodeId);
    return (
        <>
            <Heading eyebrow="PROJECTS" title="项目管理" actions={<button className={s.primary} onClick={() => setOpen(!open)}>＋ 接入项目</button>}>将业务项目绑定到节点已准备好的工作副本。</Heading>
            <ErrorBox error={projects.error ?? nodes.error} />
            {open && (
                <Panel title="接入项目">
                    <form className={s.form} onSubmit={event => { event.preventDefault(); add.mutate(); }}>
                        <label>项目名称<input required value={name} onChange={event => setName(event.target.value)} /></label>
                        <label>执行节点<select required value={nodeId} onChange={event => { setNodeId(event.target.value); setWorkspaceId(''); }}><option value="">选择在线节点</option>{nodes.data?.nodes.filter(node => node.online && node.compatible).map(node => <option key={node.nodeId} value={node.nodeId}>{node.name}</option>)}</select></label>
                        <label>工作副本<select required value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">选择节点工作副本</option>{selected?.workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.label} · {workspace.vcsType} / {workspace.target}</option>)}</select></label>
                        <ErrorBox error={add.error} />
                        <div className={s.actions}><button className={s.primary} disabled={add.isPending}>确认接入</button><button type="button" onClick={() => setOpen(false)}>取消</button></div>
                    </form>
                </Panel>
            )}
            <div className={s.projectGrid}>
                {projects.data?.projects.map(view => (
                    <Link className={s.projectCard} to={`/projects/${view.project.projectId}`} key={view.project.projectId}>
                        <div className={s.actions}><span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span><Badge value={view.freshness} /></div>
                        <h2>{view.project.name}</h2>
                        <p>{view.project.vcsType.toUpperCase()} · {view.project.target}</p>
                        <div className={s.cardCounts}>
                            <strong>{view.snapshot?.queue.filter(item => !item.local && ['pending', 'changes_requested', 'repair_failed'].includes(String(item.status))).length ?? 0}<small>待处理问题</small></strong>
                            <strong>{view.snapshot?.audits.length ?? 0}<small>审查记录</small></strong>
                        </div>
                        <footer>上次同步 {time(view.lastSyncedAt)}<span>→</span></footer>
                    </Link>
                ))}
            </div>
            {projects.data?.projects.length === 0 && <Empty>先到执行节点创建凭据，并在 DSH 上配置工作副本。</Empty>}
        </>
    );
}

function ProjectPage() {
    const { projectId = '' } = useParams();
    const client = useQueryClient(), navigate = useNavigate();
    const project = useQuery({ queryKey: ['project', projectId], queryFn: ({ signal }) => request<ProjectDetail>(`/projects/${projectId}`, 'GET', undefined, signal), refetchInterval: 4000 });
    const [name, setName] = useState(''), [note, setNote] = useState('');
    const update = useMutation({ mutationFn: (value: unknown) => request(`/projects/${projectId}`, 'PUT', value), onSuccess: () => { void client.invalidateQueries({ queryKey: ['project', projectId] }); void client.invalidateQueries({ queryKey: ['projects'] }); } });
    const run = useMutation({
        mutationFn: (operation: string) => operation === 'audit-self-test'
            ? triggerSelfTest(projectId)
            : command(projectId, operation, operation === 'audit' ? { targetPath: '.', note } : {}),
        onSuccess: () => navigate(`/tasks?projectId=${projectId}`),
    });
    const view = project.data;
    const counts = view?.snapshot?.counts;
    return (
        <>
            <Heading eyebrow="PROJECT" title={view?.project.name ?? '项目详情'} actions={<Link className={s.button} to={`/tasks?projectId=${projectId}`}>任务记录 ↗</Link>}>{view ? `${view.project.vcsType.toUpperCase()} · ${view.project.target}` : '正在读取项目…'}</Heading>
            <ErrorBox error={project.error ?? update.error ?? run.error} />
            {view && (
                <>
                    <div className={s.notice}><Badge value={view.freshness} />上次同步 {time(view.lastSyncedAt)}{!view.project.enabled && ' · 项目已停用'}</div>
                    {view.workspaceIssue && <ErrorBox error={view.workspaceIssue} />}
                    {counts && (
                        <div className={s.actions}>
                            {REVIEW_STATUSES.map(statusKey => (
                                <span key={statusKey} className={s.badge}>{label(statusKey)} {counts[statusKey] ?? 0}</span>
                            ))}
                        </div>
                    )}
                    <div className={s.twoColumns}>
                        <Panel title="执行与同步">
                            <div className={s.form}>
                                <label>本次审查补充说明<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="可选：需要重点关注的模块与约束" /></label>
                                <div className={s.actions}>
                                    <button className={s.primary} disabled={!view.writable || run.isPending} onClick={() => run.mutate('audit')}>开始全量审查</button>
                                    <button disabled={!view.online || !view.project.enabled || Boolean(view.workspaceIssue) || run.isPending} onClick={() => run.mutate('sync')}>同步仓库</button>
                                    <button disabled={!view.writable || run.isPending} onClick={() => run.mutate('reviewers-init')}>初始化 reviewers.yml</button>
                                    <button disabled={!view.writable || run.isPending} onClick={() => run.mutate('audit-self-test')}>审查流程自检</button>
                                </div>
                                {!view.writable && <small>节点离线、快照过期或存在未决任务时，暂不能开始新审查。</small>}
                            </div>
                        </Panel>
                        <Panel title="项目设置">
                            <form className={s.form} onSubmit={event => { event.preventDefault(); update.mutate({ name }); }}>
                                <label>项目名称<input placeholder={view.project.name} value={name} onChange={event => setName(event.target.value)} required /></label>
                                <div className={s.actions}>
                                    <button disabled={update.isPending}>保存名称</button>
                                    <button type="button" onClick={() => update.mutate({ enabled: !view.project.enabled })}>{view.project.enabled ? '停用项目' : '启用项目'}</button>
                                </div>
                                <small>节点 {view.project.nodeId}<br />工作副本 {view.project.workspaceId}</small>
                            </form>
                        </Panel>
                    </div>
                    <AuditPlansPanel key={projectId} projectId={projectId} plans={view.auditPlans} />
                    <Panel title="问题列表"><CandidateList items={(view.snapshot?.queue ?? []).map(item => ({ ...item, projectId, projectName: view.project.name } as unknown as QueueItem))} /></Panel>
                </>
            )}
        </>
    );
}

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const timeZones = [...new Set(['UTC', browserTimeZone, ...(Intl.supportedValuesOf?.('timeZone') ?? [])])].sort();

function describePlan({ startTime, timeZone, recurrence }: AuditPlanSettings) {
    const when = recurrence.kind === 'daily' ? '每天'
        : recurrence.kind === 'weekly' ? (recurrence.weekdays.map(day => weekdays[day - 1]).join('、') || '请选择星期')
            : `从 ${recurrence.startDate || '起始日期'} 起，每隔 ${recurrence.days || 'N'} 天`;
    return `${when} ${startTime}（${timeZone}）`;
}

function settingsForPlan({ name, enabled, startTime, timeZone, recurrence, note }: AuditPlan): AuditPlanSettings {
    return { name, enabled, startTime, timeZone, recurrence, note };
}

function AuditPlansPanel({ projectId, plans }: { projectId: string; plans: AuditPlan[] }) {
    const client = useQueryClient();
    const [editing, setEditing] = useState<{ plan?: Pick<AuditPlan, 'planId' | 'version'>; settings: AuditPlanSettings } | null>(null);
    const [status, setStatus] = useState('');
    const mutate = useMutation({
        mutationFn: async (action: { settings: AuditPlanSettings; plan?: Pick<AuditPlan, 'planId' | 'version'> }
            | { planId: string; enabled: boolean } | { deleteId: string }) => {
            if ('deleteId' in action) {
                await deleteAuditPlan(projectId, action.deleteId);
                return { deleteId: action.deleteId };
            }
            if ('enabled' in action) return setAuditPlanEnabled(projectId, action.planId, action.enabled);
            return saveAuditPlan(projectId, action.settings, action.plan);
        },
        onSuccess: async result => {
            const queryKey = ['project', projectId];
            await client.cancelQueries({ queryKey, exact: true });
            client.setQueryData<ProjectDetail>(queryKey, current => {
                if (!current) return current;
                const plans = current.auditPlans;
                if ('deleteId' in result) return { ...current, auditPlans: plans.filter(plan => plan.planId !== result.deleteId) };
                const updated = result.auditPlan;
                return {
                    ...current,
                    auditPlans: plans.some(plan => plan.planId === updated.planId)
                        ? plans.map(plan => plan.planId === updated.planId ? updated : plan)
                        : [...plans, updated],
                };
            });
            setEditing(null);
            setStatus('deleteId' in result ? '计划已删除' : '计划已保存');
            void client.invalidateQueries({ queryKey, exact: true });
        },
    });
    const draft = editing?.settings;
    function edit(values: Partial<AuditPlanSettings>) {
        setEditing(current => current && { ...current, settings: { ...current.settings, ...values } });
    }
    function selectFrequency(kind: AuditRecurrence['kind']) {
        if (!draft) return;
        let timeZone = draft.timeZone.trim();
        try { new Intl.DateTimeFormat('sv-SE', { timeZone }); }
        catch { timeZone = browserTimeZone; }
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        const recurrence: AuditRecurrence = kind === 'daily' ? { kind }
            : kind === 'weekly' ? { kind, weekdays: [] } : { kind, days: 3, startDate: today.format(new Date()) };
        edit({ recurrence });
    }
    const busy = mutate.isPending;
    const actionsDisabled = busy || Boolean(editing);

    return (
        <Panel title="定时审查" extra={<button type="button" className={s.primary} disabled={actionsDisabled} onClick={() => {
            mutate.reset();
            setStatus('');
            setEditing({ settings: { name: '', enabled: true, startTime: '02:00', timeZone: browserTimeZone, recurrence: { kind: 'daily' }, note: '' } });
        }}>新增计划</button>}>
            {!editing && <ErrorBox error={mutate.error} />}
            {status && <p className={s.scheduleStatus} role="status">{status}</p>}
            {editing && draft && (
                <form className={`${s.form} ${s.scheduleEditor}`} onSubmit={event => {
                    event.preventDefault();
                    setStatus('');
                    if (!busy) mutate.mutate({ plan: editing.plan, settings: { ...draft, timeZone: draft.timeZone.trim() } });
                }}>
                    <h3>{editing.plan ? '编辑计划' : '新增定时计划'}</h3>
                    <fieldset className={s.scheduleEditorFields} disabled={busy}>
                        <div className={s.scheduleFields}>
                            <label>计划名称<input required autoFocus maxLength={80} value={draft.name} onChange={event => edit({ name: event.target.value })} placeholder="例如 每周权限检查" /></label>
                            <label>执行频率<select value={draft.recurrence.kind} onChange={event => selectFrequency(event.target.value as AuditRecurrence['kind'])}><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">每隔 N 天</option></select></label>
                        </div>
                        {draft.recurrence.kind === 'weekly' && (
                            <fieldset className={s.scheduleWeekdays}>
                                <legend>星期</legend>
                                <div className={s.actions}>
                                    {weekdays.map((day, index) => {
                                        const dayNumber = index + 1;
                                        const selected = draft.recurrence.kind === 'weekly' ? draft.recurrence.weekdays : [];
                                        return (
                                            <button key={day} type="button" aria-pressed={selected.includes(dayNumber)} onClick={() => edit({
                                                recurrence: {
                                                    kind: 'weekly',
                                                    weekdays: selected.includes(dayNumber) ? selected.filter(v => v !== dayNumber) : [...selected, dayNumber].sort((a, b) => a - b),
                                                },
                                            })}>{day}</button>
                                        );
                                    })}
                                </div>
                                <div className={s.actions}>
                                    <button type="button" className={s.textButton} onClick={() => edit({ recurrence: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5] } })}>选工作日</button>
                                    <button type="button" className={s.textButton} onClick={() => edit({ recurrence: { kind: 'weekly', weekdays: [6, 7] } })}>选周末</button>
                                </div>
                            </fieldset>
                        )}
                        {draft.recurrence.kind === 'interval' && (
                            <div className={s.scheduleFields}>
                                <label>间隔天数<input type="number" min={2} max={365} required value={draft.recurrence.days || ''} onChange={event => edit({ recurrence: { kind: 'interval', days: event.target.valueAsNumber, startDate: draft.recurrence.kind === 'interval' ? draft.recurrence.startDate : '' } })} /></label>
                                <label>起始日期<input type="date" required value={draft.recurrence.startDate} onChange={event => edit({ recurrence: { kind: 'interval', startDate: event.target.value, days: draft.recurrence.kind === 'interval' ? draft.recurrence.days : 3 } })} /></label>
                            </div>
                        )}
                        <div className={s.scheduleFields}>
                            <label>开始时间<input type="time" required value={draft.startTime} onChange={event => edit({ startTime: event.target.value })} /></label>
                            <label>时区<input list="audit-plan-zones" required value={draft.timeZone} spellCheck={false} onChange={event => edit({ timeZone: event.target.value })} /><datalist id="audit-plan-zones">{timeZones.map(zone => <option key={zone} value={zone} />)}</datalist></label>
                        </div>
                        <label>审查要求<textarea maxLength={4000} value={draft.note} placeholder="可选。填写本轮全仓审查要额外关注的问题。" onChange={event => edit({ note: event.target.value })} /></label>
                        <label className={s.check}><input type="checkbox" checked={draft.enabled} onChange={event => edit({ enabled: event.target.checked })} />启用计划</label>
                    </fieldset>
                    <p className={s.schedulePreview} aria-live="polite">{describePlan(draft)}</p>
                    <ErrorBox error={mutate.error} />
                    <div className={s.actions}>
                        <button className={s.primary} disabled={busy || !draft.name.trim() || !draft.timeZone.trim() || (draft.recurrence.kind === 'weekly' && !draft.recurrence.weekdays.length)}>{busy ? '正在保存…' : '保存计划'}</button>
                        <button type="button" disabled={busy} onClick={() => { mutate.reset(); setEditing(null); }}>取消</button>
                    </div>
                </form>
            )}
            {plans.length > 0 ? (
                <ul className={s.scheduleList}>
                    {plans.map(plan => {
                        const run = plan.lastRun;
                        return (
                            <li key={plan.planId}>
                                <article className={s.schedulePlan}>
                                    <div className={s.schedulePlanHead}>
                                        <div><h3>{plan.name}</h3><p>{describePlan(plan)}</p></div>
                                        <small>{plan.enabled ? '已启用' : '已暂停'}</small>
                                    </div>
                                    {plan.note && <details className={s.scheduleRequirements}><summary>审查要求</summary><p>{plan.note}</p></details>}
                                    <div className={s.scheduleSummary}>
                                        <p>下次审查 {plan.nextRunAt ? time(plan.nextRunAt, plan.timeZone) : '暂无安排'}</p>
                                        <div className={s.actions}><p>最近一次计划 {time(run?.scheduledAt, plan.timeZone)}</p>{run && <Badge value={run.state} />}{run?.commandId && <Link to={`/tasks?projectId=${projectId}`}>查看项目任务</Link>}</div>
                                        {run?.reason && <p>{run.reason}</p>}
                                    </div>
                                    <div className={s.actions}>
                                        <button type="button" disabled={actionsDisabled} onClick={() => { mutate.reset(); setStatus(''); setEditing({ plan: { planId: plan.planId, version: plan.version }, settings: settingsForPlan(plan) }); }}>编辑</button>
                                        <button type="button" disabled={actionsDisabled} onClick={() => { setStatus(''); mutate.mutate({ planId: plan.planId, enabled: !plan.enabled }); }}>{plan.enabled ? '暂停' : '恢复'}</button>
                                        <button type="button" disabled={actionsDisabled} onClick={() => { if (window.confirm(`删除「${plan.name}」？已受理的审查会继续执行。`)) { setStatus(''); mutate.mutate({ deleteId: plan.planId }); } }}>删除</button>
                                    </div>
                                </article>
                            </li>
                        );
                    })}
                </ul>
            ) : !editing && <Empty>暂无定时计划</Empty>}
            {plans.length > 0 && <p className={s.scheduleStatus}>到达设定时间后最多等待 30 分钟。到期未受理时跳过本轮。</p>}
        </Panel>
    );
}

function Nodes() {
    const client = useQueryClient();
    const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'), refetchInterval: 5000 });
    const [name, setName] = useState(''), [credential, setCredential] = useState<{ nodeId: string; token: string } | null>(null);
    const add = useMutation({ mutationFn: () => request<{ nodeId: string; token: string }>('/nodes', 'POST', { name }), onSuccess: value => { setCredential(value); setName(''); void client.invalidateQueries({ queryKey: ['nodes'] }); } });
    const revoke = useMutation({ mutationFn: (id: string) => request(`/nodes/${id}/revoke`, 'POST'), onSuccess: () => { void client.invalidateQueries({ queryKey: ['nodes'] }); } });
    return (
        <>
            <Heading eyebrow="EXECUTION NODES" title="执行节点">每台机器上的 DSH 主动连接中央服务，仓库凭据保留在节点。</Heading>
            <ErrorBox error={nodes.error ?? add.error ?? revoke.error} />
            {credential && (
                <Panel title="节点凭据 · 仅展示这一次">
                    <div className={s.form}>
                        <p>把 Token 保存到节点的环境变量或凭据服务，再在 managed-node.json 中引用。</p>
                        <label>节点 ID<input readOnly value={credential.nodeId} /></label>
                        <label>Token<input readOnly value={credential.token} onFocus={event => event.target.select()} /></label>
                        <button onClick={() => setCredential(null)}>已保存，关闭凭据</button>
                    </div>
                </Panel>
            )}
            <Panel title="注册新节点">
                <form className={s.inlineForm} onSubmit={event => { event.preventDefault(); add.mutate(); }}>
                    <label className={s.grow}>节点名称<input required placeholder="例如：Linux 构建机 01" value={name} onChange={event => setName(event.target.value)} /></label>
                    <button className={s.primary} disabled={add.isPending || Boolean(credential)}>创建节点凭据</button>
                </form>
            </Panel>
            <div className={s.projectGrid}>
                {nodes.data?.nodes.map(node => (
                    <section className={s.projectCard} key={node.nodeId}>
                        <div className={s.actions}><span className={s.projectIcon}>⌘</span><Badge value={node.online ? 'online' : 'offline'} /></div>
                        <h2>{node.name}</h2>
                        <p>{node.platform || '等待首次注册'} · 协议 {node.protocolVersion ?? '—'}{node.lastSeenAt && !node.compatible ? ' · 版本不兼容' : ''}</p>
                        <div className={s.nodeWorkspaces}>
                            {node.workspaces.map(workspace => (
                                <div key={workspace.workspaceId}>
                                    <b>{workspace.label}</b>
                                    <small>{workspace.vcsType.toUpperCase()} · {workspace.target}</small>
                                </div>
                            ))}
                            {node.workspaces.length === 0 && <small>尚未注册工作副本</small>}
                        </div>
                        <footer>
                            <span>{node.enabled ? time(node.lastSeenAt) : '凭据已吊销'}</span>
                            <button className={s.textButton} disabled={!node.enabled || revoke.isPending} onClick={() => { if (window.confirm(`吊销“${node.name}”的凭据后，该节点将无法连接。确认吊销？`)) revoke.mutate(node.nodeId); }}>吊销</button>
                        </footer>
                    </section>
                ))}
            </div>
            {nodes.data?.nodes.length === 0 && <Empty>创建第一份节点凭据，连接你的 DSH 实例。</Empty>}
        </>
    );
}

function Reports() {
    const projects = useProjects();
    const [params, setParams] = useSearchParams();
    const projectId = params.get('projectId') ?? '';
    const auditId = params.get('auditId') ?? '';
    const hasSelection = Boolean(projectId && auditId);
    const queue = projects.data?.projects.find(view => view.project.projectId === projectId)?.snapshot?.queue;
    const report = useQuery({
        queryKey: ['report', projectId, auditId],
        queryFn: ({ signal }) => detail<{
            body: string;
            meta: {
                auditId: string;
                scope: string;
                baseRevision: string;
                trigger: string;
                issues: string[];
            };
        }>(entityId(projectId, 'projectId'), 'audit', { id: auditId }, signal),
        enabled: hasSelection,
    });

    return (
        <>
            <Heading eyebrow="AUDIT REPORTS" title="审查报告">保留每次全量审查的范围、发现索引与核验摘要。</Heading>
            <ErrorBox error={projects.error ?? report.error} />
            <div className={s.twoColumns}>
                <Panel title="审查记录">
                    <div className={s.stack}>
                        {projects.data?.projects.flatMap(view => (view.snapshot?.audits ?? []).map(audit => {
                            const id = String(audit.auditId);
                            const selected = view.project.projectId === projectId && id === auditId;
                            return (
                                <button
                                    key={`${view.project.projectId}/${id}`}
                                    className={selected ? `${s.reportRow} ${s.selected}` : s.reportRow}
                                    aria-pressed={selected}
                                    onClick={() => setParams({ projectId: view.project.projectId, auditId: id }, { replace: selected })}
                                >
                                    <span><b>{id}</b><small>{view.project.name} · 范围 {String(audit.scope)}{audit.trigger === 'scheduled' && ' · 定时触发'}</small><small>{time(String(audit.createdAt))}</small></span>
                                    <span>{String(audit.issueCount)} 项 →</span>
                                </button>
                            );
                        }))}
                        {projects.data?.projects.every(view => !view.snapshot?.audits.length) && <Empty>尚无已同步审查报告。</Empty>}
                    </div>
                </Panel>
                <Panel title={hasSelection ? auditId : '报告详情'}>
                    {!hasSelection ? <Empty>选择左侧记录，查看报告内容。</Empty>
                        : report.isPending ? <Empty>正在向节点读取该版本报告…</Empty>
                            : report.data ? (
                                <div className={s.document}>
                                    {report.data.meta.issues.length > 0 && (
                                        <article>
                                            <h3>本轮索引问题（{report.data.meta.issues.length}）</h3>
                                            <ul>
                                                {report.data.meta.issues.map(id => {
                                                    const candidate = queue?.find(item => item.id === id);
                                                    const title = typeof candidate?.title === 'string' && candidate.title ? candidate.title : id;
                                                    return <li key={id}>{candidate?.localOnly ? title : <Link to={candidateUrl(projectId, id)}>{title}</Link>}</li>;
                                                })}
                                            </ul>
                                        </article>
                                    )}
                                    <pre>{report.data.body}</pre>
                                </div>
                            ) : <button onClick={() => void report.refetch()}>重新读取</button>}
                </Panel>
            </div>
        </>
    );
}

function Tasks() {
    const location = useLocation(), client = useQueryClient();
    const params = new URLSearchParams(location.search);
    const projectId = params.get('projectId') ?? '', linkedId = params.get('commandId') ?? '';
    const [selectedId, setSelectedId] = useState(''), [confirmStopped, setConfirmStopped] = useState(false);
    const tasks = useQuery({ queryKey: ['tasks', projectId], queryFn: () => request<{ tasks: CommandRecord[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`), refetchInterval: 2000 });
    const targetId = selectedId || linkedId;
    const fromList = tasks.data?.tasks.find(task => task.commandId === targetId);
    const linkedTask = useQuery({
        queryKey: ['tasks', 'command', targetId],
        queryFn: () => request<{ command: CommandRecord }>(`/commands/${encodeURIComponent(targetId)}`),
        enabled: Boolean(targetId && !fromList && tasks.isSuccess),
        refetchInterval: 2000,
    });
    const selected = targetId ? fromList ?? linkedTask.data?.command : tasks.data?.tasks[0];
    const logs = useQuery({
        queryKey: ['logs', selected?.commandId, selected?.state],
        queryFn: () => request<{ log: string[]; logStartOffset: number }>(`/tasks/${selected!.commandId}/logs`),
        enabled: Boolean(selected),
        refetchInterval: selected?.state === 'completed' ? false : 2000,
    });
    const control = useMutation({
        mutationFn: (operation: string) => request(`/commands/${selected!.commandId}/${operation}`, 'POST', operation === 'recover' ? { confirmStopped } : {}),
        onSuccess: () => { setConfirmStopped(false); void client.invalidateQueries({ queryKey: ['tasks'] }); },
    });
    return (
        <>
            <Heading eyebrow="TASK HISTORY" title="任务记录" actions={projectId ? <Link className={s.button} to="/tasks">查看全部项目</Link> : null}>业务执行结果与远端交付状态分别记录。</Heading>
            <ErrorBox error={tasks.error ?? linkedTask.error ?? logs.error ?? control.error} />
            <div className={s.taskColumns}>
                <Panel title="指令记录">
                    <div className={s.stack}>
                        {tasks.data?.tasks.map(task => (
                            <button
                                className={`${s.reportRow} ${selected?.commandId === task.commandId ? s.selected : ''}`}
                                key={task.commandId}
                                onClick={() => { setSelectedId(task.commandId); setConfirmStopped(false); }}
                            >
                                <span><b>{task.operation}</b>{task.scheduledAudit && ' · 定时触发'}<small>{task.actor.reviewIdentity} · {time(task.createdAt)}</small><small>{task.projectId.slice(0, 12)}</small></span>
                                <Badge value={task.state} />
                            </button>
                        ))}
                        {tasks.data?.tasks.length === 0 && <Empty>还没有任务记录。</Empty>}
                    </div>
                </Panel>
                <Panel title={selected ? `${selected.operation} · ${selected.commandId.slice(0, 8)}` : '执行详情'}>
                    {selected ? (
                        <div className={s.form}>
                            <div className={s.actions}>
                                <Badge value={selected.state} />
                                {selected.result && <><Badge value={selected.result.outcome.status} /><Badge value={selected.result.delivery.state} delivery /></>}
                            </div>
                            {selected.scheduledAudit && <p>定时触发 · 计划开始 {time(selected.scheduledAudit.scheduledAt)} · 最晚受理 {time(selected.scheduledAudit.expiresAt)}</p>}
                            <p>{String(selected.result?.outcome.message ?? selected.result?.outcome.detail ?? '')}</p>
                            {typeof selected.result?.outcome.sessionId === 'string' && <div className={s.mono}>DSH 审查会话 {selected.result.outcome.sessionId}</div>}
                            {selected.result?.delivery.commitRevision && <div className={s.mono}>原提交 {selected.result.delivery.commitRevision}</div>}
                            {selected.result?.delivery.reason && <p>{selected.result.delivery.reason}</p>}
                            {selected.state !== 'completed' && selected.state !== 'recovery_required' && (
                                <button disabled={control.isPending || selected.cancelRequested} onClick={() => control.mutate('cancel')}>
                                    {selected.cancelRequested ? '已请求取消，等待节点回报' : '请求取消'}
                                </button>
                            )}
                            {selected.state === 'recovery_required' && (
                                <div className={s.notice}>
                                    <p>恢复会核验原执行与交付。会话停止后，外部工具仍可能留下改动。如果工具结果未知，请先核对工作副本、外部状态和工具备份，再请求核验。</p>
                                    <label className={s.check}>
                                        <input type="checkbox" checked={confirmStopped} onChange={event => setConfirmStopped(event.target.checked)} />
                                        {typeof selected.result?.outcome.sessionId === 'string' ? '我已确认旧执行已停止，并核对过结果未知的外部操作' : '我已确认旧执行已停止'}
                                    </label>
                                    <button disabled={!confirmStopped || control.isPending} onClick={() => control.mutate('recover')}>
                                        {typeof selected.result?.outcome.sessionId === 'string' ? '核验原审查会话与工作副本' : '核验并重试原提交交付'}
                                    </button>
                                </div>
                            )}
                            <h3>执行日志</h3>
                            <pre className={s.logs}>{logs.data?.log.join('\n') || '尚无日志'}</pre>
                            {selected.result?.outcome.manualPrompt ? <details><summary>人工操作提示</summary><pre className={s.logs}>{String(selected.result.outcome.manualPrompt)}</pre></details> : null}
                            <details><summary>完整业务结果</summary><pre className={s.logs}>{JSON.stringify(selected.result?.outcome ?? {}, null, 2)}</pre></details>
                        </div>
                    ) : <Empty>选择一条任务查看执行结果与日志。</Empty>}
                </Panel>
            </div>
        </>
    );
}

interface CandidateView {
    selection?: { optionId: string; patchId: number };
    selectedOption?: RepairOption;
    selectedPatch?: PatchEntry;
    selectedPatchBanned?: boolean;
    candidate: ReviewCandidate;
    finding: FindingView;
    patchText: string;
    currentBase: string | null;
    isBaseBehind: boolean;
    comments: ReviewComment[];
    validation: string[];
    patchCheck?: OptionPatchCheck;
    approvalCommitRevision?: string;
    approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown';
}

function CandidatePage() {
    const { projectId = '', '*': id = '' } = useParams(), user = useContext(UserContext), client = useQueryClient(), navigate = useNavigate();
    const [selectionParams] = useSearchParams();
    const optionId = selectionParams.get('optionId') ?? '', patchId = selectionParams.get('patchId') ?? '';
    const optionQuery: Record<string, string> = optionId ? { optionId, ...(patchId ? { patchId } : {}) } : {};
    const project = useQuery({ queryKey: ['project', projectId], queryFn: () => request<ProjectView>(`/projects/${projectId}`), refetchInterval: 4000 });
    const candidate = useQuery({
        queryKey: ['candidate', projectId, id, optionId, patchId, project.data?.vcsSnapshot],
        queryFn: ({ signal }) => detail<CandidateView>(projectId, 'candidate', { id, ...optionQuery }, signal),
        enabled: Boolean(project.data?.vcsSnapshot),
    });
    const [tab, setTab] = useState('overview');
    const [comment, setComment] = useState('');
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const [confirmed, setConfirmed] = useState<string[]>([]);
    const [waived, setWaived] = useState<Record<string, string>>({});
    const [approveOpen, setApproveOpen] = useState(false);
    const [diffFrom, setDiffFrom] = useState('0');
    const [draftVersion, setDraftVersion] = useState('');
    const [decisionVersion, setDecisionVersion] = useState('');
    const [approvalVersion, setApprovalVersion] = useState('');
    const [submission, setSubmission] = useState<{ commandId: string; draftKey: string; text: string; anchor: Anchor | null; version: string } | null>(null);
    const [gateConsent, setGateConsent] = useState(false);
    const [gateVersion, setGateVersion] = useState('');
    const draftKey = `review-draft:${user.userId}:${projectId}:${id}`;
    const submitted = submission?.commandId ?? '';
    const [diffFolding, setDiffFolding] = useState<{ scope: string; revision?: number; files: string[] }>({ scope: '', files: [] });
    const activeView = useRef<string | null>(draftKey);
    useEffect(() => { activeView.current = draftKey; return () => { activeView.current = null; }; }, [draftKey]);

    const value = candidate.data, meta = value?.candidate.meta, owner = meta?.owner === user.reviewIdentity;
    const version = meta ? `${meta.recordRevision}/${meta.updatedAt}/${value?.selection?.optionId ?? ''}/${value?.selection?.patchId ?? ''}` : '';
    const finding = value?.finding;
    const selectedOption = value?.selectedOption ?? (value?.selection ? meta?.options.find(opt => opt.id === value.selection?.optionId) : meta?.options[0]);
    const gateChecks = selectedOption?.gateChecks ?? [];
    const approvalTarget = JSON.stringify([id, version, value?.selection]);
    const currentPatchId = value?.selection?.patchId ?? selectedOption?.currentPatch;
    const previousPatches = meta?.patches.filter(patch => patch.id !== currentPatchId && (!selectedOption || patch.optionId === selectedOption.id)) ?? [];
    const diffScope = JSON.stringify([projectId, id, diffFrom, ...(value?.selection ? [value.selection.optionId, value.selection.patchId] : [])]);

    useEffect(() => {
        if (!value) {
            const prefix = `${JSON.stringify([projectId, id]).slice(0, -1)},`;
            setDiffFolding(current => current.scope.startsWith(prefix) ? current : { scope: '', files: [] });
            return;
        }
        setDiffFolding(current => current.scope === diffScope && (meta?.recordRevision === undefined || current.revision === meta.recordRevision)
            ? current : { scope: diffScope, revision: meta?.recordRevision, files: [] });
    }, [diffScope, meta?.recordRevision, value, projectId, id]);

    useEffect(() => {
        try {
            const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
            setComment(saved?.text ?? ''); setAnchor(saved?.anchor ?? null); setDraftVersion(saved?.version ?? '');
        } catch { setComment(''); setAnchor(null); setDraftVersion(''); }
        setConfirmed([]); setWaived({}); setDecisionVersion(''); setApproveOpen(false); setSubmission(null);
    }, [draftKey]);

    const saveDraft = (text: string, position: Anchor | null, stamp: string) => {
        setComment(text); setAnchor(position); setDraftVersion(stamp);
        try {
            if (text || position) sessionStorage.setItem(draftKey, JSON.stringify({ text, anchor: position, version: stamp }));
            else sessionStorage.removeItem(draftKey);
        } catch {}
    };

    const status = useQuery({
        queryKey: ['submitted-comment', submitted],
        queryFn: () => request<{ command: CommandRecord }>(`/commands/${submitted}`),
        enabled: Boolean(submitted),
        refetchInterval: query => query.state.data?.command.state === 'completed' ? false : 2000,
    });

    useEffect(() => {
        if (!submission || submission.draftKey !== draftKey || status.data?.command.state !== 'completed' || status.data.command.result?.outcome.status !== 'COMMITTED') return;
        if (comment === submission.text && draftVersion === submission.version && JSON.stringify(anchor) === JSON.stringify(submission.anchor)) saveDraft('', null, '');
        void client.invalidateQueries({ queryKey: ['project', projectId] });
    }, [status.data?.command.state, submitted]);

    const guard = meta ? { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt } : undefined;
    const run = useMutation({
        mutationFn: ({ operation, payload }: { operation: string; payload?: Record<string, unknown> }) => command(
            projectId,
            operation,
            { id, ...(['approve', 'ai-fix', 'rebase'].includes(operation) ? value?.selection ?? {} : {}), ...payload },
            guard,
        ),
        onMutate: () => ({ draftKey, text: comment, anchor: structuredClone(anchor), version: draftVersion, projectId }),
        onSuccess: (result, _variables, origin) => {
            void client.invalidateQueries({ queryKey: ['tasks'] });
            if (!origin || activeView.current !== origin.draftKey) return;
            if (result.command.operation === 'comments') setSubmission({ commandId: result.command.commandId, ...origin });
            else navigate(`/tasks?projectId=${origin.projectId}`);
        },
    });

    const writable = Boolean(project.data?.writable && owner && !value?.candidate.parseError && !run.isPending);
    const commentable = Boolean(meta && ['pending', 'changes_requested', 'repair_failed'].includes(meta.status));
    const canApproveOption = Boolean(
        meta && meta.status === 'pending' && !finding?.deferred && selectedOption && value?.selection && !value.selectedPatchBanned && gateChecks.length > 0,
    );
    const decisions = meta?.humanDecisions ?? [];
    const allDecisionsCovered = decisions.every(item =>
        decisionVersion === version && (confirmed.includes(item.id) || (waived[item.id] ?? '').trim().length > 0),
    );
    const comparison = useQuery({
        queryKey: ['comparison', projectId, id, optionId, patchId, project.data?.vcsSnapshot, diffFrom],
        queryFn: ({ signal }) => detail<{ unifiedDiff: string; notes?: string[] }>(projectId, 'diff', { id, from: diffFrom, ...optionQuery }, signal),
        enabled: tab === 'diff' && diffFrom !== '0' && Boolean(value),
    });
    const draftStale = Boolean(comment && draftVersion && version && draftVersion !== version);
    const hasDraft = Boolean(comment || anchor);
    const canApprove = gateConsent && gateVersion === version && approvalVersion === approvalTarget
        && canApproveOption && writable && value?.candidate.humanJudgmentDeclared && !value.validation.length && allDecisionsCovered;

    const submitComment = (event: FormEvent) => {
        event.preventDefault();
        run.mutate({
            operation: 'comments',
            payload: {
                content: comment,
                ...(anchor ? { ...anchor, ...(value?.selection ?? {}) } : {}),
            },
        });
    };

    const failedAttempts = (meta?.repairAttempts ?? []).filter(a => a.result !== 'applied');

    return (
        <>
            <Link className={s.back} to="/queue">← 问题队列</Link>
            <Heading eyebrow={`${project.data?.project.name ?? 'PROJECT'} / ISSUE`} title={meta?.title ?? '问题详情'} actions={<button onClick={() => { void project.refetch(); void candidate.refetch(); }}>刷新详情</button>}>{id}</Heading>
            <ErrorBox error={project.error ?? candidate.error ?? run.error ?? status.error} />
            {submitted && (
                <div className={s.notice}>
                    {status.data?.command.result ? `${label(status.data.command.result.outcome.status)}：${String(status.data.command.result.outcome.message ?? '')}` : '审核意见已受理，等待节点提交与同步。'}
                    <Link to={`/tasks?projectId=${projectId}`}>查看任务 →</Link>
                </div>
            )}
            {project.data && (
                <div className={s.notice}>
                    <Badge value={project.data.freshness} />
                    {project.data.freshness !== 'synced' ? '正在展示最后同步的版本。' : '操作提交后，由节点重新校验版本与负责人。'}
                </div>
            )}
            {candidate.isPending ? (
                <Empty>{project.data?.vcsSnapshot ? '正在向节点读取问题与补丁…' : '项目还没有可用快照。'}</Empty>
            ) : value && meta ? (
                <>
                    <div className={s.candidateHeader}>
                        <div className={s.actions}>
                            <Badge value={meta.status} />
                            {finding?.deferred && <Badge value="deferred" />}
                            <Badge value={meta.issueKind} />
                            <span>{meta.priority}</span>
                            <span>负责人 {meta.owner}</span>
                            <span>记录 {meta.recordRevision}</span>
                            <span>{time(meta.updatedAt)}</span>
                        </div>
                        <div className={s.actions}>
                            {!owner && !['approved', 'resolved'].includes(meta.status) && (
                                <button disabled={!project.data?.writable || run.isPending} onClick={() => {
                                    if (window.confirm(`将负责人从“${meta.owner}”改为“${user.reviewIdentity}”？`)) run.mutate({ operation: 'takeover' });
                                }}>接管问题</button>
                            )}
                            {canApproveOption && (
                                <button className={s.primary} disabled={!writable} onClick={() => {
                                    setApprovalVersion(approvalTarget); setGateConsent(false); setGateVersion(''); setApproveOpen(true);
                                }}>批准并应用 ({selectedOption?.id}) →</button>
                            )}
                        </div>
                    </div>
                    {finding && (
                        <FindingCard
                            key={`${finding.id}/${finding.recordRevision}`}
                            finding={finding}
                            projectId={projectId}
                            writable={project.data?.writable && owner}
                            selected={id}
                            selectedOption={value.selection?.optionId}
                        />
                    )}
                    {value.selectedPatchBanned && (
                        <div className={s.error} role="alert">
                            当前方案补丁（{value.selection?.optionId} / patch {value.selection?.patchId}）曾因门禁验证失败被永久封禁，禁止再次批准。请提交意见修订补丁、切换到另一未失败方案或转人工处理。
                        </div>
                    )}
                    {meta.status === 'repair_failed' && failedAttempts.length > 0 && (
                        <Panel title="最近修复失败记录（不会自动重试）">
                            <div className={s.document}>
                                {failedAttempts.map(attempt => (
                                    <article key={attempt.id}>
                                        <h3>尝试 #{attempt.id} · {attempt.optionId} / patch {attempt.patchId} · {attempt.result} ({attempt.applyMode})</h3>
                                        <p>{attempt.evidence}（业务工作区还原：{attempt.restored ? '已彻底还原' : '还原异常，需人工核验'}）</p>
                                    </article>
                                ))}
                            </div>
                        </Panel>
                    )}
                    {meta.status === 'approved' && (
                        <div className={s.notice}>
                            <span>业务提交版本：{value.approvalCommitRevision ?? '尚未派生'}</span>
                            <small>{value.approvalCommitLookup === 'found' ? '已找到业务提交。' : value.approvalCommitLookup === 'ambiguous' ? '匹配到多个业务提交，仅为诊断。' : '暂未确认业务提交版本，仅为诊断。'}</small>
                        </div>
                    )}
                    {value.candidate.parseError && <ErrorBox error={value.candidate.parseError} />}
                    {value.isBaseBehind && commentable && selectedOption && (
                        <div className={s.notice}>
                            业务基线已变化。
                            <button disabled={!writable} onClick={() => run.mutate({ operation: 'rebase' })}>重新基于最新代码生成补丁</button>
                        </div>
                    )}
                    <div className={s.tabs}>
                        {[['overview', '方案与证据'], ['diff', '代码差异'], ['comments', `审核意见 · ${meta.comments.length}`], ['history', '补丁账本与门禁']].map(([key, title]) => (
                            <button key={key} aria-selected={tab === key} onClick={() => setTab(key!)}>{title}</button>
                        ))}
                    </div>
                    <div className={s.reviewColumns}>
                        <div>
                            {tab === 'overview' && (
                                <Panel title="问题与修复方案">
                                    <div className={s.document}>
                                        {[['问题描述', value.candidate.sections.problem], ['根本原因', value.candidate.sections.rootCause], ['修复方案', value.candidate.sections.solution], ['验证证据', value.candidate.sections.evidence]].map(([title, text]) => (
                                            <article key={title}><h3>{title}</h3><div className={s.markdown}><Markdown skipHtml>{text || '未提供'}</Markdown></div></article>
                                        ))}
                                    </div>
                                </Panel>
                            )}
                            {tab === 'diff' && (
                                <Panel title={selectedOption ? `方案 ${selectedOption.id} · patch ${currentPatchId}` : '无补丁方案'} extra={<small>点击代码行添加定位意见</small>}>
                                    {selectedOption ? (
                                        <>
                                            <div className={s.form}>
                                                <label>
                                                    比较范围
                                                    <select value={diffFrom} onChange={event => setDiffFrom(event.target.value)}>
                                                        <option value="0">当前完整补丁</option>
                                                        {previousPatches.map(patch => <option key={patch.id} value={String(patch.id)}>patch {patch.id} → patch {currentPatchId}</option>)}
                                                    </select>
                                                </label>
                                                <ErrorBox error={comparison.error} />
                                                {comparison.isFetching && <small>正在读取版本差异…</small>}
                                                {comparison.data?.notes?.map(note => <small key={note}>{note}</small>)}
                                            </div>
                                            {diffFrom !== '0' && <p className={s.diffNote}>增量比较可在当前版本右侧添加定位意见。</p>}
                                            <Diff
                                                collapsedFiles={diffFolding.scope === diffScope && diffFolding.revision === meta.recordRevision ? diffFolding.files : []}
                                                onCollapsedFilesChange={files => setDiffFolding({ scope: diffScope, revision: meta.recordRevision, files })}
                                                allowLeft={diffFrom === '0'}
                                                text={diffFrom === '0' ? value.patchText : comparison.data?.unifiedDiff ?? ''}
                                                onSelect={selectedLine => { saveDraft(comment, selectedLine, version); setTab('comments'); }}
                                            />
                                        </>
                                    ) : <Empty>当前为纯文字方案（{label(meta.issueKind)}），没有关联补丁。</Empty>}
                                </Panel>
                            )}
                            {tab === 'comments' && (
                                <Panel title="审核意见">
                                    <div className={s.document}>
                                        {value.comments.length ? value.comments.map(item => (
                                            <article key={item.id}>
                                                <div className={s.actions}>
                                                    <b>{item.author}</b>
                                                    <Badge value={item.status} />
                                                    <small>记录 {item.revision}{item.optionId ? ` / ${item.optionId} / patch ${item.patchId}` : ''}</small>
                                                </div>
                                                {item.file && <small className={s.mono}>{item.file}:{item.line} · {item.side}</small>}
                                                <p>{item.content}</p>
                                                {writable && commentable && item.status !== 'resolved' && (
                                                    <button onClick={() => run.mutate({ operation: 'comment-status', payload: { commentId: item.id, status: 'resolved' } })}>标记已解决</button>
                                                )}
                                            </article>
                                        )) : <Empty>还没有审核意见。</Empty>}
                                        <form className={s.commentForm} onSubmit={submitComment}>
                                            {anchor && (
                                                <div className={s.notice}>
                                                    <small>{anchor.file}:{anchor.line} · {anchor.side}</small>
                                                    <button type="button" onClick={() => saveDraft(comment, null, draftVersion)}>移除定位</button>
                                                </div>
                                            )}
                                            <label>新增审核意见<textarea required value={comment} onChange={event => saveDraft(event.target.value, anchor, draftVersion || version)} placeholder="说明问题、期望行为与验证方式…" /></label>
                                            {draftStale && (
                                                <div className={s.notice}>
                                                    版本已更新，草稿保留。请对照新代码检查意见与定位。
                                                    <button type="button" onClick={() => saveDraft(comment, null, version)}>已核对，应用到当前版本</button>
                                                </div>
                                            )}
                                            <small>意见基于当前记录 {meta.recordRevision}。版本冲突时草稿会保留。</small>
                                            <button className={s.primary} disabled={!writable || !commentable || !comment.trim() || draftStale || Boolean(submitted && status.data?.command.state !== 'completed')}>提交意见</button>
                                        </form>
                                    </div>
                                </Panel>
                            )}
                            {tab === 'history' && (
                                <Panel title="补丁账本、门禁与历史">
                                    <div className={s.document}>
                                        <h3>不可变补丁账本</h3>
                                        {meta.patches.length > 0 ? meta.patches.map(patch => (
                                            <article key={patch.id}>
                                                <h4>patch #{patch.id}（{patch.optionId}）· {patch.author}</h4>
                                                <small>{patch.patch} · base {patch.baseRevision} · sha256 {patch.sha256.slice(0, 12)}</small>
                                            </article>
                                        )) : <p>无补丁文件。</p>}
                                        <h3>当前方案门禁命令（明文）</h3>
                                        <pre>{gateChecks.join('\n') || '未配置'}</pre>
                                        {meta.approval && (
                                            <>
                                                <h3>当前批准记录</h3>
                                                <p>{meta.approval.approvedBy} · {time(meta.approval.approvedAt)} · {meta.approval.optionId} / patch {meta.approval.patchId}</p>
                                                <pre>{JSON.stringify(meta.approval.gateResults, null, 2)}</pre>
                                            </>
                                        )}
                                        {meta.approvalHistory.length > 0 && (
                                            <>
                                                <h3>往期批准历史（{meta.approvalHistory.length}）</h3>
                                                <pre>{JSON.stringify(meta.approvalHistory, null, 2)}</pre>
                                            </>
                                        )}
                                    </div>
                                </Panel>
                            )}
                        </div>
                        <aside>
                            <Panel title="人工判断">
                                <div className={s.form}>
                                    {!value.candidate.humanJudgmentDeclared && <ErrorBox error="问题未填写人工判断章节，暂不能批准。" />}
                                    {decisions.length ? decisions.map(item => (
                                        <div key={item.id} className={s.form}>
                                            <label className={s.check}>
                                                <input
                                                    type="checkbox"
                                                    checked={decisionVersion === version && confirmed.includes(item.id)}
                                                    onChange={event => {
                                                        setDecisionVersion(version);
                                                        setConfirmed(current => {
                                                            const base = decisionVersion === version ? current : [];
                                                            return event.target.checked ? [...new Set([...base, item.id])] : base.filter(x => x !== item.id);
                                                        });
                                                    }}
                                                />
                                                <span><b>{item.question}</b>{item.note && <small>{item.note}</small>}</span>
                                            </label>
                                            {!(decisionVersion === version && confirmed.includes(item.id)) && (
                                                <input
                                                    placeholder="或填写放弃理由（选填）"
                                                    value={decisionVersion === version ? (waived[item.id] ?? '') : ''}
                                                    onChange={event => {
                                                        setDecisionVersion(version);
                                                        setWaived(current => ({ ...(decisionVersion === version ? current : {}), [item.id]: event.target.value }));
                                                    }}
                                                />
                                            )}
                                        </div>
                                    )) : <p>当前问题没有待确认的判断项。</p>}
                                    {value.candidate.humanJudgment.map((item, index) => <small key={index}>{item.label} {item.text}</small>)}
                                </div>
                            </Panel>
                            <Panel title="后续操作">
                                <div className={s.form}>
                                    {selectedOption && (
                                        <button disabled={!writable || !commentable || hasDraft || !meta.comments.some(item => item.status !== 'resolved')} onClick={() => run.mutate({ operation: 'ai-fix' })}>
                                            让 AI 按意见修订提案
                                        </button>
                                    )}
                                    {hasDraft && <small>请先提交审核意见草稿，再启动 AI 修订。</small>}
                                    {meta.status === 'changes_requested' && <button disabled={!writable} onClick={() => run.mutate({ operation: 'resume' })}>恢复为待审核</button>}
                                    <small>当前登录身份：{user.reviewIdentity}<br />{owner ? '你是此问题负责人。' : '接管后可提交意见或执行审核。'}</small>
                                </div>
                            </Panel>
                        </aside>
                    </div>
                    {approveOpen && (
                        <div className={s.modalBackdrop}>
                            <section role="dialog" aria-modal="true" aria-labelledby="approve-title" className={s.modal}>
                                <h2 id="approve-title">批准并交付代码</h2>
                                <p>节点将重新校验记录 {meta.recordRevision}（{value.selection?.optionId} / patch {value.selection?.patchId}），执行以下门禁后提交到 {project.data?.project.target}，并{project.data?.project.vcsType === 'git' ? '推送 Git 远端' : '提交 SVN 远端'}。</p>
                                <div>
                                    <h3>将执行的完整门禁命令（明文展示）</h3>
                                    <pre className={s.logs}>{gateChecks.join('\n') || '此方案未配置门禁。'}</pre>
                                </div>
                                <small>命令将在节点以 DSH 当前用户权限执行。</small>
                                <label className={s.check}>
                                    <input type="checkbox" checked={gateConsent && gateVersion === version} onChange={event => { setGateConsent(event.target.checked); setGateVersion(version); }} />
                                    我已核对并同意节点执行以上全部门禁命令
                                </label>
                                <p>{decisions.length ? `人工判断：${decisions.filter(d => decisionVersion === version && (confirmed.includes(d.id) || (waived[d.id] ?? '').trim())).length}/${decisions.length} 项已覆盖。` : '无需额外人工判断。'}</p>
                                {value.validation.map(error => <ErrorBox key={error} error={error} />)}
                                {!canApprove && <small>请确认或填写理由覆盖全部判断项、勾选门禁确认，并确保节点在线且无未决任务。</small>}
                                <div className={s.actions}>
                                    <button
                                        className={s.primary}
                                        disabled={!canApprove}
                                        onClick={() => {
                                            const activeConfirmed = decisionVersion === version
                                                ? decisions.filter(d => confirmed.includes(d.id)).map(d => d.id)
                                                : [];
                                            const activeWaived = decisionVersion === version
                                                ? decisions
                                                    .filter(d => !activeConfirmed.includes(d.id) && (waived[d.id] ?? '').trim().length > 0)
                                                    .map(d => ({ id: d.id, reason: (waived[d.id] ?? '').trim() }))
                                                : [];
                                            run.mutate({
                                                operation: 'approve',
                                                payload: {
                                                    confirmedDecisions: activeConfirmed,
                                                    waivedDecisions: activeWaived,
                                                    commitDetail: 'detailed',
                                                },
                                            });
                                        }}
                                    >
                                        确认批准并交付
                                    </button>
                                    <button onClick={() => setApproveOpen(false)}>返回检查</button>
                                </div>
                            </section>
                        </div>
                    )}
                </>
            ) : null}
        </>
    );
}
