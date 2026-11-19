import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 批量测试临时仓库时，fsmonitor 守护进程会累积并让 git add 卡在 IPC。
// 用可继承的 GIT_CONFIG_* 禁用它，使测试与被测插件启动的 Git 子进程都生效。
process.env.GIT_CONFIG_COUNT ??= '1';
process.env.GIT_CONFIG_KEY_0 ??= 'core.fsmonitor';
process.env.GIT_CONFIG_VALUE_0 ??= 'false';

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureGitName = 'audit-test';
const fixtureGitEmail = 'audit-test@example.com';

export function runCommand(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: fixtureGitName,
      GIT_AUTHOR_EMAIL: fixtureGitEmail,
      GIT_COMMITTER_NAME: fixtureGitName,
      GIT_COMMITTER_EMAIL: fixtureGitEmail,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${String(result.status)}）：\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

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
  runCommand('git', ['config', '--local', 'user.name', fixtureGitName], root);
  runCommand('git', ['config', '--local', 'user.email', fixtureGitEmail], root);
  runCommand('git', ['config', '--local', 'core.autocrlf', 'false'], root);
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', 'baseline'], root);
  return root;
}

/** 默认审查替身会为成功路径生成一份候选和一份报告。 */
export function fakeAuditAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'fake-audit-agent.mjs');
}

export function failAuditAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'fail-audit-agent.mjs');
}

/** 仅生成 B 类报告，用于覆盖收尾无候选的路径。 */
export function reportOnlyAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'report-only-agent.mjs');
}

export function invalidCandidateAgentPath() {
  return path.join(fixturesDir, 'fixtures', 'invalid-candidate-agent.mjs');
}

/** 替身可在 DSH 命令入口后直接运行审查夹具，测试无需调用模型。 */
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
