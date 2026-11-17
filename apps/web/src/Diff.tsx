import s from './App.module.css';
import { parseDiff } from './diff-parser.js';

export interface Anchor { file: string; line: number; side: 'LEFT' | 'RIGHT'; anchor: { snippet: string } }
export function Diff({ text, onSelect, collapsedFiles, onCollapsedFilesChange, allowLeft = true }: {
    text: string;
    onSelect(anchor: Anchor): void;
    collapsedFiles: readonly string[];
    onCollapsedFilesChange(files: string[]): void;
    allowLeft?: boolean;
}) {
    const files = parseDiff(text);
    if (!files.length) return <pre className={s.logs}>{text || '当前没有可显示的文本差异。'}</pre>;
    const ids = files.map((file, index) => `${index}/${file.name}`);
    return <div className={s.diff}>
        <div className={s.diffTools}>
            <small>{files.length} 个文件</small>
            <button onClick={() => onCollapsedFilesChange([])} disabled={ids.every(id => !collapsedFiles.includes(id))}>全部展开</button>
            <button onClick={() => onCollapsedFilesChange(ids)} disabled={ids.every(id => collapsedFiles.includes(id))}>全部收起</button>
        </div>
        {files.map((file, index) => {
            const id = ids[index]!;
            const open = !collapsedFiles.includes(id);
            return <details key={id} open={open} onToggle={event => {
                if (event.currentTarget.open !== open) onCollapsedFilesChange(event.currentTarget.open ? collapsedFiles.filter(value => value !== id) : [...collapsedFiles, id]);
            }}>
                <summary><span>{file.name}</span><span className={s.diffStat}>+{file.lines.filter(line => line.kind === 'added').length}<em>−{file.lines.filter(line => line.kind === 'removed').length}</em></span></summary>
                <div className={s.diffLabels}><span>原代码</span><span>修改后</span></div>
                <div className={s.diffScroll}><table><tbody>{file.lines.map((line, index) => line.kind === 'hunk' ? <tr key={index} className={s.hunk}><td colSpan={4}>{line.text}</td></tr> : <tr key={index} className={s[line.kind]}>{(['LEFT', 'RIGHT'] as const).map(side => {
                    const number = side === 'LEFT' ? line.left : line.right;
                    return <td colSpan={2} key={side}><button disabled={number === undefined || (side === 'LEFT' && !allowLeft)} className={s.codeLine} onClick={() => number !== undefined && onSelect({ file: file.name, line: number, side, anchor: { snippet: line.text || ' ' } })}><span>{number}</span><code>{number === undefined ? '' : line.text || ' '}</code></button></td>;
                })}</tr>)}</tbody></table></div>
            </details>;
        })}
    </div>;
}
