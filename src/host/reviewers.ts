import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from './yaml.js';

export interface ReviewerRule {
  owner: string;
  paths: string[];
  tags: string[];
}

export interface ReviewersConfig {
  defaultOwner: string;
  rules: ReviewerRule[];
  /** §5：门禁白名单（trim 后精确匹配；未命中不是禁止，而是 UI 必须二次确认）。 */
  allowedGateCommands: string[];
  /** §5：updated_at 超过该天数进入超时废弃流程；未配置时仅提示。 */
  staleDays: number | null;
  /** §5：rejected 参与重复阻止的时间窗（天），默认 30。 */
  rejectionMemoryDays: number;
  /** §5：每模块最多注入的负向摘要数量，默认 20。 */
  maxAntiPatterns: number;
  /** §4.2/G42：收尾门禁复算模式 none/smoke/declared，默认 none。 */
  verifyGateOnAuditFinalize: 'none' | 'smoke' | 'declared';
  /** §4.2/G42：smoke 模式按顺序在仓库根目录执行的命令。 */
  auditSmokeCommands: string[];
}

export const EMPTY_REVIEWERS: ReviewersConfig = {
  defaultOwner: '',
  rules: [],
  allowedGateCommands: [],
  staleDays: null,
  rejectionMemoryDays: 30,
  maxAntiPatterns: 20,
  verifyGateOnAuditFinalize: 'none',
  auditSmokeCommands: [],
};

export function reviewersPath(repoRoot: string): string {
  return path.join(repoRoot, '.ai-review', 'reviewers.yml');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

export async function loadReviewers(repoRoot: string): Promise<ReviewersConfig> {
  try {
    const text = await readFile(reviewersPath(repoRoot), 'utf8');
    const doc = load(text, { json: true });
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ...EMPTY_REVIEWERS };
    const record = doc as Record<string, unknown>;
    const rulesRaw = Array.isArray(record['rules']) ? record['rules'] : [];
    const rules: ReviewerRule[] = [];
    for (const item of rulesRaw) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const rule = item as Record<string, unknown>;
      const owner = typeof rule['owner'] === 'string' ? rule['owner'].trim() : '';
      if (!owner) continue;
      rules.push({
        owner,
        paths: asStringArray(rule['paths']),
        tags: asStringArray(rule['tags']),
      });
    }
    const asPositiveInt = (value: unknown): number | null => {
      const num = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
      return Number.isInteger(num) && num > 0 ? num : null;
    };
    return {
      defaultOwner: typeof record['default_owner'] === 'string' ? record['default_owner'].trim() : '',
      rules,
      allowedGateCommands: asStringArray(record['allowed_gate_commands']),
      staleDays: asPositiveInt(record['stale_days']),
      rejectionMemoryDays: asPositiveInt(record['rejection_memory_days']) ?? EMPTY_REVIEWERS.rejectionMemoryDays,
      maxAntiPatterns: asPositiveInt(record['max_anti_patterns']) ?? EMPTY_REVIEWERS.maxAntiPatterns,
      verifyGateOnAuditFinalize:
        record['verify_gate_on_audit_finalize'] === 'smoke' || record['verify_gate_on_audit_finalize'] === 'declared'
          ? record['verify_gate_on_audit_finalize']
          : 'none',
      auditSmokeCommands: asStringArray(record['audit_smoke_commands']),
    };
  } catch {
    return { ...EMPTY_REVIEWERS };
  }
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  let pattern = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? '';
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '.';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

export interface RouteInput {
  paths: string[];
  tags: string[];
}

export interface RouteDecision {
  owner: string;
  reason: string;
  ruleOwner?: string;
}

export function resolveOwner(config: ReviewersConfig, input: RouteInput): RouteDecision {
  const normalizedPaths = input.paths.map((item) => item.replaceAll('\\', '/'));
  const tags = new Set(input.tags.map((tag) => tag.toLowerCase()));
  let best: { rule: ReviewerRule; pathHits: number; tagHits: number } | null = null;
  for (const rule of config.rules) {
    const hasPaths = rule.paths.length > 0;
    const hasTags = rule.tags.length > 0;
    // §4.2：两类都缺省的规则无效，不得作为通配规则。
    if (!hasPaths && !hasTags) continue;
    const pathHits = hasPaths
      ? normalizedPaths.reduce((count, candidate) => {
          return count + (rule.paths.some((glob) => globToRegExp(glob).test(candidate)) ? 1 : 0);
        }, 0)
      : 0;
    // tagHits：至少命中一个规则标签的不同规范化候选 tag 数（同一 tag 只计一次）。
    const matchedTags = new Set<string>();
    if (hasTags) {
      for (const tag of tags) {
        if (rule.tags.some((ruleTag) => ruleTag.toLowerCase() === tag)) matchedTags.add(tag);
      }
    }
    const tagHits = matchedTags.size;
    // §4.2：两类同时存在时必须 AND（都至少命中一次）才参与。
    if (hasPaths && hasTags && (pathHits === 0 || tagHits === 0)) continue;
    if (hasPaths && !hasTags && pathHits === 0) continue;
    if (!hasPaths && hasTags && tagHits === 0) continue;
    if (best === null || pathHits > best.pathHits || (pathHits === best.pathHits && tagHits > best.tagHits)) {
      best = { rule, pathHits, tagHits };
    }
  }
  if (best) {
    return {
      owner: best.rule.owner,
      ruleOwner: best.rule.owner,
      reason: `匹配规则 ${best.rule.owner}（路径命中 ${String(best.pathHits)}，tag 命中 ${String(best.tagHits)}）`,
    };
  }
  return {
    owner: config.defaultOwner,
    reason: config.defaultOwner ? '未命中规则，使用 default_owner' : '未命中规则且未配置 default_owner',
  };
}
