interface DiffLine { text: string; kind: string; left?: number; right?: number }
interface DiffFile { name: string; lines: DiffLine[] }

export function parseDiff(text: string): DiffFile[] {
    const files: DiffFile[] = [];
    let file: DiffFile | undefined, left = 0, right = 0, oldRemaining = 0, newRemaining = 0;
    let gitPaths = true;
    const start = (name: string) => { file = { name, lines: [] }; files.push(file); };
    const filename = (value: string) => {
        let name = value.split('\t')[0]!;
        if (gitPaths && name.startsWith('"') && name.endsWith('"')) {
            const bytes: number[] = [];
            const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
            for (const token of name.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
                if (token[2] !== undefined) bytes.push(...new TextEncoder().encode(token[2]));
                else if (/^[0-7]/.test(token[1]!)) bytes.push(parseInt(token[1]!, 8));
                else bytes.push((escapes[token[1]!] ?? token[1]!).charCodeAt(0));
            }
            name = new TextDecoder().decode(new Uint8Array(bytes));
        }
        return gitPaths ? name.replace(/^[ab]\//, '') : name;
    };
    for (const line of text.split(/\r?\n/)) {
        const inHunk = oldRemaining > 0 || newRemaining > 0;
        if (inHunk && file) {
            if (line.startsWith('-')) { file.lines.push({ text: line.slice(1), kind: 'removed', left: left++ }); oldRemaining--; continue; }
            if (line.startsWith('+')) { file.lines.push({ text: line.slice(1), kind: 'added', right: right++ }); newRemaining--; continue; }
            if (line.startsWith(' ')) { file.lines.push({ text: line.slice(1), kind: 'context', left: left++, right: right++ }); oldRemaining--; newRemaining--; continue; }
        }
        if (line.startsWith('diff --git ')) {
            gitPaths = true;
            const paths = /^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/.exec(line);
            start(filename(paths?.[2] ?? line.slice(11)));
            oldRemaining = 0; newRemaining = 0;
        } else if (line.startsWith('Index: ')) {
            gitPaths = false;
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
