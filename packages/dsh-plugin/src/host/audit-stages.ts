/**
 * 分阶段审查状态机（scan → verify → patch → publish）：
 * - D02：patch 阶段派发注入既有问题身份/optionIds/currentPatches/guard，并在登记前校验 optionId（畸形输出不占死 2 方案名额）；
 * - D04：彻底移除 allowed_gate_commands 白名单拦截；
 * - D11：支持外部专业执行器优先 + 本 Harness 独立子代理（dsh-subagent）优雅降级；
 * - I18：每个子阶段交接前强制还原所有非 .ai-review/ 业务改动并清空 .tmp/。
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { auditFiles } from './audit-files.js';
import { AuditArchive, scopeCovers, type AuditTrigger } from './audit-archive.js';
import { loadAuditHistory, queryAuditHistoryItems, type AuditHistorySnapshot } from './audit-history.js';
import { renderAuditTemplate, type AuditStage } from './audit-prompts.js';
import {
  compatibleAuditBase,
  createArtifactDirectory,
  oneLine,
  publishStageArtifacts,
  validSourcePath,
  withinScope,
  type StageSeal,
} from './audit-stage-artifacts.js';
import {
  executeAuditCli,
  normalizeExecutorName,
  probeStageExecutors,
  type AuditExecutor,
  type ExecuteAuditStage,
} from './audit-stage-runner.js';
import { AUDIT_TYPES, ISSUE_KINDS, REVIEW_PRIORITIES } from './frontmatter.js';
import { FINDING_ID_PATTERN, OPTION_ID_PATTERN } from './invariants.js';
import { retiredOptionIds } from './issue-review.js';
import { buildIssuePublication, type PublishedFindingInput, type PublishedPatchProposal, type ReviewedExternalFindingInput } from './issue-publication.js';
import { isAiReviewPath, parsePatch } from './patch.js';
import { loadReviewers, type ReviewersConfig } from './reviewers.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { ReviewStore } from './store.js';
import type { VcsAdapter } from './vcs.js';
import type { AuditType, HumanDecision, IssueEvidence, IssueKind, ReviewPriority } from './types.js';

interface LeadRecord {
  leadId: string;
  entry: string;
  path: string;
  line: number;
  precondition: string;
  expected: string;
  impact: string;
}

interface VerifiedLead {
  subjectId: string;
  verdict: 'confirmed' | 'refuted' | 'insufficient_evidence';
  reason: string;
  evidence: IssueEvidence[];
  executor: AuditExecutor;
}

interface RegisteredProposal {
  subjectId: string;
  findingId?: string;
  proposal: PublishedPatchProposal;
}

export interface AuditStageSessionOptions {
  auditId: string;
  root: string;
  scope: string;
  baseRevision: string;
  svnUrl?: string;
  trigger: AuditTrigger;
  owner: string;
  note: string;
  deadlineAt: string;
  vcs: VcsAdapter;
  store: ReviewStore;
  source?: SharedCandidateSource;
  stageExecutors: readonly string[];
  dshCommand?: string;
  executor?: ExecuteAuditStage;
  onLog?: (line: string) => void;
  onSeal?: (manifest: StageSeal, issueIds: string[]) => Promise<void>;
  onStageStateChange?: (active: boolean) => Promise<void>;
}

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          entry: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'integer' },
          precondition: { type: 'string' },
          expected: { type: 'string' },
          impact: { type: 'string' },
        },
        required: ['leadId', 'entry', 'path', 'line', 'precondition', 'expected', 'impact'],
      },
    },
    coverage: { type: 'array', items: { type: 'string' } },
    limits: { type: 'array', items: { type: 'string' } },
  },
  required: ['leads', 'coverage', 'limits'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'insufficient_evidence'] },
    reason: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          excerpt: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'line', 'excerpt', 'reason'],
      },
    },
  },
  required: ['verdict', 'reason', 'evidence'],
};

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'blocked'] },
    optionId: { type: 'string' },
    title: { type: 'string' },
    patchPath: { type: 'string' },
    summary: { type: 'string' },
    tradeoff: { type: 'string' },
    confidence: { type: 'integer' },
    humanDecisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'question'],
      },
    },
    reason: { type: 'string' },
  },
  required: ['status', 'optionId', 'patchPath', 'summary', 'tradeoff', 'confidence', 'humanDecisions', 'reason'],
};

function asObj(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function asStrArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}

export class AuditStageSession {
  private readonly leads = new Map<string, LeadRecord>();
  private readonly verified = new Map<string, VerifiedLead>();
  private readonly proposalsBySubject = new Map<string, RegisteredProposal[]>();
  private scanCount = 0;
  private taskSeq = 0;
  private published = false;
  private historyCache: AuditHistorySnapshot | undefined;
  private reviewersCache: ReviewersConfig | undefined;

  constructor(private readonly options: AuditStageSessionOptions) {}

  private async getHistory(): Promise<AuditHistorySnapshot> {
    if (!this.historyCache) {
      this.historyCache = await loadAuditHistory(this.options.store, this.options.source, this.options.scope);
    }
    return this.historyCache;
  }

  private async getReviewers(): Promise<ReviewersConfig> {
    if (!this.reviewersCache) {
      this.reviewersCache = await loadReviewers(this.options.root, this.options.source);
    }
    return this.reviewersCache;
  }

  async buildOrchestratorPrompt(executionMode: 'session' | 'headless' | 'manual'): Promise<string> {
    const [reviewers, history] = await Promise.all([this.getReviewers(), this.getHistory()]);
    const probe = probeStageExecutors(this.options.stageExecutors, this.options.dshCommand);
    const reportPath = `.ai-review/audits/${this.options.auditId}/audit.md`;
    const extraRequirements = this.options.note.trim()
      ? this.options.note.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    return renderAuditTemplate('orchestrator', {
      auditId: this.options.auditId,
      baseRevision: this.options.baseRevision,
      scope: this.options.scope || '.',
      vcsType: this.options.vcs.type,
      deadlineAt: this.options.deadlineAt,
      reportPath,
      executionMode,
      availableRunners: probe.availableRunners,
      ownerRouting: {
        defaultOwner: reviewers.defaultOwner,
        ruleCount: reviewers.rules.length,
        automaticCandidates: true,
      },
      history: {
        openCount: history.activeForOrchestrator.length,
        awaitingVerification: history.awaitingVerification.map((i) => ({ id: i.id, findingId: i.findingId, title: i.title })),
        dueDeferred: history.dueDeferred.map((i) => ({ id: i.id, findingId: i.findingId, title: i.title })),
        acceptedAsIs: history.acceptedAsIs.map((i) => ({ id: i.id, findingId: i.findingId, title: i.title, reason: i.decision?.reason ?? '' })),
      },
      focus: this.options.note.trim() ? [this.options.note.trim()] : ['正确性', '安全性', '稳定性', '可测试性', '性能', '精简'],
      extraRequirements,
    });
  }

  async queryHistory(disposition?: string): Promise<unknown> {
    return queryAuditHistoryItems(this.options.store, this.options.source, this.options.scope, disposition);
  }

  /** 在当前基线上独立核验代码证据（路径、行号与精确原文子串）。 */
  private async verifyEvidenceList(rawList: unknown): Promise<{ valid: IssueEvidence[]; errors: string[] }> {
    if (!Array.isArray(rawList)) return { valid: [], errors: ['evidence 必须是数组'] };
    const valid: IssueEvidence[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rawList.length; i += 1) {
      const item = rawList[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`evidence[${String(i)}] 必须是对象`);
        continue;
      }
      const rec = item as Record<string, unknown>;
      const file = typeof rec['path'] === 'string' ? rec['path'].trim().replaceAll('\\', '/').replace(/^\.\//, '') : '';
      const line = typeof rec['line'] === 'number' && Number.isInteger(rec['line']) ? rec['line'] : 0;
      const excerpt = typeof rec['excerpt'] === 'string' ? rec['excerpt'].trim() : '';
      const reason = typeof rec['reason'] === 'string' ? rec['reason'].trim() : '';

      if (!file || !validSourcePath(file)) {
        errors.push(`evidence[${String(i)}].path 非法：${file}`);
        continue;
      }
      if (line < 1 || !excerpt || !reason) {
        errors.push(`evidence[${String(i)}] 缺少合法 line / excerpt / reason`);
        continue;
      }
      const content = await this.options.vcs.readFileAt(this.options.baseRevision, file).catch(() => null);
      if (content === null) {
        errors.push(`evidence[${String(i)}] 在基线 ${this.options.baseRevision} 下不存在：${file}`);
        continue;
      }
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      const actualLine = lines[line - 1];
      if (actualLine === undefined || !actualLine.includes(excerpt)) {
        errors.push(`evidence[${String(i)}] 行号 ${file}:${String(line)} 未包含声明原文 "${excerpt.slice(0, 60)}"`);
        continue;
      }
      valid.push({ path: file, line, excerpt, reason });
    }

    return { valid, errors };
  }

  /** I18 / §5.6：子阶段交接前强制还原所有非 .ai-review/ 改动并清空 .tmp/。 */
  private async cleanupAfterSubStage(): Promise<void> {
    await this.options.vcs.revertBusinessWorkspace().catch(() => undefined);
    await rm(path.join(this.options.root, '.tmp'), { recursive: true, force: true }).catch(() => undefined);
  }

  async runStage(
    stage: AuditStage,
    requestedRunner: AuditExecutor,
    rawTask: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.published) throw new Error('本轮审查已发布，不能继续派发阶段任务');
    if (!(await compatibleAuditBase(this.options.vcs, this.options.baseRevision, this.options.svnUrl))) {
      throw new Error('审查基线已漂移，拒绝继续执行阶段任务');
    }

    const task = asObj(rawTask, 'task');
    const runner = normalizeExecutorName(requestedRunner);
    const taskId = `${stage}-${String(++this.taskSeq)}`;
    const remainingMs = Math.max(10_000, Date.parse(this.options.deadlineAt) - Date.now());
    const execute = this.options.executor ?? executeAuditCli;

    const runWithHandoffCleanup = async (
      prompt: string,
      schema: Record<string, unknown>,
      artifactDir?: string,
    ) => {
      await this.options.onStageStateChange?.(true);
      try {
        return await execute({
          stage,
          runner,
          cwd: this.options.root,
          ...(artifactDir ? { artifactDir } : {}),
          prompt,
          schema,
          timeoutMs: Math.min(remainingMs, 30 * 60_000),
          signal,
          ...(this.options.dshCommand ? { dshCommand: this.options.dshCommand } : {}),
          ...(this.options.onLog ? { onLog: this.options.onLog } : {}),
        });
      } finally {
        await this.cleanupAfterSubStage();
        await this.options.onStageStateChange?.(false);
      }
    };

    if (stage === 'scan') {
      const taskScope = asStrArray(task['taskScope'] ?? [this.options.scope || '.'], 'taskScope');
      for (const p of taskScope) {
        if (p !== '.' && (!validSourcePath(p) || !withinScope(this.options.scope, p))) {
          throw new Error(`scan.taskScope 超出本轮范围或路径非法：${p}`);
        }
      }
      const prompt = await renderAuditTemplate('scan', {
        auditId: this.options.auditId,
        baseRevision: this.options.baseRevision,
        scope: this.options.scope || '.',
        vcsType: this.options.vcs.type,
        taskId,
        taskScope,
        scenarios: asStrArray(task['scenarios'] ?? [], 'scenarios'),
        questions: asStrArray(task['questions'] ?? [], 'questions'),
        constraints: asStrArray(task['constraints'] ?? [], 'constraints'),
      });

      const outcome = await runWithHandoffCleanup(prompt, SCAN_SCHEMA);
      if (!outcome.ok) return { ok: false, stage, taskId, reason: outcome.reason, diagnostic: outcome.diagnostic };

      const data = asObj(outcome.output, 'scan.output');
      const rawLeads = Array.isArray(data['leads']) ? data['leads'] : [];
      const registered: LeadRecord[] = [];
      for (const item of rawLeads) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const r = item as Record<string, unknown>;
        const leadId = typeof r['leadId'] === 'string' ? r['leadId'].trim() : '';
        const file = typeof r['path'] === 'string' ? r['path'].trim().replaceAll('\\', '/') : '';
        const line = typeof r['line'] === 'number' && Number.isInteger(r['line']) ? r['line'] : 0;
        if (!leadId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(leadId) || !validSourcePath(file) || line < 1) continue;
        const lead: LeadRecord = {
          leadId,
          entry: oneLine(String(r['entry'] ?? '')),
          path: file,
          line,
          precondition: oneLine(String(r['precondition'] ?? '')),
          expected: oneLine(String(r['expected'] ?? '')),
          impact: oneLine(String(r['impact'] ?? '')),
        };
        this.leads.set(leadId, lead);
        registered.push(lead);
      }
      this.scanCount += 1;
      return {
        ok: true,
        stage,
        taskId,
        executorUsed: outcome.executorUsed ?? runner,
        ...(outcome.degradedFrom ? { degradedFrom: outcome.degradedFrom } : {}),
        leads: registered,
        coverage: Array.isArray(data['coverage']) ? data['coverage'] : [],
        limits: Array.isArray(data['limits']) ? data['limits'] : [],
      };
    }

    if (stage === 'verify') {
      const subjectId = typeof task['subjectId'] === 'string' ? task['subjectId'].trim() : '';
      const lead = this.leads.get(subjectId);
      if (!lead) throw new Error(`verify.subjectId 未在初审阶段登记：${subjectId}`);

      const scenario = typeof task['scenario'] === 'string' ? task['scenario'].trim() : 'reachable_behavior';
      const navigation = task['navigation'] ?? { path: lead.path, line: lead.line };
      const extraReqs = this.options.note.trim()
        ? this.options.note.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        : [];
      const indexes = Array.isArray(task['expectationIndexes'])
        ? (task['expectationIndexes'] as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < extraReqs.length)
        : [];
      const expectedBehavior = [
        `请针对场景 ${scenario} 独立核查：在 ${lead.path}:${String(lead.line)} 附近是否存在可触发的缺陷或冗余行为。`,
        ...indexes.map((i) => `额外业务约束：${extraReqs[i]!}`),
      ];

      const prompt = await renderAuditTemplate('verify', {
        auditId: this.options.auditId,
        baseRevision: this.options.baseRevision,
        scope: this.options.scope || '.',
        vcsType: this.options.vcs.type,
        taskId,
        subjectId,
        question: `核查 ${lead.path}:${String(lead.line)}（场景：${scenario}）是否成立，以及实际触发前提与后果。`,
        navigation,
        expectedBehavior,
      });

      const outcome = await runWithHandoffCleanup(prompt, VERIFY_SCHEMA);
      if (!outcome.ok) return { ok: false, stage, taskId, reason: outcome.reason, diagnostic: outcome.diagnostic };

      const data = asObj(outcome.output, 'verify.output');
      const rawVerdict = data['verdict'];
      if (rawVerdict !== 'confirmed' && rawVerdict !== 'refuted' && rawVerdict !== 'insufficient_evidence') {
        return { ok: false, stage, taskId, reason: 'invalid_output', diagnostic: 'verify verdict 非法' };
      }
      const reason = oneLine(String(data['reason'] ?? ''));
      const checked = await this.verifyEvidenceList(data['evidence']);

      // 证据门控：confirmed 必须具备经 Host 在固定基线核验通过的真实证据且落在 scope 内
      let finalVerdict: VerifiedLead['verdict'] = rawVerdict;
      if (rawVerdict === 'confirmed') {
        if (checked.valid.length === 0 || !scopeCovers(this.options.scope, checked.valid.map((e) => e.path))) {
          finalVerdict = 'insufficient_evidence';
        }
      }

      const record: VerifiedLead = {
        subjectId,
        verdict: finalVerdict,
        reason: checked.errors.length > 0 ? `${reason}（证据校验提示：${checked.errors.join('；')}）` : reason,
        evidence: checked.valid,
        executor: outcome.executorUsed ?? runner,
      };
      this.verified.set(subjectId, record);

      return {
        ok: true,
        stage,
        taskId,
        subjectId,
        verdict: record.verdict,
        reason: record.reason,
        evidence: record.evidence,
        evidenceErrors: checked.errors,
        executorUsed: outcome.executorUsed ?? runner,
        ...(outcome.degradedFrom ? { degradedFrom: outcome.degradedFrom } : {}),
      };
    }

    // stage === 'patch'（D02 + D04）
    const subjectId = typeof task['subjectId'] === 'string' ? task['subjectId'].trim() : '';
    const verified = this.verified.get(subjectId);
    if (!verified || verified.verdict !== 'confirmed') {
      throw new Error(`patch.subjectId 必须先经独立复核确认（confirmed）：${subjectId}`);
    }

    const auditType = typeof task['auditType'] === 'string' ? (task['auditType'].trim() as AuditType) : 'bugfix';
    if (!AUDIT_TYPES.includes(auditType)) throw new Error(`patch.auditType 非法：${auditType}`);

    const allowedPaths = asStrArray(task['allowedPaths'], 'allowedPaths');
    if (allowedPaths.length === 0 || allowedPaths.some((p) => !validSourcePath(p) || !withinScope(this.options.scope, p))) {
      throw new Error('patch.allowedPaths 必须是非空且位于审查范围内的合法业务路径');
    }

    // D04：不再做 allowedGateCommands 白名单拦截，仅要求非空命令列表。
    const gateCommands = asStrArray(task['gateCommands'], 'gateCommands');
    if (gateCommands.length === 0) {
      throw new Error('patch.gateCommands 必须至少包含一条非空门禁命令');
    }

    const acceptance = asStrArray(task['acceptance'] ?? [], 'acceptance');
    const requestedFindingId = typeof task['findingId'] === 'string' && task['findingId'].trim()
      ? task['findingId'].trim()
      : undefined;
    if (requestedFindingId && !FINDING_ID_PATTERN.test(requestedFindingId)) {
      throw new Error(`patch.findingId 格式非法：${requestedFindingId}`);
    }

    // D02：查询既有问题并把 findingId / optionIds / currentPatches / retiredOptionIds / guard 注入派发上下文！
    const history = await this.getHistory();
    const existing = requestedFindingId ? history.byFindingId.get(requestedFindingId) : undefined;
    const retiredSet = existing
      ? new Set<string>([
        ...retiredOptionIds(existing.meta),
        ...((existing.meta.status === 'approved' || existing.meta.status === 'resolved')
          ? existing.meta.options.map((o) => o.id)
          : []),
        ...existing.meta.approvalHistory.map((h) => h.optionId),
      ])
      : new Set<string>();

    const existingProposals = this.proposalsBySubject.get(subjectId) ?? [];
    if (existingProposals.length >= 2) {
      throw new Error(`问题 ${subjectId} 本轮已登记 2 个有效补丁方案，已达上限`);
    }

    const artifactRel = `.ai-review/audits/${this.options.auditId}/stage-${taskId}`;
    const artifactAbs = await createArtifactDirectory(this.options.root, artifactRel);
    const reviewers = await this.getReviewers();

    const prompt = await renderAuditTemplate('patch', {
      auditId: this.options.auditId,
      baseRevision: this.options.baseRevision,
      scope: this.options.scope || '.',
      vcsType: this.options.vcs.type,
      taskId,
      subjectId,
      confirmedFact: verified.reason,
      evidence: verified.evidence,
      auditType,
      allowedPaths,
      acceptance,
      gateCommands,
      ownerRouting: { defaultOwner: reviewers.defaultOwner },
      candidate: {
        artifactDir: artifactAbs,
        artifactRelDir: artifactRel,
        ...(typeof task['approach'] === 'string' && task['approach'].trim() ? { approach: task['approach'].trim() } : {}),
        ...(typeof task['optionId'] === 'string' && task['optionId'].trim() ? { suggestedOptionId: task['optionId'].trim() } : {}),
      },
      existingIssue: existing
        ? {
          id: existing.id,
          findingId: existing.meta.findingId,
          status: existing.meta.status,
          guard: {
            expectedRevision: existing.meta.recordRevision,
            expectedOwner: existing.meta.owner,
            expectedUpdatedAt: existing.meta.updatedAt,
          },
          optionIds: existing.meta.options.map((o) => o.id),
          currentPatches: Object.fromEntries(existing.meta.options.map((o) => [o.id, o.currentPatch])),
          retiredOptionIds: [...retiredSet],
        }
        : null,
    });

    const outcome = await runWithHandoffCleanup(prompt, PATCH_SCHEMA, artifactAbs);
    if (!outcome.ok) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, stage, taskId, reason: outcome.reason, diagnostic: outcome.diagnostic };
    }

    const data = asObj(outcome.output, 'patch.output');
    if (data['status'] === 'blocked') {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: true,
        stage,
        taskId,
        status: 'blocked',
        reason: oneLine(String(data['reason'] ?? '无法生成安全补丁')),
        tradeoff: oneLine(String(data['tradeoff'] ?? '')),
        executorUsed: outcome.executorUsed ?? runner,
      };
    }

    // D02：登记前即强校验 optionId、归属与 2 方案名额上限；畸形产物直接拒绝且不占死名额！
    const optionId = typeof data['optionId'] === 'string' ? data['optionId'].trim() : '';
    if (!optionId || !OPTION_ID_PATTERN.test(optionId)) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        stage,
        taskId,
        reason: 'invalid_output',
        diagnostic: `patch 返回的 optionId 缺失或格式非法（须匹配 ^[a-z0-9][a-z0-9-]{0,63}$）：${optionId || '(空)'}；未占用方案名额，可修正重交`,
      };
    }
    if (retiredSet.has(optionId)) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        stage,
        taskId,
        reason: 'invalid_output',
        diagnostic: `optionId（${optionId}）已在该问题的历史周期中退役，不得复用；未占用方案名额，请换用新 optionId 重交`,
      };
    }
    if (existingProposals.some((p) => p.proposal.optionId === optionId)) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        stage,
        taskId,
        reason: 'invalid_output',
        diagnostic: `同轮已登记过 optionId=${optionId} 的方案，互斥备选须使用不同 optionId；未占用额外名额`,
      };
    }
    if (existing && !(existing.meta.status === 'approved' || existing.meta.status === 'resolved')) {
      const mergedOptionIds = new Set([...existing.meta.options.map((o) => o.id), ...existingProposals.map((p) => p.proposal.optionId), optionId]);
      if (mergedOptionIds.size > 2) {
        await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
        return {
          ok: false,
          stage,
          taskId,
          reason: 'invalid_output',
          diagnostic: `跨轮更新问题 ${existing.meta.findingId} 时，已有方案与新增方案总数超过 2 个上限（当前已有：${existing.meta.options.map((o) => o.id).join(', ')}）`,
        };
      }
    }

    const patchPathRel = typeof data['patchPath'] === 'string' ? data['patchPath'].trim().replaceAll('\\', '/') : '';
    const patchAbs = path.resolve(this.options.root, patchPathRel);
    if (!patchPathRel || !patchAbs.startsWith(path.resolve(artifactAbs) + path.sep)) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, stage, taskId, reason: 'invalid_output', diagnostic: `patchPath 必须位于本阶段产物目录内：${patchPathRel}` };
    }

    const patchRead = await auditFiles(this.options.root, { op: 'read', paths: [patchPathRel] }).catch(() => null);
    const patchBytes = patchRead?.bytes ?? null;
    if (!patchBytes || patchBytes.length === 0) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, stage, taskId, reason: 'invalid_output', diagnostic: '补丁文件不存在或为空' };
    }
    const patchText = patchBytes.toString('utf8');
    const parsedPatch = parsePatch(patchText);
    if (parsedPatch.unsafeModes.length > 0) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        stage,
        taskId,
        reason: 'invalid_output',
        diagnostic: `补丁包含禁止的文件模式（${parsedPatch.unsafeModes.join(', ')}），禁止符号链接或子模块变更`,
      };
    }
    const allowedSet = new Set(allowedPaths);
    if (
      parsedPatch.paths.length === 0
      || parsedPatch.paths.some((p) => !validSourcePath(p) || isAiReviewPath(p) || !allowedSet.has(p))
    ) {
      await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, stage, taskId, reason: 'invalid_output', diagnostic: '补丁触及了允许范围之外或禁止路径' };
    }

    // I18：仅做不改写业务文件的只读应用预检，严禁应用补丁或跑修复门禁！
    const precheck = await this.options.vcs.checkPatch(patchAbs);
    await rm(artifactAbs, { recursive: true, force: true }).catch(() => undefined);
    if (!precheck.ok) {
      return {
        ok: false,
        stage,
        taskId,
        reason: 'invalid_output',
        diagnostic: `补丁在基线 ${this.options.baseRevision} 只读应用预检失败：${precheck.message}；未占用名额，可修正重交`,
      };
    }

    const rawConf = typeof data['confidence'] === 'number' && Number.isFinite(data['confidence']) ? data['confidence'] : 80;
    const confidence = rawConf > 1 ? Math.max(0, Math.min(1, rawConf / 100)) : Math.max(0, Math.min(1, rawConf));
    const humanDecisions: HumanDecision[] = Array.isArray(data['humanDecisions'])
      ? (data['humanDecisions'] as unknown[])
        .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === 'object' && !Array.isArray(d)))
        .map((d, idx) => ({
          id: typeof d['id'] === 'string' && d['id'].trim() ? d['id'].trim() : `h${String(idx + 1)}`,
          question: oneLine(String(d['question'] ?? '')),
          ...(typeof d['note'] === 'string' && d['note'].trim() ? { note: oneLine(d['note']) } : {}),
        }))
        .filter((d) => d.question.length > 0)
      : [];

    const proposal: PublishedPatchProposal = {
      optionId,
      title: oneLine(String(data['title'] ?? data['summary'] ?? optionId)) || optionId,
      tradeoff: oneLine(String(data['tradeoff'] ?? data['reason'] ?? '见方案说明')) || '见方案说明',
      confidence,
      auditType,
      gateChecks: gateCommands,
      humanDecisions,
      patchText,
      patchBytes,
      summary: oneLine(String(data['summary'] ?? '')),
    };

    const list = this.proposalsBySubject.get(subjectId) ?? [];
    list.push({ subjectId, ...(requestedFindingId ? { findingId: requestedFindingId } : {}), proposal });
    this.proposalsBySubject.set(subjectId, list);

    return {
      ok: true,
      stage,
      taskId,
      status: 'ready',
      optionId,
      registeredCount: list.length,
      patchStats: parsedPatch.stats,
      executorUsed: outcome.executorUsed ?? runner,
      ...(outcome.degradedFrom ? { degradedFrom: outcome.degradedFrom } : {}),
    };
  }

  async publish(rawPublication: unknown, _signal: AbortSignal): Promise<unknown> {
    if (this.published) throw new Error('本轮审查已发布，不能重复发布');
    if (this.scanCount === 0) throw new Error('发布前至少需要完成一次初审（scan）');

    const pub = asObj(rawPublication, 'publication');
    const rawFindings = Array.isArray(pub['findings']) ? pub['findings'] : [];
    const coverageLines = asStrArray(pub['coverage'] ?? [], 'coverage');
    const requirementLines = asStrArray(pub['requirements'] ?? [], 'requirements');
    const historyLines = asStrArray(pub['history'] ?? [], 'history');

    const [history, reviewers] = await Promise.all([this.getHistory(), this.getReviewers()]);
    const existingDirIds = new Set(await this.options.store.listCandidateIds(this.options.source));
    const findings: PublishedFindingInput[] = [];

    for (const rawItem of rawFindings) {
      const item = asObj(rawItem, 'findings[]');
      const subjectId = typeof item['subjectId'] === 'string' ? item['subjectId'].trim() : '';
      const verified = this.verified.get(subjectId);
      if (!verified || verified.verdict !== 'confirmed') {
        throw new Error(`发布发现 ${subjectId} 未通过独立复核 confirmed`);
      }

      const rawKind = typeof item['kind'] === 'string' ? item['kind'].trim() : '';
      const issueKind: IssueKind = rawKind === 'A' || rawKind === 'repair'
        ? 'repair'
        : rawKind === 'Deferred' || rawKind === 'deferred'
          ? 'deferred'
          : 'confirm';
      if (!ISSUE_KINDS.includes(issueKind)) throw new Error(`非法分类：${rawKind}`);

      const priority = (typeof item['priority'] === 'string' ? item['priority'].trim() : 'P2') as ReviewPriority;
      if (!REVIEW_PRIORITIES.includes(priority)) throw new Error(`非法优先级：${priority}`);

      const rawFindingId = typeof item['findingId'] === 'string' && item['findingId'].trim()
        ? item['findingId'].trim()
        : subjectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!FINDING_ID_PATTERN.test(rawFindingId)) {
        throw new Error(`findingId 格式非法：${rawFindingId}`);
      }

      const registeredProposals = (this.proposalsBySubject.get(subjectId) ?? []).map((r) => r.proposal);
      const effectiveKind: IssueKind = issueKind === 'repair' && registeredProposals.length === 0 ? 'confirm' : issueKind;
      const dependsOnRaw = typeof item['dependsOn'] === 'string' && item['dependsOn'].trim() ? item['dependsOn'].trim() : null;

      // 若前置依赖尚未关闭，即使产出了提案也不允许作为 repair 发布，降级保留为 deferred 文字方案
      let finalKind = effectiveKind;
      let finalProposals = effectiveKind === 'repair' ? registeredProposals : [];
      if (dependsOnRaw && !history.closedFindingIds.has(dependsOnRaw)) {
        finalKind = 'deferred';
        finalProposals = [];
      }

      const auditType = (typeof item['auditType'] === 'string' && AUDIT_TYPES.includes(item['auditType'].trim() as AuditType)
        ? item['auditType'].trim()
        : finalProposals[0]?.auditType ?? 'bugfix') as AuditType;

      findings.push({
        findingId: rawFindingId,
        title: oneLine(String(item['title'] ?? rawFindingId)),
        ...(typeof item['module'] === 'string' && item['module'].trim() ? { module: item['module'].trim() } : {}),
        auditType,
        issueKind: finalKind,
        dependsOn: finalKind === 'deferred' ? dependsOnRaw : null,
        priority,
        reason: verified.reason,
        problemSummary: oneLine(String(item['summary'] ?? verified.reason)),
        rootCause: oneLine(String(item['rootCause'] ?? verified.reason)),
        repairPlan: String(item['repairPlan'] ?? item['decision'] ?? '').trim(),
        tags: Array.isArray(item['tags']) ? asStrArray(item['tags'], 'tags') : [],
        evidence: verified.evidence,
        proposals: finalProposals,
      });
    }

    // 校验外部人工完成项复核结论（reviewedFindings）
    const reviewedExternal: ReviewedExternalFindingInput[] = [];
    if (Array.isArray(pub['reviewedFindings'])) {
      for (const rawRev of pub['reviewedFindings']) {
        const rev = asObj(rawRev, 'reviewedFindings[]');
        const findingId = typeof rev['id'] === 'string' ? rev['id'].trim() : '';
        const status = rev['status'];
        const verdict: ReviewedExternalFindingInput['verdict'] = status === 'resolved'
          ? 'resolved'
          : status === 'pending' || status === 'confirmed'
            ? 'confirmed'
            : 'unverified';
        const rawEv = rev['evidence'] ? (Array.isArray(rev['evidence']) ? rev['evidence'] : [rev['evidence']]) : [];
        const checked = await this.verifyEvidenceList(rawEv);
        const finalVerdict = (verdict === 'resolved' || verdict === 'confirmed') && checked.valid.length === 0
          ? 'unverified'
          : verdict;
        reviewedExternal.push({
          findingId,
          verdict: finalVerdict,
          reason: oneLine(String(rev['reason'] ?? (finalVerdict === 'resolved' ? '独立复核确认问题已修复' : '外部完成项复核'))),
          evidence: checked.valid,
        });
      }
    }

    const archive = new AuditArchive(this.options.root);
    const existingAudits = await archive.list(this.options.source);
    const previousAudit = existingAudits.find((a) => !a.parseError && a.auditId !== this.options.auditId)?.auditId ?? null;

    const built = await buildIssuePublication(this.options.root, {
      auditId: this.options.auditId,
      baseRevision: this.options.baseRevision,
      scope: this.options.scope || '.',
      trigger: this.options.trigger,
      previousAudit,
      reviewers,
      existingByFindingId: history.byFindingId,
      existingDirIds,
      findings,
      reviewedExternal,
      coverageLines,
      requirementLines,
      historyLines,
    });

    await publishStageArtifacts(
      this.options.root,
      built.reportPath,
      built.reportText,
      built.candidates,
      async (manifest) => {
        await this.options.onSeal?.(manifest, built.auditMeta.issues);
      },
    );

    this.published = true;
    return {
      ok: true,
      reportPath: built.reportPath,
      issues: built.auditMeta.issues,
      overview: built.overview,
    };
  }
}
