import { performance } from 'node:perf_hooks';
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

export type GateCheckExecutionResult = GateCheckResult & {
  /** 仅在明确无法确认后代进程树已完全退出时置 false，供批准编排进入 RECOVERY_REQUIRED。 */
  processTreeStopped?: boolean;
};

/** 获批修复阶段顺序执行所选方案的全部 gate_checks，每条独立超时并等待后代进程树退出。 */
export async function runGateChecks(commands: string[], options: GateOptions): Promise<GateCheckExecutionResult[]> {
  if (commands.length === 0) return [];
  const results: GateCheckExecutionResult[] = [];
  for (const command of commands) {
    options.log?.(`[门禁] 执行：${command}`);
    const startedAt = performance.now();
    const result = await (options.run ?? runShell)(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onLine: (line, stream) => {
        options.onLine?.(line, stream, command);
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const treeStopped = result.processTreeStopped !== false;
    const passed = result.code === 0 && !result.timedOut && !result.aborted && !result.error && treeStopped;
    results.push({
      command,
      exitCode: result.timedOut ? null : result.code,
      passed,
      timedOut: result.timedOut,
      durationMs,
      outputTail: tailLines([result.stdout, result.stderr, ...(!treeStopped ? ['[门禁进程树未确认完全退出]'] : [])].filter(Boolean).join('\n'), 120),
      ...(!treeStopped ? { processTreeStopped: false } : {}),
    });
    options.log?.(`[门禁] ${passed ? '通过' : '失败'}（exit=${String(result.code)}，${String(durationMs)}ms）：${command}`);
    if (result.aborted || !treeStopped) break;
  }
  return results;
}
