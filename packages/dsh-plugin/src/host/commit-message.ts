import { parsePatch } from './patch.js';
import type { AuthorStats, ReviewCandidate } from './types.js';

/** 批准提交的消息组装层（SPEC §4.5）。首行由 Host 按所选方案生成，正文只采集可验证事实。 */

export type CommitMessageDetail = 'simple' | 'detailed';
export type { AuthorStats, AuthorStatBucket } from './types.js';

export const DETAILED_BODY_MAX_CHARS = 6000;
const DETAILED_TEXT_LIMIT = 900;

export function normalizeCommitDetail(value: unknown): CommitMessageDetail | undefined {
  return value === 'simple' || value === 'detailed' ? value : undefined;
}

/** SPEC §4.5：simple/detailed 首行若所选方案存在人工补丁，追加 `@ patch <最新人工补丁编号>`（严禁使用 record_revision）。 */
export function buildCommitSubject(candidate: ReviewCandidate, optionId?: string): string {
  const title = candidate.meta.title.replace(/\s+/g, ' ').trim();
  const scopedPatches = optionId
    ? candidate.meta.patches.filter((patch) => patch.optionId === optionId)
    : candidate.meta.patches;
  const latestHumanPatch = scopedPatches
    .filter((patch) => patch.author === 'human')
    .reduce((max, patch) => Math.max(max, patch.id), 0);
  const patchTag = latestHumanPatch > 0 ? ` @ patch ${String(latestHumanPatch)}` : '';
  return `review(${candidate.id}): ${title}${patchTag}`;
}

export function composeCommitMessage(
  candidate: ReviewCandidate,
  detail: CommitMessageDetail,
  body: string,
  optionId?: string,
): string {
  const subject = buildCommitSubject(candidate, optionId);
  if (detail === 'simple') return subject;
  const trimmed = body.trim();
  if (!trimmed) return subject;
  const clamped = trimmed.length > DETAILED_BODY_MAX_CHARS
    ? `${trimmed.slice(0, DETAILED_BODY_MAX_CHARS)}\n…（正文已截断）`
    : trimmed;
  return `${subject}\n\n${clamped}`;
}

function flatten(text: string, limit = DETAILED_TEXT_LIMIT): string {
  const compact = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '· ').trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…（截断）` : compact;
}

export interface CommitMessageContext {
  repoRoot: string;
  optionId?: string;
  patchId?: number;
  authorStats?: AuthorStats;
  patchText?: string;
  vcsType: 'git' | 'svn';
}

export async function buildCommitDetails(
  candidate: ReviewCandidate,
  context: CommitMessageContext,
): Promise<string> {
  const lines: string[] = [];
  const meta = candidate.meta;
  const option = context.optionId ? meta.options.find((o) => o.id === context.optionId) : meta.options[0];
  const patchId = context.patchId ?? option?.currentPatch;
  const patchEntry = patchId !== undefined ? meta.patches.find((p) => p.id === patchId) : undefined;
  const gateChecks = option?.gateChecks ?? [];

  const unit = context.vcsType === 'git' ? '提交' : 'revision';
  const committedFiles = context.patchText !== undefined ? parsePatch(context.patchText).stats.files : null;
  if (context.authorStats) {
    const stats = context.authorStats;
    if (stats.diagnostic) {
      lines.push(`作者统计：不可用（${stats.diagnostic}）`);
    } else if (stats.buckets.length === 0) {
      lines.push('作者统计：当前范围内没有可统计的提交');
    } else {
      lines.push(`作者统计（${stats.scope === 'tracked' ? '本问题触及文件' : '仓库'}）：`);
      for (const bucket of stats.buckets) {
        const identity = bucket.email ? `${bucket.name || bucket.email} <${bucket.email}>` : (bucket.name || '(未署名)');
        lines.push(`- ${identity}：${String(bucket.commits)} 次${unit}`);
      }
    }
    const files = committedFiles ?? stats.pendingFiles;
    lines.push(`本次提交：${context.vcsType === 'git' ? '1 个业务原子提交' : '1 个业务 revision'}，涉及 ${String(files)} 个业务文件（待提交，不计入上方历史统计）`);
  } else {
    lines.push('作者统计：不可用（当前 VCS 适配器不提供作者统计）');
  }

  if (context.patchText !== undefined) {
    const parsed = parsePatch(context.patchText);
    const { files, additions, deletions, entries } = parsed.stats;
    lines.push('', `改动摘要：${String(files)} 个文件，+${String(additions)} / -${String(deletions)} 行`);
    for (const entry of entries.slice(0, 20)) {
      lines.push(`- ${entry.path} +${String(entry.additions)} / -${String(entry.deletions)}${entry.binary ? '（二进制）' : ''}`);
    }
    if (entries.length > 20) lines.push(`- …另有 ${String(entries.length - 20)} 个文件`);
  }

  const solution = flatten(candidate.sections.solution);
  lines.push('', '修复方案：', solution || '（未填写修复方案）');
  const rootCause = flatten(candidate.sections.rootCause, 400);
  if (rootCause) lines.push('', '根因：', rootCause);

  const source: string[] = [
    `.ai-review/${candidate.id}（record_revision ${String(meta.recordRevision)} · finding_id ${meta.findingId}）`,
  ];
  if (option && patchEntry) {
    source.push(`所选方案 ${option.id} / 补丁 #${String(patchEntry.id)}（${patchEntry.patch} · author ${patchEntry.author}）`);
  }
  const humanPatches = (option
    ? meta.patches.filter((p) => p.optionId === option.id && p.author === 'human')
    : meta.patches.filter((p) => p.author === 'human'))
    .map((p) => `patch ${String(p.id)}`);
  if (humanPatches.length > 0) source.push(`人工修订 ${humanPatches.join(' / ')}`);
  source.push(`审查类型 ${meta.auditType || '未填写'}`);
  if (meta.ticket) source.push(`工单 ${meta.ticket}`);
  const auditIds = [...new Set(meta.observations.map((o) => o.auditId).filter(Boolean))];
  if (auditIds.length > 0) source.push(`审查来源 ${auditIds.join(' / ')}`);
  lines.push('', '来源元数据：', ...source.map((item) => `- ${item}`));

  lines.push(
    '',
    `门禁（本次批准实际执行 ${String(gateChecks.length)} 条）：`,
    ...(gateChecks.length > 0 ? gateChecks.map((command) => `- ${command}`) : ['- （无）']),
  );

  if (meta.humanDecisions.length > 0) {
    lines.push(
      '',
      `人工判断项（${String(meta.humanDecisions.length)} 项）：`,
      ...meta.humanDecisions.map((item) => `- ${item.id}：${flatten(item.question, 160)}`),
    );
  }
  if (meta.comments.length > 0) {
    const resolved = meta.comments.filter((comment) => comment.status === 'resolved').length;
    lines.push('', `审核评论：共 ${String(meta.comments.length)} 条，已处理 ${String(resolved)} 条`);
  }

  return lines.join('\n');
}
