import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import type {
  OptionPatchCheck,
  PatchEntry,
  RepairOption,
  ReviewCandidate,
  ReviewComment,
} from '@dsh-review/protocol';
import {
  command,
  detail,
  request,
  type CommandRecord,
  type FindingView,
  type ProjectView,
} from '../api.js';
import s from '../App.module.css';
import { Badge, Empty, ErrorBox, Heading, label, Panel, time, UserContext } from '../components/Common.js';
import { FindingCard } from '../components/FindingCard.js';
import { Diff, type Anchor } from '../Diff.js';

export interface CandidateView {
  selection?: { optionId: string; patchId: number };
  selectedOption?: RepairOption;
  selectedPatch?: PatchEntry;
  selectedPatchBanned?: boolean;
  candidate: ReviewCandidate;
  finding: FindingView;
  patchText: string;
  currentBase: string | null;
  isBaseBehind: boolean;
  comments: ReviewComment[];
  validation: string[];
  patchCheck?: OptionPatchCheck;
  approvalCommitRevision?: string;
  approvalCommitLookup?: 'found' | 'ambiguous' | 'unknown';
}

export function CandidatePage() {
  const { projectId = '', '*': id = '' } = useParams();
  const user = useContext(UserContext);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [selectionParams] = useSearchParams();
  const optionId = selectionParams.get('optionId') ?? '';
  const patchId = selectionParams.get('patchId') ?? '';
  const optionQuery: Record<string, string> = optionId ? { optionId, ...(patchId ? { patchId } : {}) } : {};
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => request<ProjectView>(`/projects/${projectId}`),
    refetchInterval: 4000,
  });
  const candidate = useQuery({
    queryKey: ['candidate', projectId, id, optionId, patchId, project.data?.vcsSnapshot],
    queryFn: ({ signal }) => detail<CandidateView>(projectId, 'candidate', { id, ...optionQuery }, signal),
    enabled: Boolean(project.data?.vcsSnapshot),
  });
  const [tab, setTab] = useState('overview');
  const [comment, setComment] = useState('');
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [waived, setWaived] = useState<Record<string, string>>({});
  const [approveOpen, setApproveOpen] = useState(false);
  const [commitDetail, setCommitDetail] = useState<'simple' | 'detailed'>('detailed');
  const [diffFrom, setDiffFrom] = useState('0');
  const [draftVersion, setDraftVersion] = useState('');
  const [decisionVersion, setDecisionVersion] = useState('');
  const [approvalVersion, setApprovalVersion] = useState('');
  const [submission, setSubmission] = useState<{ commandId: string; draftKey: string; text: string; anchor: Anchor | null; version: string } | null>(null);
  const [gateConsent, setGateConsent] = useState(false);
  const [gateVersion, setGateVersion] = useState('');
  const draftKey = `review-draft:${user.userId}:${projectId}:${id}`;
  const submitted = submission?.commandId ?? '';
  const [diffFolding, setDiffFolding] = useState<{ scope: string; revision?: number; files: string[] }>({ scope: '', files: [] });
  const activeView = useRef<string | null>(draftKey);
  useEffect(() => { activeView.current = draftKey; return () => { activeView.current = null; }; }, [draftKey]);

  // 切换候选或方案时重置增量对比起点，避免沿用旧候选的 patchId。
  useEffect(() => {
    setDiffFrom('0');
  }, [id, optionId]);

  const value = candidate.data;
  const meta = value?.candidate.meta;
  const owner = meta?.owner === user.reviewIdentity;
  const version = meta ? `${meta.recordRevision}/${meta.updatedAt}/${value?.selection?.optionId ?? ''}/${value?.selection?.patchId ?? ''}` : '';
  const finding = value?.finding;
  const selectedOption = value?.selectedOption ?? (value?.selection ? meta?.options.find((opt) => opt.id === value.selection?.optionId) : meta?.options[0]);
  const gateChecks = selectedOption?.gateChecks ?? [];
  const approvalTarget = JSON.stringify([id, version, value?.selection]);
  const currentPatchId = value?.selection?.patchId ?? selectedOption?.currentPatch;
  const previousPatches = meta?.patches.filter((patch) => patch.id !== currentPatchId && (!selectedOption || patch.optionId === selectedOption.id)) ?? [];
  const diffScope = JSON.stringify([projectId, id, diffFrom, ...(value?.selection ? [value.selection.optionId, value.selection.patchId] : [])]);

  useEffect(() => {
    if (!value) {
      const prefix = `${JSON.stringify([projectId, id]).slice(0, -1)},`;
      setDiffFolding((current) => (current.scope.startsWith(prefix) ? current : { scope: '', files: [] }));
      return;
    }
    setDiffFolding((current) => (current.scope === diffScope && (meta?.recordRevision === undefined || current.revision === meta.recordRevision)
      ? current
      : { scope: diffScope, revision: meta?.recordRevision, files: [] }));
  }, [diffScope, meta?.recordRevision, value, projectId, id]);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
      setComment(saved?.text ?? ''); setAnchor(saved?.anchor ?? null); setDraftVersion(saved?.version ?? '');
    } catch { setComment(''); setAnchor(null); setDraftVersion(''); }
    setConfirmed([]); setWaived({}); setDecisionVersion(''); setApproveOpen(false); setSubmission(null);
  }, [draftKey]);

  const saveDraft = (text: string, position: Anchor | null, stamp: string) => {
    setComment(text); setAnchor(position); setDraftVersion(stamp);
    try {
      if (text || position) sessionStorage.setItem(draftKey, JSON.stringify({ text, anchor: position, version: stamp }));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  };

  const status = useQuery({
    queryKey: ['submitted-comment', submitted],
    queryFn: () => request<{ command: CommandRecord }>(`/commands/${submitted}`),
    enabled: Boolean(submitted),
    refetchInterval: (query) => (query.state.data?.command.state === 'completed' ? false : 2000),
  });

  useEffect(() => {
    if (!submission || submission.draftKey !== draftKey || status.data?.command.state !== 'completed' || status.data.command.result?.outcome.status !== 'COMMITTED') return;
    if (comment === submission.text && draftVersion === submission.version && JSON.stringify(anchor) === JSON.stringify(submission.anchor)) saveDraft('', null, '');
    void client.invalidateQueries({ queryKey: ['project', projectId] });
  }, [status.data?.command.state, submitted]);

  const guard = meta ? { expectedRevision: meta.recordRevision, expectedOwner: meta.owner, expectedUpdatedAt: meta.updatedAt } : undefined;
  const run = useMutation({
    mutationFn: ({ operation, payload }: { operation: string; payload?: Record<string, unknown> }) => command(
      projectId,
      operation,
      { id, ...(['approve', 'ai-fix', 'rebase'].includes(operation) ? value?.selection ?? {} : {}), ...payload },
      guard,
    ),
    onMutate: () => ({ draftKey, text: comment, anchor: structuredClone(anchor), version: draftVersion, projectId }),
    onSuccess: (result, _variables, origin) => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
      if (!origin || activeView.current !== origin.draftKey) return;
      if (result.command.operation === 'comments') setSubmission({ commandId: result.command.commandId, ...origin });
      else navigate(`/tasks?projectId=${origin.projectId}`);
    },
  });

  const writable = Boolean(project.data?.writable && owner && !value?.candidate.parseError && !run.isPending);
  const commentable = Boolean(meta && ['pending', 'changes_requested', 'repair_failed'].includes(meta.status));
  const canApproveOption = Boolean(
    meta && meta.status === 'pending' && !finding?.deferred && selectedOption && value?.selection && !value.selectedPatchBanned && gateChecks.length > 0,
  );
  const decisions = meta?.humanDecisions ?? [];
  const allDecisionsCovered = decisions.every((item) =>
    decisionVersion === version && (confirmed.includes(item.id) || (waived[item.id] ?? '').trim().length > 0),
  );
  const comparison = useQuery({
    queryKey: ['comparison', projectId, id, optionId, patchId, project.data?.vcsSnapshot, diffFrom],
    queryFn: ({ signal }) => detail<{ unifiedDiff: string; notes?: string[] }>(projectId, 'diff', { id, from: diffFrom, ...optionQuery }, signal),
    enabled: tab === 'diff' && diffFrom !== '0' && Boolean(value),
  });
  const draftStale = Boolean(comment && draftVersion && version && draftVersion !== version);
  const hasDraft = Boolean(comment || anchor);
  const canApprove = gateConsent && gateVersion === version && approvalVersion === approvalTarget
    && canApproveOption && writable && value?.candidate.humanJudgmentDeclared && !value.validation.length && allDecisionsCovered;

  const submitComment = (event: FormEvent) => {
    event.preventDefault();
    run.mutate({
      operation: 'comments',
      payload: {
        content: comment,
        ...(anchor ? { ...anchor, ...(value?.selection ?? {}) } : {}),
      },
    });
  };

  const repairAttempts = meta?.repairAttempts ?? [];
  const hasRelevantUnresolvedComments = Boolean(
    selectedOption && meta?.comments.some((item) => item.status !== 'resolved' && (!item.optionId || item.optionId === selectedOption.id)),
  );

  return (
    <>
      <Link className={s.back} to="/queue">← 问题队列</Link>
      <Heading
        eyebrow={`${project.data?.project.name ?? 'PROJECT'} / ISSUE`}
        title={meta?.title ?? '问题详情'}
        actions={<button onClick={() => { void project.refetch(); void candidate.refetch(); }}>刷新详情</button>}
      >
        {id}
      </Heading>
      <ErrorBox error={project.error ?? candidate.error ?? run.error ?? status.error} />
      {submitted && (
        <div className={s.notice}>
          {status.data?.command.result ? `${label(status.data.command.result.outcome.status)}：${String(status.data.command.result.outcome.message ?? '')}` : '审核意见已受理，等待节点提交与同步。'}
          <Link to={`/tasks?projectId=${projectId}`}>查看任务 →</Link>
        </div>
      )}
      {project.data && (
        <div className={s.notice}>
          <Badge value={project.data.freshness} />
          {project.data.freshness !== 'synced' ? '正在展示最后同步的版本。' : '操作提交后，由节点重新校验版本与负责人。'}
        </div>
      )}
      {candidate.isPending ? (
        <Empty>{project.data?.vcsSnapshot ? '正在向节点读取问题与补丁…' : '项目还没有可用快照。'}</Empty>
      ) : value && meta ? (
        <>
          <div className={s.candidateHeader}>
            <div className={s.actions}>
              <Badge value={meta.status} />
              {finding?.deferred && <Badge value="deferred" />}
              <Badge value={meta.issueKind} />
              <span>{meta.priority}</span>
              <span>负责人 {meta.owner}</span>
              <span>记录 {meta.recordRevision}</span>
              <span>{time(meta.updatedAt)}</span>
            </div>
            <div className={s.actions}>
              {!owner && !['approved', 'resolved'].includes(meta.status) && (
                <button
                  disabled={!project.data?.writable || run.isPending}
                  onClick={() => {
                    if (window.confirm(`将负责人从“${meta.owner}”改为“${user.reviewIdentity}”？`)) run.mutate({ operation: 'takeover' });
                  }}
                >
                  接管问题
                </button>
              )}
              {canApproveOption && (
                <button
                  className={s.primary}
                  disabled={!writable}
                  onClick={() => {
                    setApprovalVersion(approvalTarget); setGateConsent(false); setGateVersion(''); setApproveOpen(true);
                  }}
                >
                  批准并应用 ({selectedOption?.id}) →
                </button>
              )}
            </div>
          </div>
          {finding && (
            <FindingCard
              key={`${finding.id}/${finding.recordRevision}`}
              finding={finding}
              projectId={projectId}
              writable={project.data?.writable && owner}
              selected={id}
              selectedOption={value.selection?.optionId}
            />
          )}
          {value.selectedPatchBanned && (
            <div className={s.error} role="alert">
              当前方案补丁（{value.selection?.optionId} / patch {value.selection?.patchId}）曾因门禁验证失败被永久封禁，禁止再次批准。请提交意见修订补丁、切换到另一未失败方案或转人工处理。
            </div>
          )}
          {repairAttempts.length > 0 && (
            <Panel title={`修复尝试记录（共 ${repairAttempts.length} 次；门禁失败绝不自动重试）`}>
              <div className={s.document}>
                {repairAttempts.map((attempt) => (
                  <article key={attempt.id}>
                    <h3>尝试 #{attempt.id} · {attempt.optionId} / patch {attempt.patchId} · {attempt.result} ({attempt.applyMode})</h3>
                    <p>{attempt.evidence}（业务工作区还原：{attempt.restored ? '已彻底还原' : attempt.result === 'applied' ? '已落地' : '还原异常，需人工核验'}）</p>
                  </article>
                ))}
              </div>
            </Panel>
          )}
          {meta.status === 'approved' && (
            <div className={s.notice}>
              <span>业务提交版本：{value.approvalCommitRevision ?? '尚未派生'}</span>
              <small>{value.approvalCommitLookup === 'found' ? '已找到业务提交。' : value.approvalCommitLookup === 'ambiguous' ? '匹配到多个业务提交，仅为诊断。' : '暂未确认业务提交版本，仅为诊断。'}</small>
            </div>
          )}
          {value.candidate.parseError && <ErrorBox error={value.candidate.parseError} />}
          {value.isBaseBehind && commentable && selectedOption && (
            <div className={s.notice}>
              业务基线已变化。
              <button disabled={!writable} onClick={() => run.mutate({ operation: 'rebase' })}>重新基于最新代码生成补丁</button>
            </div>
          )}
          <div className={s.tabs}>
            {[['overview', '方案与证据'], ['diff', '代码差异'], ['comments', `审核意见 · ${meta.comments.length}`], ['history', '补丁账本与门禁']].map(([key, title]) => (
              <button key={key} aria-selected={tab === key} onClick={() => setTab(key!)}>{title}</button>
            ))}
          </div>
          <div className={s.reviewColumns}>
            <div>
              {tab === 'overview' && (
                <Panel title="问题与修复方案">
                  <div className={s.document}>
                    {[['问题描述', value.candidate.sections.problem], ['根本原因', value.candidate.sections.rootCause], ['修复方案', value.candidate.sections.solution], ['验证证据', value.candidate.sections.evidence]].map(([title, text]) => (
                      <article key={title}><h3>{title}</h3><div className={s.markdown}><Markdown skipHtml>{text || '未提供'}</Markdown></div></article>
                    ))}
                    {selectedOption && (
                      <article>
                        <h3>合并门禁命令（明文）</h3>
                        <pre>{gateChecks.join('\n') || '未配置'}</pre>
                      </article>
                    )}
                  </div>
                </Panel>
              )}
              {tab === 'diff' && (
                <Panel title={selectedOption ? `方案 ${selectedOption.id} · patch ${currentPatchId}` : '无补丁方案'} extra={<small>点击代码行添加定位意见</small>}>
                  {selectedOption ? (
                    <>
                      <div className={s.form}>
                        <label>
                          比较范围
                          <select value={diffFrom} onChange={(event) => setDiffFrom(event.target.value)}>
                            <option value="0">当前完整补丁</option>
                            {previousPatches.map((patch) => <option key={patch.id} value={String(patch.id)}>patch {patch.id} → patch {currentPatchId}</option>)}
                          </select>
                        </label>
                        <ErrorBox error={comparison.error} />
                        {comparison.isFetching && <small>正在读取版本差异…</small>}
                        {comparison.data?.notes?.map((note) => <small key={note}>{note}</small>)}
                      </div>
                      {diffFrom !== '0' && <p className={s.diffNote}>增量比较可在当前版本右侧添加定位意见。</p>}
                      <Diff
                        collapsedFiles={diffFolding.scope === diffScope && diffFolding.revision === meta.recordRevision ? diffFolding.files : []}
                        onCollapsedFilesChange={(files) => setDiffFolding({ scope: diffScope, revision: meta.recordRevision, files })}
                        allowLeft={diffFrom === '0'}
                        comments={value.comments}
                        optionId={value.selection?.optionId}
                        text={diffFrom === '0' ? value.patchText : comparison.data?.unifiedDiff ?? ''}
                        onSelect={(selectedLine) => { saveDraft(comment, selectedLine, version); setTab('comments'); }}
                      />
                    </>
                  ) : <Empty>当前为纯文字方案（{label(meta.issueKind)}），没有关联补丁。</Empty>}
                </Panel>
              )}
              {tab === 'comments' && (
                <Panel title="审核意见">
                  <div className={s.document}>
                    {value.comments.length ? value.comments.map((item) => (
                      <article key={item.id}>
                        <div className={s.actions}>
                          <b>{item.author}</b>
                          <Badge value={item.status} />
                          <small>记录 {item.revision}{item.optionId ? ` / ${item.optionId} / patch ${item.patchId}` : ''}</small>
                          {writable && commentable && (
                            <select
                              aria-label="评论处理状态"
                              value={item.status}
                              onChange={(event) => run.mutate({ operation: 'comment-status', payload: { commentId: item.id, status: event.target.value } })}
                            >
                              <option value="unresolved">未解决</option>
                              <option value="partial">部分处理</option>
                              <option value="resolved">已解决</option>
                            </select>
                          )}
                        </div>
                        {item.file && <small className={s.mono}>{item.file}:{item.line} · {item.side}</small>}
                        <p>{item.content}</p>
                      </article>
                    )) : <Empty>还没有审核意见。</Empty>}
                    <form className={s.commentForm} onSubmit={submitComment}>
                      {anchor && (
                        <div className={s.notice}>
                          <small>{anchor.file}:{anchor.line} · {anchor.side}</small>
                          <button type="button" onClick={() => saveDraft(comment, null, draftVersion)}>移除定位</button>
                        </div>
                      )}
                      <label>新增审核意见<textarea required value={comment} onChange={(event) => saveDraft(event.target.value, anchor, draftVersion || version)} placeholder="说明问题、期望行为与验证方式…" /></label>
                      {draftStale && (
                        <div className={s.notice}>
                          版本已更新，草稿保留。请对照新代码检查意见与定位。
                          <button type="button" onClick={() => saveDraft(comment, null, version)}>已核对，应用到当前版本</button>
                        </div>
                      )}
                      <small>意见基于当前记录 {meta.recordRevision}。版本冲突时草稿会保留。</small>
                      <button className={s.primary} disabled={!writable || !commentable || !comment.trim() || draftStale || Boolean(submitted && status.data?.command.state !== 'completed')}>提交意见</button>
                    </form>
                  </div>
                </Panel>
              )}
              {tab === 'history' && (
                <Panel title="补丁账本、门禁与历史">
                  <div className={s.document}>
                    <h3>不可变补丁账本</h3>
                    {meta.patches.length > 0 ? meta.patches.map((patch) => (
                      <article key={patch.id}>
                        <h4>patch #{patch.id}（{patch.optionId}）· {patch.author}</h4>
                        <small>{patch.patch} · base {patch.baseRevision} · sha256 {patch.sha256.slice(0, 12)}</small>
                      </article>
                    )) : <p>无补丁文件。</p>}
                    <h3>当前方案门禁命令（明文）</h3>
                    <pre>{gateChecks.join('\n') || '未配置'}</pre>
                    {meta.approval && (
                      <>
                        <h3>当前批准记录</h3>
                        <p>{meta.approval.approvedBy} · {time(meta.approval.approvedAt)} · {meta.approval.optionId} / patch {meta.approval.patchId}</p>
                        <pre>{JSON.stringify(meta.approval.gateResults, null, 2)}</pre>
                      </>
                    )}
                    {meta.approvalHistory.length > 0 && (
                      <>
                        <h3>往期批准历史（{meta.approvalHistory.length}）</h3>
                        <pre>{JSON.stringify(meta.approvalHistory, null, 2)}</pre>
                      </>
                    )}
                  </div>
                </Panel>
              )}
            </div>
            <aside>
              <Panel title="人工判断">
                <div className={s.form}>
                  {!value.candidate.humanJudgmentDeclared && <ErrorBox error="问题未填写人工判断章节，暂不能批准。" />}
                  {decisions.length ? decisions.map((item) => (
                    <div key={item.id} className={s.form}>
                      <label className={s.check}>
                        <input
                          type="checkbox"
                          checked={decisionVersion === version && confirmed.includes(item.id)}
                          onChange={(event) => {
                            setDecisionVersion(version);
                            setConfirmed((current) => {
                              const base = decisionVersion === version ? current : [];
                              return event.target.checked ? [...new Set([...base, item.id])] : base.filter((x) => x !== item.id);
                            });
                          }}
                        />
                        <span><b>{item.question}</b>{item.note && <small>{item.note}</small>}</span>
                      </label>
                      {!(decisionVersion === version && confirmed.includes(item.id)) && (
                        <input
                          placeholder="或填写放弃理由（选填）"
                          value={decisionVersion === version ? (waived[item.id] ?? '') : ''}
                          onChange={(event) => {
                            setDecisionVersion(version);
                            setWaived((current) => ({ ...(decisionVersion === version ? current : {}), [item.id]: event.target.value }));
                          }}
                        />
                      )}
                    </div>
                  )) : <p>当前问题没有待确认的判断项。</p>}
                  {value.candidate.humanJudgment.map((item, index) => <small key={index}>{item.label} {item.text}</small>)}
                </div>
              </Panel>
              <Panel title="后续操作">
                <div className={s.form}>
                  {selectedOption && (
                    <button
                      disabled={!writable || !commentable || hasDraft || !hasRelevantUnresolvedComments}
                      onClick={() => run.mutate({ operation: 'ai-fix' })}
                    >
                      让 AI 按意见修订提案
                    </button>
                  )}
                  {hasDraft && <small>请先提交审核意见草稿，再启动 AI 修订。</small>}
                  {meta.status === 'changes_requested' && <button disabled={!writable} onClick={() => run.mutate({ operation: 'resume' })}>恢复为待审核</button>}
                  <small>当前登录身份：{user.reviewIdentity}<br />{owner ? '你是此问题负责人。' : '接管后可提交意见或执行审核。'}</small>
                </div>
              </Panel>
            </aside>
          </div>
          {approveOpen && (
            <div className={s.modalBackdrop}>
              <section role="dialog" aria-modal="true" aria-labelledby="approve-title" className={s.modal}>
                <h2 id="approve-title">批准并交付代码</h2>
                <p>节点将重新校验记录 {meta.recordRevision}（{value.selection?.optionId} / patch {value.selection?.patchId}），执行以下门禁后提交到 {project.data?.project.target}，并{project.data?.project.vcsType === 'git' ? '推送 Git 远端' : '提交 SVN 远端'}。</p>
                <div>
                  <h3>将执行的完整门禁命令（明文展示）</h3>
                  <pre className={s.logs}>{gateChecks.join('\n') || '此方案未配置门禁。'}</pre>
                </div>
                <label>
                  提交信息详略
                  <select value={commitDetail} onChange={(event) => setCommitDetail(event.target.value as 'simple' | 'detailed')}>
                    <option value="detailed">详细信息（含作者统计、改动摘要、修复方案与门禁）</option>
                    <option value="simple">简略信息（仅首行 review 标题）</option>
                  </select>
                </label>
                <small>命令将在节点以 DSH 当前用户权限执行。</small>
                <label className={s.check}>
                  <input type="checkbox" checked={gateConsent && gateVersion === version} onChange={(event) => { setGateConsent(event.target.checked); setGateVersion(version); }} />
                  我已核对并同意节点执行以上全部门禁命令
                </label>
                <p>{decisions.length ? `人工判断：${decisions.filter((d) => decisionVersion === version && (confirmed.includes(d.id) || (waived[d.id] ?? '').trim())).length}/${decisions.length} 项已覆盖。` : '无需额外人工判断。'}</p>
                {value.validation.map((error) => <ErrorBox key={error} error={error} />)}
                {!canApprove && <small>请确认或填写理由覆盖全部判断项、勾选门禁确认，并确保节点在线且无未决任务。</small>}
                <div className={s.actions}>
                  <button
                    className={s.primary}
                    disabled={!canApprove}
                    onClick={() => {
                      const activeConfirmed = decisionVersion === version
                        ? decisions.filter((d) => confirmed.includes(d.id)).map((d) => d.id)
                        : [];
                      const activeWaived = decisionVersion === version
                        ? decisions
                            .filter((d) => !activeConfirmed.includes(d.id) && (waived[d.id] ?? '').trim().length > 0)
                            .map((d) => ({ id: d.id, reason: (waived[d.id] ?? '').trim() }))
                        : [];
                      run.mutate({
                        operation: 'approve',
                        payload: {
                          confirmedDecisions: activeConfirmed,
                          waivedDecisions: activeWaived,
                          commitDetail,
                        },
                      });
                    }}
                  >
                    确认批准并交付
                  </button>
                  <button onClick={() => setApproveOpen(false)}>返回检查</button>
                </div>
              </section>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
