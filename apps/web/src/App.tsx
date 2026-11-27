import { useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, clearSession, request, setSession, type Session } from './api.js';
import s from './App.module.css';
import { Empty, ErrorBox, message, UserContext } from './components/Common.js';
import { CandidatePage } from './views/CandidatePage.js';
import { Login } from './views/Login.js';
import { Nodes } from './views/Nodes.js';
import { ProjectPage } from './views/ProjectPage.js';
import { Projects } from './views/Projects.js';
import { Queue } from './views/Queue.js';
import { Reports } from './views/Reports.js';
import { Tasks } from './views/Tasks.js';
import { Workbench } from './views/Workbench.js';

export function App() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => request<Session>('/auth/session', 'GET', undefined, signal),
    refetchInterval: 60000,
  });

  useEffect(() => {
    if (session.error instanceof ApiError && session.error.status === 401) clearSession(queryClient);
    else setSession(session.data ?? null);
  }, [session.data, session.error, queryClient]);

  if (session.isPending) return <main className={s.login}><Empty>正在连接评审中心…</Empty></main>;
  if (!session.data) {
    return (
      <Login
        onLogin={(value) => { setSession(value); queryClient.setQueryData(['session'], value); }}
        error={session.error instanceof ApiError && session.error.status === 401 ? null : session.error}
      />
    );
  }
  const onLogout = session.data.localAccess
    ? undefined
    : async () => { await request('/auth/logout', 'POST'); clearSession(queryClient); };

  return (
    <UserContext.Provider value={session.data.user}>
      <Shell onLogout={onLogout} />
    </UserContext.Provider>
  );
}

function Shell({ onLogout }: { onLogout?: () => Promise<void> }) {
  const user = useContext(UserContext);
  const location = useLocation();
  const [error, setError] = useState('');
  const navigation = [
    ['/', '◫', '工作台'],
    ['/projects', '▤', '项目管理'],
    ['/reports', '≡', '审查报告'],
    ['/queue', '◇', '问题队列'],
    ['/tasks', '↗', '任务记录'],
    ['/nodes', '⌘', '执行节点'],
  ];

  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <Link className={s.brand} to="/"><span className={s.mark}>R</span><span>评审中心<small>DSH REVIEW</small></span></Link>
        <div className={s.navLabel}>工作空间</div>
        <nav>
          {navigation.map(([path, icon, title]) => (
            <NavLink key={path} to={path!} end={path === '/'} className={({ isActive }) => (isActive ? s.activeNav : '')}>
              <span aria-hidden>{icon}</span>{title}
            </NavLink>
          ))}
        </nav>
        <div className={s.sidebarFoot}><b>审查 · 决策 · 交付</b><p>事实随仓库保存<br />执行由节点完成</p></div>
      </aside>
      <div className={s.main}>
        <header className={s.topbar}>
          <span className={s.crumb}>工作空间 <span>/ {navigation.find(([path]) => path === location.pathname)?.[2] ?? '项目详情'}</span></span>
          <div className={s.actions}>
            <span className={s.avatar}>{user.reviewIdentity.slice(0, 1)}</span>
            <span>{user.reviewIdentity}</span>
            {onLogout && <button className={s.textButton} onClick={() => void onLogout().catch((err) => setError(message(err)))}>退出</button>}
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
