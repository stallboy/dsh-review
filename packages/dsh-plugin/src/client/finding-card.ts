import { statusText } from './api.js';
import type { RichTextComponent } from './rich-text.js';
import type { IssueFindingView, ReactLike } from './types.js';

export interface FindingCardProps {
  finding: IssueFindingView;
  currentId?: string;
  currentOption?: string;
  canAct: boolean;
  busy: boolean;
  choose(id: string, selection?: { optionId: string; patchId: number }): void;
  save(body: Record<string, unknown>): void;
}

export type FindingCardComponent = (props: FindingCardProps) => unknown;

export function createFindingCard(React: ReactLike, RichText: RichTextComponent): FindingCardComponent {
  const h = React.createElement;
  const { useState } = React;

  return function FindingCard(props: FindingCardProps) {
    const { finding, currentId, canAct, busy, choose, save } = props;
    const [form, setForm] = useState('');
    const [reason, setReason] = useState('');
    const [reviewAfter, setReviewAfter] = useState('');
    const [reviewWhen, setReviewWhen] = useState('');
    const [copy, setCopy] = useState('');

    const closed = finding.issueStatus === 'approved' || finding.issueStatus === 'resolved';
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
    const reasonRequired = ['accept_as_is', 'defer', 'resume_review', 'add_repair_hint', 'external_completed'].includes(form)
      || (form === 'human_takeover' && finding.issueStatus === 'awaiting_verification');

    const submit = (action: string, fields: Record<string, unknown> = {}): void => {
      save({
        id: finding.id,
        expectedRevision: finding.recordRevision,
        expectedOwner: finding.owner,
        expectedUpdatedAt: finding.updatedAt,
        action,
        ...fields,
      });
      setForm('');
      setReason('');
    };

    return h('section', { className: 'dcr-card', 'aria-label': finding.title },
      h('div', { className: 'dcr-row' },
        h('h2', { className: 'dcr-grow', style: { margin: 0, fontSize: 15 } }, `${finding.priority} · ${finding.title}`),
        h('span', { className: `dcr-chip ${finding.issueStatus}` }, statusText(finding.issueStatus)),
        finding.deferred ? h('span', { className: 'dcr-chip warn' }, '已延期') : null,
        h('span', { className: 'dcr-chip' }, finding.issueKind === 'repair' ? '补丁修复' : finding.issueKind === 'confirm' ? '文字方案（无补丁）' : '前置依赖延期（无补丁）'),
      ),
      h('p', null, finding.summary),
      finding.dependsOn ? h('p', { className: 'dcr-small dcr-muted' }, `依赖前置问题：${finding.dependsOn}`) : null,
      finding.id !== currentId ? h('button', { className: 'dcr-btn', onClick: () => choose(finding.id) }, '查看问题详情、证据与历史') : null,
      finding.decision?.reason ? h('p', null, `处置说明：${finding.decision.reason}`) : null,
      finding.decision?.reviewAfter || finding.decision?.reviewWhen
        ? h('p', { className: 'dcr-small dcr-muted' }, `复查条件：${[finding.decision.reviewAfter, finding.decision.reviewWhen].filter(Boolean).join(' · ')}`) : null,
      finding.repairPlan ? h('details', null, h('summary', null, '修复方案与验收'), h(RichText, { text: finding.repairPlan })) : null,
      finding.options.length > 0 ? h('div', { className: 'dcr-row', style: { marginTop: 8 } }, ...finding.options.map((option, index) =>
        h('button', {
          key: option.optionId,
          className: `dcr-btn ${option.banned ? 'd' : ''}`,
          disabled: finding.id === currentId && option.optionId === props.currentOption,
          onClick: () => choose(finding.id, { optionId: option.optionId, patchId: option.patchId }),
        },
        `${finding.options.length === 1 ? '查看补丁' : `方案 ${String(index + 1)} (${option.optionId})`} · ${option.tradeoff}${option.banned ? ' [已封禁]' : ''}`))) : null,
      h('div', { className: 'dcr-row', style: { marginTop: 8 } },
        canAcceptAsIs ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => setForm('accept_as_is') }, '接受现状') : null,
        canDefer ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => setForm('defer') }, '延期') : null,
        canHumanTakeover ? h('button', {
          className: 'dcr-btn',
          disabled: busy,
          onClick: () => (finding.issueStatus === 'awaiting_verification' ? setForm('human_takeover') : submit('human_takeover')),
        }, finding.issueStatus === 'awaiting_verification' ? '撤回至人工接手' : '人工接手') : null,
        canResumeReview ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => setForm('resume_review') }, finding.deferred ? '解除延期' : '恢复审核') : null,
        canAct && finding.issueStatus === 'human_takeover' ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => setForm('add_repair_hint') }, '提交修复线索') : null,
        canAct && finding.issueStatus === 'human_takeover' ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => setForm('external_completed') }, '反馈外部完成') : null,
        h('button', {
          className: 'dcr-btn',
          onClick: () => {
            const text = [finding.title, finding.findingId, `基线 ${finding.baseRevision ?? ''}`, finding.targetFiles.join('\n'),
              finding.summary, finding.repairPlan ?? ''].join('\n\n');
            void navigator.clipboard.writeText(text).then(() => setCopy('已复制')).catch(() => setCopy('复制失败'));
          },
        }, '复制交接内容'),
        h('span', { role: 'status' }, copy),
      ),
      finding.repairHints.length > 0 ? h('ul', null, ...finding.repairHints.map((hint, index) => h('li', { key: index }, hint))) : null,
      canAct && form ? h('div', { style: { marginTop: 8 } },
        h('textarea', {
          className: 'dcr-textarea',
          'aria-label': form === 'add_repair_hint' ? '修复线索' : form === 'external_completed' ? '外部完成说明' : '处置理由',
          placeholder: form === 'add_repair_hint' ? '填写修复线索或提交编号…' : form === 'external_completed' ? '请填写外部完成说明或关联提交…' : '请填写处置理由…',
          value: reason,
          onChange: (event: { target: { value: string } }) => setReason(event.target.value),
        }),
        form === 'defer' ? h('div', { className: 'dcr-row', style: { marginTop: 6 } },
          h('input', { className: 'dcr-input', type: 'date', 'aria-label': '复查日期', value: reviewAfter, onChange: (event: { target: { value: string } }) => setReviewAfter(event.target.value) }),
          h('input', { className: 'dcr-input', 'aria-label': '复查条件', placeholder: '触发复查条件', value: reviewWhen, onChange: (event: { target: { value: string } }) => setReviewWhen(event.target.value) })) : null,
        h('div', { className: 'dcr-row', style: { marginTop: 6 } },
          h('button', {
            className: 'dcr-btn p',
            disabled: busy || (reasonRequired && !reason.trim()),
            onClick: () => submit(form, form === 'add_repair_hint'
              ? { hint: reason.trim() }
              : {
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                  ...(form === 'defer' && reviewAfter ? { reviewAfter } : {}),
                  ...(form === 'defer' && reviewWhen.trim() ? { reviewWhen: reviewWhen.trim() } : {}),
                }),
          }, '保存'),
          h('button', { className: 'dcr-btn', onClick: () => { setForm(''); setReason(''); } }, '取消'),
        ),
      ) : null,
    );
  };
}
