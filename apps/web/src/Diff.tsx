import type { ReviewComment } from '@dsh-review/protocol';
import s from './App.module.css';
import { parseDiff, relocateInlineComments } from './diff-parser.js';

export interface Anchor {
  file: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  anchor: { snippet: string; before?: string; after?: string };
}

export function Diff({
  text,
  onSelect,
  collapsedFiles,
  onCollapsedFilesChange,
  allowLeft = true,
  comments = [],
  optionId,
}: {
  text: string;
  onSelect(anchor: Anchor): void;
  collapsedFiles: readonly string[];
  onCollapsedFilesChange(files: string[]): void;
  allowLeft?: boolean;
  comments?: readonly ReviewComment[];
  optionId?: string;
}) {
  const files = parseDiff(text);
  if (!files.length) return <pre className={s.logs}>{text || '当前没有可显示的文本差异。'}</pre>;
  const ids = files.map((file, index) => `${index}/${file.name}`);

  return (
    <div className={s.diff}>
      <div className={s.diffTools}>
        <small>{files.length} 个文件</small>
        <button onClick={() => onCollapsedFilesChange([])} disabled={ids.every((id) => !collapsedFiles.includes(id))}>全部展开</button>
        <button onClick={() => onCollapsedFilesChange(ids)} disabled={ids.every((id) => collapsedFiles.includes(id))}>全部收起</button>
      </div>
      {files.length > 1 && (
        <nav className={s.diffFileTree} aria-label="差异文件列表">
          {files.map((file, index) => (
            <a key={ids[index]!} href={`#diff-file-${index}`}>{file.name}</a>
          ))}
        </nav>
      )}
      {files.map((file, index) => {
        const id = ids[index]!;
        const open = !collapsedFiles.includes(id);
        const relocated = comments.length > 0 ? relocateInlineComments(file.raw, comments, optionId) : new Map();

        const commentsFor = (side: 'LEFT' | 'RIGHT', lineNo: number | undefined): ReviewComment[] => {
          if (lineNo === undefined || comments.length === 0) return [];
          return comments.filter((comment) => {
            if (comment.file !== file.name) return false;
            if (optionId && comment.optionId && comment.optionId !== optionId) return false;
            const exact = comment.line === lineNo && (comment.side ?? 'RIGHT') === side;
            const re = relocated.get(comment.id);
            const relocatedHere = re !== undefined && re.line === lineNo && re.side === side;
            return exact || relocatedHere;
          });
        };

        return (
          <details
            key={id}
            id={`diff-file-${index}`}
            open={open}
            onToggle={(event) => {
              if (event.currentTarget.open !== open) {
                onCollapsedFilesChange(
                  event.currentTarget.open
                    ? collapsedFiles.filter((value) => value !== id)
                    : [...collapsedFiles, id],
                );
              }
            }}
          >
            <summary>
              <span>{file.name}</span>
              <span className={s.diffStat}>
                +{file.lines.filter((line) => line.kind === 'added').length}
                <em>−{file.lines.filter((line) => line.kind === 'removed').length}</em>
              </span>
            </summary>
            <div className={s.diffLabels}><span>原代码</span><span>修改后</span></div>
            <div className={s.diffScroll}>
              <table>
                <tbody>
                  {file.lines.map((line, lineIndex) => {
                    if (line.kind === 'hunk') {
                      return <tr key={lineIndex} className={s.hunk}><td colSpan={4}>{line.text}</td></tr>;
                    }
                    const lineComments = line.kind === 'context'
                      ? commentsFor('RIGHT', line.right)
                      : [
                          ...commentsFor('LEFT', line.left),
                          ...commentsFor('RIGHT', line.right),
                        ];
                    return (
                      <>
                        <tr key={lineIndex} className={s[line.kind]}>
                          {(['LEFT', 'RIGHT'] as const).map((side) => {
                            const number = side === 'LEFT' ? line.left : line.right;
                            return (
                              <td colSpan={2} key={side}>
                                <button
                                  disabled={number === undefined || (side === 'LEFT' && !allowLeft)}
                                  className={s.codeLine}
                                  onClick={() => number !== undefined && onSelect({ file: file.name, line: number, side, anchor: { snippet: line.text || ' ' } })}
                                >
                                  <span>{number}</span>
                                  <code>{number === undefined ? '' : line.text || ' '}</code>
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                        {lineComments.map((comment) => (
                          <tr key={`${lineIndex}-comment-${comment.id}`} className={s.inlineCommentRow}>
                            <td colSpan={4}>
                              <div className={s.inlineComment}>
                                <b>{comment.author}</b>
                                <small>记录 {comment.revision} · {comment.status === 'resolved' ? '已解决' : comment.status === 'partial' ? '部分处理' : '未解决'}</small>
                                <p>{comment.content}</p>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}
