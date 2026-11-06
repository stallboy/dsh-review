import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { load, dump } from './yaml.js';

/**
 * §3 audit.md 新契约：目录式审查档案（audits/<audit_id>/audit.md）+ §3.4 finding 投影。
 * 旧扁平 audits/*.md 不参与新流程（§10 开发期数据删除重建）。
 */

export class AuditFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditFormatError';
  }
}

export type AuditTrigger = 'manual' | 'scheduled';
export type AuditItemKind = 'confirm' | 'deferred';
export type AuditItemStatus = 'pending' | 'converted' | 'dismissed' | 'resolved';

export interface AuditItem {
  findingId: string;
  kind: AuditItemKind;
  title: string;
  summary: string;
  targetFiles: string[];
  dependsOn: string | null;
  status: AuditItemStatus;
  candidate: string | null;
}

export interface AuditFrontmatter {
  schemaVersion: number;
  auditId: string;
  createdAt: string;
  baseRevision: string;
  scope: string;
  trigger: AuditTrigger;
  previousAudit: string | null;
  candidates: string[];
  items: AuditItem[];
}

export interface AuditRecord {
  meta: AuditFrontmatter;
  body: string;
  /** 档案所在目录名（应等于 audit_id）。 */
  dirName: string;
  reviewPath: string;
  parseError?: string;
}

const AUDIT_DIR_PATTERN = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*$/;
const FINDING_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  // §2.2：接受 YAML 裸 ISO 时间对象并规范化为 UTC（Z）ISO 字符串。
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') throw new AuditFormatError(`${field} 必须是字符串`);
  return value;
}

function parseItem(value: unknown, index: number): AuditItem {
  if (!isRecord(value)) throw new AuditFormatError(`items[${String(index)}] 必须是对象`);
  const kind = asString(value['kind'], `items[${String(index)}].kind`);
  if (kind !== 'confirm' && kind !== 'deferred') {
    throw new AuditFormatError(`items[${String(index)}].kind 只能是 confirm | deferred`);
  }
  const status = asString(value['status'], `items[${String(index)}].status`);
  if (!['pending', 'converted', 'dismissed', 'resolved'].includes(status)) {
    throw new AuditFormatError(`items[${String(index)}].status 非法：${status}`);
  }
  const itemStatus = status as AuditItemStatus;
  const dependsOn = value['depends_on'] === null || value['depends_on'] === undefined ? null : asString(value['depends_on'], `items[${String(index)}].depends_on`);
  const candidate = value['candidate'] === null || value['candidate'] === undefined ? null : asString(value['candidate'], `items[${String(index)}].candidate`);
  const findingId = asString(value['finding_id'], `items[${String(index)}].finding_id`);
  if (!FINDING_ID_PATTERN.test(findingId)) {
    throw new AuditFormatError(`items[${String(index)}].finding_id 格式非法：${findingId}`);
  }
  return {
    findingId,
    kind,
    title: asString(value['title'], `items[${String(index)}].title`),
    summary: asString(value['summary'], `items[${String(index)}].summary`),
    targetFiles: Array.isArray(value['target_files']) ? value['target_files'].map((f) => String(f)) : [],
    dependsOn,
    status: itemStatus,
    candidate,
  };
}

export function parseAuditMarkdown(text: string): { meta: AuditFrontmatter; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) throw new AuditFormatError('audit.md 缺少 YAML Frontmatter');
  let doc: unknown;
  try {
    doc = load(match[1] ?? '', { json: true });
  } catch (error) {
    throw new AuditFormatError(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(doc)) throw new AuditFormatError('audit.md Frontmatter 必须是 YAML 对象');
  const schemaVersion = Number(doc['schema_version']);
  if (schemaVersion !== 1) throw new AuditFormatError(`不支持的 schema_version：${String(doc['schema_version'])}`);
  const trigger = asString(doc['trigger'], 'trigger');
  if (trigger !== 'manual' && trigger !== 'scheduled') throw new AuditFormatError('trigger 只能是 manual | scheduled');
  const scope = asString(doc['scope'], 'scope');
  if (scope !== '.' && (scope.startsWith('/') || scope.includes('..') || scope.includes('\\') || scope.startsWith('./') || scope.endsWith('/'))) {
    throw new AuditFormatError(`scope 非法：${scope}`);
  }
  return {
    meta: {
      schemaVersion,
      auditId: asString(doc['audit_id'], 'audit_id'),
      createdAt: asString(doc['created_at'], 'created_at'),
      baseRevision: asString(doc['base_revision'], 'base_revision'),
      scope,
      trigger,
      previousAudit: doc['previous_audit'] === null || doc['previous_audit'] === undefined ? null : asString(doc['previous_audit'], 'previous_audit'),
      candidates: Array.isArray(doc['candidates']) ? doc['candidates'].map((c) => String(c)) : [],
      items: (Array.isArray(doc['items']) ? doc['items'] : []).map(parseItem),
    },
    body: normalized.slice(match[0].length),
  };
}

export function serializeAuditMarkdown(meta: AuditFrontmatter, body: string): string {
  const doc: Record<string, unknown> = {
    schema_version: meta.schemaVersion,
    audit_id: meta.auditId,
    created_at: meta.createdAt,
    base_revision: meta.baseRevision,
    scope: meta.scope,
    trigger: meta.trigger,
    previous_audit: meta.previousAudit,
    candidates: meta.candidates,
    items: meta.items.map((item) => ({
      finding_id: item.findingId,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      target_files: item.targetFiles,
      depends_on: item.dependsOn,
      status: item.status,
      candidate: item.candidate,
    })),
  };
  const yamlText = dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n$/, '');
  return `---\n${yamlText}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

/** §13.2 读取审查：I1（audit 部分）、I9、I10、I13。返回错误列表；空即有效。 */
export function auditInvariantErrors(meta: AuditFrontmatter, dirName: string): string[] {
  const errors: string[] = [];
  if (!AUDIT_DIR_PATTERN.test(dirName)) errors.push(`I1: audit 目录名非法：${dirName}`);
  if (meta.auditId !== dirName) errors.push(`I1: audit_id=${meta.auditId} 与目录名 ${dirName} 不一致`);
  // I9：converted ⟺ candidate 非空。
  for (const item of meta.items) {
    const at = `items[${item.findingId}]`;
    if (item.status === 'converted' && !item.candidate) errors.push(`I9: ${at} converted 但 candidate 为空`);
    if (item.status !== 'converted' && item.candidate) errors.push(`I9: ${at} 非 converted 但 candidate 非空`);
    // I10：deferred 必须有依赖；confirm 必须没有。
    if (item.kind === 'deferred' && !item.dependsOn) errors.push(`I10: ${at} deferred 缺少 depends_on`);
    if (item.kind === 'confirm' && item.dependsOn) errors.push(`I10: ${at} confirm 不应有 depends_on`);
  }
  // I13：audit_id 时间戳与 created_at 指向同一开始时刻（分钟粒度）。
  const stamp = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(meta.auditId);
  if (stamp) {
    const created = new Date(meta.createdAt);
    if (Number.isNaN(created.getTime())) {
      errors.push('I13: created_at 无法解析');
    } else {
      const local = new Date(created.getTime() - created.getTimezoneOffset() * 60_000);
      const compact = local.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      if (compact !== stamp.slice(1).join('')) errors.push(`I13: audit_id 时间戳与 created_at 不一致：${meta.auditId} vs ${meta.createdAt}`);
    }
  }
  return errors;
}

export class AuditArchive {
  constructor(readonly repoRoot: string) {}

  private get auditsRoot(): string {
    return path.join(this.repoRoot, '.ai-review', 'audits');
  }

  /** 列出目录式档案（目录名合法且含 audit.md）；旧扁平 *.md 不参与。 */
  async list(): Promise<AuditRecord[]> {
    const records: AuditRecord[] = [];
    let dirs: string[] = [];
    try {
      dirs = (await readdir(this.auditsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && AUDIT_DIR_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return records;
    }
    dirs.sort();
    for (const dirName of dirs) {
      const reviewPath = path.join(this.auditsRoot, dirName, 'audit.md');
      if (!existsSync(reviewPath)) continue;
      const record = await this.read(dirName);
      records.push(record);
    }
    return records;
  }

  async read(dirName: string): Promise<AuditRecord> {
    const reviewPath = path.join(this.auditsRoot, dirName, 'audit.md');
    const text = await readFile(reviewPath, 'utf8');
    try {
      const parsed = parseAuditMarkdown(text);
      const errors = auditInvariantErrors(parsed.meta, dirName);
      if (errors.length > 0) {
        return { meta: parsed.meta, body: parsed.body, dirName, reviewPath, parseError: errors.join('；') };
      }
      return { meta: parsed.meta, body: parsed.body, dirName, reviewPath };
    } catch (error) {
      if (!(error instanceof AuditFormatError)) throw error;
      return {
        meta: {
          schemaVersion: 1, auditId: dirName, createdAt: '', baseRevision: '', scope: '.',
          trigger: 'manual', previousAudit: null, candidates: [], items: [],
        },
        body: '',
        dirName,
        reviewPath,
        parseError: error.message,
      };
    }
  }

  /** 写入新档案（§6.1：创建前校验目录不存在，冲突即失败——同秒并发由时间戳自然区分）。 */
  async write(meta: AuditFrontmatter, body: string): Promise<AuditRecord> {
    const errors = auditInvariantErrors(meta, meta.auditId);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const dir = path.join(this.auditsRoot, meta.auditId);
    if (existsSync(dir)) throw new AuditFormatError(`审查目录已存在：${meta.auditId}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const reviewPath = path.join(dir, 'audit.md');
    const temp = `${reviewPath}.tmp-${String(process.pid)}`;
    await writeFile(temp, serializeAuditMarkdown(meta, body), 'utf8');
    await rename(temp, reviewPath);
    return { meta, body, dirName: meta.auditId, reviewPath };
  }

  /** 人工转换审查项时更新 item（§3.4：只改 status/candidate，不重写其他历史）。 */
  async updateItem(dirName: string, findingId: string, status: AuditItemStatus, candidate: string | null): Promise<AuditRecord> {
    const record = await this.read(dirName);
    if (record.parseError) throw new AuditFormatError(record.parseError);
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new AuditFormatError(`finding 不存在：${findingId}`);
    item.status = status;
    item.candidate = candidate;
    const errors = auditInvariantErrors(record.meta, dirName);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    // 与其他写路径一致的原子替换：temp + rename，避免崩溃留下半写档案。
    const temp = `${record.reviewPath}.tmp-${String(process.pid)}`;
    const { writeFile: writeAtomic, rename: renameAtomic } = await import('node:fs/promises');
    await writeAtomic(temp, serializeAuditMarkdown(record.meta, record.body), 'utf8');
    await renameAtomic(temp, record.reviewPath);
    return record;
  }
}

// ---------- §3.4 投影 ----------

export type ProjectedState = 'open' | 'closed' | 'dismissed' | 'reopened';

export interface FindingProjection {
  findingId: string;
  title: string;
  summary: string;
  targetFiles: string[];
  kind: AuditItemKind;
  dependsOn: string | null;
  state: ProjectedState;
  lastStatus: AuditItemStatus;
  lastObservedAudit: string;
  lastObservedAt: string;
  /** converted 时的关联候选当前状态（由调用方供给）。 */
  candidateStatus?: 'pending' | 'changes_requested' | 'approved' | 'rejected';
  candidate?: string;
}

function scopeCovers(scope: string, targetFiles: string[]): boolean {
  if (scope === '.') return true;
  const prefix = scope.endsWith('/') ? scope : `${scope}/`;
  if (targetFiles.length === 0) return false;
  return targetFiles.every((file) => file === scope || file.startsWith(prefix));
}

/**
 * §3.4 投影：覆盖判定（target_files 全部落在某轮 scope 内才算观察过）→
 * 最新观察（时间点最新，同刻以 audit_id 为次序键）→ 当前状态（converted 结合候选真实状态）→ 可见性。
 */
export function projectFindings(
  audits: AuditRecord[],
  candidateStatusById: (candidateId: string) => 'pending' | 'changes_requested' | 'approved' | 'rejected' | null,
): FindingProjection[] {
  // 只用有效档案；无效档案不参与投影（§13.2）。
  const valid = audits.filter((audit) => !audit.parseError);
  // 覆盖判定 + 最新观察。
  const latest = new Map<string, { audit: AuditRecord; item: AuditItem }>();
  for (const audit of valid) {
    for (const item of audit.meta.items) {
      if (!scopeCovers(audit.meta.scope, item.targetFiles)) continue;
      const current = latest.get(item.findingId);
      if (!current) {
        latest.set(item.findingId, { audit, item });
        continue;
      }
      const currentTime = new Date(current.audit.meta.createdAt).getTime();
      const nextTime = new Date(audit.meta.createdAt).getTime();
      if (nextTime > currentTime || (nextTime === currentTime && audit.meta.auditId > current.audit.meta.auditId)) {
        latest.set(item.findingId, { audit, item });
      }
    }
  }
  const projections: FindingProjection[] = [];
  for (const [findingId, { audit, item }] of latest) {
    let state: ProjectedState;
    let candidateStatus: FindingProjection['candidateStatus'];
    if (item.status === 'dismissed') state = 'dismissed';
    else if (item.status === 'resolved') state = 'closed';
    else if (item.status === 'converted') {
      const status = item.candidate ? candidateStatusById(item.candidate) : null;
      candidateStatus = status ?? undefined;
      if (status === 'approved') state = 'closed';
      else if (status === 'rejected') state = 'reopened';
      else state = 'open'; // pending / changes_requested / 未知
    } else state = 'open';
    projections.push({
      findingId,
      title: item.title,
      summary: item.summary,
      targetFiles: item.targetFiles,
      kind: item.kind,
      dependsOn: item.dependsOn,
      state,
      lastStatus: item.status,
      lastObservedAudit: audit.meta.auditId,
      lastObservedAt: audit.meta.createdAt,
      ...(item.candidate ? { candidate: item.candidate } : {}),
      ...(candidateStatus ? { candidateStatus } : {}),
    });
  }
  return projections.sort((left, right) => left.findingId.localeCompare(right.findingId));
}
