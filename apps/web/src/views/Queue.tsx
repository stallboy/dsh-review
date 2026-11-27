import { useContext, useState } from 'react';
import { emptyReviewCounts, REVIEW_STATUSES } from '@dsh-review/protocol';
import type { FindingView, QueueItem } from '../api.js';
import s from '../App.module.css';
import { CandidateList } from '../components/CandidateList.js';
import { ErrorBox, Heading, label, Panel, useProjects, UserContext } from '../components/Common.js';
import { FindingCard } from '../components/FindingCard.js';

export function Queue() {
  const user = useContext(UserContext);
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [owner, setOwner] = useState(user.reviewIdentity);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  const views = projects.data?.projects ?? [];
  const selectedViews = views.filter((view) => !projectId || view.project.projectId === projectId);

  const allItems: QueueItem[] = selectedViews.flatMap((view) =>
    (view.snapshot?.queue ?? []).map((item) => ({
      ...item,
      projectId: view.project.projectId,
      projectName: view.project.name,
    })),
  );
  const ownerScoped = allItems.filter((item) => !owner || item.owner === owner);
  const counts = emptyReviewCounts();
  for (const item of ownerScoped) {
    if (!item.local && item.status !== 'broken') counts[item.status] = (counts[item.status] ?? 0) + 1;
  }

  const q = search.trim().toLowerCase();
  const items = ownerScoped.filter((item) =>
    (!status || item.status === status)
    && (!q || `${item.title} ${item.id} ${item.owner} ${item.findingId}`.toLowerCase().includes(q)),
  );

  const findings: Array<{ finding: FindingView; projectId: string; writable: boolean }> = selectedViews.flatMap((view) =>
    (view.snapshot?.findings ?? []).map((finding) => ({
      finding,
      projectId: view.project.projectId,
      writable: view.writable,
    })),
  );
  const filteredFindings = findings.filter(({ finding }) =>
    (!owner || finding.owner === owner)
    && (!status || finding.issueStatus === status)
    && (!q || `${finding.title} ${finding.findingId} ${finding.id} ${finding.owner}`.toLowerCase().includes(q)),
  );

  return (
    <>
      <Heading eyebrow="REVIEW QUEUE" title="问题队列">从问题出发，逐项查看方案、代码与人工判断。</Heading>
      <ErrorBox error={projects.error} />
      <div className={s.filters}>
        <label className={s.search}>搜索<input placeholder="标题、编号或负责人" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>
          负责人
          <div className={s.actions}>
            <button type="button" className={owner === user.reviewIdentity ? s.primary : ''} onClick={() => setOwner(user.reviewIdentity)}>我的</button>
            <button type="button" className={owner === '' ? s.primary : ''} onClick={() => setOwner('')}>全部</button>
            <input style={{ width: 120 }} placeholder="留空=全部" value={owner} onChange={(event) => setOwner(event.target.value)} />
          </div>
        </label>
        <label>
          项目
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">全部项目</option>
            {views.map((view) => <option key={view.project.projectId} value={view.project.projectId}>{view.project.name}</option>)}
          </select>
        </label>
        <label>
          状态
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            {REVIEW_STATUSES.map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select>
        </label>
      </div>
      <div className={s.statusBar} aria-label="状态统计">
        {REVIEW_STATUSES.map((statusKey) => (
          <button
            key={statusKey}
            type="button"
            className={`${s.statusChip} ${status === statusKey ? s.statusChipActive : ''}`}
            onClick={() => setStatus(status === statusKey ? '' : statusKey)}
          >
            {label(statusKey)} {counts[statusKey] ?? 0}
          </button>
        ))}
      </div>
      {filteredFindings.map((entry) => (
        <FindingCard key={`${entry.projectId}/${entry.finding.id}/${entry.finding.recordRevision}`} {...entry} />
      ))}
      <Panel title={`全部问题列表（${items.length}）`}>
        <CandidateList items={items} loading={projects.isPending} />
      </Panel>
    </>
  );
}
