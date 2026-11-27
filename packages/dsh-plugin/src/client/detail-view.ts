import type { UnifiedDiffFile } from '@dsh-review/protocol';
import { commentText, dateText, short, statsText, statusText } from './api.js';
import type { DiffDraft, DiffViewComponent } from './diff-view.js';
import type { FindingCardComponent } from './finding-card.js';
import type { RichTextComponent } from './rich-text.js';
import {
  EMPTY_STATS,
  type Detail,
  type DiffResult,
  type ReactLike,
  type ReviewComment,
  type Settings,
} from './types.js';

export interface DetailViewProps {
  detail: Detail | null;
  stale: boolean;
  error: string;
  busy: boolean;
  settings: Settings | null;
  panel: '' | 'approve';
  setPanel(next: '' | 'approve'): void;
  ack: Record<string, boolean>;
  setAck(next: Record<string, boolean>): void;
  waiveReason: Record<string, string>;
  setWaiveReason(next: Record<string, string>): void;
  commitDetail: 'simple' | 'detailed';
  setCommitDetail(next: 'simple' | 'detailed'): void;
  general: string;
  setGeneral(value: string): void;
  batchDrafts: string[];
  setBatchDrafts(next: string[]): void;
  fixTarget: 'session' | 'export';
  setFixTarget(next: 'session' | 'export'): void;
  fixLaunching: boolean;
  fixSession: { sessionId: string; title: string; revision: number } | null;
  fixPrompt: { text: string; revision: number } | null;
  fixPromptLoading: boolean;
  fixCopied: boolean;
  diff: DiffResult | null;
  diffFiles: UnifiedDiffFile[];
  diffMode: 'full' | 'incremental';
  setDiffMode(mode: 'full' | 'incremental'): void;
  diffFrom: number;
  setDiffFrom(from: number): void;
  diffLayout: 'auto' | 'split' | 'unified';
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void;
  diffWidth: number | null;
  diffLoading: boolean;
  diffCardRef: { current: unknown };
  draft: DiffDraft | null;
  setDraft(next: DiffDraft | null): void;
  renderJob(): unknown;
  onReloadCurrent(): void;
  onTakeover(): Promise<void>;
  onResumeCandidate(): Promise<void>;
  onApprove(): void;
  onRebase(): Promise<void>;
  onFinalizeCandidate(): void;
  onAddComment(
    file: string,
    line: number,
    text: string,
    autoFix?: boolean,
    side?: 'LEFT' | 'RIGHT',
    anchor?: { snippet: string; before?: string; after?: string },
  ): Promise<boolean>;
  onSubmitBatch(drafts: string[]): Promise<boolean>;
  onSubmitFeedbackAndFix(drafts: string[]): Promise<boolean>;
  onSetCommentStatus(commentId: string, status: ReviewComment['status']): Promise<void>;
  onCopyFixPrompt(): Promise<void>;
  onOpenCandidate(id: string, selection?: { optionId: string; patchId: number }): void;
  onSaveFindingDecision(body: Record<string, unknown>): void;
}

export type DetailViewComponent = (props: DetailViewProps) => unknown;

export function createDetailView(
  React: ReactLike,
  RichText: RichTextComponent,
  FindingCard: FindingCardComponent,
  DiffView: DiffViewComponent,
): DetailViewComponent {
  const h = React.createElement;

  return function DetailView(props: DetailViewProps) {
    const {
      detail,
      stale,
      error,
      busy,
      settings,
      panel,
      setPanel,
      ack,
      setAck,
      waiveReason,
      setWaiveReason,
      commitDetail,
      setCommitDetail,
      general,
      setGeneral,
      batchDrafts,
      setBatchDrafts,
      fixTarget,
      setFixTarget,
      fixLaunching,
      fixSession,
      fixPrompt,
      fixPromptLoading,
      fixCopied,
      diff,
      diffFiles,
      diffMode,
      setDiffMode,
      diffFrom,
      setDiffFrom,
      diffLayout,
      setDiffLayout,
      diffWidth,
      diffLoading,
      diffCardRef,
      draft,
      setDraft,
      renderJob,
      onReloadCurrent,
      onTakeover,
      onResumeCandidate,
      onApprove,
      onRebase,
      onFinalizeCandidate,
      onAddComment,
      onSubmitBatch,
      onSubmitFeedbackAndFix,
      onSetCommentStatus,
      onCopyFixPrompt,
      onOpenCandidate,
      onSaveFindingDecision,
    } = props;

    if (!detail) {
      return h('div', { className: 'dcr-body' },
        error ? h('div', { className: 'dcr-banner err' }, error) : h('div', { className: 'dcr-empty' }, '加载问题…'));
    }

    const candidate = detail.candidate;
    const selectedOption = detail.selectedOption
      ?? (detail.selection ? candidate.meta.options.find((opt) => opt.id === detail.selection?.optionId) : candidate.meta.options[0]);
    const gateChecks = selectedOption?.gateChecks ?? [];
    const canAct = detail.canAct && !stale && ['pending', 'changes_requested', 'repair_failed'].includes(candidate.meta.status);
    const canApproveOption = Boolean(
      canAct
      && candidate.meta.status === 'pending'
      && !detail.finding?.deferred
      && selectedOption
      && detail.selection
      && !detail.selectedPatchBanned
      && gateChecks.length > 0,
    );
    const items = (candidate.meta.humanDecisions ?? []).map((decision) => ({ id: decision.id, label: decision.question }));
    const ackCount = items.filter((item) => ack[item.id]).length;
    const waivedCount = items.filter((item) => !ack[item.id] && (waiveReason[item.id] ?? '').trim().length > 0).length;
    const allAck = items.length === 0 || ackCount + waivedCount === items.length;
    const currentPatchId = detail.selection?.patchId ?? selectedOption?.currentPatch ?? 0;
    const currentPatch = detail.selectedPatch ?? candidate.meta.patches.find((patch) => patch.id === currentPatchId);
    const previousPatches = candidate.meta.patches.filter((patch) => patch.id < currentPatchId && (!selectedOption || patch.optionId === selectedOption.id));
    const baseRevision = currentPatch?.baseRevision ?? '';
    const repairAttempts = candidate.meta.repairAttempts ?? [];
    const approvalHistory = candidate.meta.approvalHistory ?? [];

    const steps = [
      { title: '同步基线', desc: settings?.syncBeforeApprove ? '先 pull --ff-only / svn update；失败即中止。' : '按当前基线验证，不自动同步远端。' },
      { title: '应用补丁', desc: `应用方案 ${detail.selection?.optionId ?? ''} 的 ${currentPatch?.patch ?? '补丁'}（严格 → 三方合并 → Mode C 辅助）。` },
      { title: '执行门禁', desc: `${String(gateChecks.length)} 条明文命令逐条执行，任一失败即还原并永久封禁该补丁。` },
      { title: '原子提交', desc: '业务代码与问题记录进入同一个原子提交，保留不可变补丁账本。' },
    ];

    /** 预览首行按所选方案的人工修订补丁计算，与 Host 的 buildCommitSubject 保持一致。 */
    const commitPreview = (): string => {
      const optionHumanPatches = candidate.meta.patches.filter((patch) =>
        patch.author === 'human' && (!selectedOption || patch.optionId === selectedOption.id));
      const latestHuman = optionHumanPatches.reduce((max, patch) => Math.max(max, patch.id), 0);
      const title = candidate.meta.title.replace(/\s+/g, ' ').trim();
      const subject = `review(${candidate.id}): ${title}${latestHuman > 0 ? ` @ patch ${String(latestHuman)}` : ''}`;
      if (commitDetail === 'simple') return subject;
      return [
        subject,
        '',
        '作者统计（补丁触及文件）：…',
        '',
        '改动摘要：N 个文件，+X / -Y 行',
        '',
        '修复方案：',
        '…',
        '',
        '来源问题：',
        `- .ai-review/${candidate.id}（记录 ${String(candidate.meta.recordRevision)} · ${detail.selection?.optionId ?? ''} / patch ${String(currentPatchId)}）`,
        '',
        `门禁（本次批准重新执行 ${String(gateChecks.length)} 条）：`,
        ...(gateChecks.length > 0 ? gateChecks.map((command) => `- ${command}`) : ['- （无）']),
      ].join('\n');
    };

    const commitMessagePanel = (): unknown => h('div', { className: 'dcr-commit' },
      h('div', { className: 'dcr-row' },
        h('strong', { className: 'dcr-grow' }, '提交信息'),
        h('span', { className: 'dcr-small dcr-muted' }, '首行自动取问题 title（需与标题一致）'),
      ),
      h('div', { className: 'dcr-seg', role: 'group', 'aria-label': '提交信息详略' },
        h('button', {
          className: `dcr-btn ${commitDetail === 'simple' ? 'p' : ''}`,
          type: 'button',
          'aria-pressed': commitDetail === 'simple',
          onClick: () => setCommitDetail('simple'),
        }, '简略信息'),
        h('button', {
          className: `dcr-btn ${commitDetail === 'detailed' ? 'p' : ''}`,
          type: 'button',
          'aria-pressed': commitDetail === 'detailed',
          onClick: () => setCommitDetail('detailed'),
        }, '详细信息'),
      ),
      h('div', { className: 'dcr-small dcr-muted', style: { margin: '6px 0' } },
        commitDetail === 'detailed'
          ? '详细信息：单行综述 → 空行 → 作者统计、改动摘要、修复方案、来源问题、门禁与人工判断项。'
          : '简略信息：只提交一行 `review(<问题>): <标题>`，正文留空。'),
      h('div', { className: 'dcr-small dcr-muted' }, '预览'),
      h('pre', { className: 'dcr-commit-preview' }, commitPreview()),
    );

    const approvalPanel = (): unknown => h('div', { className: 'dcr-card dcr-approve' },
      h('div', { className: 'dcr-row' },
        h('h3', { className: 'dcr-grow', style: { margin: 0 } }, `确认批准并提交（${detail.selection?.optionId ?? ''} / patch ${String(currentPatchId)}）`),
        h('button', { className: 'dcr-btn g', onClick: () => setPanel('') }, '取消'),
      ),
      h('div', { className: 'dcr-approve-steps' },
        ...steps.map((step, index) => h('div', { key: index, className: 'dcr-step' },
          h('div', { className: 'dcr-step-no' }, String(index + 1)),
          h('div', null,
            h('div', { className: 'dcr-step-title' }, step.title),
            h('div', { className: 'dcr-step-desc' }, step.desc),
          ),
        )),
      ),
      h('div', { className: `dcr-banner ${items.length === 0 || allAck ? 'info' : 'warn'}` },
        items.length === 0
          ? (candidate.humanJudgmentDeclared ? 'AI 已确认无需额外人工判断，可直接批准。' : 'AI 未填写需人工判断项，批准前请先补全。')
          : allAck
            ? `已覆盖全部 ${String(items.length)} 项需人工判断点。`
            : `还有 ${String(items.length - ackCount - waivedCount)} 项需人工判断项未覆盖；请逐项确认或填写放弃理由。`),
      items.length > 0 ? h('div', { className: 'dcr-approve-acks' },
        h('div', { className: 'dcr-small dcr-muted' }, '逐项确认或填写理由放弃（精确覆盖后才解锁批准）：'),
        ...items.map((item) => h('div', { key: item.id, className: 'dcr-row', style: { alignItems: 'center', marginTop: 4 } },
          h('label', { className: 'dcr-check dcr-grow' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(ack[item.id]),
              onChange: (e: { target: { checked: boolean } }) => setAck({ ...ack, [item.id]: Boolean(e.target.checked) }),
            }),
            h('span', null, item.label),
          ),
          h('input', {
            className: 'dcr-input',
            style: { width: 220 },
            placeholder: '放弃理由（选填）',
            value: waiveReason[item.id] ?? '',
            onChange: (e: { target: { value: string } }) => setWaiveReason({ ...waiveReason, [item.id]: String(e.target.value) }),
          }),
        )),
      ) : null,
      h('div', { style: { marginTop: 10 } },
        h('div', { className: 'dcr-small', style: { fontWeight: 600, marginBottom: 4 } }, `将执行的完整合并门禁命令（${String(gateChecks.length)} 条，明文展示，以当前用户权限执行）：`),
        gateChecks.length === 0
          ? h('div', { className: 'dcr-banner warn' }, '门禁为空，无法批准；请在总体意见中要求 AI 补全 gate_checks 后再提交。')
          : h('div', null, ...gateChecks.map((command, index) => h('div', { key: index, className: 'dcr-gate-item dcr-mono dcr-small' }, command))),
      ),
      commitMessagePanel(),
      h('div', { className: 'dcr-row', style: { marginTop: 12 } },
        h('button', { className: 'dcr-btn p', disabled: busy || !canApproveOption || !allAck || gateChecks.length === 0, onClick: onApprove }, busy ? '执行中…' : '确认批准并提交'),
        h('button', { className: 'dcr-btn', onClick: () => setPanel('') }, '再想想'),
        h('span', { className: 'dcr-grow' }),
        h('span', { className: 'dcr-small dcr-muted' }, settings?.syncBeforeApprove ? '批准前自动同步基线' : '不自动同步基线'),
      ),
      h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 8 } }, '批准过程在页内显示实时日志，不弹窗、不锁定其他页面。'),
    );

    return h('div', { className: 'dcr-body' },
      h('div', { className: 'dcr-wrap' },
        renderJob(),
        error ? h('div', { className: 'dcr-banner err' }, error) : null,
        stale ? h('div', { className: 'dcr-banner err' },
          h('div', null, '该问题已在其他窗口更新（版本或 owner 变化），当前页面已锁定。'),
          h('button', { className: 'dcr-btn', style: { marginTop: 6 }, onClick: onReloadCurrent }, '加载最新并解除锁定'),
        ) : null,
        detail.selectedPatchBanned ? h('div', { className: 'dcr-banner err' },
          `当前方案补丁（${detail.selection?.optionId ?? ''} / patch ${String(currentPatchId)}）曾因门禁验证失败被永久封禁，禁止再次批准。请提交意见修订补丁、切换到另一未失败方案或转人工处理。`,
        ) : null,
        detail.isBaseBehind && selectedOption
          ? h('div', { className: 'dcr-banner warn' }, `仓库基线 ${short(detail.currentBase)} 已不同于补丁基线 ${short(baseRevision)}；批准时会先同步再严格应用补丁。`)
          : null,
        detail.patchCheck && selectedOption ? h('div', { className: `dcr-banner ${detail.patchCheck.state === 'conflicted' ? 'warn' : 'info'}`, style: { marginTop: 6 } },
          h('span', { className: 'dcr-grow' },
            detail.patchCheck.state === 'conflicted'
              ? `补丁预检：在基线 ${short(detail.patchCheck.checkedBase)} 无法直接应用；可先 Rebase。批准时在当前目标重新校验，符合条件时会尝试三方合并。`
              : detail.patchCheck.state === 'clean'
                ? `补丁预检：可应用到基线 ${short(detail.patchCheck.checkedBase)}（仅诊断，不构成批准证据）。`
                : '补丁预检：状态未知（仅诊断）。'),
          detail.patchCheck.state === 'conflicted'
            ? h('button', { className: 'dcr-btn', disabled: busy || !canAct, onClick: () => { void onRebase(); } }, 'Rebase')
            : null,
        ) : null,
        repairAttempts.length > 0 ? h('div', { className: 'dcr-card' },
          h('h3', null, `修复尝试记录（共 ${String(repairAttempts.length)} 次；门禁失败绝不自动重试）`),
          ...repairAttempts.map((attempt) => h('div', { key: attempt.id, className: 'dcr-hist' },
            h('div', { className: 'dcr-row' },
              h('strong', null, `尝试 #${String(attempt.id)} · ${attempt.optionId} / patch ${String(attempt.patchId)}`),
              h('span', { className: `dcr-chip ${attempt.result === 'applied' ? 'approved' : 'rejected'}` }, `${attempt.result} (${attempt.applyMode})`),
              h('span', { className: 'dcr-small dcr-muted' }, attempt.restored ? '业务工作区已彻底还原' : attempt.result === 'applied' ? '已落地' : '还原异常，请核验现场'),
            ),
            h('div', { className: 'dcr-small', style: { marginTop: 4 } }, attempt.evidence),
          )),
        ) : null,
        h('div', { className: 'dcr-card dcr-candidate-head' },
          h('div', { className: 'dcr-row', style: { alignItems: 'flex-start' } },
            h('div', { className: 'dcr-grow' },
              h('h2', { style: { margin: '0 0 7px', fontSize: 18 } }, `${candidate.meta.priority} · ${candidate.meta.title}`),
              h('div', { className: 'dcr-meta' },
                h('span', { className: `dcr-chip ${candidate.meta.status}` }, statusText(candidate.meta.status)),
                detail.finding?.deferred ? h('span', { className: 'dcr-chip warn' }, '已延期') : null,
                h('span', null, `记录 ${String(candidate.meta.recordRevision)}`),
                h('span', null, candidate.meta.ticket ? `#${candidate.meta.ticket}` : '无 ticket'),
                h('span', null, `owner ${candidate.meta.owner}`),
                h('span', null, `创建 ${dateText(candidate.meta.createdAt)}`),
                ...candidate.meta.tags.map((tag) => h('span', { key: tag, className: 'dcr-chip' }, tag)),
              ),
              h('div', { className: 'dcr-small dcr-muted dcr-mono', style: { marginTop: 6 } }, candidate.id),
              candidate.meta.approval ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 4 } },
                `批准：${candidate.meta.approval.approvedBy} · ${dateText(candidate.meta.approval.approvedAt)}`,
                detail.approvalCommitRevision ? ` · commit ${short(detail.approvalCommitRevision)}` : '',
                detail.approvalCommitLookup === 'ambiguous' ? ' · 派生提交不唯一，请人工确认' : '',
                detail.approvalCommitLookup === 'unknown' ? ' · 业务提交版本未派生（仅诊断）' : '',
              ) : null,
            ),
            h('div', { className: 'dcr-row' },
              !detail.canAct && !['approved', 'resolved'].includes(candidate.meta.status)
                ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => { void onTakeover(); } }, '接管审核')
                : null,
              canAct && candidate.meta.status === 'changes_requested'
                ? h('button', { className: 'dcr-btn', disabled: busy, onClick: () => { void onResumeCandidate(); } }, '转回待审核')
                : null,
              canApproveOption ? h('button', {
                className: 'dcr-btn p',
                disabled: busy || detail.validation.length > 0,
                title: detail.validation.length > 0 ? detail.validation.join('；') : !allAck ? '打开审批面板，逐项覆盖人工判断项' : '确认批准并提交',
                onClick: () => { setPanel(panel === 'approve' ? '' : 'approve'); },
              }, panel === 'approve' ? '收起审批' : `批准并应用 (${selectedOption?.id ?? ''})`) : null,
            ),
          ),
          detail.finding ? h(FindingCard, {
            key: `${detail.finding.id}/${String(detail.finding.recordRevision)}`,
            finding: detail.finding,
            currentId: candidate.id,
            currentOption: detail.selection?.optionId,
            canAct: detail.canAct && !stale,
            busy,
            choose: onOpenCandidate,
            save: onSaveFindingDecision,
          }) : null,
          h('div', { className: 'dcr-kpis' },
            h('div', { className: 'dcr-kpi' },
              h('div', { className: 'dcr-kpi-label' }, '基线'),
              h('div', { className: `dcr-kpi-value ${detail.isBaseBehind ? 'warn' : 'ok'}` }, detail.isBaseBehind ? `落后 ${short(baseRevision)}` : '最新'),
            ),
            h('div', { className: 'dcr-kpi' },
              h('div', { className: 'dcr-kpi-label' }, '人工确认'),
              h('div', { className: `dcr-kpi-value ${items.length > 0 && !allAck ? 'warn' : !candidate.humanJudgmentDeclared ? 'warn' : 'ok'}` },
                items.length > 0 ? `${String(ackCount + waivedCount)}/${String(items.length)}` : candidate.humanJudgmentDeclared ? '无需' : '未填写'),
            ),
            h('div', { className: 'dcr-kpi' },
              h('div', { className: 'dcr-kpi-label' }, '门禁'),
              h('div', { className: `dcr-kpi-value ${gateChecks.length > 0 ? 'ok' : 'warn'}` }, `${String(gateChecks.length)} 条`),
            ),
            h('div', { className: 'dcr-kpi' },
              h('div', { className: 'dcr-kpi-label' }, '补丁'),
              h('div', { className: 'dcr-kpi-value' }, statsText(detail.patchStats)),
            ),
          ),
          !detail.canAct ? h('div', { className: 'dcr-banner info', style: { marginTop: 10 } }, `当前负责人为 ${candidate.meta.owner}，您处于只读模式；需要操作请先“接管审核”。`) : null,
          detail.validation.length > 0 ? h('div', { className: 'dcr-banner err', style: { marginTop: 10 } }, `评审数据不完整：${detail.validation.join('；')}`) : null,
        ),
        panel === 'approve' ? approvalPanel() : null,
        items.length === 0
          ? (candidate.humanJudgmentDeclared
              ? null
              : h('div', { className: 'dcr-banner warn' }, 'AI 未填写需人工判断项；批准前请在总体意见中要求 AI 补全该章节。'))
          : h('div', { className: 'dcr-judge' },
              h('h3', null, `需人工判断项 · ${String(ackCount + waivedCount)}/${String(items.length)} 已处理`),
              ...items.map((item) => h('div', { key: item.id, className: 'dcr-judge-item' },
                h('div', { className: 'dcr-grow' },
                  h('div', { className: 'dcr-judge-label' }, item.label),
                  (waiveReason[item.id] ?? '').trim() ? h('div', { className: 'dcr-small' }, `放弃理由：${String(waiveReason[item.id])}`) : null,
                ),
                h('label', { className: 'dcr-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(ack[item.id]),
                    disabled: !canAct,
                    onChange: (e: { target: { checked: boolean } }) => setAck({ ...ack, [item.id]: Boolean(e.target.checked) }),
                  }),
                  h('span', null, '已确认'),
                ),
              )),
            ),
        h('div', { className: 'dcr-card' }, h('h3', null, '问题与影响'), h(RichText, { text: candidate.sections.problem })),
        h('div', { className: 'dcr-card' }, h('h3', null, '根因'), h(RichText, { text: candidate.sections.rootCause })),
        h('div', { className: 'dcr-card' }, h('h3', null, '当前修复方案'), h(RichText, { text: candidate.sections.solution })),
        h('div', { className: 'dcr-card' },
          h('h3', null, '合并门禁与验证证据'),
          gateChecks.length === 0
            ? h('div', { className: 'dcr-banner warn' }, '当前方案未定义 gate_checks。')
            : h('div', null, ...gateChecks.map((command, index) => h('div', { key: index, className: 'dcr-gate-item dcr-mono dcr-small' }, command))),
          h('div', { className: 'dcr-small dcr-muted' }, '点击批准即代表确认并在本机以当前用户权限明文执行以上命令；任一失败会阻止合并并永久封禁该补丁。'),
          candidate.sections.evidence
            ? h('details', { className: 'dcr-details', style: { marginTop: 8 } },
                h('summary', null, '验证证据'),
                h(RichText, { text: candidate.sections.evidence }),
              )
            : null,
        ),
        h('div', { className: 'dcr-card' },
          h('h3', null, '总体意见'),
          h('div', { className: 'dcr-small dcr-muted', style: { marginBottom: 6 } },
            '提交后按下方「提案修订方式」保存意见并启动下一版：新建 DSH 会话可直接观察/追问，导出提示词可交给外部 Agent；只想记录意见时点「仅提交意见」。'),
          h('textarea', {
            className: 'dcr-textarea',
            value: general,
            disabled: !canAct,
            placeholder: canAct ? '写给 AI/作者的整体意见（可加入草稿批量提交）…' : '仅 owner 可提交意见',
            onChange: (e: { target: { value: string } }) => setGeneral(e.target.value),
          }),
          h('div', { className: 'dcr-row', style: { marginTop: 8, alignItems: 'center' } },
            h('span', { className: 'dcr-small dcr-muted' }, '提案修订方式'),
            h('div', { className: 'dcr-seg', role: 'group', 'aria-label': '提案修订方式' },
              h('button', {
                className: `dcr-btn ${fixTarget === 'session' ? 'p' : ''}`,
                type: 'button',
                disabled: !canAct,
                'aria-pressed': fixTarget === 'session',
                onClick: () => setFixTarget('session'),
              }, '新建 DSH 会话'),
              h('button', {
                className: `dcr-btn ${fixTarget === 'export' ? 'p' : ''}`,
                type: 'button',
                disabled: !canAct,
                'aria-pressed': fixTarget === 'export',
                onClick: () => setFixTarget('export'),
              }, '导出提示词'),
            ),
            h('span', { className: 'dcr-small dcr-muted' },
              fixTarget === 'session'
                ? '新建可见 DSH 会话并投递 Mode B 修订提示词；完成后在面板收尾校验提交。'
                : '生成 Mode B 修订提示词，复制后粘贴到外部 Agent；完成后回到这里收尾。'),
          ),
          selectedOption ? h('button', {
            className: 'dcr-btn',
            style: { marginTop: 8 },
            disabled: !canAct || busy,
            onClick: onFinalizeCandidate,
          }, '校验并提交修订提案') : null,
          batchDrafts.length > 0 ? h('div', { className: 'dcr-banner info', style: { marginTop: 6 } },
            h('div', { className: 'dcr-small' }, `草稿 ${String(batchDrafts.length)} 条：`),
            ...batchDrafts.map((entry, index) => h('div', { key: index, className: 'dcr-row', style: { alignItems: 'center', marginTop: 2 } },
              h('span', { className: 'dcr-small dcr-grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `· ${entry}`),
              h('button', { className: 'dcr-btn', onClick: () => setBatchDrafts(batchDrafts.filter((_, i) => i !== index)) }, '移除'),
            )),
          ) : null,
          h('div', { className: 'dcr-row', style: { marginTop: 8 } },
            selectedOption ? h('button', {
              className: 'dcr-btn p',
              disabled: !canAct || busy || fixLaunching || fixPromptLoading || (batchDrafts.length === 0 && !general.trim()),
              onClick: () => {
                const drafts = [...batchDrafts, ...(general.trim() ? [general.trim()] : [])];
                void onSubmitFeedbackAndFix(drafts).then((ok) => {
                  if (ok) { setBatchDrafts([]); setGeneral(''); }
                });
              },
            }, fixLaunching ? '正在创建会话…' : fixPromptLoading ? '生成提示词…' : fixTarget === 'session' ? '提交意见并新建修订会话' : '提交意见并导出修订提示词') : null,
            h('button', {
              className: 'dcr-btn',
              disabled: !canAct || busy || (batchDrafts.length === 0 && !general.trim()),
              onClick: () => {
                const drafts = [...batchDrafts, ...(general.trim() ? [general.trim()] : [])];
                const pending = drafts.length > 1 ? onSubmitBatch(drafts) : drafts[0] ? onAddComment('', 0, drafts[0], false) : Promise.resolve(false);
                void pending.then((ok) => {
                  if (ok) { setBatchDrafts([]); setGeneral(''); }
                });
              },
            }, '仅提交意见'),
            h('button', {
              className: 'dcr-btn',
              disabled: !canAct || general.trim().length === 0,
              onClick: () => { if (general.trim()) { setBatchDrafts([...batchDrafts, general.trim()]); setGeneral(''); } },
            }, '加入草稿'),
            batchDrafts.length > 0 ? h('button', {
              className: 'dcr-btn',
              disabled: !canAct || busy,
              onClick: () => {
                const drafts = [...batchDrafts];
                void onSubmitBatch(drafts).then((ok) => {
                  if (ok) setBatchDrafts([]);
                });
              },
            }, `批量提交 ${String(batchDrafts.length)} 条`) : null,
            selectedOption && batchDrafts.length > 0 ? h('button', {
              className: 'dcr-btn',
              disabled: !canAct || busy || fixLaunching || fixPromptLoading,
              onClick: () => {
                const drafts = [...batchDrafts, ...(general.trim() ? [general.trim()] : [])];
                void onSubmitFeedbackAndFix(drafts).then((ok) => {
                  if (ok) { setBatchDrafts([]); setGeneral(''); }
                });
              },
            }, fixTarget === 'session' ? '批量提交并新建修订会话' : '批量提交并导出提示词') : null,
            h('span', { className: 'dcr-grow' }),
            h('span', { className: 'dcr-small dcr-muted' }, '提交后写入仓库 review.md（repair_failed 状态保持不变）。'),
          ),
          fixSession ? h('div', { className: 'dcr-banner info', style: { marginTop: 8 } },
            `已创建修订会话（记录 ${String(fixSession.revision)}）：${fixSession.title}。请在侧边栏打开该会话查看过程；产出新补丁后回到这里收尾提交。`,
          ) : null,
          fixPrompt && fixPrompt.revision === candidate.meta.recordRevision ? h('div', { className: 'dcr-field', style: { marginTop: 10 } },
            h('div', { className: 'dcr-row' },
              h('label', { className: 'dcr-grow' }, '修订提示词（新会话口径，可整段粘贴到外部 Agent）'),
              h('button', { className: 'dcr-btn', onClick: () => { void onCopyFixPrompt(); } }, fixCopied ? '已复制' : '复制'),
            ),
            h('textarea', { className: 'dcr-textarea', style: { minHeight: 220 }, readOnly: true, value: fixPrompt.text }),
          ) : null,
        ),
        selectedOption
          ? h(DiffView, {
              detail,
              selectedOption,
              currentPatchId,
              previousPatches,
              diff,
              diffFiles,
              diffMode,
              setDiffMode,
              diffFrom,
              setDiffFrom,
              diffLayout,
              setDiffLayout,
              diffWidth,
              diffLoading,
              diffCardRef,
              canAct,
              draft,
              setDraft,
              onAddComment,
              onSetCommentStatus,
            })
          : h('div', { className: 'dcr-card dcr-small dcr-muted' }, '当前为纯文字方案，无关联代码差异。'),
        h('div', { className: 'dcr-card' },
          h('h3', null, '评论、批准历史与补丁账本'),
          detail.comments.length === 0
            ? h('div', { className: 'dcr-muted dcr-small' }, '暂无评论')
            : h('div', null, ...detail.comments.map((comment) => h('div', { key: comment.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 7, marginTop: 7 } },
                h('div', { className: 'dcr-row dcr-small' },
                  h('strong', null, comment.author),
                  comment.file ? h('span', { className: 'dcr-mono' }, `${comment.file}:${String(comment.line)}`) : h('span', null, '总体'),
                  h('span', { className: comment.status === 'resolved' ? 'dcr-st-resolved' : comment.status === 'partial' ? 'dcr-st-partial' : 'dcr-st-unresolved' }, commentText(comment.status)),
                  h('span', { className: 'dcr-grow' }),
                  canAct ? h('select', {
                    className: 'dcr-select',
                    style: { padding: '0 3px', fontSize: 11 },
                    value: comment.status,
                    onChange: (e: { target: { value: string } }) => { void onSetCommentStatus(comment.id, e.target.value as ReviewComment['status']); },
                  },
                  h('option', { value: 'unresolved' }, '未处理'),
                  h('option', { value: 'partial' }, '部分处理'),
                  h('option', { value: 'resolved' }, '已处理')) : null,
                ),
                h(RichText, { text: comment.content, className: 'dcr-small' }),
              ))),
          approvalHistory.length > 0 ? h('div', null,
            h('div', { className: 'dcr-sep' }),
            h('h4', { style: { margin: '0 0 6px', fontSize: 13 } }, `历史批准记录（${String(approvalHistory.length)} 条）`),
            ...approvalHistory.map((item, idx) => h('div', { key: `${item.approvedAt}-${String(idx)}`, className: 'dcr-hist' },
              h('div', { className: 'dcr-row dcr-small' },
                h('strong', null, `${item.optionId} / patch #${String(item.patchId)}`),
                h('span', null, `批准人 ${item.approvedBy}`),
                h('span', { className: 'dcr-muted' }, dateText(item.approvedAt)),
                h('span', { className: 'dcr-mono dcr-muted' }, `base ${short(item.baseRevision)}`),
                item.businessCommit ? h('span', { className: 'dcr-mono dcr-muted' }, `commit ${short(item.businessCommit)}`) : null,
              ),
            )),
          ) : null,
          h('div', { className: 'dcr-sep' }),
          ...candidate.meta.patches.map((patch) => h('div', { key: patch.id, className: 'dcr-hist' },
            h('div', { className: 'dcr-row' },
              h('strong', null, `patch #${String(patch.id)} (${patch.optionId})`),
              h('span', { className: 'dcr-small dcr-muted' }, `base ${short(patch.baseRevision)}`),
              h('span', { className: 'dcr-small' }, statsText(detail.revisionStats[String(patch.id)]?.stats ?? EMPTY_STATS)),
              h('span', { className: 'dcr-grow' }),
              selectedOption && patch.optionId === selectedOption.id && patch.id < currentPatchId
                ? h('button', { className: 'dcr-btn g', onClick: () => { setDiffMode('incremental'); setDiffFrom(patch.id); } }, '查看增量') : null,
            ),
            h('div', { className: 'dcr-small dcr-mono dcr-muted' }, `${patch.patch} · sha256 ${patch.sha256.slice(0, 12)}`),
          )),
          candidate.sections.history
            ? h('details', { className: 'dcr-details', style: { marginTop: 8 } },
                h('summary', null, '版本审核记录'),
                h(RichText, { text: candidate.sections.history }),
              )
            : null,
        ),
        h('div', { style: { height: 8 } }),
      ),
    );
  };
}
