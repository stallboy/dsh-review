/** 问题记录数据不变量校验器（对应 SPEC §10.1 I1–I16，严格单一格式 schema_version: 1）。 */

import { isAiReviewPath, isRepoRelativePath, parsePatch } from './patch.js';
import { AUDIT_TYPES, ISO_TIMESTAMP_PATTERN, ISSUE_KINDS, REVIEW_PRIORITIES, REVIEW_STATUS_LIST } from './frontmatter.js';
import { formatPatchFilename, sha256Hex } from './issue-review.js';
import type { ApprovalInfo, ReviewFrontmatter } from './types.js';

export const MONTH_PATTERN = /^\d{4}-\d{2}$/;
/** I1：问题目录 slug 仅允许小写 ASCII 字母、数字与 . _ -，避免跨平台大小写碰撞。 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const FINDING_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export { isRepoRelativePath };

export function parseTime(value: string, field: string, errors: string[]): number | null {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    errors.push(`${field} 必须是含时区的 ISO-8601 时间戳`);
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    errors.push(`${field} 不是有效时间戳`);
    return null;
  }
  return ms;
}

export function validateSafeBusinessPath(file: string, field: string, errors: string[]): boolean {
  if (!file || !isRepoRelativePath(file) || isAiReviewPath(file) || /[\r\n\0]/.test(file)) {
    errors.push(`${field} 含非法或禁止路径：${file || '(空)'}`);
    return false;
  }
  return true;
}

function validateApprovalSnapshot(
  approval: ApprovalInfo,
  meta: ReviewFrontmatter,
  field: string,
  isCurrent: boolean,
  errors: string[],
): void {
  if (!approval.approvedBy.trim()) errors.push(`${field}.approved_by 不能为空`);
  parseTime(approval.approvedAt, `${field}.approved_at`, errors);
  if (!Number.isInteger(approval.recordRevision) || approval.recordRevision < 1) {
    errors.push(`${field}.record_revision 必须是正整数`);
  }
  if (!OPTION_ID_PATTERN.test(approval.optionId)) {
    errors.push(`${field}.option_id 格式无效`);
  }
  if (!Number.isInteger(approval.patchId) || approval.patchId < 1) {
    errors.push(`${field}.patch_id 必须是正整数`);
  }
  if (!SHA256_PATTERN.test(approval.patchSha256)) {
    errors.push(`${field}.patch_sha256 必须是 64 位小写十六进制 SHA-256`);
  }
  if (!Number.isInteger(approval.repairAttemptId) || approval.repairAttemptId < 1) {
    errors.push(`${field}.repair_attempt_id 必须是正整数`);
  }
  if (!approval.baseRevision.trim()) {
    errors.push(`${field}.base_revision 不能为空`);
  }
  if (approval.businessCommit !== undefined && !approval.businessCommit.trim()) {
    errors.push(`${field}.business_commit 若提供则不能为空`);
  }

  const patch = meta.patches.find((p) => p.id === approval.patchId);
  if (!patch) {
    errors.push(`${field}.patch_id（${String(approval.patchId)}）在 patches[] 中不存在`);
  } else {
    if (patch.optionId !== approval.optionId) {
      errors.push(`${field}.option_id 与 patches[${String(patch.id)}].option_id 不一致`);
    }
    if (patch.sha256 !== approval.patchSha256) {
      errors.push(`${field}.patch_sha256 与 patches[${String(patch.id)}].sha256 不一致`);
    }
  }

  const attempt = meta.repairAttempts.find((a) => a.id === approval.repairAttemptId);
  if (!attempt) {
    errors.push(`${field}.repair_attempt_id（${String(approval.repairAttemptId)}）在 repair_attempts[] 中不存在`);
  } else {
    if (attempt.result !== 'applied' || attempt.restored !== false) {
      errors.push(`${field}.repair_attempt_id 必须指向 result=applied 且 restored=false 的成功尝试`);
    }
    if (attempt.optionId !== approval.optionId || attempt.patchId !== approval.patchId) {
      errors.push(`${field} 与对应 repair_attempts[${String(attempt.id)}] 的方案或补丁编号不一致`);
    }
  }

  if (approval.gateChecks.length === 0 || approval.gateChecks.some((cmd) => !cmd.trim())) {
    errors.push(`${field}.gate_checks 必须非空且每条命令非空`);
  }
  if (approval.gateResults.length !== approval.gateChecks.length) {
    errors.push(`${field}.gate_results 数量必须与 gate_checks 一一对应`);
  } else {
    approval.gateResults.forEach((res, idx) => {
      if (res.command !== approval.gateChecks[idx]) {
        errors.push(`${field}.gate_results[${String(idx)}].command 必须与 gate_checks 顺序一致`);
      }
      if (res.exitCode !== 0) {
        errors.push(`${field}.gate_results[${String(idx)}].exit_code 必须为 0`);
      }
      if (typeof res.durationMs !== 'number' || !Number.isFinite(res.durationMs) || res.durationMs < 0) {
        errors.push(`${field}.gate_results[${String(idx)}].duration_ms 必须是非负有限数`);
      }
    });
  }

  if (isCurrent) {
    const selectedOption = meta.options.find((o) => o.id === approval.optionId);
    if (!selectedOption) {
      errors.push(`当前 approval.option_id（${approval.optionId}）不在当前 options[] 中`);
    } else {
      if (selectedOption.currentPatch !== approval.patchId) {
        errors.push(`当前 approval.patch_id 必须等于所选方案的 current_patch`);
      }
      if (
        selectedOption.gateChecks.length !== approval.gateChecks.length
        || selectedOption.gateChecks.some((cmd, idx) => cmd !== approval.gateChecks[idx])
      ) {
        errors.push('当前 approval.gate_checks 必须与所选方案的 gate_checks 完全一致');
      }
    }

    // I10：精确覆盖当前 human_decisions。
    const declaredIds = new Set(meta.humanDecisions.map((d) => d.id));
    const confirmedSet = new Set<string>();
    for (const id of approval.confirmedDecisions) {
      if (confirmedSet.has(id)) errors.push(`${field}.confirmed_decisions 包含重复项：${id}`);
      if (!declaredIds.has(id)) errors.push(`${field}.confirmed_decisions 包含未知判断项：${id}`);
      confirmedSet.add(id);
    }
    const waivedSet = new Set<string>();
    for (const waived of approval.waivedDecisions) {
      if (waivedSet.has(waived.id)) errors.push(`${field}.waived_decisions 包含重复项：${waived.id}`);
      if (!declaredIds.has(waived.id)) errors.push(`${field}.waived_decisions 包含未知判断项：${waived.id}`);
      if (confirmedSet.has(waived.id)) errors.push(`${field} 中判断项 ${waived.id} 同时出现在 confirmed 与 waived`);
      if (!waived.reason.trim()) errors.push(`${field}.waived_decisions[${waived.id}] 理由不能为空`);
      waivedSet.add(waived.id);
    }
    for (const id of declaredIds) {
      if (!confirmedSet.has(id) && !waivedSet.has(id)) {
        errors.push(`${field} 遗漏了必须处理的人工判断项：${id}`);
      }
    }
  } else {
    // 历史批准只校验自身结构内部无重、无交集且 waive 理由非空，不强求匹配当前 options[] 或当前 human_decisions。
    const confirmedSet = new Set<string>();
    for (const id of approval.confirmedDecisions) {
      if (confirmedSet.has(id)) errors.push(`${field}.confirmed_decisions 包含重复项：${id}`);
      confirmedSet.add(id);
    }
    const waivedSet = new Set<string>();
    for (const waived of approval.waivedDecisions) {
      if (waivedSet.has(waived.id)) errors.push(`${field}.waived_decisions 包含重复项：${waived.id}`);
      if (confirmedSet.has(waived.id)) errors.push(`${field} 中判断项 ${waived.id} 同时出现在 confirmed 与 waived`);
      if (!waived.reason.trim()) errors.push(`${field}.waived_decisions[${waived.id}] 理由不能为空`);
      waivedSet.add(waived.id);
    }
  }
}

export interface QuickInvariantInput {
  id: string;
  month: string;
  slug: string;
  meta: ReviewFrontmatter;
}

/** 仅依据 review.md 与目录身份执行的快速不变量校验（I1–I16）。 */
export function quickReviewInvariants(input: QuickInvariantInput): string[] {
  const { month, slug, meta } = input;
  const errors: string[] = [];

  if (!MONTH_PATTERN.test(month)) errors.push(`目录月份格式非法：${month}`);
  if (!SLUG_PATTERN.test(slug)) errors.push(`问题目录 slug 必须为小写 ASCII（^[a-z0-9][a-z0-9._-]*$）：${slug}`);
  if (meta.schemaVersion !== 1) errors.push(`schema_version 必须为 1，当前为 ${String(meta.schemaVersion)}`);
  if (!FINDING_ID_PATTERN.test(meta.findingId)) errors.push(`finding_id 格式非法：${meta.findingId}`);

  if (!meta.module.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(meta.module)) {
    errors.push(`module 必须是非空小写模块标志：${meta.module}`);
  }
  if (!meta.title.trim()) {
    errors.push('title 不能为空');
  } else if (meta.module) {
    const prefix = `${meta.module}: `;
    if (!meta.title.startsWith(prefix) || !meta.title.slice(prefix.length).trim()) {
      errors.push(`title 必须以 "${prefix}" 开头且包含非空标题正文`);
    }
  }
  if (!AUDIT_TYPES.includes(meta.auditType as (typeof AUDIT_TYPES)[number])) {
    errors.push(`audit_type 非法：${meta.auditType}`);
  }
  if (!ISSUE_KINDS.includes(meta.issueKind)) {
    errors.push(`issue_kind 非法：${meta.issueKind}`);
  }
  if (!REVIEW_PRIORITIES.includes(meta.priority)) {
    errors.push(`priority 非法：${meta.priority}`);
  }
  if (!REVIEW_STATUS_LIST.includes(meta.status)) {
    errors.push(`status 非法：${meta.status}`);
  }
  if (!meta.baseRevision.trim()) errors.push('base_revision 不能为空');
  if (!meta.owner.trim()) errors.push('owner 不能为空');

  // I7: depends_on
  if (meta.issueKind === 'deferred') {
    if (!meta.dependsOn || !FINDING_ID_PATTERN.test(meta.dependsOn)) {
      errors.push('issue_kind 为 deferred 时 depends_on 必须是合法前置 finding_id');
    } else if (meta.dependsOn === meta.findingId) {
      errors.push('depends_on 不能等于自身 finding_id');
    }
  } else if (meta.dependsOn !== null) {
    errors.push(`issue_kind 为 ${meta.issueKind} 时 depends_on 必须为 null`);
  }

  // I13: timestamps
  const createdMs = parseTime(meta.createdAt, 'created_at', errors);
  const updatedMs = parseTime(meta.updatedAt, 'updated_at', errors);
  if (createdMs !== null && updatedMs !== null && updatedMs < createdMs) {
    errors.push('updated_at 不能早于 created_at');
  }

  // I5: target_files non-empty, unique, safe relative paths
  const targetFileSet = new Set<string>();
  if (meta.targetFiles.length === 0) {
    errors.push('target_files 不能为空');
  } else {
    for (const file of meta.targetFiles) {
      validateSafeBusinessPath(file, 'target_files', errors);
      if (targetFileSet.has(file)) errors.push(`target_files 存在重复路径：${file}`);
      targetFileSet.add(file);
    }
  }

  // I3: record_revision
  if (!Number.isInteger(meta.recordRevision) || meta.recordRevision < 1) {
    errors.push('record_revision 必须是正整数');
  }

  // I3 & I4: patches[]
  const patchById = new Map<number, (typeof meta.patches)[number]>();
  meta.patches.forEach((patch, idx) => {
    const expectedId = idx + 1;
    if (patch.id !== expectedId) {
      errors.push(`patches[${String(idx)}].id 必须从 1 连续递增（期望 ${String(expectedId)}，实际 ${String(patch.id)}）`);
    }
    const expectedFile = formatPatchFilename(expectedId);
    if (patch.patch !== expectedFile) {
      errors.push(`patches[${String(idx)}].patch 应为 ${expectedFile}，实际为 ${patch.patch}`);
    }
    if (!OPTION_ID_PATTERN.test(patch.optionId)) {
      errors.push(`patches[${String(idx)}].option_id 格式非法：${patch.optionId}`);
    }
    if (!patch.baseRevision.trim()) {
      errors.push(`patches[${String(idx)}].base_revision 不能为空`);
    }
    if (!SHA256_PATTERN.test(patch.sha256)) {
      errors.push(`patches[${String(idx)}].sha256 必须是 64 位小写十六进制摘要`);
    }
    patchById.set(patch.id, patch);
  });

  // 收集历史批准周期明确退役的 option_id（含历史周期未合入的备选方案；同基线重开新增的新方案不会误判，I6）。
  const historicApprovedOptionIds = new Set(meta.approvalHistory.map((h) => h.optionId));
  const historicApprovedPatchIds = new Set(meta.approvalHistory.map((h) => h.patchId));
  const maxHistoricPatchId = meta.approvalHistory.reduce((max, h) => Math.max(max, h.patchId), 0);
  const maxHistoricAttemptId = meta.approvalHistory.reduce((max, h) => Math.max(max, h.repairAttemptId), 0);
  const maxHistoricRevision = meta.approvalHistory.reduce((max, h) => Math.max(max, h.recordRevision), 0);
  const historicBaseRevisions = new Set(meta.approvalHistory.map((h) => h.baseRevision));
  if (meta.approvalHistory.length > 0) {
    for (const patch of meta.patches) {
      if (
        patch.id <= maxHistoricPatchId
        || (historicBaseRevisions.has(patch.baseRevision) && patch.baseRevision !== meta.baseRevision)
      ) {
        historicApprovedOptionIds.add(patch.optionId);
      }
    }
    for (const attempt of meta.repairAttempts) {
      if (attempt.id <= maxHistoricAttemptId) historicApprovedOptionIds.add(attempt.optionId);
    }
    for (const comment of meta.comments) {
      if (comment.optionId && comment.revision <= maxHistoricRevision) {
        historicApprovedOptionIds.add(comment.optionId);
      }
    }
  }

  // I6: options[]
  if (meta.issueKind === 'repair') {
    if (meta.options.length < 1 || meta.options.length > 2) {
      errors.push(`issue_kind 为 repair 时 options 数量必须为 1–2，当前为 ${String(meta.options.length)}`);
    }
  } else if (meta.options.length !== 0) {
    errors.push(`issue_kind 为 ${meta.issueKind} 时 options 必须为空数组`);
  }

  const seenOptionIds = new Set<string>();
  meta.options.forEach((option, idx) => {
    if (!OPTION_ID_PATTERN.test(option.id)) {
      errors.push(`options[${String(idx)}].id 格式非法：${option.id}`);
    }
    if (seenOptionIds.has(option.id)) {
      errors.push(`options 存在重复 id：${option.id}`);
    }
    seenOptionIds.add(option.id);
    if (historicApprovedOptionIds.has(option.id)) {
      errors.push(`options[${String(idx)}].id（${option.id}）已在往期批准历史中退役，不得复用`);
    }
    if (!option.title.trim()) errors.push(`options[${String(idx)}].title 不能为空`);
    if (!option.tradeoff.trim()) errors.push(`options[${String(idx)}].tradeoff 不能为空`);
    if (typeof option.confidence !== 'number' || !Number.isFinite(option.confidence) || option.confidence < 0 || option.confidence > 1) {
      errors.push(`options[${String(idx)}].confidence 必须是 0 到 1 之间的有限数`);
    }
    const targetPatch = patchById.get(option.currentPatch);
    if (!targetPatch) {
      errors.push(`options[${String(idx)}].current_patch（${String(option.currentPatch)}）在 patches[] 中不存在`);
    } else if (targetPatch.optionId !== option.id) {
      errors.push(`options[${String(idx)}].current_patch 指向的补丁属于 ${targetPatch.optionId}，与 ${option.id} 不符`);
    }
    if (historicApprovedPatchIds.has(option.currentPatch)) {
      errors.push(`options[${String(idx)}].current_patch 不得指向 approval_history 中已落地的旧补丁`);
    }
    if (option.gateChecks.length === 0 || option.gateChecks.some((cmd) => !cmd.trim())) {
      errors.push(`options[${String(idx)}].gate_checks 必须非空且每条命令非空`);
    }
  });

  // I5: observations[] & evidence coverage
  meta.observations.forEach((obs, idx) => {
    if (!obs.auditId.trim()) errors.push(`observations[${String(idx)}].audit_id 不能为空`);
    if (!obs.baseRevision.trim()) errors.push(`observations[${String(idx)}].base_revision 不能为空`);
    parseTime(obs.at, `observations[${String(idx)}].at`, errors);
    if (!obs.reason.trim()) errors.push(`observations[${String(idx)}].reason 不能为空`);
    if ((obs.verdict === 'confirmed' || obs.verdict === 'resolved') && obs.evidence.length === 0) {
      errors.push(`observations[${String(idx)}] 结论为 ${obs.verdict} 时必须包含至少一条代码证据`);
    }
    obs.evidence.forEach((ev, evIdx) => {
      const ok = validateSafeBusinessPath(ev.path, `observations[${String(idx)}].evidence[${String(evIdx)}].path`, errors);
      if (ok && !targetFileSet.has(ev.path)) {
        errors.push(`target_files 未覆盖观察证据路径：${ev.path}`);
      }
      if (!Number.isInteger(ev.line) || ev.line < 1) {
        errors.push(`observations[${String(idx)}].evidence[${String(evIdx)}].line 必须是正整数`);
      }
      if (!ev.excerpt.trim()) errors.push(`observations[${String(idx)}].evidence[${String(evIdx)}].excerpt 不能为空`);
      if (!ev.reason.trim()) errors.push(`observations[${String(idx)}].evidence[${String(evIdx)}].reason 不能为空`);
    });
  });

  meta.decisions.forEach((decision, idx) => {
    const field = `decisions[${String(idx)}]`;
    if (!decision.actor.trim()) errors.push(`${field}.actor 不能为空`);
    parseTime(decision.at, `${field}.at`, errors);
    if (decision.action !== 'human_takeover' && !decision.reason.trim()) {
      errors.push(`${field}（${decision.action}）的 reason 不能为空`);
    }
    if (decision.action !== 'defer') {
      if (decision.reviewAfter !== undefined) errors.push(`${field}.review_after 仅允许用于 defer`);
      if (decision.reviewWhen !== undefined) errors.push(`${field}.review_when 仅允许用于 defer`);
    } else if (decision.reviewWhen !== undefined && !decision.reviewWhen.trim()) {
      errors.push(`${field}.review_when 若提供则不能为空`);
    }
    if (decision.action !== 'accept_as_is') {
      if (decision.category !== undefined) errors.push(`${field}.category 仅允许用于 accept_as_is`);
      if (decision.relatedSymbols !== undefined) errors.push(`${field}.related_symbols 仅允许用于 accept_as_is`);
    } else if (decision.relatedSymbols !== undefined) {
      if (decision.relatedSymbols.length > 16) {
        errors.push(`${field}.related_symbols 最多允许 16 条`);
      }
      const seenSymbols = new Set<string>();
      for (const sym of decision.relatedSymbols) {
        const trimmed = sym.trim();
        if (!trimmed || trimmed.length > 120 || trimmed !== sym || seenSymbols.has(trimmed)) {
          errors.push(`${field}.related_symbols 包含空值、超长或重复符号`);
          break;
        }
        seenSymbols.add(trimmed);
      }
    }
  });

  // I3: repair_attempts[]
  meta.repairAttempts.forEach((attempt, idx) => {
    const expectedId = idx + 1;
    if (attempt.id !== expectedId) {
      errors.push(`repair_attempts[${String(idx)}].id 必须从 1 连续递增（期望 ${String(expectedId)}，实际 ${String(attempt.id)}）`);
    }
    if (!OPTION_ID_PATTERN.test(attempt.optionId)) {
      errors.push(`repair_attempts[${String(idx)}].option_id 格式非法`);
    }
    const patch = patchById.get(attempt.patchId);
    if (!patch || patch.optionId !== attempt.optionId) {
      errors.push(`repair_attempts[${String(idx)}] 指向的补丁不存在或与 option_id 不匹配`);
    }
    if (!attempt.baseRevision.trim()) errors.push(`repair_attempts[${String(idx)}].base_revision 不能为空`);
    if (!attempt.actor.trim()) errors.push(`repair_attempts[${String(idx)}].actor 不能为空`);
    parseTime(attempt.at, `repair_attempts[${String(idx)}].at`, errors);
    if (attempt.result === 'applied' && attempt.restored !== false) {
      errors.push(`repair_attempts[${String(idx)}] result=applied 时 restored 必须为 false`);
    }
    if (!attempt.evidence.trim()) errors.push(`repair_attempts[${String(idx)}].evidence 不能为空`);
  });

  // I10: human_decisions[]
  const decisionIds = new Set<string>();
  meta.humanDecisions.forEach((item, idx) => {
    if (!item.id.trim()) errors.push(`human_decisions[${String(idx)}].id 不能为空`);
    else if (decisionIds.has(item.id)) errors.push(`human_decisions 存在重复 id：${item.id}`);
    decisionIds.add(item.id);
    if (!item.question.trim()) errors.push(`human_decisions[${String(idx)}].question 不能为空`);
  });

  // I11: comments[]
  const commentIds = new Set<string>();
  meta.comments.forEach((comment, idx) => {
    const field = `comments[${String(idx)}]`;
    if (!comment.id.trim()) errors.push(`${field}.id 不能为空`);
    else if (commentIds.has(comment.id)) errors.push(`comments 存在重复 id：${comment.id}`);
    commentIds.add(comment.id);
    if (!Number.isInteger(comment.revision) || comment.revision < 1 || comment.revision > meta.recordRevision) {
      errors.push(`${field}.revision 必须在 1..${String(meta.recordRevision)} 之间`);
    }
    if (!comment.author.trim()) errors.push(`${field}.author 不能为空`);
    if (!comment.content.trim()) errors.push(`${field}.content 不能为空`);
    if (comment.createdAt !== undefined) parseTime(comment.createdAt, `${field}.created_at`, errors);

    const isGeneral = comment.file === '' && comment.line === 0;
    if (isGeneral) {
      if (comment.side !== undefined || comment.anchor !== undefined || comment.optionId !== undefined || comment.patchId !== undefined) {
        errors.push(`${field} 为总体评论时不得包含 side / anchor / option_id / patch_id`);
      }
    } else {
      validateSafeBusinessPath(comment.file, `${field}.file`, errors);
      if (!Number.isInteger(comment.line) || comment.line < 1) errors.push(`${field} 行内评论 line 必须是正整数`);
      if (comment.side !== 'LEFT' && comment.side !== 'RIGHT') errors.push(`${field} 行内评论必须提供合法 side（LEFT/RIGHT）`);
      if (!comment.optionId || !OPTION_ID_PATTERN.test(comment.optionId)) {
        errors.push(`${field} 行内评论必须提供合法 option_id`);
      }
      if (typeof comment.patchId !== 'number' || !Number.isInteger(comment.patchId) || comment.patchId < 1) {
        errors.push(`${field} 行内评论必须提供正整数 patch_id`);
      } else {
        const patch = patchById.get(comment.patchId);
        if (!patch || patch.optionId !== comment.optionId) {
          errors.push(`${field} 行内评论的 (option_id, patch_id) 未指向归属一致的真实补丁`);
        }
      }
      if (comment.anchor !== undefined && !comment.anchor.snippet.trim()) {
        errors.push(`${field}.anchor.snippet 不能为空`);
      }
    }
  });

  // I8 & I9: approval / approval_history / rejection
  if (meta.status === 'approved' && meta.approval === null) {
    errors.push('status 为 approved 时 approval 不能为空');
  }
  if (meta.status !== 'approved' && meta.approval !== null) {
    errors.push(`status 为 ${meta.status} 时 approval 必须为 null`);
  }
  if (meta.status === 'rejected' && meta.rejection === null) {
    errors.push('status 为 rejected 时 rejection 不能为空');
  }
  if (meta.status !== 'rejected' && meta.rejection !== null) {
    errors.push(`status 为 ${meta.status} 时 rejection 必须为 null`);
  }
  if (meta.approval !== null && meta.rejection !== null) {
    errors.push('approval 与 rejection 互斥，不能同时非空');
  }

  if (meta.approval !== null) {
    validateApprovalSnapshot(meta.approval, meta, 'approval', true, errors);
  }
  meta.approvalHistory.forEach((item, idx) => {
    validateApprovalSnapshot(item, meta, `approval_history[${String(idx)}]`, false, errors);
  });

  if (meta.rejection !== null) {
    if (!meta.rejection.rejectedBy.trim()) errors.push('rejection.rejected_by 不能为空');
    const rejMs = parseTime(meta.rejection.rejectedAt, 'rejection.rejected_at', errors);
    if (!meta.rejection.reason.trim()) errors.push('rejection.reason 不能为空');
    if (meta.status === 'rejected') {
      const latestAcceptAsIs = [...meta.decisions].reverse().find((d) => d.action === 'accept_as_is');
      if (!latestAcceptAsIs) {
        errors.push('I8: status 为 rejected 时 decisions[] 必须包含同步的 accept_as_is 记录');
      } else {
        const decMs = Date.parse(latestAcceptAsIs.at);
        if (
          latestAcceptAsIs.actor !== meta.rejection.rejectedBy
          || latestAcceptAsIs.reason !== meta.rejection.reason
          || (rejMs !== null && Number.isFinite(decMs) && decMs !== rejMs)
        ) {
          errors.push('I8: rejection 必须与 decisions[] 中最新 accept_as_is 决定保持同步');
        }
      }
    }
  }

  // I9: commit_message
  if (meta.options.length > 0) {
    if (meta.commitMessage === null || !meta.commitMessage.trim()) {
      errors.push('存在有效修复方案时 commit_message 必须为非空字符串');
    } else {
      const firstLine = meta.commitMessage.replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? '';
      if (firstLine !== meta.title.trim()) {
        errors.push(`commit_message 首行必须与 title 完全一致（期望 "${meta.title.trim()}"）`);
      }
    }
  } else if (meta.commitMessage !== null) {
    if (!meta.commitMessage.trim()) {
      errors.push('commit_message 非 null 时不能为空白字符串');
    } else {
      const firstLine = meta.commitMessage.replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? '';
      if (firstLine !== meta.title.trim()) {
        errors.push(`commit_message 首行必须与 title 完全一致（期望 "${meta.title.trim()}"）`);
      }
    }
  }

  return errors;
}

export interface FullInvariantInput extends QuickInvariantInput {
  /** 问题目录下实际存在的 .patch 文件名列表。 */
  patchFilesOnDisk: string[];
  /** 读取补丁原始字节，用于 I4 sha256 与补丁路径/范围校验。 */
  readPatchBytes: (patchName: string) => Promise<Buffer | null>;
}

/** 含磁盘/快照补丁字节与路径覆盖的完整不变量校验（I4、I5、I12）。 */
export async function fullReviewInvariants(input: FullInvariantInput): Promise<string[]> {
  const errors = quickReviewInvariants(input);
  const { meta, patchFilesOnDisk, readPatchBytes } = input;
  const declaredPatchNames = new Set(meta.patches.map((p) => p.patch));
  for (const diskFile of patchFilesOnDisk) {
    if (/\.patch$/i.test(diskFile) && !declaredPatchNames.has(diskFile)) {
      errors.push(`问题目录存在未在 patches[] 中登记的孤立补丁文件：${diskFile}`);
    }
  }

  const targetFileSet = new Set(meta.targetFiles);
  const activeOptionPatchIds = new Set(meta.options.map((o) => o.currentPatch));

  for (const entry of meta.patches) {
    const raw = await readPatchBytes(entry.patch);
    if (raw === null) {
      errors.push(`补丁文件缺失：${entry.patch}`);
      continue;
    }
    const actualSha = sha256Hex(raw);
    if (actualSha !== entry.sha256) {
      errors.push(`补丁 ${entry.patch} 的 SHA-256 摘要不匹配（声明 ${entry.sha256}，实际 ${actualSha}）`);
    }
    const text = raw.toString('utf8');
    const parsed = parsePatch(text);
    if (parsed.paths.length === 0) {
      errors.push(`补丁 ${entry.patch} 未包含任何有效文件变更`);
    }
    if (parsed.unsafeModes.length > 0) {
      errors.push(`补丁 ${entry.patch} 包含禁止的文件模式（${parsed.unsafeModes.join(', ')}）`);
    }
    for (const file of parsed.paths) {
      validateSafeBusinessPath(file, `补丁 ${entry.patch}`, errors);
      if (activeOptionPatchIds.has(entry.id) && !targetFileSet.has(file)) {
        errors.push(`target_files 未覆盖当前有效方案补丁 ${entry.patch} 触及的路径：${file}`);
      }
    }
  }

  return errors;
}
