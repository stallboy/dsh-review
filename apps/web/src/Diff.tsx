import s from './App.module.css';
import { parseDiff } from './diff-parser.js';

export interface Anchor { file: string; line: number; side: 'LEFT' | 'RIGHT'; anchor: { snippet: string } }
export function Diff({ text, onSelect, allowLeft = true }: { text: string; onSelect(anchor: Anchor): void; allowLeft?: boolean }) {
    const files = parseDiff(text);
    if (!files.length) return <pre className={s.logs}>{text || '当前没有可显示的文本差异。'}</pre>;
    return <div className={s.diff}>{files.map((file, index) => <section key={`${index}/${file.name}`}><h3>{file.name}</h3><div className={s.diffLabels}><span>原代码</span><span>修改后</span></div><div className={s.diffScroll}><table><tbody>{file.lines.map((line, index) => line.kind === 'hunk' ? <tr key={index} className={s.hunk}><td colSpan={4}>{line.text}</td></tr> : <tr key={index} className={s[line.kind]}>{(['LEFT', 'RIGHT'] as const).map(side => {
        const number = side === 'LEFT' ? line.left : line.right;
        return <td colSpan={2} key={side}><button disabled={number === undefined || (side === 'LEFT' && !allowLeft)} className={s.codeLine} onClick={() => number !== undefined && onSelect({ file: file.name, line: number, side, anchor: { snippet: line.text || ' ' } })}><span>{number}</span><code>{number === undefined ? '' : line.text || ' '}</code></button></td>;
    })}</tr>)}</tbody></table></div></section>)}</div>;
}
