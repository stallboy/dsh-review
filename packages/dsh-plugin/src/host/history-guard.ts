/**
 * 问题历史只追加防篡改守卫（SPEC §3.3 / §4.1 / §5.6 / I4 / I14 / I16）：
 * 同时守护 Mode B 提案修订收尾与仓库审查跨轮合并收尾，防止 Agent 删改既有身份、
 * 历史补丁账本、失败修复尝试（防绕过永久封禁）、人类评论原文、人工决定、历史批准与未知扩展键。
 */

import type { ReviewFrontmatter } from './types.js';

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

export interface AppendOnlyGuardOptions {
  mode: 'mode_b' | 'audit';
  targetOptionId?: string;
  targetBase?: string;
}

export function assertAppendOnlyHistory(
  oldMeta: ReviewFrontmatter,
  newMeta: ReviewFrontmatter,
  options: AppendOnlyGuardOptions,
): string[] {
  const errors: string[] = [];

  if (newMeta.findingId !== oldMeta.findingId) {
    errors.push(`finding_id 不得变更（原：${oldMeta.findingId}，现：${newMeta.findingId}）`);
  }
  if (newMeta.createdAt !== oldMeta.createdAt) {
    errors.push(`created_at 不得篡改（原：${oldMeta.createdAt}，现：${newMeta.createdAt}）`);
  }
  if (newMeta.owner !== oldMeta.owner) {
    errors.push(`不能改写既有共享问题的负责人（当前共享负责人：${oldMeta.owner}，提交值：${newMeta.owner}）`);
  }
  if (newMeta.recordRevision !== oldMeta.recordRevision + 1) {
    errors.push(`record_revision 必须推进为 ${String(oldMeta.recordRevision + 1)}，当前为 ${String(newMeta.recordRevision)}`);
  }

  const oldMs = Date.parse(oldMeta.updatedAt);
  const newMs = Date.parse(newMeta.updatedAt);
  if (!Number.isFinite(newMs) || (Number.isFinite(oldMs) && newMs <= oldMs)) {
    errors.push(`updated_at（${newMeta.updatedAt}）必须严格大于旧记录时间（${oldMeta.updatedAt}）`);
  }

  // 顶层未知扩展键（I14）必须完整保留
  if (oldMeta.extra && Object.keys(oldMeta.extra).length > 0) {
    for (const [key, val] of Object.entries(oldMeta.extra)) {
      if (!newMeta.extra || !sameValue(newMeta.extra[key], val)) {
        errors.push(`顶层未知扩展键 ${key} 被删改`);
      }
    }
  }

  // patches[] 不可变追加账本
  if (newMeta.patches.length < oldMeta.patches.length) {
    errors.push('历史补丁账本 patches[] 不得删减');
  } else {
    for (let i = 0; i < oldMeta.patches.length; i += 1) {
      if (!sameValue(oldMeta.patches[i], newMeta.patches[i])) {
        errors.push(`历史补丁 #${String(oldMeta.patches[i]!.id)} 被修改或篡改`);
      }
    }
  }

  // repair_attempts[] 只追加，严禁删除或篡改（防绕过 I16 失败补丁永久封禁！）
  if (newMeta.repairAttempts.length < oldMeta.repairAttempts.length) {
    errors.push('历史修复尝试 repair_attempts[] 不得删减');
  } else {
    for (let i = 0; i < oldMeta.repairAttempts.length; i += 1) {
      if (!sameValue(oldMeta.repairAttempts[i], newMeta.repairAttempts[i])) {
        errors.push(`历史修复尝试 repair_attempts[${String(i)}] 被篡改`);
      }
    }
  }

  // observations[] 只追加
  if (newMeta.observations.length < oldMeta.observations.length) {
    errors.push('历史审查观察 observations[] 不得删减');
  } else {
    for (let i = 0; i < oldMeta.observations.length; i += 1) {
      if (!sameValue(oldMeta.observations[i], newMeta.observations[i])) {
        errors.push(`历史审查观察 observations[${String(i)}] 被篡改`);
      }
    }
  }

  // decisions[] 只追加
  if (newMeta.decisions.length < oldMeta.decisions.length) {
    errors.push('历史人工处置 decisions[] 不得删减');
  } else {
    for (let i = 0; i < oldMeta.decisions.length; i += 1) {
      if (!sameValue(oldMeta.decisions[i], newMeta.decisions[i])) {
        errors.push(`历史人工处置 decisions[${String(i)}] 被篡改`);
      }
    }
  }

  // comments[] 不可删减，原文/作者/定位/锚点/扩展键不可改（Mode B 仅允许更新 status）
  if (newMeta.comments.length < oldMeta.comments.length) {
    errors.push('历史人类评论 comments[] 不得删减');
  } else {
    const nextById = new Map(newMeta.comments.map((c) => [c.id, c]));
    for (const oldC of oldMeta.comments) {
      const nextC = nextById.get(oldC.id);
      if (!nextC) {
        errors.push(`历史人类评论 ${oldC.id} 被删除`);
        continue;
      }
      const { status: _oldStatus, ...oldImmutable } = oldC;
      const { status: _nextStatus, ...nextImmutable } = nextC;
      if (!sameValue(oldImmutable, nextImmutable)) {
        errors.push(`历史人类评论 ${oldC.id} 原文或元数据被篡改`);
      }
      if (options.mode === 'audit' && oldC.status !== nextC.status) {
        errors.push(`审查合并不得修改既有评论 ${oldC.id} 的状态`);
      }
    }
  }

  // approval_history[] 只追加
  if (newMeta.approvalHistory.length < oldMeta.approvalHistory.length) {
    errors.push('历史批准记录 approval_history[] 不得删减');
  } else {
    for (let i = 0; i < oldMeta.approvalHistory.length; i += 1) {
      if (!sameValue(oldMeta.approvalHistory[i], newMeta.approvalHistory[i])) {
        errors.push(`历史批准记录 approval_history[${String(i)}] 被篡改`);
      }
    }
  }

  if (options.mode === 'mode_b') {
    if (newMeta.approvalHistory.length !== oldMeta.approvalHistory.length) {
      errors.push('Mode B 不得新增或改动 approval_history[]');
    }
    if (newMeta.repairAttempts.length !== oldMeta.repairAttempts.length) {
      errors.push('Mode B 不得新增 repair_attempts[]');
    }
    if (newMeta.observations.length !== oldMeta.observations.length) {
      errors.push('Mode B 不得新增 observations[]');
    }
    if (newMeta.decisions.length !== oldMeta.decisions.length) {
      errors.push('Mode B 不得新增 decisions[]');
    }

    // 非目标方案必须完全原样保留
    for (const oldOpt of oldMeta.options) {
      if (oldOpt.id === options.targetOptionId) continue;
      const nextOpt = newMeta.options.find((o) => o.id === oldOpt.id);
      if (!nextOpt || !sameValue(oldOpt, nextOpt)) {
        errors.push(`非目标方案 ${oldOpt.id} 被意外修改或移除`);
      }
    }

    // 新追加补丁必须绑定目标基线
    if (options.targetBase && newMeta.patches.length === oldMeta.patches.length + 1) {
      const addedPatch = newMeta.patches[newMeta.patches.length - 1]!;
      if (addedPatch.baseRevision !== options.targetBase) {
        errors.push(`新补丁 ${addedPatch.patch} 的 base_revision（${addedPatch.baseRevision}）必须等于目标基线 ${options.targetBase}`);
      }
    }
  }

  return errors;
}
