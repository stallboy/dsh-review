import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, type NodeRecord, type NodeRegistration, type ProjectRecord, textValue, entityId } from '@dsh-review/protocol';
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
        this.sql.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('central_id',?)").run(randomUUID());
        this.centralId = (this.sql.prepare("SELECT value FROM metadata WHERE key='central_id'").get() as Row).value;
    }

    now(): string { return this.clock().toISOString(); }

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

    login(username: string, password: string): { user: User; token: string; csrfToken: string } {
        if (typeof password !== 'string' || password.length > 256) throw new CentralError(401, 'unauthorized', '账号或密码错误');
        const row = this.sql.prepare('SELECT * FROM users WHERE username=?').get(username) as Row | undefined;
        const salt = row?.salt ?? 'missing-user';
        const hash = row?.password_hash ?? '00'.repeat(64);
        const matches = passwordMatches(password, salt, hash);
        if (!row || !matches) throw new CentralError(401, 'unauthorized', '账号或密码错误');
        const token = secret(), csrfToken = secret();
        this.sql.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
        this.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), row.user_id, csrfToken,
            new Date(this.clock().getTime() + 12 * 60 * 60 * 1000).toISOString());
        return { user: { userId: row.user_id, username: row.username, reviewIdentity: row.review_identity }, token, csrfToken };
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

    initializeOwned(input: { reviewIdentity: string; password: string; node?: { nodeId: string; token: string } }): { nodeId: string; token: string } {
        textValue(input.reviewIdentity, 'reviewIdentity', 160);
        textValue(input.password, 'password', 256);
        return this.transaction(() => {
            const existing = this.sql.prepare("SELECT * FROM users WHERE username='local'").get() as Row | undefined;
            if (existing) {
                if (existing.review_identity !== input.reviewIdentity || !passwordMatches(input.password, existing.salt, existing.password_hash)) {
                    throw new CentralError(401, 'identity_mismatch', '本机账号凭据或审核身份不一致');
                }
            } else this.createUser({ username: 'local', password: input.password, reviewIdentity: input.reviewIdentity });
            if (input.node) {
                if (this.nodeIdentity(input.node.token) !== input.node.nodeId) throw new CentralError(401, 'identity_mismatch', '本机节点身份不一致');
                return input.node;
            }
            return this.createNode('本机插件节点');
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

    listNodes(): NodeRecord[] {
        return (this.sql.prepare('SELECT node_id FROM nodes ORDER BY name,node_id').all() as Row[]).map(row => this.getNode(row.node_id));
    }

    hasActiveNodeInstance(nodeId: string): boolean {
        const node = this.getNode(nodeId);
        return Boolean(node.enabled && node.lastSeenAt && this.clock().getTime() - Date.parse(node.lastSeenAt) <= 30000);
    }

    registerNode(nodeId: string, registration: NodeRegistration, admissionPaused = false): NodeRecord {
        return this.transaction(() => {
            const node = this.getNode(nodeId);
            if (this.hasActiveNodeInstance(nodeId) && node.instanceId !== registration.instanceId) throw new CentralError(409, 'instance_conflict', '相同节点已有活动实例');
            if (node.instanceId && node.instanceId !== registration.instanceId) {
                this.sql.prepare("UPDATE commands SET state='recovery_required',updated_at=? WHERE node_id=? AND state IN ('accepted','executing')").run(this.now(), nodeId);
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
        return Number((this.sql.prepare("SELECT COUNT(*) AS count FROM commands WHERE node_id=? AND state!='completed'").get(nodeId) as Row).count);
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
            this.sql.prepare("UPDATE commands SET state='recovery_required',updated_at=? WHERE node_id=? AND state IN ('accepted','executing')").run(this.now(), nodeId);
        });
    }

    getProject(projectId: string): ProjectRecord {
        entityId(projectId, 'projectId');
        const row = this.sql.prepare('SELECT * FROM projects WHERE project_id=?').get(projectId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '项目不存在');
        return { projectId: row.project_id, name: row.name, nodeId: row.node_id, workspaceId: row.workspace_id,
            bindingGeneration: row.binding_generation, projectConfigRevision: row.config_revision,
            vcsType: row.vcs_type, target: row.target, enabled: Boolean(row.enabled) };
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
        this.sql.prepare('INSERT INTO projects(project_id,name,node_id,workspace_id,vcs_type,target) VALUES (?,?,?,?,?,?)')
            .run(id, input.name, input.nodeId, input.workspaceId, workspace.vcsType, workspace.target);
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
        if (this.sql.prepare("SELECT 1 FROM commands WHERE project_id=? AND state!='completed'").get(projectId)) throw new CentralError(409, 'project_busy', '项目有未决操作，不能更改配置');
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
