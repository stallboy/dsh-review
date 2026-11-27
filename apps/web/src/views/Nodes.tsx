import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, type NodeRecord } from '../api.js';
import s from '../App.module.css';
import { Badge, Empty, ErrorBox, Heading, Panel, time } from '../components/Common.js';

export function Nodes() {
  const client = useQueryClient();
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => request<{ nodes: NodeRecord[] }>('/nodes'),
    refetchInterval: 5000,
  });
  const [name, setName] = useState('');
  const [credential, setCredential] = useState<{ nodeId: string; token: string } | null>(null);
  const add = useMutation({
    mutationFn: () => request<{ nodeId: string; token: string }>('/nodes', 'POST', { name }),
    onSuccess: (value) => {
      setCredential(value);
      setName('');
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => request(`/nodes/${id}/revoke`, 'POST'),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['nodes'] }); },
  });

  return (
    <>
      <Heading eyebrow="EXECUTION NODES" title="执行节点">每台机器上的 DSH 主动连接中央服务，仓库凭据保留在节点。</Heading>
      <ErrorBox error={nodes.error ?? add.error ?? revoke.error} />
      {credential && (
        <Panel title="节点凭据 · 仅展示这一次">
          <div className={s.form}>
            <p>把 Token 保存到节点的环境变量或凭据服务，再在节点配置中引用。</p>
            <label>节点 ID<input readOnly value={credential.nodeId} /></label>
            <label>Token<input readOnly value={credential.token} onFocus={(event) => event.target.select()} /></label>
            <button onClick={() => setCredential(null)}>已保存，关闭凭据</button>
          </div>
        </Panel>
      )}
      <Panel title="注册新节点">
        <form className={s.inlineForm} onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
          <label className={s.grow}>节点名称<input required placeholder="例如：Linux 构建机 01" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <button className={s.primary} disabled={add.isPending || Boolean(credential)}>创建节点凭据</button>
        </form>
      </Panel>
      <div className={s.projectGrid}>
        {nodes.data?.nodes.map((node) => (
          <section className={s.projectCard} key={node.nodeId}>
            <div className={s.actions}><span className={s.projectIcon}>⌘</span><Badge value={node.online ? 'online' : 'offline'} /></div>
            <h2>{node.name}</h2>
            <p>{node.platform || '等待首次注册'} · 协议 {node.protocolVersion ?? '—'}{node.lastSeenAt && !node.compatible ? ' · 版本不兼容' : ''}</p>
            <div className={s.nodeWorkspaces}>
              {node.workspaces.map((workspace) => (
                <div key={workspace.workspaceId}>
                  <b>{workspace.label}</b>
                  <small>{workspace.vcsType.toUpperCase()} · {workspace.target}</small>
                </div>
              ))}
              {node.workspaces.length === 0 && <small>尚未注册工作副本</small>}
            </div>
            <footer>
              <span>{node.enabled ? time(node.lastSeenAt) : '凭据已吊销'}</span>
              <button
                className={s.textButton}
                disabled={!node.enabled || revoke.isPending}
                onClick={() => { if (window.confirm(`吊销“${node.name}”的凭据后，该节点将无法连接。确认吊销？`)) revoke.mutate(node.nodeId); }}
              >
                吊销
              </button>
            </footer>
          </section>
        ))}
      </div>
      {nodes.data?.nodes.length === 0 && <Empty>创建第一份节点凭据，连接你的 DSH 实例。</Empty>}
    </>
  );
}
