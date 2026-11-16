import { parsePatch } from './patch.js';
import { loadReviewers } from './reviewers.js';
import type { AuthorStats, ReviewCandidate } from './types.js';

/**
 * §5.6 / §10.2（2026-11-12 修订）：批准提交信息的「简略 / 详细」两种组成。
 *
 * 规范要求（单一行 `review(YYYY-MM/slug): title [@ rev N]`）由 Host 生成，不依赖
 * AI 写入的 `commit_message` 是否恰好有多行；「详细」只决定是否在规范单行之后
 * **空一行**追加正文块。正文块只呈现 Host 能自证的事实（作者统计、改动摘要、
 * 修复方案、来源候选、门禁与人工判断项、评论处理情况），不编造验证结论。
 */

export type CommitMessageDetail = 'simple' | 'detailed';

export type { AuthorStats, AuthorStatBucket } from './types.js';
export const DETAILED_BODY_MAX_CHARS = 6000;
const DETAILED_TEXT_LIMIT = 900;

export function normalizeCommitDetail(value: unknown): CommitMessageDetail | undefined {
  return value === 'simple' || value === 'detailed' ? value : undefined;
}

/** 规范单行：`review(<id>): <title>`，必要时追加 `[@ rev N]` 标记人类修订版本。 */
export function buildCommitSubject(candidate: ReviewCandidate): string {
  const title = candidate.meta.title.replace(/\s+/g, ' ').trim();
  const humanRevisions = candidate.meta.revisions.filter((revision) => revision.author === 'human');
  const latestHuman = humanRevisions.reduce((max, revision) => Math.max(max, revision.id), 0);
  const revTag = latestHuman > 0 ? ` @ rev ${String(latestHuman)}` : '';
  return `review(${candidate.id}): ${title}${revTag}`;
}

/**
 * 简略：只返回规范单行。
 * 详细：规范单行 + 空行 + 正文块（会被压到 `DETAILED_BODY_MAX_CHARS` 以内）。
 */
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

/** 单行化并把 Markdown 噪声压平：列表项保留要点，标题/引用标记去掉。 */
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
  /** §7.1：prefer 共享快照读取 reviewers.yml；读不到时回退工作区。 */
  readReviewersText?: () => Promise<string | null>;
  /** 作者统计；缺省（VCS 不支持）时正文写「统计不可用」。 */
  authorStats?: AuthorStats;
  /** 当前版本补丁文本（共享快照）；缺省时不渲染「改动摘要」。 */
  patchText?: string;
  vcsType: 'git' | 'svn';
}

/** 正文块：详细提交信息的可自证事实摘要。 */
export async function buildCommitDetails(
  candidate: ReviewCandidate,
  context: CommitMessageContext,
): Promise<string> {
  const lines: string[] = [];
  const meta = candidate.meta;

  // 1) 作者统计——明确区分历史提交与本次待提交。
  const unit = context.vcsType === 'git' ? '提交' : 'revision';
  // 「本次提交」的文件数取自即将提交的补丁（批准时补丁尚未应用到工作区，git status 恒为 0）。
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
        // SVN 只提供作者名（无邮箱），不得渲染成 `name <>`。
        const identity = bucket.email ? `${bucket.name || bucket.email} <${bucket.email}>` : (bucket.name || '(未署名)');
        lines.push(`- ${identity}：${String(bucket.commits)} 次${unit}`);
      }
    }
    const files = committedFiles ?? stats.pendingFiles;
    lines.push(`本次提交：${context.vcsType === 'git' ? '1 个业务原子提交' : '1 个业务 revision'}，涉及 ${String(files)} 个业务文件（待提交，不计入上方历史统计）`);
  } else {
    lines.push('作者统计：不可用（当前 VCS 适配器不提供作者统计）');
  }

  // 2) 改动摘要——只来自当前版本补丁，不推断未发生的改动。
  if (context.patchText !== undefined) {
    const parsed = parsePatch(context.patchText);
    const { files, additions, deletions, entries } = parsed.stats;
    lines.push('', `改动摘要：${String(files)} 个文件，+${String(additions)} / -${String(deletions)} 行`);
    for (const entry of entries.slice(0, 20)) {
      lines.push(`- ${entry.path} +${String(entry.additions)} / -${String(entry.deletions)}${entry.binary ? '（二进制）' : ''}`);
    }
    if (entries.length > 20) lines.push(`- …另有 ${String(entries.length - 20)} 个文件`);
  }

  // 3) 修复方案。
  const solution = flatten(candidate.sections.solution);
  lines.push('', '修复方案：', solution || '（候选未填写修复方案）');
  const rootCause = flatten(candidate.sections.rootCause, 400);
  if (rootCause) lines.push('', '根因：', rootCause);

  // 4) 来源候选——人类修订时说明版本与作者；正常情况说明候选与版本。
  const currentRevision = meta.revisions.find((revision) => revision.id === meta.currentRevision);
  const source = [`.ai-review/${candidate.id}（rev ${String(meta.currentRevision)}${currentRevision?.author ? ` · author ${currentRevision.author}` : ''}）`];
  if (meta.reopenedFrom) source.push(`重开来源 ${meta.reopenedFrom}`);
  const humanRevisions = meta.revisions.filter((revision) => revision.author === 'human').map((revision) => `rev ${String(revision.id)}`);
  if (humanRevisions.length > 0) source.push(`人工修订 ${humanRevisions.join(' / ')}`);
  source.push(`审查类型 ${meta.auditType || '未填写'}`);
  if (meta.ticket) source.push(`工单 ${meta.ticket}`);
  lines.push('', '来源候选：', ...source.map((item) => `- ${item}`));

  // 5) 门禁——只列命令，执行结果由批准快照留痕，不在提交信息里重复断言。
  lines.push('', `门禁（本次批准重新执行 ${String(meta.gateChecks.length)} 条）：`,
    ...(meta.gateChecks.length > 0 ? meta.gateChecks.map((command) => `- ${command}`) : ['- （无）']));

  // 6) 人工判断项 + 评论处理情况。
  if (meta.humanDecisions.length > 0) {
    lines.push('', `人工判断项（${String(meta.humanDecisions.length)} 项）：`, ...meta.humanDecisions.map((item) => `- ${item.id}：${flatten(item.question, 160)}`));
  }
  if (meta.comments.length > 0) {
    const resolved = meta.comments.filter((comment) => comment.status === 'resolved').length;
    lines.push('', `审核评论：共 ${String(meta.comments.length)} 条，已处理 ${String(resolved)} 条`);
  }

  // 7) reviewers.yml 中的白名单统计：帮助审阅者判断门禁是否受控。
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
    // reviewers.yml 不可读时不影响提交信息生成：批准流程已独立校验过配置。
  }

  // 说明：审查溯源（audits/<audit_id>/audit.md）不在此渲染——review.md 的 Frontmatter
  // 不记录 audit_id，任何按日期/范围猜测都会在跨轮次审查时指错档案，因此宁可不写。
  return lines.join('\n');
}
