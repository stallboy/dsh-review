interface DiffLine { text: string; kind: string; left?: number; right?: number }
interface DiffFile { name: string; lines: DiffLine[] }

export function parseDiff(text: string): DiffFile[] {
    const files: DiffFile[] = [];
    let file: DiffFile | undefined, left = 0, right = 0, oldRemaining = 0, newRemaining = 0;
    const start = (name: string) => { file = { name, lines: [] }; files.push(file); };
    const filename = (value: string) => {
        let name = value.split('\t')[0]!;
        if (name.startsWith('"')) { try { name = JSON.parse(name); } catch {} }
        return name.replace(/^[ab]\//, '');
    };
    for (const line of text.split(/\r?\n/)) {
        const inHunk = oldRemaining > 0 || newRemaining > 0;
        if (inHunk && file) {
            if (line.startsWith('-')) { file.lines.push({ text: line.slice(1), kind: 'removed', left: left++ }); oldRemaining--; continue; }
            if (line.startsWith('+')) { file.lines.push({ text: line.slice(1), kind: 'added', right: right++ }); newRemaining--; continue; }
            if (line.startsWith(' ')) { file.lines.push({ text: line.slice(1), kind: 'context', left: left++, right: right++ }); oldRemaining--; newRemaining--; continue; }
        }
        if (line.startsWith('diff --git ')) {
            start(line.replace(/^diff --git a\/.* b\//, ''));
            oldRemaining = 0; newRemaining = 0;
        } else if (line.startsWith('Index: ')) {
            start(line.slice(7));
            oldRemaining = 0; newRemaining = 0;
        } else if (line.startsWith('--- ')) {
            if (!file || file.lines.length) start(filename(line.slice(4)));
            else if (line.slice(4) !== '/dev/null') file.name = filename(line.slice(4));
        } else if (line.startsWith('+++ ')) {
            if (line.slice(4) !== '/dev/null') {
                if (!file) start(filename(line.slice(4))); else file.name = filename(line.slice(4));
            }
        } else if (line.startsWith('@@')) {
            const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (match) {
                left = Number(match[1]); right = Number(match[3]);
                oldRemaining = Number(match[2] ?? 1); newRemaining = Number(match[4] ?? 1);
            }
            file?.lines.push({ text: line, kind: 'hunk' });
        } else if (file && (line.startsWith('Binary ') || line.startsWith('\\ No newline'))) {
            file.lines.push({ text: line, kind: 'hunk' });
        }
    }
    return files;
}
