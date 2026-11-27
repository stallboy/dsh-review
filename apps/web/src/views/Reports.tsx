import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { entityId } from '@dsh-review/protocol';
import { detail } from '../api.js';
import s from '../App.module.css';
import { candidateUrl, Empty, ErrorBox, Heading, Panel, time, useProjects } from '../components/Common.js';

export function Reports() {
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? '';
  const auditId = params.get('auditId') ?? '';
  const hasSelection = Boolean(projectId && auditId);
  const queue = projects.data?.projects.find((view) => view.project.projectId === projectId)?.snapshot?.queue;
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
            {projects.data?.projects.flatMap((view) => (view.snapshot?.audits ?? []).map((audit) => {
              const id = String(audit.auditId);
              const selected = view.project.projectId === projectId && id === auditId;
              return (
                <button
                  key={`${view.project.projectId}/${id}`}
                  className={selected ? `${s.reportRow} ${s.selected}` : s.reportRow}
                  aria-pressed={selected}
                  onClick={() => setParams({ projectId: view.project.projectId, auditId: id }, { replace: selected })}
                >
                  <span>
                    <b>{id}</b>
                    <small>{view.project.name} · 范围 {String(audit.scope)}{audit.trigger === 'scheduled' && ' · 定时触发'}</small>
                    <small>{time(String(audit.createdAt))}</small>
                  </span>
                  <span>{String(audit.issueCount)} 项 →</span>
                </button>
              );
            }))}
            {projects.data?.projects.every((view) => !view.snapshot?.audits.length) && <Empty>尚无已同步审查报告。</Empty>}
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
                        {report.data.meta.issues.map((id) => {
                          const candidate = queue?.find((item) => item.id === id);
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
