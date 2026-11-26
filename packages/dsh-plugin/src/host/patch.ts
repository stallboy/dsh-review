import type { InterRevisionDiff, PatchFileStat, PatchStats } from './types.js';

export function isRepoRelativePath(value: string): boolean {
    if (!value || value.includes('\\') || value.includes('..') || value.startsWith('/') || value.endsWith('/')) return false;
    if (value.includes('./')) return false;
    return true;
}

export interface ParsedPatch {
  stats: PatchStats;
  /** 包含重命名/复制的源与目标以及删除路径，以便校验补丁触及的完整范围。 */
  paths: string[];
  /** 检测到的非普通文件模式（如 120000 符号链接、160000 子模块），供安全校验拦截。 */
  unsafeModes: string[];
  text: string;
  binary: boolean;
}

/** Git 的八进制转义表示 UTF-8 字节，须合并后再解码。 */
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

/** Git 路径前缀须在去除引号和解码之后剥离。 */
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

/** 未加引号的路径可能含空格。同路径情形可先按两侧等长定位分隔符。 */
function splitSamePath(value: string): string | null {
  const pathLength = (value.length - 5) / 2;
  if (!Number.isInteger(pathLength) || pathLength < 0) return null;
  const boundary = 2 + pathLength;
  if (value[boundary] !== ' ' || value.slice(boundary + 1, boundary + 3) !== 'b/') return null;
  const oldPath = value.slice(2, boundary);
  return value.slice(boundary + 3) === oldPath ? oldPath : null;
}

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

export function parsePatch(text: string): ParsedPatch {
  const entries = new Map<string, PatchFileStat>();
  const touched = new Set<string>();
  const unsafeModes = new Set<string>();
  let current: PatchFileStat | null = null;
  let binary = false;
  let inHunk = false;
  let inBinaryPayload = false;
  const noteTouched = (filePath: string | null): void => {
    if (filePath !== null && filePath.length > 0 && filePath !== '/dev/null') touched.add(filePath);
  };
  const checkMode = (mode: string): void => {
    if (mode !== '100644' && mode !== '100755') unsafeModes.add(mode);
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
      const filePath = headerPath(indexHeader[1] ?? '');
      noteTouched(filePath);
      current = entries.get(filePath) ?? { path: filePath, additions: 0, deletions: 0, binary: false };
      entries.set(filePath, current);
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    // 变更内容本身能产生以 --- 或 +++ 开头的行，hunk 内不能把它识别为文件头。
    if (inHunk) {
      if (line.startsWith('+')) {
        if (current) current.additions += 1;
      } else if (line.startsWith('-')) {
        if (current) current.deletions += 1;
      }
      continue;
    }
    const renameOrCopy = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (renameOrCopy) {
      noteTouched(unquoteGitPath(renameOrCopy[1] ?? ''));
      continue;
    }
    const modeHeader = /^(?:new file mode|deleted file mode|old mode|new mode) (\d{6})$/.exec(line);
    if (modeHeader?.[1]) {
      checkMode(modeHeader[1]);
      continue;
    }
    const gitIndexMode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/.exec(line);
    if (gitIndexMode?.[1]) {
      checkMode(gitIndexMode[1]);
      continue;
    }
    const plusHeader = /^\+\+\+ (.+)$/.exec(line);
    if (plusHeader) {
      const filePath = headerPath(plusHeader[1] ?? '');
      noteTouched(filePath);
      if (filePath !== '/dev/null') {
        current = entries.get(filePath) ?? { path: filePath, additions: 0, deletions: 0, binary: false };
        entries.set(filePath, current);
      }
      continue;
    }
    const minusHeader = /^--- (.+)$/.exec(line);
    if (minusHeader) {
      const filePath = headerPath(minusHeader[1] ?? '');
      noteTouched(filePath);
      if (filePath !== '/dev/null' && current === null) {
        current = entries.get(filePath) ?? { path: filePath, additions: 0, deletions: 0, binary: false };
        entries.set(filePath, current);
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
  return { stats, paths: [...touched], unsafeModes: [...unsafeModes], text, binary };
}

/** AC-MEMORY-01：合并补丁 hunk header 中的函数/结构体符号，去重截断，供负向记忆提示词辅助使用。 */
export function extractPatchSymbols(patchTexts: readonly string[]): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const patchText of patchTexts) {
    if (!patchText) continue;
    for (const line of patchText.replace(/\r\n/g, '\n').split('\n')) {
      const match = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]+(.+)$/.exec(line);
      if (!match) continue;
      const symbol = (match[1] ?? '').trim().slice(0, 120);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      symbols.push(symbol);
      if (symbols.length >= 16) return symbols;
    }
  }
  return symbols;
}

const FORBIDDEN_PATH_PREFIXES = ['.ai-review/', '.tmp/', 'node_modules/', '.git/', '.svn/'];

export function isAiReviewPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (FORBIDDEN_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return true;
  }
  // Git worktree 的 .git 是指向元数据目录的文件，也须拦截。
  const segments = normalized.split('/');
  return segments.includes('.git') || segments.includes('.svn');
}

/** 只使用补丁实际覆盖的行，无法提取锚点时调用方仍可保存原评论坐标。 */
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

/** 用于两份补丁基线不同的降级展示。返回的是原 hunk 对照，界面须提示它不代表可计算的差异。 */
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
