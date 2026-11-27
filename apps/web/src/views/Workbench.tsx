import { Link } from 'react-router-dom';
import type { QueueItem } from '../api.js';
import s from '../App.module.css';
import { CandidateList } from '../components/CandidateList.js';
import { Badge, Empty, ErrorBox, Heading, Panel, useProjects } from '../components/Common.js';

export function Workbench() {
  const projects = useProjects();
  const views = projects.data?.projects ?? [];
  const queue: QueueItem[] = views.flatMap((view) =>
    (view.snapshot?.queue ?? []).map((item) => ({
      ...item,
      projectId: view.project.projectId,
      projectName: view.project.name,
    })),
  );
  const actionable = queue.filter((item) =>
    !item.local && ['pending', 'changes_requested', 'repair_failed', 'human_takeover', 'awaiting_verification'].includes(item.status),
  );

  return (
    <>
      <Heading eyebrow="OVERVIEW" title="工作台" actions={<Link className={s.button} to="/projects">管理项目 ↗</Link>}>先看需要决策的事，再进入具体代码。</Heading>
      <ErrorBox error={projects.error} />
      <div className={s.metrics}>
        {[
          ['待处理问题', actionable.length, '待审核、修订、修复失败或人工跟进'],
          ['接入项目', views.length, '统一查看项目进展'],
          ['在线项目', views.filter((view) => view.online).length, '执行节点保持连接'],
          ['未同步 / 延迟', views.filter((view) => view.freshness !== 'synced').length, '保留最后已知结果'],
        ].map(([title, value, note]) => (
          <div key={String(title)} className={s.metric}>
            <span>{title}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div className={s.twoColumns}>
        <Panel title="需要关注" extra={<Link to="/queue">全部问题 →</Link>}>
          <CandidateList items={actionable.slice(0, 8)} loading={projects.isPending} />
        </Panel>
        <Panel title="项目状态">
          <div className={s.stack}>
            {views.length ? views.map((view) => (
              <Link className={s.projectRow} to={`/projects/${view.project.projectId}`} key={view.project.projectId}>
                <span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span>
                <span className={s.grow}>
                  <b>{view.project.name}</b>
                  <small>{view.project.vcsType.toUpperCase()} · {view.project.target}</small>
                </span>
                <Badge value={view.freshness} />
              </Link>
            )) : <Empty>还没有接入项目。先注册节点，再绑定工作副本。</Empty>}
          </div>
        </Panel>
      </div>
    </>
  );
}
