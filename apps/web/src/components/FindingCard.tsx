import { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { command, type FindingView } from '../api.js';
import s from '../App.module.css';
import { Badge, candidateUrl, ErrorBox, Panel, UserContext } from './Common.js';

export function FindingCard({
  finding,
  projectId,
  writable,
  selected,
  selectedOption,
}: {
  finding: FindingView;
  projectId: string;
  writable?: boolean;
  selected?: string;
  selectedOption?: string;
}) {
  const user = useContext(UserContext);
  const navigate = useNavigate();
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [reviewAfter, setReviewAfter] = useState('');
  const [reviewWhen, setReviewWhen] = useState('');
  const [copied, setCopied] = useState('');

  const closed = finding.issueStatus === 'approved' || finding.issueStatus === 'resolved';
  const isOwner = finding.owner === user.reviewIdentity;
  const canAct = Boolean(writable && isOwner);
  const guard = {
    expectedRevision: finding.recordRevision,
    expectedOwner: finding.owner,
    expectedUpdatedAt: finding.updatedAt,
  };
  const run = useMutation({
    mutationFn: (payload: Record<string, unknown>) => command(projectId, 'finding-decision', { id: finding.id, ...payload }, guard),
    onSuccess: () => { setAction(''); setReason(''); navigate(`/tasks?projectId=${projectId}`); },
  });
  const disabled = !canAct || run.isPending;
  const canResumeFromRepairFailed = finding.options.some((option) => !option.banned);
  const canAcceptAsIs = canAct && !closed && ['pending', 'changes_requested', 'repair_failed', 'human_takeover'].includes(finding.issueStatus);
  const canDefer = canAct && !closed && ['pending', 'changes_requested', 'repair_failed'].includes(finding.issueStatus) && !finding.deferred;
  const canHumanTakeover = canAct && !closed && ['pending', 'changes_requested', 'repair_failed', 'awaiting_verification'].includes(finding.issueStatus);
  const canResumeReview = canAct && !closed && (
    finding.deferred
    || finding.issueStatus === 'rejected'
    || finding.issueStatus === 'human_takeover'
    || (finding.issueStatus === 'repair_failed' && canResumeFromRepairFailed)
  );
  const reasonRequired = ['accept_as_is', 'defer', 'resume_review', 'add_repair_hint', 'external_completed'].includes(action)
    || (action === 'human_takeover' && finding.issueStatus === 'awaiting_verification');

  return (
    <Panel
      title={`${finding.priority} · ${finding.title}`}
      extra={(
        <div className={s.actions}>
          <Badge value={finding.issueStatus} />
          {finding.deferred && <Badge value="deferred" />}
          <Badge value={finding.issueKind} />
          {finding.options.length === 0 && <span className={s.badge}>无补丁</span>}
        </div>
      )}
    >
      <div className={s.form}>
        <p>{finding.summary}</p>
        {finding.dependsOn && <small>依赖前置问题：{finding.dependsOn}</small>}
        {finding.id !== selected && <Link to={candidateUrl(projectId, finding.id)}>查看问题详情、证据与历史 →</Link>}
        {finding.decision?.reason && <p>处置说明：{finding.decision.reason}</p>}
        {(finding.decision?.reviewAfter || finding.decision?.reviewWhen) && (
          <small>延期复查：{[finding.decision.reviewAfter, finding.decision.reviewWhen].filter(Boolean).join(' · ')}</small>
        )}
        {finding.repairPlan && <details><summary>修复方案与验收</summary><Markdown skipHtml>{finding.repairPlan}</Markdown></details>}
        {finding.options.length > 0 && (
          <div className={s.actions}>
            {finding.options.map((option, index) => {
              const isSelected = finding.id === selected && option.optionId === selectedOption;
              const tag = option.banned ? ' [已封禁]' : '';
              return isSelected ? (
                <strong key={option.optionId}>{option.optionId}（patch {option.patchId}）· {option.tradeoff}{tag}</strong>
              ) : (
                <Link
                  key={option.optionId}
                  className={s.button}
                  to={`${candidateUrl(projectId, finding.id)}?optionId=${encodeURIComponent(option.optionId)}&patchId=${option.patchId}`}
                >
                  {finding.options.length === 1 ? '查看补丁' : `方案 ${index + 1} (${option.optionId})`} · {option.tradeoff}{tag}
                </Link>
              );
            })}
          </div>
        )}
        <ErrorBox error={run.error} />
        <div className={s.actions}>
          {canAcceptAsIs && <button disabled={disabled} onClick={() => setAction('accept_as_is')}>接受现状</button>}
          {canDefer && <button disabled={disabled} onClick={() => setAction('defer')}>延期</button>}
          {canHumanTakeover && (
            <button
              disabled={disabled}
              onClick={() => (finding.issueStatus === 'awaiting_verification' ? setAction('human_takeover') : run.mutate({ action: 'human_takeover' }))}
            >
              {finding.issueStatus === 'awaiting_verification' ? '撤回至人工接手' : '人工接手'}
            </button>
          )}
          {canResumeReview && <button disabled={disabled} onClick={() => setAction('resume_review')}>{finding.deferred ? '解除延期' : '恢复审核'}</button>}
          {canAct && finding.issueStatus === 'human_takeover' && <button disabled={disabled} onClick={() => setAction('add_repair_hint')}>提交修复线索</button>}
          {canAct && finding.issueStatus === 'human_takeover' && <button disabled={disabled} onClick={() => setAction('external_completed')}>反馈外部完成</button>}
          <button onClick={() => void navigator.clipboard.writeText([
            finding.title,
            finding.findingId,
            `基线 ${finding.baseRevision ?? ''}`,
            finding.targetFiles.join('\n'),
            finding.summary,
            finding.repairPlan ?? '',
          ].join('\n\n')).then(() => setCopied('已复制')).catch(() => setCopied('复制失败'))}
          >
            复制交接内容
          </button>
          <span role="status">{copied}</span>
        </div>
        {finding.repairHints.length > 0 && <ul>{finding.repairHints.map((hint, index) => <li key={index}>{hint}</li>)}</ul>}
        {canAct && action && (
          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              run.mutate({
                action,
                ...(action === 'add_repair_hint' ? { hint: reason.trim() } : reason.trim() ? { reason: reason.trim() } : {}),
                ...(action === 'defer' && reviewAfter ? { reviewAfter } : {}),
                ...(action === 'defer' && reviewWhen.trim() ? { reviewWhen: reviewWhen.trim() } : {}),
              });
            }}
          >
            <label>
              {action === 'add_repair_hint' ? '修复线索' : action === 'external_completed' ? '外部完成说明' : '处置理由'}
              <textarea required={reasonRequired} value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            {action === 'defer' && (
              <>
                <label>复查日期<input type="date" value={reviewAfter} onChange={(event) => setReviewAfter(event.target.value)} /></label>
                <label>复查条件<input value={reviewWhen} onChange={(event) => setReviewWhen(event.target.value)} /></label>
              </>
            )}
            <div className={s.actions}>
              <button disabled={disabled || (reasonRequired && !reason.trim())}>保存</button>
              <button type="button" onClick={() => { setAction(''); setReason(''); }}>取消</button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
