import type { ReviewApi } from './api.js';
import { AUDIT_TIMEOUT_MS } from './audit-lifecycle.js';
import type { AuditStage } from './audit-prompts.js';
import type { AuditExecutor } from './audit-stage-runner.js';

interface ToolContext {
  agent?: { id?: string; session?: { id?: string; header?: { id?: string } } };
  signal: AbortSignal;
}

interface AuditTool {
  name: string;
  description: string;
  parameters: object;
  output: { schema: object; render: (args: unknown, value: { json: string }) => Array<{ type: 'text'; text: string }> };
  timeoutMs: number;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<{ json: string }>;
}

export interface AuditToolRegistry {
  register(definition: AuditTool): () => void;
}

export function registerAuditStageTools(
  registry: AuditToolRegistry,
  api: ReviewApi | ((sessionId: string) => ReviewApi | undefined),
): () => void {
  const output = {
    schema: { type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false },
    render: (_args: unknown, value: { json: string }) => [{ type: 'text' as const, text: value.json }],
  };
  const owner = (context: ToolContext) => {
    const sessionId = context.agent?.session?.id ?? context.agent?.session?.header?.id ?? '';
    const runtime = typeof api === 'function' ? api(sessionId) : api;
    if (!runtime) throw new Error('阶段工具需要有效租约绑定的审查会话');
    return { runtime, sessionId };
  };
  const parse = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value || value.length > 64 * 1024) throw new Error('阶段工具需要有效 JSON 参数');
    return JSON.parse(value);
  };
  const run = registry.register({
    name: 'runAuditStage',
    description: '在当前审查租约运行初审(scan)、独立复核(verify)或补丁方案(patch)阶段。外部执行器不可用时自动降级为本 Harness 独立子代理。',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['scan', 'verify', 'patch'] },
        runner: { type: 'string', enum: ['codex', 'claude', 'claude-code', 'dsh-subagent'] },
        task: { type: 'string' },
      },
      required: ['stage', 'runner', 'task'],
      additionalProperties: false,
    },
    output,
    timeoutMs: AUDIT_TIMEOUT_MS,
    async execute(args, context) {
      const { runtime, sessionId } = owner(context);
      const result = await runtime.runAuditStage(
        sessionId,
        args['stage'] as AuditStage,
        args['runner'] as AuditExecutor,
        parse(args['task']),
        context.signal,
      );
      return { json: JSON.stringify(result) };
    },
  });
  const unregister = [run];
  try {
    unregister.push(registry.register({
      name: 'publishAuditArtifacts',
      description: '发布已核验的正式问题记录与本轮索引，供 Host 校验收尾。publication 为 JSON 字符串。',
      parameters: {
        type: 'object',
        properties: { publication: { type: 'string' } },
        required: ['publication'],
        additionalProperties: false,
      },
      output,
      timeoutMs: 60_000,
      async execute(args, context) {
        context.signal.throwIfAborted();
        const { runtime, sessionId } = owner(context);
        const result = await runtime.publishAuditStages(sessionId, parse(args['publication']), context.signal);
        return { json: JSON.stringify(result) };
      },
    }));
    unregister.push(registry.register({
      name: 'queryAuditHistory',
      description: '只读查询本轮审查范围内的历史问题及其人工处置（不主动列举已程序修复关闭的 approved 问题）。',
      parameters: {
        type: 'object',
        properties: {
          disposition: {
            type: 'string',
            enum: ['undecided', 'accept_as_is', 'defer', 'human_takeover', 'applied', 'resolved'],
          },
        },
        additionalProperties: false,
      },
      output,
      timeoutMs: 60_000,
      async execute(args, context) {
        context.signal.throwIfAborted();
        const { runtime, sessionId } = owner(context);
        const result = await runtime.queryAuditHistory(
          sessionId,
          typeof args['disposition'] === 'string' ? args['disposition'] : undefined,
        );
        return { json: JSON.stringify(result) };
      },
    }));
    return () => {
      for (const remove of [...unregister].reverse()) remove();
    };
  } catch (error) {
    for (const remove of unregister.reverse()) remove();
    throw error;
  }
}
