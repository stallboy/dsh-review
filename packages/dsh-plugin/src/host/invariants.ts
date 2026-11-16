import type { ReviewCandidate, RevisionEntry } from './types.js';

/**
 * §13.1 不变量（读端校验）。违反者由调用方标记 broken，不参与批准/投影/负向记忆。
 * I4（补丁可干净应用）与 I5 的补丁内容比对需要 VCS/补丁解析，由调用方在具备上下文时补充。
 */

const TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isRepoRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('..') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('./')) return false;
  return true;
}

function parseTime(value: string, field: string, errors: string[]): Date | null {
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
  /** 活跃候选的每个 Revision 的补丁文件是否存在（I4 文件存在性部分）。 */
  patchExists: (revision: RevisionEntry) => boolean;
  /** 当前补丁实际触及的业务文件（I5）；null 表示无法取得（跳过 I5）。 */
  currentPatchPaths: string[] | null;
  /** reopened_from 指向的候选是否存在且为 rejected（I16 完整形态）；不提供则只做结构校验。 */
  reopenedTargetRejected?: (candidateId: string) => boolean | null;
}

/** 只依赖 review.md 自身的快速校验（无 fs/补丁上下文），用于队列加载早期。 */
export function quickReviewInvariants(candidate: ReviewInvariantInput['candidate']): string[] {
  const errors: string[] = [];
  const meta = candidate.meta;

  // I1：candidate_id 等于相对 .ai-review/ 的目录路径格式（slug 不得以 . 开头）。
  if (!/^\d{4}-\d{2}$/.test(candidate.month) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.slug)) {
    errors.push(`I1: 候选目录命名非法：${candidate.id}`);
  }
  // I2：schema_version 必须是 1（解析层已拦截，此处兜底）。
  if (meta.schemaVersion !== 1) errors.push(`I2: schema_version 必须是 1，实际 ${String(meta.schemaVersion)}`);

  // I3：current_revision == max(revisions[].id)；ID 正整数、唯一、连续递增且与补丁编号一致。
  const ids = meta.revisions.map((revision) => revision.id);
  if (ids.length === 0) {
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
    // §4.6：补丁文件名必须是与 revision id 一致的三位零填充编号。
    for (const revision of meta.revisions) {
      if (revision.patch !== `${String(revision.id).padStart(3, '0')}.patch`) {
        errors.push(`I3: 版本 ${String(revision.id)} 的补丁名必须为 ${String(revision.id).padStart(3, '0')}.patch，实际 ${revision.patch}`);
      }
    }
  }

  // I6：status == approved ⟺ approval != null；rejected ⟺ rejection != null；互斥。
  const approvedMismatch = meta.status === 'approved' !== (meta.approval !== null);
  const rejectedMismatch = meta.status === 'rejected' !== (meta.rejection !== null);
  if (approvedMismatch || rejectedMismatch) errors.push('I6: status 与 approval/rejection 不一致');
  if (meta.approval && meta.rejection) errors.push('I6: approval 与 rejection 互斥违反');

  // I11：评论 id 候选内唯一；引用与总体/行内形态。
  const knownIds = new Set(ids);
  const commentIds = new Set<string>();
  meta.comments.forEach((comment, index) => {
    const at = `comments[${String(index)}]`;
    if (!comment.id) errors.push(`I11: ${at}.id 不能为空`);
    else if (commentIds.has(comment.id)) errors.push(`I11: 评论 id 重复：${comment.id}`);
    commentIds.add(comment.id);
    if (!comment.author.trim()) errors.push(`I11: ${at}.author 不能为空`);
    if (comment.createdAt !== undefined) parseTime(comment.createdAt, `${at}.created_at`, errors);
    if (!knownIds.has(comment.revision)) errors.push(`I11: ${at}.revision=${String(comment.revision)} 指向不存在的版本`);
    const inline = comment.file !== '' || comment.line !== 0;
    if (inline) {
      if (!comment.file) errors.push(`I11: ${at} 行内评论缺少文件`);
      if (comment.line <= 0) errors.push(`I11: ${at} 行内评论 line 必须为正整数`);
      if (comment.side !== 'LEFT' && comment.side !== 'RIGHT') errors.push(`I11: ${at} 行内评论缺少 LEFT/RIGHT side`);
      if (!isRepoRelativePath(comment.file)) errors.push(`I11: ${at}.file 不是仓库相对路径：${comment.file}`);
      // §4.3：anchor 仅行内评论可带，snippet 非空。
      if (comment.anchor !== undefined && !comment.anchor.snippet.trim()) {
        errors.push(`I11: ${at}.anchor.snippet 不能为空`);
      }
    } else {
      if (comment.side !== undefined) errors.push(`I11: ${at} 总体评论不应有 side`);
      if (comment.anchor !== undefined) errors.push(`I11: ${at} 总体评论不应有 anchor`);
    }
  });

  // I12：target_files 为仓库相对路径。
  meta.targetFiles.forEach((file) => {
    if (!isRepoRelativePath(file)) errors.push(`I12: target_files 含非法路径：${file}`);
  });

  // I13：时间可解析且含时区偏移。
  parseTime(meta.createdAt, 'created_at', errors);
  parseTime(meta.updatedAt, 'updated_at', errors);
  if (meta.rejection) parseTime(meta.rejection.rejectedAt, 'rejection.rejected_at', errors);
  if (meta.approval) parseTime(meta.approval.approvedAt, 'approval.approved_at', errors);

  // I7：批准快照的所有字段必填，门禁逐条对应且数值非负。
  if (meta.approval) {
    if (!meta.approval.gateChecks) errors.push('I7: approval.gate_checks 是必填快照');
    if (!meta.approval.gateResults) errors.push('I7: approval.gate_results 是必填逐条结果');
    const snapshot = meta.approval.gateChecks ?? [];
    if (meta.approval.gateChecks && JSON.stringify(snapshot) !== JSON.stringify(meta.gateChecks)) {
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

  // I8：human_decisions[].id 唯一且非空；批准快照的 confirmed/waived 必须是精确集合。
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

  // I16：重开字段同时出现或同时缺省；出现时 reason 非空。
  const hasFrom = meta.reopenedFrom !== undefined && meta.reopenedFrom !== null;
  const hasReason = meta.reopenedReason !== undefined && meta.reopenedReason !== null;
  if (hasFrom !== hasReason) errors.push('I16: reopened_from 与 reopen_reason 必须同时出现或同时缺省');
  if (hasFrom && !(meta.reopenedReason ?? '').trim()) errors.push('I16: reopen_reason 不能为空');

  // 拒绝留痕完整性（I6 的补充）：rejected 必须有非空 reason 与 rejectedBy。
  if (meta.rejection) {
    if (!meta.rejection.rejectedBy.trim()) errors.push('I6: rejection.rejected_by 为空');
    if (!meta.rejection.reason.trim()) errors.push('I6: rejection.reason 为空');
  }

  return errors;
}

/** 完整校验：补齐需要文件系统与补丁上下文的 I4/I5/I16（引用存在性）。 */
export function fullReviewInvariants(input: ReviewInvariantInput): string[] {
  const errors = quickReviewInvariants(input.candidate);
  const meta = input.candidate.meta;
  const archived = meta.status === 'approved' || meta.status === 'rejected';

  // I4：活跃候选每个 Revision 都有补丁文件。
  if (!archived) {
    for (const revision of meta.revisions) {
      if (!input.patchExists(revision)) {
        errors.push(`I4: 版本 ${String(revision.id)} 的补丁不存在：${revision.patch}`);
      }
    }
  }

  // I5：target_files 与当前补丁实际触及的业务文件一致；活跃候选必须非空。
  if (!archived && meta.targetFiles.length === 0) {
    errors.push('I5: 活跃候选 target_files 不能为空');
  }
  if (input.currentPatchPaths !== null && meta.targetFiles.length > 0 && !archived) {
    const declared = [...meta.targetFiles].sort();
    const actual = [...input.currentPatchPaths].sort();
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      errors.push(`I5: target_files 与补丁实际路径不一致：声明 ${JSON.stringify(declared)} vs 实际 ${JSON.stringify(actual)}`);
    }
  }

  // I16 完整形态：reopened_from 指向真实存在的 rejected 候选。
  if (meta.reopenedFrom && input.reopenedTargetRejected) {
    const result = input.reopenedTargetRejected(meta.reopenedFrom);
    if (result === false) errors.push(`I16: reopened_from 指向的候选不存在或不是 rejected：${meta.reopenedFrom}`);
  }

  return errors;
}
