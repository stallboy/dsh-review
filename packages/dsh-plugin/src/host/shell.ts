import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted?: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  stdinError?: string;
  processTreeStopped?: boolean;
}

export interface ProcessBufferResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted?: boolean;
  stdout: Buffer;
  stderr: string;
  overflowed?: boolean;
  error?: string;
  processTreeStopped?: boolean;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  input?: string | { initial: string; reply: (line: string) => Promise<string> | undefined };
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  onTimeout?: () => void;
  maxBytes?: number;
  /** 为 false 时仅向 onLine 流式推送，不累积 stdout 字符串，避免长事件流触发上限截断。 */
  captureStdout?: boolean;
  /** 门禁和执行器可能留下后台进程，按需清理以免 VCS 短命令承担 taskkill 的开销。 */
  killTreeOnExit?: boolean;
  /** 取消会触发进程树清理，命令在清理尝试结束后返回。 */
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发送终止信号后子进程可能仍未退出，因此短时探测进程组是否消失。 */
async function waitProcessGroupGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    await delay(50);
  }
  return false;
}

function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function killProcessTree(pid: number | undefined, _cwd?: string): Promise<boolean> {
  return killTree(pid);
}

function killTree(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return Promise.resolve(true);
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', (code) => resolve(code === 0 || isPidGone(pid)));
      killer.on('error', () => resolve(isPidGone(pid)));
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { }
  }
  return waitProcessGroupGone(pid);
}

/** 在 Windows 非 Job 路径下解析 PATH 中的 .cmd/.bat，改由 cmd.exe 包装执行以兼容 Node 24。 */
function resolveSpawnTarget(exe: string, args: string[], cwd: string): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: exe, args };
  const hasSep = exe.includes('/') || exe.includes('\\');
  const hasExt = path.extname(exe).length > 0;
  let resolved: string | null = null;
  if (hasSep) {
    if (existsSync(exe)) resolved = exe;
    else if (!hasExt) {
      const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
      for (const ext of exts) {
        if (existsSync(`${exe}${ext}`)) { resolved = `${exe}${ext}`; break; }
      }
    }
  } else {
    const exts = hasExt ? [''] : (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const dir of [cwd, ...(process.env['PATH'] ?? '').split(delimiter)]) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = join(dir, `${exe}${ext}`);
        if (existsSync(candidate)) { resolved = candidate; break; }
      }
      if (resolved) break;
    }
  }
  if (resolved && /\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe';
    return { command: comspec, args: ['/d', '/c', 'call', resolved, ...args] };
  }
  return { command: exe, args };
}

export function runProcess(exe: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
      return;
    }
    let child;
    const job = process.platform === 'win32' && options.killTreeOnExit === true;
    const target = job ? null : resolveSpawnTarget(exe, args, options.cwd);
    let jobResult = '';
    try {
      child = spawn(job ? process.execPath : target!.command, job ? [fileURLToPath(new URL('./win32-job-runner.js', import.meta.url)),
        JSON.stringify({ command: exe, args, cwd: options.cwd })] : target!.args, {
        cwd: options.cwd,
        windowsHide: true,
        // 独立的 POSIX 进程组可在取消时一次停止所有后代进程。
        detached: process.platform !== 'win32',
        env: options.inheritEnv === false ? options.env ?? {} : { ...process.env, ...options.env },
        stdio: job ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
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
    const captureStdout = options.captureStdout !== false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingStdout = '';
    let pendingStderr = '';
    let timedOut = false;
    let aborted = false;
    let stdinError: string | undefined;
    let termination: Promise<boolean> | undefined;
    let settled = false;
    const terminate = () => (termination ??= (async () => {
      if (!job) return killTree(child.pid);
      if (child.connected) child.send?.({ stop: true }, () => {});
      const deadline = Date.now() + 12_000;
      while (!jobResult && Date.now() < deadline && child.exitCode === null) await delay(25);
      if (!jobResult) await killTree(child.pid);
      try { return (JSON.parse(jobResult) as { stopped?: boolean }).stopped === true; } catch { return false; }
    })());
    if (job) child.on('message', value => { jobResult = JSON.stringify(value); });
    const exchange = typeof options.input === 'object' ? options.input : undefined;
    let replied = false;

    const emit = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (!options.onLine && (!exchange || stream !== 'stdout')) return;
      const buffer = stream === 'stdout' ? pendingStdout + chunk : pendingStderr + chunk;
      const lines = buffer.split(/\r?\n/);
      let rest = lines.pop() ?? '';
      if (rest.length > MAX_LINE_BUFFER_CHARS) rest = rest.slice(-MAX_LINE_BUFFER_CHARS);
      if (stream === 'stdout') pendingStdout = rest;
      else pendingStderr = rest;
      for (const line of lines) {
        options.onLine?.(line, stream);
        if (stream !== 'stdout' || replied) continue;
        const response = exchange?.reply(line);
        if (!response) continue;
        replied = true;
        void response.then((value) => {
          if (!settled) child.stdin?.end(value);
        }, () => {
          if (!settled) child.stdin?.end();
        });
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (captureStdout && stdoutBytes < maxBytes) {
        stdout += chunk;
        stdoutBytes += Buffer.byteLength(chunk);
      }
      emit('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderrBytes < maxBytes) {
        stderr += chunk;
        stderrBytes += Buffer.byteLength(chunk);
      }
      emit('stderr', chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.();
      void terminate();
    }, options.timeoutMs ?? 120_000);
    timer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      clearTimeout(timer);
      void terminate();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 即使主进程正常退出，POSIX 同组子进程也可能仍在运行。
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const shouldKill = timedOut || aborted || process.platform !== 'win32' || options.killTreeOnExit === true;
      const cleanup = shouldKill ? terminate() : Promise.resolve(undefined);
      void cleanup.then((processTreeStopped) => {
        if (pendingStdout) options.onLine?.(pendingStdout, 'stdout');
        if (pendingStderr) options.onLine?.(pendingStderr, 'stderr');
        let runnerError: string | undefined;
        if (job) {
          try { runnerError = (JSON.parse(jobResult) as { error?: string }).error; }
          catch { runnerError = 'Windows 进程 Job 未返回可核验的停止结果'; }
        }
        resolve({ code, signal, timedOut, aborted, stdout, stderr, ...((error ?? runnerError) ? { error: error ?? runnerError } : {}),
          ...(stdinError ? { stdinError } : {}), ...(timedOut || aborted || options.killTreeOnExit ? { processTreeStopped } : {}) });
      });
    };

    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      stdinError = error.code ?? 'UNKNOWN';
    });
    if (exchange) child.stdin?.write(exchange.initial);
    else child.stdin?.end(typeof options.input === 'string' ? options.input : undefined);
  });
}

/** 二进制精确字节受控子进程：统一进程组清理、超时、有界 stderr 与超限早停。 */
export function runProcessBuffer(
  exe: string,
  args: string[],
  options: Omit<ProcessOptions, 'onLine' | 'captureStdout' | 'input'>,
): Promise<ProcessBufferResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut: false, aborted: true, stdout: Buffer.alloc(0), stderr: '' });
      return;
    }
    const target = resolveSpawnTarget(exe, args, options.cwd);
    let child;
    try {
      child = spawn(target.command, target.args, {
        cwd: options.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: options.inheritEnv === false ? options.env ?? {} : { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout: Buffer.alloc(0),
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let termination: Promise<boolean> | undefined;

    const terminate = () => (termination ??= killTree(child.pid));

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) {
        stdoutChunks.push(chunk);
      } else if (!overflowed) {
        overflowed = true;
        void terminate();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.();
      void terminate();
    }, options.timeoutMs ?? 180_000);
    timer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      clearTimeout(timer);
      void terminate();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const shouldKill = timedOut || aborted || overflowed || process.platform !== 'win32' || options.killTreeOnExit === true;
      const cleanup = shouldKill ? terminate() : Promise.resolve(undefined);
      void cleanup.then((processTreeStopped) => {
        resolve({
          code,
          signal,
          timedOut,
          aborted,
          stdout: overflowed ? Buffer.alloc(0) : Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          ...(overflowed ? { overflowed: true } : {}),
          ...(error ? { error } : {}),
          ...(timedOut || aborted || options.killTreeOnExit ? { processTreeStopped } : {}),
        });
      });
    };

    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
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
      return await runProcess(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/c', 'call', file], { ...options, killTreeOnExit: true });
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
