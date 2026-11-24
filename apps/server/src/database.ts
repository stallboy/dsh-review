import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type CommandRecord, type NodeRecord, type NodeRegistration, type PendingCommandSummary, type ProjectRecord, textValue, entityId } from '@dsh-review/protocol';
import { digest, passwordHash, passwordMatches, secret } from './auth.js';

export class CentralError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface User {
    userId: string;
    username: string;
    reviewIdentity: string;
}

export type Row = Record<string, any>;

function rollbackState(state: CommandRecord['state']): CommandRecord['state'] {
    return state === 'queued' || state === 'dispatched' || state === 'completed' ? 'completed' : 'recovery_required';
}

export function assignCommandState(state: CommandRecord['state']): string {
    return `state=CASE WHEN protected_state IS NULL THEN '${state}' ELSE '${rollbackState(state)}' END,
        protected_state=${state === 'completed' ? 'NULL' : `CASE WHEN protected_state IS NOT NULL THEN '${state}' END`}`;
}

export class CentralDatabase {
    readonly sql: DatabaseSync;
    readonly clock: () => Date;
    readonly centralId: string;
    private closed = false;

    constructor(readonly dataDir: string, clock: () => Date = () => new Date()) {
        this.clock = clock;
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.sql = new DatabaseSync(path.join(dataDir, 'central.sqlite'));
        this.sql.exec(`
            PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                review_identity TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
                csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1, registration TEXT, instance_id TEXT, last_seen_at TEXT);
            CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                node_id TEXT NOT NULL REFERENCES nodes, workspace_id TEXT NOT NULL, binding_generation INTEGER NOT NULL DEFAULT 1,
                config_revision INTEGER NOT NULL DEFAULT 1, vcs_type TEXT NOT NULL, target TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(node_id,workspace_id));
            CREATE TABLE IF NOT EXISTS commands (command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects,
                node_id TEXT NOT NULL REFERENCES nodes, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                envelope TEXT NOT NULL, state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT,
                last_event INTEGER NOT NULL DEFAULT 0, logs_total INTEGER NOT NULL DEFAULT 0,
                recovery_requested INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id,idempotency_key));
            CREATE UNIQUE INDEX IF NOT EXISTS one_project_writer ON commands(project_id) WHERE state!='completed';
            CREATE TABLE IF NOT EXISTS audit_schedules (project_id TEXT PRIMARY KEY REFERENCES projects,
                enabled INTEGER NOT NULL, start_time TEXT NOT NULL, time_zone TEXT NOT NULL,
                effective_at TEXT NOT NULL, review_identity TEXT NOT NULL, last_missed_at TEXT);
            CREATE TABLE IF NOT EXISTS audit_plans (project_id TEXT NOT NULL REFERENCES projects, plan_id TEXT NOT NULL,
                name TEXT NOT NULL, enabled INTEGER NOT NULL, start_time TEXT NOT NULL, time_zone TEXT NOT NULL,
                recurrence TEXT NOT NULL, note TEXT NOT NULL, effective_at TEXT NOT NULL,
                review_identity TEXT NOT NULL, last_missed_at TEXT, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id,plan_id));
            CREATE TABLE IF NOT EXISTS audit_plan_creations (project_id TEXT NOT NULL REFERENCES projects,
                request_key TEXT NOT NULL, request_hash TEXT NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY (project_id,request_key));
            CREATE TABLE IF NOT EXISTS events (command_id TEXT NOT NULL REFERENCES commands, sequence INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(command_id,sequence));
            CREATE TABLE IF NOT EXISTS logs (command_id TEXT NOT NULL REFERENCES commands, offset INTEGER NOT NULL,
                line TEXT NOT NULL, PRIMARY KEY(command_id,offset));
            CREATE TABLE IF NOT EXISTS snapshots (project_id TEXT PRIMARY KEY REFERENCES projects,
                binding_generation INTEGER NOT NULL, sequence INTEGER NOT NULL, vcs_snapshot TEXT NOT NULL, payload TEXT NOT NULL,
                received_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS queries (query_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects,
                cache_key TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
            CREATE TABLE IF NOT EXISTS artifacts (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
        `);
        if (!this.sql.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'received_at')) {
            this.sql.exec("ALTER TABLE snapshots ADD COLUMN received_at TEXT NOT NULL DEFAULT ''");
        }
        if (!this.sql.prepare('PRAGMA table_info(commands)').all().some(column => column.name === 'recovery_requested')) {
            this.sql.exec('ALTER TABLE commands ADD COLUMN recovery_requested INTEGER NOT NULL DEFAULT 0');
        }
        if (!this.sql.prepare('PRAGMA table_info(nodes)').all().some(column => column.name === 'admission_paused')) {
            this.sql.exec('ALTER TABLE nodes ADD COLUMN admission_paused INTEGER NOT NULL DEFAULT 0');
        }
        if (!this.sql.prepare('PRAGMA table_info(nodes)').all().some(column => column.name === 'workspace_issues')) {
            this.sql.exec("ALTER TABLE nodes ADD COLUMN workspace_issues TEXT NOT NULL DEFAULT '{}'");
        }
        if (!this.sql.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'execution_config_hash')) {
            this.sql.exec('ALTER TABLE projects ADD COLUMN execution_config_hash TEXT');
        }
        this.transaction(() => {
            if (!this.sql.prepare('PRAGMA table_info(audit_plans)').all().some(column => column.name === 'version')) {
                this.sql.exec('ALTER TABLE audit_plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
            }
            this.prepareCommandRollback();
            this.sql.exec(`INSERT INTO audit_plans (project_id,plan_id,name,enabled,start_time,time_zone,recurrence,note,
                effective_at,review_identity,last_missed_at)
                SELECT project_id,'legacy','每日全量审查',enabled,start_time,time_zone,'{"kind":"daily"}','',
                    effective_at,review_identity,last_missed_at FROM audit_schedules WHERE 1
                ON CONFLICT(project_id,plan_id) DO UPDATE SET
                    enabled=CASE WHEN excluded.enabled=1 OR (json_extract(audit_plans.recurrence,'$.kind')='daily' AND audit_plans.note='')
                        THEN excluded.enabled ELSE audit_plans.enabled END,
                    start_time=excluded.start_time,time_zone=excluded.time_zone,effective_at=excluded.effective_at,
                    review_identity=excluded.review_identity,last_missed_at=excluded.last_missed_at,version=audit_plans.version+1
                WHERE excluded.enabled!=(audit_plans.enabled AND json_extract(audit_plans.recurrence,'$.kind')='daily' AND audit_plans.note='')
                    OR excluded.start_time!=audit_plans.start_time OR excluded.time_zone!=audit_plans.time_zone
                    OR excluded.effective_at!=audit_plans.effective_at OR excluded.review_identity!=audit_plans.review_identity
                    OR excluded.last_missed_at IS NOT audit_plans.last_missed_at;`);
            for (const row of this.sql.prepare("SELECT project_id FROM audit_plans WHERE plan_id='legacy'").all()) {
                this.syncLegacyAuditSchedule(String(row.project_id));
            }
        });
        this.sql.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('central_id',?)").run(randomUUID());
        this.centralId = (this.sql.prepare("SELECT value FROM metadata WHERE key='central_id'").get() as Row).value;
    }

    now(): string { return this.clock().toISOString(); }

    private prepareCommandRollback(): void {
        if (!this.sql.prepare('PRAGMA table_info(commands)').all().some(column => column.name === 'protected_state')) {
            this.sql.exec("ALTER TABLE commands ADD COLUMN protected_state TEXT; ALTER TABLE commands ADD COLUMN active_state TEXT AS (COALESCE(protected_state,state));");
        }
        // 有补充要求的指令只能由理解能力守卫的中央重新派发。
        this.sql.exec(`UPDATE commands SET protected_state=state,
            state=CASE WHEN state IN ('queued','dispatched') THEN 'completed' ELSE 'recovery_required' END
            WHERE protected_state IS NULL AND state!='completed'
                AND json_extract(envelope,'$.scheduledAudit') IS NOT NULL AND json_extract(envelope,'$.payload.note')!='';
            UPDATE commands SET protected_state=NULL
                WHERE protected_state IS NOT NULL AND state='completed' AND result IS NOT NULL;
            UPDATE commands SET protected_state='recovery_required'
                WHERE protected_state IN ('accepted','executing') AND state='recovery_required' AND result IS NOT NULL;`);
        // 旧中央可在未受理指令暂不可见时合法接管同项目，重新升级不得抢占。
        this.sql.prepare(`UPDATE commands AS protected SET protected_state=NULL,updated_at=?,result=?
            WHERE protected_state IN ('queued','dispatched') AND (EXISTS (
                SELECT 1 FROM commands AS other WHERE other.project_id=protected.project_id AND other.state!='completed'
            ) OR NOT EXISTS (
                SELECT 1 FROM projects WHERE project_id=protected.project_id AND enabled=1
                    AND binding_generation=json_extract(protected.envelope,'$.bindingGeneration')
                    AND config_revision=json_extract(protected.envelope,'$.projectConfigRevision')
            ) OR (protected.idempotency_key GLOB 'scheduled-audit:????-??-??' AND EXISTS (
                SELECT 1 FROM audit_schedules AS legacy JOIN audit_plans AS plan USING(project_id)
                WHERE legacy.project_id=protected.project_id AND plan.plan_id='legacy'
                    AND (legacy.enabled!=(plan.enabled AND json_extract(plan.recurrence,'$.kind')='daily' AND plan.note='')
                        OR legacy.start_time!=plan.start_time OR legacy.time_zone!=plan.time_zone
                        OR legacy.effective_at!=plan.effective_at OR legacy.review_identity!=plan.review_identity)
            )))`).run(this.now(), JSON.stringify({
            outcome: { status: 'ABORTED', reason: 'SCHEDULE_ROLLBACK_CONFLICT', message: '回退期间项目配置已变化或已有任务，本轮未启动' },
            delivery: { state: 'not_required' },
        }));
    }

    syncLegacyAuditSchedule(projectId: string): void {
        // 旧中央只理解每日全仓计划，扩展计划回退期间须保持停用。
        this.sql.prepare(`INSERT INTO audit_schedules (project_id,enabled,start_time,time_zone,effective_at,review_identity,last_missed_at)
            SELECT project_id,(enabled AND json_extract(recurrence,'$.kind')='daily' AND note=''),start_time,time_zone,
                effective_at,review_identity,last_missed_at FROM audit_plans WHERE plan_id='legacy' AND project_id=?
            ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,start_time=excluded.start_time,time_zone=excluded.time_zone,
                effective_at=excluded.effective_at,review_identity=excluded.review_identity,last_missed_at=excluded.last_missed_at`).run(projectId);
    }

    transaction<T>(task: () => T): T {
        this.sql.exec('BEGIN IMMEDIATE');
        try { const result = task(); this.sql.exec('COMMIT'); return result; }
        catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    }

    createUser(input: { username: string; password: string; reviewIdentity: string }): User {
        textValue(input.username, 'username', 80);
        textValue(input.reviewIdentity, 'reviewIdentity', 160);
        if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) throw new CentralError(422, 'bad_request', '密码长度须为 12 至 256 个字符');
        const { salt, hash } = passwordHash(input.password);
        const user = { userId: randomUUID(), username: input.username, reviewIdentity: input.reviewIdentity };
        this.sql.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.userId, user.username, user.reviewIdentity, salt, hash);
        return user;
    }

    authenticateUser(username: string, password: string): User {
        if (typeof password !== 'string' || password.length > 256) throw new CentralError(401, 'unauthorized', '账号或密码错误');
        const row = this.sql.prepare('SELECT * FROM users WHERE username=?').get(username) as Row | undefined;
        const salt = row?.salt ?? 'missing-user';
        const hash = row?.password_hash ?? '00'.repeat(64);
        const matches = passwordMatches(password, salt, hash);
        if (!row || !matches) throw new CentralError(401, 'unauthorized', '账号或密码错误');
        return { userId: row.user_id, username: row.username, reviewIdentity: row.review_identity };
    }

    login(username: string, password: string): { user: User; token: string; csrfToken: string } {
        const user = this.authenticateUser(username, password);
        const token = secret(), csrfToken = secret();
        this.sql.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
        this.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), user.userId, csrfToken,
            new Date(this.clock().getTime() + 12 * 60 * 60 * 1000).toISOString());
        return { user, token, csrfToken };
    }

    session(token: string): { user: User; csrfToken: string } {
        const row = this.sql.prepare(`SELECT users.*,sessions.csrf FROM sessions JOIN users USING(user_id)
            WHERE token_hash=? AND expires_at>?`).get(digest(token), this.now()) as Row | undefined;
        if (!row) throw new CentralError(401, 'unauthorized', '请先登录');
        return { user: { userId: row.user_id, username: row.username, reviewIdentity: row.review_identity }, csrfToken: row.csrf };
    }

    logout(token: string): void { this.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); }

    createNode(name: string): { nodeId: string; token: string } {
        textValue(name, 'name', 160);
        const nodeId = randomUUID(), token = secret();
        this.sql.prepare('INSERT INTO nodes(node_id,name,token_hash) VALUES (?,?,?)').run(nodeId, name, digest(token));
        return { nodeId, token };
    }

    initializeOwned(input: { reviewIdentity: string; password: string; node?: { nodeId: string; token: string } }): { user: User; node: { nodeId: string; token: string } } {
        textValue(input.reviewIdentity, 'reviewIdentity', 160);
        textValue(input.password, 'password', 256);
        return this.transaction(() => {
            const existing = this.sql.prepare("SELECT * FROM users WHERE username='local'").get() as Row | undefined;
            if (existing && (existing.review_identity !== input.reviewIdentity || !passwordMatches(input.password, existing.salt, existing.password_hash))) {
                throw new CentralError(401, 'identity_mismatch', '本机账号凭据或审核身份不一致');
            }
            const user = existing ? { userId: existing.user_id, username: existing.username, reviewIdentity: existing.review_identity }
                : this.createUser({ username: 'local', password: input.password, reviewIdentity: input.reviewIdentity });
            if (input.node && this.nodeIdentity(input.node.token) !== input.node.nodeId) {
                throw new CentralError(401, 'identity_mismatch', '本机节点身份不一致');
            }
            return { user, node: input.node ?? this.createNode('本机插件节点') };
        });
    }

    nodeIdentity(token: string): string {
        const row = this.sql.prepare('SELECT node_id FROM nodes WHERE token_hash=? AND enabled=1').get(digest(token)) as Row | undefined;
        if (!row) throw new CentralError(401, 'unauthorized', '节点凭据无效');
        return row.node_id;
    }

    getNode(nodeId: string): NodeRecord {
        const row = this.sql.prepare('SELECT * FROM nodes WHERE node_id=?').get(nodeId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '节点不存在');
        const registration: NodeRegistration = row.registration ? JSON.parse(row.registration) : {
            protocolVersion: 0, instanceId: '', pluginVersion: '', dshVersion: '', platform: '', workspaces: [],
        };
        return { ...registration, nodeId, name: row.name, enabled: Boolean(row.enabled), lastSeenAt: row.last_seen_at,
            compatible: registration.protocolVersion === PROTOCOL_VERSION,
            online: Boolean(row.enabled && !row.admission_paused && row.last_seen_at && this.clock().getTime() - Date.parse(row.last_seen_at) <= 30000) };
    }

    workspaceIssues(nodeId: string): Record<string, string> {
        const row = this.sql.prepare('SELECT workspace_issues FROM nodes WHERE node_id=?').get(nodeId) as Row | undefined;
        return JSON.parse(row?.workspace_issues ?? '{}');
    }

    setWorkspaceIssues(nodeId: string, issues: Record<string, string>): void {
        this.sql.prepare('UPDATE nodes SET workspace_issues=? WHERE node_id=?').run(JSON.stringify(issues), nodeId);
    }

    listNodes(): NodeRecord[] {
        return (this.sql.prepare('SELECT node_id FROM nodes ORDER BY name,node_id').all() as Row[]).map(row => this.getNode(row.node_id));
    }

    hasActiveNodeInstance(nodeId: string): boolean {
        const node = this.getNode(nodeId);
        return Boolean(node.enabled && node.lastSeenAt && this.clock().getTime() - Date.parse(node.lastSeenAt) <= 30000);
    }

    registerNode(nodeId: string, registration: NodeRegistration, admissionPaused = false, workspaceIssues?: Record<string, string>): NodeRecord {
        return this.transaction(() => {
            const node = this.getNode(nodeId);
            if (this.hasActiveNodeInstance(nodeId) && node.instanceId !== registration.instanceId) throw new CentralError(409, 'instance_conflict', '相同节点已有活动实例');
            for (const project of this.listProjects(nodeId)) {
                const workspace = registration.workspaces.find(value => value.workspaceId === project.workspaceId);
                if (!workspace) continue;
                if (workspace.vcsType !== project.vcsType || workspace.target !== project.target) throw new CentralError(409, 'binding_mismatch', '既有项目的工作副本目标不能变更');
                if (workspace.executionConfigHash === project.executionConfigHash) continue;
                if (!workspace.executionConfigHash) throw new CentralError(409, 'configuration_required', '节点必须继续提供已登记的执行配置摘要');
                if (!project.executionConfigHash) {
                    this.sql.prepare("UPDATE commands SET cancel_requested=1,updated_at=? WHERE project_id=? AND active_state IN ('queued','dispatched')").run(this.now(), project.projectId);
                    this.sql.prepare(`UPDATE commands SET ${assignCommandState('recovery_required')},updated_at=? WHERE project_id=? AND active_state IN ('accepted','executing')`).run(this.now(), project.projectId);
                    this.sql.prepare('UPDATE projects SET execution_config_hash=? WHERE project_id=?').run(workspace.executionConfigHash, project.projectId);
                    continue;
                }
                if (this.sql.prepare("SELECT 1 FROM commands WHERE project_id=? AND active_state!='completed'").get(project.projectId)) throw new CentralError(409, 'project_busy', '项目有未决操作，不能更改执行配置');
                this.sql.prepare('UPDATE projects SET execution_config_hash=?,config_revision=config_revision+1 WHERE project_id=?')
                    .run(workspace.executionConfigHash ?? null, project.projectId);
            }
            if (workspaceIssues || node.instanceId !== registration.instanceId) this.setWorkspaceIssues(nodeId, workspaceIssues ?? {});
            if (node.instanceId && node.instanceId !== registration.instanceId) {
                this.sql.prepare(`UPDATE commands SET ${assignCommandState('recovery_required')},updated_at=? WHERE node_id=? AND active_state IN ('accepted','executing')`).run(this.now(), nodeId);
            }
            const paused = node.instanceId === registration.instanceId
                ? Number((this.sql.prepare('SELECT admission_paused FROM nodes WHERE node_id=?').get(nodeId) as Row).admission_paused)
                : admissionPaused ? 1 : 0;
            this.sql.prepare('UPDATE nodes SET registration=?,instance_id=?,last_seen_at=?,admission_paused=? WHERE node_id=?')
                .run(JSON.stringify(registration), registration.instanceId, this.now(), paused, nodeId);
            return this.getNode(nodeId);
        });
    }

    touchNode(nodeId: string, instanceId: string): NodeRecord {
        const node = this.getNode(nodeId);
        if (!node.enabled || !instanceId || node.instanceId !== instanceId) throw new CentralError(409, 'instance_conflict', '节点实例已失效，请重新核验');
        this.sql.prepare('UPDATE nodes SET last_seen_at=? WHERE node_id=?').run(this.now(), nodeId);
        return this.getNode(nodeId);
    }

    revokeNode(nodeId: string): void {
        this.getNode(nodeId);
        this.sql.prepare('UPDATE nodes SET enabled=0 WHERE node_id=?').run(nodeId);
    }

    pendingNodeCommands(nodeId: string): number {
        return Number((this.sql.prepare("SELECT COUNT(*) AS count FROM commands WHERE node_id=? AND active_state!='completed'").get(nodeId) as Row).count);
    }

    pendingNodeCommandDetails(nodeId: string): PendingCommandSummary[] {
        const rows = this.sql.prepare(`SELECT command_id, project_id, state, json_extract(envelope,'$.operation') AS operation,
            COALESCE(json_extract(result,'$.outcome.detail'),json_extract(result,'$.outcome.message'),json_extract(result,'$.delivery.reason')) AS detail
            FROM commands WHERE node_id=? AND state!='completed' ORDER BY updated_at DESC, command_id LIMIT 30`).all(nodeId);
        return rows.map(row => ({ commandId: String(row.command_id), projectId: String(row.project_id),
            operation: String(row.operation), state: row.state as PendingCommandSummary['state'],
            ...(typeof row.detail === 'string' ? { detail: row.detail.slice(0, 600) } : {}) }));
    }

    quiesceNode(nodeId: string, instanceId: string): void {
        this.transaction(() => {
            const node = this.getNode(nodeId);
            if (!node.enabled || !instanceId || node.instanceId !== instanceId) throw new CentralError(409, 'instance_conflict', '节点实例已失效，请重新核验');
            if (this.pendingNodeCommands(nodeId)) throw new CentralError(409, 'node_busy', '节点有未决操作，不能暂停接入');
            this.sql.prepare('UPDATE nodes SET admission_paused=1 WHERE node_id=?').run(nodeId);
        });
    }

    activateNode(nodeId: string, instanceId: string): void {
        this.transaction(() => {
            this.touchNode(nodeId, instanceId);
            this.sql.prepare('UPDATE nodes SET admission_paused=0 WHERE node_id=?').run(nodeId);
        });
    }

    disconnectNode(nodeId: string, instanceId: string): void {
        this.transaction(() => {
            const node = this.getNode(nodeId);
            if (!node.enabled || !instanceId || node.instanceId !== instanceId) throw new CentralError(409, 'instance_conflict', '节点实例已失效，请重新核验');
            this.sql.prepare('UPDATE nodes SET last_seen_at=NULL,admission_paused=1 WHERE node_id=?').run(nodeId);
            this.sql.prepare(`UPDATE commands SET ${assignCommandState('recovery_required')},updated_at=? WHERE node_id=? AND active_state IN ('accepted','executing')`).run(this.now(), nodeId);
        });
    }

    getProject(projectId: string): ProjectRecord {
        entityId(projectId, 'projectId');
        const row = this.sql.prepare('SELECT * FROM projects WHERE project_id=?').get(projectId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '项目不存在');
        return { projectId: row.project_id, name: row.name, nodeId: row.node_id, workspaceId: row.workspace_id,
            bindingGeneration: row.binding_generation, projectConfigRevision: row.config_revision,
            vcsType: row.vcs_type, target: row.target, enabled: Boolean(row.enabled),
            ...(row.execution_config_hash ? { executionConfigHash: row.execution_config_hash } : {}) };
    }

    listProjects(nodeId?: string): ProjectRecord[] {
        const rows = nodeId ? this.sql.prepare('SELECT project_id FROM projects WHERE node_id=? ORDER BY name').all(nodeId)
            : this.sql.prepare('SELECT project_id FROM projects ORDER BY name').all();
        return (rows as Row[]).map(row => this.getProject(row.project_id));
    }

    bindProject(input: { name: string; nodeId: string; workspaceId: string }): ProjectRecord {
        textValue(input.name, 'name', 160);
        const node = this.getNode(input.nodeId);
        const workspace = node.workspaces.find(w => w.workspaceId === input.workspaceId);
        if (!workspace || !node.enabled || !node.compatible) throw new CentralError(409, 'workspace_unavailable', '节点没有可绑定的工作副本');
        const id = randomUUID();
        this.sql.prepare('INSERT INTO projects(project_id,name,node_id,workspace_id,vcs_type,target,execution_config_hash) VALUES (?,?,?,?,?,?,?)')
            .run(id, input.name, input.nodeId, input.workspaceId, workspace.vcsType, workspace.target, workspace.executionConfigHash ?? null);
        return this.getProject(id);
    }

    ensureNodeProject(nodeId: string, input: { instanceId: string; workspaceId: string; name: string; enabled: boolean; restore?: boolean }): ProjectRecord {
        entityId(input.workspaceId, 'workspaceId');
        textValue(input.name, 'name', 160);
        return this.transaction(() => {
            const node = this.touchNode(nodeId, input.instanceId);
            const existing = this.sql.prepare('SELECT project_id FROM projects WHERE node_id=? AND workspace_id=?').get(nodeId, input.workspaceId) as Row | undefined;
            const project = existing ? this.getProject(existing.project_id) : undefined;
            if (!node.compatible || (!node.workspaces.some(workspace => workspace.workspaceId === input.workspaceId) && (!project || input.enabled))) {
                throw new CentralError(409, 'workspace_unavailable', '节点没有可绑定的工作副本');
            }
            if (project && input.restore) return project;
            if (project && project.name === input.name && project.enabled === input.enabled) return project;
            if (this.pendingNodeCommands(nodeId)) throw new CentralError(409, 'project_busy', '节点有未决操作，不能更改项目接入');
            if (project) return this.updateProject(project.projectId, { name: input.name, enabled: input.enabled });
            if (!input.enabled) throw new CentralError(409, 'workspace_unavailable', '首次接入的工作副本必须启用');
            return this.bindProject({ nodeId, workspaceId: input.workspaceId, name: input.name });
        });
    }

    updateProject(projectId: string, input: { name?: string; enabled?: boolean }): ProjectRecord {
        this.getProject(projectId);
        if (this.sql.prepare("SELECT 1 FROM commands WHERE project_id=? AND active_state!='completed'").get(projectId)) throw new CentralError(409, 'project_busy', '项目有未决操作，不能更改配置');
        if (input.name !== undefined) this.sql.prepare('UPDATE projects SET name=? WHERE project_id=?').run(textValue(input.name, 'name', 160), projectId);
        if (input.enabled !== undefined) this.sql.prepare('UPDATE projects SET enabled=? WHERE project_id=?').run(input.enabled ? 1 : 0, projectId);
        return this.getProject(projectId);
    }

    assertNodeProject(nodeId: string, projectId: string): ProjectRecord {
        const project = this.getProject(projectId);
        if (project.nodeId !== nodeId) throw new CentralError(403, 'forbidden', '项目不属于该节点');
        return project;
    }

    close(): void {
        if (!this.closed) { this.sql.close(); this.closed = true; }
    }
}
