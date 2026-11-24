import { randomUUID } from 'node:crypto';
import { SCHEDULED_AUDIT_WAIT_MS, entityId, positiveInteger, type AuditPlanSettings, type AuditRecurrence, type CommandRecord,
    type JsonRecord, type ProjectRecord, type ScheduledAudit } from '@dsh-review/protocol';
import { digest, stableJson } from './auth.js';
import { assignCommandState, CentralDatabase, CentralError, type Row, type User } from './database.js';

const DAY_MS = 24 * 60 * 60_000;
const MAX_INTERVAL_DAYS = 365;
const LEGACY_PLAN_ID = 'legacy';
const LEGACY_PLAN_NAME = '每日全量审查';
const EXPIRED_REASON = 'SCHEDULE_WINDOW_EXPIRED';
const EXPIRED_MESSAGE = '30 分钟等待期已结束，本轮未启动';
const CHANGED_REASON = 'SCHEDULE_CHANGED';
const CHANGED_MESSAGE = '定时设置已修改，本轮未启动';
const NOTES_UNSUPPORTED = 'SCHEDULE_NOTES_UNSUPPORTED';
const SCHEDULE_KEY_PREFIX = 'scheduled-audit:';
const UNACCEPTED_SCHEDULED = "active_state IN ('queued','dispatched') AND json_extract(envelope,'$.scheduledAudit') IS NOT NULL";

interface SchedulePolicy extends AuditPlanSettings {
    planId: string;
    version: number;
    effectiveAt: string;
    reviewIdentity: string;
    lastMissedAt: string | null;
}

interface Slot extends ScheduledAudit {
    key: string;
}

type Run = Pick<CommandRecord, 'state' | 'result'> & { commandId: string; scheduledAt: string; expiresAt: string };

function keyPrefix(planId: string): string {
    return planId === LEGACY_PLAN_ID ? SCHEDULE_KEY_PREFIX : `${SCHEDULE_KEY_PREFIX}${planId}:`;
}

function keysFor(planId: string): string {
    return `${keyPrefix(planId)}????-??-??`;
}

function localMinute(formatter: Intl.DateTimeFormat, date: Date): number {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

function matchesDay(recurrence: AuditRecurrence, day: number): boolean {
    switch (recurrence.kind) {
        case 'daily': return true;
        case 'weekly': return recurrence.weekdays.includes(new Date(day).getUTCDay() || 7);
        case 'interval': {
            const anchor = Date.parse(`${recurrence.startDate}T00:00:00Z`);
            return day >= anchor && (day - anchor) % (recurrence.days * DAY_MS) === 0;
        }
    }
}

function slotAt(formatter: Intl.DateTimeFormat, policy: SchedulePolicy, day: number): Slot | null {
    if (!matchesDay(policy.recurrence, day)) return null;
    const date = new Date(day).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const wallTime = Date.parse(`${date}T${policy.startTime}:00Z`);
    const candidates = [-1, 0, 1].map(offsetDay => {
        const sample = wallTime + offsetDay * DAY_MS;
        const offset = localMinute(formatter, new Date(sample)) - sample;
        return wallTime - offset;
    }).filter(candidate => localMinute(formatter, new Date(candidate)) === wallTime);
    if (!candidates.length) return null;
    const start = Math.min(...candidates);
    const scheduledAt = new Date(start).toISOString();
    if (start < Date.parse(policy.effectiveAt)) return null;
    return { key: `${keyPrefix(policy.planId)}${date}`, scheduledAt, expiresAt: new Date(start + SCHEDULED_AUDIT_WAIT_MS).toISOString() };
}

function localCalendar(policy: SchedulePolicy, now: string) {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const today = Math.floor(localMinute(formatter, new Date(now)) / DAY_MS) * DAY_MS;
    return { today, slot: (day: number) => slotAt(formatter, policy, day) };
}

function planSettings(input: JsonRecord): AuditPlanSettings {
    const { name, enabled, startTime, timeZone, recurrence, note } = input;
    if (Object.keys(input).some(key => !['name', 'enabled', 'startTime', 'timeZone', 'recurrence', 'note'].includes(key))
        || typeof enabled !== 'boolean' || typeof startTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
        throw new CentralError(422, 'bad_request', '请填写启用状态和 HH:mm 格式的开始时间');
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof note !== 'string' || note.trim().length > 4000) {
        throw new CentralError(422, 'bad_request', '计划名称须为 1 至 80 字，审查要求最多 4000 字');
    }
    if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,79}$/.test(timeZone)) {
        throw new CentralError(422, 'bad_request', '请填写有效的 IANA 时区');
    }
    let zone: string;
    try { zone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; }
    catch { throw new CentralError(422, 'bad_request', '请填写有效的 IANA 时区'); }
    return { name: name.trim(), enabled, startTime, timeZone: zone, recurrence: readRecurrence(recurrence), note: note.trim() };
}

function readRecurrence(value: unknown): AuditRecurrence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CentralError(422, 'bad_request', '请选择执行频率');
    }
    const { kind, days, weekdays, startDate } = value as JsonRecord;
    const count = Object.keys(value).length;
    if (kind === 'daily' && count === 1) return { kind };
    if (kind === 'weekly' && count === 2 && Array.isArray(weekdays) && weekdays.length > 0 && weekdays.length <= 7
        && weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7) && new Set(weekdays).size === weekdays.length) {
        return { kind, weekdays: [...weekdays].sort((a, b) => a - b) };
    }
    if (kind === 'interval' && count === 3 && typeof days === 'number' && Number.isInteger(days) && days >= 2 && days <= MAX_INTERVAL_DAYS
        && typeof startDate === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(startDate)) {
        const anchor = new Date(`${startDate}T00:00:00Z`);
        if (Number.isFinite(anchor.valueOf()) && anchor.toISOString().slice(0, 10) === startDate) return { kind, days, startDate };
    }
    throw new CentralError(422, 'bad_request', '请选择至少一天的星期，或填写 2 至 365 天的间隔和有效起始日期');
}

function policyFrom(row: Row): SchedulePolicy {
    return { planId: row.plan_id, version: row.version, name: row.name, enabled: Boolean(row.enabled), startTime: row.start_time,
        timeZone: row.time_zone, recurrence: JSON.parse(row.recurrence), note: row.note, effectiveAt: row.effective_at,
        reviewIdentity: row.review_identity, lastMissedAt: row.last_missed_at };
}

export class AuditSchedules {
    constructor(private readonly database: CentralDatabase) {}

    private policy(projectId: string, planId: string): SchedulePolicy | null {
        const row = this.database.sql.prepare('SELECT * FROM audit_plans WHERE project_id=? AND plan_id=?').get(projectId, planId) as Row | undefined;
        return row ? policyFrom(row) : null;
    }

    private policies(projectId: string): SchedulePolicy[] {
        const rows = this.database.sql.prepare('SELECT * FROM audit_plans WHERE project_id=? ORDER BY rowid').all(projectId) as Row[];
        return rows.map(policyFrom);
    }

    update(project: ProjectRecord, input: JsonRecord, user: User) {
        if (Object.keys(input).some(key => !['enabled', 'startTime', 'timeZone'].includes(key))) {
            throw new CentralError(422, 'bad_request', '请填写启用状态和 HH:mm 格式的开始时间');
        }
        return this.database.transaction(() => {
            const existing = this.policy(project.projectId, LEGACY_PLAN_ID);
            const settings = planSettings({ name: existing?.name ?? LEGACY_PLAN_NAME, recurrence: existing?.recurrence ?? { kind: 'daily' },
                note: existing?.note ?? '', ...input });
            this.save(project, LEGACY_PLAN_ID, existing, settings, user);
            return this.view(project);
        });
    }

    createPlan(project: ProjectRecord, input: JsonRecord, user: User, requestKey: unknown) {
        const settings = planSettings(input);
        const key = requestKey === undefined ? null : entityId(requestKey, 'Idempotency-Key');
        const sql = this.database.sql;
        return this.database.transaction(() => {
            const hash = digest(stableJson({ settings, actor: user.userId }));
            if (key) {
                const replay = sql.prepare('SELECT request_hash,plan_id FROM audit_plan_creations WHERE project_id=? AND request_key=?')
                    .get(project.projectId, key);
                if (replay) {
                    if (replay.request_hash !== hash) throw new CentralError(409, 'idempotency_conflict', '同一幂等键已用于其他计划设置');
                    const plan = this.policy(project.projectId, String(replay.plan_id));
                    if (!plan) throw new CentralError(410, 'plan_deleted', '该次创建的计划已删除');
                    return this.planView(project, plan, this.database.now());
                }
            }
            const plan = this.save(project, randomUUID(), null, settings, user);
            if (key) sql.prepare('INSERT INTO audit_plan_creations VALUES (?,?,?,?)').run(project.projectId, key, hash, plan.planId);
            return plan;
        });
    }

    updatePlan(project: ProjectRecord, planId: string, input: JsonRecord, user: User) {
        const { expectedVersion, ...fields } = input;
        const version = positiveInteger(expectedVersion, 'expectedVersion');
        const settings = planSettings(fields);
        return this.database.transaction(() => {
            const old = this.existingPlan(project.projectId, planId);
            if (version !== old.version) {
                throw new CentralError(409, 'plan_version_conflict', '计划已被修改，请重新打开后编辑');
            }
            return this.save(project, planId, old, settings, user);
        });
    }

    setPlanEnabled(project: ProjectRecord, planId: string, input: JsonRecord, user: User) {
        const { enabled } = input;
        if (typeof enabled !== 'boolean' || Object.keys(input).length !== 1) {
            throw new CentralError(422, 'bad_request', '只接受计划启用状态');
        }
        return this.database.transaction(() => {
            const old = this.existingPlan(project.projectId, planId);
            return this.save(project, planId, old, { ...old, enabled }, user);
        });
    }

    private existingPlan(projectId: string, planId: string): SchedulePolicy {
        const policy = this.policy(projectId, planId);
        if (!policy) throw new CentralError(404, 'not_found', '定时审查计划不存在');
        return policy;
    }

    private save(project: ProjectRecord, planId: string, old: SchedulePolicy | null, settings: AuditPlanSettings, user: User) {
        const db = this.database;
        const now = db.now();
        const recurrence = JSON.stringify(settings.recurrence);
        const executionChanged = !old || old.enabled !== settings.enabled || old.startTime !== settings.startTime
            || old.timeZone !== settings.timeZone || old.note !== settings.note || JSON.stringify(old.recurrence) !== recurrence;
        if (old && !executionChanged && old.name === settings.name) return this.planView(project, old, now);
        const lastRun = old && executionChanged ? this.planView(project, old, now).lastRun : null;
        const missed = lastRun?.state === 'skipped' && !lastRun.commandId ? lastRun.scheduledAt : old?.lastMissedAt ?? null;
        db.sql.prepare(`INSERT INTO audit_plans (project_id,plan_id,name,enabled,start_time,time_zone,recurrence,note,effective_at,review_identity,last_missed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,plan_id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,
                start_time=excluded.start_time,time_zone=excluded.time_zone,recurrence=excluded.recurrence,note=excluded.note,
                effective_at=excluded.effective_at,review_identity=excluded.review_identity,last_missed_at=excluded.last_missed_at,
                version=audit_plans.version+1`)
            .run(project.projectId, planId, settings.name, Number(settings.enabled), settings.startTime, settings.timeZone,
                recurrence, settings.note, executionChanged ? now : old.effectiveAt, executionChanged ? user.reviewIdentity : old.reviewIdentity, missed);
        if (planId === LEGACY_PLAN_ID) db.syncLegacyAuditSchedule(project.projectId);
        if (old && executionChanged) this.withdraw(project.projectId, planId, now);
        return this.planView(project, this.existingPlan(project.projectId, planId), now);
    }

    deletePlan(project: ProjectRecord, planId: string): void {
        const db = this.database;
        db.transaction(() => {
            const deleted = db.sql.prepare('DELETE FROM audit_plans WHERE project_id=? AND plan_id=?').run(project.projectId, planId);
            if (!deleted.changes) throw new CentralError(404, 'not_found', '定时审查计划不存在');
            if (planId === LEGACY_PLAN_ID) db.sql.prepare('DELETE FROM audit_schedules WHERE project_id=?').run(project.projectId);
            this.withdraw(project.projectId, planId, db.now());
        });
    }

    private withdraw(projectId: string, planId: string, now: string): void {
        this.database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},updated_at=?,result=?
            WHERE project_id=? AND idempotency_key GLOB ? AND ${UNACCEPTED_SCHEDULED}`)
            .run(now, this.skipped(CHANGED_REASON, CHANGED_MESSAGE), projectId, keysFor(planId));
    }

    private skipped(reason: string, message: string): string {
        return JSON.stringify({ outcome: { status: 'ABORTED', reason, message }, delivery: { state: 'not_required' } });
    }

    skipUnsupportedNotes(commandId: string): void {
        this.database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},updated_at=?,result=?
            WHERE command_id=? AND ${UNACCEPTED_SCHEDULED}`).run(this.database.now(),
            this.skipped(NOTES_UNSUPPORTED, '执行节点不支持定时审查要求，本轮未启动'), commandId);
    }

    expire(now = this.database.now()): void {
        const expired = `${UNACCEPTED_SCHEDULED} AND json_extract(envelope,'$.scheduledAudit.expiresAt')<=?`;
        if (!this.database.sql.prepare(`SELECT 1 FROM commands WHERE ${expired} LIMIT 1`).get(now)) return;
        this.database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},updated_at=?,result=? WHERE ${expired}`)
            .run(now, this.skipped(EXPIRED_REASON, EXPIRED_MESSAGE), now);
    }

    rememberMissedWindow(project: ProjectRecord): void {
        for (const plan of this.list(project)) {
            const missed = plan.lastRun;
            if (missed?.state === 'skipped' && !missed.commandId) {
                this.database.sql.prepare('UPDATE audit_plans SET last_missed_at=? WHERE project_id=? AND plan_id=?')
                    .run(missed.scheduledAt, project.projectId, plan.planId);
                if (plan.planId === LEGACY_PLAN_ID) this.database.syncLegacyAuditSchedule(project.projectId);
            }
        }
    }

    blocksManual(projectId: string): boolean {
        return Boolean(this.database.sql.prepare(`SELECT 1 FROM commands WHERE project_id=? AND active_state!='completed'
            AND NOT (${UNACCEPTED_SCHEDULED})`).get(projectId));
    }

    /** 改写未取消指令的幂等键使本轮可以重新派发，并保留原指令供节点确认。 */
    yieldToManual(projectId: string, now: string): void {
        this.database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},updated_at=?,
            idempotency_key=CASE WHEN cancel_requested=1 THEN idempotency_key ELSE 'retired-scheduled:' || command_id END,
            result=CASE WHEN cancel_requested=1 THEN ? ELSE ? END
            WHERE project_id=? AND ${UNACCEPTED_SCHEDULED}`).run(now,
            this.skipped('CANCELLED', '执行前已取消，没有产生副作用'),
            this.skipped('SCHEDULE_MANUAL_PRIORITY', '本次派发已让位于手动任务'), projectId);
    }

    private run(projectId: string, planId: string, slot?: Slot): Run | null {
        const db = this.database;
        const row = slot
            ? db.sql.prepare('SELECT command_id,active_state AS state,result,envelope FROM commands WHERE project_id=? AND idempotency_key=?').get(projectId, slot.key) as Row | undefined
            : db.sql.prepare(`SELECT command_id,active_state AS state,result,envelope FROM commands WHERE project_id=?
                AND idempotency_key GLOB ? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(projectId, keysFor(planId)) as Row | undefined;
        if (!row) return null;
        return { commandId: row.command_id, state: row.state, ...JSON.parse(row.envelope).scheduledAudit,
            ...(row.result ? { result: JSON.parse(row.result) } : {}) };
    }

    private runView(run: Run, now: string) {
        const outcome = run.result?.outcome;
        const unacceptedExpired = (run.state === 'queued' || run.state === 'dispatched') && now >= run.expiresAt;
        const skipReasons = [EXPIRED_REASON, CHANGED_REASON, 'SCHEDULE_WORKSPACE_BUSY', 'SCHEDULE_WORKSPACE_DIRTY', 'SCHEDULE_WORKSPACE_NO_BASE',
            'SCHEDULE_WORKSPACE_INCOMPLETE', 'RUNNER_UNAVAILABLE', 'SCHEDULE_ROLLBACK_CONFLICT', NOTES_UNSUPPORTED];
        const skipped = unacceptedExpired || (typeof outcome?.reason === 'string' && skipReasons.includes(outcome.reason));
        const reason = outcome?.message ?? outcome?.detail ?? outcome?.reason;
        return { commandId: run.commandId, scheduledAt: run.scheduledAt, state: skipped ? 'skipped' as const : run.state,
            reason: unacceptedExpired ? EXPIRED_MESSAGE : typeof reason === 'string' ? reason : null };
    }

    private nearby(projectId: string, policy: SchedulePolicy, now: string) {
        const { today, slot } = localCalendar(policy, now);
        const timestamp = Date.parse(now);
        const { recurrence } = policy;
        const span = recurrence.kind === 'interval' ? recurrence.days : recurrence.kind === 'weekly' ? 7 : 1;
        const anchor = recurrence.kind === 'interval' ? Date.parse(`${recurrence.startDate}T00:00:00Z`) : today;
        const firstFutureDay = Math.max(today, anchor);
        const find = (start: number, direction: 1 | -1, matches: (candidate: Slot) => boolean) => {
            for (let offset = 0; offset <= 4 * span + 2; offset++) {
                const candidate = slot(start + offset * direction * DAY_MS);
                if (candidate && matches(candidate)) return candidate;
            }
        };
        return {
            last: anchor <= today ? find(today, -1, candidate => Date.parse(candidate.scheduledAt) <= timestamp) : undefined,
            next: find(firstFutureDay, 1, candidate => Date.parse(candidate.scheduledAt) > timestamp && !this.run(projectId, policy.planId, candidate)),
        };
    }

    private planView(project: ProjectRecord, policy: SchedulePolicy, now: string) {
        const { planId, version, name, enabled, startTime, timeZone, recurrence, note } = policy;
        const { last, next } = enabled && project.enabled ? this.nearby(project.projectId, policy, now) : {};
        const run = last ? this.run(project.projectId, planId, last) : null;
        const latestCommand = run ?? this.run(project.projectId, planId);
        const completedOrPending = latestCommand ? this.runView(latestCommand, now) : null;
        const currentWindow = last && !run ? {
            scheduledAt: last.scheduledAt,
            state: now < last.expiresAt ? 'waiting' as const : 'skipped' as const,
            reason: now < last.expiresAt ? '等待执行节点空闲并领取任务' : EXPIRED_MESSAGE,
            commandId: null,
        } : null;
        const savedSkip = policy.lastMissedAt ? { scheduledAt: policy.lastMissedAt, state: 'skipped' as const, reason: EXPIRED_MESSAGE, commandId: null } : null;
        const latest = [completedOrPending, currentWindow, savedSkip].sort((left, right) => (right?.scheduledAt ?? '').localeCompare(left?.scheduledAt ?? ''));
        return { planId, version, name, enabled, startTime, timeZone, recurrence, note, nextRunAt: next?.scheduledAt ?? null, lastRun: latest[0] ?? null };
    }

    view(project: ProjectRecord, now = this.database.now()) {
        const policy = this.policy(project.projectId, LEGACY_PLAN_ID);
        if (!policy) return null;
        const { enabled, startTime, timeZone, nextRunAt, lastRun } = this.planView(project, policy, now);
        return { enabled, startTime, timeZone, nextRunAt, lastRun };
    }

    list(project: ProjectRecord, now = this.database.now()) {
        return this.policies(project.projectId).map(policy => this.planView(project, policy, now));
    }

    due(nodeId: string, workspaces: ReadonlySet<string>, supportsScheduledAuditNotes: boolean) {
        if (!workspaces.size) return [];
        const now = this.database.now();
        return this.database.listProjects(nodeId).flatMap(project => {
            if (!project.enabled || !workspaces.has(project.workspaceId)) return [];
            return this.policies(project.projectId).flatMap(policy => {
                if (!policy.enabled || (policy.note && !supportsScheduledAuditNotes)) return [];
                const { today, slot } = localCalendar(policy, now);
                const due = [today - DAY_MS, today].map(slot).find(candidate => candidate
                    && candidate.scheduledAt <= now && now < candidate.expiresAt && !this.run(project.projectId, policy.planId, candidate));
                return due ? [{ project, slot: due, reviewIdentity: policy.reviewIdentity, note: policy.note }] : [];
            });
        }).sort((left, right) => left.slot.scheduledAt.localeCompare(right.slot.scheduledAt) || left.project.projectId.localeCompare(right.project.projectId));
    }
}
