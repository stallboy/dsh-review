import { parsePatch } from './patch.js';
import { loadReviewers } from './reviewers.js';
import type { AuthorStats, ReviewCandidate } from './types.js';

/** 批准提交的消息组装层。首行由 Host 按候选生成，正文只采集能从当前评审信息验证的事实。 */

export type CommitMessageDetail = 'simple' | 'detailed';

export type { AuthorStats, AuthorStatBucket } from './types.js';
export const DETAILED_BODY_MAX_CHARS = 6000;
const DETAILED_TEXT_LIMIT = 900;

export function normalizeCommitDetail(value: unknown): CommitMessageDetail | undefined {
  return value === 'simple' || value === 'detailed' ? value : undefined;
}

export function buildCommitSubject(candidate: ReviewCandidate): string {
  const title = candidate.meta.title.replace(/\s+/g, ' ').trim();
  const humanRevisions = candidate.meta.revisions.filter((revision) => revision.author === 'human');
  const latestHuman = humanRevisions.reduce((max, revision) => Math.max(max, revision.id), 0);
  const revTag = latestHuman > 0 ? ` @ rev ${String(latestHuman)}` : '';
  return `review(${candidate.id}): ${title}${revTag}`;
}

/** 详细模式仍保留标准首行，用空行隔开受长度限制的正文。 */
export function composeCommitMessage(
  candidate: ReviewCandidate,
  detail: CommitMessageDetail,
  body: string,
): string {
  const subject = buildCommitSubject(candidate);
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
  /** 由批准调用方注入同一次批准所用的共享快照读取。 */
  readReviewersText?: () => Promise<string | null>;
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

  const unit = context.vcsType === 'git' ? '提交' : 'revision';
  // 生成消息时补丁尚未应用，工作区状态无法代表本次提交的文件数。
  const committedFiles = context.patchText !== undefined ? parsePatch(context.patchText).stats.files : null;
  if (context.authorStats) {
    const stats = context.authorStats;
    if (stats.diagnostic) {
      lines.push(`作者统计：不可用（${stats.diagnostic}）`);
    } else if (stats.buckets.length === 0) {
      lines.push('作者统计：当前范围内没有可统计的提交');
    } else {
      lines.push(`作者统计（${stats.scope === 'tracked' ? '本候选触及文件' : '仓库'}）：`);
      for (const bucket of stats.buckets) {
        // SVN 作者统计可能没有邮箱，空地址会误导读者。
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
  lines.push('', '修复方案：', solution || '（候选未填写修复方案）');
  const rootCause = flatten(candidate.sections.rootCause, 400);
  if (rootCause) lines.push('', '根因：', rootCause);

  const currentRevision = meta.revisions.find((revision) => revision.id === meta.currentRevision);
  const source = [`.ai-review/${candidate.id}（rev ${String(meta.currentRevision)}${currentRevision?.author ? ` · author ${currentRevision.author}` : ''}）`];
  if (meta.reopenedFrom) source.push(`重开来源 ${meta.reopenedFrom}`);
  const humanRevisions = meta.revisions.filter((revision) => revision.author === 'human').map((revision) => `rev ${String(revision.id)}`);
  if (humanRevisions.length > 0) source.push(`人工修订 ${humanRevisions.join(' / ')}`);
  source.push(`审查类型 ${meta.auditType || '未填写'}`);
  if (meta.ticket) source.push(`工单 ${meta.ticket}`);
  lines.push('', '来源候选：', ...source.map((item) => `- ${item}`));

  // 门禁结果以批准快照为准，提交消息只记录计划执行的命令。
  lines.push('', `门禁（本次批准重新执行 ${String(meta.gateChecks.length)} 条）：`,
    ...(meta.gateChecks.length > 0 ? meta.gateChecks.map((command) => `- ${command}`) : ['- （无）']));

  if (meta.humanDecisions.length > 0) {
    lines.push('', `人工判断项（${String(meta.humanDecisions.length)} 项）：`, ...meta.humanDecisions.map((item) => `- ${item.id}：${flatten(item.question, 160)}`));
  }
  if (meta.comments.length > 0) {
    const resolved = meta.comments.filter((comment) => comment.status === 'resolved').length;
    lines.push('', `审核评论：共 ${String(meta.comments.length)} 条，已处理 ${String(resolved)} 条`);
  }

  try {
    const reviewers = await loadReviewers(
      context.repoRoot,
      context.readReviewersText ? { readReviewersText: context.readReviewersText } : undefined,
    );
    if (reviewers.allowedGateCommands.length > 0) {
      const allowed = meta.gateChecks.filter((command) => reviewers.allowedGateCommands.includes(command.trim())).length;
      lines.push(`门禁白名单：${String(allowed)}/${String(meta.gateChecks.length)} 条在 reviewers.yml allowed_gate_commands 中`);
    }
  } catch {
    // 这次读取只用于丰富提交消息，批准流程另外负责配置校验。
  }

  // 候选元数据没有 audit_id，按日期或范围推断可能指向别的审查轮次。
  return lines.join('\n');
}
