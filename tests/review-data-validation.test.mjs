import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
    scope: '.', trigger: 'manual', previousAudit: null, issues: [],
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
    assert.throws(() => parseReviewMarkdown(review.replace(/patch: "?001\.patch"?/, 'patch: "second.patch"\n    patch: "001.patch"')), /duplicated mapping key/);
});

test('审查档案要求显式填写必填字段并验证纯索引 issues[]', () => {
    for (const [input, invalid, message] of [
        ['schema_version: 1', 'schema_version: true', /schema_version/],
        ['schema_version: 1', 'schema_version: 2', /schema_version/],
        ['previous_audit: null\n', '', /previous_audit/],
        ['issues: []\n', '', /issues/],
        ['issues: []', 'issues: wrong', /issues.*数组/],
        ['issues: []', 'issues: [42]', /issues.*数组/],
    ]) {
        assert.notEqual(audit.replace(input, invalid), audit);
        assert.throws(() => parseAuditMarkdown(audit.replace(input, invalid)), message);
    }
});

test('唯一 schema_version: 1 强校验 finding_id 并拒绝 v2/v3 旧版本', () => {
    const valid = reviewFixture('math-addition', { findingId: 'math-addition' });
    const parsed = parseReviewMarkdown(valid);
    assert.equal(parsed.meta.schemaVersion, 1);
    assert.equal(parsed.meta.findingId, 'math-addition');
    assert.deepEqual(parseReviewMarkdown(serializeReviewMarkdown(parsed.meta, parsed.body)).meta, parsed.meta);
    assert.throws(() => parseReviewMarkdown(valid.replace(/finding_id: .*\n/, '')), /finding_id/);
    assert.throws(() => parseReviewMarkdown(valid.replace('schema_version: 1', 'schema_version: 2')), /schema_version/);
    assert.throws(() => parseReviewMarkdown(valid.replace('schema_version: 1', 'schema_version: 3')), /schema_version/);
});

test('纯索引 audit.md 校验 issues[] 目录格式与唯一性', () => {
    const { meta, body } = parseAuditMarkdown(audit);
    const indexed = { ...meta, issues: ['2026-11/fix-a', '2026-11/fix-b'] };
    assert.deepEqual(parseAuditMarkdown(serializeAuditMarkdown(indexed, body)).meta, indexed);
    assert.deepEqual(auditInvariantErrors(indexed, auditId), []);
    assert.ok(auditInvariantErrors({ ...indexed, issues: ['2026-11/fix-a', '2026-11/fix-a'] }, auditId).some((e) => /重复/.test(e)));
    assert.ok(auditInvariantErrors({ ...indexed, issues: ['../escape'] }, auditId).some((e) => /非法/.test(e)));
    assert.ok(auditInvariantErrors({ ...indexed, auditId: 'other-id' }, auditId).some((e) => /不一致/.test(e)));
});

test('只读命令批量输出字段和路径，校验失败返回非零且不改数据', async t => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'review-data-cli-'));
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
    const run = (...files) => spawnSync(process.execPath, [cli, ...files], { cwd: root, encoding: 'utf8', env: { ...process.env, INIT_CWD: '' } });
    const pass = run(path.relative(root, reviewPath), auditPath);
    assert.equal(pass.status, 0, pass.stderr);
    assert.deepEqual(JSON.parse(pass.stdout), { ok: true, files: [{ path: reviewPath, errors: [] }, { path: auditPath, errors: [] }] });
    const fail = run(reviewPath, invalidPath, path.join(root, 'missing', 'audit.md'));
    assert.equal(fail.status, 1, fail.stderr);
    const result = JSON.parse(fail.stdout);
    assert.equal(result.ok, false);
    assert.deepEqual(result.files[0], { path: reviewPath, errors: [] });
    assert.equal(result.files[1].path, invalidPath);
    assert.match(result.files[1].errors[0], /owner/);
    assert.match(result.files[2].errors[0], /ENOENT/);
    assert.equal(await readFile(invalidPath, 'utf8'), invalidReview);
    assert.equal(await readFile(auditPath, 'utf8'), audit);
    assert.equal(run().status, 2);
});
