import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-11-12 事故（见 docs/2026-11-12-writer-in-dsh-smoke-test-incident.md §7）：
// 本机启用 core.fsmonitor 时，每个临时 fixture 仓库都会驻留一个 fsmonitor 守护进程，
// 累计数百个后 `git add` 会在 IPC 上无限阻塞——四轮全量测试分别在
// contract-audit-finalize / contract-fixes 等收尾用例上"挂死"均由此产生。
// 在测试进程树内统一禁用 fsmonitor：GIT_CONFIG_* 会随 child_process 继承，
// 同时覆盖测试直调的 git 与被测插件拉起的 git 子进程；不改动任何断言。
process.env.GIT_CONFIG_COUNT ??= '1';
process.env.GIT_CONFIG_KEY_0 ??= 'core.fsmonitor';
process.env.GIT_CONFIG_VALUE_0 ??= 'false';

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

export function runCommand(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'audit-test',
      GIT_AUTHOR_EMAIL: 'audit-test@example.com',
      GIT_COMMITTER_NAME: 'audit-test',
      GIT_COMMITTER_EMAIL: 'audit-test@example.com',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${String(result.status)}）：\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/** Create a throwaway Git repository with one committed source file. */
export async function createGitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-audit-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a - b;\n', 'utf8');
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'audit-fixture', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  runCommand('git', ['init', '-q'], root);
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'baseline'], root);
  return root;
}

/** A stand-in for `dsh headless`; consumes the audit prompt and writes one candidate + report. */
export function fakeAuditAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'fake-audit-agent.mjs');
}

/** A stand-in for a failing executor. */
export function failAuditAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'fail-audit-agent.mjs');
}

/** A stand-in that produces only a report (B-class only, no candidate). */
export function reportOnlyAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'report-only-agent.mjs');
}

/** A stand-in that produces a structurally invalid candidate. */
export function invalidCandidateAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'invalid-candidate-agent.mjs');
}

/**
 * A stand-in `dsh` executable: ignores the `--profile headless --json -` args
 * and runs the fake agent, so the DSH branch can be tested without a model call.
 */
export async function createFakeDshCommand() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-audit-dsh-'));
  if (process.platform === 'win32') {
    const file = path.join(dir, 'dsh.cmd');
    await writeFile(file, `@echo off\r\n"${process.execPath}" "${fakeAuditAgentPath()}"\r\n`, 'utf8');
    return file;
  }
  const file = path.join(dir, 'dsh');
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${fakeAuditAgentPath()}" "$@"\n`, 'utf8');
  await chmod(file, 0o755);
  return file;
}
