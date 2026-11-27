import {
  buildSplitRows,
  relocateInlineComments,
  type RelocatedAnchor,
  type UnifiedDiffFile,
  type UnifiedDiffLine,
} from '@dsh-review/protocol';
import { commentText } from './api.js';
import type { RichTextComponent } from './rich-text.js';
import type { Detail, DiffResult, PatchEntry, ReactLike, RepairOption, ReviewComment } from './types.js';

export const SPLIT_MIN_WIDTH = 900;

export interface DiffDraft {
  file: string;
  line: number;
  text: string;
  side: 'LEFT' | 'RIGHT';
}

export interface DiffViewProps {
  detail: Detail;
  selectedOption: RepairOption;
  currentPatchId: number;
  previousPatches: PatchEntry[];
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
  canAct: boolean;
  draft: DiffDraft | null;
  setDraft(next: DiffDraft | null): void;
  onAddComment(
    file: string,
    line: number,
    text: string,
    autoFix: boolean,
    side: 'LEFT' | 'RIGHT',
    anchor?: { snippet: string; before?: string; after?: string },
  ): Promise<boolean>;
  onSetCommentStatus(commentId: string, status: ReviewComment['status']): Promise<void>;
}

export type DiffViewComponent = (props: DiffViewProps) => unknown;

export function createDiffView(React: ReactLike, RichText: RichTextComponent): DiffViewComponent {
  const h = React.createElement;
  const { useState, useEffect } = React;

  return function DiffView(props: DiffViewProps) {
    const {
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
    } = props;

    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    // 切换问题、方案或对比范围时重置折叠状态；提交评论刷新 recordRevision 时保留折叠状态
    const diffScopeKey = `${detail.candidate.id}:${selectedOption.id}:${String(currentPatchId)}:${diffMode}:${String(diffFrom)}`;
    useEffect(() => {
      setCollapsed({});
    }, [diffScopeKey]);

    const toggleFile = (filePath: string): void => {
      setCollapsed((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
    };
    const collapseAll = (): void => {
      setCollapsed(Object.fromEntries(diffFiles.map((f) => [f.path, true])));
    };
    const expandAll = (): void => {
      setCollapsed({});
    };

    const crossBaseFallback = diff?.resolutionMode === 'cross_base_hunk_fallback'
      || /^# 跨基线 Hunk 对比/m.test(diff?.unifiedDiff ?? '');
    const splitView = !crossBaseFallback
      && (diffLayout === 'split' || (diffLayout === 'auto' && diffWidth !== null && diffWidth >= SPLIT_MIN_WIDTH));

    const threadNode = (comment: ReviewComment): unknown => h('div', { key: comment.id, className: `dcr-thread${splitView ? ' split' : ''}` },
      h('div', { className: 'dcr-thread-head' },
        h('span', null, comment.author),
        h('span', null, `记录 ${String(comment.revision)}${comment.optionId ? ` / ${comment.optionId} / patch ${String(comment.patchId ?? '')}` : ''}`),
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
      h(RichText, { text: comment.content }),
    );

    const commentsForRow = (
      file: UnifiedDiffFile,
      relocated: Map<string, RelocatedAnchor>,
      side: 'LEFT' | 'RIGHT',
      rowNo: number | null,
    ): ReviewComment[] => (rowNo === null ? [] : detail.comments.filter((comment) => {
      if (comment.file !== file.path || (detail.selection && comment.optionId && comment.optionId !== detail.selection.optionId)) return false;
      const exact = comment.line === rowNo && (comment.side ?? 'RIGHT') === side;
      const re = relocated.get(comment.id);
      const relocatedHere = re !== undefined && re.line === rowNo && re.side === side;
      return exact || relocatedHere;
    }));

    const plusNode = (file: UnifiedDiffFile, side: 'LEFT' | 'RIGHT', rowNo: number | null): unknown =>
      (canAct && rowNo !== null
        ? h('span', {
            className: 'dcr-plus',
            title: side === 'LEFT' ? '对基线侧该行添加意见（LEFT）' : '添加行内意见（RIGHT）',
            onClick: () => setDraft({ file: file.path, line: rowNo, text: '', side }),
          }, '+')
        : null);

    const renderFileHeader = (file: UnifiedDiffFile): unknown => {
      const isCollapsed = Boolean(collapsed[file.path]);
      const adds = file.lines.filter((l) => l.kind === 'add').length;
      const dels = file.lines.filter((l) => l.kind === 'del').length;
      return h('div', {
        className: 'dcr-file',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !isCollapsed,
        onClick: () => toggleFile(file.path),
        onKeyDown: (e: { key: string; preventDefault(): void }) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleFile(file.path);
          }
        },
      },
      h('span', null, isCollapsed ? '▸' : '▾'),
      h('span', { className: 'dcr-mono dcr-grow' }, file.path),
      file.binary
        ? h('span', { className: 'dcr-chip' }, 'binary')
        : h('span', { className: 'dcr-small dcr-muted' }, `+${String(adds)} / -${String(dels)}`),
      );
    };

    const renderSplitFile = (file: UnifiedDiffFile, relocated: Map<string, RelocatedAnchor>): unknown => {
      const isCollapsed = Boolean(collapsed[file.path]);
      const half = (line: UnifiedDiffLine | null, side: 'LEFT' | 'RIGHT'): unknown => {
        if (!line) {
          return h('div', { className: 'dcr-shalf empty' },
            h('span', { className: 'dcr-num' }), h('span', { className: 'dcr-sign' }), h('span', { className: 'dcr-code' }));
        }
        const no = side === 'LEFT' ? line.oldNo : line.newNo;
        const commentSide = side === 'LEFT' ? line.kind === 'del' : line.kind !== 'del';
        return h('div', { className: `dcr-shalf ${line.kind}` },
          h('span', { className: 'dcr-num' }, no === null ? '' : String(no)),
          h('span', { className: 'dcr-sign' }, line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''),
          h('span', { className: 'dcr-code' }, line.text),
          commentSide ? plusNode(file, side, no) : null,
        );
      };
      return h('div', { key: file.path, id: `dcr-file-${file.path}` },
        renderFileHeader(file),
        isCollapsed ? null : h('div', { className: 'dcr-srows' }, ...buildSplitRows(file.lines).map((row, index) => {
          const key = `${file.path}-${String(index)}`;
          if (row.kind === 'meta') return h('div', { key, className: 'dcr-smeta' }, row.meta?.text ?? '');
          const context = row.left !== null && row.right !== null && row.left === row.right;
          const rowComments = context
            ? commentsForRow(file, relocated, 'RIGHT', row.right?.newNo ?? null)
            : [
                ...commentsForRow(file, relocated, 'LEFT', row.left?.oldNo ?? null),
                ...commentsForRow(file, relocated, 'RIGHT', row.right?.newNo ?? null),
              ];
          return h('div', { key },
            h('div', { className: 'dcr-srow' }, half(row.left, 'LEFT'), half(row.right, 'RIGHT')),
            ...rowComments.map(threadNode),
          );
        })),
      );
    };

    return h('div', { className: 'dcr-diff', ref: diffCardRef },
      h('div', { className: 'dcr-diff-bar' },
        h('strong', null, `代码差异 · ${selectedOption.id} / patch ${String(currentPatchId)}`),
        h('button', { className: `dcr-btn ${diffMode === 'full' ? 'p' : ''}`, onClick: () => setDiffMode('full') }, '完整差异'),
        previousPatches.length > 0 ? h('button', {
          className: `dcr-btn ${diffMode === 'incremental' ? 'p' : ''}`,
          onClick: () => {
            setDiffFrom(previousPatches[previousPatches.length - 1]!.id);
            setDiffMode('incremental');
          },
        }, '版本增量') : null,
        diffMode === 'incremental' ? h('select', {
          className: 'dcr-select',
          value: String(diffFrom),
          onChange: (e: { target: { value: string } }) => setDiffFrom(Number(e.target.value)),
        }, ...previousPatches.map((p) => h('option', { key: p.id, value: String(p.id) }, `patch ${String(p.id)}`))) : null,
        diffMode === 'incremental' ? h('span', { className: 'dcr-small dcr-muted' }, `→ patch ${String(currentPatchId)}`) : null,
        diffFiles.length > 1 ? h('button', { className: 'dcr-btn g', onClick: expandAll }, '全部展开') : null,
        diffFiles.length > 1 ? h('button', { className: 'dcr-btn g', onClick: collapseAll }, '全部折叠') : null,
        h('span', { className: 'dcr-grow' }),
        crossBaseFallback ? null : h('span', { className: 'dcr-small dcr-muted' }, '布局'),
        crossBaseFallback ? null : h('button', {
          className: `dcr-btn ${diffLayout === 'auto' ? 'p' : ''}`,
          title: `自动：差异区宽度 ≥ ${String(SPLIT_MIN_WIDTH)}px 时并排，否则单列`,
          onClick: () => setDiffLayout('auto'),
        }, '自动'),
        crossBaseFallback ? null : h('button', { className: `dcr-btn ${diffLayout === 'split' ? 'p' : ''}`, onClick: () => setDiffLayout('split') }, '并排'),
        crossBaseFallback ? null : h('button', { className: `dcr-btn ${diffLayout === 'unified' ? 'p' : ''}`, onClick: () => setDiffLayout('unified') }, '统一'),
        splitView ? h('span', { className: 'dcr-small dcr-muted' }, '左：基线 · 右：补丁') : null,
        diffLoading ? h('span', { className: 'dcr-small dcr-muted' }, '加载差异…') : null,
      ),
      !crossBaseFallback && diffFiles.length > 1 ? h('div', { className: 'dcr-file-tree', 'aria-label': '差异文件列表' },
        ...diffFiles.map((file) => h('button', {
          key: file.path,
          type: 'button',
          className: 'dcr-btn g dcr-mono dcr-small',
          onClick: () => {
            setCollapsed((prev) => ({ ...prev, [file.path]: false }));
            if (typeof document !== 'undefined') {
              document.getElementById(`dcr-file-${file.path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          },
        }, file.path)),
      ) : null,
      diff?.notes?.length ? h('div', { className: 'dcr-banner info', style: { margin: 8 } }, diff.notes.join(' ')) : null,
      crossBaseFallback
        ? h('div', { style: { padding: 10 } },
            h('div', { className: 'dcr-banner warn', style: { marginBottom: 8 } }, '跨基线且旧补丁无法三方应用：当前为 Hunk 级近似对比，不代表逐行真实 diff。'),
            h('pre', { className: 'dcr-raw' }, diff?.unifiedDiff || '（无差异）'),
          )
        : h('div', { className: 'dcr-diff-body' }, ...diffFiles.map((file) => {
            const relocated = relocateInlineComments(file, detail.comments, detail.selection?.optionId);
            if (splitView) return renderSplitFile(file, relocated);
            const isCollapsed = Boolean(collapsed[file.path]);
            return h('div', { key: file.path, id: `dcr-file-${file.path}` },
              renderFileHeader(file),
              ...(isCollapsed ? [] : file.lines.map((line, index) => {
                const rowSide: 'LEFT' | 'RIGHT' = line.kind === 'del' ? 'LEFT' : 'RIGHT';
                const rowNo = rowSide === 'LEFT' ? line.oldNo : line.newNo;
                const comments = commentsForRow(file, relocated, rowSide, rowNo);
                return h('div', { key: `${file.path}-${String(index)}` },
                  h('div', { className: `dcr-line ${line.kind}` },
                    h('span', { className: 'dcr-num' }, line.oldNo === null ? '' : String(line.oldNo)),
                    h('span', { className: 'dcr-num' }, line.newNo === null ? '' : String(line.newNo)),
                    h('span', { className: 'dcr-sign' }, line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''),
                    h('span', { className: 'dcr-code' }, line.text),
                    line.kind !== 'meta' ? plusNode(file, rowSide, rowNo) : null,
                  ),
                  ...comments.map(threadNode),
                );
              })),
            );
          })),
      draft ? h('div', { style: { padding: '0 10px 10px' } },
        h('div', { className: 'dcr-card' },
          h('h3', null, `行内意见 ${draft.file}:${String(draft.line)}`),
          h('textarea', {
            className: 'dcr-textarea',
            autoFocus: true,
            value: draft.text,
            onChange: (e: { target: { value: string } }) => setDraft({ ...draft, text: e.target.value }),
          }),
          h('div', { className: 'dcr-row', style: { marginTop: 8 } },
            h('button', {
              className: 'dcr-btn p',
              disabled: !draft.text.trim(),
              onClick: () => {
                const value = draft.text;
                const side = draft.side;
                const { file: draftFile, line: draftLine } = draft;
                const entry = diffFiles.find((item) => item.path === draftFile);
                const idx = entry ? entry.lines.findIndex((l) => (side === 'LEFT' ? l.oldNo : l.newNo) === draftLine) : -1;
                const target = entry && idx >= 0 ? entry.lines[idx] : undefined;
                const prevLine = entry && idx > 0 ? entry.lines[idx - 1] : undefined;
                const nextLine = entry && idx >= 0 ? entry.lines[idx + 1] : undefined;
                const anchor = target
                  ? {
                      snippet: target.text,
                      ...(prevLine ? { before: prevLine.text } : {}),
                      ...(nextLine ? { after: nextLine.text } : {}),
                    }
                  : undefined;
                void onAddComment(draftFile, draftLine, value, false, side, anchor).then((ok) => {
                  if (ok) setDraft(null);
                });
              },
            }, '提交行内意见'),
            h('button', { className: 'dcr-btn', onClick: () => setDraft(null) }, '取消'),
          ),
        ),
      ) : null,
    );
  };
}
