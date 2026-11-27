import {
  parseUnifiedDiff,
  relocateInlineComments,
  type RelocatedAnchor,
  type UnifiedDiffFile,
} from '@dsh-review/protocol';

export { parseUnifiedDiff, relocateInlineComments, type RelocatedAnchor, type UnifiedDiffFile };

export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'hunk';
  left?: number;
  right?: number;
  text: string;
}

export interface DiffFile {
  name: string;
  lines: DiffLine[];
  raw: UnifiedDiffFile;
}

/** 复用 @dsh-review/protocol 的统一 diff 解析器并适配为 Web 差异表格行结构。 */
export function parseDiff(text: string): DiffFile[] {
  return parseUnifiedDiff(text).map((file) => ({
    name: file.path,
    raw: file,
    lines: file.lines.map((line) => ({
      kind: line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : line.kind === 'meta' ? 'hunk' : 'context',
      ...(line.oldNo !== null ? { left: line.oldNo } : {}),
      ...(line.newNo !== null ? { right: line.newNo } : {}),
      text: line.text,
    })),
  }));
}
