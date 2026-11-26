import { runShell, tailLines } from './shell.js';
import type { GateCheckResult } from './types.js';

export interface GateOptions {
  cwd: string;
  timeoutMs: number;
  log?: (line: string) => void;
  onLine?: (line: string, stream: 'stdout' | 'stderr', command: string) => void;
  signal?: AbortSignal;
  run?: typeof runShell;
}

/** SPEC §5.3：仅在获批修复阶段顺序执行所选方案的全部 gate_checks，每条独立超时并清理进程树。 */
export async function runGateChecks(commands: string[], options: GateOptions): Promise<GateCheckResult[]> {
  if (commands.length === 0) return [];
  const results: GateCheckResult[] = [];
  for (const command of commands) {
    options.log?.(`[门禁] 执行：${command}`);
    const startedAt = Date.now();
    const result = await (options.run ?? runShell)(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onLine: (line, stream) => {
        options.onLine?.(line, stream, command);
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const durationMs = Date.now() - startedAt;
    const passed = result.code === 0 && !result.timedOut && !result.aborted && !result.error;
    results.push({
      command,
      exitCode: result.timedOut ? null : result.code,
      passed,
      timedOut: result.timedOut,
      durationMs,
      outputTail: tailLines([result.stdout, result.stderr].filter(Boolean).join('\n'), 120),
    });
    options.log?.(`[门禁] ${passed ? '通过' : '失败'}（exit=${String(result.code)}，${String(durationMs)}ms）：${command}`);
    if (result.aborted) break;
  }
  return results;
}
