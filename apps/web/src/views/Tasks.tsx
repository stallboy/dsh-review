import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, type CommandRecord } from '../api.js';
import s from '../App.module.css';
import { Badge, Empty, ErrorBox, Heading, Panel, time } from '../components/Common.js';

interface TaskLogsResponse {
  log: string[];
  logOffset: number;
  totalLogLines: number;
  earliestLogOffset: number;
  logResetRequired: boolean;
}

export function Tasks() {
  const location = useLocation();
  const client = useQueryClient();
  const params = new URLSearchParams(location.search);
  const projectId = params.get('projectId') ?? '';
  const linkedId = params.get('commandId') ?? '';
  const [selectedId, setSelectedId] = useState('');
  const [confirmStopped, setConfirmStopped] = useState(false);

  const tasks = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => request<{ tasks: CommandRecord[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: 2000,
  });
  const targetId = selectedId || linkedId;
  const fromList = tasks.data?.tasks.find((task) => task.commandId === targetId);
  const linkedTask = useQuery({
    queryKey: ['tasks', 'command', targetId],
    queryFn: () => request<{ command: CommandRecord }>(`/commands/${encodeURIComponent(targetId)}`),
    enabled: Boolean(targetId && !fromList && tasks.isSuccess),
    refetchInterval: 2000,
  });
  const selected = targetId ? fromList ?? linkedTask.data?.command : tasks.data?.tasks[0];
  const selectedCommandId = selected?.commandId ?? '';

  // 按 SPEC §6.2 绝对偏移增量拉取日志；切换任务或收到 logResetRequired 时全量替换本地缓冲。
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logError, setLogError] = useState<unknown>(null);
  const logOffsetRef = useRef<number | null>(null);
  const logCommandRef = useRef<string>('');

  useEffect(() => {
    logCommandRef.current = selectedCommandId;
    logOffsetRef.current = null;
    setLogLines([]);
    setLogError(null);
  }, [selectedCommandId]);

  const selectedState = selected?.state ?? '';
  useEffect(() => {
    if (!selectedCommandId) return;
    let active = true;
    const poll = async () => {
      try {
        const since = logOffsetRef.current;
        const query = since === null ? '' : `?since=${String(since)}`;
        const data = await request<TaskLogsResponse>(`/tasks/${encodeURIComponent(selectedCommandId)}/logs${query}`);
        if (!active || logCommandRef.current !== selectedCommandId) return;
        if (since === null || data.logResetRequired) {
          setLogLines(data.log);
        } else if (data.log.length > 0) {
          setLogLines((prev) => [...prev, ...data.log]);
        }
        logOffsetRef.current = data.logOffset;
        setLogError(null);
      } catch (err) {
        if (active && logCommandRef.current === selectedCommandId) setLogError(err);
      }
    };
    void poll();
    if (selectedState === 'completed') return () => { active = false; };
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedCommandId, selectedState]);

  const control = useMutation({
    mutationFn: (operation: string) => request(`/commands/${selected!.commandId}/${operation}`, 'POST', operation === 'recover' ? { confirmStopped } : {}),
    onSuccess: () => {
      setConfirmStopped(false);
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const promptText = selected?.result?.outcome.manualPrompt ?? selected?.result?.outcome.prompt;

  return (
    <>
      <Heading eyebrow="TASK HISTORY" title="任务记录" actions={projectId ? <Link className={s.button} to="/tasks">查看全部项目</Link> : null}>
        业务执行结果与远端交付状态分别记录。
      </Heading>
      <ErrorBox error={tasks.error ?? linkedTask.error ?? logError ?? control.error} />
      <div className={s.taskColumns}>
        <Panel title="指令记录">
          <div className={s.stack}>
            {tasks.data?.tasks.map((task) => (
              <button
                className={`${s.reportRow} ${selected?.commandId === task.commandId ? s.selected : ''}`}
                key={task.commandId}
                onClick={() => { setSelectedId(task.commandId); setConfirmStopped(false); }}
              >
                <span>
                  <b>{task.operation}</b>
                  {task.scheduledAudit && ' · 定时触发'}
                  <small>{task.actor.reviewIdentity} · {time(task.createdAt)}</small>
                  <small>{task.projectId.slice(0, 12)}</small>
                </span>
                <Badge value={task.state} />
              </button>
            ))}
            {tasks.data?.tasks.length === 0 && <Empty>还没有任务记录。</Empty>}
          </div>
        </Panel>
        <Panel title={selected ? `${selected.operation} · ${selected.commandId.slice(0, 8)}` : '执行详情'}>
          {selected ? (
            <div className={s.form}>
              <div className={s.actions}>
                <Badge value={selected.state} />
                {selected.result && (
                  <>
                    <Badge value={selected.result.outcome.status} />
                    <Badge value={selected.result.delivery.state} delivery />
                  </>
                )}
              </div>
              {selected.scheduledAudit && (
                <p>定时触发 · 计划开始 {time(selected.scheduledAudit.scheduledAt)} · 最晚受理 {time(selected.scheduledAudit.expiresAt)}</p>
              )}
              <p>{String(selected.result?.outcome.message ?? selected.result?.outcome.detail ?? '')}</p>
              {typeof selected.result?.outcome.sessionId === 'string' && <div className={s.mono}>DSH 审查会话 {selected.result.outcome.sessionId}</div>}
              {selected.result?.delivery.commitRevision && <div className={s.mono}>原提交 {selected.result.delivery.commitRevision}</div>}
              {selected.result?.delivery.reason && <p>{selected.result.delivery.reason}</p>}
              {selected.state !== 'completed' && selected.state !== 'recovery_required' && (
                <button disabled={control.isPending || selected.cancelRequested} onClick={() => control.mutate('cancel')}>
                  {selected.cancelRequested ? '已请求取消，等待节点回报' : '请求取消'}
                </button>
              )}
              {selected.state === 'recovery_required' && (
                <div className={s.notice}>
                  <p>恢复会核验原执行与交付。会话停止后，外部工具仍可能留下改动。如果工具结果未知，请先核对工作副本、外部状态和工具备份，再请求核验。</p>
                  <label className={s.check}>
                    <input type="checkbox" checked={confirmStopped} onChange={(event) => setConfirmStopped(event.target.checked)} />
                    {typeof selected.result?.outcome.sessionId === 'string'
                      ? '我已确认旧执行已停止，并核对过结果未知的外部操作'
                      : '我已确认旧执行已停止'}
                  </label>
                  <button disabled={!confirmStopped || control.isPending} onClick={() => control.mutate('recover')}>
                    {typeof selected.result?.outcome.sessionId === 'string'
                      ? '核验原审查会话与工作副本'
                      : '核验并重试原提交交付'}
                  </button>
                </div>
              )}
              <h3>执行日志（{logLines.length} 行）</h3>
              <pre className={s.logs}>{logLines.join('\n') || '尚无日志'}</pre>
              {promptText ? (
                <details>
                  <summary>人工操作 / 修复提示词</summary>
                  <pre className={s.logs}>{String(promptText)}</pre>
                </details>
              ) : null}
              <details>
                <summary>完整业务结果</summary>
                <pre className={s.logs}>{JSON.stringify(selected.result?.outcome ?? {}, null, 2)}</pre>
              </details>
            </div>
          ) : <Empty>选择一条任务查看执行结果与日志。</Empty>}
        </Panel>
      </div>
    </>
  );
}
