import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runProcess } from './shell.js';
import type { AppSettings, VcsType } from './types.js';

export const DEFAULT_SETTINGS: AppSettings = {
  repoRoot: '',
  owner: '',
  vcsType: 'auto',
  baseBranch: '',
  runner: 'dsh',
  dshCommand: '',
  externalCommand: '',
  autoFixOnFailure: true,
  gateTimeoutMs: 600_000,
  syncBeforeApprove: true,
  scheduleIntervalMinutes: 0,
};

export function dshHome(): string {
  return process.env['DSH_HOME'] || path.join(os.homedir(), '.dsh');
}

export function settingsFilePath(): string {
  return path.join(dshHome(), 'dsh-code-review', 'settings.json');
}

function normalizeSettings(raw: unknown): AppSettings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const asString = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const runner = asString(input['runner'], DEFAULT_SETTINGS.runner);
  const vcsType = asString(input['vcsType'], DEFAULT_SETTINGS.vcsType);
  return {
    repoRoot: asString(input['repoRoot'], '').trim(),
    owner: asString(input['owner'], '').trim(),
    vcsType: vcsType === 'git' || vcsType === 'svn' ? vcsType : 'auto',
    baseBranch: asString(input['baseBranch'], '').trim(),
    runner: runner === 'manual' || runner === 'external' ? runner : 'dsh',
    dshCommand: asString(input['dshCommand'], '').trim(),
    externalCommand: asString(input['externalCommand'], '').trim(),
    autoFixOnFailure: input['autoFixOnFailure'] !== false,
    gateTimeoutMs: typeof input['gateTimeoutMs'] === 'number' && input['gateTimeoutMs'] > 1000
      ? Math.min(input['gateTimeoutMs'], 3_600_000)
      : DEFAULT_SETTINGS.gateTimeoutMs,
    syncBeforeApprove: input['syncBeforeApprove'] !== false,
    scheduleIntervalMinutes: typeof input['scheduleIntervalMinutes'] === 'number' && input['scheduleIntervalMinutes'] > 0
      ? input['scheduleIntervalMinutes']
      : 0,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const text = await readFile(settingsFilePath(), 'utf8');
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = normalizeSettings(settings);
  const file = settingsFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return normalized;
}

export interface SettingsValidation {
  ok: boolean;
  errors: string[];
  vcsType: VcsType | null;
}

export async function validateSettings(settings: AppSettings): Promise<SettingsValidation> {
  const errors: string[] = [];
  if (!settings.owner.trim()) errors.push('审核者（owner）不能为空');
  if (!settings.repoRoot.trim()) {
    // Project selection is session-scoped: an empty repoRoot is valid and is
    // resolved from the active conversation's working directory per request.
    return { ok: errors.length === 0, errors, vcsType: null };
  }
  const repoRoot = path.resolve(settings.repoRoot);
  try {
    const info = await stat(repoRoot);
    if (!info.isDirectory()) errors.push(`产品仓库路径不是目录：${repoRoot}`);
  } catch {
    errors.push(`产品仓库路径不存在：${repoRoot}`);
    return { ok: false, errors, vcsType: null };
  }
  const vcsType = await detectVcs(repoRoot);
  if (vcsType === null) {
    errors.push('产品仓库未检测到 .git 或 .svn，且 svn/git 信息读取失败');
  } else if (settings.vcsType !== 'auto' && settings.vcsType !== vcsType) {
    errors.push(`配置的 VCS 是 ${settings.vcsType}，但仓库实际是 ${vcsType}`);
  }
  return { ok: errors.length === 0, errors, vcsType };
}

export async function detectVcs(repoRoot: string): Promise<VcsType | null> {
  if (existsSync(path.join(repoRoot, '.git'))) return 'git';
  if (existsSync(path.join(repoRoot, '.svn'))) return 'svn';
  const git = await runProcess('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  if (git.code === 0 && git.stdout.trim() === 'true') return 'git';
  const svn = await runProcess('svn', ['info', '--show-item', 'wc-root', repoRoot], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  if (svn.code === 0 && svn.stdout.trim().length > 0) return 'svn';
  return null;
}

export async function suggestOwner(repoRoot: string): Promise<string> {
  if (repoRoot) {
    const result = await runProcess('git', ['-C', repoRoot, 'config', 'user.name'], {
      cwd: repoRoot,
      timeoutMs: 10_000,
    });
    const name = result.stdout.trim();
    if (result.code === 0 && name) return name;
  }
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

export async function resolveRepoRoot(settings: AppSettings): Promise<string> {
  if (!settings.repoRoot.trim()) return '';
  return path.resolve(settings.repoRoot);
}
