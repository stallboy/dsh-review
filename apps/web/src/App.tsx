import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewCandidate, ReviewComment } from '@dsh-review/protocol';
import { ApiError, clearSession, command, detail, request, saveAuditSchedule, setSession, type AuditSchedule, type AuditScheduleSettings, type CommandRecord, type NodeRecord, type ProjectDetail, type ProjectView, type QueueItem, type Session } from './api.js';
import { Diff, type Anchor } from './Diff.js';
import s from './App.module.css';

const UserContext = createContext<Session['user']>(null!);
const labels: Record<string, string> = { online: '在线', unresolved: '未解决', resolved: '已解决', outdated: '已过期', open: '待处理', closed: '已关闭', dismissed: '已忽略', converted: '已关联候选', reopened: '已重新打开', pending: '待审核', changes_requested: '待修复', approved: '已批准', rejected: '已拒绝', queued: '排队中', dispatched: '已分派', accepted: '已受理', executing: '执行中', completed: '已结束', recovery_required: '待核验', waiting: '等待执行条件', skipped: '已跳过', synced: '已同步', stale: '同步延迟', offline: '离线', not_synced: '未同步', delivered: '已交付远端', not_required: '无需交付', conflict: '交付冲突', unknown: '结果待核验', COMMITTED: '已提交', ABORTED: '已中止', RECOVERY_REQUIRED: '需要恢复', SUCCEEDED: '已完成', MANUAL_REQUIRED: '需要人工处理', VALIDATION_FAILED: '校验未通过' };
const label = (value: string) => labels[value] ?? value;
const time = (value?: string | null, timeZone?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone }) : '尚无记录';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const candidateUrl = (projectId: string, id: string) => `/projects/${projectId}/candidates/${id.split('/').map(encodeURIComponent).join('/')}`;

function Badge({ value, delivery = false }: { value: string; delivery?: boolean }) { return <span className={`${s.badge} ${s[value] ?? ''}`}>{delivery && value === 'pending' ? '待交付远端' : label(value)}</span>; }
function ErrorBox({ error }: { error: unknown }) { return error ? <div className={s.error} role="alert">{message(error)}</div> : null; }
function Empty({ children }: { children: ReactNode }) { return <div className={s.empty}><span className={s.emptyMark}>◇</span>{children}</div>; }
function Heading({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) { return <div className={s.heading}><div><div className={s.eyebrow}>{eyebrow}</div><h1>{title}</h1>{children && <p>{children}</p>}</div><div className={s.actions}>{actions}</div></div>; }
function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) { return <section className={s.panel}><div className={s.panelHead}><h2>{title}</h2>{extra}</div>{children}</section>; }
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
    return <UserContext.Provider value={session.data.user}><Shell onLogout={async () => { await request('/auth/logout', 'POST'); clearSession(queryClient); }} /></UserContext.Provider>;
}

function Login({ onLogin, error }: { onLogin(value: Session): void; error: unknown }) {
    const [username, setUsername] = useState(''), [password, setPassword] = useState('');
    const login = useMutation({ mutationFn: () => request<Session>('/auth/login', 'POST', { username, password }), onSuccess: onLogin });
    return <main className={s.login}><form className={s.loginCard} onSubmit={event => { event.preventDefault(); login.mutate(); }}><div className={s.mark}>R</div><div className={s.eyebrow}>DSH REVIEW CENTER</div><h1>让每一次修改<br />都有据可审。</h1><p>登录中央工作台，查看项目、审查与执行状态。</p><label>账号<input autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} /></label><label>密码<input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></label><ErrorBox error={login.error ?? error} /><button className={s.primary} disabled={login.isPending}>{login.isPending ? '正在登录…' : '登录工作台 →'}</button><small>账号由管理员在中央服务创建。</small></form></main>;
}

function Shell({ onLogout }: { onLogout(): Promise<void> }) {
    const user = useContext(UserContext), location = useLocation();
    const [error, setError] = useState('');
    const navigation = [['/', '◫', '工作台'], ['/projects', '▤', '项目管理'], ['/reports', '≡', '审查报告'], ['/queue', '◇', '候选队列'], ['/tasks', '↗', '任务记录'], ['/nodes', '⌘', '执行节点']];
    return <div className={s.shell}><aside className={s.sidebar}><Link className={s.brand} to="/"><span className={s.mark}>R</span><span>评审中心<small>DSH REVIEW</small></span></Link><div className={s.navLabel}>工作空间</div><nav>{navigation.map(([path, icon, title]) => <NavLink key={path} to={path!} end={path === '/'} className={({ isActive }) => isActive ? s.activeNav : ''}><span aria-hidden>{icon}</span>{title}</NavLink>)}</nav><div className={s.sidebarFoot}><b>审查 · 决策 · 交付</b><p>事实随仓库保存<br />执行由节点完成</p></div></aside><div className={s.main}><header className={s.topbar}><span className={s.crumb}>工作空间 <span>/ {navigation.find(([path]) => path === location.pathname)?.[2] ?? '项目详情'}</span></span><div className={s.actions}><span className={s.avatar}>{user.reviewIdentity.slice(0, 1)}</span><span>{user.reviewIdentity}</span><button className={s.textButton} onClick={() => void onLogout().catch(error => setError(message(error)))}>退出</button></div></header><main className={s.body}><ErrorBox error={error} /><Routes><Route path="/" element={<Workbench />} /><Route path="/projects" element={<Projects />} /><Route path="/reports" element={<Reports />} /><Route path="/queue" element={<Queue />} /><Route path="/tasks" element={<Tasks />} /><Route path="/nodes" element={<Nodes />} /><Route path="/projects/:projectId/candidates/*" element={<CandidatePage />} /><Route path="/projects/:projectId" element={<ProjectPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></main></div></div>;
}

function Workbench() {
    const projects = useProjects();
    const views = projects.data?.projects ?? [];
    const queue = views.flatMap(view => (view.snapshot?.queue ?? []).map(item => ({ ...item, projectId: view.project.projectId, projectName: view.project.name } as unknown as QueueItem)));
    const pending = queue.filter(item => !item.local && ['pending', 'changes_requested'].includes(item.status));
    return <><Heading eyebrow="OVERVIEW" title="工作台" actions={<Link className={s.button} to="/projects">管理项目 ↗</Link>}>先看需要决策的事，再进入具体代码。</Heading><ErrorBox error={projects.error} /><div className={s.metrics}>{[['待处理候选', pending.length, '等待审核或修复'], ['接入项目', views.length, '统一查看项目进展'], ['在线项目', views.filter(view => view.online).length, '执行节点保持连接'], ['未同步 / 延迟', views.filter(view => view.freshness !== 'synced').length, '保留最后已知结果']].map(([title, value, note]) => <div key={title} className={s.metric}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>)}</div><div className={s.twoColumns}><Panel title="需要关注" extra={<Link to="/queue">全部候选 →</Link>}><CandidateList items={pending.slice(0, 8)} loading={projects.isPending} /></Panel><Panel title="项目状态"><div className={s.stack}>{views.length ? views.map(view => <Link className={s.projectRow} to={`/projects/${view.project.projectId}`} key={view.project.projectId}><span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span><span className={s.grow}><b>{view.project.name}</b><small>{view.project.vcsType.toUpperCase()} · {view.project.target}</small></span><Badge value={view.freshness} /></Link>) : <Empty>还没有接入项目。先注册节点，再绑定工作副本。</Empty>}</div></Panel></div></>;
}

function CandidateList({ items, loading }: { items: QueueItem[]; loading?: boolean }) {
    if (!items.length) return <Empty>{loading ? '正在加载候选…' : '当前没有匹配的候选。'}</Empty>;
    return <div className={s.candidateList}>{items.map(item => <div className={s.candidateRow} key={`${item.projectId}/${item.id}`}><div className={s.grow}>{item.localOnly ? <b>{item.title}</b> : <Link className={s.rowTitle} to={candidateUrl(item.projectId, item.id)}>{item.title || item.id}</Link>}<div className={s.rowMeta}><span>{item.projectName}</span><span>{item.owner}</span><span>rev {item.currentRevision}</span><span>{item.unresolvedComments ?? 0} 条待处理意见</span></div>{item.parseError && <p className={s.dangerText}>{item.parseError}</p>}</div><div className={s.end}><Badge value={item.status} />{item.local && <small>本地诊断</small>}<span className={s.diffStat}>+{item.patchStats?.additions ?? 0} <em>−{item.patchStats?.deletions ?? 0}</em></span></div></div>)}</div>;
}

function Queue() {
    const projects = useProjects();
    const [projectId, setProjectId] = useState(''), [status, setStatus] = useState(''), [search, setSearch] = useState('');
    const views = projects.data?.projects ?? [];
    const items = views.filter(view => !projectId || view.project.projectId === projectId).flatMap(view => (view.snapshot?.queue ?? []).map(item => ({ ...item, projectId: view.project.projectId, projectName: view.project.name } as unknown as QueueItem)))
        .filter(item => (!status || item.status === status) && `${item.title} ${item.id} ${item.owner}`.toLowerCase().includes(search.toLowerCase()));
    return <><Heading eyebrow="REVIEW QUEUE" title="候选队列">从问题出发，逐项查看方案、代码与人工判断。</Heading><ErrorBox error={projects.error} /><div className={s.filters}><label className={s.search}>搜索<input placeholder="标题、编号或负责人" value={search} onChange={event => setSearch(event.target.value)} /></label><label>项目<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">全部项目</option>{views.map(view => <option key={view.project.projectId} value={view.project.projectId}>{view.project.name}</option>)}</select></label><label>状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{['pending', 'changes_requested', 'approved', 'rejected'].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label></div><Panel title={`${items.length} 个候选`}><CandidateList items={items} loading={projects.isPending} /></Panel></>;
}

function Projects() {
    const client = useQueryClient(), projects = useProjects();
    const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'), refetchInterval: 5000 });
    const [open, setOpen] = useState(false), [name, setName] = useState(''), [nodeId, setNodeId] = useState(''), [workspaceId, setWorkspaceId] = useState('');
    const add = useMutation({ mutationFn: () => request('/projects', 'POST', { name, nodeId, workspaceId }), onSuccess: () => { setOpen(false); setName(''); void client.invalidateQueries({ queryKey: ['projects'] }); } });
    const selected = nodes.data?.nodes.find(node => node.nodeId === nodeId);
    return <><Heading eyebrow="PROJECTS" title="项目管理" actions={<button className={s.primary} onClick={() => setOpen(!open)}>＋ 接入项目</button>}>将业务项目绑定到节点已准备好的工作副本。</Heading><ErrorBox error={projects.error ?? nodes.error} />{open && <Panel title="接入项目"><form className={s.form} onSubmit={event => { event.preventDefault(); add.mutate(); }}><label>项目名称<input required value={name} onChange={event => setName(event.target.value)} /></label><label>执行节点<select required value={nodeId} onChange={event => { setNodeId(event.target.value); setWorkspaceId(''); }}><option value="">选择在线节点</option>{nodes.data?.nodes.filter(node => node.online && node.compatible).map(node => <option key={node.nodeId} value={node.nodeId}>{node.name}</option>)}</select></label><label>工作副本<select required value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">选择节点工作副本</option>{selected?.workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.label} · {workspace.vcsType} / {workspace.target}</option>)}</select></label><ErrorBox error={add.error} /><div className={s.actions}><button className={s.primary} disabled={add.isPending}>确认接入</button><button type="button" onClick={() => setOpen(false)}>取消</button></div></form></Panel>}<div className={s.projectGrid}>{projects.data?.projects.map(view => <Link className={s.projectCard} to={`/projects/${view.project.projectId}`} key={view.project.projectId}><div className={s.actions}><span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span><Badge value={view.freshness} /></div><h2>{view.project.name}</h2><p>{view.project.vcsType.toUpperCase()} · {view.project.target}</p><div className={s.cardCounts}><strong>{view.snapshot?.queue.filter(item => !item.local && ['pending', 'changes_requested'].includes(String(item.status))).length ?? 0}<small>待处理候选</small></strong><strong>{view.snapshot?.audits.length ?? 0}<small>审查记录</small></strong></div><footer>上次同步 {time(view.lastSyncedAt)}<span>→</span></footer></Link>)}</div>{projects.data?.projects.length === 0 && <Empty>先到执行节点创建凭据，并在 DSH 上配置工作副本。</Empty>}</>;
}

function ProjectPage() {
    const { projectId = '' } = useParams();
    const client = useQueryClient(), navigate = useNavigate();
    const project = useQuery({ queryKey: ['project', projectId], queryFn: ({ signal }) => request<ProjectDetail>(`/projects/${projectId}`, 'GET', undefined, signal), refetchInterval: 4000 });
    const [name, setName] = useState(''), [note, setNote] = useState('');
    const update = useMutation({ mutationFn: (value: unknown) => request(`/projects/${projectId}`, 'PUT', value), onSuccess: () => { void client.invalidateQueries({ queryKey: ['project', projectId] }); void client.invalidateQueries({ queryKey: ['projects'] }); } });
    const run = useMutation({ mutationFn: (operation: string) => command(projectId, operation, operation === 'audit' ? { targetPath: '.', note } : {}), onSuccess: () => navigate(`/tasks?projectId=${projectId}`) });
    const view = project.data;
    return <><Heading eyebrow="PROJECT" title={view?.project.name ?? '项目详情'} actions={<Link className={s.button} to={`/tasks?projectId=${projectId}`}>任务记录 ↗</Link>}>{view ? `${view.project.vcsType.toUpperCase()} · ${view.project.target}` : '正在读取项目…'}</Heading><ErrorBox error={project.error ?? update.error ?? run.error} />{view && <><div className={s.notice}><Badge value={view.freshness} />上次同步 {time(view.lastSyncedAt)}{!view.project.enabled && ' · 项目已停用'}</div><div className={s.twoColumns}><Panel title="执行与同步"><div className={s.form}><label>本次审查补充说明<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="可选：需要重点关注的模块与约束" /></label><div className={s.actions}><button className={s.primary} disabled={!view.writable || run.isPending} onClick={() => run.mutate('audit')}>开始全量审查</button><button disabled={!view.online || !view.project.enabled || run.isPending} onClick={() => run.mutate('sync')}>同步仓库</button></div>{!view.writable && <small>节点离线、快照过期或存在未决任务时，暂不能开始新审查。</small>}</div></Panel><Panel title="项目设置"><form className={s.form} onSubmit={event => { event.preventDefault(); update.mutate({ name }); }}><label>项目名称<input placeholder={view.project.name} value={name} onChange={event => setName(event.target.value)} required /></label><div className={s.actions}><button disabled={update.isPending}>保存名称</button><button type="button" onClick={() => update.mutate({ enabled: !view.project.enabled })}>{view.project.enabled ? '停用项目' : '启用项目'}</button></div><small>节点 {view.project.nodeId}<br />工作副本 {view.project.workspaceId}</small></form></Panel></div><AuditSchedulePanel key={projectId} projectId={projectId} schedule={view.auditSchedule} /><Panel title="候选"><CandidateList items={(view.snapshot?.queue ?? []).map(item => ({ ...item, projectId, projectName: view.project.name } as unknown as QueueItem))} /></Panel></>}</>;
}

const defaultAuditSchedule: AuditScheduleSettings = {
    enabled: false,
    startTime: '02:00',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

function AuditSchedulePanel({ projectId, schedule }: { projectId: string; schedule: AuditSchedule | null }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<Partial<AuditScheduleSettings>>({});
    const saved = schedule ?? defaultAuditSchedule;
    const enabled = draft.enabled ?? saved.enabled;
    const startTime = draft.startTime ?? saved.startTime;
    const timeZone = draft.timeZone ?? saved.timeZone;
    const dirty = enabled !== saved.enabled || startTime !== saved.startTime || timeZone !== saved.timeZone;
    const run = schedule?.lastRun;
    const save = useMutation({
        mutationFn: (settings: AuditScheduleSettings) => saveAuditSchedule(projectId, settings),
        onSuccess: async ({ auditSchedule }) => {
            const queryKey = ['project', projectId];
            await client.cancelQueries({ queryKey, exact: true });
            client.setQueryData<ProjectDetail>(queryKey, current => current && { ...current, auditSchedule });
            setDraft({});
        },
    });
    function edit<Key extends keyof AuditScheduleSettings>(key: Key, value: AuditScheduleSettings[Key]) {
        setDraft(current => ({ ...current, [key]: value === saved[key] ? undefined : value }));
    }

    return <Panel title="定时审查" extra={<small>{saved.enabled ? '已启用' : '已关闭'}</small>}>
        <form className={s.form} onSubmit={event => {
            event.preventDefault();
            if (dirty && !save.isPending) save.mutate({ enabled, startTime, timeZone: timeZone.trim() });
        }}>
            <label className={s.check}>
                <input type="checkbox" checked={enabled} disabled={save.isPending} onChange={event => edit('enabled', event.target.checked)} />启用每日全量审查
            </label>
            <div className={s.scheduleFields}>
                <label>每日开始时间<input type="time" name="startTime" required value={startTime} disabled={save.isPending} onChange={event => edit('startTime', event.target.value)} /></label>
                <label>时区（IANA）<input name="timeZone" placeholder="例如 Asia/Shanghai" required value={timeZone} spellCheck={false} disabled={save.isPending} onChange={event => edit('timeZone', event.target.value)} /></label>
            </div>
            <small>到达设定时间后最多等待 30 分钟。到期未受理时跳过本轮，已受理的任务正常收尾。</small>
            <ErrorBox error={save.error} />
            <div className={s.actions}>
                <button disabled={!dirty || !startTime || !timeZone.trim() || save.isPending}>{save.isPending ? '正在保存…' : '保存定时设置'}</button>
                {save.isSuccess && !dirty && <small role="status">已保存</small>}
            </div>
            <div className={s.scheduleSummary}>
                <p>下次审查 {schedule?.nextRunAt ? `${time(schedule.nextRunAt, schedule.timeZone)}（${schedule.timeZone}）` : '暂无安排'}</p>
                {run ? <>
                    <div className={s.actions}><p>最近一次计划 {time(run.scheduledAt, schedule?.timeZone)}</p><Badge value={run.state} />{run.commandId && <Link to={`/tasks?projectId=${projectId}`}>查看项目任务</Link>}</div>
                    {run.reason && <p>{run.reason}</p>}
                </> : <p>最近一次计划 尚无记录</p>}
            </div>
        </form>
    </Panel>;
}

function Nodes() {
    const client = useQueryClient();
    const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'), refetchInterval: 5000 });
    const [name, setName] = useState(''), [credential, setCredential] = useState<{ nodeId: string; token: string } | null>(null);
    const add = useMutation({ mutationFn: () => request<{ nodeId: string; token: string }>('/nodes', 'POST', { name }), onSuccess: value => { setCredential(value); setName(''); void client.invalidateQueries({ queryKey: ['nodes'] }); } });
    const revoke = useMutation({ mutationFn: (id: string) => request(`/nodes/${id}/revoke`, 'POST'), onSuccess: () => { void client.invalidateQueries({ queryKey: ['nodes'] }); } });
    return <><Heading eyebrow="EXECUTION NODES" title="执行节点">每台机器上的 DSH 主动连接中央服务，仓库凭据保留在节点。</Heading><ErrorBox error={nodes.error ?? add.error ?? revoke.error} />{credential && <Panel title="节点凭据 · 仅展示这一次"><div className={s.form}><p>把 Token 保存到节点的环境变量或凭据服务，再在 managed-node.json 中引用。</p><label>节点 ID<input readOnly value={credential.nodeId} /></label><label>Token<input readOnly value={credential.token} onFocus={event => event.target.select()} /></label><button onClick={() => setCredential(null)}>已保存，关闭凭据</button></div></Panel>}<Panel title="注册新节点"><form className={s.inlineForm} onSubmit={event => { event.preventDefault(); add.mutate(); }}><label className={s.grow}>节点名称<input required placeholder="例如：Linux 构建机 01" value={name} onChange={event => setName(event.target.value)} /></label><button className={s.primary} disabled={add.isPending || Boolean(credential)}>创建节点凭据</button></form></Panel><div className={s.projectGrid}>{nodes.data?.nodes.map(node => <section className={s.projectCard} key={node.nodeId}><div className={s.actions}><span className={s.projectIcon}>⌘</span><Badge value={node.online ? 'online' : 'offline'} /></div><h2>{node.name}</h2><p>{node.platform || '等待首次注册'} · 协议 {node.protocolVersion ?? '—'}{node.lastSeenAt && !node.compatible ? ' · 版本不兼容' : ''}</p><div className={s.nodeWorkspaces}>{node.workspaces.map(workspace => <div key={workspace.workspaceId}><b>{workspace.label}</b><small>{workspace.vcsType.toUpperCase()} · {workspace.target}</small></div>)}{node.workspaces.length === 0 && <small>尚未注册工作副本</small>}</div><footer><span>{node.enabled ? time(node.lastSeenAt) : '凭据已吊销'}</span><button className={s.textButton} disabled={!node.enabled || revoke.isPending} onClick={() => { if (window.confirm(`吊销“${node.name}”的凭据后，该节点将无法连接。确认吊销？`)) revoke.mutate(node.nodeId); }}>吊销</button></footer></section>)}</div>{nodes.data?.nodes.length === 0 && <Empty>创建第一份节点凭据，连接你的 DSH 实例。</Empty>}</>;
}

function Reports() {
    const projects = useProjects();
    const [selected, setSelected] = useState<{ projectId: string; auditId: string } | null>(null);
    const report = useQuery({ queryKey: ['report', selected], queryFn: ({ signal }) => detail<{ body: string; meta: { auditId: string; scope: string; items: { findingId: string; title: string; summary: string; status: string }[] } }>(selected!.projectId, 'audit', { id: selected!.auditId }, signal), enabled: Boolean(selected) });
    return <><Heading eyebrow="AUDIT REPORTS" title="审查报告">保留每次全量审查的范围、发现和处理脉络。</Heading><ErrorBox error={projects.error ?? report.error} /><div className={s.twoColumns}><Panel title="审查记录"><div className={s.stack}>{projects.data?.projects.flatMap(view => (view.snapshot?.audits ?? []).map(audit => <button key={`${view.project.projectId}/${audit.auditId}`} className={s.reportRow} onClick={() => setSelected({ projectId: view.project.projectId, auditId: String(audit.auditId) })}><span><b>{String(audit.auditId)}</b><small>{view.project.name} · 范围 {String(audit.scope)}{audit.trigger === 'scheduled' && ' · 定时触发'}</small><small>{time(String(audit.createdAt))}</small></span><span>{String(audit.itemCount)} 项 →</span></button>))}{projects.data?.projects.every(view => !view.snapshot?.audits.length) && <Empty>尚无已同步审查报告。</Empty>}</div></Panel><Panel title={selected ? selected.auditId : '报告详情'}>{!selected ? <Empty>选择左侧记录，查看报告内容。</Empty> : report.isPending ? <Empty>正在向节点读取该版本报告…</Empty> : report.data ? <div className={s.document}>{report.data.meta.items.map(item => <article key={item.findingId}><Badge value={item.status} /><h3>{item.title}</h3><p>{item.summary}</p></article>)}<pre>{report.data.body}</pre></div> : <button onClick={() => void report.refetch()}>重新读取</button>}</Panel></div></>;
}

function Tasks() {
    const location = useLocation(), client = useQueryClient();
    const projectId = new URLSearchParams(location.search).get('projectId') ?? '';
    const [selectedId, setSelectedId] = useState(''), [confirmStopped, setConfirmStopped] = useState(false);
    const tasks = useQuery({ queryKey: ['tasks', projectId], queryFn: () => request<{ tasks: CommandRecord[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`), refetchInterval: 2000 });
    const selected = tasks.data?.tasks.find(task => task.commandId === selectedId) ?? tasks.data?.tasks[0];
    const logs = useQuery({ queryKey: ['logs', selected?.commandId, selected?.state], queryFn: () => request<{ log: string[]; logStartOffset: number }>(`/tasks/${selected!.commandId}/logs`), enabled: Boolean(selected), refetchInterval: selected?.state === 'completed' ? false : 2000 });
    const control = useMutation({ mutationFn: (operation: string) => request(`/commands/${selected!.commandId}/${operation}`, 'POST', operation === 'recover' ? { confirmStopped } : {}), onSuccess: () => { setConfirmStopped(false); void client.invalidateQueries({ queryKey: ['tasks'] }); } });
    return <><Heading eyebrow="TASK HISTORY" title="任务记录" actions={projectId ? <Link className={s.button} to="/tasks">查看全部项目</Link> : null}>业务执行结果与远端交付状态分别记录。</Heading><ErrorBox error={tasks.error ?? logs.error ?? control.error} /><div className={s.taskColumns}><Panel title="指令记录"><div className={s.stack}>{tasks.data?.tasks.map(task => <button className={`${s.reportRow} ${selected?.commandId === task.commandId ? s.selected : ''}`} key={task.commandId} onClick={() => { setSelectedId(task.commandId); setConfirmStopped(false); }}><span><b>{task.operation}</b>{task.scheduledAudit && ' · 定时触发'}<small>{task.actor.reviewIdentity} · {time(task.createdAt)}</small><small>{task.projectId.slice(0, 12)}</small></span><Badge value={task.state} /></button>)}{tasks.data?.tasks.length === 0 && <Empty>还没有任务记录。</Empty>}</div></Panel><Panel title={selected ? `${selected.operation} · ${selected.commandId.slice(0, 8)}` : '执行详情'}>{selected ? <div className={s.form}><div className={s.actions}><Badge value={selected.state} />{selected.result && <><Badge value={selected.result.outcome.status} /><Badge value={selected.result.delivery.state} delivery /></>}</div>{selected.scheduledAudit && <p>定时触发 · 计划开始 {time(selected.scheduledAudit.scheduledAt)} · 最晚受理 {time(selected.scheduledAudit.expiresAt)}</p>}<p>{String(selected.result?.outcome.message ?? selected.result?.outcome.detail ?? '')}</p>{selected.result?.delivery.commitRevision && <div className={s.mono}>原提交 {selected.result.delivery.commitRevision}</div>}{selected.result?.delivery.reason && <p>{selected.result.delivery.reason}</p>}{selected.state !== 'completed' && selected.state !== 'recovery_required' && <button disabled={control.isPending || selected.cancelRequested} onClick={() => control.mutate('cancel')}>{selected.cancelRequested ? '已请求取消，等待节点回报' : '请求取消'}</button>}{selected.state === 'recovery_required' && <div className={s.notice}><p>恢复只核验原执行与交付，不会重新批准或重跑业务。</p><label className={s.check}><input type="checkbox" checked={confirmStopped} onChange={event => setConfirmStopped(event.target.checked)} />我已确认旧执行进程停止</label><button disabled={!confirmStopped || control.isPending} onClick={() => control.mutate('recover')}>核验并重试原提交交付</button></div>}<h3>执行日志</h3><pre className={s.logs}>{logs.data?.log.join('\n') || '尚无日志'}</pre>{selected.result?.outcome.manualPrompt ? <details><summary>人工操作提示</summary><pre className={s.logs}>{String(selected.result.outcome.manualPrompt)}</pre></details> : null}<details><summary>完整业务结果</summary><pre className={s.logs}>{JSON.stringify(selected.result?.outcome ?? {}, null, 2)}</pre></details></div> : <Empty>选择一条任务查看执行结果与日志。</Empty>}</Panel></div></>;
}

interface CandidateView { candidate: ReviewCandidate; patchText: string; currentBase: string | null; isBaseBehind: boolean; comments: ReviewComment[]; validation: string[]; patchCheck?: { state: string }; approvalCommitRevision?: string; approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown' }

function CandidatePage() {
    const { projectId = '', '*': id = '' } = useParams(), user = useContext(UserContext), client = useQueryClient(), navigate = useNavigate();
    const project = useQuery({ queryKey: ['project', projectId], queryFn: () => request<ProjectView>(`/projects/${projectId}`), refetchInterval: 4000 });
    const candidate = useQuery({ queryKey: ['candidate', projectId, id, project.data?.vcsSnapshot], queryFn: ({ signal }) => detail<CandidateView>(projectId, 'candidate', { id }, signal), enabled: Boolean(project.data?.vcsSnapshot) });
    const [tab, setTab] = useState('overview'), [comment, setComment] = useState(''), [anchor, setAnchor] = useState<Anchor | null>(null), [confirmed, setConfirmed] = useState<string[]>([]), [approveOpen, setApproveOpen] = useState(false), [reason, setReason] = useState(''), [reopenFrom, setReopenFrom] = useState(''), [manualPatch, setManualPatch] = useState(''), [diffFrom, setDiffFrom] = useState('0');
    const [draftVersion, setDraftVersion] = useState(''), [decisionVersion, setDecisionVersion] = useState(''), [approvalVersion, setApprovalVersion] = useState(''), [submission, setSubmission] = useState<{ commandId: string; draftKey: string; text: string; anchor: Anchor | null; version: string } | null>(null), [gateConsent, setGateConsent] = useState(false), [gateVersion, setGateVersion] = useState('');
    const draftKey = `review-draft:${user.userId}:${projectId}:${id}`;
    const submitted = submission?.commandId ?? '';
    const [diffFolding, setDiffFolding] = useState<{ scope: string; revision?: number; files: string[] }>({ scope: '', files: [] });
    const activeView = useRef<string | null>(draftKey);
    useEffect(() => { activeView.current = draftKey; return () => { activeView.current = null; }; }, [draftKey]);
    const value = candidate.data, meta = value?.candidate.meta, owner = meta?.owner === user.reviewIdentity;
    const version = meta ? `${meta.currentRevision}/${meta.updatedAt}` : '';
    const diffScope = JSON.stringify([projectId, id, diffFrom]);
    useEffect(() => {
        setDiffFolding(current => current.scope === diffScope && (meta?.currentRevision === undefined || current.revision === meta.currentRevision)
            ? current : { scope: diffScope, revision: meta?.currentRevision, files: [] });
    }, [diffScope, meta?.currentRevision]);
    useEffect(() => {
        try { const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'); setComment(saved?.text ?? ''); setAnchor(saved?.anchor ?? null); setDraftVersion(saved?.version ?? ''); } catch { setComment(''); setAnchor(null); setDraftVersion(''); }
        setConfirmed([]); setDecisionVersion(''); setApproveOpen(false); setSubmission(null);
    }, [draftKey]);
    const saveDraft = (text: string, position: Anchor | null, stamp: string) => {
        setComment(text); setAnchor(position); setDraftVersion(stamp);
        try { if (text || position) sessionStorage.setItem(draftKey, JSON.stringify({ text, anchor: position, version: stamp })); else sessionStorage.removeItem(draftKey); } catch {}
    };
    const status = useQuery({ queryKey: ['submitted-comment', submitted], queryFn: () => request<{ command: CommandRecord }>(`/commands/${submitted}`), enabled: Boolean(submitted), refetchInterval: query => query.state.data?.command.state === 'completed' ? false : 2000 });
    useEffect(() => {
        if (!submission || submission.draftKey !== draftKey || status.data?.command.state !== 'completed' || status.data.command.result?.outcome.status !== 'COMMITTED') return;
        if (comment === submission.text && draftVersion === submission.version && JSON.stringify(anchor) === JSON.stringify(submission.anchor)) saveDraft('', null, '');
        void client.invalidateQueries({ queryKey: ['project', projectId] });
    }, [status.data?.command.state, submitted]);
    const guard = meta ? { expectedRevision: meta.currentRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt } : undefined;
    const run = useMutation({
        mutationFn: ({ operation, payload }: { operation: string; payload?: Record<string, unknown> }) => command(projectId, operation, { id, ...payload }, guard),
        onMutate: () => ({ draftKey, text: comment, anchor: structuredClone(anchor), version: draftVersion, projectId }),
        onSuccess: (result, _variables, origin) => {
            void client.invalidateQueries({ queryKey: ['tasks'] });
            if (!origin || activeView.current !== origin.draftKey) return;
            if (result.command.operation === 'comments') setSubmission({ commandId: result.command.commandId, ...origin });
            else navigate(`/tasks?projectId=${origin.projectId}`);
        },
    });
    const writable = Boolean(project.data?.writable && owner && !value?.candidate.parseError && !run.isPending);
    const active = meta && ['pending', 'changes_requested'].includes(meta.status);
    const decisions = meta?.humanDecisions ?? [];
    const comparison = useQuery({ queryKey: ['comparison', projectId, id, project.data?.vcsSnapshot, diffFrom], queryFn: ({ signal }) => detail<{ unifiedDiff: string; notes?: string[] }>(projectId, 'diff', { id, from: diffFrom }, signal), enabled: tab === 'diff' && diffFrom !== '0' && Boolean(value) });
    const draftStale = Boolean(comment && draftVersion && version && draftVersion !== version);
    const hasDraft = Boolean(comment || anchor);
    const canApprove = gateConsent && gateVersion === version && approvalVersion === version && writable && meta?.status === 'pending' && value?.candidate.humanJudgmentDeclared && !value.validation.length && decisions.every(item => decisionVersion === version && confirmed.includes(item.id));
    const submitComment = (event: FormEvent) => { event.preventDefault(); run.mutate({ operation: 'comments', payload: { content: comment, revision: meta?.currentRevision, ...(anchor ?? {}) } }); };
    return <><Link className={s.back} to="/queue">← 候选队列</Link><Heading eyebrow={`${project.data?.project.name ?? 'PROJECT'} / CANDIDATE`} title={meta?.title ?? '候选详情'} actions={<button onClick={() => { void project.refetch(); void candidate.refetch(); }}>刷新详情</button>}>{id}</Heading><ErrorBox error={project.error ?? candidate.error ?? run.error ?? status.error} />{submitted && <div className={s.notice}>{status.data?.command.result ? `${label(status.data.command.result.outcome.status)}：${String(status.data.command.result.outcome.message ?? '')}` : '审核意见已受理，等待节点提交与同步。'}<Link to={`/tasks?projectId=${projectId}`}>查看任务 →</Link></div>}{project.data && <div className={s.notice}><Badge value={project.data.freshness} />{project.data.freshness !== 'synced' ? '正在展示最后同步的版本。' : '操作提交后，由节点重新校验版本与负责人。'}</div>}{candidate.isPending ? <Empty>{project.data?.vcsSnapshot ? '正在向节点读取候选与补丁…' : '项目还没有可用快照。'}</Empty> : value && meta ? <><div className={s.candidateHeader}><div className={s.actions}><Badge value={meta.status} /><span>负责人 {meta.owner}</span><span>rev {meta.currentRevision}</span><span>{time(meta.updatedAt)}</span></div><div className={s.actions}>{!owner && active && <button disabled={!project.data?.writable || run.isPending} onClick={() => { if (window.confirm(`将负责人从“${meta.owner}”改为“${user.reviewIdentity}”？`)) run.mutate({ operation: 'takeover' }); }}>接管候选</button>}{active && <button className={s.primary} disabled={!writable || meta.status !== 'pending'} onClick={() => { setApprovalVersion(version); setGateConsent(false); setGateVersion(''); setApproveOpen(true); }}>批准并交付 →</button>}</div></div>{meta.status === 'approved' && <div className={s.notice}><span>业务提交版本：{value.approvalCommitRevision ?? '尚未派生'}</span><small>{value.approvalCommitLookup === 'found' ? '已找到业务提交。' : value.approvalCommitLookup === 'ambiguous' ? '匹配到多个业务提交，仅为诊断。' : '暂未确认业务提交版本，仅为诊断。'}</small></div>}{value.candidate.parseError && <ErrorBox error={value.candidate.parseError} />}{value.isBaseBehind && active && <div className={s.notice}>业务基线已变化。<button disabled={!writable || meta.status !== 'pending'} onClick={() => run.mutate({ operation: 'rebase' })}>重新基于最新代码生成补丁</button></div>}<div className={s.tabs}>{[['overview', '方案与证据'], ['diff', '代码差异'], ['comments', `审核意见 · ${meta.comments.length}`], ['history', '版本与门禁']].map(([key, title]) => <button key={key} aria-selected={tab === key} onClick={() => setTab(key!)}>{title}</button>)}</div><div className={s.reviewColumns}><div>{tab === 'overview' && <Panel title="问题与修复方案"><div className={s.document}>{[['问题描述', value.candidate.sections.problem], ['根本原因', value.candidate.sections.rootCause], ['修复方案', value.candidate.sections.solution], ['验证证据', value.candidate.sections.evidence]].map(([title, text]) => <article key={title}><h3>{title}</h3><p>{text || '未提供'}</p></article>)}</div></Panel>}{tab === 'diff' && <Panel title="当前版本 · 并排差异" extra={<small>点击代码行添加定位意见</small>}><div className={s.form}><label>比较范围<select value={diffFrom} onChange={event => setDiffFrom(event.target.value)}><option value="0">当前完整补丁</option>{meta.revisions.filter(revision => revision.id !== meta.currentRevision).map(revision => <option key={revision.id} value={String(revision.id)}>rev {revision.id} → rev {meta.currentRevision}</option>)}</select></label><ErrorBox error={comparison.error} />{comparison.isFetching && <small>正在读取版本差异…</small>}{comparison.data?.notes?.map(note => <small key={note}>{note}</small>)}</div>{diffFrom !== '0' && <p className={s.diffNote}>增量比较可在当前版本右侧添加定位意见。</p>}<Diff collapsedFiles={diffFolding.scope === diffScope && diffFolding.revision === meta.currentRevision ? diffFolding.files : []} onCollapsedFilesChange={files => setDiffFolding({ scope: diffScope, revision: meta.currentRevision, files })} allowLeft={diffFrom === '0'} text={diffFrom === '0' ? value.patchText : comparison.data?.unifiedDiff ?? ''} onSelect={selected => { saveDraft(comment, selected, version); setTab('comments'); }} /></Panel>}{tab === 'comments' && <Panel title="审核意见"><div className={s.document}>{value.comments.length ? value.comments.map(item => <article key={item.id}><div className={s.actions}><b>{item.author}</b><Badge value={item.status} /><small>rev {item.revision}</small></div>{item.file && <small className={s.mono}>{item.file}:{item.line} · {item.side}</small>}<p>{item.content}</p>{writable && active && item.status !== 'resolved' && <button onClick={() => run.mutate({ operation: 'comment-status', payload: { commentId: item.id, status: 'resolved' } })}>标记已解决</button>}</article>) : <Empty>还没有审核意见。</Empty>}<form className={s.commentForm} onSubmit={submitComment}>{anchor && <div className={s.notice}><small>{anchor.file}:{anchor.line} · {anchor.side}</small><button type="button" onClick={() => saveDraft(comment, null, draftVersion)}>移除定位</button></div>}<label>新增审核意见<textarea required value={comment} onChange={event => saveDraft(event.target.value, anchor, draftVersion || version)} placeholder="说明问题、期望行为与验证方式…" /></label>{draftStale && <div className={s.notice}>版本已更新，草稿保留。请对照新代码检查意见与定位。<button type="button" onClick={() => saveDraft(comment, null, version)}>已核对，应用到当前版本</button></div>}<small>意见基于当前显示的 rev {meta.currentRevision}。版本冲突时草稿会保留。</small><button className={s.primary} disabled={!writable || !active || !comment.trim() || draftStale || Boolean(submitted && status.data?.command.state !== 'completed')}>提交意见</button></form></div></Panel>}{tab === 'history' && <Panel title="版本与门禁"><div className={s.document}>{meta.revisions.map(revision => <article key={revision.id}><h3>rev {revision.id} · {revision.author}</h3><small>{revision.baseRevision}</small><p>{revision.patch}</p></article>)}<h3>门禁命令</h3><pre>{meta.gateChecks.join('\n') || '未配置'}</pre>{meta.approval && <><h3>批准记录</h3><p>{meta.approval.approvedBy} · {time(meta.approval.approvedAt)}</p><pre>{JSON.stringify(meta.approval.gateResults, null, 2)}</pre></>}</div></Panel>}</div><aside><Panel title="人工判断"><div className={s.form}>{!value.candidate.humanJudgmentDeclared && <ErrorBox error="候选未填写人工判断章节，暂不能批准。" />}{decisions.length ? decisions.map(item => <label className={s.check} key={item.id}><input type="checkbox" checked={decisionVersion === version && confirmed.includes(item.id)} onChange={event => { setDecisionVersion(version); setConfirmed(current => { const base = decisionVersion === version ? current : []; return event.target.checked ? [...new Set([...base, item.id])] : base.filter(id => id !== item.id); }); }} /><span><b>{item.question}</b>{item.note && <small>{item.note}</small>}</span></label>) : <p>当前候选没有待确认的判断项。</p>}{value.candidate.humanJudgment.map((item, index) => <small key={index}>{item.label} {item.text}</small>)}</div></Panel><Panel title="后续操作"><div className={s.form}><button disabled={!writable || !active || hasDraft || !meta.comments.some(item => item.status !== 'resolved')} onClick={() => run.mutate({ operation: 'ai-fix' })}>让 AI 处理未解决意见</button>{hasDraft && <small>请先提交审核意见草稿，再启动 AI 修复；只有行定位时请先填写意见或移除定位。</small>}{meta.status === 'changes_requested' && <button disabled={!writable} onClick={() => run.mutate({ operation: 'resume' })}>恢复为待审核</button>}{active && <details><summary>人工提交新补丁</summary><label>Unified Diff<textarea className={s.mono} value={manualPatch} onChange={event => setManualPatch(event.target.value)} placeholder="粘贴完整补丁，由节点校验并生成新版本" /></label><button disabled={!writable || !manualPatch.trim()} onClick={() => run.mutate({ operation: 'manual-revision', payload: { patchText: manualPatch } })}>校验并保存人工版本</button></details>}<label>处理原因<textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="拒绝或重新打开时填写" /></label>{active ? <button className={s.dangerText} disabled={!writable || !reason.trim()} onClick={() => { if (window.confirm('确认拒绝并归档此候选？')) run.mutate({ operation: 'reject', payload: { reason } }); }}>拒绝候选</button> : null}{meta.status === 'pending' && <><label>关联被拒来源<input value={reopenFrom} onChange={event => setReopenFrom(event.target.value)} placeholder="YYYY-MM/被拒候选编号" /></label><button disabled={!writable || !reason.trim() || !reopenFrom.trim()} onClick={() => run.mutate({ operation: 'reopen', payload: { from: reopenFrom, reason } })}>记录重新打开的来源</button></>}{meta.status === 'rejected' && <small>重新审查产生新候选后，可在新候选中关联当前编号。</small>}<small>当前登录身份：{user.reviewIdentity}<br />{owner ? '你是此候选负责人。' : '接管后可提交意见或执行审核。'}</small></div></Panel></aside></div>{approveOpen && <div className={s.modalBackdrop}><section role="dialog" aria-modal="true" aria-labelledby="approve-title" className={s.modal}><h2 id="approve-title">批准并交付代码</h2><p>节点将重新校验 rev {meta.currentRevision}，执行门禁后提交到 {project.data?.project.target}，并{project.data?.project.vcsType === 'git' ? '推送 Git 远端' : '提交 SVN 远端'}。</p><div><h3>将执行的完整门禁命令</h3><pre className={s.logs}>{meta.gateChecks.join('\n') || '此候选未配置门禁。'}</pre></div><small>命令将在节点以 DSH 的系统账号执行。</small><label className={s.check}><input type="checkbox" checked={gateConsent && gateVersion === version} onChange={event => { setGateConsent(event.target.checked); setGateVersion(version); }} />我已核对，并同意节点执行以上门禁命令</label><p>{decisions.length ? `人工判断：${confirmed.length}/${decisions.length} 项已确认。` : '无需额外人工判断。'}</p>{value.validation.map(error => <ErrorBox key={error} error={error} />)}{!canApprove && <small>请确认全部判断项，并确保候选有效、节点在线且没有未决任务。</small>}<div className={s.actions}><button className={s.primary} disabled={!canApprove} onClick={() => run.mutate({ operation: 'approve', payload: { confirmedDecisions: confirmed, commitDetail: 'detailed' } })}>确认批准并交付</button><button onClick={() => setApproveOpen(false)}>返回检查</button></div></section></div>}</> : null}</>;
}
