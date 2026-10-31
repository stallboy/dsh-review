import process from 'node:process';
import { runShell, tailLines } from './shell.js';
import type { GateCheckResult, ValidationReport } from './types.js';

export interface GateOptions {
  cwd: string;
  baseRevision: string;
  timeoutMs: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr', command: string) => void;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * Run the candidate's `gate_checks` verbatim in the repository working tree.
 * Gate checks are the merge contract: all must pass before an approval may commit.
 */
export async function runGateChecks(commands: string[], options: GateOptions): Promise<ValidationReport> {
  const results: GateCheckResult[] = [];
  for (const command of commands) {
    const startedAt = Date.now();
    const result = await runShell(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onLine: (line, stream) => options.onLine?.(line, stream, command),
    });
    const durationMs = Date.now() - startedAt;
    const passed = result.code === 0 && !result.timedOut && !result.error;
    results.push({
      command,
      exitCode: result.code,
      passed,
      timedOut: result.timedOut,
      durationMs,
      outputTail: tailLines([result.stdout, result.stderr].filter(Boolean).join('\n'), 120),
    });
  }

  const environmentSummary = [
    `工作目录: ${options.cwd}`,
    `基线: ${options.baseRevision}`,
    `平台: ${process.platform} / node ${process.version}`,
    `执行时间: ${new Date().toISOString()}`,
  ].join(' · ');

  const allPassed = results.length > 0 && results.every((result) => result.passed);
  const lines: string[] = [
    '<!-- ai-review:validation -->',
    '### 门禁执行结果',
    '',
    `- ${escapeCell(environmentSummary)}`,
    '',
    '| 结果 | 命令 | 退出码 | 耗时 |',
    '| --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const state = result.passed ? '通过' : result.timedOut ? '超时' : '失败';
    lines.push(
      `| ${state} | \`${escapeCell(result.command)}\` | ${String(result.exitCode ?? 'null')} | ${formatDuration(result.durationMs)} |`,
    );
  }
  for (const result of results) {
    if (result.passed) continue;
    lines.push('', `**失败命令**: \`${result.command}\``, '', '```text', result.outputTail.trim(), '```');
  }
  lines.push('<!-- /ai-review:validation -->');
  const formattedEvidenceMarkdown = lines.join('\n');

  return {
    allPassed,
    baseRevision: options.baseRevision,
    environmentSummary,
    results,
    formattedEvidenceMarkdown,
  };
}
