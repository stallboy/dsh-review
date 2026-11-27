import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AppSettings, RunnerType, VcsType } from './types.js';

/** 原子写入 JSON 文件（UUID 临时文件防同毫秒碰撞，失败自动清理）。 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const DEFAULT_STAGE_EXECUTORS = ['codex', 'claude'] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  repoRoot: '',
  owner: '',
  vcsType: 'auto',
  baseBranch: '',
  runner: 'dsh',
  dshCommand: '',
  externalCommand: '',
  stageExecutors: [...DEFAULT_STAGE_EXECUTORS],
  autoFixOnFailure: true,
  gateTimeoutMs: 600_000,
  syncBeforeApprove: true,
};

export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']?.trim();
  return fromEnv && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(homedir(), '.dsh');
}

export function settingsFilePath(): string {
  return path.join(dshHome(), 'dsh-code-review', 'settings.json');
}

export function normalizeStageExecutors(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_STAGE_EXECUTORS];
  if (!Array.isArray(value)) return [...DEFAULT_STAGE_EXECUTORS];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const raw = item.trim().toLowerCase();
    if (!raw) continue;
    // 兼容用户填写 claude-code / claude 的常见写法，内部统一归一。
    const canonical = raw === 'claude-code' ? 'claude' : raw;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.gateTimeoutMs;
  }
  const truncated = Math.trunc(value);
  if (truncated <= 1000) return DEFAULT_SETTINGS.gateTimeoutMs;
  return Math.min(truncated, 3_600_000);
}

function normalizeVcs(value: unknown): 'auto' | VcsType {
  return value === 'git' || value === 'svn' ? value : 'auto';
}

function normalizeRunner(value: unknown): RunnerType {
  return value === 'dsh' || value === 'manual' || value === 'external' ? value : 'dsh';
}

export function normalizeSettings(raw: Partial<AppSettings> | Record<string, unknown> | null | undefined): AppSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const repoRoot = typeof input['repoRoot'] === 'string' ? input['repoRoot'].trim() : '';
  const owner = typeof input['owner'] === 'string' ? input['owner'].trim() : '';
  const baseBranch = typeof input['baseBranch'] === 'string' ? input['baseBranch'].trim() : '';
  const dshCommand = typeof input['dshCommand'] === 'string' ? input['dshCommand'].trim() : '';
  const externalCommand = typeof input['externalCommand'] === 'string' ? input['externalCommand'].trim() : '';
  return {
    repoRoot: repoRoot.length > 0 ? path.resolve(repoRoot) : '',
    owner,
    vcsType: normalizeVcs(input['vcsType']),
    baseBranch,
    runner: normalizeRunner(input['runner']),
    dshCommand,
    externalCommand,
    stageExecutors: normalizeStageExecutors(input['stageExecutors']),
    autoFixOnFailure: typeof input['autoFixOnFailure'] === 'boolean' ? input['autoFixOnFailure'] : DEFAULT_SETTINGS.autoFixOnFailure,
    gateTimeoutMs: clampTimeout(input['gateTimeoutMs']),
    syncBeforeApprove: typeof input['syncBeforeApprove'] === 'boolean' ? input['syncBeforeApprove'] : DEFAULT_SETTINGS.syncBeforeApprove,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const file = settingsFilePath();
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeSettings(parsed);
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await atomicWriteJson(settingsFilePath(), next);
  return next;
}

export function detectVcsType(repoRoot: string): VcsType | null {
  if (!repoRoot) return null;
  let current = path.resolve(repoRoot);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return 'git';
    if (existsSync(path.join(current, '.svn'))) return 'svn';
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface SettingsValidation {
  ok: boolean;
  errors: string[];
  vcsType: VcsType | null;
}

export async function validateSettings(settings: AppSettings): Promise<SettingsValidation> {
  const errors: string[] = [];
  let vcsType: VcsType | null = null;
  if (!settings.repoRoot) {
    errors.push('未配置目标仓库路径（repoRoot）。');
  } else {
    try {
      const info = await stat(settings.repoRoot);
      if (!info.isDirectory()) errors.push(`仓库路径不是目录：${settings.repoRoot}`);
      else {
        const detected = detectVcsType(settings.repoRoot);
        if (!detected) {
          errors.push(`目录不在 Git 或 SVN 仓库内：${settings.repoRoot}`);
        } else if (settings.vcsType !== 'auto' && settings.vcsType !== detected) {
          errors.push(`配置的 VCS 类型为 ${settings.vcsType}，但检测到仓库为 ${detected}。`);
        } else {
          vcsType = detected;
        }
      }
    } catch {
      errors.push(`仓库路径不存在：${settings.repoRoot}`);
    }
  }
  if (!settings.owner) {
    errors.push('未配置当前操作者账号（owner）。');
  }
  if (settings.runner === 'external' && !settings.externalCommand) {
    errors.push('runner 为 external 时必须配置 externalCommand。');
  }
  return { ok: errors.length === 0, errors, vcsType };
}
