import { SCHEDULED_AUDIT_WAIT_MS, type CommandRecord, type JsonRecord, type ProjectRecord,
    type ScheduledAudit } from '@dsh-review/protocol';
import { CentralDatabase, CentralError, type Row, type User } from './database.js';

const DAY_MS = 24 * 60 * 60_000;
const EXPIRED_REASON = 'SCHEDULE_WINDOW_EXPIRED';
const EXPIRED_MESSAGE = '30 分钟等待期已结束，本轮未启动';
const CHANGED_REASON = 'SCHEDULE_CHANGED';
const CHANGED_MESSAGE = '定时设置已修改，本轮未启动';
const SCHEDULE_KEY_PREFIX = 'scheduled-audit:';
const UNACCEPTED_SCHEDULED = "state IN ('queued','dispatched') AND json_extract(envelope,'$.scheduledAudit') IS NOT NULL";

interface SchedulePolicy {
    enabled: boolean;
    startTime: string;
    timeZone: string;
    effectiveAt: string;
    reviewIdentity: string;
    lastMissedAt: string | null;
}

interface Slot extends ScheduledAudit {
    key: string;
}

type Run = Pick<CommandRecord, 'state' | 'result'> & { commandId: string; scheduledAt: string; expiresAt: string };

function zonedMinute(formatter: Intl.DateTimeFormat, date: Date): string {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function slotsNear(now: string, policy: SchedulePolicy): Slot[] {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const localDay = Date.parse(`${zonedMinute(formatter, new Date(now)).slice(0, 10)}T00:00:00Z`);
    return [-2, -1, 0, 1, 2].flatMap(day => {
        const date = new Date(localDay + day * DAY_MS).toISOString().slice(0, 10);
        const local = `${date}T${policy.startTime}`;
        const wallTime = Date.parse(`${local}:00Z`);
        const candidates = [-1, 0, 1].map(offsetDay => {
            const sample = wallTime + offsetDay * DAY_MS;
            const offset = Date.parse(`${zonedMinute(formatter, new Date(sample))}:00Z`) - sample;
            return wallTime - offset;
        }).filter(candidate => zonedMinute(formatter, new Date(candidate)) === local);
        if (!candidates.length) return [];
        const start = Math.min(...candidates);
        const scheduledAt = new Date(start).toISOString();
        if (scheduledAt < policy.effectiveAt) return [];
        return [{ key: `${SCHEDULE_KEY_PREFIX}${date}`, scheduledAt, expiresAt: new Date(start + SCHEDULED_AUDIT_WAIT_MS).toISOString() }];
    });
}

export class AuditSchedules {
    constructor(private readonly database: CentralDatabase) {}

    private policy(projectId: string): SchedulePolicy | null {
        const row = this.database.sql.prepare('SELECT * FROM audit_schedules WHERE project_id=?').get(projectId) as Row | undefined;
        return row ? { enabled: Boolean(row.enabled), startTime: row.start_time, timeZone: row.time_zone,
            effectiveAt: row.effective_at, reviewIdentity: row.review_identity, lastMissedAt: row.last_missed_at } : null;
    }

    update(project: ProjectRecord, input: JsonRecord, user: User) {
        const { enabled, startTime, timeZone } = input;
        if (Object.keys(input).some(key => !['enabled', 'startTime', 'timeZone'].includes(key)) || typeof enabled !== 'boolean'
            || typeof startTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
            throw new CentralError(422, 'bad_request', '请填写启用状态和 HH:mm 格式的开始时间');
        }
        if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,79}$/.test(timeZone)) {
            throw new CentralError(422, 'bad_request', '请填写有效的 IANA 时区');
        }
        let zone: string;
        try { zone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; }
        catch { throw new CentralError(422, 'bad_request', '请填写有效的 IANA 时区'); }
        const db = this.database;
        db.transaction(() => {
            const old = this.policy(project.projectId);
            if (old?.enabled === enabled && old.startTime === startTime && old.timeZone === zone) return;
            const now = db.now();
            const lastRun = old ? this.view(project, now)?.lastRun : null;
            const missed = lastRun?.state === 'skipped' && !lastRun.commandId ? lastRun.scheduledAt : old?.lastMissedAt ?? null;
            db.sql.prepare(`INSERT INTO audit_schedules VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,
                start_time=excluded.start_time,time_zone=excluded.time_zone,effective_at=excluded.effective_at,
                review_identity=excluded.review_identity,last_missed_at=excluded.last_missed_at`)
                .run(project.projectId, Number(enabled), startTime, zone, now, user.reviewIdentity, missed);
            db.sql.prepare(`UPDATE commands SET state='completed',updated_at=?,result=? WHERE project_id=? AND ${UNACCEPTED_SCHEDULED}`)
                .run(now, this.skipped(CHANGED_REASON, CHANGED_MESSAGE), project.projectId);
        });
        return this.view(project);
    }

    private skipped(reason: string, message: string): string {
        return JSON.stringify({ outcome: { status: 'ABORTED', reason, message }, delivery: { state: 'not_required' } });
    }

    expire(now = this.database.now()): void {
        const expired = `state!='completed' AND state IN ('queued','dispatched') AND json_extract(envelope,'$.scheduledAudit.expiresAt')<=?`;
        if (!this.database.sql.prepare(`SELECT 1 FROM commands WHERE ${expired} LIMIT 1`).get(now)) return;
        this.database.sql.prepare(`UPDATE commands SET state='completed',updated_at=?,result=? WHERE ${expired}`)
            .run(now, this.skipped(EXPIRED_REASON, EXPIRED_MESSAGE), now);
    }

    rememberMissedWindow(project: ProjectRecord): void {
        const missed = this.view(project)?.lastRun;
        if (missed?.state === 'skipped' && !missed.commandId) {
            this.database.sql.prepare('UPDATE audit_schedules SET last_missed_at=? WHERE project_id=?').run(missed.scheduledAt, project.projectId);
        }
    }

    blocksManual(projectId: string): boolean {
        return Boolean(this.database.sql.prepare(`SELECT 1 FROM commands WHERE project_id=? AND state!='completed'
            AND NOT (${UNACCEPTED_SCHEDULED})`).get(projectId));
    }

    yieldToManual(projectId: string, now: string): void {
        // 保留原指令供节点确认，同时让未主动取消的计划在本轮窗口内重新派发。
        this.database.sql.prepare(`UPDATE commands SET state='completed',updated_at=?,
            idempotency_key=CASE WHEN cancel_requested=1 THEN idempotency_key ELSE 'retired-scheduled:' || command_id END,
            result=CASE WHEN cancel_requested=1 THEN ? ELSE ? END
            WHERE project_id=? AND ${UNACCEPTED_SCHEDULED}`).run(now,
            this.skipped('CANCELLED', '执行前已取消，没有产生副作用'),
            this.skipped('SCHEDULE_MANUAL_PRIORITY', '本次派发已让位于手动任务'), projectId);
    }

    private run(projectId: string, slot?: Slot): Run | null {
        const db = this.database;
        const row = slot
            ? db.sql.prepare('SELECT command_id,state,result,envelope FROM commands WHERE project_id=? AND idempotency_key=?').get(projectId, slot.key) as Row | undefined
            : db.sql.prepare(`SELECT command_id,state,result,envelope FROM commands WHERE project_id=?
                AND idempotency_key LIKE ? ORDER BY created_at DESC LIMIT 1`).get(projectId, `${SCHEDULE_KEY_PREFIX}%`) as Row | undefined;
        if (!row) return null;
        return { commandId: row.command_id, state: row.state, ...JSON.parse(row.envelope).scheduledAudit,
            ...(row.result ? { result: JSON.parse(row.result) } : {}) };
    }

    private runView(run: Run, now: string) {
        const outcome = run.result?.outcome;
        const unacceptedExpired = (run.state === 'queued' || run.state === 'dispatched') && now >= run.expiresAt;
        const skipReasons = [EXPIRED_REASON, CHANGED_REASON, 'SCHEDULE_WORKSPACE_BUSY', 'SCHEDULE_WORKSPACE_DIRTY', 'SCHEDULE_WORKSPACE_NO_BASE',
            'SCHEDULE_WORKSPACE_INCOMPLETE', 'RUNNER_UNAVAILABLE'];
        const skipped = unacceptedExpired || (typeof outcome?.reason === 'string' && skipReasons.includes(outcome.reason));
        const reason = outcome?.message ?? outcome?.detail ?? outcome?.reason;
        return { commandId: run.commandId, scheduledAt: run.scheduledAt, state: skipped ? 'skipped' as const : run.state,
            reason: unacceptedExpired ? EXPIRED_MESSAGE : typeof reason === 'string' ? reason : null };
    }

    view(project: ProjectRecord, now = this.database.now()) {
        const policy = this.policy(project.projectId);
        if (!policy) return null;
        const { enabled, startTime, timeZone } = policy;
        const slots = enabled && project.enabled ? slotsNear(now, policy) : [];
        const last = slots.filter(slot => slot.scheduledAt <= now).at(-1);
        const next = slots.find(slot => slot.scheduledAt > now && !this.run(project.projectId, slot));
        const run = this.run(project.projectId, last);
        const latestCommand = run ?? this.run(project.projectId);
        const completedOrPending = latestCommand ? this.runView(latestCommand, now) : null;
        const currentWindow = last && !run ? {
            scheduledAt: last.scheduledAt,
            state: now < last.expiresAt ? 'waiting' : 'skipped',
            reason: now < last.expiresAt ? '等待执行节点空闲并领取任务' : EXPIRED_MESSAGE,
            commandId: null,
        } : null;
        const savedSkip = policy.lastMissedAt ? { scheduledAt: policy.lastMissedAt, state: 'skipped', reason: EXPIRED_MESSAGE, commandId: null } : null;
        const latest = [completedOrPending, currentWindow, savedSkip].sort((left, right) => (right?.scheduledAt ?? '').localeCompare(left?.scheduledAt ?? ''));
        return { enabled, startTime, timeZone, nextRunAt: next?.scheduledAt ?? null, lastRun: latest[0] ?? null };
    }

    due(nodeId: string, workspaces: ReadonlySet<string>) {
        if (!workspaces.size) return [];
        const now = this.database.now();
        return this.database.listProjects(nodeId).flatMap(project => {
            if (!project.enabled || !workspaces.has(project.workspaceId)) return [];
            const policy = this.policy(project.projectId);
            if (!policy?.enabled) return [];
            const slot = slotsNear(now, policy).find(slot => slot.scheduledAt <= now && now < slot.expiresAt);
            if (!slot || this.run(project.projectId, slot)) return [];
            return [{ project, slot, reviewIdentity: policy.reviewIdentity }];
        }).sort((left, right) => left.slot.scheduledAt.localeCompare(right.slot.scheduledAt) || left.project.projectId.localeCompare(right.project.projectId));
    }
}
