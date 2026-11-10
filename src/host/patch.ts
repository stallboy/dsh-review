import type { InterRevisionDiff, PatchFileStat, PatchStats } from './types.js';

export interface ParsedPatch {
  stats: PatchStats;
  /** Every path the patch touches, including the old side of a rename or deletion. */
  paths: string[];
  text: string;
  binary: boolean;
}

/**
 * Decode a git-quoted path (`core.quotepath` defaults to true for non-ASCII
 * names): C escapes plus octal byte escapes that must be decoded as UTF-8.
 */
function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? '';
    if (char !== '\\') {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) break;
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripDiffPrefix(value: string): string {
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

/** Path from a `---`/`+++`/`Index:` line; the prefix must be stripped after unquoting. */
function headerPath(value: string): string {
  const withoutTab = value.split('\t')[0] ?? '';
  return stripDiffPrefix(unquoteGitPath(withoutTab));
}

function readQuotedToken(text: string, start: number): { token: string; end: number } | null {
  if (text[start] !== '"') return null;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') return { token: text.slice(start, index + 1), end: index + 1 };
    index += 1;
  }
  return null;
}

/** `a/<same path> b/<same path>`; the only unambiguous split for bare paths with spaces. */
function splitSamePath(value: string): string | null {
  const pathLength = (value.length - 5) / 2;
  if (!Number.isInteger(pathLength) || pathLength < 0) return null;
  const boundary = 2 + pathLength;
  if (value[boundary] !== ' ' || value.slice(boundary + 1, boundary + 3) !== 'b/') return null;
  const oldPath = value.slice(2, boundary);
  return value.slice(boundary + 3) === oldPath ? oldPath : null;
}

/** Both sides of a `diff --git` header; git quotes each side that needs quoting. */
function diffHeaderPaths(value: string): { oldPath: string; newPath: string } | null {
  const rest = value.trim();
  if (rest.startsWith('"')) {
    const first = readQuotedToken(rest, 0);
    if (!first) return null;
    let index = first.end;
    while (rest[index] === ' ') index += 1;
    const second = readQuotedToken(rest, index);
    return { oldPath: headerPath(first.token), newPath: headerPath(second ? second.token : rest.slice(index)) };
  }
  if (!rest.startsWith('a/')) return null;
  const same = splitSamePath(rest);
  if (same !== null) return { oldPath: same, newPath: same };
  const boundary = rest.indexOf(' b/');
  if (boundary <= 0) return null;
  return { oldPath: headerPath(rest.slice(0, boundary)), newPath: headerPath(rest.slice(boundary + 1)) };
}

/** Parse a unified diff (git or svn flavor) enough for queue stats and path validation. */
export function parsePatch(text: string): ParsedPatch {
  const entries = new Map<string, PatchFileStat>();
  const touched = new Set<string>();
  let current: PatchFileStat | null = null;
  let binary = false;
  let inHunk = false;
  let inBinaryPayload = false;
  const noteTouched = (path: string | null): void => {
    if (path !== null && path.length > 0 && path !== '/dev/null') touched.add(path);
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const diffHeader = /^diff --git (.+)$/.exec(line);
    if (diffHeader) {
      inHunk = false;
      inBinaryPayload = false;
      const paths = diffHeaderPaths(diffHeader[1] ?? '');
      if (!paths) continue;
      noteTouched(paths.oldPath);
      noteTouched(paths.newPath);
      current = entries.get(paths.newPath) ?? { path: paths.newPath, additions: 0, deletions: 0, binary: false };
      entries.set(paths.newPath, current);
      continue;
    }
    if (inBinaryPayload) continue;
    const indexHeader = /^Index: (.+)$/.exec(line);
    if (indexHeader) {
      inHunk = false;
      const path = headerPath(indexHeader[1] ?? '');
      noteTouched(path);
      current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
      entries.set(path, current);
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    // Inside a hunk every '---'/'+++' line is content (a removed line may start
    // with '-- ', an added line with '++ '), never a file header.
    if (inHunk) {
      if (line.startsWith('+')) {
        if (current) current.additions += 1;
      } else if (line.startsWith('-')) {
        if (current) current.deletions += 1;
      }
      continue;
    }
    const plusHeader = /^\+\+\+ (.+)$/.exec(line);
    if (plusHeader) {
      const path = headerPath(plusHeader[1] ?? '');
      noteTouched(path);
      if (path !== '/dev/null') {
        current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
        entries.set(path, current);
      }
      continue;
    }
    const minusHeader = /^--- (.+)$/.exec(line);
    if (minusHeader) {
      const path = headerPath(minusHeader[1] ?? '');
      noteTouched(path);
      if (path !== '/dev/null' && current === null) {
        current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
        entries.set(path, current);
      }
      continue;
    }
    if (line.startsWith('GIT binary patch')) {
      binary = true;
      inBinaryPayload = true;
      if (current) current.binary = true;
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('Cannot display: file marked as a binary type')) {
      binary = true;
      if (current) current.binary = true;
    }
  }
  const list = [...entries.values()].filter((entry) => entry.path.length > 0);
  const stats: PatchStats = {
    files: list.length,
    additions: list.reduce((total, entry) => total + entry.additions, 0),
    deletions: list.reduce((total, entry) => total + entry.deletions, 0),
    entries: list,
  };
  return { stats, paths: [...touched], text, binary };
}

/** §4.6/G15：补丁不得触及的仓库路径前缀与 VCS 管理文件。 */
const FORBIDDEN_PATH_PREFIXES = ['.ai-review/', '.tmp/', 'node_modules/', '.git/', '.svn/'];

export function isAiReviewPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (FORBIDDEN_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return true;
  }
  // 名为 .git 的 worktree 管理文件（根或任意目录下）。
  const segments = normalized.split('/');
  return segments.includes('.git') || segments.includes('.svn');
}

/**
 * §4.3：从当前 revision 的补丁 Hunk 中提取被评论行的原文与前后行，作为 Host 兜底 anchor。
 * 只做内存解析；目标行不在 Hunk 覆盖范围内时返回 undefined（调用方静默省略）。
 */
export function anchorFromPatch(
  patchText: string,
  file: string,
  line: number,
  side: 'LEFT' | 'RIGHT',
): { snippet: string; before?: string; after?: string } | undefined {
  const target = file.replaceAll('\\', '/').replace(/^\.\//, '');
  const lines = patchText.split(/\r?\n/);
  let currentFile = '';
  let inTarget = false;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const rows: { oldNo: number | null; newNo: number | null; text: string }[] = [];
  const flush = (): { snippet: string; before?: string; after?: string } | undefined => {
    const index = rows.findIndex((row) => (side === 'LEFT' ? row.oldNo === line : row.newNo === line));
    if (index < 0) return undefined;
    const row = rows[index];
    if (!row) return undefined;
    return {
      snippet: row.text,
      ...(index > 0 && rows[index - 1] ? { before: rows[index - 1]?.text ?? '' } : {}),
      ...(index + 1 < rows.length && rows[index + 1] ? { after: rows[index + 1]?.text ?? '' } : {}),
    };
  };
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      if (inTarget) {
        const found = flush();
        if (found) return found;
      }
      rows.length = 0;
      inTarget = false;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const plus = raw.slice(4).trim().replace(/^b\//, '');
      inTarget = plus === target;
      rows.length = 0;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) {
      currentFile = raw.startsWith('--- /dev/null') ? '' : raw.slice(4).trim().replace(/^a\//, '');
      // 删除文件的 Hunk 只有 `--- a/file` + `+++ /dev/null`：从旧路径命中目标。
      if (currentFile === target) inTarget = true;
      if (inTarget && currentFile !== '' && currentFile !== target) inTarget = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1] ?? 0);
      newNo = Number(hunk[2] ?? 0);
      inHunk = inTarget;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith(' ')) {
      rows.push({ oldNo, newNo, text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    } else if (raw.startsWith('-')) {
      rows.push({ oldNo, newNo: null, text: raw.slice(1) });
      oldNo += 1;
    } else if (raw.startsWith('+')) {
      rows.push({ oldNo: null, newNo, text: raw.slice(1) });
      newNo += 1;
    }
  }
  return inTarget ? flush() : undefined;
}

/**
 * Hunk-level fallback for cross-base diffs. It deliberately does not pretend to
 * be a computed diff: it shows both patches' per-file hunks side by side in one
 * text report, which the UI renders with an explicit "unreliable" banner.
 */
export function buildHunkFallbackDiff(
  fromRevision: number,
  toRevision: number,
  fromBase: string,
  toBase: string,
  fromPatch: string,
  toPatch: string,
  notes: string[],
): InterRevisionDiff {
  const from = parsePatch(fromPatch);
  const to = parsePatch(toPatch);
  const allPaths = [...new Set([...from.stats.entries, ...to.stats.entries].map((entry) => entry.path))].sort();
  const chunks: string[] = [
    `# 跨基线 Hunk 对比（rev ${String(fromRevision)} → rev ${String(toRevision)}）`,
    `# 旧基线: ${fromBase}`,
    `# 新基线: ${toBase}`,
    '# 说明: 旧补丁无法干净地三方应用到新基线，以下按文件列出两版补丁的 hunk，',
    '# 不代表逐行计算出的实际变更，请结合代码导览阅读。',
  ];
  if (notes.length > 0) chunks.push(...notes.map((note) => `# ${note}`));
  for (const path of allPaths) {
    chunks.push('', `## 文件 ${path}`, '', `### 旧版本 rev ${String(fromRevision)} (${fromBase})`);
    const fromPart = extractFileSection(fromPatch, path);
    chunks.push(fromPart.trim().length > 0 ? fromPart : '(该版本未修改此文件)');
    chunks.push('', `### 新版本 rev ${String(toRevision)} (${toBase})`);
    const toPart = extractFileSection(toPatch, path);
    chunks.push(toPart.trim().length > 0 ? toPart : '(该版本未修改此文件)');
  }
  return {
    resolutionMode: 'cross_base_hunk_fallback',
    unifiedDiff: chunks.join('\n'),
    fromRevision,
    toRevision,
    fromBase,
    toBase,
    notes,
  };
}

function extractFileSection(patchText: string, path: string): string {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const collected: string[] = [];
  let active = false;
  for (const line of lines) {
    const diffHeader = /^diff --git (.+)$/.exec(line);
    if (diffHeader) {
      const paths = diffHeaderPaths(diffHeader[1] ?? '');
      active = paths !== null && paths.newPath === path;
      if (active) collected.push(line);
      continue;
    }
    // `svn diff` uses `Index:` sections instead of git's `diff --git` headers.
    const indexHeader = /^Index: (.+)$/.exec(line);
    if (indexHeader) {
      active = headerPath(indexHeader[1] ?? '') === path;
      if (active) collected.push(line);
      continue;
    }
    if (active) collected.push(line);
  }
  return collected.join('\n');
}
