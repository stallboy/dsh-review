import type { InterRevisionDiff, PatchFileStat, PatchStats } from './types.js';

export interface ParsedPatch {
  stats: PatchStats;
  paths: string[];
  text: string;
  binary: boolean;
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

function headerPath(value: string): string {
  const withoutTab = value.split('\t')[0] ?? '';
  const trimmed = withoutTab.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
  return unquoteGitPath(withoutPrefix);
}

/** Parse a unified diff (git or svn flavor) enough for queue stats and path validation. */
export function parsePatch(text: string): ParsedPatch {
  const entries = new Map<string, PatchFileStat>();
  let current: PatchFileStat | null = null;
  let binary = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffHeader) {
      const path = unquoteGitPath(diffHeader[2] ?? diffHeader[1] ?? '');
      current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
      entries.set(path, current);
      continue;
    }
    const indexHeader = /^Index: (.+)$/.exec(line);
    if (indexHeader) {
      const path = headerPath(indexHeader[1] ?? '');
      current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
      entries.set(path, current);
      continue;
    }
    const plusHeader = /^\+\+\+ (.+)$/.exec(line);
    if (plusHeader) {
      const path = headerPath(plusHeader[1] ?? '');
      if (path !== '/dev/null') {
        current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
        entries.set(path, current);
      }
      continue;
    }
    const minusHeader = /^--- (.+)$/.exec(line);
    if (minusHeader) {
      const path = headerPath(minusHeader[1] ?? '');
      if (path !== '/dev/null' && current === null) {
        current = entries.get(path) ?? { path, additions: 0, deletions: 0, binary: false };
        entries.set(path, current);
      }
      continue;
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ') || line.startsWith('Cannot display: file marked as a binary type')) {
      binary = true;
      if (current) current.binary = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (current) current.additions += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (current) current.deletions += 1;
      continue;
    }
  }
  const list = [...entries.values()].filter((entry) => entry.path.length > 0);
  const stats: PatchStats = {
    files: list.length,
    additions: list.reduce((total, entry) => total + entry.additions, 0),
    deletions: list.reduce((total, entry) => total + entry.deletions, 0),
    entries: list,
  };
  return { stats, paths: list.map((entry) => entry.path), text, binary };
}

export function isAiReviewPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized === '.ai-review' || normalized.startsWith('.ai-review/');
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
  const allPaths = [...new Set([...from.paths, ...to.paths])].sort();
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
    const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffHeader) {
      const candidate = unquoteGitPath(diffHeader[2] ?? diffHeader[1] ?? '');
      active = candidate === path;
      if (active) collected.push(line);
      continue;
    }
    if (active) collected.push(line);
  }
  return collected.join('\n');
}
