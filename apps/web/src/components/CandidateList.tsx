import { Link } from 'react-router-dom';
import type { QueueItem } from '../api.js';
import s from '../App.module.css';
import { Badge, candidateUrl, Empty, label } from './Common.js';

export function CandidateList({ items, loading }: { items: QueueItem[]; loading?: boolean }) {
  if (!items.length) return <Empty>{loading ? '正在加载问题…' : '当前没有匹配的问题。'}</Empty>;

  return (
    <div className={s.candidateList}>
      {items.map((item) => (
        <div className={s.candidateRow} key={`${item.projectId}/${item.id}`}>
          <div className={s.grow}>
            {item.localOnly
              ? <b>{item.title}</b>
              : <Link className={s.rowTitle} to={candidateUrl(item.projectId, item.id)}>{item.title || item.id}</Link>}
            <div className={s.rowMeta}>
              <span>{item.projectName}</span>
              <span>{item.priority}</span>
              <span>{label(item.issueKind)}</span>
              {item.options.length === 0 && <span>无补丁</span>}
              <span>{item.owner}</span>
              <span>记录 {item.recordRevision}</span>
              <span>{item.unresolvedComments ?? 0} 条待处理意见</span>
              {item.isStale && <span className={s.dangerText}>跨基线待复核</span>}
              {item.duplicateOf && <span className={s.dangerText}>重复问题（{item.duplicateOf}）</span>}
            </div>
            {item.options.length > 0 && (
              <div className={s.rowMeta} style={{ marginTop: 6 }}>
                {item.options.map((opt) => (
                  <span key={opt.id}>
                    {opt.id}#{opt.currentPatch} (+{opt.patchStats.additions}/−{opt.patchStats.deletions})
                    {opt.banned ? ' [已封禁]' : ''}
                    {opt.patchCheck?.state === 'conflicted' ? ' [预检冲突]' : opt.patchCheck?.state === 'clean' ? ' [预检可应用]' : ''}
                  </span>
                ))}
              </div>
            )}
            {item.parseError && <p className={s.dangerText}>{item.parseError}</p>}
          </div>
          <div className={s.end}>
            <Badge value={item.status} />
            {item.deferred && <Badge value="deferred" />}
            {item.local && <small>本地诊断</small>}
            {item.options.length > 0
              ? <span className={s.diffStat}>+{item.patchStats?.additions ?? 0} <em>−{item.patchStats?.deletions ?? 0}</em></span>
              : <small>无补丁</small>}
          </div>
        </div>
      ))}
    </div>
  );
}
