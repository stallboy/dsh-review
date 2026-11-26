/**
 * 正式问题发布与跨轮合并（SPEC §3.3 / §3.5 / §4.1 / D07 / D08）：
 * - 统一输出 schema_version: 1 的唯一 review.md（绝不硬编码 module='audit'）；
 * - 保留原目录、原 owner、人类评论、人工处置与补丁账本；
 * - 严格递增 updated_at；重开 approved 时转存 approval_history[] 并清空旧 options[] 退役旧 option_id；
 * - audit.md 仅作为纯索引（issues: YYYY-MM/<slug>[]）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditIdTimestampUtc, serializeAuditMarkdown, type AuditFrontmatter, type AuditTrigger } from './audit-archive.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from './frontmatter.js';
import { FINDING_ID_PATTERN, OPTION_ID_PATTERN, quickReviewInvariants, SLUG_PATTERN } from './invariants.js';
import { formatPatchFilename, nextUpdatedAt, retiredOptionIds, sha256Hex } from './issue-review.js';
import { parsePatch } from './patch.js';
import { resolveOwner, type ReviewersConfig } from './reviewers.js';
import type { StageCandidate } from './audit-stage-artifacts.js';
import type {
  AuditType,
  HumanDecision,
  IssueEvidence,
  IssueKind,
  IssueObservation,
  PatchEntry,
  RepairOption,
  ReviewCandidate,
  ReviewFrontmatter,
  ReviewPriority,
  ReviewStatus,
} from './types.js';

export interface PublishedPatchProposal {
  optionId: string;
  title: string;
  tradeoff: string;
  confidence: number;
  auditType: AuditType;
  gateChecks: string[];
  humanDecisions: HumanDecision[];
  patchText: string;
  patchBytes: Buffer;
  summary: string;
}

export interface PublishedFindingInput {
  findingId: string;
  title: string;
  module?: string;
  auditType: AuditType;
  issueKind: IssueKind;
  dependsOn: string | null;
  priority: ReviewPriority;
  reason: string;
  problemSummary: string;
  rootCause: string;
  repairPlan: string;
  tags: string[];
  evidence: IssueEvidence[];
  proposals: PublishedPatchProposal[];
}

export interface ReviewedExternalFindingInput {
  findingId: string;
  verdict: 'confirmed' | 'resolved' | 'unverified';
  reason: string;
  evidence: IssueEvidence[];
}

export interface BuildIssuePublicationInput {
  auditId: string;
  baseRevision: string;
  scope: string;
  trigger: AuditTrigger;
  previousAudit: string | null;
  reviewers: ReviewersConfig;
  existingByFindingId: ReadonlyMap<string, ReviewCandidate>;
  existingDirIds: ReadonlySet<string>;
  findings: readonly PublishedFindingInput[];
  reviewedExternal: readonly ReviewedExternalFindingInput[];
  coverageLines: readonly string[];
  requirementLines: readonly string[];
  historyLines: readonly string[];
  now?: Date;
}

export interface BuiltIssuePublication {
  auditMeta: AuditFrontmatter;
  reportPath: string;
  reportText: string;
  candidates: StageCandidate[];
  overview: Array<{ id: string; findingId: string; priority: ReviewPriority; issueKind: IssueKind; title: string }>;
}

const PRIORITY_RANK: Record<ReviewPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** D07：按显式 module → title 前缀 → 首个证据文件路径推导出真实小写模块标志，绝不硬编码 'audit'。 */
export function resolveIssueModule(input: { module?: string; title: string; targetFiles: readonly string[] }): string {
  const clean = (raw: string): string =>
    raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 32);

  if (input.module) {
    const candidate = clean(input.module);
    if (candidate && SLUG_PATTERN.test(candidate)) return candidate;
  }
  const colonMatch = /^([a-z0-9][a-z0-9._-]{0,31}):\s+/.exec(input.title.trim());
  if (colonMatch?.[1]) return colonMatch[1];

  for (const file of input.targetFiles) {
    const segments = file.replaceAll('\\', '/').split('/').filter(Boolean);
    const meaningful = segments.find((seg) => !['src', 'packages', 'apps', 'internal', 'pkg', 'lib'].includes(seg.toLowerCase()))
      ?? segments[0]
      ?? '';
    const withoutExt = meaningful.replace(/\.[^.]+$/, '');
    const derived = clean(withoutExt);
    if (derived && SLUG_PATTERN.test(derived)) return derived;
  }
  return 'core';
}

export function ensureModuleTitlePrefix(moduleName: string, rawTitle: string): string {
  const trimmed = rawTitle.trim().replace(/\r?\n/g, ' ');
  const prefix = `${moduleName}: `;
  if (trimmed.startsWith(prefix)) return trimmed;
  const stripped = trimmed.replace(/^[a-zA-Z0-9._-]+:\s*/, '').trim();
  return `${prefix}${stripped || '代码审查问题'}`;
}

export function slugFromFindingId(findingId: string): string {
  const normalized = findingId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  if (!normalized || !SLUG_PATTERN.test(normalized)) {
    throw new Error(`无法从 finding_id 生成合法小写目录 slug：${findingId}`);
  }
  return normalized;
}

function allocateIssueDirId(
  findingId: string,
  month: string,
  usedDirIds: Set<string>,
): string {
  const baseSlug = slugFromFindingId(findingId);
  let candidate = `${month}/${baseSlug}`;
  if (!usedDirIds.has(candidate)) {
    usedDirIds.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    candidate = `${month}/${baseSlug}-${String(suffix)}`;
    if (!usedDirIds.has(candidate)) {
      usedDirIds.add(candidate);
      return candidate;
    }
  }
  throw new Error(`无法为 ${findingId} 分配不冲突的目录 ID`);
}

function renderIssueBody(input: {
  finding: PublishedFindingInput;
  options: readonly RepairOption[];
  patches: readonly PatchEntry[];
  recordRevision: number;
  auditId: string;
  baseRevision: string;
  existingBody?: string;
}): string {
  const { finding, options, patches, recordRevision, auditId, baseRevision, existingBody } = input;
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const optionLines = options.length === 0
    ? [
      `- **分类**：${finding.issueKind === 'deferred' ? `Deferred（前置依赖 \`${finding.dependsOn ?? ''}\`）` : 'B 类文字方案（无自动补丁）'}`,
      finding.repairPlan.trim() || '- 详见问题分析与验收建议。',
    ]
    : [
      ...options.map((opt, idx) => {
        const p = patchById.get(opt.currentPatch);
        return `- **${idx === 0 ? '推荐方案' : '备选方案'} \`${opt.id}\`（补丁 \`${p?.patch ?? formatPatchFilename(opt.currentPatch)}\`，置信度 ${String(Math.round(opt.confidence * 100))}%）**：${opt.title} — ${opt.tradeoff}`;
      }),
      ...(finding.repairPlan.trim() ? ['', finding.repairPlan.trim()] : []),
    ];

  const allDecisions = finding.proposals.flatMap((p) => p.humanDecisions);
  const uniqueDecisions = new Map<string, HumanDecision>();
  for (const d of allDecisions) uniqueDecisions.set(d.id, d);
  const decisionLines = uniqueDecisions.size === 0
    ? ['- 无']
    : [...uniqueDecisions.values()].map((d) => `- **${d.id}**：${d.question}${d.note ? `（${d.note}）` : ''}`);

  const evidenceLines = finding.evidence.map(
    (ev) => `- \`${ev.path}:${String(ev.line)}\` — \`${ev.excerpt}\`（${ev.reason}）`,
  );
  const precheckNote = options.length > 0
    ? `- 补丁只读预检：${options.map((o) => `\`${patchById.get(o.currentPatch)?.patch ?? ''}\``).join('、')} 在基线 \`${baseRevision}\` 通过只读应用预检；实际修复门禁留待人工批准后由 Host 执行。`
    : '- 本问题当前为纯文字方案，无待应用补丁。';

  const newHistoryBlock = [
    `## 记录版本 ${String(recordRevision)}`,
    `- 审查 \`${auditId}\`（基线 \`${baseRevision}\`）：${finding.reason}`,
    ...(options.length > 0
      ? [`- 方案与补丁：${options.map((o) => `\`${o.id}\` → \`${formatPatchFilename(o.currentPatch)}\``).join('；')}`]
      : []),
  ].join('\n');

  let historySection = newHistoryBlock;
  if (existingBody) {
    const existingHistoryIdx = existingBody.search(/^#\s+审核记录\s*$/m);
    if (existingHistoryIdx >= 0) {
      const priorHistory = existingBody.slice(existingHistoryIdx).replace(/^#\s+审核记录\s*\r?\n/, '').trim();
      historySection = priorHistory ? `${priorHistory}\n\n${newHistoryBlock}` : newHistoryBlock;
    }
  }

  return [
    '# 问题与影响',
    finding.problemSummary.trim() || finding.reason,
    '',
    '# 根因',
    finding.rootCause.trim() || finding.reason,
    '',
    '# 当前修复方案',
    ...optionLines,
    '',
    '# 需人工判断项',
    ...decisionLines,
    '',
    '# 验证证据',
    ...evidenceLines,
    precheckNote,
    '',
    '# 审核记录',
    '',
    historySection,
  ].join('\n');
}

function buildCommitMessage(title: string, reason: string, issueKind: IssueKind): string | null {
  if (issueKind !== 'repair') return null;
  return `${title}\n\n${reason.trim()}`;
}

export async function buildIssuePublication(
  repoRoot: string,
  input: BuildIssuePublicationInput,
): Promise<BuiltIssuePublication> {
  const now = input.now ?? new Date();
  const auditCreatedAt = auditIdTimestampUtc(input.auditId) ?? now.toISOString();
  const month = auditCreatedAt.slice(0, 7);
  const usedDirIds = new Set<string>(input.existingDirIds);
  const seenFindingIds = new Set<string>();
  const candidates: StageCandidate[] = [];
  const publishedIssueIds: string[] = [];
  const overview: BuiltIssuePublication['overview'] = [];

  for (const finding of input.findings) {
    if (!FINDING_ID_PATTERN.test(finding.findingId)) {
      throw new Error(`finding_id 格式非法：${finding.findingId}`);
    }
    if (seenFindingIds.has(finding.findingId)) {
      throw new Error(`同轮发布包含重复 finding_id：${finding.findingId}`);
    }
    seenFindingIds.add(finding.findingId);

    if (finding.evidence.length === 0) {
      throw new Error(`正式问题 ${finding.findingId} 缺少已核验代码证据`);
    }
    if (finding.issueKind === 'repair' && (finding.proposals.length < 1 || finding.proposals.length > 2)) {
      throw new Error(`repair 问题 ${finding.findingId} 必须提供 1–2 个有效方案`);
    }
    if (finding.issueKind !== 'repair' && finding.proposals.length > 0) {
      throw new Error(`${finding.issueKind} 问题 ${finding.findingId} 不得附带补丁方案`);
    }
    if (finding.issueKind === 'deferred' && (!finding.dependsOn || finding.dependsOn === finding.findingId)) {
      throw new Error(`deferred 问题 ${finding.findingId} 必须提供合法非自身前置 depends_on`);
    }

    const existing = input.existingByFindingId.get(finding.findingId);
    const dirId = existing ? existing.id : allocateIssueDirId(finding.findingId, month, usedDirIds);
    const [dirMonth, dirSlug] = dirId.split('/') as [string, string];

    const evidencePaths = finding.evidence.map((e) => e.path);
    const proposalPaths = finding.proposals.flatMap((p) => parsePatch(p.patchText).paths);
    const mergedTargets = [...new Set([
      ...(existing ? existing.meta.targetFiles : []),
      ...evidencePaths,
      ...proposalPaths,
    ])];
    if (mergedTargets.length === 0) {
      throw new Error(`问题 ${finding.findingId} 的 target_files 不能为空`);
    }

    const moduleName = existing?.meta.module || resolveIssueModule({
      ...(finding.module ? { module: finding.module } : {}),
      title: finding.title,
      targetFiles: mergedTargets,
    });
    const fullTitle = ensureModuleTitlePrefix(moduleName, finding.title);
    const normalizedTags = [...new Set([
      ...(existing ? existing.meta.tags : []),
      ...finding.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    ])];

    const obsAt = existing ? nextUpdatedAt(existing.meta.updatedAt, now) : auditCreatedAt;
    const observation: IssueObservation = {
      auditId: input.auditId,
      baseRevision: input.baseRevision,
      at: obsAt,
      verdict: 'confirmed',
      reason: finding.reason,
      evidence: finding.evidence,
    };

    const newPatches: Record<string, string> = {};
    let meta: ReviewFrontmatter;
    let expectedReview: string | undefined;

    if (!existing) {
      const routing = resolveOwner(input.reviewers, { paths: mergedTargets, tags: normalizedTags });
      if (!routing.owner) {
        throw new Error(`无法为新问题 ${finding.findingId} 路由 owner，请检查 reviewers.yml default_owner`);
      }

      const patches: PatchEntry[] = [];
      const options: RepairOption[] = [];
      const decisionMap = new Map<string, HumanDecision>();
      const usedOptionIds = new Set<string>();

      for (const proposal of finding.proposals) {
        if (!OPTION_ID_PATTERN.test(proposal.optionId)) {
          throw new Error(`方案 option_id 格式非法：${proposal.optionId}`);
        }
        if (usedOptionIds.has(proposal.optionId)) {
          throw new Error(`同一问题包含重复 option_id：${proposal.optionId}`);
        }
        usedOptionIds.add(proposal.optionId);
        const patchId = patches.length + 1;
        const patchName = formatPatchFilename(patchId);
        newPatches[patchName] = proposal.patchText;
        patches.push({
          id: patchId,
          patch: patchName,
          optionId: proposal.optionId,
          baseRevision: input.baseRevision,
          author: 'ai',
          sha256: sha256Hex(proposal.patchBytes),
        });
        options.push({
          id: proposal.optionId,
          title: proposal.title,
          tradeoff: proposal.tradeoff,
          confidence: proposal.confidence,
          currentPatch: patchId,
          gateChecks: [...proposal.gateChecks],
        });
        for (const d of proposal.humanDecisions) decisionMap.set(d.id, d);
      }

      meta = {
        schemaVersion: 1,
        findingId: finding.findingId,
        title: fullTitle,
        module: moduleName,
        auditType: finding.auditType,
        issueKind: finding.issueKind,
        dependsOn: finding.issueKind === 'deferred' ? finding.dependsOn : null,
        priority: finding.priority,
        baseRevision: input.baseRevision,
        createdAt: auditCreatedAt,
        updatedAt: obsAt,
        owner: routing.owner,
        tags: normalizedTags,
        ticket: null,
        status: 'pending',
        targetFiles: mergedTargets,
        recordRevision: 1,
        patches,
        options,
        observations: [observation],
        decisions: [],
        repairAttempts: [],
        comments: [],
        humanDecisions: [...decisionMap.values()],
        approval: null,
        approvalHistory: [],
        rejection: null,
        commitMessage: buildCommitMessage(fullTitle, finding.reason, finding.issueKind),
      };
    } else {
      expectedReview = await readFile(path.join(repoRoot, '.ai-review', existing.id, 'review.md'), 'utf8');
      const prev = existing.meta;
      const isReopeningClosed = prev.status === 'approved' || prev.status === 'resolved';
      const nextApprovalHistory = isReopeningClosed && prev.approval
        ? [...prev.approvalHistory, prev.approval]
        : [...prev.approvalHistory];
      // SPEC §4.1：重开 approved/resolved 时清空原 options[]，原 option_id 退役不得复用！
      const baseOptions: RepairOption[] = isReopeningClosed ? [] : prev.options.map((o) => ({ ...o, gateChecks: [...o.gateChecks] }));
      const retired = new Set<string>([
        ...retiredOptionIds(prev),
        ...(isReopeningClosed ? prev.options.map((o) => o.id) : []),
        ...nextApprovalHistory.map((h) => h.optionId),
      ]);

      const patches: PatchEntry[] = [...prev.patches];
      const options: RepairOption[] = [...baseOptions];
      const decisionMap = new Map<string, HumanDecision>(prev.humanDecisions.map((d) => [d.id, d]));

      for (const proposal of finding.proposals) {
        if (!OPTION_ID_PATTERN.test(proposal.optionId)) {
          throw new Error(`方案 option_id 格式非法：${proposal.optionId}`);
        }
        if (retired.has(proposal.optionId)) {
          throw new Error(`方案 option_id（${proposal.optionId}）已退役，不得复用`);
        }
        const existingOptIndex = options.findIndex((o) => o.id === proposal.optionId);
        if (existingOptIndex < 0 && options.length >= 2) {
          throw new Error(`问题 ${finding.findingId} 已达 2 个有效方案上限，无法新增方案 ${proposal.optionId}`);
        }
        const patchId = patches.length + 1;
        const patchName = formatPatchFilename(patchId);
        newPatches[patchName] = proposal.patchText;
        patches.push({
          id: patchId,
          patch: patchName,
          optionId: proposal.optionId,
          baseRevision: input.baseRevision,
          author: 'ai',
          sha256: sha256Hex(proposal.patchBytes),
        });
        const nextOpt: RepairOption = {
          id: proposal.optionId,
          title: proposal.title,
          tradeoff: proposal.tradeoff,
          confidence: proposal.confidence,
          currentPatch: patchId,
          gateChecks: [...proposal.gateChecks],
        };
        if (existingOptIndex >= 0) options[existingOptIndex] = nextOpt;
        else options.push(nextOpt);
        for (const d of proposal.humanDecisions) decisionMap.set(d.id, d);
      }

      // 保持人工处置状态不被常规观察静默覆盖（仅已关闭重开或 awaiting_verification 回到 human_takeover）。
      let nextStatus: ReviewStatus = prev.status;
      let nextRejection = prev.rejection;
      if (isReopeningClosed) {
        nextStatus = 'pending';
        nextRejection = null;
      } else if (prev.status === 'awaiting_verification') {
        nextStatus = 'human_takeover';
      }

      const nextIssueKind: IssueKind = options.length > 0 ? 'repair' : finding.issueKind;
      const nextCommitMsg = options.length > 0
        ? (prev.commitMessage && prev.commitMessage.split('\n')[0]?.trim() === fullTitle
          ? prev.commitMessage
          : buildCommitMessage(fullTitle, finding.reason, 'repair'))
        : null;

      meta = {
        ...prev,
        title: fullTitle,
        module: moduleName,
        auditType: finding.auditType,
        issueKind: nextIssueKind,
        dependsOn: nextIssueKind === 'deferred' ? finding.dependsOn : null,
        priority: finding.priority,
        baseRevision: input.baseRevision,
        updatedAt: obsAt,
        // 保留已有共享 owner，不因路由规则变化而改写
        owner: prev.owner,
        tags: normalizedTags,
        status: nextStatus,
        targetFiles: mergedTargets,
        recordRevision: prev.recordRevision + 1,
        patches,
        options: nextIssueKind === 'repair' ? options : [],
        observations: [...prev.observations, observation],
        humanDecisions: [...decisionMap.values()],
        approval: isReopeningClosed ? null : prev.approval,
        approvalHistory: nextApprovalHistory,
        rejection: nextRejection,
        commitMessage: nextCommitMsg,
      };
    }

    const body = renderIssueBody({
      finding,
      options: meta.options,
      patches: meta.patches,
      recordRevision: meta.recordRevision,
      auditId: input.auditId,
      baseRevision: input.baseRevision,
      ...(existing ? { existingBody: existing.body } : {}),
    });

    const quickErrors = quickReviewInvariants({ id: dirId, month: dirMonth, slug: dirSlug, meta });
    if (quickErrors.length > 0) {
      throw new Error(`发布问题 ${finding.findingId} 不变量失败：${quickErrors.join('；')}`);
    }

    const reviewText = serializeReviewMarkdown(meta, body);
    // 往返解析自检，确保落盘即合法
    parseReviewMarkdown(reviewText);

    candidates.push({
      id: dirId,
      title: meta.title,
      patch: '',
      review: reviewText,
      ...(expectedReview !== undefined ? { expectedReview } : {}),
      patches: newPatches,
    });
    publishedIssueIds.push(dirId);
    overview.push({
      id: dirId,
      findingId: meta.findingId,
      priority: meta.priority,
      issueKind: meta.issueKind,
      title: meta.title,
    });
  }

  // 处理外部人工完成项（awaiting_verification）的独立复核结论（I20）
  for (const reviewed of input.reviewedExternal) {
    if (seenFindingIds.has(reviewed.findingId)) continue;
    const existing = input.existingByFindingId.get(reviewed.findingId);
    if (!existing || existing.meta.status !== 'awaiting_verification') continue;
    if ((reviewed.verdict === 'resolved' || reviewed.verdict === 'confirmed') && reviewed.evidence.length === 0) {
      throw new Error(`外部复核 ${reviewed.findingId} 给出确定结论时必须提供真实代码证据`);
    }
    const expectedReview = await readFile(path.join(repoRoot, '.ai-review', existing.id, 'review.md'), 'utf8');
    const obsAt = nextUpdatedAt(existing.meta.updatedAt, now);
    const mergedTargets = [...new Set([...existing.meta.targetFiles, ...reviewed.evidence.map((e) => e.path)])];
    const nextStatus: ReviewStatus = reviewed.verdict === 'resolved'
      ? 'resolved'
      : reviewed.verdict === 'confirmed'
        ? 'human_takeover'
        : 'awaiting_verification';

    const nextMeta: ReviewFrontmatter = {
      ...existing.meta,
      baseRevision: input.baseRevision,
      updatedAt: obsAt,
      status: nextStatus,
      targetFiles: mergedTargets,
      recordRevision: existing.meta.recordRevision + 1,
      observations: [
        ...existing.meta.observations,
        {
          auditId: input.auditId,
          baseRevision: input.baseRevision,
          at: obsAt,
          verdict: reviewed.verdict,
          reason: reviewed.reason,
          evidence: reviewed.evidence,
        },
      ],
    };
    const nextBody = `${existing.body.trimEnd()}\n\n## 记录版本 ${String(nextMeta.recordRevision)}\n- 外部完成项复核（审查 \`${input.auditId}\`）：结论 \`${reviewed.verdict}\`，状态置为 \`${nextStatus}\` — ${reviewed.reason}\n`;
    const reviewText = serializeReviewMarkdown(nextMeta, nextBody);
    parseReviewMarkdown(reviewText);

    candidates.push({
      id: existing.id,
      title: nextMeta.title,
      patch: '',
      review: reviewText,
      expectedReview,
      patches: {},
    });
    publishedIssueIds.push(existing.id);
    overview.push({
      id: existing.id,
      findingId: nextMeta.findingId,
      priority: nextMeta.priority,
      issueKind: nextMeta.issueKind,
      title: nextMeta.title,
    });
  }

  overview.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.findingId.localeCompare(b.findingId));

  const auditMeta: AuditFrontmatter = {
    schemaVersion: 1,
    auditId: input.auditId,
    createdAt: auditCreatedAt,
    baseRevision: input.baseRevision,
    scope: input.scope || '.',
    trigger: input.trigger,
    previousAudit: input.previousAudit,
    issues: publishedIssueIds,
  };

  const reportBody = [
    '# 仓库审查报告',
    '',
    '## 审查目标与范围',
    `- 目标目录：\`${auditMeta.scope}\``,
    `- 起始基线：\`${auditMeta.baseRevision}\``,
    `- 触发方式：${auditMeta.trigger === 'scheduled' ? '定时审查（scheduled）' : '手动审查（manual）'}`,
    '',
    '## 优先级总览',
    ...(overview.length === 0
      ? ['- 无']
      : overview.map((item) => `- **[${item.priority}]** \`${item.id}\`（${item.issueKind}）— \`${item.title}\``)),
    '',
    '## 历史问题复查',
    ...(input.historyLines.length === 0 ? ['- 无适用历史复查说明。'] : input.historyLines.map((l) => `- ${l}`)),
    '',
    '## 覆盖说明与未覆盖风险',
    ...(input.coverageLines.length === 0 ? ['- 本轮已完成目标范围覆盖。'] : input.coverageLines.map((l) => `- ${l}`)),
    ...(input.requirementLines.length > 0 ? ['', '## 额外要求核对', ...input.requirementLines.map((l) => `- ${l}`)] : []),
  ].join('\n');

  const reportPath = `.ai-review/audits/${input.auditId}/audit.md`;
  const reportText = serializeAuditMarkdown(auditMeta, reportBody);

  return { auditMeta, reportPath, reportText, candidates, overview };
}
