import path from 'node:path';
import { access } from 'node:fs/promises';
import { loadWin32ProcessBindings, spawnCurrentTokenJobProcess, pollProcessExit, isJobEmpty,
    terminateJob, closeHandleChecked, type SpawnedJobProcess } from '@deepseek-ai/dsh-win32-process';

const input = JSON.parse(process.argv[2] ?? '{}') as { command: string; args: string[]; cwd: string };
const api = loadWin32ProcessBindings();
let child: SpawnedJobProcess | undefined;
let stopping = false;
const stop = (): void => {
    stopping = true;
    if (child) terminateJob(api, child.job, 143);
};
process.on('message', stop);
process.on('disconnect', stop);
const report = (value: object) => new Promise<void>((resolve, reject) => {
    if (!process.send) { reject(new Error('Windows Job 缺少私有 IPC')); return; }
    process.send(value, error => error ? reject(error) : resolve());
});
const delay = () => new Promise(resolve => setTimeout(resolve, 25));
try {
    const extensions = path.extname(input.command) ? [''] : (process.env['PATHEXT'] ?? '.EXE;.COM').split(';');
    const names = path.isAbsolute(input.command) ? [input.command]
        : [input.cwd, ...(process.env['PATH'] ?? '').split(path.delimiter)].flatMap(directory => extensions.map(extension => path.join(directory, input.command + extension)));
    let executable: string | undefined;
    for (const name of names) {
        try { await access(name); executable = name; break; } catch {}
    }
    if (!executable) throw new Error('无法找到进程执行文件：' + input.command);
    const isBatch = /\.(?:cmd|bat)$/i.test(executable);
    let spawnApp = executable;
    let spawnCmd = input.command;
    let spawnArgs = input.args;
    if (isBatch) {
        const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe';
        spawnApp = comspec;
        spawnCmd = comspec;
        // 通过 cmd.exe /d /c call 包装 .cmd/.bat，避免 CreateProcessW 触发 ERROR_BAD_EXE_FORMAT 且保留引号边界。
        spawnArgs = ['/d', '/c', 'call', executable, ...input.args];
    }
    child = spawnCurrentTokenJobProcess(api, { applicationName: spawnApp, command: spawnCmd, args: spawnArgs,
        cwd: input.cwd, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
            && !['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(entry[0]))),
        stdio: { stdin: 0, stdout: 1, stderr: 2 } });
    if (stopping) stop();
    let code: number | undefined;
    while ((code = pollProcessExit(api, child.process)) === undefined) await delay();
    if (!isJobEmpty(api, child.job)) terminateJob(api, child.job, 143);
    const deadline = Date.now() + 10_000;
    while (!isJobEmpty(api, child.job) && Date.now() < deadline) await delay();
    const stopped = isJobEmpty(api, child.job);
    await report({ code, stopped });
    process.exitCode = stopped ? code : 1;
} catch (error) {
    if (child) {
        try { terminateJob(api, child.job, 143); } catch {}
    }
    await report({ error: String(error), stopped: child === undefined });
    process.exitCode = 1;
} finally {
    process.removeListener('message', stop);
    process.removeListener('disconnect', stop);
    if (process.connected) process.disconnect();
    if (child) {
        closeHandleChecked(api, child.process, '审查进程');
        closeHandleChecked(api, child.job, '审查进程 Job');
    }
}
