import { REVIEW_STATUSES } from '@dsh-review/protocol';
import { short, statsText, statusText } from './api.js';
import type { FindingCardComponent } from './finding-card.js';
import type { CandidateSummary, Health, IssueFindingView, Queue, ReactLike } from './types.js';

export interface QueueFilterState {
  owner: string;
  statuses: string;
  text: string;
  tag: string;
  dir: string;
  createdAfter: string;
  createdBefore: string;
}

export interface QueueViewProps {
  health: Health | null;
  queue: Queue | null;
  findings: IssueFindingView[];
  findingErrors: string[];
  filter: QueueFilterState;
  setFilter(next: QueueFilterState): void;
  defaultOwner: string;
  loading: boolean;
  busy: boolean;
  error: string;
  auditOpen: boolean;
  auditReady: boolean;
  auditTarget: string;
  setAuditTarget(value: string): void;
  auditNote: string;
  setAuditNote(value: string): void;
  auditExtra: string;
  setAuditExtra(value: string): void;
  auditPrompt: string;
  auditPromptLoading: boolean;
  auditLaunching: boolean;
  auditCopied: boolean;
  auditSessionId: string;
  auditLeaseId: string;
  releaseArmed: boolean;
  renderJob(): unknown;
  renderLeaseBanner(): unknown;
  onRefresh(): void;
  onInitReviewers(): void;
  onToggleAudit(): void;
  onOpenAudit(): void;
  onCloseAudit(): void;
  onLaunchAuditSession(): void;
  onExportAuditPrompt(): void;
  onCopyAuditPrompt(): void;
  onStartManualAudit(): void;
  onFinalizeAudit(auditId: string): void;
  onReleaseAuditLease(): void;
  onOpenCandidate(id: string, selection?: { optionId: string; patchId: number }): void;
  onSaveFindingDecision(body: Record<string, unknown>): void;
}

export type QueueViewComponent = (props: QueueViewProps) => unknown;

export function createQueueView(React: ReactLike, FindingCard: FindingCardComponent): QueueViewComponent {
  const h = React.createElement;

  return function QueueView(props: QueueViewProps) {
    const {
      health,
      queue,
      findings,
      findingErrors,
      filter,
      setFilter,
      defaultOwner,
      loading,
      busy,
      error,
      auditOpen,
      auditReady,
      auditTarget,
      setAuditTarget,
      auditNote,
      setAuditNote,
      auditExtra,
      setAuditExtra,
      auditPrompt,
      auditPromptLoading,
      auditLaunching,
      auditCopied,
      auditSessionId,
      auditLeaseId,
      releaseArmed,
      renderJob,
      renderLeaseBanner,
      onRefresh,
      onInitReviewers,
      onToggleAudit,
      onOpenAudit,
      onCloseAudit,
      onLaunchAuditSession,
      onExportAuditPrompt,
      onCopyAuditPrompt,
      onStartManualAudit,
      onFinalizeAudit,
      onReleaseAuditLease,
      onOpenCandidate,
      onSaveFindingDecision,
    } = props;

    const filteredItems: CandidateSummary[] = queue?.items ?? [];
    const me = queue?.me || defaultOwner;
    const visibleFindings = findings.filter((finding) =>
      (!filter.owner || finding.owner === filter.owner)
      && (!filter.statuses || filter.statuses.split(',').includes(finding.issueStatus))
      && (!filter.dir || finding.targetFiles.some((file) => file.includes(filter.dir)))
      && (!filter.text || `${finding.title} ${finding.findingId} ${finding.id}`.toLowerCase().includes(filter.text.toLowerCase())));
    const localTotal = filteredItems.filter((item) => item.local).length;
    const hasActiveFilter = Boolean(filter.owner || filter.statuses || filter.text || filter.tag || filter.dir || filter.createdAfter || filter.createdBefore);
    const missingReviewers = (health?.diagnostics ?? []).some((d) => d.includes('reviewers.yml'));
    const counts = queue?.counts ?? health?.counts ?? {};

    return h('div', { className: 'dcr-body' },
      h('div', { className: 'dcr-wrap' },
        renderJob(),
        renderLeaseBanner(),
        missingReviewers ? h('div', { className: 'dcr-banner warn' },
          h('div', { className: 'dcr-row' },
            h('span', { className: 'dcr-grow' }, '尚未初始化 .ai-review/reviewers.yml（发起仓库审查前必须完成配置）。'),
            h('button', { className: 'dcr-btn p', disabled: busy, onClick: onInitReviewers }, '一键初始化 reviewers.yml'),
          ),
        ) : null,
        h('div', { className: 'dcr-card' },
          h('div', { className: 'dcr-row' },
            h('div', { className: 'dcr-seg', role: 'group', 'aria-label': '负责人视角' },
              me ? h('button', {
                type: 'button',
                className: `dcr-btn ${filter.owner === me ? 'p' : ''}`,
                'aria-pressed': filter.owner === me,
                onClick: () => setFilter({ ...filter, owner: me }),
              }, '我的') : null,
              h('button', {
                type: 'button',
                className: `dcr-btn ${filter.owner === '' ? 'p' : ''}`,
                'aria-pressed': filter.owner === '',
                onClick: () => setFilter({ ...filter, owner: '' }),
              }, '全部'),
            ),
            h('input', {
              className: 'dcr-input',
              style: { width: 130 },
              placeholder: '负责人（留空=全部）',
              value: filter.owner,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, owner: e.target.value }),
            }),
            h('select', {
              className: 'dcr-select',
              value: filter.statuses,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, statuses: e.target.value }),
            },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待审核'),
            h('option', { value: 'changes_requested' }, '待修订'),
            h('option', { value: 'repair_failed' }, '修复失败'),
            h('option', { value: 'human_takeover' }, '人工接手'),
            h('option', { value: 'awaiting_verification' }, '待复查验证'),
            h('option', { value: 'pending,changes_requested,repair_failed' }, '全部待处理'),
            h('option', { value: 'approved' }, '已批准'),
            h('option', { value: 'rejected' }, '已接受现状'),
            h('option', { value: 'resolved' }, '已解决')),
            h('input', {
              className: 'dcr-input',
              style: { flex: 1, minWidth: 160 },
              placeholder: '搜索标题 / ticket / 目录',
              value: filter.text,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, text: e.target.value }),
            }),
            h('input', {
              className: 'dcr-input',
              style: { width: 100 },
              placeholder: 'tag',
              value: filter.tag,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, tag: e.target.value }),
            }),
            h('button', { className: 'dcr-btn', disabled: loading, onClick: onRefresh }, loading ? '加载中…' : '刷新'),
            h('button', { className: 'dcr-btn p', disabled: busy, onClick: onToggleAudit }, auditOpen ? '收起审查' : '审查仓库'),
          ),
          h('div', { className: 'dcr-row', style: { marginTop: 8 } },
            h('input', {
              className: 'dcr-input',
              placeholder: '目录包含',
              value: filter.dir,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, dir: e.target.value }),
            }),
            h('input', {
              className: 'dcr-input',
              type: 'datetime-local',
              title: '创建时间起（含边界）',
              value: filter.createdAfter,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, createdAfter: e.target.value }),
            }),
            h('input', {
              className: 'dcr-input',
              type: 'datetime-local',
              title: '创建时间止（含边界）',
              value: filter.createdBefore,
              onChange: (e: { target: { value: string } }) => setFilter({ ...filter, createdBefore: e.target.value }),
            }),
          ),
          h('div', { className: 'dcr-counts', 'aria-label': '状态统计' },
            ...REVIEW_STATUSES.map((status) => h('button', {
              key: status,
              type: 'button',
              className: `dcr-btn ${filter.statuses === status ? 'p' : 'g'}`,
              onClick: () => setFilter({ ...filter, statuses: filter.statuses === status ? '' : status }),
            }, `${statusText(status)} ${String(counts[status] ?? 0)}`)),
          ),
          h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 8 } },
            `当前基线 ${short(queue?.currentBase)} · 当前筛选下共 ${String(filteredItems.length)} 项`
            + (localTotal > 0 ? `（含 ${String(localTotal)} 项本地未提交：审查收尾后才进入共享队列）` : '')),
        ),
        auditOpen ? h('div', { className: 'dcr-card' },
          h('h3', null, '在新会话中审查当前仓库'),
          h('div', { className: 'dcr-small dcr-muted', style: { marginBottom: 10 } },
            '点击“启动审查会话”会新建一个 DSH 会话并在侧边栏显示；审查过程以对话形式流式展示，你可以随时切到其他会话，不会用弹窗遮挡当前页面。'),
          !auditReady ? h('div', { className: 'dcr-banner warn', style: { marginBottom: 10 } }, '当前仓库还没有基线提交（Git HEAD / SVN revision）。请先完成一次提交，再启动审查会话。') : null,
          h('div', { className: 'dcr-field' },
            h('label', null, '审查范围（留空 = 全仓库）'),
            h('input', { className: 'dcr-input', value: auditTarget, placeholder: '例如 src/ 或 packages/core/', onChange: (e: { target: { value: string } }) => setAuditTarget(e.target.value) }),
          ),
          h('div', { className: 'dcr-field' },
            h('label', null, '补充关注点（可选）'),
            h('textarea', { className: 'dcr-textarea', value: auditNote, placeholder: '例如：覆盖写入成功后响应超时的重试链路。', onChange: (e: { target: { value: string } }) => setAuditNote(e.target.value) }),
          ),
          h('div', { className: 'dcr-field' },
            h('label', null, '额外要求（可选）'),
            h('textarea', { className: 'dcr-textarea', value: auditExtra, placeholder: '每行一条，例如：保留公开 API。', onChange: (e: { target: { value: string } }) => setAuditExtra(e.target.value) }),
          ),
          h('div', { className: 'dcr-row' },
            h('button', { className: 'dcr-btn p', disabled: busy || auditLaunching || auditPromptLoading || !auditReady, onClick: onLaunchAuditSession }, auditLaunching ? '正在创建会话…' : '启动审查会话'),
            h('button', { className: 'dcr-btn', disabled: auditPromptLoading || !auditReady, onClick: onExportAuditPrompt }, auditPromptLoading ? '生成中…' : '仅预览提示词'),
            h('button', { className: 'dcr-btn', disabled: auditLaunching || !auditReady, onClick: onStartManualAudit }, '创建外部执行租约'),
            auditLeaseId ? h('button', { className: 'dcr-btn', disabled: auditLaunching, onClick: () => onFinalizeAudit(auditLeaseId) }, '收尾并提交') : null,
            auditLeaseId ? h('button', { className: 'dcr-btn g', disabled: busy, onClick: onReleaseAuditLease }, releaseArmed ? '再次点击确认释放' : '确认停止并释放') : null,
            h('button', { className: 'dcr-btn g', onClick: onCloseAudit }, '取消'),
            h('span', { className: 'dcr-grow' }),
            h('span', { className: 'dcr-small dcr-muted' }, `基线 ${short(queue?.currentBase ?? health?.currentBase)} · 使用新建 DSH 会话`),
          ),
          auditLeaseId ? h('div', { className: 'dcr-banner info', style: { marginTop: 10 } }, `执行租约 ${auditLeaseId} 正在参与互斥；外部 Agent 停止后按实际状态选择收尾或确认释放。`) : null,
          auditSessionId ? h('div', { className: 'dcr-banner info', style: { marginTop: 10 } }, `审查会话已创建（${short(auditSessionId)}）。请在侧边栏打开「仓库审查 · ${auditTarget.trim() || '全仓库'}」查看实时过程；当前页面不会被遮挡。`) : null,
          auditPrompt ? h('div', { className: 'dcr-field', style: { marginTop: 10 } },
            h('div', { className: 'dcr-row' },
              h('label', { className: 'dcr-grow' }, auditLeaseId ? '审查提示词（租约已创建，可供外部 Agent 执行）' : '预览提示词（执行前必须创建手动租约）'),
              h('button', {
                className: 'dcr-btn',
                disabled: !auditLeaseId,
                title: auditLeaseId ? '复制执行提示词' : '先创建外部执行租约',
                onClick: onCopyAuditPrompt,
              }, auditCopied ? '已复制' : '复制'),
            ),
            h('textarea', { className: 'dcr-textarea', style: { minHeight: 220 }, readOnly: true, value: auditPrompt }),
          ) : null,
        ) : null,
        error ? h('div', { className: 'dcr-banner err' }, error) : null,
        ...findingErrors.map((message, index) => h('div', { key: index, className: 'dcr-banner err' }, message)),
        ...visibleFindings.map((finding) => h(FindingCard, {
          key: `${finding.id}/${String(finding.recordRevision)}`,
          finding,
          canAct: finding.owner === me,
          busy,
          choose: onOpenCandidate,
          save: onSaveFindingDecision,
        })),
        filteredItems.length === 0 && visibleFindings.length === 0
          ? h('div', { className: 'dcr-empty' },
              h('div', null, hasActiveFilter
                ? '当前筛选条件下没有问题；本地未提交问题同样受筛选影响，可调整或清空上方筛选。'
                : '队列为空：仓库 .ai-review 中还没有问题记录。'),
              !hasActiveFilter ? h('div', { style: { marginTop: 12 } },
                h('button', { className: 'dcr-btn p', disabled: busy, onClick: onOpenAudit }, '审查当前仓库并生成问题'),
              ) : null,
            )
          : h('div', { className: 'dcr-list' }, ...filteredItems.map((item) => h('div',
              {
                key: item.id,
                className: 'dcr-item',
                ...(item.localOnly ? { style: { opacity: 0.85 } } : { onClick: () => onOpenCandidate(item.id) }),
              },
              h('div', { className: 'dcr-row', style: { alignItems: 'flex-start' } },
                h('div', { className: 'dcr-grow' },
                  h('h2', null, `${item.priority} · ${item.title}`),
                  h('div', { className: 'dcr-meta' },
                    h('span', { className: `dcr-chip ${item.status}` }, statusText(item.status)),
                    item.deferred ? h('span', { className: 'dcr-chip warn' }, '已延期') : null,
                    item.options.length === 0 ? h('span', { className: 'dcr-chip' }, '无补丁') : null,
                    item.localOnly
                      ? h('span', { className: 'dcr-chip rejected' }, '本地草稿（未提交）')
                      : item.local ? h('span', { className: 'dcr-chip rejected' }, '本地视图（未提交）') : null,
                    item.duplicateOf ? h('span', { className: 'dcr-chip rejected' }, `重复问题（${item.duplicateOf}）`) : null,
                    item.isStale ? h('span', { className: 'dcr-chip warn' }, '跨基线待复核') : null,
                    h('span', null, `记录 ${String(item.recordRevision)}`),
                    h('span', null, item.ticket ? `#${item.ticket}` : '无 ticket'),
                    h('span', null, `owner ${item.owner}`),
                    item.options.length > 0 ? h('span', null, statsText(item.patchStats)) : null,
                    item.options.length > 0
                      ? (item.isBaseBehind ? h('span', { className: 'dcr-chip warn' }, `基线落后 ${short(item.baseRevision)}`) : h('span', { className: 'dcr-chip approved' }, '基线最新'))
                      : null,
                    item.humanJudgmentCount > 0
                      ? h('span', { className: 'dcr-chip warn' }, `${String(item.humanJudgmentCount)} 项需人工判断`)
                      : item.humanJudgmentDeclared
                        ? h('span', { className: 'dcr-chip approved' }, '无需人工判断')
                        : h('span', { className: 'dcr-chip warn' }, '人工判断项未填写'),
                    item.unresolvedComments > 0 ? h('span', { className: 'dcr-chip warn' }, `${String(item.unresolvedComments)} 条未处理意见`) : null,
                    ...item.tags.map((tag) => h('span', { key: tag, className: 'dcr-chip' }, tag)),
                  ),
                  item.options.length > 0 ? h('div', { className: 'dcr-meta', style: { marginTop: 6 } },
                    ...item.options.map((opt) => h('span', {
                      key: opt.id,
                      className: `dcr-chip ${opt.banned || opt.patchCheck?.state === 'conflicted' ? 'warn' : ''}`,
                    }, [
                      `${opt.id}#${String(opt.currentPatch)}`,
                      statsText(opt.patchStats),
                      opt.banned ? '已封禁' : null,
                      opt.patchCheck?.state === 'conflicted' ? '预检冲突' : opt.patchCheck?.state === 'clean' ? '预检可应用' : null,
                    ].filter(Boolean).join(' · '))),
                  ) : null,
                  item.localOnly ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 6 } }, '本地草稿尚未进入共享快照：审查收尾（finalize）提交后可查看详情与批准。') : null,
                  item.lastFeedback ? h('div', { className: 'dcr-small dcr-muted', style: { marginTop: 6 } }, `最近意见：${item.lastFeedback}`) : null,
                  item.parseError ? h('div', { className: 'dcr-small', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 } }, item.parseError) : null,
                ),
              ),
            ))),
        h('div', { className: 'dcr-small dcr-muted', style: { textAlign: 'center' } }, '仅当前 owner 可操作；其他人只读，可先“接管审核”。'),
      ),
    );
  };
}
