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
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * §7.3：终止整个进程组/进程树并等待清理完成。
 * POSIX：spawn 使用 detached 形成进程组，kill(-pid) 一次清理全部子进程；
 * Windows：taskkill /t /f 并等待其退出（不再 fire-and-forget）。
 * 目标已退出时静默成功（taskkill/kill 报 ESRCH 均视为已清理）。
 */
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
  return Promise.resolve();
}

export function runProcess(exe: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
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

    // §7.3：主进程退出后清理进程组内残留子进程。
    // POSIX：kill(-pid) 同步且廉价，正常退出后也执行；
    // Windows：taskkill 每次约 2-3 秒，仅在超时/终止路径执行，正常退出跳过（由超时机制兜底）。
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      clearTimeout(timer);
      const cleanup = process.platform === 'win32' && !timedOut
        ? killPromise
        : Promise.all([killPromise, killTree(child.pid)]).then(() => undefined);
      void cleanup.then(() => {
        if (pendingStdout) options.onLine?.(pendingStdout, 'stdout');
        if (pendingStderr) options.onLine?.(pendingStderr, 'stderr');
        resolve({ code, signal, timedOut, stdout, stderr, ...(error ? { error } : {}) });
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
      return await runProcess(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', file], options);
    }
    return await runProcess('/bin/sh', [file], options);
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
