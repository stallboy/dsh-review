import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { load, dump } from './yaml.js';
import { isRepoRelativePath } from './invariants.js';

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
  const findingIds = new Set<string>();
  for (const item of meta.items) {
    const at = `items[${item.findingId}]`;
    // I1：finding_id 必须匹配规范且同一档案内唯一。
    if (!FINDING_ID_PATTERN.test(item.findingId)) errors.push(`I1: ${at} finding_id 非法`);
    if (findingIds.has(item.findingId)) errors.push(`I1: ${at} finding_id 在同一档案内重复`);
    findingIds.add(item.findingId);
    // I12：item.target_files 必须是合法仓库相对路径（空数组允许）。
    for (const target of item.targetFiles) {
      if (!isRepoRelativePath(target)) errors.push(`I12: ${at} target_files 含非法路径：${target}`);
    }
    // I9：converted ⟺ candidate 非空。
    if (item.status === 'converted' && !item.candidate) errors.push(`I9: ${at} converted 但 candidate 为空`);
    if (item.status !== 'converted' && item.candidate) errors.push(`I9: ${at} 非 converted 但 candidate 非空`);
    // I10：deferred 必须有依赖且不得自依赖；confirm 必须没有。
    if (item.kind === 'deferred' && !item.dependsOn) errors.push(`I10: ${at} deferred 缺少 depends_on`);
    if (item.kind === 'deferred' && item.dependsOn === item.findingId) errors.push(`I10: ${at} deferred 不得自依赖`);
    if (item.kind === 'confirm' && item.dependsOn) errors.push(`I10: ${at} confirm 不应有 depends_on`);
  }
  // I10：pending 依赖环必须报告。
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
  // I13：audit_id 时间戳与 created_at 的 UTC 日历时刻一致（§4.7：与创建/读取机器时区无关）。
  const stamp = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(meta.auditId);
  if (stamp) {
    const created = new Date(meta.createdAt);
    if (Number.isNaN(created.getTime())) {
      errors.push('I13: created_at 无法解析');
    } else {
      const compact = created.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      if (compact !== stamp.slice(1).join('')) errors.push(`I13: audit_id 时间戳与 created_at 不一致：${meta.auditId} vs ${meta.createdAt}`);
    }
  }
  return errors;
}

/** §7.1：共享快照读取源（Git HEAD / SVN BASE）——投影等读端只能使用共享事实。 */
export interface AuditSnapshotSource {
  listAuditDirs(): Promise<string[]>;
  readAuditText(dirName: string): Promise<string | null>;
}

export class AuditArchive {
  constructor(readonly repoRoot: string) {}

  private get auditsRoot(): string {
    return path.join(this.repoRoot, '.ai-review', 'audits');
  }

  /**
   * 列出目录式档案（目录名合法且含 audit.md）；旧扁平 *.md 不参与。
   * 传入共享快照源时只读该快照；否则读工作区（写路径使用）。
   */
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

  /** 写入新档案（§4.7：创建前校验目录不存在，冲突即失败）。 */
  async write(meta: AuditFrontmatter, body: string): Promise<AuditRecord> {
    const errors = auditInvariantErrors(meta, meta.auditId);
    if (errors.length > 0) throw new AuditFormatError(errors.join('；'));
    const dir = path.join(this.auditsRoot, meta.auditId);
    if (existsSync(dir)) throw new AuditFormatError(`审查目录已存在：${meta.auditId}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    return this.writeExisting(meta, body);
  }

  /**
   * 收尾覆写：目录已由 Agent 创建（报告正文先写入 audit.md），
   * Host 在原位写入完整档案（frontmatter + 正文 + 复核块）。仍执行全部不变量校验。
   */
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

  /** 生成下一个未占用的 audit_id（UTC 时间戳 + scope slug；同秒冲突追加 -2/-3）。 */
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

  /** 人工转换审查项时更新 item（§3.4：只改 status/candidate，不重写其他历史）。 */
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
    // §7.6 /dismiss-finding：在正文 `# 审查项处理记录` 追加时间、操作者与理由。
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

// ---------- §4.8 投影 ----------

export type ProjectedState = 'open' | 'closed' | 'dismissed' | 'reopened';

/** §4.8 投影所需的候选事实（由调用方从共享事实供给）。 */
export interface CandidateChainInfo {
  status: 'pending' | 'changes_requested' | 'approved' | 'rejected';
  /** §4.8：该候选的 reopened_from 指向（null 表示非重开）。 */
  reopenedFrom: string | null;
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

/**
 * §4.8 投影（2026-11-10 对齐 SPEC）：覆盖判定 → 最新观察 → 基础状态映射 →
 * 重开链判定（converted+rejected 时沿 reopened_from 查找唯一替代候选，
 * candidate/candidateStatus 指向链上当前候选；多替代/缺失/broken/环 → errors 报告）。
 */
export function projectFindings(
  audits: AuditRecord[],
  candidateInfoById: (candidateId: string) => CandidateChainInfo | null,
  candidateIds: string[] = [],
): { findings: FindingProjection[]; errors: string[] } {
  const errors: string[] = [];
  const valid = audits.filter((audit) => !audit.parseError);
  // 覆盖判定 + 最新观察（时间点最新，同刻以 audit_id 为次序键）。
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
    if (start === null) {
      errors.push(`finding ${findingId}：converted 候选 ${item.candidate} 缺失或状态不可读，不参与正常投影`);
      continue;
    }
    let currentId = item.candidate;
    let current = start;
    const visited = new Set<string>([currentId]);
    for (;;) {
      if (current.status === 'approved') { pushBase(findingId, entry, 'closed', { id: currentId, status: current.status }); break; }
      if (current.status === 'pending' || current.status === 'changes_requested') { pushBase(findingId, entry, 'open', { id: currentId, status: current.status }); break; }
      // rejected：查找 reopened_from 指向它的直接替代候选（应最多一个）。
      const replacements = candidateIds
        .filter((id) => !visited.has(id))
        .map((id) => ({ id, info: candidateInfoById(id) }))
        .filter((next): next is { id: string; info: CandidateChainInfo } => next.info !== null && next.info.reopenedFrom === currentId);
      if (replacements.length === 0) { pushBase(findingId, entry, 'reopened', { id: currentId, status: current.status }); break; }
      if (replacements.length > 1) {
        errors.push(`finding ${findingId}：rejected 候选 ${currentId} 有 ${String(replacements.length)} 个直接替代候选（应最多 1 个），不参与正常投影`);
        break;
      }
      const next = replacements[0];
      if (!next) break;
      visited.add(next.id);
      currentId = next.id;
      current = next.info;
    }
  }
  return { findings: projections.sort((left, right) => left.findingId.localeCompare(right.findingId)), errors };
}
