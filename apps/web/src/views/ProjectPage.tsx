import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REVIEW_STATUSES } from '@dsh-review/protocol';
import { command, request, triggerSelfTest, type ProjectDetail, type QueueItem } from '../api.js';
import s from '../App.module.css';
import { AuditPlansPanel } from '../components/AuditPlansPanel.js';
import { CandidateList } from '../components/CandidateList.js';
import { Badge, ErrorBox, Heading, label, Panel, time } from '../components/Common.js';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => request<ProjectDetail>(`/projects/${projectId}`, 'GET', undefined, signal),
    refetchInterval: 4000,
  });
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const update = useMutation({
    mutationFn: (value: unknown) => request(`/projects/${projectId}`, 'PUT', value),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['project', projectId] });
      void client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const run = useMutation({
    mutationFn: (operation: string) => (
      operation === 'audit-self-test'
        ? triggerSelfTest(projectId)
        : command(projectId, operation, operation === 'audit' ? { targetPath: '.', note } : {})
    ),
    onSuccess: () => navigate(`/tasks?projectId=${projectId}`),
  });

  const view = project.data;
  const counts = view?.snapshot?.counts;
  const items: QueueItem[] = (view?.snapshot?.queue ?? []).map((item) => ({
    ...item,
    projectId,
    projectName: view?.project.name ?? '',
  }));

  return (
    <>
      <Heading
        eyebrow="PROJECT"
        title={view?.project.name ?? '项目详情'}
        actions={<Link className={s.button} to={`/tasks?projectId=${projectId}`}>任务记录 ↗</Link>}
      >
        {view ? `${view.project.vcsType.toUpperCase()} · ${view.project.target}` : '正在读取项目…'}
      </Heading>
      <ErrorBox error={project.error ?? update.error ?? run.error} />
      {view && (
        <>
          <div className={s.notice}>
            <Badge value={view.freshness} />
            上次同步 {time(view.lastSyncedAt)}
            {!view.project.enabled && ' · 项目已停用'}
          </div>
          {view.workspaceIssue && <ErrorBox error={view.workspaceIssue} />}
          {counts && (
            <div className={s.actions} style={{ marginBottom: 18 }}>
              {REVIEW_STATUSES.map((statusKey) => (
                <span key={statusKey} className={s.badge}>{label(statusKey)} {counts[statusKey] ?? 0}</span>
              ))}
            </div>
          )}
          <div className={s.twoColumns}>
            <Panel title="执行与同步">
              <div className={s.form}>
                <label>本次审查补充说明<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选：需要重点关注的模块与约束" /></label>
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
              <form className={s.form} onSubmit={(event) => { event.preventDefault(); update.mutate({ name }); }}>
                <label>项目名称<input placeholder={view.project.name} value={name} onChange={(event) => setName(event.target.value)} required /></label>
                <div className={s.actions}>
                  <button disabled={update.isPending}>保存名称</button>
                  <button type="button" onClick={() => update.mutate({ enabled: !view.project.enabled })}>{view.project.enabled ? '停用项目' : '启用项目'}</button>
                </div>
                <small>节点 {view.project.nodeId}<br />工作副本 {view.project.workspaceId}</small>
              </form>
            </Panel>
          </div>
          <AuditPlansPanel key={projectId} projectId={projectId} plans={view.auditPlans} />
          <Panel title="问题列表"><CandidateList items={items} /></Panel>
        </>
      )}
    </>
  );
}
