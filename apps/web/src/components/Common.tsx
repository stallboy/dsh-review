import { createContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request, type ProjectView, type Session } from '../api.js';
import s from '../App.module.css';

export const UserContext = createContext<Session['user']>(null!);

export const labels: Record<string, string> = {
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

export const label = (value: string): string => labels[value] ?? value;

export const time = (value?: string | null, timeZone?: string): string => (
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone }) : '尚无记录'
);

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const candidateUrl = (projectId: string, id: string): string => (
  `/projects/${projectId}/candidates/${id.split('/').map(encodeURIComponent).join('/')}`
);

export function Badge({ value, delivery = false }: { value: string; delivery?: boolean }) {
  return <span className={`${s.badge} ${s[value] ?? ''}`}>{delivery && value === 'pending' ? '待交付远端' : label(value)}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return error ? <div className={s.error} role="alert">{message(error)}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={s.empty}><span className={s.emptyMark}>◇</span>{children}</div>;
}

export function Heading({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={s.heading}>
      <div>
        <div className={s.eyebrow}>{eyebrow}</div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      <div className={s.actions}>{actions}</div>
    </div>
  );
}

export function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => request<{ projects: ProjectView[] }>('/projects'),
    refetchInterval: 5000,
  });
}
