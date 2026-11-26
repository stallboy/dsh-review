import { randomUUID } from 'node:crypto';
import { entityId, positiveInteger, ProtocolError, record, RETIRED_MANUAL_REVISION, retiredManualRevisionResult, SCHEDULED_AUDIT_ACTOR, textValue, validateCommand, type Actor, type CommandRecord,
    type JsonRecord, type ManagedResult, type NodeEvent, type ProjectRecord, type ScheduledAudit } from '@dsh-review/protocol';
import { digest, stableJson } from './auth.js';
import { assignCommandState, CentralDatabase, CentralError, type Row, type User } from './database.js';
import { AuditSchedules } from './audit-schedule.js';

function requiresAuditNotes(command: CommandRecord): boolean {
    return Boolean(command.scheduledAudit && command.payload.note);
}

export class Commands {
    constructor(private readonly database: CentralDatabase, private readonly schedules: AuditSchedules) {
        database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},result=?,updated_at=?
            WHERE active_state IN ('queued','dispatched') AND json_extract(envelope,'$.operation')=?`)
            .run(JSON.stringify(retiredManualRevisionResult()), database.now(), RETIRED_MANUAL_REVISION);
    }

    get(commandId: string): CommandRecord {
        const row = this.database.sql.prepare('SELECT * FROM commands WHERE command_id=?').get(commandId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '任务不存在');
        return { ...JSON.parse(row.envelope), state: row.active_state, cancelRequested: Boolean(row.cancel_requested),
            updatedAt: row.updated_at, ...(row.result ? { result: JSON.parse(row.result) } : {}) };
    }

    list(projectId?: string): CommandRecord[] {
        const rows = projectId ? this.database.sql.prepare('SELECT command_id FROM commands WHERE project_id=? ORDER BY created_at DESC LIMIT 200').all(projectId)
            : this.database.sql.prepare('SELECT command_id FROM commands ORDER BY created_at DESC LIMIT 200').all();
        return (rows as Row[]).map(row => this.get(row.command_id));
    }

    private supportsFindingWorkflow(project: ProjectRecord): boolean {
        return this.database.getNode(project.nodeId).workspaces.some(workspace =>
            workspace.workspaceId === project.workspaceId && (workspace.findingWorkflow === true || workspace.issueWorkflow === true));
    }

    private supportsIssueWorkflow(project: ProjectRecord): boolean {
        return this.database.getNode(project.nodeId).workspaces.some(workspace =>
            workspace.workspaceId === project.workspaceId && workspace.issueWorkflow === true);
    }

    private supportsSelfTest(project: ProjectRecord): boolean {
        return this.database.getNode(project.nodeId).workspaces.some(workspace =>
            workspace.workspaceId === project.workspaceId && workspace.auditSelfTest);
    }

    private finishUnsupportedSelfTest(commandId: string): CommandRecord {
        const result: ManagedResult = { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', step: 'workspace',
            message: '执行节点已不支持审查流程自检' }, delivery: { state: 'not_required' } };
        this.database.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},result=?,updated_at=? WHERE command_id=?`)
            .run(JSON.stringify(result), this.database.now(), commandId);
        return this.get(commandId);
    }

    create(projectId: string, input: JsonRecord, user: User, selfTest = false): CommandRecord {
        if (input.operation === RETIRED_MANUAL_REVISION || (input.operation === 'test' && !selfTest)) throw new ProtocolError('operation');
        const db = this.database;
        const project = db.getProject(projectId);
        const key = entityId(input.idempotencyKey, 'idempotencyKey');
        if ('scheduledAudit' in input) throw new CentralError(422, 'bad_request', '定时审查标识由中央生成');
        const requestHash = digest(stableJson({ operation: input.operation, payload: input.payload, guard: input.guard, actor: user.userId }));
        return db.transaction(() => {
            const now = db.now();
            this.schedules.expire(now);
            const existing = db.sql.prepare('SELECT command_id,request_hash FROM commands WHERE project_id=? AND idempotency_key=?').get(projectId, key) as Row | undefined;
            if (existing) {
                if (existing.request_hash !== requestHash) throw new CentralError(409, 'idempotency_conflict', '同一幂等键已用于不同操作');
                return this.get(existing.command_id);
            }
            if (this.schedules.blocksManual(projectId)) throw new CentralError(409, 'project_busy', '项目有未决操作');
            const node = db.getNode(project.nodeId);
            if (!project.enabled || !node.online || !node.compatible) throw new CentralError(503, 'node_unavailable', '执行节点离线、停用或协议不兼容');
            const supportsFindings = this.supportsFindingWorkflow(project);
            const supportsIssues = this.supportsIssueWorkflow(project);
            const payload = record(input.payload, 'payload');
            if ('findingWorkflow' in payload) throw new ProtocolError('payload.findingWorkflow');
            if ('issueWorkflow' in payload) throw new ProtocolError('payload.issueWorkflow');
            if ((input.operation === 'audit' || 'optionId' in payload || 'patchId' in payload || payload.action === 'external_completed') && !supportsIssues) {
                throw new CentralError(409, 'conflict', '节点尚未声明问题记录与方案选择能力，请先升级节点');
            }
            if ((input.operation === 'finding-decision' || (input.operation === 'approve' && 'expectedFindingVersion' in payload)) && !supportsFindings) {
                throw new CentralError(409, 'conflict', '节点尚未声明新版发现能力');
            }
            const issues = db.workspaceIssues(node.nodeId);
            if (Object.hasOwn(issues, project.workspaceId)) throw new CentralError(503, 'workspace_unavailable', issues[project.workspaceId]!);
            if (input.operation === 'test' && !this.supportsSelfTest(project)) {
                throw new CentralError(409, 'conflict', '节点尚未声明审查流程自检能力');
            }
            this.schedules.yieldToManual(projectId, now);
            const command = input.operation === 'audit' && (supportsFindings || supportsIssues)
                ? { ...input, payload: { ...payload, findingWorkflow: true, ...(supportsIssues ? { issueWorkflow: true } : {}) } } : input;
            return this.insert(project, key, command, { userId: user.userId, reviewIdentity: user.reviewIdentity }, requestHash);
        });
    }

    private insert(project: ProjectRecord, key: string, input: JsonRecord, actor: Actor, requestHash: string, scheduledAudit?: ScheduledAudit): CommandRecord {
        const db = this.database;
        const createdAt = db.now();
        const command = validateCommand({ commandId: randomUUID(), requestHash, projectId: project.projectId, nodeId: project.nodeId,
            bindingGeneration: project.bindingGeneration, projectConfigRevision: project.projectConfigRevision,
            operation: input.operation, payload: input.payload, actor, ...(input.guard !== undefined ? { guard: input.guard } : {}),
            ...(scheduledAudit ? { scheduledAudit } : {}), createdAt });
        const protectedNotes = Boolean(scheduledAudit && command.payload.note);
        db.sql.prepare(`INSERT INTO commands(command_id,project_id,node_id,idempotency_key,request_hash,envelope,state,protected_state,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(command.commandId, project.projectId, project.nodeId, key, requestHash, JSON.stringify(command),
                protectedNotes ? 'completed' : 'queued', protectedNotes ? 'queued' : null, createdAt, createdAt);
        return this.get(command.commandId);
    }

    poll(nodeId: string, scheduledAuditWorkspaces: ReadonlySet<string>, supportsScheduledAuditNotes: boolean): { commands: CommandRecord[]; cancellations: string[]; recoveries: string[] } {
        const db = this.database;
        return db.transaction(() => {
            const node = db.getNode(nodeId);
            if (!node.compatible) return { commands: [], cancellations: [], recoveries: [] };
            this.schedules.expire();
            const issues = db.workspaceIssues(nodeId);
            const unavailable = (command: CommandRecord) => Object.hasOwn(issues, db.getProject(command.projectId).workspaceId);
            const all = (db.sql.prepare("SELECT command_id FROM commands WHERE node_id=? AND active_state!='completed' ORDER BY created_at").all(nodeId) as Row[])
                .map(row => this.get(row.command_id));
            const supports = (command: CommandRecord) => (command.payload.issueWorkflow !== true && !('optionId' in command.payload)
                || this.supportsIssueWorkflow(db.getProject(command.projectId))) && (command.operation === 'test'
                ? this.supportsSelfTest(db.getProject(command.projectId))
                : !(
                command.operation === 'finding-decision' || (command.operation === 'approve' && 'expectedFindingVersion' in command.payload)
                || (command.operation === 'audit' && command.payload.findingWorkflow === true)
            ) || this.supportsFindingWorkflow(db.getProject(command.projectId)));
            const relevant = all.filter(command => {
                if (command.state !== 'queued' && command.state !== 'dispatched') {
                    return command.state === 'accepted' || command.state === 'executing' || !unavailable(command);
                }
                if (unavailable(command) && command.operation === 'test') return false;
                if (!supportsScheduledAuditNotes && requiresAuditNotes(command)) {
                    this.schedules.skipUnsupportedNotes(command.commandId);
                    return false;
                }
                if (supports(command)) return !unavailable(command);
                if (command.operation === 'test') {
                    this.finishUnsupportedSelfTest(command.commandId);
                    return false;
                }
                const result: ManagedResult = { outcome: { status: 'ABORTED', reason: 'STATE_CONFLICT', message: '执行节点已不支持新版发现' },
                    delivery: { state: 'not_required' } };
                db.sql.prepare(`UPDATE commands SET ${assignCommandState('completed')},result=?,updated_at=? WHERE command_id=?`)
                    .run(JSON.stringify(result), db.now(), command.commandId);
                return false;
            });
            if (!relevant.length && node.online) {
                const ready = new Set([...scheduledAuditWorkspaces].filter(workspaceId => !Object.hasOwn(issues, workspaceId)
                    && node.workspaces.some(workspace => workspace.workspaceId === workspaceId && workspace.issueWorkflow === true)));
                const due = this.schedules.due(nodeId, ready, supportsScheduledAuditNotes)[0];
                if (due) {
                    const { key, ...schedule } = due.slot;
                    const input = { operation: 'audit', payload: {
                        targetPath: '.', note: due.note, findingWorkflow: true, issueWorkflow: true,
                    } };
                    const actor = { userId: SCHEDULED_AUDIT_ACTOR, reviewIdentity: due.reviewIdentity };
                    relevant.push(this.insert(due.project, key, input, actor, digest(stableJson({ ...input, actor, schedule })), schedule));
                }
            }
            const running = relevant.some(c => c.state === 'accepted' || c.state === 'executing' || c.state === 'recovery_required');
            const dispatchable = relevant.filter(c => !c.scheduledAudit || (scheduledAuditWorkspaces.has(db.getProject(c.projectId).workspaceId)
                && (supportsScheduledAuditNotes || !requiresAuditNotes(c))));
            const accepted = dispatchable.filter(c => c.state === 'accepted');
            const waiting = dispatchable.filter(c => c.state === 'queued' || c.state === 'dispatched');
            const next = waiting.find(c => !c.scheduledAudit) ?? waiting[0];
            const commands = accepted.length ? accepted : !running && next ? [next] : [];
            for (const command of commands) {
                if (command.state === 'accepted') continue;
                db.sql.prepare(`UPDATE commands SET ${assignCommandState('dispatched')},updated_at=? WHERE command_id=?`).run(db.now(), command.commandId);
                command.state = 'dispatched';
            }
            const recoveries = db.sql.prepare("SELECT command_id FROM commands WHERE node_id=? AND active_state='recovery_required' AND recovery_requested=1").all(nodeId) as Row[];
            return { commands, cancellations: all.filter(c => c.cancelRequested).map(c => c.commandId),
                recoveries: recoveries.map(row => row.command_id) };
        });
    }

    acknowledge(nodeId: string, commandId: string, supportsScheduledAuditNotes: boolean): CommandRecord {
        const db = this.database;
        return db.transaction(() => {
            const now = db.now();
            this.schedules.expire(now);
            const command = this.get(commandId);
            this.authorize(nodeId, command, !(command.state === 'completed' && (command.scheduledAudit || command.operation === RETIRED_MANUAL_REVISION || command.operation === 'test')));
            if (!supportsScheduledAuditNotes && requiresAuditNotes(command)) {
                if (command.state === 'accepted') {
                    throw new CentralError(409, 'audit_notes_unsupported', '此任务已受理，请使用支持定时审查要求的节点继续处理');
                }
                if (command.state === 'queued' || command.state === 'dispatched') {
                    this.schedules.skipUnsupportedNotes(commandId);
                    return this.get(commandId);
                }
            }
            if (command.state === 'queued' || command.state === 'dispatched') {
                if (!db.getNode(nodeId).compatible) throw new CentralError(409, 'protocol_incompatible', '节点协议不兼容，不能受理写指令');
                const issues = db.workspaceIssues(nodeId);
                const project = db.getProject(command.projectId);
                if (Object.hasOwn(issues, project.workspaceId)) return command;
                if (command.operation === 'test' && !this.supportsSelfTest(project)) return this.finishUnsupportedSelfTest(commandId);
                if (command.scheduledAudit && db.sql.prepare(`SELECT projects.workspace_id,commands.active_state AS state FROM commands JOIN projects USING(project_id)
                    WHERE commands.node_id=? AND commands.active_state!='completed'
                    AND json_extract(envelope,'$.scheduledAudit') IS NULL`).all(nodeId)
                    .some(row => row.state === 'accepted' || row.state === 'executing' || !Object.hasOwn(issues, String(row.workspace_id)))) return command;
                db.sql.prepare(`UPDATE commands SET ${assignCommandState('accepted')},updated_at=? WHERE command_id=?`).run(now, commandId);
            }
            const acknowledged = this.get(commandId);
            return acknowledged.operation === RETIRED_MANUAL_REVISION && acknowledged.state === 'accepted'
                ? { ...acknowledged, cancelRequested: true } : acknowledged;
        });
    }

    cancel(commandId: string): CommandRecord {
        const command = this.get(commandId);
        if (command.state !== 'completed') this.database.sql.prepare('UPDATE commands SET cancel_requested=1,updated_at=? WHERE command_id=?').run(this.database.now(), commandId);
        return this.get(commandId);
    }

    requestRecovery(commandId: string, confirmStopped: unknown): CommandRecord {
        const command = this.get(commandId);
        if (confirmStopped !== true || command.state !== 'recovery_required') throw new CentralError(409, 'recovery_confirmation_required', '仅在确认执行器已停止后请求核验恢复');
        this.database.sql.prepare('UPDATE commands SET recovery_requested=1,updated_at=? WHERE command_id=?').run(this.database.now(), commandId);
        return command;
    }

    private authorize(nodeId: string, command: CommandRecord, verifyBinding = true): void {
        if (command.nodeId !== nodeId) throw new CentralError(403, 'forbidden', '任务不属于该节点');
        if (!verifyBinding) return;
        const project = this.database.assertNodeProject(nodeId, command.projectId);
        if (project.bindingGeneration !== command.bindingGeneration || project.projectConfigRevision !== command.projectConfigRevision) throw new CentralError(409, 'binding_mismatch', '任务绑定或配置已变化');
    }

    event(nodeId: string, value: unknown): { commandId: string; acknowledged: number } {
        const event = record(value, 'event');
        const commandId = entityId(event.commandId, 'commandId');
        const sequence = positiveInteger(event.sequence, 'sequence');
        if (!['accepted', 'progress', 'result', 'recovery_required'].includes(String(event.type))) throw new CentralError(422, 'bad_request', '事件类型无效');
        if (event.logs !== undefined && (!Array.isArray(event.logs) || event.logs.length > 400 || event.logs.some(line => typeof line !== 'string' || line.length > 4000))) throw new CentralError(422, 'bad_request', '日志批次无效');
        if (event.type === 'result' || event.result !== undefined) this.validateResult(event.result);
        const db = this.database;
        return db.transaction(() => {
            const command = this.get(commandId);
            this.authorize(nodeId, command);
            if (event.auditTimeoutStopping !== undefined && (event.auditTimeoutStopping !== true
                || event.type !== 'progress' || event.result !== undefined || !Array.isArray(event.logs) || !event.logs.length
                || command.operation !== 'audit' || command.scheduledAudit)) {
                throw new CentralError(422, 'bad_request', '审查超时停止标记无效');
            }
            const current = db.sql.prepare('SELECT last_event FROM commands WHERE command_id=?').get(commandId) as Row;
            const hash = digest(stableJson(event));
            const previous = db.sql.prepare('SELECT payload FROM events WHERE command_id=? AND sequence=?').get(commandId, sequence) as Row | undefined;
            if (previous && JSON.parse(previous.payload).hash !== hash) throw new CentralError(409, 'event_conflict', '相同事件序号内容不一致');
            if (sequence > current.last_event + 256) throw new CentralError(409, 'event_gap', '事件缺口过大，请按确认序号重传');
            if (!previous) db.sql.prepare('INSERT INTO events VALUES (?,?,?)').run(commandId, sequence, JSON.stringify({ hash, event }));
            let next = Number(current.last_event) + 1;
            while (true) {
                const row = db.sql.prepare('SELECT payload FROM events WHERE command_id=? AND sequence=?').get(commandId, next) as Row | undefined;
                if (!row) break;
                const saved = JSON.parse(row.payload) as { hash: string; event: NodeEvent };
                this.applyEvent(commandId, saved.event);
                delete saved.event.logs;
                db.sql.prepare('UPDATE events SET payload=? WHERE command_id=? AND sequence=?').run(JSON.stringify(saved), commandId, next);
                db.sql.prepare('UPDATE commands SET last_event=? WHERE command_id=?').run(next, commandId);
                next++;
            }
            return { commandId, acknowledged: next - 1 };
        });
    }

    private validateResult(value: unknown): ManagedResult {
        const result = record(value, 'result');
        const outcome = record(result.outcome, 'outcome');
        textValue(outcome.status, 'outcome.status', 80);
        const delivery = record(result.delivery, 'delivery');
        if (!['not_required', 'pending', 'delivered', 'conflict', 'unknown'].includes(String(delivery.state))) throw new CentralError(422, 'bad_request', '交付状态无效');
        return result as unknown as ManagedResult;
    }

    private applyEvent(commandId: string, event: NodeEvent): void {
        const db = this.database;
        const command = this.get(commandId);
        if (event.logs?.length) {
            const row = db.sql.prepare('SELECT logs_total FROM commands WHERE command_id=?').get(commandId) as Row;
            let total = Number(row.logs_total);
            for (const line of event.logs) db.sql.prepare('INSERT INTO logs VALUES (?,?,?)').run(commandId, total++, line);
            db.sql.prepare('UPDATE commands SET logs_total=? WHERE command_id=?').run(total, commandId);
            db.sql.prepare('DELETE FROM logs WHERE command_id=? AND offset<?').run(commandId, Math.max(0, total - 4000));
        }
        if (command.state === 'completed') return;
        if (event.result) {
            const before = command.result?.outcome.commitRevision;
            if (before && event.result.outcome.commitRevision !== before) throw new CentralError(409, 'commit_mismatch', '不能用另一提交替换原执行结果');
            const proven = command.result && (command.result.outcome.status === 'COMMITTED'
                || (before && command.result.outcome.status !== 'RECOVERY_REQUIRED'));
            if (proven && stableJson(command.result!.outcome) !== stableJson(event.result.outcome)) {
                throw new CentralError(409, 'outcome_mismatch', '已确认的业务提交结果不可被恢复回报覆盖');
            }
            if (proven && command.result!.delivery.state !== 'not_required' && event.result.delivery.state === 'not_required') {
                throw new CentralError(409, 'delivery_mismatch', '已提交内容的远端交付义务不能被清除');
            }
            const unresolved = event.result.outcome.status === 'RECOVERY_REQUIRED' || ['pending', 'conflict', 'unknown'].includes(event.result.delivery.state);
            db.sql.prepare(`UPDATE commands SET ${assignCommandState(unresolved ? 'recovery_required' : 'completed')},result=?,updated_at=?,recovery_requested=0 WHERE command_id=?`)
                .run(JSON.stringify(event.result), db.now(), commandId);
        } else {
            const state = event.type === 'recovery_required' ? 'recovery_required' : event.type === 'accepted' ? 'accepted' : 'executing';
            if (command.state === 'recovery_required') return;
            db.sql.prepare(`UPDATE commands SET ${assignCommandState(state)},updated_at=? WHERE command_id=?`).run(db.now(), commandId);
        }
    }

    logs(commandId: string, since = 0): JsonRecord {
        this.get(commandId);
        if (!Number.isSafeInteger(since) || since < 0) throw new CentralError(422, 'bad_request', '日志偏移无效');
        const row = this.database.sql.prepare('SELECT logs_total FROM commands WHERE command_id=?').get(commandId) as Row;
        const end = Number(row.logs_total), start = Math.max(0, end - 4000);
        const reset = since < start || since > end;
        const lines = this.database.sql.prepare('SELECT line FROM logs WHERE command_id=? AND offset>=? ORDER BY offset').all(commandId, reset ? start : since) as Row[];
        return { log: lines.map(item => item.line), logStartOffset: start, logNextOffset: end, logResetRequired: reset };
    }
}
