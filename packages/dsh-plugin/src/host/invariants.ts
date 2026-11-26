import type { ReviewCandidate, RevisionEntry } from './types.js';
import { issueInvariantErrors, selectIssuePatch } from './issue-review.js';
import { isRepoRelativePath } from './patch.js';
export { isRepoRelativePath } from './patch.js';

/** 候选读取端的不变量检查。补丁能否应用须由有 VCS 上下文的调用方另行验证。 */

const TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const FINDING_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseTime(value: string, field: string, errors: string[]): Date | null {
  if (!TIME_WITH_ZONE.test(value)) {
    errors.push(`I13: ${field} 不是含时区偏移的 ISO 时间：${value || '(空)'}`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push(`I13: ${field} 无法解析为时间：${value}`);
    return null;
  }
  return date;
}

export interface ReviewInvariantInput {
  candidate: Pick<ReviewCandidate, 'id' | 'month' | 'slug' | 'meta'>;
  patchExists: (revision: RevisionEntry) => boolean;
  /** 无法解析当前补丁时传 null，只跳过文件集合比对。 */
  currentPatchPaths: string[] | null;
  /** 未提供目标查验能力时只校验重开字段的结构。 */
  reopenedTargetRejected?: (candidateId: string) => boolean | null;
}

/** 只读取候选元数据，适合尚未解析补丁的队列读取。 */
export function quickReviewInvariants(candidate: ReviewInvariantInput['candidate']): string[] {
  const errors: string[] = [];
  const meta = candidate.meta;

  if (!/^\d{4}-\d{2}$/.test(candidate.month) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.slug)) {
    errors.push(`I1: 候选目录命名非法：${candidate.id}`);
  }
  if (meta.schemaVersion !== 1 && meta.schemaVersion !== 2 && meta.schemaVersion !== 3) {
    errors.push(`I2: schema_version 必须是 1、2 或 3，实际 ${String(meta.schemaVersion)}`);
  }
  if ((meta.schemaVersion >= 2 && !FINDING_ID_PATTERN.test(meta.findingId ?? ''))
    || (meta.schemaVersion === 1 && meta.findingId !== undefined)) {
    errors.push('I2: 只有 v2 候选必须绑定合法的 finding_id');
  }

  const ids = meta.revisions.map((revision) => revision.id);
  if (meta.schemaVersion === 3) {
    errors.push(...issueInvariantErrors(meta));
  } else if (ids.length === 0) {
    errors.push('I3: revisions 为空');
  } else {
    if (new Set(ids).size !== ids.length) errors.push('I3: revisions 存在重复版本号');
    const sorted = [...ids].sort((left, right) => left - right);
    if (sorted.some((id, index) => id !== index + 1)) {
      errors.push(`I3: 版本号必须是从 1 开始的连续正整数：${JSON.stringify(sorted)}`);
    }
    if (meta.currentRevision !== sorted[sorted.length - 1]) {
      errors.push(`I3: current_revision=${String(meta.currentRevision)} 不等于最高版本 ${String(sorted[sorted.length - 1] ?? -1)}`);
    }
    for (const revision of meta.revisions) {
      if (revision.patch !== `${String(revision.id).padStart(3, '0')}.patch`) {
        errors.push(`I3: 版本 ${String(revision.id)} 的补丁名必须为 ${String(revision.id).padStart(3, '0')}.patch，实际 ${revision.patch}`);
      }
    }
  }

  const approvedMismatch = meta.status === 'approved' !== (meta.approval !== null);
  const rejectedMismatch = meta.status === 'rejected' !== (meta.rejection !== null);
  if (approvedMismatch || rejectedMismatch) errors.push('I6: status 与 approval/rejection 不一致');
  if (meta.approval && meta.rejection) errors.push('I6: approval 与 rejection 互斥违反');

  const knownIds = new Set(ids);
  const commentIds = new Set<string>();
  meta.comments.forEach((comment, index) => {
    const at = `comments[${String(index)}]`;
    if (!comment.id) errors.push(`I11: ${at}.id 不能为空`);
    else if (commentIds.has(comment.id)) errors.push(`I11: 评论 id 重复：${comment.id}`);
    commentIds.add(comment.id);
    if (!comment.author.trim()) errors.push(`I11: ${at}.author 不能为空`);
    if (comment.createdAt !== undefined) parseTime(comment.createdAt, `${at}.created_at`, errors);
    if (meta.schemaVersion === 3 ? !Number.isSafeInteger(comment.revision) || comment.revision < 1 || comment.revision > meta.currentRevision : !knownIds.has(comment.revision)) errors.push(`I11: ${at}.revision=${String(comment.revision)} 指向不存在的版本`);
    const inline = comment.file !== '' || comment.line !== 0;
    if (inline) {
      if (!comment.file) errors.push(`I11: ${at} 行内评论缺少文件`);
      if (comment.line <= 0) errors.push(`I11: ${at} 行内评论 line 必须为正整数`);
      if (comment.side !== 'LEFT' && comment.side !== 'RIGHT') errors.push(`I11: ${at} 行内评论缺少 LEFT/RIGHT side`);
      if (!isRepoRelativePath(comment.file)) errors.push(`I11: ${at}.file 不是仓库相对路径：${comment.file}`);
      if (comment.anchor !== undefined && !comment.anchor.snippet.trim()) {
        errors.push(`I11: ${at}.anchor.snippet 不能为空`);
      }
    } else {
      if (comment.side !== undefined) errors.push(`I11: ${at} 总体评论不应有 side`);
      if (comment.anchor !== undefined) errors.push(`I11: ${at} 总体评论不应有 anchor`);
    }
  });

  meta.targetFiles.forEach((file) => {
    if (!isRepoRelativePath(file)) errors.push(`I12: target_files 含非法路径：${file}`);
  });

  parseTime(meta.createdAt, 'created_at', errors);
  parseTime(meta.updatedAt, 'updated_at', errors);
  if (meta.rejection) parseTime(meta.rejection.rejectedAt, 'rejection.rejected_at', errors);
  if (meta.approval) parseTime(meta.approval.approvedAt, 'approval.approved_at', errors);

  if (meta.approval) {
    if (!meta.approval.gateChecks) errors.push('I7: approval.gate_checks 是必填快照');
    if (!meta.approval.gateResults) errors.push('I7: approval.gate_results 是必填逐条结果');
    const snapshot = meta.approval.gateChecks ?? [];
    let expectedGates = meta.gateChecks;
    if (meta.issue && meta.approval.extra) {
      try { expectedGates = selectIssuePatch(meta, { optionId: String(meta.approval.extra['option_id']), patchId: Number(meta.approval.extra['patch_id']) }).option.gateChecks; }
      catch { errors.push('批准的方案和补丁引用无效'); }
    }
    if (meta.approval.gateChecks && JSON.stringify(snapshot) !== JSON.stringify(expectedGates)) {
      errors.push('I7: approval.gate_checks 快照与顶层 gate_checks 不一致（疑似外部改写）');
    }
    const results = meta.approval.gateResults ?? [];
    if (meta.approval.gateResults && results.length !== snapshot.length) {
      errors.push(`I7: gate_results 数量（${String(results.length)}）与快照（${String(snapshot.length)}）不一致`);
    }
    results.forEach((result, index) => {
      if (result.command !== snapshot[index]) errors.push(`I7: gate_results[${String(index)}].command 与快照不一致`);
      if (!Number.isInteger(result.exit_code) || result.exit_code < 0 || result.exit_code !== 0) {
        errors.push(`I7: gate_results[${String(index)}].exit_code 必须为非负整数，批准时还必须为 0`);
      }
      if (!Number.isFinite(result.duration_ms) || result.duration_ms < 0) {
        errors.push(`I7: gate_results[${String(index)}].duration_ms 必须为非负有限数`);
      }
    });
  }

  const decisionIds = meta.humanDecisions.map((decision) => decision.id);
  if (decisionIds.some((id) => !id)) errors.push('I8: human_decisions.id 不能为空');
  if (new Set(decisionIds).size !== decisionIds.length) errors.push('I8: human_decisions 存在重复 id');
  if (meta.approval) {
    if (!meta.approval.confirmedDecisions) errors.push('I8: approval.confirmed_decisions 是必填数组（无项时为 []）');
    if (!meta.approval.waivedDecisions) errors.push('I8: approval.waived_decisions 是必填数组（无项时为 []）');
    const valid = new Set(decisionIds);
    const confirmed = meta.approval.confirmedDecisions ?? [];
    const waived = meta.approval.waivedDecisions ?? [];
    const confirmedSeen = new Set<string>();
    for (const id of confirmed) {
      if (!valid.has(id)) errors.push(`I8: approval.confirmed_decisions 含未知 id：${id}`);
      if (confirmedSeen.has(id)) errors.push(`I8: approval.confirmed_decisions 重复 id：${id}`);
      confirmedSeen.add(id);
    }
    const waivedSeen = new Set<string>();
    for (const item of waived) {
      if (!valid.has(item.id)) errors.push(`I8: approval.waived_decisions 含未知 id：${item.id}`);
      if (waivedSeen.has(item.id)) errors.push(`I8: approval.waived_decisions 重复 id：${item.id}`);
      if (confirmedSeen.has(item.id)) errors.push(`I8: 判断项 ${item.id} 同时被确认与知悉`);
      if (!item.reason.trim()) errors.push(`I8: approval.waived_decisions ${item.id} 缺少理由`);
      waivedSeen.add(item.id);
    }
    for (const id of decisionIds) {
      if (!confirmedSeen.has(id) && !waivedSeen.has(id)) errors.push(`I8: 判断项 ${id} 未出现在 approval 覆盖集合中`);
    }
  }

  const hasFrom = meta.reopenedFrom !== undefined && meta.reopenedFrom !== null;
  const hasReason = meta.reopenedReason !== undefined && meta.reopenedReason !== null;
  if (hasFrom !== hasReason) errors.push('I16: reopened_from 与 reopen_reason 必须同时出现或同时缺省');
  if (hasFrom && !(meta.reopenedReason ?? '').trim()) errors.push('I16: reopen_reason 不能为空');

  if (meta.rejection) {
    if (!meta.rejection.rejectedBy.trim()) errors.push('I6: rejection.rejected_by 为空');
    if (!meta.rejection.reason.trim()) errors.push('I6: rejection.reason 为空');
  }

  return errors;
}

export function fullReviewInvariants(input: ReviewInvariantInput): string[] {
  const errors = quickReviewInvariants(input.candidate);
  const meta = input.candidate.meta;
  const archived = meta.status === 'approved' || meta.status === 'rejected';

  if (!archived || meta.schemaVersion === 3) {
    for (const revision of meta.revisions) {
      if (!input.patchExists(revision)) {
        errors.push(`I4: 版本 ${String(revision.id)} 的补丁不存在：${revision.patch}`);
      }
    }
  }

  if (!archived && meta.targetFiles.length === 0 && !meta.issue) {
    errors.push('I5: 活跃候选 target_files 不能为空');
  }
  if (input.currentPatchPaths !== null && meta.targetFiles.length > 0 && !archived) {
    const declared = [...meta.targetFiles].sort();
    const actual = [...input.currentPatchPaths].sort();
    if (meta.issue ? actual.some(file => !declared.includes(file)) : JSON.stringify(declared) !== JSON.stringify(actual)) {
      errors.push(`I5: target_files 与补丁实际路径不一致：声明 ${JSON.stringify(declared)} vs 实际 ${JSON.stringify(actual)}`);
    }
  }

  if (meta.reopenedFrom && input.reopenedTargetRejected) {
    const result = input.reopenedTargetRejected(meta.reopenedFrom);
    if (result === false) errors.push(`I16: reopened_from 指向的候选不存在或不是 rejected：${meta.reopenedFrom}`);
  }

  return errors;
}
