// 内置 js-yaml 4.3.2（MIT），YAML 读写无需在安装时另行获取此依赖。
import { load } from './vendor/js-yaml.js';
export { load, dump } from './vendor/js-yaml.js';

export function readMarkdownFrontmatter(text: string, filename: string): { doc: unknown; body: string } {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
    if (!match) throw new Error(`${filename} 缺少 YAML Frontmatter，起止分隔符必须各自独占一行（---）`);
    try {
        const doc: unknown = load(match[1] ?? '', {
            listener(event: string, state: { anchor: string | null; line: number }) {
                if (event === 'close' && state.anchor !== null) {
                    throw new Error(`禁止使用 YAML 锚点或别名（约第 ${String(state.line + 2)} 行）`);
                }
            },
        });
        return { doc, body: normalized.slice(match[0].length) };
    } catch (error) {
        throw new Error(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
}
