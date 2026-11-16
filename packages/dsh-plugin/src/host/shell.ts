import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** §7.7：由 Job 取消信号终止（区别于超时）。 */
  aborted?: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  maxBytes?: number;
  /**
   * Windows 上主进程正常退出后是否也执行 taskkill /t /f 清理残留子进程。
   * 仅用于门禁/Runner 这类可能派生后台进程的 shell；VCS 命令保持默认 false，
   * 避免每条 git/svn 命令额外付出 taskkill 开销与误杀风险。
   */
  killTreeOnExit?: boolean;
  /** §7.7：Job 取消信号；触发后终止进程组并等待清理。 */
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * §7.3：终止整个进程组/进程树并等待清理完成。
 * POSIX：spawn 使用 detached 形成进程组，kill(-pid) 一次清理全部子进程；
 * Windows：taskkill /t /f 并等待其退出（不再 fire-and-forget）。
 * 目标已退出时静默成功（taskkill/kill 报 ESRCH 均视为已清理）。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §7.3：等待进程组真正消失（而不只是“发了信号”）。 */
async function waitProcessGroupGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
}

function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  }
  try {
    // 进程组整体终止；组已不存在（ESRCH）视为已清理。
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return waitProcessGroupGone(pid);
}

export function runProcess(exe: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
      return;
    }
    let child;
    try {
      child = spawn(exe, args, {
        cwd: options.cwd,
        windowsHide: true,
        // POSIX 下建立独立进程组，超时/取消可 kill(-pid) 清理全部子进程。
        detached: process.platform !== 'win32',
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingStdout = '';
    let pendingStderr = '';
    let timedOut = false;
    let aborted = false;
    let killPromise: Promise<void> = Promise.resolve();

    const emit = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (!options.onLine) return;
      const buffer = stream === 'stdout' ? pendingStdout + chunk : pendingStderr + chunk;
      const lines = buffer.split(/\r?\n/);
      const rest = lines.pop() ?? '';
      if (stream === 'stdout') pendingStdout = rest;
      else pendingStderr = rest;
      for (const line of lines) options.onLine(line, stream);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      if (stdoutBytes < maxBytes) {
        stdout += chunk;
        stdoutBytes += data.length;
      }
      emit('stdout', chunk);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      if (stderrBytes < maxBytes) {
        stderr += chunk;
        stderrBytes += data.length;
      }
      emit('stderr', chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killPromise = killTree(child.pid);
    }, options.timeoutMs ?? 120_000);
    timer.unref?.();

    // §7.7：取消信号立即终止完整进程树；close 后由 finish 等待清理完成。
    const onAbort = (): void => {
      aborted = true;
      killPromise = Promise.all([killPromise, killTree(child.pid)]).then(() => undefined);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // §7.3：主进程无论成功、失败或超时退出后，都必须终止并等待进程组内残留子进程退出。
    // Windows 的 taskkill /t /f 需要父进程仍存在；对 VCS 命令关闭正常退出清理（见 ProcessOptions）。
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const shouldKill = timedOut || aborted || process.platform !== 'win32' || options.killTreeOnExit === true;
      const cleanup = shouldKill
        ? Promise.all([killPromise, killTree(child.pid)]).then(() => undefined)
        : killPromise;
      void cleanup.then(() => {
        if (pendingStdout) options.onLine?.(pendingStdout, 'stdout');
        if (pendingStderr) options.onLine?.(pendingStderr, 'stderr');
        resolve({ code, signal, timedOut, aborted, stdout, stderr, ...(error ? { error } : {}) });
      });
    };

    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Run one shell command. Windows executes it from a temporary `.cmd` file so
 * gate commands containing quotes, `&`, or `%` survive cmd.exe's argument
 * parsing unchanged; POSIX uses a temporary `.sh` file for the same reason.
 */
export async function runShell(command: string, options: ProcessOptions): Promise<ProcessResult> {
  const isWindows = process.platform === 'win32';
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shell-'));
  const file = join(dir, isWindows ? 'run.cmd' : 'run.sh');
  const body = isWindows ? `@echo off\r\n${command}\r\n` : `#!/bin/sh\n${command}\n`;
  try {
    await writeFile(file, body, 'utf8');
    if (isWindows) {
      return await runProcess(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', file], { ...options, killTreeOnExit: true });
    }
    return await runProcess('/bin/sh', [file], { ...options, killTreeOnExit: true });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function commandExists(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (existsSync(join(dir, `${command}${extension}`))) return true;
    }
  }
  return false;
}

export function tailLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join('\n');
}
