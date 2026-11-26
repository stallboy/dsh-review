import { FINDING_ID_PATTERN, parseTime } from './invariants.js';
import { dump, readYamlDocument } from './yaml.js';

export type FindingDecision =
    | { action: 'accept_as_is'; reason: string }
    | { action: 'defer'; reason: string; reviewAfter?: string; reviewWhen?: string }
    | { action: 'human_takeover'; reason?: string }
    | { action: 'external_completed'; reason: string }
    | { action: 'add_repair_hint'; hint: string }
    | { action: 'resume_review'; reason: string };

export type FindingEvent = FindingDecision & { revision: number; auditId: string; actor: string; at: string };
export type FindingDisposition = 'undecided' | 'accept_as_is' | 'defer' | 'human_takeover' | 'applied' | 'resolved';

export function findingRecordPath(findingId: string): string {
    if (!FINDING_ID_PATTERN.test(findingId)) throw new Error('发现编号无效');
    return `.ai-review/findings/${findingId}.yml`;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
        throw new Error('发现处置记录必须是对象');
    }
    return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
    return value;
}

function parseDecision(input: Record<string, unknown>): FindingDecision {
    switch (input['action']) {
        case 'accept_as_is':
        case 'resume_review':
        case 'external_completed':
            return { action: input['action'], reason: nonEmpty(input['reason'], 'reason') };
        case 'defer': {
            const date = input['review_after'];
            const reviewAfter = date instanceof Date ? date.toISOString().slice(0, 10)
                : date === undefined ? undefined : nonEmpty(date, 'review_after');
            if (reviewAfter !== undefined) {
                const parsed = new Date(`${reviewAfter}T00:00:00.000Z`);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewAfter) || !Number.isFinite(parsed.getTime())
                    || parsed.toISOString().slice(0, 10) !== reviewAfter) {
                    throw new Error('review_after 必须是有效的 UTC 日期');
                }
            }
            const condition = input['review_when'];
            return {
                action: 'defer',
                reason: nonEmpty(input['reason'], 'reason'),
                ...(reviewAfter !== undefined ? { reviewAfter } : {}),
                ...(condition !== undefined ? { reviewWhen: nonEmpty(condition, 'review_when') } : {}),
            };
        }
        case 'human_takeover':
            return {
                action: 'human_takeover',
                ...(input['reason'] !== undefined ? { reason: nonEmpty(input['reason'], 'reason') } : {}),
            };
        case 'add_repair_hint':
            return { action: 'add_repair_hint', hint: nonEmpty(input['hint'], 'hint') };
        default:
            throw new Error('发现处置动作无效');
    }
}

export function findingDecisionFromRequest(input: Record<string, unknown>): FindingDecision {
    return parseDecision({ ...input, review_after: input['reviewAfter'], review_when: input['reviewWhen'] });
}

export function serializeFindingEvents(findingId: string, events: FindingEvent[]): string {
    return dump({
        schema_version: 1,
        finding_id: findingId,
        events: events.map(({ auditId, ...event }) => {
            const { reviewAfter, reviewWhen } = event.action === 'defer' ? event : { reviewAfter: undefined, reviewWhen: undefined };
            const { revision, actor, at, action } = event;
            return {
                revision, audit_id: auditId, actor, at, action,
                ...('reason' in event && event.reason !== undefined ? { reason: event.reason } : {}),
                ...('hint' in event ? { hint: event.hint } : {}),
                ...(reviewAfter !== undefined ? { review_after: reviewAfter } : {}),
                ...(reviewWhen !== undefined ? { review_when: reviewWhen } : {}),
            };
        }),
    }, { lineWidth: -1, noRefs: true });
}

export function parseFindingEvents(text: string, findingId: string): FindingEvent[] {
    const doc = record(readYamlDocument(text));
    if (doc['schema_version'] !== 1 || !FINDING_ID_PATTERN.test(findingId) || doc['finding_id'] !== findingId
        || !Array.isArray(doc['events'])) {
        throw new Error('发现处置记录版本、编号或事件列表无效');
    }
    let disposition: FindingDisposition = 'undecided';
    return doc['events'].map((value, index) => {
        const input = record(value);
        const revision = index + 1;
        if (input['revision'] !== revision) throw new Error('发现处置事件版本必须连续');
        const auditId = nonEmpty(input['audit_id'], 'audit_id');
        const actor = nonEmpty(input['actor'], 'actor');
        const rawAt = input['at'];
        const at = rawAt instanceof Date ? rawAt.toISOString() : nonEmpty(rawAt, 'at');
        if (!parseTime(at, 'at', [])) throw new Error('发现处置事件时间无效');
        const decision = parseDecision(input);
        if (decision.action === 'add_repair_hint') {
            if (disposition !== 'human_takeover') throw new Error('仅可为人工接手的发现补充线索');
        } else if (decision.action === 'resume_review') {
            if (disposition === 'undecided') throw new Error('发现已经处于待审核状态');
            disposition = 'undecided';
        } else {
            disposition = decision.action === 'external_completed' ? 'human_takeover' : decision.action;
        }
        return { revision, auditId, actor, at, ...decision };
    });
}

export async function loadFindingEvents(
    source: Pick<import('./shared-facts.js').SharedCandidateSource, 'readFindingText'>,
    records: import('./audit-archive.js').AuditRecord[],
): Promise<Map<string, FindingEvent[] | Error>> {
    const ids = new Set(records.filter(record => !record.parseError && record.meta.schemaVersion === 2)
        .flatMap(record => record.meta.items.filter(item => item.repairPlan !== undefined).map(item => item.findingId)));
    const events = new Map<string, FindingEvent[] | Error>();
    for (const id of ids) {
        try {
            const text = await source.readFindingText(id);
            if (text !== null) events.set(id, parseFindingEvents(text, id));
        } catch (error) {
            events.set(id, error instanceof Error ? error : new Error(String(error)));
        }
    }
    return events;
}
