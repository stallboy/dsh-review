import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, type NodeRecord } from '../api.js';
import s from '../App.module.css';
import { Badge, Empty, ErrorBox, Heading, Panel, time, useProjects } from '../components/Common.js';

export function Projects() {
  const client = useQueryClient();
  const projects = useProjects();
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'),
    refetchInterval: 5000,
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const add = useMutation({
    mutationFn: () => request('/projects', 'POST', { name, nodeId, workspaceId }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      void client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const selected = nodes.data?.nodes.find((node) => node.nodeId === nodeId);

  return (
    <>
      <Heading eyebrow="PROJECTS" title="项目管理" actions={<button className={s.primary} onClick={() => setOpen(!open)}>＋ 接入项目</button>}>
        将业务项目绑定到节点已准备好的工作副本。
      </Heading>
      <ErrorBox error={projects.error ?? nodes.error} />
      {open && (
        <Panel title="接入项目">
          <form className={s.form} onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
            <label>项目名称<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>
              执行节点
              <select required value={nodeId} onChange={(event) => { setNodeId(event.target.value); setWorkspaceId(''); }}>
                <option value="">选择在线节点</option>
                {nodes.data?.nodes.filter((node) => node.online && node.compatible).map((node) => (
                  <option key={node.nodeId} value={node.nodeId}>{node.name}</option>
                ))}
              </select>
            </label>
            <label>
              工作副本
              <select required value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                <option value="">选择节点工作副本</option>
                {selected?.workspaces.map((workspace) => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.label} · {workspace.vcsType} / {workspace.target}
                  </option>
                ))}
              </select>
            </label>
            <ErrorBox error={add.error} />
            <div className={s.actions}>
              <button className={s.primary} disabled={add.isPending}>确认接入</button>
              <button type="button" onClick={() => setOpen(false)}>取消</button>
            </div>
          </form>
        </Panel>
      )}
      <div className={s.projectGrid}>
        {projects.data?.projects.map((view) => (
          <Link className={s.projectCard} to={`/projects/${view.project.projectId}`} key={view.project.projectId}>
            <div className={s.actions}>
              <span className={s.projectIcon}>{view.project.name.slice(0, 1)}</span>
              <Badge value={view.freshness} />
            </div>
            <h2>{view.project.name}</h2>
            <p>{view.project.vcsType.toUpperCase()} · {view.project.target}</p>
            <div className={s.cardCounts}>
              <strong>
                {view.snapshot?.queue.filter((item) => !item.local && ['pending', 'changes_requested', 'repair_failed'].includes(item.status)).length ?? 0}
                <small>待处理问题</small>
              </strong>
              <strong>
                {view.snapshot?.audits.length ?? 0}
                <small>审查记录</small>
              </strong>
            </div>
            <footer>上次同步 {time(view.lastSyncedAt)}<span>→</span></footer>
          </Link>
        ))}
      </div>
      {projects.data?.projects.length === 0 && <Empty>先到执行节点创建凭据，并在 DSH 上配置工作副本。</Empty>}
    </>
  );
}
