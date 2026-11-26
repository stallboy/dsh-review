import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ReviewStore } from './store.js';
import { findingIdOf } from './auditor.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from './frontmatter.js';
import { oneLine, type StageCandidate } from './audit-stage-artifacts.js';
import { parsePatch } from './patch.js';
import { resolveOwner, type ReviewersConfig } from './reviewers.js';
import type { AuditLeaseRecord } from './audit-lifecycle.js';
import type { CandidateSource } from './store.js';
import type { ReviewFrontmatter } from './types.js';
import type { AuditRecheck } from './audit-history.js';
import { parseFindingEvents } from './finding-decisions.js';
import type { SharedCandidateSource } from './shared-facts.js';
import type { VcsAdapter } from './vcs.js';
import { runProcess } from './shell.js';

async function historicalPatch(vcs: VcsAdapter, file: string): Promise<string> {
    const args = vcs.type === 'git' ? ['log', '-256', '--format=%H', '--', file]
        : ['--non-interactive', 'log', '--xml', '-l', '256', '--', path.posix.dirname(file)];
    const log = await runProcess(vcs.type, args, { cwd: vcs.root, timeoutMs: 30_000, maxBytes: 1024 * 1024 });
    if (log.code !== 0) throw new Error('无法读取遗留补丁历史');
    const revisions = vcs.type === 'git' ? log.stdout.trim().split(/\r?\n/)
        : [...log.stdout.matchAll(/<logentry\s+revision="(\d+)"/g)].flatMap(match => [match[1]!, String(Number(match[1]) - 1)]);
    for (const revision of revisions.filter(Boolean)) {
        const text = await vcs.readFileAt(revision, file);
        if (text !== null) return text;
    }
    throw new Error('找不到遗留补丁内容，保留原记录待人工处理：' + file);
}

interface Finding {
    subjectId: string; title: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; kind: 'A' | 'B' | 'Deferred';
    decision: string; dependsOn: string; repairPlan?: string; findingId?: string;
}

interface Verification {
    reason: string; observedBehavior: string; impact: string; preconditions: string[]; limits: string[];
    evidence: Array<{ path: string; line: number; excerpt: string; reason: string }>;
}

export async function prepareIssuePublication(input: {
    lease: AuditLeaseRecord; findings: Finding[]; reviews: ReadonlyMap<string, Verification>;
    proposals: ReadonlyMap<string, StageCandidate[]>; coverage: string[]; history: string[];
    reviewers: ReviewersConfig; source?: SharedCandidateSource; vcs: VcsAdapter;
    recheck?: AuditRecheck;
    recheckEvidence?: unknown[];
}): Promise<{ path: string; body: string; candidates: StageCandidate[]; items: []; overview: Array<{ title: string; priority: Finding['priority']; kind: Finding['kind'] }> }> {
    const { lease } = input;
    const store = new ReviewStore(lease.root);
    const existing = new Map<string, { id: string; text: string }>();
    for (const id of input.source ? await input.source.listCandidateDirs() : await store.listCandidateIds()) {
        const [month, slug] = id.split('/') as [string, string];
        const text = input.source ? await input.source.readReviewText(month, slug)
            : await readFile(path.join(lease.root, '.ai-review', id, 'review.md'), 'utf8');
        if (!text) continue;
        const { meta } = parseReviewMarkdown(text);
        if (!meta.findingId) continue;
        const previous = existing.get(meta.findingId);
        if (meta.schemaVersion === 3 && previous && parseReviewMarkdown(previous.text).meta.schemaVersion === 3) throw new Error('同一问题存在多个权威记录');
        if (!previous || meta.schemaVersion === 3) existing.set(meta.findingId, { id, text });
    }
    const artifacts: StageCandidate[] = [];
    const seen = new Set<string>();
    const now = new Date().toISOString();
    for (const finding of input.findings) {
        const findingId = finding.findingId ?? findingIdOf('confirm', oneLine(finding.title));
        if (seen.has(findingId)) throw new Error('正式问题编号重复');
        seen.add(findingId);
        const prior = existing.get(findingId);
        if (prior && input.source) {
            const [month, slug] = prior.id.split('/') as [string, string];
            if (await input.source.hasLocalChanges(month, slug)) throw new Error('既有问题存在本地修改，禁止覆盖');
        }
        const old = prior ? parseReviewMarkdown(prior.text) : undefined;
        const id = prior?.id ?? lease.createdAt.slice(0, 7) + '/' + findingId;
        const fact = input.reviews.get(finding.subjectId)!;
        const proposals = input.proposals.get(finding.subjectId) ?? [];
        const paths = [...new Set([...fact.evidence.map(item => item.path), ...proposals.flatMap(item => parsePatch(item.patch).paths)])];
        const owner = old?.meta.owner ?? resolveOwner(input.reviewers, { paths, tags: [] }).owner;
        if (!owner) throw new Error('问题缺少有效负责人');
        const meta: ReviewFrontmatter = old ? structuredClone(old.meta) : {
            schemaVersion: 3, module: 'audit', title: 'audit: ' + oneLine(finding.title), auditType: proposals[0]?.proposal?.auditType ?? 'bugfix',
            owner, tags: [], ticket: null, status: 'pending', createdAt: now, updatedAt: now, targetFiles: paths,
            currentRevision: 1, revisions: [], gateChecks: [], comments: [], humanDecisions: [], approval: null, rejection: null,
            commitMessage: 'audit: ' + oneLine(finding.title), extra: {},
        };
        const patches: Record<string, string> = {};
        if (old && old.meta.schemaVersion !== 3) {
            meta.extra = { ...meta.extra, legacy_metadata: old.meta };
            meta.revisions = meta.revisions.map(revision => ({ ...revision, extra: { ...revision.extra, option_id: 'legacy' } }));
            for (const revision of meta.revisions) {
                const [month, slug] = id.split('/') as [string, string];
                const text = input.source ? await input.source.readPatchText(month, slug, revision.patch)
                    : await readFile(path.join(lease.root, '.ai-review', id, revision.patch), 'utf8').catch(() => null);
                if (text === null) patches[revision.patch] = await historicalPatch(input.vcs, '.ai-review/' + id + '/' + revision.patch);
                revision.extra = { ...revision.extra, sha256: createHash('sha256').update(text ?? patches[revision.patch]!).digest('hex') };
            }
        }
        meta.schemaVersion = 3;
        meta.findingId = findingId;
        meta.currentRevision = old ? old.meta.currentRevision + 1 : 1;
        meta.updatedAt = now;
        meta.targetFiles = [...new Set([...meta.targetFiles, ...paths])];
        meta.issue ??= { priority: finding.priority, baseRevision: lease.baseRevision, options: [], observations: [], decisions: [], repairAttempts: [] };
        if ((!old || old.meta.schemaVersion !== 3) && input.source) {
            const text = await input.source.readFindingText(findingId);
            const events = text === null ? [] : parseFindingEvents(text, findingId);
            meta.issue.decisions = events.map(event => ({ action: event.action, actor: event.actor, at: event.at,
                reason: ('hint' in event ? event.hint : 'reason' in event ? event.reason : '') ?? '',
                ...(event.action === 'defer' ? { reviewAfter: event.reviewAfter, reviewWhen: event.reviewWhen } : {}) }));
            const decision = events.filter(event => event.action !== 'add_repair_hint').at(-1);
            if (decision?.action === 'human_takeover') meta.status = 'human_takeover';
            if (decision?.action === 'external_completed') meta.status = 'awaiting_verification';
        }
        if (meta.approval) meta.extra = { ...meta.extra, approval_history: [...(Array.isArray(meta.extra?.['approval_history']) ? meta.extra['approval_history'] : []), meta.approval] };
        meta.approval = null;
        meta.issue.priority = finding.priority;
        meta.issue.baseRevision = lease.baseRevision;
        meta.issue.observations.push({ auditId: lease.auditId, baseRevision: lease.baseRevision, at: now, verdict: 'confirmed',
            reason: fact.reason, evidence: fact.evidence });
        if (meta.status === 'approved' || meta.status === 'resolved' || meta.status === 'changes_requested') meta.status = 'pending';
        if (meta.status === 'awaiting_verification') meta.status = 'human_takeover';
        const originalOptions = meta.issue.options;
        const generated = proposals.map((proposal, index) => {
            if (old?.meta.schemaVersion === 3 && originalOptions.length && !proposal.proposal?.optionId) throw new Error('修订既有问题时必须声明稳定的 optionId');
            const optionId = proposal.proposal?.optionId ?? ['a', 'b'][index]!;
            const previousOption = originalOptions.find(option => option.id === optionId);
            if (!previousOption && meta.revisions.some(revision => revision.extra?.['option_id'] === optionId)) throw new Error('已退役的方案编号不得复用');
            const patchId = meta.revisions.length + 1;
            const name = String(patchId).padStart(3, '0') + '.patch';
            meta.revisions.push({ id: patchId, baseRevision: lease.baseRevision, patch: name, author: 'ai', extra: { option_id: optionId,
                sha256: createHash('sha256').update(proposal.patch).digest('hex') } });
            patches[name] = proposal.patch;
            return { ...previousOption, id: optionId, title: proposal.title, tradeoff: proposal.proposal!.tradeoff, confidence: proposal.proposal!.confidence,
                currentPatch: patchId, gateChecks: proposal.proposal!.commands };
        });
        meta.issue.options = finding.kind === 'A' ? [...originalOptions.map(option => generated.find(item => item.id === option.id) ?? option),
            ...generated.filter(option => !originalOptions.some(previous => previous.id === option.id))] : [];
        if (meta.issue.options.length > 2 || new Set(generated.map(option => option.id)).size !== generated.length) throw new Error('最多两个有效方案且修订编号唯一');
        meta.gateChecks = meta.issue.options[0]?.gateChecks ?? [];
        const judgments = [...new Set(proposals.flatMap(proposal => proposal.proposal!.humanDecisions))];
        for (const question of judgments) {
            if (!meta.humanDecisions.some(item => item.question === question)) meta.humanDecisions.push({ id: 'decision-' + String(meta.humanDecisions.length + 1), question });
        }
        const provenance = [
            '# ' + oneLine(finding.title), '', '> **任务来源**: 仓库审查与逐条独立复核',
            '> **任务内容**: 记录问题、证据和待人工审核的修复提案', '> **参考文档**:',
            ...fact.evidence.map(item => '> - `' + item.path + ':' + String(item.line) + '` — ' + oneLine(item.reason)),
            '> **生成日期**: ' + lease.createdAt.slice(0, 10), '',
        ].join('\n');
        const history = old ? old.body.slice(old.body.indexOf('# 审核记录') + '# 审核记录'.length).trim() : '';
        const body = [provenance, '# 问题与影响', fact.observedBehavior, fact.impact, '# 根因', fact.reason,
            '# 当前修复方案', finding.repairPlan || finding.decision || proposals.map(item => item.title).join('\n'),
            '# 需人工判断项', judgments.length ? judgments.map(item => '- ' + item).join('\n') : '- 无',
            '# 验证证据', ...fact.evidence.map(item => '- ' + item.path + ':' + String(item.line) + ' `' + item.excerpt + '`：' + item.reason),
            '修复提案未应用；修复效果由人工批准后的修复阶段验证。', ...fact.limits,
            '# 审核记录', history, '## 记录 ' + String(meta.currentRevision) + ' · ' + lease.auditId,
            '### 方案说明', finding.repairPlan || finding.decision || '见当前修复方案', '### 验证结果', fact.reason,
            '### 人类总体意见', '待审核', '### 意见处理结果', '保留既有人工处置与补丁历史。',
        ].join('\n\n');
        artifacts.push({ id, title: meta.title, patch: '', patches, review: serializeReviewMarkdown(meta, body), ...(prior ? { expectedReview: prior.text } : {}) });
    }
    for (const observation of input.recheck?.observations ?? []) {
        if (seen.has(observation.findingId)) continue;
        const prior = existing.get(observation.findingId);
        if (!prior) continue;
        const { meta, body } = parseReviewMarkdown(prior.text);
        if (meta.schemaVersion !== 3 || !meta.issue) continue;
        const entry = input.recheckEvidence?.find(value => value && typeof value === 'object'
            && (value as Record<string, unknown>)['id'] === observation.findingId) as Record<string, unknown> | undefined;
        const evidence = entry?.['evidence'] as Record<string, unknown> | undefined;
        if (!evidence || !['pending', 'resolved'].includes(String(entry?.['status']))) continue;
        const resolved = observation.status === 'resolved' && meta.status === 'awaiting_verification';
        const confirmed = observation.status === 'pending';
        meta.currentRevision += 1;
        meta.updatedAt = now;
        meta.issue.baseRevision = lease.baseRevision;
        meta.issue.observations.push({ auditId: lease.auditId, baseRevision: lease.baseRevision, at: now,
            verdict: resolved ? 'resolved' : confirmed ? 'confirmed' : 'unverified', reason: observation.summary,
            evidence: [{ path: String(evidence['file']), line: Number(evidence['line']), excerpt: String(evidence['excerpt']), reason: String(evidence['reason']) }] });
        if (resolved) meta.status = 'resolved';
        else if (confirmed && meta.status === 'awaiting_verification') meta.status = 'human_takeover';
        artifacts.push({ id: prior.id, title: meta.title, patch: '', patches: {}, expectedReview: prior.text,
            review: serializeReviewMarkdown(meta, body + '\n\n## 历史复查 · ' + lease.auditId + '\n\n' + observation.summary + '\n') });
    }
    const body = ['# 仓库审查索引', '', '> **任务来源**: 用户发起的仓库审查', '> **任务内容**: 本轮问题索引、覆盖与限制',
        '> **参考文档**:', ...artifacts.map(item => '> - `.ai-review/' + item.id + '/review.md` — 问题权威记录'),
        '> **生成日期**: ' + lease.createdAt.slice(0, 10), '', '- 基线：' + lease.baseRevision, '- 范围：' + (lease.targetPath || '.'),
        '', '## 问题索引', '', ...artifacts.map(item => '- [' + oneLine(item.title) + '](../../' + item.id + '/review.md)'),
        '', '## 覆盖与限制', '', ...input.coverage.map(item => '- ' + oneLine(item)), '', '## 历史复查', '', ...input.history.map(item => '- ' + oneLine(item)), '',
    ].join('\n');
    return { path: '.ai-review/audits/' + lease.auditId + '/audit.md', body, candidates: artifacts, items: [],
        overview: input.findings.map(({ title, priority, kind }) => ({ title, priority, kind })) };
}
