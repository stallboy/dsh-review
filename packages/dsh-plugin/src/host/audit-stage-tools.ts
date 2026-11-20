import type { ReviewApi } from './api.js';
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

export function registerAuditStageTools(registry: AuditToolRegistry, api: ReviewApi): () => void {
    const output = {
        schema: { type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false },
        render: (_args: unknown, value: { json: string }) => [{ type: 'text' as const, text: value.json }],
    };
    const sessionId = (context: ToolContext) => context.agent?.session?.id ?? context.agent?.session?.header?.id ?? '';
    const parse = (value: unknown): unknown => {
        if (typeof value !== 'string' || !value || value.length > 48 * 1024) throw new Error('阶段工具需要有效 JSON 参数');
        return JSON.parse(value);
    };
    const run = registry.register({
        name: 'runAuditStage', description: '在当前审查租约运行初审、独立复核或补丁阶段。task 为阶段参数的 JSON 字符串。',
        parameters: {
            type: 'object', properties: {
                stage: { type: 'string', enum: ['scan', 'verify', 'patch'] },
                runner: { type: 'string', enum: ['codex', 'claude-code'] },
                task: { type: 'string' },
            }, required: ['stage', 'runner', 'task'], additionalProperties: false,
        },
        output, timeoutMs: 3600_000,
        async execute(args, context) {
            const result = await api.runAuditStage(sessionId(context), args['stage'] as AuditStage, args['runner'] as AuditExecutor,
                parse(args['task']), context.signal);
            return { json: JSON.stringify(result) };
        },
    });
    const unregister = [run];
    try {
        unregister.push(registry.register({
            name: 'publishAuditArtifacts', description: '发布已核验的正式发现和候选，供 Host 收尾。publication 为 JSON 字符串。',
            parameters: {
                type: 'object', properties: { publication: { type: 'string' } }, required: ['publication'], additionalProperties: false,
            },
            output, timeoutMs: 60_000,
            async execute(args, context) {
                context.signal.throwIfAborted();
                const result = await api.publishAuditStages(sessionId(context), parse(args['publication']));
                return { json: JSON.stringify(result) };
            },
        }));
        unregister.push(registry.register({
            name: 'queryAuditHistory', description: '只读查询本轮审查范围内的历史发现及人的处置。',
            parameters: { type: 'object', properties: { disposition: {
                type: 'string', enum: ['undecided', 'accept_as_is', 'defer', 'human_takeover', 'applied', 'resolved'],
            } }, additionalProperties: false },
            output, timeoutMs: 60_000,
            async execute(args, context) {
                context.signal.throwIfAborted();
                const result = await api.queryAuditHistory(sessionId(context), typeof args['disposition'] === 'string' ? args['disposition'] : undefined);
                return { json: JSON.stringify(result) };
            },
        }));
        return () => { for (const remove of [...unregister].reverse()) remove(); };
    } catch (error) {
        for (const remove of unregister.reverse()) remove();
        throw error;
    }
}
