/**
 * 仓库级持久化恢复守卫（SPEC §8.3 / I20）：
 * 在业务写入与提交窗口落盘登记；若进程崩溃或进入 RECOVERY_REQUIRED，重启后仍持续阻塞该仓库写操作，
 * 直至人工恢复现场并通过工作区与 VCS 状态核验后解除。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './settings.js';
import { ApiError } from './types.js';
import type { VcsAdapter } from './vcs-types.js';

export type RecoveryKind = 'approve' | 'commit' | 'sync' | 'audit';

export interface RepoRecoveryRecord {
  repoRoot: string;
  state: 'active_write' | 'recovery_required';
  kind: RecoveryKind;
  reason: string;
  detail: string;
  jobId?: string;
  candidateId?: string;
  updatedAt: string;
}

interface PersistedRecoveryFile {
  version: 1;
  records: RepoRecoveryRecord[];
}

function canonicalRepoKey(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class RepoRecoveryStore {
  private readonly records = new Map<string, RepoRecoveryRecord>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray((parsed as PersistedRecoveryFile | null)?.records)
      ? (parsed as PersistedRecoveryFile).records
      : [];
    let promoted = false;
    this.records.clear();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || typeof raw.repoRoot !== 'string') continue;
      const key = canonicalRepoKey(raw.repoRoot);
      if (raw.state === 'active_write') {
        // 进程在写入/提交窗口内异常退出，重启后必须升级为持久 RECOVERY_REQUIRED 阻塞后续写入
        promoted = true;
        this.records.set(key, {
          ...raw,
          state: 'recovery_required',
          reason: 'COMMIT_OUTCOME_UNKNOWN',
          detail: `上次进程在 ${raw.kind} 写入窗口内异常中断（${raw.detail || raw.reason}），请核对仓库提交与工作区后再解除恢复阻塞`,
          updatedAt: new Date().toISOString(),
        });
      } else if (raw.state === 'recovery_required') {
        this.records.set(key, raw);
      }
    }
    if (promoted) {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    const payload: PersistedRecoveryFile = {
      version: 1,
      records: [...this.records.values()],
    };
    await atomicWriteJson(this.filePath, payload);
  }

  blockerFor(repoRoot: string): RepoRecoveryRecord | undefined {
    const record = this.records.get(canonicalRepoKey(repoRoot));
    return record?.state === 'recovery_required' ? record : undefined;
  }

  assertNotBlocked(repoRoot: string): void {
    const blocker = this.blockerFor(repoRoot);
    if (!blocker) return;
    throw new ApiError(
      409,
      'conflict',
      `仓库处于待恢复态（${blocker.reason}）：${blocker.detail}；请人工核对并清理现场后解除恢复阻塞`,
      {
        status: 'RECOVERY_REQUIRED',
        reason: blocker.reason,
        detail: blocker.detail,
        recovery: blocker,
      },
    );
  }

  async beginWriteWindow(
    repoRoot: string,
    info: { kind: RecoveryKind; reason: string; detail: string; jobId?: string; candidateId?: string },
  ): Promise<void> {
    const key = canonicalRepoKey(repoRoot);
    const existing = this.records.get(key);
    if (existing?.state === 'recovery_required') {
      this.assertNotBlocked(repoRoot);
    }
    this.records.set(key, {
      repoRoot: path.resolve(repoRoot),
      state: 'active_write',
      kind: info.kind,
      reason: info.reason,
      detail: info.detail,
      ...(info.jobId ? { jobId: info.jobId } : {}),
      ...(info.candidateId ? { candidateId: info.candidateId } : {}),
      updatedAt: new Date().toISOString(),
    });
    await this.save();
  }

  async markRecoveryRequired(
    repoRoot: string,
    info: { kind: RecoveryKind; reason: string; detail: string; jobId?: string; candidateId?: string },
  ): Promise<RepoRecoveryRecord> {
    const key = canonicalRepoKey(repoRoot);
    const record: RepoRecoveryRecord = {
      repoRoot: path.resolve(repoRoot),
      state: 'recovery_required',
      kind: info.kind,
      reason: info.reason,
      detail: info.detail,
      ...(info.jobId ? { jobId: info.jobId } : {}),
      ...(info.candidateId ? { candidateId: info.candidateId } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    await this.save();
    return record;
  }

  /** 仅清除未进入 recovery_required 的活跃写入窗口，避免误清持久化恢复阻塞。 */
  async finishWriteWindow(repoRoot: string): Promise<void> {
    const key = canonicalRepoKey(repoRoot);
    const existing = this.records.get(key);
    if (!existing || existing.state !== 'active_write') return;
    this.records.delete(key);
    await this.save();
  }

  async clearIfVerified(repoRoot: string, vcs: VcsAdapter): Promise<{ cleared: boolean; previous?: RepoRecoveryRecord }> {
    const key = canonicalRepoKey(repoRoot);
    const existing = this.records.get(key);
    if (!existing) return { cleared: false };

    const clean = await vcs.ensureCleanWorkspace();
    if (!clean.clean) {
      throw new ApiError(
        409,
        'conflict',
        `无法解除恢复阻塞：业务工作区仍不干净（${clean.dirtyPaths.join(', ') || clean.message}）`,
        { dirtyPaths: clean.dirtyPaths },
      );
    }
    if (vcs.type === 'git' && (await vcs.hasActiveGitOperation?.())) {
      throw new ApiError(
        409,
        'conflict',
        '无法解除恢复阻塞：Git 仍处于未完成的 merge/rebase/cherry-pick/revert 状态',
      );
    }
    this.records.delete(key);
    await this.save();
    return { cleared: true, previous: existing };
  }
}
