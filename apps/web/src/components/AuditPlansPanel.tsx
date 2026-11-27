import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuditPlanSettings, AuditRecurrence } from '@dsh-review/protocol';
import {
  deleteAuditPlan,
  saveAuditPlan,
  setAuditPlanEnabled,
  type AuditPlan,
  type ProjectDetail,
} from '../api.js';
import s from '../App.module.css';
import { Badge, Empty, ErrorBox, Panel, time } from './Common.js';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const timeZones = [...new Set(['UTC', browserTimeZone, ...(Intl.supportedValuesOf?.('timeZone') ?? [])])].sort();

function describePlan({ startTime, timeZone, recurrence }: AuditPlanSettings): string {
  const when = recurrence.kind === 'daily'
    ? '每天'
    : recurrence.kind === 'weekly'
      ? (recurrence.weekdays.map((day) => weekdays[day - 1]).join('、') || '请选择星期')
      : `从 ${recurrence.startDate || '起始日期'} 起，每隔 ${recurrence.days || 'N'} 天`;
  return `${when} ${startTime}（${timeZone}）`;
}

function settingsForPlan({ name, enabled, startTime, timeZone, recurrence, note }: AuditPlan): AuditPlanSettings {
  return { name, enabled, startTime, timeZone, recurrence, note };
}

export function AuditPlansPanel({ projectId, plans }: { projectId: string; plans: AuditPlan[] }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ plan?: Pick<AuditPlan, 'planId' | 'version'>; settings: AuditPlanSettings } | null>(null);
  const [status, setStatus] = useState('');
  const mutate = useMutation({
    mutationFn: async (
      action:
        | { settings: AuditPlanSettings; plan?: Pick<AuditPlan, 'planId' | 'version'> }
        | { planId: string; enabled: boolean }
        | { deleteId: string },
    ) => {
      if ('deleteId' in action) {
        await deleteAuditPlan(projectId, action.deleteId);
        return { deleteId: action.deleteId };
      }
      if ('enabled' in action) return setAuditPlanEnabled(projectId, action.planId, action.enabled);
      return saveAuditPlan(projectId, action.settings, action.plan);
    },
    onSuccess: async (result) => {
      const queryKey = ['project', projectId];
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<ProjectDetail>(queryKey, (current) => {
        if (!current) return current;
        const currentPlans = current.auditPlans;
        if ('deleteId' in result) return { ...current, auditPlans: currentPlans.filter((plan) => plan.planId !== result.deleteId) };
        const updated = result.auditPlan;
        return {
          ...current,
          auditPlans: currentPlans.some((plan) => plan.planId === updated.planId)
            ? currentPlans.map((plan) => (plan.planId === updated.planId ? updated : plan))
            : [...currentPlans, updated],
        };
      });
      setEditing(null);
      setStatus('deleteId' in result ? '计划已删除' : '计划已保存');
      void client.invalidateQueries({ queryKey, exact: true });
    },
  });

  const draft = editing?.settings;
  const edit = (values: Partial<AuditPlanSettings>) => {
    setEditing((current) => current && { ...current, settings: { ...current.settings, ...values } });
  };
  const selectFrequency = (kind: AuditRecurrence['kind']) => {
    if (!draft) return;
    let timeZone = draft.timeZone.trim();
    try { new Intl.DateTimeFormat('sv-SE', { timeZone }); } catch { timeZone = browserTimeZone; }
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const recurrence: AuditRecurrence = kind === 'daily'
      ? { kind }
      : kind === 'weekly'
        ? { kind, weekdays: [] }
        : { kind, days: 3, startDate: today.format(new Date()) };
    edit({ recurrence });
  };

  const busy = mutate.isPending;
  const actionsDisabled = busy || Boolean(editing);

  return (
    <Panel
      title="定时审查"
      extra={(
        <button
          type="button"
          className={s.primary}
          disabled={actionsDisabled}
          onClick={() => {
            mutate.reset();
            setStatus('');
            setEditing({ settings: { name: '', enabled: true, startTime: '02:00', timeZone: browserTimeZone, recurrence: { kind: 'daily' }, note: '' } });
          }}
        >
          新增计划
        </button>
      )}
    >
      {!editing && <ErrorBox error={mutate.error} />}
      {status && <p className={s.scheduleStatus} role="status">{status}</p>}
      {editing && draft && (
        <form
          className={`${s.form} ${s.scheduleEditor}`}
          onSubmit={(event) => {
            event.preventDefault();
            setStatus('');
            if (!busy) mutate.mutate({ plan: editing.plan, settings: { ...draft, timeZone: draft.timeZone.trim() } });
          }}
        >
          <h3>{editing.plan ? '编辑计划' : '新增定时计划'}</h3>
          <fieldset className={s.scheduleEditorFields} disabled={busy}>
            <div className={s.scheduleFields}>
              <label>计划名称<input required autoFocus maxLength={80} value={draft.name} onChange={(event) => edit({ name: event.target.value })} placeholder="例如 每周权限检查" /></label>
              <label>
                执行频率
                <select value={draft.recurrence.kind} onChange={(event) => selectFrequency(event.target.value as AuditRecurrence['kind'])}>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="interval">每隔 N 天</option>
                </select>
              </label>
            </div>
            {draft.recurrence.kind === 'weekly' && (
              <fieldset className={s.scheduleWeekdays}>
                <legend>星期</legend>
                <div className={s.actions}>
                  {weekdays.map((day, index) => {
                    const dayNumber = index + 1;
                    const selected = draft.recurrence.kind === 'weekly' ? draft.recurrence.weekdays : [];
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={selected.includes(dayNumber)}
                        onClick={() => edit({
                          recurrence: {
                            kind: 'weekly',
                            weekdays: selected.includes(dayNumber)
                              ? selected.filter((v) => v !== dayNumber)
                              : [...selected, dayNumber].sort((a, b) => a - b),
                          },
                        })}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
                <div className={s.actions}>
                  <button type="button" className={s.textButton} onClick={() => edit({ recurrence: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5] } })}>选工作日</button>
                  <button type="button" className={s.textButton} onClick={() => edit({ recurrence: { kind: 'weekly', weekdays: [6, 7] } })}>选周末</button>
                </div>
              </fieldset>
            )}
            {draft.recurrence.kind === 'interval' && (
              <div className={s.scheduleFields}>
                <label>间隔天数<input type="number" min={2} max={365} required value={draft.recurrence.days || ''} onChange={(event) => edit({ recurrence: { kind: 'interval', days: event.target.valueAsNumber, startDate: draft.recurrence.kind === 'interval' ? draft.recurrence.startDate : '' } })} /></label>
                <label>起始日期<input type="date" required value={draft.recurrence.startDate} onChange={(event) => edit({ recurrence: { kind: 'interval', startDate: event.target.value, days: draft.recurrence.kind === 'interval' ? draft.recurrence.days : 3 } })} /></label>
              </div>
            )}
            <div className={s.scheduleFields}>
              <label>开始时间<input type="time" required value={draft.startTime} onChange={(event) => edit({ startTime: event.target.value })} /></label>
              <label>时区<input list="audit-plan-zones" required value={draft.timeZone} spellCheck={false} onChange={(event) => edit({ timeZone: event.target.value })} /><datalist id="audit-plan-zones">{timeZones.map((zone) => <option key={zone} value={zone} />)}</datalist></label>
            </div>
            <label>审查要求<textarea maxLength={4000} value={draft.note} placeholder="可选。填写本轮全仓审查要额外关注的问题。" onChange={(event) => edit({ note: event.target.value })} /></label>
            <label className={s.check}><input type="checkbox" checked={draft.enabled} onChange={(event) => edit({ enabled: event.target.checked })} />启用计划</label>
          </fieldset>
          <p className={s.schedulePreview} aria-live="polite">{describePlan(draft)}</p>
          <ErrorBox error={mutate.error} />
          <div className={s.actions}>
            <button className={s.primary} disabled={busy || !draft.name.trim() || !draft.timeZone.trim() || (draft.recurrence.kind === 'weekly' && !draft.recurrence.weekdays.length)}>{busy ? '正在保存…' : '保存计划'}</button>
            <button type="button" disabled={busy} onClick={() => { mutate.reset(); setEditing(null); }}>取消</button>
          </div>
        </form>
      )}
      {plans.length > 0 ? (
        <ul className={s.scheduleList}>
          {plans.map((plan) => {
            const run = plan.lastRun;
            return (
              <li key={plan.planId}>
                <article className={s.schedulePlan}>
                  <div className={s.schedulePlanHead}>
                    <div><h3>{plan.name}</h3><p>{describePlan(plan)}</p></div>
                    <small>{plan.enabled ? '已启用' : '已暂停'}</small>
                  </div>
                  {plan.note && <details className={s.scheduleRequirements}><summary>审查要求</summary><p>{plan.note}</p></details>}
                  <div className={s.scheduleSummary}>
                    <p>下次审查 {plan.nextRunAt ? time(plan.nextRunAt, plan.timeZone) : '暂无安排'}</p>
                    <div className={s.actions}>
                      <p>最近一次计划 {time(run?.scheduledAt, plan.timeZone)}</p>
                      {run && <Badge value={run.state} />}
                      {run?.commandId && <Link to={`/tasks?projectId=${projectId}`}>查看项目任务</Link>}
                    </div>
                    {run?.reason && <p>{run.reason}</p>}
                  </div>
                  <div className={s.actions}>
                    <button type="button" disabled={actionsDisabled} onClick={() => { mutate.reset(); setStatus(''); setEditing({ plan: { planId: plan.planId, version: plan.version }, settings: settingsForPlan(plan) }); }}>编辑</button>
                    <button type="button" disabled={actionsDisabled} onClick={() => { setStatus(''); mutate.mutate({ planId: plan.planId, enabled: !plan.enabled }); }}>{plan.enabled ? '暂停' : '恢复'}</button>
                    <button type="button" disabled={actionsDisabled} onClick={() => { if (window.confirm(`删除「${plan.name}」？已受理的审查会继续执行。`)) { setStatus(''); mutate.mutate({ deleteId: plan.planId }); } }}>删除</button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : !editing && <Empty>暂无定时计划</Empty>}
      {plans.length > 0 && <p className={s.scheduleStatus}>到达设定时间后最多等待 30 分钟。到期未受理时跳过本轮。</p>}
    </Panel>
  );
}
