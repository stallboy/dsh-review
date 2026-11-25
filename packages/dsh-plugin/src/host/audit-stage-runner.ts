import { addAbortListener } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { dshHome } from './settings.js';
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
    logProcessExit?: (line: string) => void;
    onTimeout?: () => void;
    onProcessTreeStopped?: (stopped: boolean) => void;
}

export type ExecuteAuditStage = (input: AuditExecution) => Promise<unknown>;

export class AuditStopUnknown extends Error {
    constructor(message: string, readonly processTreeStopped = false) { super(message); }
}

export class AuditStageTimedOut extends AuditStopUnknown {
    constructor(executor: AuditExecutor, processTreeStopped: boolean) {
        super(executor + ' 执行器超时', processTreeStopped);
    }
}

export class AuditExecutorAuthenticationError extends Error {
    constructor(executor: AuditExecutor, code?: number | null) {
        super(executor + ' 执行器报告认证失败' + (code == null ? '' : '（退出码 ' + String(code) + '）'));
    }
}

const MAX_OUTPUT = 1024 * 1024;

const AUTHENTICATION_FAILURE = /unauthorized|not logged in|invalid api key|authentication failed/i;

const AUTHENTICATION_MESSAGE = /^(?:Error:\s*)?(?:Not logged in\b|Unauthorized\b|Invalid API key\b|Authentication failed\b|(?:unexpected status |API Error:\s*)?401\b)/i;

function diagnosticObject(text: string): Record<string, unknown> | undefined {
    try { return auditObject(JSON.parse(text)); } catch { return undefined; }
}

function isAuthenticationMessage(message: unknown): boolean {
    return typeof message === 'string' && AUTHENTICATION_MESSAGE.test(message.trim());
}

export function isAuditAuthenticationFailure(executor: AuditExecutor, stdout: string, stderr: string): boolean {
    if (stderr.split(/\r?\n/).some(isAuthenticationMessage)) return true;
    if (executor === 'claude-code') {
        const result = diagnosticObject(stdout);
        return result?.['type'] === 'result' && result['is_error'] === true
            && (result['api_error_status'] === 401 || isAuthenticationMessage(result['result']));
    }
    return stdout.split(/\r?\n/).some(line => {
        const event = diagnosticObject(line);
        if (event?.['type'] === 'error') return isAuthenticationMessage(event['message']);
        if (event?.['type'] === 'turn.failed' && typeof event['error'] === 'object' && event['error'] !== null) {
            return isAuthenticationMessage((event['error'] as Record<string, unknown>)['message']);
        }
        return false;
    });
}

export function auditCliDiagnostic(output: string, includeAuthentication = true): string {
    if (/sandbox|沙箱/i.test(output) && /denied|failed|requires|blocked|error|拒绝|失败|阻止/i.test(output)) return '执行器报告沙箱错误';
    if (/EACCES|EPERM|permission denied|access is denied|operation not permitted|权限不足|拒绝访问/i.test(output)) return '执行器报告权限不足';
    if (/ENOENT|command not found|找不到命令/i.test(output)) return '找不到执行命令或所需文件';
    if (includeAuthentication && AUTHENTICATION_FAILURE.test(output)) return '执行器报告认证失败';
    return '';
}

const CLAUDE_AUTH_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
const CLAUDE_CONNECTION_ENV = [...CLAUDE_AUTH_ENV, 'ANTHROPIC_BASE_URL'] as const;
const CLAUDE_LAUNCH_OVERRIDES = [...CLAUDE_CONNECTION_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'] as const;
const CLAUDE_SETTINGS_ENV = [...CLAUDE_CONNECTION_ENV, 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'] as const;

async function readExecutorSettings(file: string, diagnostic: string, signal: AbortSignal, optional = false): Promise<unknown> {
    let listener: ReturnType<typeof addAbortListener> | undefined;
    try {
        signal.throwIfAborted();
        const aborted = new Promise<never>((_, reject) => {
            listener = addAbortListener(signal, () => reject(signal.reason));
        });
        const contents = await Promise.race([readFile(file, { encoding: 'utf8', signal }), aborted]);
        signal.throwIfAborted();
        return JSON.parse(contents);
    } catch (error) {
        signal.throwIfAborted();
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error(diagnostic);
    } finally {
        listener?.[Symbol.dispose]();
    }
}

export async function resolveAuditCliLaunch(executor: AuditExecutor, signal = new AbortController().signal):
    Promise<{ exe: string; env: Record<string, string> }> {
    signal.throwIfAborted();
    const codex = executor === 'codex';
    const override = process.env[codex ? 'DSH_AUDIT_CODEX' : 'DSH_AUDIT_CLAUDE'];
    const defaultExe = (codex ? 'codex' : 'claude') + (process.platform === 'win32' ? '.exe' : '');
    if (codex ? override : CLAUDE_LAUNCH_OVERRIDES.some(key => process.env[key])) {
        return { exe: override || defaultExe, env: {} };
    }

    const config = auditObject(await readExecutorSettings(path.join(dshHome(), 'dsh-code-review', 'audit-executors.json'),
        '无法读取审查执行器启动配置', signal, true));
    const key = codex ? 'codexPath' : 'claudeSettingsPath';
    const configuredPath = config[key];
    if (configuredPath === undefined) return { exe: override || defaultExe, env: {} };
    if (typeof configuredPath !== 'string' || !path.isAbsolute(configuredPath)) throw new Error(key + ' 必须是绝对路径');
    if (codex) return { exe: configuredPath, env: {} };

    const settings = auditObject(await readExecutorSettings(configuredPath, '无法读取配置的 Claude Code 用户设置', signal));
    const configuredEnv = auditObject(settings['env']);
    if (!CLAUDE_AUTH_ENV.some(name => typeof configuredEnv[name] === 'string' && configuredEnv[name].trim())) {
        throw new Error('配置的 Claude Code 用户设置缺少认证环境变量');
    }
    const env: Record<string, string> = {};
    for (const name of CLAUDE_SETTINGS_ENV) {
        const value = configuredEnv[name];
        if (!process.env[name] && typeof value === 'string' && value.trim()) env[name] = value;
    }
    return { exe: override || defaultExe, env };
}

export const executeAuditCli: ExecuteAuditStage = async ({ executor, location, prompt, schema, timeoutMs, signal, logProcessExit, onTimeout, onProcessTreeStopped }) => {
    const resultPath = path.join(location, 'result.json');
    const schemaPath = path.join(location, 'schema.json');
    const schemaText = JSON.stringify(schema);
    await writeFile(schemaPath, schemaText, { flag: 'wx' });
    const codex = executor === 'codex';
    const now = Date.now();
    const launchDeadline = AbortSignal.timeout(timeoutMs);
    const { exe, env } = await resolveAuditCliLaunch(executor, AbortSignal.any([signal, launchDeadline])).catch(error => {
        onProcessTreeStopped?.(true);
        if (launchDeadline.aborted && !signal.aborted) throw new AuditStageTimedOut(executor, true);
        throw error;
    });
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
        cwd: location, timeoutMs: Math.max(1, timeoutMs - (Date.now() - now)), signal, input: prompt, killTreeOnExit: true, maxBytes: MAX_OUTPUT, ...(onTimeout ? { onTimeout } : {}),
        env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' },
    });
    onProcessTreeStopped?.(result.processTreeStopped === true || Boolean(result.error) && result.code === null);
    logProcessExit?.([
        '执行器进程结束', '退出码=' + String(result.code),
        ...(result.signal ? ['信号=' + result.signal] : []),
        ...(result.stdinError ? ['输入管道=' + result.stdinError] : []),
        ...(result.error ? ['启动失败'] : []),
        ...(result.timedOut ? ['超时'] : []),
        ...(result.aborted ? ['已取消'] : []),
    ].join(' '));
    if (result.timedOut) throw new AuditStageTimedOut(executor, result.processTreeStopped === true);
    if (result.aborted) throw new AuditStopUnknown(executor + ' 执行器已取消，需确认子进程已经停止', result.processTreeStopped === true);
    const diagnostic = auditCliDiagnostic([result.error, result.stderr, result.stdout].filter(Boolean).join('\n'), false);
    if (result.error) throw new Error(executor + ' 无法启动' + (diagnostic ? '：' + diagnostic : ''));
    if (result.code !== 0) {
        if (isAuditAuthenticationFailure(executor, result.stdout, result.stderr)) throw new AuditExecutorAuthenticationError(executor, result.code);
        throw new Error(executor + ' 阶段执行失败（退出码 ' + String(result.code) + '）' + (diagnostic ? '：' + diagnostic : ''));
    }
    if (result.stdinError) throw new Error(executor + ' 执行器未接收完整提示词（' + result.stdinError + '）');
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
