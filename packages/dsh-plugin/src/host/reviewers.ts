import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './types.js';
import { dump, readYamlDocument } from './yaml.js';

export interface ReviewerRule {
  owner: string;
  paths: string[];
  tags: string[];
}

export interface ReviewersConfig {
  defaultOwner: string;
  rules: ReviewerRule[];
  staleDays: number;
  rejectionMemoryDays: number;
  maxAntiPatterns: number;
  exists: boolean;
  valid: boolean;
  errors: string[];
}

export interface OwnerResolution {
  owner: string;
  ruleIndex: number | null;
  pathHits: number;
  tagHits: number;
  reason: string;
}

export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_REJECTION_MEMORY_DAYS = 30;
export const DEFAULT_MAX_ANTI_PATTERNS = 20;

export function reviewersPath(repoRoot: string): string {
  return path.join(repoRoot, '.ai-review', 'reviewers.yml');
}

export function serializeInitialReviewers(defaultOwner: string): string {
  const owner = defaultOwner.trim();
  if (!owner) throw new ApiError(422, 'bad_request', 'defaultOwner 必须是非空字符串');
  const doc = {
    default_owner: owner,
    rules: [],
    stale_days: DEFAULT_STALE_DAYS,
    rejection_memory_days: DEFAULT_REJECTION_MEMORY_DAYS,
    max_anti_patterns: DEFAULT_MAX_ANTI_PATTERNS,
  };
  return `# dsh-code-review 负责人路由与周期配置\n${dump(doc, { lineWidth: -1, noRefs: true })}`;
}

function positiveInt(value: unknown, fallback: number, field: string, errors: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  errors.push(`${field} 必须是正整数（已回退默认值 ${String(fallback)}）`);
  return fallback;
}

function stringArray(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须是字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
    else errors.push(`${field} 包含非字符串或空项`);
  }
  return out;
}

export function parseReviewersYaml(text: string): ReviewersConfig {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = readYamlDocument(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      defaultOwner: '',
      rules: [],
      staleDays: DEFAULT_STALE_DAYS,
      rejectionMemoryDays: DEFAULT_REJECTION_MEMORY_DAYS,
      maxAntiPatterns: DEFAULT_MAX_ANTI_PATTERNS,
      exists: true,
      valid: false,
      errors: [`reviewers.yml YAML 解析失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      defaultOwner: '',
      rules: [],
      staleDays: DEFAULT_STALE_DAYS,
      rejectionMemoryDays: DEFAULT_REJECTION_MEMORY_DAYS,
      maxAntiPatterns: DEFAULT_MAX_ANTI_PATTERNS,
      exists: true,
      valid: false,
      errors: ['reviewers.yml 顶层必须是对象'],
    };
  }
  const record = doc as Record<string, unknown>;
  const defaultOwner = typeof record['default_owner'] === 'string' ? record['default_owner'].trim() : '';
  if (!defaultOwner) errors.push('default_owner 必填且不能为空');

  const staleDays = positiveInt(record['stale_days'], DEFAULT_STALE_DAYS, 'stale_days', errors);
  const rejectionMemoryDays = positiveInt(
    record['rejection_memory_days'],
    DEFAULT_REJECTION_MEMORY_DAYS,
    'rejection_memory_days',
    errors,
  );
  const maxAntiPatterns = positiveInt(
    record['max_anti_patterns'],
    DEFAULT_MAX_ANTI_PATTERNS,
    'max_anti_patterns',
    errors,
  );

  const rules: ReviewerRule[] = [];
  if (record['rules'] !== undefined) {
    if (!Array.isArray(record['rules'])) {
      errors.push('rules 必须是数组');
    } else {
      record['rules'].forEach((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          errors.push(`rules[${String(index)}] 必须是对象`);
          return;
        }
        const entry = item as Record<string, unknown>;
        const owner = typeof entry['owner'] === 'string' ? entry['owner'].trim() : '';
        const paths = stringArray(entry['paths'], `rules[${String(index)}].paths`, errors);
        const tags = [...new Set(stringArray(entry['tags'], `rules[${String(index)}].tags`, errors).map((t) => t.toLowerCase()))];
        if (!owner) {
          errors.push(`rules[${String(index)}] 缺少非空 owner`);
          return;
        }
        if (paths.length === 0 && tags.length === 0) {
          errors.push(`rules[${String(index)}] 必须至少提供 paths 或 tags 之一`);
          return;
        }
        rules.push({ owner, paths, tags });
      });
    }
  }

  return {
    defaultOwner,
    rules,
    staleDays,
    rejectionMemoryDays,
    maxAntiPatterns,
    exists: true,
    valid: errors.length === 0,
    errors,
  };
}

export async function loadReviewers(
  repoRoot: string,
  source?: { readReviewersText(): Promise<string | null> },
): Promise<ReviewersConfig> {
  let text: string | null;
  if (source) {
    text = await source.readReviewersText();
  } else {
    try {
      text = await readFile(reviewersPath(repoRoot), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = null;
      else throw error;
    }
  }
  if (text === null) {
    return {
      defaultOwner: '',
      rules: [],
      staleDays: DEFAULT_STALE_DAYS,
      rejectionMemoryDays: DEFAULT_REJECTION_MEMORY_DAYS,
      maxAntiPatterns: DEFAULT_MAX_ANTI_PATTERNS,
      exists: false,
      valid: false,
      errors: ['缺少 .ai-review/reviewers.yml（请初始化并配置 default_owner）'],
    };
  }
  return parseReviewersYaml(text);
}

/** AC-ROUTING-01：启动审查前强制核验有效的 reviewers.yml 与非空 default_owner，缺失即前置阻断。 */
export async function requireValidReviewers(
  repoRoot: string,
  source?: { readReviewersText(): Promise<string | null> },
): Promise<ReviewersConfig> {
  const config = await loadReviewers(repoRoot, source);
  if (!config.exists) {
    throw new ApiError(
      412,
      'not_configured',
      '启动审查前必须先初始化 .ai-review/reviewers.yml 并配置有效的 default_owner（可调用 POST /reviewers/init 一键初始化）',
      { reviewersMissing: true, errors: config.errors },
    );
  }
  if (!config.valid || !config.defaultOwner) {
    throw new ApiError(
      412,
      'not_configured',
      `.ai-review/reviewers.yml 配置无效，无法启动审查：${config.errors.join('；')}`,
      { reviewersInvalid: true, errors: config.errors },
    );
  }
  return config;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** glob 仅支持 **（跨 /）、*（单段）与 ?（单字符）。 */
export function matchGlob(pattern: string, target: string): boolean {
  const normalizedPattern = normalizePath(pattern.trim());
  const normalizedTarget = normalizePath(target.trim());
  if (!normalizedPattern || !normalizedTarget) return false;
  let regex = '^';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index] ?? '';
    const next = normalizedPattern[index + 1];
    if (char === '*' && next === '*') {
      const after = normalizedPattern[index + 2];
      if (after === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(char)) regex += `\\${char}`;
    else regex += char;
  }
  regex += '$';
  return new RegExp(regex).test(normalizedTarget);
}

/** AC-ROUTING-01：paths 与 tags 同时声明时按 AND 匹配；决胜按 pathHits 降序 -> tagHits 降序 -> 声明顺序。 */
export function resolveOwner(
  config: ReviewersConfig,
  input: { paths: string[]; tags: string[] },
): OwnerResolution {
  const files = [...new Set(input.paths.map(normalizePath).filter((p) => p.length > 0))];
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  let best: OwnerResolution | null = null;

  config.rules.forEach((rule, index) => {
    const hasPaths = rule.paths.length > 0;
    const hasTags = rule.tags.length > 0;
    if (!hasPaths && !hasTags) return;
    const pathHits = hasPaths ? files.filter((file) => rule.paths.some((pattern) => matchGlob(pattern, file))).length : 0;
    const tagHits = hasTags ? tags.filter((tag) => rule.tags.includes(tag)).length : 0;
    if (hasPaths && pathHits === 0) return;
    if (hasTags && tagHits === 0) return;
    if (
      best === null
      || pathHits > best.pathHits
      || (pathHits === best.pathHits && tagHits > best.tagHits)
    ) {
      best = {
        owner: rule.owner,
        ruleIndex: index,
        pathHits,
        tagHits,
        reason: `命中规则 #${String(index + 1)}（路径 ${String(pathHits)}，标签 ${String(tagHits)}）`,
      };
    }
  });

  if (best) return best;
  return {
    owner: config.defaultOwner,
    ruleIndex: null,
    pathHits: 0,
    tagHits: 0,
    reason: config.defaultOwner ? '回退到 default_owner' : '未命中规则且未配置 default_owner',
  };
}
