import { randomUUID } from 'node:crypto';
import { entityId, positiveInteger, record, textValue, validateCommand, type CommandRecord, type JsonRecord,
    type ManagedResult, type NodeEvent } from '@dsh-review/protocol';
import { digest, stableJson } from './auth.js';
import { CentralDatabase, CentralError, type Row, type User } from './database.js';

export class Commands {
    constructor(private readonly database: CentralDatabase) {}

    get(commandId: string): CommandRecord {
        const row = this.database.sql.prepare('SELECT * FROM commands WHERE command_id=?').get(commandId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '任务不存在');
        return { ...JSON.parse(row.envelope), state: row.state, cancelRequested: Boolean(row.cancel_requested),
            updatedAt: row.updated_at, ...(row.result ? { result: JSON.parse(row.result) } : {}) };
    }

    list(projectId?: string): CommandRecord[] {
        const rows = projectId ? this.database.sql.prepare('SELECT command_id FROM commands WHERE project_id=? ORDER BY created_at DESC LIMIT 200').all(projectId)
            : this.database.sql.prepare('SELECT command_id FROM commands ORDER BY created_at DESC LIMIT 200').all();
        return (rows as Row[]).map(row => this.get(row.command_id));
    }

    create(projectId: string, input: JsonRecord, user: User): CommandRecord {
        const db = this.database;
        const project = db.getProject(projectId);
        const key = entityId(input.idempotencyKey, 'idempotencyKey');
        const requestHash = digest(stableJson({ operation: input.operation, payload: input.payload, guard: input.guard, actor: user.userId }));
        return db.transaction(() => {
            const existing = db.sql.prepare('SELECT command_id,request_hash FROM commands WHERE project_id=? AND idempotency_key=?').get(projectId, key) as Row | undefined;
            if (existing) {
                if (existing.request_hash !== requestHash) throw new CentralError(409, 'idempotency_conflict', '同一幂等键已用于不同操作');
                return this.get(existing.command_id);
            }
            if (db.sql.prepare("SELECT 1 FROM commands WHERE project_id=? AND state!='completed'").get(projectId)) throw new CentralError(409, 'project_busy', '项目有未决操作');
            const node = db.getNode(project.nodeId);
            if (!project.enabled || !node.online || !node.compatible) throw new CentralError(503, 'node_unavailable', '执行节点离线、停用或协议不兼容');
            const command = validateCommand({ commandId: randomUUID(), requestHash, projectId, nodeId: project.nodeId,
                bindingGeneration: project.bindingGeneration, projectConfigRevision: project.projectConfigRevision,
                operation: input.operation, payload: input.payload,
                actor: { userId: user.userId, reviewIdentity: user.reviewIdentity },
                ...(input.guard !== undefined ? { guard: input.guard } : {}), createdAt: db.now() });
            db.sql.prepare(`INSERT INTO commands(command_id,project_id,node_id,idempotency_key,request_hash,envelope,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,'queued',?,?)`).run(command.commandId, projectId, project.nodeId, key, requestHash, JSON.stringify(command), db.now(), db.now());
            return this.get(command.commandId);
        });
    }

    poll(nodeId: string): { commands: CommandRecord[]; cancellations: string[]; recoveries: string[] } {
        const db = this.database;
        return db.transaction(() => {
            const node = db.getNode(nodeId);
            if (!node.compatible) return { commands: [], cancellations: [], recoveries: [] };
            const all = (db.sql.prepare("SELECT command_id FROM commands WHERE node_id=? AND state!='completed' ORDER BY created_at").all(nodeId) as Row[])
                .map(row => this.get(row.command_id));
            const running = all.some(c => c.state === 'accepted' || c.state === 'executing' || c.state === 'recovery_required');
            const accepted = all.filter(c => c.state === 'accepted');
            const commands = accepted.length ? accepted : running ? [] : all.filter(c => c.state === 'queued' || c.state === 'dispatched').slice(0, 1);
            for (const command of commands) {
                if (command.state === 'accepted') continue;
                db.sql.prepare("UPDATE commands SET state='dispatched',updated_at=? WHERE command_id=?").run(db.now(), command.commandId);
                command.state = 'dispatched';
            }
            const recoveries = db.sql.prepare("SELECT command_id FROM commands WHERE node_id=? AND state='recovery_required' AND recovery_requested=1").all(nodeId) as Row[];
            return { commands, cancellations: all.filter(c => c.cancelRequested).map(c => c.commandId),
                recoveries: recoveries.map(row => row.command_id) };
        });
    }

    acknowledge(nodeId: string, commandId: string): CommandRecord {
        const command = this.get(commandId);
        this.authorize(nodeId, command);
        if (command.state === 'queued' || command.state === 'dispatched') {
            if (!this.database.getNode(nodeId).compatible) throw new CentralError(409, 'protocol_incompatible', '节点协议不兼容，不能受理写指令');
            this.database.sql.prepare("UPDATE commands SET state='accepted',updated_at=? WHERE command_id=?").run(this.database.now(), commandId);
        }
        return this.get(commandId);
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

    private authorize(nodeId: string, command: CommandRecord): void {
        if (command.nodeId !== nodeId) throw new CentralError(403, 'forbidden', '任务不属于该节点');
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
            db.sql.prepare('UPDATE commands SET state=?,result=?,updated_at=?,recovery_requested=0 WHERE command_id=?').run(unresolved ? 'recovery_required' : 'completed', JSON.stringify(event.result), db.now(), commandId);
        } else {
            const state = event.type === 'recovery_required' ? 'recovery_required' : event.type === 'accepted' ? 'accepted' : 'executing';
            if (command.state === 'recovery_required') return;
            db.sql.prepare('UPDATE commands SET state=?,updated_at=? WHERE command_id=?').run(state, db.now(), commandId);
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
