import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auditFiles } from './audit-files.js';
import path from 'node:path';
import { readMarkdownFrontmatter, dump } from './yaml.js';
import { FINDING_ID_PATTERN, isRepoRelativePath, parseTime } from './invariants.js';
import type { FindingDisposition, FindingEvent } from './finding-decisions.js';

/** 审查档案的读写、校验与审查项投影。档案以 audits/<audit_id>/audit.md 为单位。 */

export class AuditFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditFormatError';
  }
}

export type AuditTrigger = 'manual' | 'scheduled';
export type AuditItemKind = 'confirm' | 'deferred' | 'repair';
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
  repairPlan?: string;
  options?: { candidateId: string; tradeoff: string }[];
  repairRevisions?: string[];
  repairAttribution?: string;
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
const CANDIDATE_ID_PATTERN = /^\d{4}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function parseAuditItem(value: unknown, index: number, schemaVersion: number): AuditItem {
    const name = `items[${String(index)}].`;
    if (!isRecord(value)) throw new AuditFormatError(`items[${String(index)}] 必须是对象`);
    const field = (key: string) => requiredField(value, key, name);
    const kind = asString(field('kind'), `${name}kind`);
    if (kind !== 'confirm' && kind !== 'deferred' && !(schemaVersion === 2 && kind === 'repair')) {
        throw new AuditFormatError(`${name}kind 不受当前 schema_version 支持`);
    }
    const status = asString(field('status'), `${name}status`);
    if (!['pending', 'converted', 'dismissed', 'resolved'].includes(status)) {
        throw new AuditFormatError(`${name}status 非法：${status}`);
    }
    const findingId = asString(field('finding_id'), `${name}finding_id`);
    if (!FINDING_ID_PATTERN.test(findingId)) {
        throw new AuditFormatError(`${name}finding_id 格式非法：${findingId}`);
    }
    const item: AuditItem = {
        findingId,
        kind: kind as AuditItemKind,
        title: asString(field('title'), `${name}title`),
        summary: asString(field('summary'), `${name}summary`),
        targetFiles: asStringArray(field('target_files'), `${name}target_files`),
        dependsOn: asNullableString(field('depends_on'), `${name}depends_on`),
        status: status as AuditItemStatus,
        candidate: asNullableString(field('candidate'), `${name}candidate`),
    };
    if (schemaVersion === 2) {
        if (Object.hasOwn(value, 'repair_plan')) item.repairPlan = asString(value['repair_plan'], `${name}repair_plan`);
        if (Object.hasOwn(value, 'options')) {
            item.options = asArray(value['options'], `${name}options`).map((option, optionIndex) => {
                const key = `${name}options[${String(optionIndex)}]`;
                if (!isRecord(option)) throw new AuditFormatError(`${key} 必须是对象`);
                return {
                    candidateId: asString(option['candidate_id'], `${key}.candidate_id`),
                    tradeoff: asString(option['tradeoff'], `${key}.tradeoff`),
                };
            });
        }
        if (Object.hasOwn(value, 'repair_revisions')) {
            item.repairRevisions = asStringArray(value['repair_revisions'], `${name}repair_revisions`);
        }
        if (Object.hasOwn(value, 'repair_attribution')) {
            item.repairAttribution = asString(value['repair_attribution'], `${name}repair_attribution`);
        }
    }
    return item;
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
    if (schemaVersion !== 1 && schemaVersion !== 2) {
        throw new AuditFormatError('schema_version 必须是数字 1 或 2；更高版本需要升级插件');
    }
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
            items: asArray(field('items'), 'items').map((item, index) => parseAuditItem(item, index, schemaVersion)),
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
      ...(item.repairPlan !== undefined ? { repair_plan: item.repairPlan } : {}),
      ...(item.options !== undefined ? {
        options: item.options.map(({ candidateId, tradeoff }) => ({ candidate_id: candidateId, tradeoff })),
      } : {}),
      ...(item.repairRevisions !== undefined ? { repair_revisions: item.repairRevisions } : {}),
      ...(item.repairAttribution !== undefined ? { repair_attribution: item.repairAttribution } : {}),
    })),
  };
  const yamlText = dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false }).replace(/\n$/, '');
  return `---\n${yamlText}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

export function auditInvariantErrors(meta: AuditFrontmatter, dirName: string): string[] {
  const errors: string[] = [];
  if (!AUDIT_DIR_PATTERN.test(dirName)) errors.push(`I1: audit 目录名非法：${dirName}`);
  if (meta.auditId !== dirName) errors.push(`I1: audit_id=${meta.auditId} 与目录名 ${dirName} 不一致`);
  if (meta.schemaVersion !== 1 && meta.schemaVersion !== 2) errors.push('I2: 档案 schema_version 无效');
  const findingIds = new Set<string>();
  const optionIds = new Set<string>();
  const publishedIds = new Set(meta.candidates);
  for (const item of meta.items) {
    const at = `items[${item.findingId}]`;
    if (!FINDING_ID_PATTERN.test(item.findingId)) errors.push(`I1: ${at} finding_id 非法`);
    if (findingIds.has(item.findingId)) errors.push(`I1: ${at} finding_id 在同一档案内重复`);
    findingIds.add(item.findingId);
    for (const target of item.targetFiles) {
      if (!isRepoRelativePath(target) || (meta.schemaVersion === 2 && path.win32.parse(target).root)) {
        errors.push(`I12: ${at} target_files 含非法路径：${target}`);
      }
    }
    if (item.status === 'converted' && !item.candidate) errors.push(`I9: ${at} converted 但 candidate 为空`);
    if (item.status !== 'converted' && item.candidate) errors.push(`I9: ${at} 非 converted 但 candidate 非空`);
    if (item.kind === 'deferred' && !item.dependsOn) errors.push(`I10: ${at} deferred 缺少 depends_on`);
    if (item.kind === 'deferred' && item.dependsOn === item.findingId) errors.push(`I10: ${at} deferred 不得自依赖`);
    if (item.kind !== 'deferred' && item.dependsOn) errors.push(`I10: ${at} 非 deferred 不应有 depends_on`);
    if (meta.schemaVersion === 2) {
      if (item.kind === 'repair' && item.repairPlan !== undefined && item.status === 'pending' && item.options === undefined) {
        errors.push(`I2: ${at} 发布修复方案时必须提供选项`);
      }
      if (item.options !== undefined) {
        if (item.kind !== 'repair' || item.status !== 'pending' || !item.repairPlan?.trim()
          || item.options.length < 1 || item.options.length > 3) {
          errors.push(`I2: ${at} 修复选项必须属于待审核修复方案，且为一至三项`);
        }
        for (const option of item.options) {
          if (!CANDIDATE_ID_PATTERN.test(option.candidateId) || !publishedIds.has(option.candidateId)
            || optionIds.has(option.candidateId) || !option.tradeoff.trim()) {
            errors.push(`I2: ${at} 修复选项无效或重复：${option.candidateId}`);
          }
          optionIds.add(option.candidateId);
        }
      }
      if (item.repairRevisions !== undefined || item.repairAttribution !== undefined) {
        const revisions = item.repairRevisions ?? [];
        if (item.status !== 'resolved' || !item.repairAttribution?.trim() || revisions.length === 0
          || new Set(revisions).size !== revisions.length) {
          errors.push(`I2: ${at} 修复归因须对应已解决观察，并含有效版本和归因说明`);
        }
      }
    }
  }
  if (meta.schemaVersion === 2 && publishedIds.size !== meta.candidates.length) {
    errors.push('I2: v2 档案的候选清单不得重复');
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

  async readDraft(dirName: string): Promise<string | null> {
    if (!AUDIT_DIR_PATTERN.test(dirName)) throw new AuditFormatError(`审查目录名非法：${dirName}`);
    const result = await auditFiles(this.repoRoot, { op: 'read', paths: [`.ai-review/audits/${dirName}/audit.md`] });
    return result.bytes?.toString('utf8') ?? null;
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
      const result = await auditFiles(this.repoRoot, { op: 'list', paths: ['.ai-review/audits'] });
      dirs = (result.names ?? []).filter(name => AUDIT_DIR_PATTERN.test(name));
    } catch {
      return records;
    }
    dirs.sort();
    for (const dirName of dirs) {
      const record = await this.read(dirName).catch(() => null);
      if (record) records.push(record);
    }
    return records;
  }

  async read(dirName: string, source?: AuditSnapshotSource): Promise<AuditRecord> {
    const reviewPath = path.join(this.auditsRoot, dirName, 'audit.md');
    const text = source
      ? await source.readAuditText(dirName).catch(() => null)
      : await this.readDraft(dirName);
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
    return this.writeArchive(meta, body, true);
  }

  async writeExisting(meta: AuditFrontmatter, body: string): Promise<AuditRecord> {
    return this.writeArchive(meta, body, false);
  }

  private async writeArchive(meta: AuditFrontmatter, body: string, createOnly: boolean): Promise<AuditRecord> {
    const errors = auditInvariantErrors(meta, meta.auditId);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const file = `.ai-review/audits/${meta.auditId}/audit.md`;
    await auditFiles(this.repoRoot, { op: 'write', paths: [file], text: serializeAuditMarkdown(meta, body), createOnly });
    return { meta, body, dirName: meta.auditId, reviewPath: path.join(this.repoRoot, file) };
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
    return this.writeExisting(record.meta, body);
  }
}


export type ProjectedState = 'open' | 'closed' | 'dismissed' | 'reopened';

export interface CandidateChainInfo {
  status: 'pending' | 'changes_requested' | 'approved' | 'rejected';
  reopenedFrom: string | null;
  broken?: boolean;
  findingId?: string;
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
  findingVersion?: string;
  disposition?: FindingDisposition;
  decision?: FindingEvent;
  repairHints?: string[];
  repairPlan?: string;
  baseRevision?: string;
  repairRevisions?: string[];
  repairAttribution?: string;
  options?: { candidateId: string; tradeoff: string; status: CandidateChainInfo['status'] }[];
}

export function scopeCovers(scope: string, targetFiles: string[]): boolean {
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
  v2?: {
    candidateInfo: (id: string) => CandidateChainInfo | null;
    events: ReadonlyMap<string, FindingEvent[] | Error>;
  },
): { findings: FindingProjection[]; errors: string[] } {
  const errors: string[] = [];
  const valid = audits.filter((audit) => !audit.parseError);
  // 观察时间相同时用档案编号打破平局，使最新观察的选择不依赖枚举顺序。
  const latest = new Map<string, { audit: AuditRecord; item: AuditItem }>();
  const versioned = new Map<string, { audit: AuditRecord; item: AuditItem }[]>();
  for (const audit of valid) {
    for (const item of audit.meta.items) {
      if (!scopeCovers(audit.meta.scope, item.targetFiles)) continue;
      if (audit.meta.schemaVersion === 2) {
        const observations = versioned.get(item.findingId) ?? [];
        observations.push({ audit, item });
        versioned.set(item.findingId, observations);
      }
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
  const pushBase = (findingId: string, entry: { audit: AuditRecord; item: AuditItem }, state: ProjectedState, chain?: { id: string; status: CandidateChainInfo['status'] }, details?: Partial<FindingProjection>): void => {
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
      ...details,
    });
  };
  for (const [findingId, entry] of latest) {
    const observations = versioned.get(findingId);
    if (observations?.some(({ item }) => item.repairPlan !== undefined || item.kind === 'repair'
      || item.repairRevisions !== undefined)) {
      if (!v2) continue;
      observations.sort((a, b) => new Date(b.audit.meta.createdAt).getTime() - new Date(a.audit.meta.createdAt).getTime()
        || b.audit.meta.auditId.localeCompare(a.audit.meta.auditId));
      const current = observations[0] ?? entry;
      const plan = observations.find(({ item }) => item.repairPlan !== undefined);
      const events = v2.events.get(findingId) ?? [];
      const optionIds = new Set(observations.flatMap(({ item }) => item.options?.map((option) => option.candidateId) ?? []));
      const optionInfo = new Map([...optionIds].map((id) => [id, v2.candidateInfo(id)]));
      const unavailable = [...optionInfo].find(([, info]) => !info || info.broken || info.findingId !== findingId);
      const approved = [...optionInfo].filter(([, info]) => info?.status === 'approved');
      if (!plan || unavailable || approved.length > 1 || events instanceof Error) {
        const reason = events instanceof Error ? events.message : unavailable
          ? `候选 ${unavailable[0]} 缺失、无效或关联不一致` : !plan ? '缺少原始方案' : '同一发现存在多条批准';
        errors.push(`finding ${findingId}：${reason}`);
        continue;
      }
      const currentAuditIds = new Set(observations.map(({ audit }) => audit.meta.auditId));
      if (events.some((event) => !currentAuditIds.has(event.auditId))) {
        errors.push(`finding ${findingId}：处置指向不存在或范围不符的观察`);
        continue;
      }
      const decision = events.filter((event) => event.action !== 'add_repair_hint').at(-1);
      const winningId = approved[0]?.[0];
      const disposition: FindingDisposition = current.item.status === 'resolved' ? 'resolved' : winningId ? 'applied'
        : decision && decision.action !== 'resume_review' ? decision.action : 'undecided';
      const options = (plan.item.options ?? []).flatMap((option) => {
        const info = optionInfo.get(option.candidateId);
        return info ? [{ ...option, status: info.status }] : [];
      });
      const findingVersion = createHash('sha256').update(JSON.stringify({
        observation: current.audit.meta.auditId, item: current.item,
        plan: plan.audit.meta.auditId, options: plan.item.options, winningId, events,
      })).digest('hex');
      pushBase(findingId, current, disposition === 'resolved' || disposition === 'applied' ? 'closed' : 'open',
        winningId ? { id: winningId, status: 'approved' } : undefined, {
          findingVersion, disposition, options,
          baseRevision: plan.audit.meta.baseRevision,
          ...(decision ? { decision } : {}),
          ...(plan.item.repairPlan !== undefined ? { repairPlan: plan.item.repairPlan } : {}),
          ...(current.item.repairRevisions ? { repairRevisions: current.item.repairRevisions } : {}),
          ...(current.item.repairAttribution ? { repairAttribution: current.item.repairAttribution } : {}),
          repairHints: events.flatMap((event) => event.action === 'add_repair_hint' ? [event.hint] : []),
        });
      continue;
    }
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
