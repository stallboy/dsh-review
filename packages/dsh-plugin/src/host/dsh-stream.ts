/**
 * 统一 DSH / Claude Headless JSON 事件流增量解析器：
 * - 逐行消费而不缓存整段 stdout，避免大型工具输出流触及缓冲区上限导致最终结果被截断；
 * - 严格过滤非助手事件（tool_result / tool_use / user / system / thinking 等），防止仓库源码或工具输出中的伪造 JSON 被误判为助手结论；
 * - delta 增量片段无多余换行直接拼接，保持分片 JSON 完整性。
 */

const IGNORED_EVENT_TYPES = new Set([
  'tool_result',
  'tool_use',
  'tool_call',
  'tool_output',
  'user',
  'system',
  'init',
  'progress',
  'thinking',
  'reasoning',
  'status',
  'heartbeat',
  'error',
]);

const IGNORED_ROLES = new Set(['user', 'system', 'tool', 'developer']);

const MAX_ASSISTANT_CHARS = 2 * 1024 * 1024;

export function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse((fenced[i]?.[1] ?? '').trim()); } catch { /* continue */ }
  }
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace >= 0) {
    for (let pos = trimmed.lastIndexOf('{', lastBrace); pos >= 0; pos = trimmed.lastIndexOf('{', pos - 1)) {
      try { return JSON.parse(trimmed.slice(pos, lastBrace + 1)); } catch { /* continue */ }
    }
  }
  return undefined;
}

function extractMessageContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const rec = block as Record<string, unknown>;
    const blockType = typeof rec['type'] === 'string' ? rec['type'].toLowerCase() : 'text';
    if (blockType !== 'text' && blockType !== 'output_text') continue;
    if (typeof rec['text'] === 'string' && rec['text']) parts.push(rec['text']);
  }
  return parts.length > 0 ? parts.join('') : null;
}

export class DshEventStreamParser {
  private structuredOutput: unknown = undefined;
  private hasStructuredOutput = false;
  private assistantText = '';
  private plainLines: string[] = [];
  private sawJsonEvents = false;

  private appendText(fragment: string, withNewline: boolean): void {
    if (!fragment) return;
    if (withNewline && this.assistantText.length > 0 && !this.assistantText.endsWith('\n')) {
      this.assistantText += '\n';
    }
    this.assistantText += fragment;
    if (this.assistantText.length > MAX_ASSISTANT_CHARS) {
      this.assistantText = this.assistantText.slice(this.assistantText.length - MAX_ASSISTANT_CHARS);
    }
  }

  /** 处理单行 stdout；返回 true 表示该行已作为助手事件提取（调用方无需作为普通日志重复刷屏）。 */
  feedLine(rawLine: string): boolean {
    const trimmed = rawLine.trim();
    if (!trimmed) return false;
    if (!trimmed.startsWith('{')) {
      if (this.plainLines.length < 4000) this.plainLines.push(rawLine);
      return false;
    }

    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (this.plainLines.length < 4000) this.plainLines.push(rawLine);
        return false;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      if (this.plainLines.length < 4000) this.plainLines.push(rawLine);
      return false;
    }

    this.sawJsonEvents = true;

    const eventType = typeof obj['type'] === 'string' ? obj['type'].toLowerCase() : '';
    const role = typeof obj['role'] === 'string' ? obj['role'].toLowerCase() : '';
    if (IGNORED_EVENT_TYPES.has(eventType) || IGNORED_ROLES.has(role)) {
      return false;
    }

    if (obj['structured_output'] !== undefined) {
      this.structuredOutput = obj['structured_output'];
      this.hasStructuredOutput = true;
      return true;
    }

    // 嵌套 message 对象（Anthropic / DSH assistant message 格式）
    const msg = obj['message'];
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      const msgRec = msg as Record<string, unknown>;
      const msgRole = typeof msgRec['role'] === 'string' ? msgRec['role'].toLowerCase() : '';
      if (IGNORED_ROLES.has(msgRole)) return false;
      if (msgRole === 'assistant' || eventType === 'assistant' || eventType === 'message' || !msgRole) {
        const extracted = extractMessageContentText(msgRec['content']);
        if (extracted !== null) {
          this.appendText(extracted, true);
          return true;
        }
      }
    }

    // 增量 delta（严禁插入 '\n'，防止把 JSON token 切裂）
    if (typeof obj['delta'] === 'string') {
      if (!eventType || eventType.includes('text') || eventType.includes('assistant') || eventType.includes('delta') || eventType === 'content_block_delta') {
        this.appendText(obj['delta'], false);
        return true;
      }
      return false;
    }
    if (obj['delta'] && typeof obj['delta'] === 'object' && !Array.isArray(obj['delta'])) {
      const deltaRec = obj['delta'] as Record<string, unknown>;
      const deltaType = typeof deltaRec['type'] === 'string' ? deltaRec['type'].toLowerCase() : 'text_delta';
      if ((deltaType === 'text_delta' || deltaType === 'text') && typeof deltaRec['text'] === 'string') {
        this.appendText(deltaRec['text'], false);
        return true;
      }
      return false;
    }

    // Claude / DSH 终态 result 字段
    if (eventType === 'result' && typeof obj['result'] === 'string') {
      this.appendText(obj['result'], true);
      return true;
    }
    if (!eventType && typeof obj['result'] === 'string') {
      this.appendText(obj['result'], true);
      return true;
    }

    // 显式助手文本事件
    if (
      (!eventType || eventType === 'assistant' || eventType === 'text' || eventType === 'assistant_text' || eventType === 'output_text' || eventType === 'message')
      && typeof obj['text'] === 'string'
    ) {
      this.appendText(obj['text'], eventType !== 'text_delta');
      return true;
    }

    if ((eventType === 'assistant' || role === 'assistant') && typeof obj['content'] === 'string') {
      this.appendText(obj['content'], true);
      return true;
    }

    // 若本身就是非包裹结构的纯 JSON 载荷（如直接输出 { verdict, ... } 或 { leads, ... }），保留原行供 JSON 解析
    if (!eventType && !role && !('tool_call_id' in obj) && !('tool_use_id' in obj)) {
      this.appendText(trimmed, true);
      return true;
    }

    return false;
  }

  getAssistantText(): string {
    if (this.assistantText.trim().length > 0) return this.assistantText;
    if (!this.sawJsonEvents && this.plainLines.length > 0) return this.plainLines.join('\n');
    return '';
  }

  extractJsonOutput(): unknown {
    if (this.hasStructuredOutput) return this.structuredOutput;
    const text = this.getAssistantText();
    if (text) return parseJsonPayload(text);
    if (!this.sawJsonEvents && this.plainLines.length > 0) {
      return parseJsonPayload(this.plainLines.join('\n'));
    }
    return undefined;
  }
}
