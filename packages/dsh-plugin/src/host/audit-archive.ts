/** 本轮审查档案 audit.md 读写与不变量校验（唯一契约 schema_version: 1，纯索引模型）。 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditFiles } from './audit-files.js';
import { ISO_TIMESTAMP_PATTERN } from './frontmatter.js';
import { isRepoRelativePath, MONTH_PATTERN, parseTime, SLUG_PATTERN } from './invariants.js';
import { isAiReviewPath } from './patch.js';
import { dump, readMarkdownFrontmatter } from './yaml.js';

export type AuditTrigger = 'manual' | 'scheduled';

export interface AuditFrontmatter {
  schemaVersion: 1;
  auditId: string;
  createdAt: string;
  baseRevision: string;
  scope: string;
  trigger: AuditTrigger;
  previousAudit: string | null;
  /** 本轮新建或有效更新的问题目录 ID 列表（YYYY-MM/<slug>）。 */
  issues: string[];
  extra?: Record<string, unknown>;
}

export interface AuditRecord {
  auditId: string;
  dirPath: string;
  filePath: string;
  meta: AuditFrontmatter;
  body: string;
  parseError?: string;
}

export interface AuditSource {
  listAuditDirs(): Promise<string[]>;
  readAuditText(dirName: string): Promise<string | null>;
}

export const AUDIT_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9][a-z0-9._-]*)$/;
const REPORT_MARKER_START = '<!-- ai-review:audit-verification -->';
const REPORT_MARKER_END = '<!-- /ai-review:audit-verification -->';

const KNOWN_AUDIT_KEYS = new Set([
  'schema_version',
  'audit_id',
  'created_at',
  'base_revision',
  'scope',
  'trigger',
  'previous_audit',
  'issues',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** 判定审查 scope 是否覆盖给定业务路径集合（scope="." 表示全仓）。 */
export function scopeCovers(scope: string, files: readonly string[]): boolean {
  const normalizedScope = scope.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedScope === '.' || normalizedScope === '') return true;
  if (files.length === 0) return false;
  return files.every((raw) => {
    const file = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    return file === normalizedScope || file.startsWith(`${normalizedScope}/`);
  });
}

export function isValidIssueDirId(value: string): boolean {
  const parts = value.split('/');
  return parts.length === 2 && MONTH_PATTERN.test(parts[0] ?? '') && SLUG_PATTERN.test(parts[1] ?? '');
}

export function auditIdTimestampUtc(auditId: string): string | null {
  const match = AUDIT_ID_PATTERN.exec(auditId);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) return null;
  return iso;
}

export function parseAuditMarkdown(text: string): { meta: AuditFrontmatter; body: string } {
  const { doc, body } = readMarkdownFrontmatter(text, 'audit.md');
  if (!isPlainRecord(doc)) throw new Error('audit.md Frontmatter 顶层必须是对象');
  for (const key of KNOWN_AUDIT_KEYS) {
    if (!Object.hasOwn(doc, key)) throw new Error(`audit.md 缺少必填顶层字段：${key}`);
  }
  if (doc['schema_version'] !== 1) {
    throw new Error(`audit.md 仅支持 schema_version: 1（当前为 ${String(doc['schema_version'])}）`);
  }
  const auditId = doc['audit_id'];
  if (typeof auditId !== 'string' || !auditId.trim()) throw new Error('audit_id 必须是非空字符串');
  const rawCreated = doc['created_at'];
  let createdAt = '';
  if (rawCreated instanceof Date) {
    if (!Number.isFinite(rawCreated.getTime())) throw new Error('created_at 不是有效日期时间');
    createdAt = rawCreated.toISOString();
  } else if (typeof rawCreated === 'string') {
    const trimmed = rawCreated.trim();
    if (!trimmed || !ISO_TIMESTAMP_PATTERN.test(trimmed)) {
      throw new Error('created_at 必须是含时区的 ISO-8601 时间戳');
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) throw new Error('created_at 不是有效时间戳');
    createdAt = new Date(parsedMs).toISOString();
  } else {
    throw new Error('created_at 必须是非空 ISO-8601 字符串');
  }
  const baseRevision = doc['base_revision'];
  if (typeof baseRevision !== 'string' || !baseRevision.trim()) throw new Error('base_revision 必须是非空字符串');
  const scope = doc['scope'];
  if (typeof scope !== 'string' || !scope.trim()) throw new Error('scope 必须是非空字符串');
  const trigger = doc['trigger'];
  if (trigger !== 'manual' && trigger !== 'scheduled') throw new Error(`trigger 非法：${String(trigger)}`);
  const previousAudit = doc['previous_audit'];
  if (previousAudit !== null && typeof previousAudit !== 'string') {
    throw new Error('previous_audit 必须是字符串或 null');
  }
  const rawIssues = doc['issues'];
  if (!Array.isArray(rawIssues) || rawIssues.some((item) => typeof item !== 'string')) {
    throw new Error('issues 必须是字符串数组');
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_AUDIT_KEYS.has(k)) extra[k] = v;
  }
  return {
    meta: {
      schemaVersion: 1,
      auditId,
      createdAt,
      baseRevision,
      scope,
      trigger,
      previousAudit,
      issues: rawIssues as string[],
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
    body,
  };
}

export function serializeAuditMarkdown(meta: AuditFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {
    schema_version: 1,
    audit_id: meta.auditId,
    created_at: meta.createdAt,
    base_revision: meta.baseRevision,
    scope: meta.scope,
    trigger: meta.trigger,
    previous_audit: meta.previousAudit,
    issues: meta.issues,
    ...(meta.extra ?? {}),
  };
  const yamlText = dump(ordered, { lineWidth: -1, noRefs: true, sortKeys: false });
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s*$/, '');
  return `---\n${yamlText}---\n\n${normalizedBody}\n`;
}

/** I2 / I13 / I15：校验 audit.md 结构、时间戳一致性、scope 合法性与纯索引约束。 */
export function auditInvariantErrors(meta: AuditFrontmatter, dirName: string, body?: string): string[] {
  const errors: string[] = [];
  if (meta.schemaVersion !== 1) errors.push(`audit.md 仅支持 schema_version: 1`);
  if (!AUDIT_ID_PATTERN.test(dirName)) errors.push(`审查档案目录名格式非法：${dirName}`);
  if (meta.auditId !== dirName) errors.push(`audit_id（${meta.auditId}）与目录名（${dirName}）不一致`);

  const createdMs = parseTime(meta.createdAt, 'created_at', errors);
  const idUtc = auditIdTimestampUtc(meta.auditId);
  if (!idUtc) {
    errors.push(`audit_id 的时间戳部分无效：${meta.auditId}`);
  } else if (createdMs !== null) {
    const createdSecond = new Date(Math.floor(createdMs / 1000) * 1000).toISOString();
    if (createdSecond !== idUtc) {
      errors.push(`created_at 的 UTC 秒级时刻（${createdSecond}）必须与 audit_id（${idUtc}）一致`);
    }
  }

  if (!meta.baseRevision.trim()) errors.push('base_revision 不能为空');
  if (meta.scope !== '.') {
    if (!isRepoRelativePath(meta.scope) || isAiReviewPath(meta.scope) || meta.scope.startsWith('./') || meta.scope.endsWith('/')) {
      errors.push(`scope 非法：${meta.scope}`);
    }
  }
  if (meta.previousAudit !== null && !AUDIT_ID_PATTERN.test(meta.previousAudit)) {
    errors.push(`previous_audit 格式非法：${meta.previousAudit}`);
  }

  const seen = new Set<string>();
  for (const id of meta.issues) {
    if (!isValidIssueDirId(id)) {
      errors.push(`issues 包含非法的问题目录 ID：${id}`);
      continue;
    }
    if (seen.has(id)) errors.push(`issues 存在重复问题 ID：${id}`);
    seen.add(id);
  }

  if (body !== undefined) {
    const startMatches = body.match(new RegExp(REPORT_MARKER_START, 'g')) ?? [];
    const endMatches = body.match(new RegExp(REPORT_MARKER_END, 'g')) ?? [];
    if (startMatches.length > 1 || endMatches.length > 1 || startMatches.length !== endMatches.length) {
      errors.push('audit.md 正文中的插件核验标记块必须至多出现一次且成对闭合');
    }
  }

  return errors;
}

export function upsertAuditVerificationBlock(text: string, block: string): string {
  const pattern = new RegExp(`${REPORT_MARKER_START}[\\s\\S]*?${REPORT_MARKER_END}`);
  const wrapped = `${REPORT_MARKER_START}\n${block.trim()}\n${REPORT_MARKER_END}`;
  if (pattern.test(text)) return text.replace(pattern, () => wrapped);
  return `${text.replace(/\s+$/, '')}\n\n${wrapped}\n`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function slugifyAuditScope(targetPath: string): string {
  const cleaned = (targetPath || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  return cleaned && SLUG_PATTERN.test(cleaned) ? cleaned : 'repo';
}

export class AuditArchive {
  readonly auditsDir: string;

  constructor(readonly repoRoot: string) {
    this.auditsDir = path.join(repoRoot, '.ai-review', 'audits');
  }

  auditFilePath(auditId: string): string {
    return path.join(this.auditsDir, auditId, 'audit.md');
  }

  async nextAuditId(targetPath: string, now: Date = new Date()): Promise<string> {
    const slug = slugifyAuditScope(targetPath);
    const stamp = `${String(now.getUTCFullYear())}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
    const base = `${stamp}-${slug}`;
    const existing = new Set(await this.listDirsFromFs());
    if (!existing.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error(`同秒审查档案数量超限：${base}`);
  }

  private async listDirsFromFs(): Promise<string[]> {
    try {
      const entries = await readdir(this.auditsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readDraft(auditId: string): Promise<string | null> {
    try {
      return await readFile(this.auditFilePath(auditId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeAudit(meta: AuditFrontmatter, body: string): Promise<void> {
    const errors = auditInvariantErrors(meta, meta.auditId, body);
    if (errors.length > 0) throw new Error(`审查档案不变量失败：${errors.join('；')}`);
    const relPath = `.ai-review/audits/${meta.auditId}/audit.md`;
    await auditFiles(this.repoRoot, { op: 'write', paths: [relPath], text: serializeAuditMarkdown(meta, body) });
  }

  async list(source?: AuditSource): Promise<AuditRecord[]> {
    const dirs = source ? await source.listAuditDirs() : await this.listDirsFromFs();
    const records: AuditRecord[] = [];
    for (const dirName of [...dirs].sort().reverse()) {
      const dirPath = path.join(this.auditsDir, dirName);
      const filePath = path.join(dirPath, 'audit.md');
      try {
        const text = source
          ? await source.readAuditText(dirName)
          : await readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
        if (text === null) continue;
        const { meta, body } = parseAuditMarkdown(text);
        const errors = auditInvariantErrors(meta, dirName, body);
        records.push({
          auditId: dirName,
          dirPath,
          filePath,
          meta,
          body,
          ...(errors.length > 0 ? { parseError: errors.join('；') } : {}),
        });
      } catch (error) {
        records.push({
          auditId: dirName,
          dirPath,
          filePath,
          meta: {
            schemaVersion: 1,
            auditId: dirName,
            createdAt: '',
            baseRevision: '',
            scope: '.',
            trigger: 'manual',
            previousAudit: null,
            issues: [],
          },
          body: '',
          parseError: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return records;
  }

  async get(auditId: string, source?: AuditSource): Promise<AuditRecord | null> {
    const text = source
      ? await source.readAuditText(auditId)
      : await readFile(this.auditFilePath(auditId), 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (text === null) return null;
    const dirPath = path.join(this.auditsDir, auditId);
    const filePath = path.join(dirPath, 'audit.md');
    const { meta, body } = parseAuditMarkdown(text);
    const errors = auditInvariantErrors(meta, auditId, body);
    return {
      auditId,
      dirPath,
      filePath,
      meta,
      body,
      ...(errors.length > 0 ? { parseError: errors.join('；') } : {}),
    };
  }

  async read(auditId: string, source?: AuditSource): Promise<AuditRecord> {
    const record = await this.get(auditId, source);
    if (!record) throw new Error(`审查档案不存在：${auditId}`);
    return record;
  }
}
