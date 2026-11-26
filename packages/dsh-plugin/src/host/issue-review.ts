import { createHash } from 'node:crypto';
import type { IssueReview, IssueSelection, RepairOption, ReviewCandidate, ReviewFrontmatter, RevisionEntry } from './types.js';
import type { FindingProjection } from './audit-archive.js';
import { isRepoRelativePath } from './patch.js';
import path from 'node:path';
import { ApiError } from './types.js';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = ['pending', 'changes_requested', 'approved', 'rejected', 'repair_failed', 'human_takeover', 'awaiting_verification', 'resolved'];

function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
    return value as Record<string, unknown>;
}

function string(value: unknown, field: string, empty = false): string {
    if (typeof value !== 'string' || (!empty && !value.trim())) throw new Error(`${field} 必须是${empty ? '' : '非空'}字符串`);
    return value;
}

function array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
    return value;
}

function number(value: unknown, field: string, minimum = 1): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${field} 必须是大于等于 ${minimum} 的整数`);
    return Number(value);
}

function extra(value: Record<string, unknown>, keys: string[]): { extra?: Record<string, unknown> } {
    const unknown = Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    return Object.keys(unknown).length ? { extra: unknown } : {};
}

function timestamp(value: unknown, field: string): string {
    const text = string(value, field);
    if (!Number.isFinite(Date.parse(text))) throw new Error(field + ' 必须是有效时间');
    return text;
}

export function parseIssueReview(doc: Record<string, unknown>): IssueReview {
    const priority = string(doc['priority'], 'priority');
    if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) throw new Error('priority 必须为 P0–P3');
    if (!STATUSES.includes(String(doc['status']))) throw new Error('问题状态无效');
    const options = array(doc['options'], 'options').map((value): RepairOption => {
        const item = object(value, 'option');
        const id = string(item['id'], 'option.id');
        if (!ID.test(id)) throw new Error('方案编号无效');
        const confidence = item['confidence'];
        if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('方案置信度须在 0 到 1 之间');
        return {
            ...extra(item, ['id', 'title', 'tradeoff', 'confidence', 'current_patch', 'gate_checks']),
            id, title: string(item['title'], 'option.title'), tradeoff: string(item['tradeoff'], 'option.tradeoff'), confidence,
            currentPatch: number(item['current_patch'], 'option.current_patch'),
            gateChecks: array(item['gate_checks'], 'option.gate_checks').map(command => string(command, 'gate_check')),
        };
    });
    if (options.length > 2 || new Set(options.map(item => item.id)).size !== options.length) throw new Error('有效方案必须不超过两个且编号唯一');
    return {
        priority: priority as IssueReview['priority'], baseRevision: string(doc['base_revision'], 'base_revision'), options,
        observations: array(doc['observations'], 'observations').map(value => {
            const item = object(value, 'observation');
            const verdict = string(item['verdict'], 'observation.verdict');
            if (!['confirmed', 'resolved', 'unverified'].includes(verdict)) throw new Error('观察结论无效');
            return {
                ...extra(item, ['audit_id', 'base_revision', 'at', 'verdict', 'reason', 'evidence']),
                auditId: string(item['audit_id'], 'observation.audit_id'), baseRevision: string(item['base_revision'], 'observation.base_revision'),
                at: timestamp(item['at'], 'observation.at'), verdict: verdict as 'confirmed' | 'resolved' | 'unverified', reason: string(item['reason'], 'observation.reason'),
                evidence: array(item['evidence'], 'observation.evidence').map(value => {
                    const evidence = object(value, 'evidence');
                    const file = string(evidence['path'], 'evidence.path');
                    if (!isRepoRelativePath(file) || path.win32.parse(file).root) throw new Error('证据路径必须在项目内');
                    return { ...extra(evidence, ['path', 'line', 'excerpt', 'reason']), path: file, line: number(evidence['line'], 'evidence.line'),
                        excerpt: string(evidence['excerpt'], 'evidence.excerpt'), reason: string(evidence['reason'], 'evidence.reason') };
                }),
            };
        }),
        decisions: array(doc['decisions'], 'decisions').map(value => {
            const item = object(value, 'decision');
            const action = string(item['action'], 'decision.action');
            if (!['accept_as_is', 'defer', 'human_takeover', 'external_completed', 'add_repair_hint', 'resume_review'].includes(action)) throw new Error('问题处置动作无效');
            return { ...extra(item, ['action', 'actor', 'at', 'reason', 'review_after', 'review_when']), action: action as IssueReview['decisions'][number]['action'], actor: string(item['actor'], 'decision.actor'),
                at: timestamp(item['at'], 'decision.at'), reason: string(item['reason'], 'decision.reason', true),
                ...(item['review_after'] !== undefined ? { reviewAfter: string(item['review_after'], 'decision.review_after') } : {}),
                ...(item['review_when'] !== undefined ? { reviewWhen: string(item['review_when'], 'decision.review_when') } : {}) };
        }),
        repairAttempts: array(doc['repair_attempts'], 'repair_attempts').map(value => {
            const item = object(value, 'repair_attempt');
            if (!['applied', 'verification_failed'].includes(String(item['result'])) || typeof item['restored'] !== 'boolean') throw new Error('修复结果无效');
            return { ...extra(item, ['option_id', 'patch_id', 'base_revision', 'at', 'actor', 'result', 'restored', 'evidence']), optionId: string(item['option_id'], 'repair_attempt.option_id'), patchId: number(item['patch_id'], 'repair_attempt.patch_id'),
                baseRevision: string(item['base_revision'], 'repair_attempt.base_revision'), at: timestamp(item['at'], 'repair_attempt.at'),
                actor: string(item['actor'], 'repair_attempt.actor'), result: item['result'] as 'applied' | 'verification_failed',
                restored: item['restored'], evidence: string(item['evidence'], 'repair_attempt.evidence') };
        }),
    };
}

export function issueReviewFields(issue: IssueReview): Record<string, unknown> {
    return {
        priority: issue.priority, base_revision: issue.baseRevision,
        options: issue.options.map(option => ({ ...option.extra, id: option.id, title: option.title, tradeoff: option.tradeoff,
            confidence: option.confidence, current_patch: option.currentPatch, gate_checks: option.gateChecks })),
        observations: issue.observations.map(observation => ({ ...observation.extra, audit_id: observation.auditId, base_revision: observation.baseRevision,
            at: observation.at, verdict: observation.verdict, reason: observation.reason, evidence: observation.evidence.map(({ extra, ...item }) => ({ ...extra, ...item })) })),
        decisions: issue.decisions.map(decision => ({ ...decision.extra, action: decision.action, actor: decision.actor, at: decision.at, reason: decision.reason,
            ...(decision.reviewAfter ? { review_after: decision.reviewAfter } : {}), ...(decision.reviewWhen ? { review_when: decision.reviewWhen } : {}) })),
        repair_attempts: issue.repairAttempts.map(attempt => ({ ...attempt.extra, option_id: attempt.optionId, patch_id: attempt.patchId,
            base_revision: attempt.baseRevision, at: attempt.at, actor: attempt.actor, result: attempt.result, restored: attempt.restored, evidence: attempt.evidence })),
    };
}

export function selectIssuePatch(meta: ReviewFrontmatter, selection: IssueSelection): { option: RepairOption; revision: RevisionEntry } {
    const option = meta.issue?.options.find(item => item.id === selection.optionId);
    const revision = meta.revisions.find(item => item.id === selection.patchId);
    if (meta.schemaVersion !== 3 || !option || option.currentPatch !== selection.patchId || !revision
        || revision.extra?.['option_id'] !== option.id) throw new ApiError(409, 'stale', '所选方案或补丁已更新，请重新选择');
    return { option, revision };
}

export function issueSelection(value: Record<string, unknown>): IssueSelection | undefined {
    if (value['optionId'] === undefined && value['patchId'] === undefined) return undefined;
    const optionId = value['optionId'];
    const patchId = Number(value['patchId']);
    if (typeof optionId !== 'string' || !ID.test(optionId) || !Number.isSafeInteger(patchId) || patchId < 1) throw new ApiError(422, 'bad_request', '方案与补丁编号无效');
    return { optionId, patchId };
}

export function requireIssueSelection(meta: ReviewFrontmatter, selection?: IssueSelection): IssueSelection | undefined {
    if (meta.schemaVersion !== 3) return undefined;
    if (!selection) throw new ApiError(422, 'bad_request', '请显式选择修复方案和当前补丁');
    selectIssuePatch(meta, selection);
    return selection;
}

export function defaultIssueSelection(meta: ReviewFrontmatter): IssueSelection | undefined {
    if (meta.approval?.extra?.['option_id'] && meta.approval.extra['patch_id']) {
        return { optionId: String(meta.approval.extra['option_id']), patchId: Number(meta.approval.extra['patch_id']) };
    }
    const option = meta.issue?.options[0];
    return option ? { optionId: option.id, patchId: option.currentPatch } : undefined;
}

export function currentReviewPatch(meta: ReviewFrontmatter, selection?: IssueSelection): RevisionEntry | undefined {
    if (meta.schemaVersion !== 3) return meta.revisions.find(item => item.id === meta.currentRevision);
    const selected = selection ?? defaultIssueSelection(meta);
    return selected ? selectIssuePatch(meta, selected).revision : undefined;
}

export function issueVersion(meta: ReviewFrontmatter): string {
    return createHash('sha256').update(JSON.stringify(meta)).digest('hex');
}

export function projectIssue(candidate: ReviewCandidate): FindingProjection {
    const { meta } = candidate;
    const issue = meta.issue!;
    const last = issue.observations.at(-1);
    const decision = issue.decisions.filter(item => item.action !== 'add_repair_hint').at(-1);
    const closed = meta.status === 'approved' || meta.status === 'resolved';
    const disposition = closed ? meta.status === 'approved' ? 'applied' : 'resolved'
        : meta.status === 'human_takeover' || meta.status === 'awaiting_verification' || meta.status === 'repair_failed' ? 'human_takeover'
        : decision?.action === 'accept_as_is' || decision?.action === 'defer' ? decision.action : 'undecided';
    return {
        findingId: meta.findingId!, title: meta.title, summary: candidate.sections.problem,
        targetFiles: [...meta.targetFiles], kind: issue.options.length ? 'repair' : 'confirm', dependsOn: null,
        state: closed ? 'closed' : disposition === 'accept_as_is' ? 'dismissed' : 'open',
        lastStatus: closed ? 'resolved' : 'pending', lastObservedAudit: last?.auditId ?? '', lastObservedAt: last?.at ?? meta.updatedAt,
        candidateStatus: meta.status, candidate: candidate.id, findingVersion: issueVersion(meta), disposition,
        repairPlan: candidate.sections.solution, baseRevision: issue.baseRevision, reviewId: candidate.id,
        schemaVersion: 3, issueStatus: meta.status,
        ...(decision ? { decision: { ...decision, revision: issue.decisions.indexOf(decision) + 1, auditId: last?.auditId ?? '' } as import('./finding-decisions.js').FindingEvent } : {}),
        repairHints: issue.decisions.filter(item => item.action === 'add_repair_hint').map(item => item.reason),
        options: issue.options.map(option => ({ candidateId: candidate.id, optionId: option.id, patchId: option.currentPatch,
            title: option.title, tradeoff: option.tradeoff, confidence: option.confidence, status: meta.status })),
    };
}

export function readIssueSelection(meta: ReviewFrontmatter, query: Record<string, unknown>): IssueSelection | undefined {
    if (meta.schemaVersion === 3 && typeof query['optionId'] === 'string' && query['patchId'] === undefined) {
        const option = meta.issue?.options.find(item => item.id === query['optionId']);
        if (!option) throw new ApiError(409, 'conflict', '方案已变化，请重新选择');
        return { optionId: option.id, patchId: option.currentPatch };
    }
    return issueSelection(query);
}

export function issueInvariantErrors(meta: ReviewFrontmatter): string[] {
    const errors: string[] = [];
    const issue = meta.issue;
    if (meta.schemaVersion !== 3 || !issue) return ['问题缺少 schema3 数据'];
    if (!ID.test(meta.findingId ?? '')) errors.push('问题编号无效');
    if (!Number.isSafeInteger(meta.currentRevision) || meta.currentRevision < 1) errors.push('问题记录版本必须为正整数');
    if (issue.options.length > 2 || new Set(issue.options.map(item => item.id)).size !== issue.options.length) errors.push('最多两个唯一有效方案');
    for (const [index, revision] of meta.revisions.entries()) {
        if (revision.id !== index + 1 || revision.patch !== `${String(revision.id).padStart(3, '0')}.patch`
            || !ID.test(String(revision.extra?.['option_id'] ?? ''))) errors.push('补丁账本必须按独立编号递增并保留所属方案');
    }
    for (const option of issue.options) {
        try { selectIssuePatch(meta, { optionId: option.id, patchId: option.currentPatch }); }
        catch { errors.push(`方案 ${option.id} 引用的当前补丁无效`); }
        if (!option.gateChecks.length) errors.push(`方案 ${option.id} 缺少修复阶段门禁`);
    }
    if (meta.status === 'approved' && !meta.approval) errors.push('已解决问题缺少批准证据');
    if (meta.status === 'approved' && meta.approval) {
        const approval = meta.approval.extra;
        try { selectIssuePatch(meta, { optionId: String(approval?.['option_id'] ?? ''), patchId: Number(approval?.['patch_id']) }); }
        catch { errors.push('批准证据必须绑定有效方案和补丁'); }
        if (!Number.isSafeInteger(approval?.['record_revision']) || Number(approval?.['record_revision']) >= meta.currentRevision
            || !/^[a-f0-9]{64}$/.test(String(approval?.['patch_sha256'] ?? '')) || !approval?.['base_revision']) errors.push('批准证据缺少问题版本、补丁摘要或应用基线');
    }
    if (meta.status === 'resolved' && (issue.observations.at(-1)?.verdict !== 'resolved'
        || !issue.decisions.some(item => item.action === 'external_completed'))) errors.push('外部解决必须有完成反馈及复查证据');
    if (meta.status === 'repair_failed' && !issue.repairAttempts.some(item => item.result === 'verification_failed')) errors.push('修复失败问题缺少失败记录');
    return errors;
}
