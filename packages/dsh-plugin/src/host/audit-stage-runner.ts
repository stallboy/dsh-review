import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runProcess } from './shell.js';

export const AUDIT_EXECUTORS = ['codex', 'claude-code'] as const;
export type AuditExecutor = typeof AUDIT_EXECUTORS[number];

type Schema =
    | { type: 'string'; enum?: readonly string[] }
    | { type: 'integer' }
    | { type: 'array'; items: Schema }
    | { type: 'object'; additionalProperties: false; required: string[]; properties: Record<string, Schema> };

export const stringSchema = { type: 'string' } as const;
export const integerSchema = { type: 'integer' } as const;
export const arraySchema = (items: Schema): Schema => ({ type: 'array', items });
export const enumSchema = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const objectSchema = (properties: Record<string, Schema>): Schema => ({
    type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});

export function auditObject(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
    return value as Record<string, unknown>;
}

export function validateAuditValue(schema: Schema, value: unknown, field = 'result'): void {
    switch (schema.type) {
        case 'string':
            if (typeof value !== 'string' || (schema.enum && !schema.enum.includes(value))) throw new Error('无效字段 ' + field);
            return;
        case 'integer':
            if (!Number.isSafeInteger(value)) throw new Error('无效字段 ' + field);
            return;
        case 'array':
            if (!Array.isArray(value) || value.length > 100) throw new Error('无效数组 ' + field);
            for (const entry of value) validateAuditValue(schema.items, entry, field + '[]');
            return;
        case 'object': {
            const record = auditObject(value);
            if (Object.keys(record).length !== schema.required.length) throw new Error('字段不完整或越界 ' + field);
            for (const name of schema.required) {
                if (!Object.hasOwn(record, name)) throw new Error('缺少字段 ' + field + '.' + name);
                validateAuditValue(schema.properties[name]!, record[name], field + '.' + name);
            }
        }
    }
}

export interface AuditExecution {
    executor: AuditExecutor;
    location: string;
    prompt: string;
    schema: Schema;
    timeoutMs: number;
    signal: AbortSignal;
}

export type ExecuteAuditStage = (input: AuditExecution) => Promise<unknown>;

export class AuditStopUnknown extends Error {}

const MAX_OUTPUT = 1024 * 1024;

export function auditCliDiagnostic(output: string): string {
    if (/sandbox|沙箱/i.test(output) && /denied|failed|requires|blocked|error|拒绝|失败|阻止/i.test(output)) return '执行器报告沙箱错误';
    if (/EACCES|EPERM|permission denied|access is denied|operation not permitted|权限不足|拒绝访问/i.test(output)) return '执行器报告权限不足';
    if (/ENOENT|command not found|找不到命令/i.test(output)) return '找不到执行命令或所需文件';
    if (/unauthorized|not logged in|invalid api key|authentication failed/i.test(output)) return '执行器报告认证失败';
    return '';
}

export const executeAuditCli: ExecuteAuditStage = async ({ executor, location, prompt, schema, timeoutMs, signal }) => {
    const resultPath = path.join(location, 'result.json');
    const schemaPath = path.join(location, 'schema.json');
    const schemaText = JSON.stringify(schema);
    await writeFile(schemaPath, schemaText, { flag: 'wx' });
    const codex = executor === 'codex';
    const exe = codex
        ? process.env['DSH_AUDIT_CODEX'] || (process.platform === 'win32' ? 'codex.exe' : 'codex')
        : process.env['DSH_AUDIT_CLAUDE'] || (process.platform === 'win32' ? 'claude.exe' : 'claude');
    const args = codex ? [
        '--ask-for-approval', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--output-schema', schemaPath, '--output-last-message', resultPath,
        '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
        '-c', 'features.code_mode=false', '-c', 'features.apply_patch_freeform=false',
        '-c', 'features.multi_agent=false', '-c', 'features.memory_tool=false',
        '-c', 'features.js_repl=false', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '-',
    ] : [
        '--print', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', '',
        '--output-format', 'json', '--json-schema', schemaText,
    ];
    const result = await runProcess(exe, args, {
        cwd: location, timeoutMs, signal, input: prompt, killTreeOnExit: true, maxBytes: MAX_OUTPUT,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' },
    });
    if (result.timedOut || result.aborted) throw new AuditStopUnknown(executor + (result.timedOut ? ' 执行器超时' : ' 执行器已取消') + '，需确认子进程已经停止');
    const diagnostic = auditCliDiagnostic([result.error, result.stderr, result.stdout].filter(Boolean).join('\n'));
    if (result.error) throw new Error(executor + ' 无法启动' + (diagnostic ? '：' + diagnostic : ''));
    if (result.code !== 0) throw new Error(executor + ' 阶段执行失败（退出码 ' + String(result.code) + '）' + (diagnostic ? '：' + diagnostic : ''));
    if (Buffer.byteLength(result.stdout) >= MAX_OUTPUT) throw new Error(executor + ' 阶段输出过长');
    let value: unknown;
    if (codex) {
        for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean)) {
            const event = auditObject(JSON.parse(line));
            if (event['item']) {
                const item = auditObject(event['item']);
                if (!['agent_message', 'reasoning', 'todo_list', 'error'].includes(String(item['type']))) {
                    throw new Error('Codex 阶段出现未授权的工具事件：' + String(item['type']).slice(0, 100));
                }
            }
        }
        const output = await readFile(resultPath, 'utf8');
        if (Buffer.byteLength(output) >= MAX_OUTPUT) throw new Error('Codex 阶段结果过长');
        value = JSON.parse(output);
    } else {
        const response = auditObject(JSON.parse(result.stdout));
        if (response['is_error'] === true || response['subtype'] !== 'success') throw new Error('Claude Code 未返回成功结果');
        value = response['structured_output'];
    }
    validateAuditValue(schema, value);
    return value;
};
