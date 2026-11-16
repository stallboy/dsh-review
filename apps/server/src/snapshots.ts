import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { record, textValue, validateSnapshot, type JsonRecord, type ManagedQuery, type ProjectSnapshot, type QueryKind } from '@dsh-review/protocol';
import { digest, stableJson } from './auth.js';
import { CentralDatabase, CentralError, type Row } from './database.js';

export class Snapshots {
    constructor(private readonly database: CentralDatabase) {}

    get(projectId: string): ProjectSnapshot | null {
        this.database.getProject(projectId);
        const row = this.database.sql.prepare('SELECT payload FROM snapshots WHERE project_id=?').get(projectId) as Row | undefined;
        return row ? JSON.parse(row.payload) : null;
    }

    publish(nodeId: string, value: unknown): ProjectSnapshot {
        const snapshot = validateSnapshot(value), db = this.database;
        return db.transaction(() => {
            const project = db.assertNodeProject(nodeId, snapshot.projectId);
            if (snapshot.bindingGeneration !== project.bindingGeneration || snapshot.projectConfigRevision !== project.projectConfigRevision) throw new CentralError(409, 'binding_mismatch', '快照绑定或配置不一致');
            const old = this.get(snapshot.projectId);
            if (old && old.bindingGeneration === snapshot.bindingGeneration && old.snapshotSequence >= snapshot.snapshotSequence) {
                if (stableJson(old) === stableJson(snapshot)) return old;
                throw new CentralError(409, 'stale_snapshot', '拒绝过期或冲突快照');
            }
            for (const artifact of snapshot.artifacts ?? []) {
                const saved = db.sql.prepare('SELECT size FROM artifacts WHERE hash=?').get(artifact.hash) as Row | undefined;
                if (!saved || saved.size !== artifact.size) throw new CentralError(409, 'missing_artifact', '快照附件尚未完整同步');
            }
            db.sql.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?)').run(snapshot.projectId, snapshot.bindingGeneration, snapshot.snapshotSequence, snapshot.vcsSnapshot, JSON.stringify(snapshot), db.now());
            return snapshot;
        });
    }

    view(projectId: string): JsonRecord {
        const project = this.database.getProject(projectId), node = this.database.getNode(project.nodeId), snapshot = this.get(projectId);
        const received = this.database.sql.prepare('SELECT received_at FROM snapshots WHERE project_id=?').get(projectId);
        const fresh = received && Date.parse(this.database.now()) - Date.parse(String(received.received_at)) <= 30000;
        return { project, online: node.online, compatible: node.compatible, vcsSnapshot: snapshot?.vcsSnapshot ?? null,
            collectedAt: snapshot?.collectedAt ?? null, snapshotSequence: snapshot?.snapshotSequence ?? null,
            lastSyncedAt: received?.received_at ?? null,
            freshness: !snapshot ? 'not_synced' : !node.online ? 'offline' : fresh ? 'synced' : 'stale',
            writable: Boolean(project.enabled && node.online && node.compatible && fresh && !this.database.sql.prepare("SELECT 1 FROM commands WHERE project_id=? AND state!='completed'").get(projectId)) };
    }

    query(projectId: string, kind: QueryKind, params: JsonRecord): { status: number; body: JsonRecord } {
        const project = this.database.getProject(projectId), view = this.view(projectId), snapshot = this.get(projectId);
        if (!snapshot) throw new CentralError(503, 'not_synced', '项目尚未同步');
        const cacheKey = digest(stableJson({ projectId, generation: project.bindingGeneration, snapshot: snapshot.vcsSnapshot, kind, params }));
        let row = this.database.sql.prepare('SELECT query_id,state,result FROM queries WHERE cache_key=?').get(cacheKey) as Row | undefined;
        if (row?.state === 'ready') return { status: 200, body: { ...view, data: JSON.parse(row.result) } };
        if (!view.online) throw new CentralError(503, 'node_offline', '节点离线且该版本详情尚未缓存');
        if (row?.state === 'snapshot_moved') throw new CentralError(409, 'snapshot_moved', '节点版本已经变化，请刷新项目');
        if (row?.state === 'error') {
            this.database.sql.prepare("UPDATE queries SET state='retired',cache_key=? WHERE query_id=?").run(`retired:${row.query_id}`, row.query_id);
            row = undefined;
        }
        const queryId = row?.query_id ?? randomUUID();
        if (!row) {
            const query: ManagedQuery = { queryId, projectId, bindingGeneration: project.bindingGeneration, vcsSnapshot: snapshot.vcsSnapshot, kind, params };
            this.database.sql.prepare("INSERT INTO queries VALUES (?,?,?,?,'pending',NULL)").run(queryId, projectId, cacheKey, JSON.stringify(query));
        }
        return { status: 202, body: { ...view, queryId, pollUrl: `/api/v1/queries/${queryId}` } };
    }

    pending(nodeId: string): ManagedQuery[] {
        return (this.database.sql.prepare(`SELECT queries.envelope FROM queries JOIN projects USING(project_id)
            WHERE queries.state='pending' AND projects.node_id=? LIMIT 20`).all(nodeId) as Row[]).map(row => JSON.parse(row.envelope));
    }

    complete(nodeId: string, value: unknown): void {
        const result = record(value, 'queryResult'), queryId = textValue(result.queryId, 'queryId');
        const row = this.database.sql.prepare('SELECT * FROM queries WHERE query_id=?').get(queryId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '查询不存在');
        const query = JSON.parse(row.envelope) as ManagedQuery;
        const project = this.database.assertNodeProject(nodeId, query.projectId);
        if (project.bindingGeneration !== query.bindingGeneration) throw new CentralError(409, 'binding_mismatch', '查询绑定已变化');
        if (row.state === 'retired' || row.state === 'ready') return;
        if (!['ready', 'snapshot_moved', 'error'].includes(String(result.status))) throw new CentralError(422, 'bad_request', '查询结果无效');
        if (result.status === 'ready' && result.vcsSnapshot !== query.vcsSnapshot) throw new CentralError(409, 'snapshot_mismatch', '不能把其他快照放入查询缓存');
        const content = result.data as JsonRecord | undefined;
        if (result.status === 'ready' && content?.type === 'central-artifact') {
            const artifact = this.database.sql.prepare('SELECT size FROM artifacts WHERE hash=?').get(String(content.hash));
            if (!artifact || artifact.size !== content.size) throw new CentralError(409, 'missing_artifact', '详情附件尚未完整同步');
        }
        this.database.sql.prepare('UPDATE queries SET state=?,result=? WHERE query_id=?').run(String(result.status), JSON.stringify(result.status === 'ready' ? result.data ?? null : { error: result.error ?? String(result.status) }), queryId);
    }

    queryStatus(queryId: string): JsonRecord {
        const row = this.database.sql.prepare('SELECT state,result,envelope FROM queries WHERE query_id=?').get(queryId) as Row | undefined;
        if (!row) throw new CentralError(404, 'not_found', '查询不存在');
        const query = JSON.parse(row.envelope) as ManagedQuery;
        const current = this.get(query.projectId);
        if (current?.vcsSnapshot !== query.vcsSnapshot) return { state: 'snapshot_moved', projectId: query.projectId };
        return { state: row.state, projectId: query.projectId, vcsSnapshot: query.vcsSnapshot, ...(row.result ? { data: JSON.parse(row.result) } : {}) };
    }

    async putArtifact(hash: string, bytes: Buffer): Promise<void> {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new CentralError(422, 'bad_request', '附件摘要无效');
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new CentralError(422, 'hash_mismatch', '附件摘要不匹配');
        const directory = path.join(this.database.dataDir, 'artifacts');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, `${hash}.${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, path.join(directory, hash));
        this.database.sql.prepare('INSERT OR REPLACE INTO artifacts VALUES (?,?)').run(hash, bytes.length);
    }

    async artifact(hash: string): Promise<Buffer> {
        if (!/^[a-f0-9]{64}$/.test(hash) || !this.database.sql.prepare('SELECT 1 FROM artifacts WHERE hash=?').get(hash)) throw new CentralError(404, 'not_found', '附件不存在');
        return readFile(path.join(this.database.dataDir, 'artifacts', hash));
    }
}
