import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RETIRED_MANUAL_REVISION, validateCommand, type ManagedCommand, type ManagedResult, type NodeEvent, type PendingCommandSummary } from '@dsh-review/protocol';

export interface JournalCommand {
    command: ManagedCommand;
    phase: 'accepted' | 'executing' | 'completed' | 'recovery_required';
    result?: ManagedResult;
}

export interface UnconfirmedEvents {
    commandId: string;
    projectId?: string;
    operation?: string;
    count: number;
    first: number;
    last: number;
}

export class ManagedJournal {
    private readonly database: DatabaseSync;
    private closed = false;

    constructor(filename: string) {
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.database = new DatabaseSync(filename);
        this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
                envelope TEXT NOT NULL, phase TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, result TEXT);
            CREATE TABLE IF NOT EXISTS outbox (command_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                event TEXT NOT NULL, PRIMARY KEY(command_id,sequence));
            CREATE TABLE IF NOT EXISTS snapshots (project_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS checkpoints (command_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces (workspace_id TEXT PRIMARY KEY, identity TEXT NOT NULL);
        `);
    }

    private transaction<T>(task: () => T): T {
        this.database.exec('BEGIN IMMEDIATE');
        try { const value = task(); this.database.exec('COMMIT'); return value; }
        catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }

    get(commandId: string): JournalCommand | null {
        const row = this.database.prepare('SELECT envelope,phase,result FROM commands WHERE id=?').get(commandId);
        return row ? { command: JSON.parse(String(row.envelope)), phase: String(row.phase) as JournalCommand['phase'],
            ...(row.result ? { result: JSON.parse(String(row.result)) } : {}) } : null;
    }

    accept(value: ManagedCommand): { fresh: boolean; record: JournalCommand } {
        const command = validateCommand(value, true);
        return this.transaction(() => {
            const previous = this.get(command.commandId);
            if (previous) {
                if (previous.command.requestHash !== command.requestHash) throw new Error('同一指令标识的内容摘要冲突');
                return { fresh: false, record: previous };
            }
            this.database.prepare("INSERT INTO commands(id,request_hash,envelope,phase) VALUES (?,?,?,'accepted')")
                .run(command.commandId, command.requestHash, JSON.stringify(command));
            return { fresh: true, record: this.get(command.commandId)! };
        });
    }

    markExecuting(commandId: string): void {
        const result = this.database.prepare("UPDATE commands SET phase='executing' WHERE id=? AND phase='accepted'").run(commandId);
        if (result.changes !== 1) throw new Error('指令尚未受理或已经执行，拒绝重复启动');
    }

    awaitingAcknowledgement(): ManagedCommand[] {
        return this.database.prepare("SELECT envelope FROM commands WHERE phase='accepted'").all()
            .map(row => validateCommand(JSON.parse(String(row.envelope)), true))
            .filter(command => command.scheduledAudit || command.operation === RETIRED_MANUAL_REVISION || command.operation === 'test');
    }

    settleBeforeExecution(commandId: string, result: ManagedResult): void {
        this.database.prepare("UPDATE commands SET phase='completed',result=? WHERE id=? AND phase='accepted'")
            .run(JSON.stringify(result), commandId);
    }

    interrupted(): JournalCommand[] {
        return this.database.prepare("SELECT id FROM commands WHERE phase='executing'").all().map(row => this.get(String(row.id))!);
    }

    emit(commandId: string, type: NodeEvent['type'], logs?: string[], result?: ManagedResult, auditTimeoutStopping?: true): NodeEvent {
        return this.transaction(() => {
            const row = this.database.prepare('SELECT sequence FROM commands WHERE id=?').get(commandId);
            if (!row) throw new Error('不能为未知指令写入事件');
            const sequence = Number(row.sequence) + 1;
            const event: NodeEvent = { commandId, sequence, type, ...(logs?.length ? { logs: logs.map(line => line.slice(0, 4000)) } : {}), ...(auditTimeoutStopping ? { auditTimeoutStopping } : {}), ...(result ? { result } : {}) };
            if (result) {
                const pending = result.outcome.status === 'RECOVERY_REQUIRED' || ['pending', 'conflict', 'unknown'].includes(result.delivery.state);
                this.database.prepare('UPDATE commands SET sequence=?,phase=?,result=? WHERE id=?').run(sequence, pending ? 'recovery_required' : 'completed', JSON.stringify(result), commandId);
            } else this.database.prepare('UPDATE commands SET sequence=? WHERE id=?').run(sequence, commandId);
            this.database.prepare('INSERT INTO outbox VALUES (?,?,?)').run(commandId, sequence, JSON.stringify(event));
            return event;
        });
    }

    pending(): NodeEvent[] {
        return this.database.prepare('SELECT event FROM outbox ORDER BY command_id,sequence LIMIT 100').all().map(row => JSON.parse(String(row.event)));
    }

    hasPendingEvent(commandId: string, sequence: number): boolean {
        return this.database.prepare('SELECT 1 FROM outbox WHERE command_id=? AND sequence=?').get(commandId, sequence) !== undefined;
    }

    acknowledge(commandId: string, sequence: number): void {
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('事件确认序号无效');
        this.database.prepare('DELETE FROM outbox WHERE command_id=? AND sequence<=?').run(commandId, sequence);
    }

    nextSnapshotSequence(projectId: string): number {
        return this.transaction(() => {
            const row = this.database.prepare('SELECT sequence FROM snapshots WHERE project_id=?').get(projectId);
            const next = Number(row?.sequence ?? 0) + 1;
            this.database.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?)').run(projectId, next);
            return next;
        });
    }

    checkpoint(commandId: string, data: Record<string, unknown>): void {
        this.database.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?,?)').run(commandId, JSON.stringify(data));
    }

    recoveryData(commandId: string): Record<string, unknown> | null {
        const row = this.database.prepare('SELECT data FROM checkpoints WHERE command_id=?').get(commandId);
        return row ? JSON.parse(String(row.data)) : null;
    }

    bindWorkspace(workspaceId: string, identity: string): void {
        const saved = this.database.prepare('SELECT identity FROM workspaces WHERE workspace_id=?').get(workspaceId);
        if (saved && saved.identity !== identity) throw new Error('同一 workspaceId 不能指向不同工作副本或目标');
        this.database.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?)').run(workspaceId, identity);
    }

    close(): void {
        if (!this.closed) { this.database.close(); this.closed = true; }
    }

    hasUnsettled(): boolean {
        return Boolean(this.database.prepare("SELECT 1 FROM commands WHERE phase!='completed' LIMIT 1").get()
            || this.database.prepare('SELECT 1 FROM outbox LIMIT 1').get());
    }

    unsettled(): { commands: PendingCommandSummary[]; events: UnconfirmedEvents[] } {
        const commands = this.database.prepare(`SELECT id, phase, json_extract(envelope,'$.projectId') AS projectId,
            json_extract(envelope,'$.operation') AS operation,
            COALESCE(json_extract(result,'$.outcome.detail'),json_extract(result,'$.outcome.message'),json_extract(result,'$.delivery.reason')) AS detail
            FROM commands WHERE phase!='completed' ORDER BY id`).all().map(row => ({
            commandId: String(row.id), projectId: String(row.projectId), operation: String(row.operation),
            state: row.phase as PendingCommandSummary['state'], ...(typeof row.detail === 'string' ? { detail: row.detail.slice(0, 600) } : {}),
        }));
        const events = this.database.prepare(`SELECT o.command_id, COUNT(*) AS count, MIN(o.sequence) AS first, MAX(o.sequence) AS last,
            json_extract(c.envelope,'$.projectId') AS projectId, json_extract(c.envelope,'$.operation') AS operation
            FROM outbox o LEFT JOIN commands c ON c.id=o.command_id GROUP BY o.command_id ORDER BY o.command_id`).all().map(row => ({
            commandId: String(row.command_id), count: Number(row.count), first: Number(row.first), last: Number(row.last),
            ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
            ...(typeof row.operation === 'string' ? { operation: row.operation } : {}),
        }));
        return { commands, events };
    }
}
