import { safeExternalHref } from '@dsh-review/protocol';
import type { ReactLike } from './types.js';

export type RichTextComponent = (props: { text: string; className?: string }) => unknown;

/** 审查正文可来自仓库；构造 React 节点并校验外链协议，阻断原始 HTML 与 javascript:/data: XSS。 */
export function createRichText(React: ReactLike): RichTextComponent {
  const h = React.createElement;

  function inlineNodes(text: string, keyPrefix: string): unknown[] {
    const nodes: unknown[] = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      const token = match[0];
      if (token.startsWith('**')) {
        nodes.push(h('strong', { key: `${keyPrefix}-b-${String(index)}` }, token.slice(2, -2)));
      } else if (token.startsWith('`')) {
        nodes.push(h('code', { key: `${keyPrefix}-c-${String(index)}` }, token.slice(1, -1)));
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        const safeHref = link ? safeExternalHref(link[2]) : null;
        if (link && safeHref) {
          nodes.push(h('a', {
            key: `${keyPrefix}-a-${String(index)}`,
            href: safeHref,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, link[1]));
        } else {
          nodes.push(link ? link[1] : token);
        }
      }
      last = match.index + token.length;
      index += 1;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  return function RichText(props: { text: string; className?: string }) {
    const text = (props.text || '').replace(/\r\n/g, '\n').trim();
    if (!text) return h('div', { className: 'dcr-muted dcr-small' }, '未填写');
    const blocks: unknown[] = [];
    const lines = text.split('\n');
    let seq = 0;
    const nextKey = (): string => `rt-${String(seq++)}`;
    const isBlockStart = (line: string): boolean =>
      /^#{1,4}\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || line.startsWith('```');

    let index = 0;
    while (index < lines.length) {
      const line = (lines[index] ?? '').trim();
      if (!line) {
        index += 1;
        continue;
      }
      if (line.startsWith('```')) {
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
          code.push(lines[index] ?? '');
          index += 1;
        }
        index += 1;
        blocks.push(h('pre', { key: nextKey(), className: 'dcr-codeblock' }, code.join('\n')));
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        blocks.push(h('div', { key: nextKey(), className: `dcr-rt-h dcr-rt-h${String(level)}` }, ...inlineNodes(heading[2] ?? '', nextKey())));
        index += 1;
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (index < lines.length) {
          const bullet = /^[-*]\s+(.+)$/.exec((lines[index] ?? '').trim());
          if (!bullet) break;
          let item = bullet[1] ?? '';
          index += 1;
          while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? '') && !isBlockStart((lines[index] ?? '').trim())) {
            item += ` ${(lines[index] ?? '').trim()}`;
            index += 1;
          }
          items.push(item);
        }
        blocks.push(h('ul', { key: nextKey() }, ...items.map((item, itemIndex) =>
          h('li', { key: `${String(itemIndex)}` }, ...inlineNodes(item, nextKey())))));
        continue;
      }
      if (/^\d+[.)]\s+/.test(line)) {
        const items: string[] = [];
        while (index < lines.length) {
          const ordered = /^\d+[.)]\s+(.+)$/.exec((lines[index] ?? '').trim());
          if (!ordered) break;
          items.push(ordered[1] ?? '');
          index += 1;
        }
        blocks.push(h('ol', { key: nextKey() }, ...items.map((item, itemIndex) =>
          h('li', { key: `${String(itemIndex)}` }, ...inlineNodes(item, nextKey())))));
        continue;
      }
      const paragraph: string[] = [line];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? '').trim();
        if (!next || isBlockStart(next)) break;
        paragraph.push(next);
        index += 1;
      }
      blocks.push(h('p', { key: nextKey() }, ...inlineNodes(paragraph.join(' '), nextKey())));
    }
    return h('div', { className: `dcr-rt ${props.className ?? ''}`.trim() }, ...blocks);
  };
}
