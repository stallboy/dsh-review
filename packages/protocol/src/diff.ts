/**
 * 前后端共享的纯 TypeScript 统一差异解析、并排视图构造、行内评论锚点重定位与安全外链校验。
 * 零运行时依赖，可同时在 Node、plugin client（esbuild IIFE）与 central web（Vite）中直接复用。
 */

import type { ReviewComment } from './review.js';

export type UnifiedDiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface UnifiedDiffFile {
  path: string;
  lines: UnifiedDiffLine[];
  binary: boolean;
}

export interface UnifiedSplitRow {
  kind: 'meta' | 'pair';
  meta: UnifiedDiffLine | null;
  left: UnifiedDiffLine | null;
  right: UnifiedDiffLine | null;
}

export interface RelocatedAnchor {
  side: 'LEFT' | 'RIGHT';
  line: number;
}

function unquoteGitPath(raw: string, gitPaths: boolean): string {
  let name = raw.split('\t')[0] ?? '';
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
}

/** 解析 Git / SVN unified diff，按 hunk 行数计数防护 `---`/`+++` 代码正文被误判为文件头。 */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const files: UnifiedDiffFile[] = [];
  let current: UnifiedDiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let gitPaths = true;

  const start = (filePath: string): UnifiedDiffFile => {
    const file: UnifiedDiffFile = { path: filePath, lines: [], binary: false };
    files.push(file);
    return file;
  };

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (inHunk && current) {
      if (raw.startsWith('-')) {
        current.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
        oldRemaining -= 1;
        continue;
      }
      if (raw.startsWith('+')) {
        current.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
        newRemaining -= 1;
        continue;
      }
      if (raw.startsWith(' ')) {
        current.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
    }
    if (raw.startsWith('diff --git ')) {
      gitPaths = true;
      const paths = /^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/.exec(raw);
      current = start(unquoteGitPath(paths?.[2] ?? raw.slice(11), true));
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    if (raw.startsWith('Index: ')) {
      gitPaths = false;
      current = start(raw.slice(7).trim());
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const target = raw.slice(4);
      if (!current || current.lines.length > 0) {
        current = start(target === '/dev/null' ? '' : unquoteGitPath(target, gitPaths));
      } else if (target !== '/dev/null' && !current.path) {
        current.path = unquoteGitPath(target, gitPaths);
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4);
      if (target !== '/dev/null') {
        const resolved = unquoteGitPath(target, gitPaths);
        if (!current) current = start(resolved);
        else current.path = resolved;
      }
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch') || raw.startsWith('Cannot display: file marked as a binary type')) {
      current.binary = true;
      current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[3]);
        oldRemaining = Number(match[2] ?? 1);
        newRemaining = Number(match[4] ?? 1);
      }
      current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith('\\')) {
      current.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
    }
  }
  return files;
}

/** 构造并排差异行；评论定位仍以原始差异行号和侧别为准。 */
export function buildSplitRows(lines: readonly UnifiedDiffLine[]): UnifiedSplitRow[] {
  const rows: UnifiedSplitRow[] = [];
  const pendingDeletions: UnifiedDiffLine[] = [];
  let deletionCursor = 0;

  const flushDeletions = (): void => {
    for (let index = deletionCursor; index < pendingDeletions.length; index += 1) {
      const line = pendingDeletions[index];
      if (line) rows.push({ kind: 'pair', meta: null, left: line, right: null });
    }
    pendingDeletions.length = 0;
    deletionCursor = 0;
  };

  for (const line of lines) {
    if (line.kind === 'del') {
      pendingDeletions.push(line);
      continue;
    }
    if (line.kind === 'add') {
      const left = pendingDeletions[deletionCursor] ?? null;
      if (left) deletionCursor += 1;
      rows.push({ kind: 'pair', meta: null, left, right: line });
      continue;
    }
    flushDeletions();
    if (line.kind === 'meta') rows.push({ kind: 'meta', meta: line, left: null, right: null });
    else rows.push({ kind: 'pair', meta: null, left: line, right: line });
  }
  flushDeletions();
  return rows;
}

/** 对已偏移的行内评论基于 anchor.snippet / before / after 在当前文件差异中重新定位。 */
export function relocateInlineComments(
  file: UnifiedDiffFile,
  comments: readonly Pick<ReviewComment, 'id' | 'file' | 'line' | 'side' | 'optionId' | 'anchor'>[],
  optionId?: string,
): Map<string, RelocatedAnchor> {
  const rowSideOf = (line: UnifiedDiffLine): 'LEFT' | 'RIGHT' => (line.kind === 'del' ? 'LEFT' : 'RIGHT');
  const rowNoOf = (line: UnifiedDiffLine): number | null => (line.kind === 'del' ? line.oldNo : line.newNo);

  const lineKeys = new Set<string>();
  for (const line of file.lines) {
    if (line.kind === 'meta') continue;
    const no = rowNoOf(line);
    if (no !== null) lineKeys.add(`${rowSideOf(line)}:${String(no)}`);
    if (line.kind === 'context' && line.oldNo !== null) lineKeys.add(`LEFT:${String(line.oldNo)}`);
  }

  const relocated = new Map<string, RelocatedAnchor>();
  for (const comment of comments) {
    if (comment.file !== file.path || !comment.anchor?.snippet) continue;
    if (optionId && comment.optionId && comment.optionId !== optionId) continue;
    const key = `${comment.side ?? 'RIGHT'}:${String(comment.line)}`;
    if (lineKeys.has(key)) continue;

    let bestIndex = -1;
    let bestScore = -1;
    for (let idx = 0; idx < file.lines.length; idx += 1) {
      const candidate = file.lines[idx]!;
      if (candidate.kind === 'meta' || candidate.text !== comment.anchor.snippet) continue;
      let score = 1;
      if (comment.anchor.before !== undefined && idx > 0 && file.lines[idx - 1]?.text === comment.anchor.before) score += 2;
      if (comment.anchor.after !== undefined && idx + 1 < file.lines.length && file.lines[idx + 1]?.text === comment.anchor.after) score += 2;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
    if (bestIndex >= 0) {
      const target = file.lines[bestIndex]!;
      const side = rowSideOf(target);
      const lineNo = rowNoOf(target);
      if (lineNo !== null) relocated.set(comment.id, { side, line: lineNo });
    }
  }
  return relocated;
}

/** 仅允许安全外链协议（http / https / mailto），阻断 javascript:/data:/vbscript: 注入。 */
export function safeExternalHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}
