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
}

export const EMPTY_REVIEWERS: ReviewersConfig = { defaultOwner: '', rules: [] };

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
    return {
      defaultOwner: typeof record['default_owner'] === 'string' ? record['default_owner'].trim() : '',
      rules,
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
    const pathHits = normalizedPaths.reduce((count, candidate) => {
      return count + (rule.paths.some((glob) => globToRegExp(glob).test(candidate)) ? 1 : 0);
    }, 0);
    const tagHits = rule.tags.reduce((count, tag) => count + (tags.has(tag.toLowerCase()) ? 1 : 0), 0);
    if (best === null) {
      best = { rule, pathHits, tagHits };
      continue;
    }
    if (pathHits > best.pathHits || (pathHits === best.pathHits && tagHits > best.tagHits)) {
      best = { rule, pathHits, tagHits };
    }
  }
  if (best && (best.pathHits > 0 || best.tagHits > 0)) {
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
