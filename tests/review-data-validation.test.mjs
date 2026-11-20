import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditInvariantErrors, parseAuditMarkdown, serializeAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { parseReviewMarkdown, serializeReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { reviewFixture } from './fixtures/contract.mjs';

const auditId = '20261119-120000-repo';
const audit = serializeAuditMarkdown({
    schemaVersion: 1, auditId, createdAt: '2026-11-19T12:00:00Z', baseRevision: '123',
    scope: '.', trigger: 'manual', previousAudit: null, candidates: [], items: [],
}, '# 审查报告\n');

test('评审与档案拒绝重复键、锚点和错误的 Frontmatter 结束行', () => {
    const review = reviewFixture('strict');
    for (const [parse, text] of [[parseReviewMarkdown, review], [parseAuditMarkdown, audit]]) {
        assert.throws(() => parse(text.replace('schema_version: 1', 'schema_version: 0\nschema_version: 1')), /duplicated mapping key/);
        assert.throws(() => parse(text.replace('schema_version: 1', 'schema_version: &version 1')), /YAML 锚点或别名/);
        assert.throws(() => parse(text.replace('schema_version: 1', 'extension: &version\n  x: 1\nschema_version: 1')), /YAML 锚点或别名/);
        assert.throws(() => parse(text.replace('schema_version: 1', 'extension: &version {x: 1}\ncopy: *version\nschema_version: 1')), /YAML 锚点或别名/);
        assert.throws(() => parse(text.replace(/\n---\n/, '\n---garbage\n')), /分隔符/);
        const compatible = '\uFEFF' + text.replace('schema_version: 1', 'schema_version: 1 # &comment\nextension: "&literal *text"').replaceAll('\n', '\r\n');
        assert.equal(parse(compatible).meta.schemaVersion, 1);
    }
    assert.throws(() => parseReviewMarkdown(review.replace('patch: 001.patch', 'patch: second.patch\n    patch: 001.patch')), /duplicated mapping key/);
});

test('审查档案要求显式填写必填字段并验证数组元素类型', () => {
    for (const [input, invalid, message] of [
        ['schema_version: 1', 'schema_version: true', /schema_version/],
        ['previous_audit: null\n', '', /previous_audit.*必填/],
        ['candidates: []\n', '', /candidates.*必填/],
        ['candidates: []', 'candidates: wrong', /candidates.*必须是数组/],
        ['candidates: []', 'candidates: [42]', /candidates\[0\].*字符串/],
        ['items: []\n', '', /items.*必填/],
        ['items: []', 'items: null', /items.*必须是数组/],
        ['items: []', 'items: [{finding_id: x, kind: confirm, title: T, summary: S, target_files: [], depends_on: null, status: pending}]', /items\[0\]\.candidate.*必填/],
        ['items: []', 'items: [{finding_id: x, kind: confirm, title: T, summary: S, target_files: [42], depends_on: null, status: pending, candidate: null}]', /items\[0\]\.target_files\[0\].*字符串/],
    ]) {
        assert.notEqual(audit.replace(input, invalid), audit);
        assert.throws(() => parseAuditMarkdown(audit.replace(input, invalid)), message);
    }
});

test('V2 候选必须绑定合法发现，旧候选仍可往返', () => {
    const legacy = reviewFixture('legacy');
    const v2 = legacy.replace('schema_version: 1', 'schema_version: 2\nfinding_id: math-addition');
    const parsed = parseReviewMarkdown(v2);
    assert.equal(parsed.meta.findingId, 'math-addition');
    assert.deepEqual(parseReviewMarkdown(serializeReviewMarkdown(parsed.meta, parsed.body)).meta, parsed.meta);
    assert.equal(parseReviewMarkdown(legacy).meta.findingId, undefined);
    assert.throws(() => parseReviewMarkdown(v2.replace('finding_id: math-addition\n', '')), /finding_id/);
    assert.throws(() => parseReviewMarkdown(v2.replace('math-addition', '../escape')), /finding_id/);
    assert.throws(() => parseReviewMarkdown(v2.replace('schema_version: 2', 'schema_version: 1')), /finding_id/);
});

test('V2 档案保持方案顺序并校验选项的归属和格式', () => {
    const { meta, body } = parseAuditMarkdown(audit);
    const first = { candidateId: '2026-11/fix-a', tradeoff: '影响面小' };
    const second = { candidateId: '2026-11/fix-b', tradeoff: '复用公用逻辑' };
    const item = {
        findingId: 'math-addition', kind: 'repair', title: '加法异常', summary: '两个正数相加错误',
        targetFiles: ['src/math.js'], dependsOn: null, status: 'pending', candidate: null,
        repairPlan: '恢复加法语义并校验正数输入', options: [first, second],
    };
    const v2 = { ...meta, schemaVersion: 2, candidates: [first.candidateId, second.candidateId], items: [item] };
    assert.deepEqual(parseAuditMarkdown(serializeAuditMarkdown(v2, body)).meta, v2);
    assert.deepEqual(auditInvariantErrors(v2, auditId), []);
    assert.match(auditInvariantErrors({ ...v2, items: [{ ...item, options: [first, first] }] }, auditId).join(), /选项/);
    assert.match(auditInvariantErrors({ ...v2, items: [{ ...item, options: [{ ...first, candidateId: '../escape' }] }] }, auditId).join(), /选项/);
    assert.match(auditInvariantErrors({ ...v2, candidates: [first.candidateId] }, auditId).join(), /选项/);
    assert.match(auditInvariantErrors({ ...v2, items: [{ ...item, options: [] }] }, auditId).join(), /选项/);
    assert.match(auditInvariantErrors({ ...v2, items: [{ ...item, options: undefined }] }, auditId).join(), /选项/);
});

test('只读命令批量输出字段和路径，校验失败返回非零且不改数据', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-data-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const reviewPath = path.join(root, '2026-11', 'strict', 'review.md');
    const auditPath = path.join(root, 'audits', auditId, 'audit.md');
    const invalidPath = path.join(root, '2026-11', 'missing-owner', 'review.md');
    for (const file of [reviewPath, auditPath, invalidPath]) await mkdir(path.dirname(file), { recursive: true });
    const invalidReview = reviewFixture('missing-owner').replace('owner: tester\n', '');
    await writeFile(reviewPath, reviewFixture('strict'));
    await writeFile(auditPath, audit);
    await writeFile(invalidPath, invalidReview);
    const cli = fileURLToPath(new URL('../packages/dsh-plugin/dist/host/validate-review-data.js', import.meta.url));
    const run = (...files) => spawnSync(process.execPath, [cli, ...files], { cwd: root, encoding: 'utf8' });
    const pass = run(path.relative(root, reviewPath), auditPath);
    assert.equal(pass.status, 0, pass.stderr);
    assert.deepEqual(JSON.parse(pass.stdout), { ok: true, files: [{ path: reviewPath, errors: [] }, { path: auditPath, errors: [] }] });
    const fail = run(reviewPath, invalidPath, path.join(root, 'missing', 'audit.md'));
    assert.equal(fail.status, 1, fail.stderr);
    const result = JSON.parse(fail.stdout);
    assert.equal(result.ok, false);
    assert.deepEqual(result.files[0], { path: reviewPath, errors: [] });
    assert.equal(result.files[1].path, invalidPath);
    assert.match(result.files[1].errors[0], /owner.*必填/);
    assert.match(result.files[2].errors[0], /ENOENT/);
    assert.equal(await readFile(invalidPath, 'utf8'), invalidReview);
    assert.equal(await readFile(auditPath, 'utf8'), audit);
    assert.equal(run().status, 2);
});
