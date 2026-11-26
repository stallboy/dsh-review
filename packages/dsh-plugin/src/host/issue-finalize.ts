import path from 'node:path';
import { auditFiles } from './audit-files.js';
import { AuditArchive, serializeAuditMarkdown } from './audit-archive.js';
import { assertStageArtifacts, compatibleAuditBase } from './audit-stage-artifacts.js';
import { gitBlobHash } from './vcs.js';
import { loadReviewers, resolveOwner } from './reviewers.js';
import { validateReviewData } from './review-data-validation.js';
import { parseReviewMarkdown } from './frontmatter.js';
import type { AuditDeps, AuditFinalizeInput, AuditFinalizeResult } from './auditor.js';

export async function finalizeIssueAudit(deps: AuditDeps, input: AuditFinalizeInput): Promise<AuditFinalizeResult> {
    const { store, vcs } = deps;
    const reportPath = '.ai-review/audits/' + input.auditId + '/audit.md';
    const result: AuditFinalizeResult = { status: 'ABORTED', reportPath, body: '', created: [], deferred: [],
        dataValidation: [], commitRevision: null, warnings: [...input.extraWarnings ?? []], message: '审查提案未提交' };
    const recovery = (detail: string, commit = false): AuditFinalizeResult => ({ ...result, status: 'RECOVERY_REQUIRED',
        reason: commit ? 'COMMIT_OUTCOME_UNKNOWN' : 'SYNC_STATE_UNKNOWN', detail, message: '审查收尾需要核验现场' });
    const safe = async () => !deps.signal?.aborted && await compatibleAuditBase(vcs, input.baseRevision, input.svnUrl)
        && (await vcs.ensureCleanWorkspace()).clean && (!deps.scheduledBaseMatches || await deps.scheduledBaseMatches());
    if (!input.phasedSeal || !await safe()) return recovery('审查未封存或工作区状态已变化');
    const seal = { ...input.phasedSeal };
    const ids = Object.keys(seal).filter(file => /^\.ai-review\/\d{4}-\d{2}\/[^/]+\/review\.md$/.test(file)).map(file => file.slice(11, -10));
    try { await assertStageArtifacts(store.repoRoot, seal, ids); } catch (error) { return recovery(String(error)); }
    const reviewers = await loadReviewers(store.repoRoot, deps.candidateSource);
    for (const id of ids) {
        const detail = await store.get(id, input.baseRevision);
        const { candidate } = detail;
        const errors = await store.validateFullCandidate(candidate);
        const reviewPath = '.ai-review/' + id + '/review.md';
        const bytes = (await auditFiles(store.repoRoot, { op: 'read', paths: [reviewPath] })).bytes;
        if (!bytes) errors.push('问题记录不存在');
        else errors.push(...validateReviewData(reviewPath, bytes));
        if (candidate.meta.schemaVersion !== 3 || candidate.meta.issue?.baseRevision !== input.baseRevision) errors.push('问题格式或观察基线不匹配');
        if (!input.beforeIds.has(id) && candidate.meta.currentRevision !== 1) errors.push('新问题记录必须从版本 1 开始');
        let owner = resolveOwner(reviewers, { paths: candidate.meta.targetFiles, tags: candidate.meta.tags }).owner;
        if (input.beforeIds.has(id)) {
            const [month, slug] = id.split('/') as [string, string];
            const previous = await deps.candidateSource?.readReviewText(month, slug);
            if (previous == null) errors.push('无法核验既有问题的共享负责人');
            else owner = parseReviewMarkdown(previous).meta.owner;
        }
        if (owner !== candidate.meta.owner) errors.push('问题负责人不符合共享记录或新问题路由');
        for (const option of candidate.meta.issue?.options ?? []) {
            const revision = candidate.meta.revisions.find(item => item.id === option.currentPatch)!;
            const [month, slug] = id.split('/') as [string, string];
            const existed = await deps.candidateSource?.readPatchText(month, slug, revision.patch);
            if (existed == null && (candidate.meta.status === 'pending' || candidate.meta.status === 'changes_requested')) {
                if (option.gateChecks.some(command => !reviewers.allowedGateCommands.includes(command))) errors.push('新提案的修复门禁不在白名单');
                const checked = await vcs.checkPatch(path.join(candidate.dirPath, revision.patch));
                if (!checked.ok) errors.push('补丁只读预检失败：' + checked.message);
            }
        }
        result.dataValidation.push({ path: reviewPath, errors });
        result.created.push({ id, title: candidate.meta.title, owner: candidate.meta.owner, status: candidate.meta.status,
            patch: candidate.meta.issue?.options.map(item => String(item.currentPatch).padStart(3, '0') + '.patch').join('、') ?? '',
            baseRevision: input.baseRevision, patchStats: detail.patchStats, gateChecks: candidate.meta.gateChecks.length, errors });
    }
    if (result.created.some(item => item.errors.length)) return { ...result, status: 'VALIDATION_FAILED', message: '问题提案校验失败，未提交' };
    const archive = new AuditArchive(store.repoRoot);
    const body = await archive.readDraft(input.auditId);
    if (!body) return recovery('封存报告无法读取');
    const previousAudit = (await archive.list()).filter(item => !item.parseError && item.meta.auditId !== input.auditId)
        .map(item => item.meta.auditId).sort().at(-1) ?? null;
    result.body = body;
    const createdAt = new Date(input.startedAt).toISOString();
    const meta = { schemaVersion: 3, auditId: input.auditId, createdAt, baseRevision: input.baseRevision,
        scope: input.targetPath || '.', trigger: input.trigger, previousAudit, candidates: ids, items: [] };
    await archive.writeExisting(meta, body);
    seal[reportPath] = gitBlobHash(serializeAuditMarkdown(meta, body));
    const paths = Object.keys(seal);
    const snapshot = await auditFiles(store.repoRoot, { op: 'snapshot', paths });
    const entries = snapshot.entries;
    if (!entries || entries.length !== paths.length || entries.some(entry => entry.blobHash !== seal[entry.path])) return recovery('封存后产物发生变化');
    if (!await safe()) return recovery('提交前工作区或基线发生变化');
    const probeBefore = await vcs.getCommitProbe(paths).catch(() => null);
    if (probeBefore === null) return recovery('无法建立提交探针');
    await input.beforeCommit?.();
    if (!await safe()) return recovery('提交前检查未通过');
    const commit = await vcs.atomicCommit({ message: `audit(${input.targetPath || 'repo'}): 记录 ${String(ids.length)} 个问题提案 [skip ci]`, paths, verifyEntries: entries });
    if (commit.verificationFailed) return recovery(commit.errorOutput, true);
    if (!commit.success) {
        const probeAfter = await vcs.getCommitProbe(paths).catch(() => null);
        if (probeAfter === null) return recovery(commit.errorOutput, true);
        if (probeAfter !== probeBefore) {
            const changed = await vcs.listCommitPaths?.(probeAfter);
            if (!changed || !changed.includes(reportPath) || changed.some(file => !paths.includes(file))) return recovery(commit.errorOutput, true);
            for (const entry of entries) {
                const text = await vcs.readFileAt(probeAfter, entry.path).catch(() => null);
                if (text === null || gitBlobHash(text) !== entry.blobHash) return recovery(commit.errorOutput, true);
            }
            result.commitRevision = probeAfter;
        } else {
            await commit.restorePreparation?.();
            const after = await auditFiles(store.repoRoot, { op: 'snapshot', paths });
            if (JSON.stringify(after.entries) !== JSON.stringify(entries)) return recovery('提交失败后现场再次变化');
            for (const entry of entries) {
                const before = await vcs.readFileAt(input.baseRevision, entry.path);
                if (before === null) await auditFiles(store.repoRoot, { op: 'remove', paths: [entry.path], entries: [entry] });
                else await auditFiles(store.repoRoot, { op: 'write', paths: [entry.path], text: before, expectedText: (await auditFiles(store.repoRoot, { op: 'read', paths: [entry.path] })).bytes!.toString('utf8') });
            }
            return { ...result, message: '审查提交失败，已恢复原问题记录：' + commit.errorOutput };
        }
    } else result.commitRevision = commit.commitRevision;
    return { ...result, status: 'COMMITTED', message: `审查完成：${String(ids.length)} 个问题记录已归档，修复提案待人工审核` };
}
