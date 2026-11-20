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
  aborted?: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  input?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  maxBytes?: number;
  /** 门禁和执行器可能留下后台进程，按需清理以免 VCS 短命令承担 taskkill 的开销。 */
  killTreeOnExit?: boolean;
  /** 取消会触发进程树清理，命令在清理尝试结束后返回。 */
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发送终止信号后子进程可能仍未退出，因此短时探测进程组是否消失。 */
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
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { }
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
        // 独立的 POSIX 进程组可在取消时一次停止所有后代进程。
        detached: process.platform !== 'win32',
        env: options.inheritEnv === false ? options.env ?? {} : { ...process.env, ...options.env },
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

    const onAbort = (): void => {
      aborted = true;
      killPromise = Promise.all([killPromise, killTree(child.pid)]).then(() => undefined);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 即使主进程正常退出，POSIX 同组子进程也可能仍在运行。
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

/** 用临时脚本执行原始命令，避免传参时再次解释引号和 shell 元字符。 */
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
