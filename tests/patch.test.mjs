import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHunkFallbackDiff, parsePatch } from '../dist/patch.js';

const CJK = '\u4e2d\u6587.txt';

test('parsePatch decodes git-quoted non-ASCII paths', () => {
  const patch = [
    `diff --git "a/\\344\\270\\255\\346\\226\\207.txt" "b/\\344\\270\\255\\346\\226\\207.txt"`,
    'index 587be6b..b77b4eb 100644',
    `--- "a/\\344\\270\\255\\346\\226\\207.txt"`,
    `+++ "b/\\344\\270\\255\\346\\226\\207.txt"`,
    '@@ -1 +1,2 @@',
    ' x',
    '+y',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, [CJK]);
  assert.equal(parsed.stats.files, 1);
  assert.equal(parsed.stats.entries[0]?.path, CJK);
  assert.equal(parsed.stats.additions, 1);
});

test('parsePatch decodes quoted binary paths and ignores base85 payload lines', () => {
  const patch = [
    `diff --git "a/img/\\344\\270\\255.png" "b/img/\\344\\270\\255.png"`,
    'new file mode 100644',
    'index 0000000..1111111',
    'GIT binary patch',
    'literal 5',
    '+cmZQzU|?Wi00RI3',
    'literal 0',
    'HcmV?d00001',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, ['img/\u4e2d.png']);
  assert.equal(parsed.stats.files, 1);
  assert.equal(parsed.stats.additions, 0);
  assert.equal(parsed.stats.deletions, 0);
  assert.equal(parsed.binary, true);
  assert.equal(parsed.stats.entries[0]?.binary, true);
});

test('parsePatch keeps both sides of a rename so the deletion can be committed', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/b.ts',
    'similarity index 100%',
    'rename from src/a.ts',
    'rename to src/b.ts',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, ['src/a.ts', 'src/b.ts']);
  assert.equal(parsed.stats.files, 1);
  assert.equal(parsed.stats.entries[0]?.path, 'src/b.ts');
});

test('parsePatch does not treat removed lines starting with "-- " as file headers', () => {
  const patch = [
    'diff --git a/db/schema.sql b/db/schema.sql',
    '--- a/db/schema.sql',
    '+++ b/db/schema.sql',
    '@@ -1,2 +1,1 @@',
    '--- old comment',
    ' SELECT 1;',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, ['db/schema.sql']);
  assert.equal(parsed.stats.entries[0]?.deletions, 1);
  assert.equal(parsed.stats.entries[0]?.additions, 0);
});

test('parsePatch does not treat added lines starting with "++ " as file headers', () => {
  const patch = [
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1 +1,2 @@',
    ' base',
    '+++ payload',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, ['notes.md']);
  assert.equal(parsed.stats.entries[0]?.additions, 1);
  assert.equal(parsed.stats.entries[0]?.deletions, 0);
});

test('parsePatch still parses plain svn-style unified diffs', () => {
  const patch = [
    'Index: a.txt',
    '===================================================================',
    '--- a.txt\t(revision 1)',
    '+++ a.txt\t(working copy)',
    '@@ -1 +1 @@',
    '-base',
    '+rev1',
  ].join('\n');

  const parsed = parsePatch(patch);
  assert.deepEqual(parsed.paths, ['a.txt']);
  assert.equal(parsed.stats.entries[0]?.path, 'a.txt');
  assert.equal(parsed.stats.additions, 1);
  assert.equal(parsed.stats.deletions, 1);
});

test('parsePatch records created and deleted files from /dev/null headers', () => {
  const created = parsePatch([
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n'));
  assert.deepEqual(created.paths, ['new.txt']);
  assert.equal(created.stats.additions, 1);

  const deleted = parsePatch([
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n'));
  assert.deepEqual(deleted.paths, ['gone.txt']);
  assert.equal(deleted.stats.deletions, 1);
});

const svnPatch = (value) => [
  'Index: a.txt',
  '===================================================================',
  '--- a.txt\t(revision 1)',
  '+++ a.txt\t(working copy)',
  '@@ -1 +1 @@',
  '-base',
  `+${value}`,
].join('\n');

const quotedGitPatch = (value) => [
  `diff --git "a/\\344\\270\\255\\346\\226\\207.txt" "b/\\344\\270\\255\\346\\226\\207.txt"`,
  `--- "a/\\344\\270\\255\\346\\226\\207.txt"`,
  `+++ "b/\\344\\270\\255\\346\\226\\207.txt"`,
  '@@ -1 +1 @@',
  '-base',
  `+${value}`,
].join('\n');

test('buildHunkFallbackDiff renders svn Index sections instead of empty placeholders', () => {
  const out = buildHunkFallbackDiff(1, 2, '1', '2', svnPatch('rev1'), svnPatch('rev2'), []);
  assert.match(out.unifiedDiff, /### 旧版本 rev 1 \(1\)\nIndex: a\.txt/);
  assert.match(out.unifiedDiff, /\+rev1/);
  assert.match(out.unifiedDiff, /### 新版本 rev 2 \(2\)\nIndex: a\.txt/);
  assert.match(out.unifiedDiff, /\+rev2/);
  assert.doesNotMatch(out.unifiedDiff, /该版本未修改此文件/);
});

test('buildHunkFallbackDiff renders sections for git-quoted paths', () => {
  const out = buildHunkFallbackDiff(1, 2, 'b1', 'b2', quotedGitPatch('rev1'), quotedGitPatch('rev2'), []);
  assert.ok(out.unifiedDiff.includes(`## 文件 ${CJK}`), out.unifiedDiff);
  assert.match(out.unifiedDiff, /\+rev1/);
  assert.match(out.unifiedDiff, /\+rev2/);
  assert.doesNotMatch(out.unifiedDiff, /该版本未修改此文件/);
});

test('buildHunkFallbackDiff keeps the placeholder for files a revision did not touch', () => {
  const right = [
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-base',
    '+rev2',
  ].join('\n');
  const out = buildHunkFallbackDiff(1, 2, 'b1', 'b2', svnPatch('rev1'), right, []);
  assert.match(out.unifiedDiff, /### 新版本 rev 2 \(b2\)\n\(该版本未修改此文件\)/);
});
