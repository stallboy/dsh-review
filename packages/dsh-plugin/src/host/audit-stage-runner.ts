/**
 * 分阶段审查执行器与多执行器降级策略（SPEC §5.4）：
 * - 支持外部专业执行器（codex / claude）优先调用以增强多模型分工；
 * - 遵循「软引导 + Host 强还原」策略，不在子阶段施加硬写拦截沙箱；
 * - 外部执行器不可用、未配置、鉴权失败或启动失败时，优雅降级为本 Harness 独立子代理（dsh-subagent）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuditStage } from './audit-prompts.js';
import { DshEventStreamParser, parseJsonPayload } from './dsh-stream.js';
import { commandExists, runProcess } from './shell.js';

export type AuditExecutor = 'codex' | 'claude' | 'claude-code' | 'dsh-subagent';

export interface ExecutorProbeStatus {
  name: string;
  status: 'available' | 'unavailable' | 'degraded';
  reason?: string;
}

export interface StageRunRequest {
  stage: AuditStage;
  runner: AuditExecutor;
  cwd: string;
  artifactDir?: string;
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
  dshCommand?: string;
  onLog?: (line: string) => void;
}

export interface StageRunOutcome {
  ok: boolean;
  output?: unknown;
  executorUsed?: AuditExecutor;
  degradedFrom?: AuditExecutor;
  diagnostic?: string;
  reason?: 'auth' | 'unavailable' | 'timeout' | 'aborted' | 'invalid_output' | 'failed';
}

export type ExecuteAuditStage = (request: StageRunRequest) => Promise<StageRunOutcome>;

export class AuditStopUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditStopUnknown';
  }
}

export function normalizeExecutorName(raw: string): AuditExecutor {
  const lower = raw.trim().toLowerCase();
  if (lower === 'codex') return 'codex';
  if (lower === 'claude' || lower === 'claude-code') return 'claude';
  return 'dsh-subagent';
}

/** 探测已配置的外部专业执行器与本 Harness 子代理的实时可用状态。 */
export function probeStageExecutors(configured: readonly string[], dshCommand = ''): {
  executors: ExecutorProbeStatus[];
  availableRunners: AuditExecutor[];
} {
  const executors: ExecutorProbeStatus[] = [];
  const availableRunners: AuditExecutor[] = [];
  const seen = new Set<string>();

  for (const raw of configured) {
    const name = normalizeExecutorName(raw);
    if (name === 'dsh-subagent' || seen.has(name)) continue;
    seen.add(name);
    const bin = name === 'codex' ? 'codex' : 'claude';
    if (commandExists(bin)) {
      executors.push({ name, status: 'available' });
      availableRunners.push(name);
    } else {
      executors.push({ name, status: 'unavailable', reason: `未检测到 ${bin} 可执行文件，将自动降级为本 Harness 独立子代理` });
    }
  }

  const dshBin = dshCommand.trim().split(/\s+/)[0] || 'dsh';
  if (commandExists(dshBin)) {
    executors.push({ name: 'dsh-subagent', status: 'available' });
    availableRunners.push('dsh-subagent');
  } else {
    executors.push({ name: 'dsh-subagent', status: 'degraded', reason: `未在 PATH 检测到 ${dshBin}（若在 DSH 宿主内运行仍由宿主提供子代理能力）` });
    availableRunners.push('dsh-subagent');
  }

  return { executors, availableRunners };
}

async function runExternalExecutor(
  executor: 'codex' | 'claude',
  request: StageRunRequest,
): Promise<StageRunOutcome> {
  const bin = executor === 'codex' ? 'codex' : 'claude';
  if (!commandExists(bin)) {
    return { ok: false, reason: 'unavailable', diagnostic: `未安装外部执行器 ${bin}` };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), `dcr-stage-${executor}-`));
  try {
    const schemaPath = path.join(tempDir, 'schema.json');
    const outputPath = path.join(tempDir, 'output.json');
    await writeFile(schemaPath, JSON.stringify(request.schema, null, 2), 'utf8');

    const args = executor === 'codex'
      ? ['exec', '--output-schema', schemaPath, '-o', outputPath, '-']
      : ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(request.schema), '-'];

    const streamParser = new DshEventStreamParser();
    const stdoutTail: string[] = [];
    const result = await runProcess(bin, args, {
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      maxBytes: 256 * 1024,
      captureStdout: false,
      killTreeOnExit: true,
      onLine: (line, stream) => {
        if (stream === 'stderr') {
          request.onLog?.(`[${executor}:stderr] ${line.slice(0, 400)}`);
          return;
        }
        if (stdoutTail.length >= 200) stdoutTail.shift();
        stdoutTail.push(line);
        if (executor === 'claude') streamParser.feedLine(line);
        request.onLog?.(`[${executor}] ${line.slice(0, 400)}`);
      },
    });

    if (result.processTreeStopped === false) {
      throw new AuditStopUnknown(`${executor} 阶段退出后无法确认后代进程树已停止`);
    }
    if (result.aborted) return { ok: false, reason: 'aborted', diagnostic: `${executor} 阶段已取消` };
    if (result.timedOut) return { ok: false, reason: 'timeout', diagnostic: `${executor} 阶段超时` };

    const combined = `${stdoutTail.join('\n')}\n${result.stderr}`;
    if (result.code !== 0) {
      if (/unauthorized|auth|api[_ -]?key|login|token|credential|401|403/i.test(combined)) {
        return { ok: false, reason: 'auth', diagnostic: `${executor} 鉴权不可用：${combined.trim().slice(0, 300)}` };
      }
      return { ok: false, reason: 'failed', diagnostic: `${executor} 退出码 ${String(result.code)}：${combined.trim().slice(0, 300)}` };
    }

    let parsed: unknown;
    if (executor === 'codex') {
      const fromFile = await readFile(outputPath, 'utf8').catch(() => '');
      parsed = parseJsonPayload(fromFile) ?? parseJsonPayload(stdoutTail.join('\n'));
    } else {
      parsed = streamParser.extractJsonOutput();
    }
    if (parsed === undefined) {
      return { ok: false, reason: 'invalid_output', diagnostic: `${executor} 未输出合法结构化 JSON` };
    }
    return { ok: true, output: parsed, executorUsed: executor };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runNativeHarnessSubagent(request: StageRunRequest): Promise<StageRunOutcome> {
  const tokens = (request.dshCommand?.trim() || 'dsh').split(/\s+/).filter(Boolean);
  const bin = tokens[0] ?? 'dsh';
  if (!commandExists(bin)) {
    return { ok: false, reason: 'unavailable', diagnostic: `未检测到本 Harness 子代理入口：${bin}` };
  }
  const promptWithSchema = [
    request.prompt,
    '',
    '## 输出 JSON Schema（必须严格满足并输出合法 JSON）',
    '```json',
    JSON.stringify(request.schema, null, 2),
    '```',
  ].join('\n');

  const streamParser = new DshEventStreamParser();
  const stdoutTail: string[] = [];
  const args = [...tokens.slice(1), '--profile', 'headless', '--json', '-'];
  const result = await runProcess(bin, args, {
    cwd: request.cwd,
    input: promptWithSchema,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    maxBytes: 256 * 1024,
    captureStdout: false,
    killTreeOnExit: true,
    onLine: (line, stream) => {
      if (stream === 'stderr') {
        request.onLog?.(`[dsh-subagent:stderr] ${line.slice(0, 400)}`);
        return;
      }
      if (stdoutTail.length >= 200) stdoutTail.shift();
      stdoutTail.push(line);
      streamParser.feedLine(line);
      request.onLog?.(`[dsh-subagent] ${line.slice(0, 400)}`);
    },
  });

  if (result.processTreeStopped === false) {
    throw new AuditStopUnknown('dsh-subagent 阶段退出后无法确认后代进程树已停止');
  }
  if (result.aborted) return { ok: false, reason: 'aborted', diagnostic: '子代理阶段已取消' };
  if (result.timedOut) return { ok: false, reason: 'timeout', diagnostic: '子代理阶段超时' };
  if (result.code !== 0) {
    return {
      ok: false,
      reason: 'failed',
      diagnostic: `dsh-subagent 退出码 ${String(result.code)}：${(result.stderr || stdoutTail.join('\n')).trim().slice(0, 300)}`,
    };
  }
  const parsed = streamParser.extractJsonOutput();
  if (parsed === undefined) {
    return { ok: false, reason: 'invalid_output', diagnostic: 'dsh-subagent 未输出合法结构化 JSON' };
  }
  return { ok: true, output: parsed, executorUsed: 'dsh-subagent' };
}

/**
 * 默认分阶段执行器：
 * 优先调用请求指定的外部专业执行器（codex / claude）；
 * 若不可用、鉴权失败或拉起失败，自动优雅降级至本 Harness 独立子代理（dsh-subagent）。
 */
export async function executeAuditCli(request: StageRunRequest): Promise<StageRunOutcome> {
  const normalized = normalizeExecutorName(request.runner);
  if (normalized === 'dsh-subagent') {
    return runNativeHarnessSubagent(request);
  }

  const externalKind: 'codex' | 'claude' = normalized === 'claude-code' ? 'claude' : normalized;
  const primary = await runExternalExecutor(externalKind, request);
  if (primary.ok || primary.reason === 'aborted' || primary.reason === 'timeout') {
    return primary;
  }

  // 外部专业执行器不可用 / 鉴权失败 / 异常时，优雅降级至本 Harness 独立子代理。
  request.onLog?.(`[降级] 外部执行器 ${normalized} 不可用（${primary.diagnostic ?? primary.reason ?? 'unknown'}），降级使用本 Harness 独立子代理`);
  const fallback = await runNativeHarnessSubagent({ ...request, runner: 'dsh-subagent' });
  return {
    ...fallback,
    degradedFrom: normalized,
    diagnostic: fallback.ok
      ? `由 ${normalized} 自动降级至 dsh-subagent 完成（原原因：${primary.diagnostic ?? primary.reason ?? 'unavailable'}）`
      : `外部执行器 ${normalized} 失败（${primary.diagnostic ?? ''}），且降级 dsh-subagent 失败（${fallback.diagnostic ?? ''}）`,
  };
}
