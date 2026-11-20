import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAuditMarkdown, serializeAuditMarkdown } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { parseReviewMarkdown } from '../packages/dsh-plugin/dist/host/frontmatter.js';
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
    assert.match(result.files[1].errors[0], /owner.*必填/);
    assert.match(result.files[2].errors[0], /ENOENT/);
    assert.equal(await readFile(invalidPath, 'utf8'), invalidReview);
    assert.equal(await readFile(auditPath, 'utf8'), audit);
    assert.equal(run().status, 2);
});
