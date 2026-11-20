import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { readMarkdownFrontmatter, dump } from './yaml.js';
import { isRepoRelativePath, parseTime } from './invariants.js';

/** 审查档案的读写、校验与审查项投影。档案以 audits/<audit_id>/audit.md 为单位。 */

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
  dirName: string;
  reviewPath: string;
  parseError?: string;
}

const AUDIT_DIR_PATTERN = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*$/;
const FINDING_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredField(doc: Record<string, unknown>, key: string, prefix = ''): unknown {
    if (!Object.hasOwn(doc, key)) throw new AuditFormatError(`${prefix}${key} 是必填字段，不得缺省`);
    return doc[key];
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new AuditFormatError(`${field} 必须是非空字符串`);
    return value;
}

function asNullableString(value: unknown, field: string): string | null {
    return value === null ? null : asString(value, field);
}

function asArray(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) throw new AuditFormatError(`${field} 必须是数组`);
    return value;
}

function asStringArray(value: unknown, field: string): string[] {
    return asArray(value, field).map((item, index) => asString(item, `${field}[${String(index)}]`));
}

function parseItem(value: unknown, index: number): AuditItem {
    const name = `items[${String(index)}].`;
    if (!isRecord(value)) throw new AuditFormatError(`items[${String(index)}] 必须是对象`);
    const field = (key: string) => requiredField(value, key, name);
    const kind = asString(field('kind'), `${name}kind`);
    if (kind !== 'confirm' && kind !== 'deferred') {
        throw new AuditFormatError(`${name}kind 只能是 confirm | deferred`);
    }
    const status = asString(field('status'), `${name}status`);
    if (!['pending', 'converted', 'dismissed', 'resolved'].includes(status)) {
        throw new AuditFormatError(`${name}status 非法：${status}`);
    }
    const findingId = asString(field('finding_id'), `${name}finding_id`);
    if (!FINDING_ID_PATTERN.test(findingId)) {
        throw new AuditFormatError(`${name}finding_id 格式非法：${findingId}`);
    }
    return {
        findingId,
        kind,
        title: asString(field('title'), `${name}title`),
        summary: asString(field('summary'), `${name}summary`),
        targetFiles: asStringArray(field('target_files'), `${name}target_files`),
        dependsOn: asNullableString(field('depends_on'), `${name}depends_on`),
        status: status as AuditItemStatus,
        candidate: asNullableString(field('candidate'), `${name}candidate`),
    };
}

export function parseAuditMarkdown(text: string): { meta: AuditFrontmatter; body: string } {
    let doc: unknown;
    let body: string;
    try {
        ({ doc, body } = readMarkdownFrontmatter(text, 'audit.md'));
    } catch (error) {
        throw new AuditFormatError(error instanceof Error ? error.message : String(error));
    }
    if (!isRecord(doc)) throw new AuditFormatError('audit.md Frontmatter 必须是 YAML 对象');
    const field = (key: string) => requiredField(doc, key);
    const schemaVersion = field('schema_version');
    if (schemaVersion !== 1) throw new AuditFormatError('schema_version 必须是数字 1；更高版本需要升级插件');
    const trigger = asString(field('trigger'), 'trigger');
    if (trigger !== 'manual' && trigger !== 'scheduled') throw new AuditFormatError('trigger 只能是 manual | scheduled');
    const scope = asString(field('scope'), 'scope');
    if (scope !== '.' && !isRepoRelativePath(scope)) throw new AuditFormatError(`scope 非法：${scope}`);
    const createdAt = field('created_at');
    return {
        meta: {
            schemaVersion,
            auditId: asString(field('audit_id'), 'audit_id'),
            createdAt: createdAt instanceof Date ? createdAt.toISOString() : asString(createdAt, 'created_at'),
            baseRevision: asString(field('base_revision'), 'base_revision'),
            scope,
            trigger,
            previousAudit: asNullableString(field('previous_audit'), 'previous_audit'),
            candidates: asStringArray(field('candidates'), 'candidates'),
            items: asArray(field('items'), 'items').map(parseItem),
        },
        body,
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

export function auditInvariantErrors(meta: AuditFrontmatter, dirName: string): string[] {
  const errors: string[] = [];
  if (!AUDIT_DIR_PATTERN.test(dirName)) errors.push(`I1: audit 目录名非法：${dirName}`);
  if (meta.auditId !== dirName) errors.push(`I1: audit_id=${meta.auditId} 与目录名 ${dirName} 不一致`);
  const findingIds = new Set<string>();
  for (const item of meta.items) {
    const at = `items[${item.findingId}]`;
    if (!FINDING_ID_PATTERN.test(item.findingId)) errors.push(`I1: ${at} finding_id 非法`);
    if (findingIds.has(item.findingId)) errors.push(`I1: ${at} finding_id 在同一档案内重复`);
    findingIds.add(item.findingId);
    for (const target of item.targetFiles) {
      if (!isRepoRelativePath(target)) errors.push(`I12: ${at} target_files 含非法路径：${target}`);
    }
    if (item.status === 'converted' && !item.candidate) errors.push(`I9: ${at} converted 但 candidate 为空`);
    if (item.status !== 'converted' && item.candidate) errors.push(`I9: ${at} 非 converted 但 candidate 非空`);
    if (item.kind === 'deferred' && !item.dependsOn) errors.push(`I10: ${at} deferred 缺少 depends_on`);
    if (item.kind === 'deferred' && item.dependsOn === item.findingId) errors.push(`I10: ${at} deferred 不得自依赖`);
    if (item.kind === 'confirm' && item.dependsOn) errors.push(`I10: ${at} confirm 不应有 depends_on`);
  }
  const pendingDeps = new Map<string, string>();
  for (const item of meta.items) {
    if (item.kind === 'deferred' && item.status === 'pending' && item.dependsOn) {
      pendingDeps.set(item.findingId, item.dependsOn);
    }
  }
  const reportedCycles = new Set<string>();
  for (const start of pendingDeps.keys()) {
    const pathSeen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (pathSeen.has(current)) {
        if (!reportedCycles.has(current)) {
          reportedCycles.add(current);
          errors.push(`I10: pending 依赖形成环：${[...pathSeen, current].join(' → ')}`);
        }
        break;
      }
      pathSeen.add(current);
      current = pendingDeps.get(current);
    }
  }
  // 用 UTC 比较档案编号与创建时间，避免跨时区读取时误报。
  const stamp = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(meta.auditId);
  const created = parseTime(meta.createdAt, 'created_at', errors);
  if (stamp && created) {
    const compact = created.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    if (compact !== stamp.slice(1).join('')) errors.push(`I13: audit_id 时间戳与 created_at 不一致：${meta.auditId} vs ${meta.createdAt}`);
  }
  return errors;
}

export interface AuditSnapshotSource {
  listAuditDirs(): Promise<string[]>;
  readAuditText(dirName: string): Promise<string | null>;
}

export class AuditArchive {
  constructor(readonly repoRoot: string) {}

  private get auditsRoot(): string {
    return path.join(this.repoRoot, '.ai-review', 'audits');
  }

  /** 写路径可省略 source 检查工作区。共享读路径须传入快照，而且不会扫描旧的扁平报告。 */
  async list(source?: AuditSnapshotSource): Promise<AuditRecord[]> {
    const records: AuditRecord[] = [];
    let dirs: string[] = [];
    if (source) {
      try {
        dirs = (await source.listAuditDirs()).filter((name) => AUDIT_DIR_PATTERN.test(name));
      } catch {
        return records;
      }
      dirs.sort();
      for (const dirName of dirs) {
        const text = await source.readAuditText(dirName).catch(() => null);
        if (text === null) continue;
        records.push(this.recordFromText(dirName, path.join(this.auditsRoot, dirName, 'audit.md'), text));
      }
      return records;
    }
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

  async read(dirName: string, source?: AuditSnapshotSource): Promise<AuditRecord> {
    const reviewPath = path.join(this.auditsRoot, dirName, 'audit.md');
    const text = source
      ? await source.readAuditText(dirName).catch(() => null)
      : await readFile(reviewPath, 'utf8');
    if (text === null) throw new Error(`审查档案不存在：${dirName}`);
    return this.recordFromText(dirName, reviewPath, text);
  }

  private recordFromText(dirName: string, reviewPath: string, text: string): AuditRecord {
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

  async write(meta: AuditFrontmatter, body: string): Promise<AuditRecord> {
    const errors = auditInvariantErrors(meta, meta.auditId);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const dir = path.join(this.auditsRoot, meta.auditId);
    if (existsSync(dir)) throw new AuditFormatError(`审查目录已存在：${meta.auditId}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    return this.writeExisting(meta, body);
  }

  /** 仅用于 Host 收尾。要求 Agent 已在目标目录写入报告，再用验证过的完整档案覆盖。 */
  async writeExisting(meta: AuditFrontmatter, body: string): Promise<AuditRecord> {
    const errors = auditInvariantErrors(meta, meta.auditId);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const dir = path.join(this.auditsRoot, meta.auditId);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const reviewPath = path.join(dir, 'audit.md');
    const temp = `${reviewPath}.tmp-${String(process.pid)}`;
    await writeFile(temp, serializeAuditMarkdown(meta, body), 'utf8');
    await rename(temp, reviewPath);
    return { meta, body, dirName: meta.auditId, reviewPath };
  }

  async nextAuditId(scope: string, now: Date): Promise<string> {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{14})(\d)$/, '$1');
    const compact = `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`;
    const slug = (scope || 'repo')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'repo';
    let auditId = `${compact}-${slug}`;
    let suffix = 2;
    while (existsSync(path.join(this.auditsRoot, auditId))) {
      auditId = `${compact}-${slug}-${String(suffix)}`;
      suffix += 1;
    }
    return auditId;
  }

  async updateItem(
    dirName: string,
    findingId: string,
    status: AuditItemStatus,
    candidate: string | null,
    note?: string,
  ): Promise<AuditRecord> {
    const record = await this.read(dirName);
    if (record.parseError) throw new AuditFormatError(record.parseError);
    const item = record.meta.items.find((entry) => entry.findingId === findingId);
    if (!item) throw new AuditFormatError(`finding 不存在：${findingId}`);
    item.status = status;
    item.candidate = candidate;
    const errors = auditInvariantErrors(record.meta, dirName);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const body = note
      ? `${record.body.replace(/\s+$/, '')}\n\n# 审查项处理记录\n\n- ${note}\n`
      : record.body;
    const temp = `${record.reviewPath}.tmp-${String(process.pid)}`;
    const { writeFile: writeAtomic, rename: renameAtomic } = await import('node:fs/promises');
    await writeAtomic(temp, serializeAuditMarkdown(record.meta, body), 'utf8');
    await renameAtomic(temp, record.reviewPath);
    return { ...record, body };
  }
}


export type ProjectedState = 'open' | 'closed' | 'dismissed' | 'reopened';

export interface CandidateChainInfo {
  status: 'pending' | 'changes_requested' | 'approved' | 'rejected';
  reopenedFrom: string | null;
  broken?: boolean;
}

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
  candidateStatus?: 'pending' | 'changes_requested' | 'approved' | 'rejected';
  candidate?: string;
}

function scopeCovers(scope: string, targetFiles: string[]): boolean {
  if (scope === '.') return true;
  const prefix = scope.endsWith('/') ? scope : `${scope}/`;
  if (targetFiles.length === 0) return false;
  return targetFiles.every((file) => file === scope || file.startsWith(prefix));
}

/** 审查项被拒绝的旧候选可能已有替代者。只有能确定唯一有效重开链时，投影才可沿链定位当前候选。 */
export function projectFindings(
  audits: AuditRecord[],
  candidateInfoById: (candidateId: string) => CandidateChainInfo | null,
  candidateIds: string[] = [],
): { findings: FindingProjection[]; errors: string[] } {
  const errors: string[] = [];
  const valid = audits.filter((audit) => !audit.parseError);
  // 观察时间相同时用档案编号打破平局，使最新观察的选择不依赖枚举顺序。
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
  const pushBase = (findingId: string, entry: { audit: AuditRecord; item: AuditItem }, state: ProjectedState, chain?: { id: string; status: CandidateChainInfo['status'] }): void => {
    projections.push({
      findingId,
      title: entry.item.title,
      summary: entry.item.summary,
      targetFiles: entry.item.targetFiles,
      kind: entry.item.kind,
      dependsOn: entry.item.dependsOn,
      state,
      lastStatus: entry.item.status,
      lastObservedAudit: entry.audit.meta.auditId,
      lastObservedAt: entry.audit.meta.createdAt,
      ...(chain ? { candidate: chain.id, candidateStatus: chain.status } : {}),
    });
  };
  for (const [findingId, entry] of latest) {
    const { item } = entry;
    if (item.status === 'dismissed') { pushBase(findingId, entry, 'dismissed'); continue; }
    if (item.status === 'resolved') { pushBase(findingId, entry, 'closed'); continue; }
    if (item.status !== 'converted') { pushBase(findingId, entry, 'open'); continue; }
    if (!item.candidate) { pushBase(findingId, entry, 'open'); continue; }
    const start = candidateInfoById(item.candidate);
    if (start === null || start.broken) {
      errors.push(`finding ${findingId}：converted 候选 ${item.candidate} 缺失、broken 或状态不可读，不参与正常投影`);
      continue;
    }
    let currentId = item.candidate;
    let current = start;
    const visited = new Set<string>([currentId]);
    for (;;) {
      if (current.status === 'approved') { pushBase(findingId, entry, 'closed', { id: currentId, status: current.status }); break; }
      if (current.status === 'pending' || current.status === 'changes_requested') { pushBase(findingId, entry, 'open', { id: currentId, status: current.status }); break; }
      const replacements = candidateIds
        .map((id) => ({ id, info: candidateInfoById(id) }))
        .filter((next): next is { id: string; info: CandidateChainInfo } => next.info !== null && next.info.reopenedFrom === currentId);
      if (replacements.length === 0) { pushBase(findingId, entry, 'reopened', { id: currentId, status: current.status }); break; }
      if (replacements.length > 1) {
        errors.push(`finding ${findingId}：rejected 候选 ${currentId} 有 ${String(replacements.length)} 个直接替代候选（应最多 1 个），不参与正常投影`);
        break;
      }
      const next = replacements[0];
      if (!next) break;
      if (next.info.broken) {
        errors.push(`finding ${findingId}：重开替代候选 ${next.id} 为 broken，不参与正常投影`);
        break;
      }
      if (visited.has(next.id)) {
        errors.push(`finding ${findingId}：重开链在 ${currentId} 与 ${next.id} 之间形成环，不参与正常投影`);
        break;
      }
      visited.add(next.id);
      currentId = next.id;
      current = next.info;
    }
  }
  return { findings: projections.sort((left, right) => left.findingId.localeCompare(right.findingId)), errors };
}
