import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVcs } from '../dist/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';

function canRun(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

const hasSvn = canRun('svn') && canRun('svnadmin');

test('git revertBusinessWorkspace drops staged business changes', async () => {
  const root = await createGitFixture();
  const vcs = createVcs('git', root);
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  runCommand('git', ['add', '-A'], root);

  await vcs.revertBusinessWorkspace();

  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
  assert.match(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), /a - b/);
});

test('git revertBusinessWorkspace removes intent-to-add files from `git add -N`', async () => {
  const root = await createGitFixture();
  const vcs = createVcs('git', root);
  await writeFile(path.join(root, 'new-file.ts'), 'export const x = 1;\n', 'utf8');
  runCommand('git', ['add', '-N', 'new-file.ts'], root);

  await vcs.revertBusinessWorkspace();

  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '');
  await assert.rejects(readFile(path.join(root, 'new-file.ts')), /ENOENT/);
});

test('git revertBusinessWorkspace unstages .ai-review but keeps its content', async () => {
  const root = await createGitFixture();
  const reviewPath = path.join(root, '.ai-review', '2026-10', 'keep', 'review.md');
  await mkdir(path.dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, '# keep me\n', 'utf8');
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  runCommand('git', ['add', '-A'], root);
  const vcs = createVcs('git', root);

  await vcs.revertBusinessWorkspace();

  assert.equal(await readFile(reviewPath, 'utf8'), '# keep me\n');
  assert.match(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), /a - b/);
  assert.equal(runCommand('git', ['diff', '--cached', '--name-only'], root).stdout.trim(), '');
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '?? .ai-review/');
});

test('git revertBusinessWorkspace recovers from a failed atomic commit', async () => {
  const root = await createGitFixture();
  const reviewPath = path.join(root, '.ai-review', '2026-10', 'keep', 'review.md');
  await mkdir(path.dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, '# keep me\n', 'utf8');
  await writeFile(path.join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(hook, 0o755);
  const vcs = createVcs('git', root);

  const commit = await vcs.atomicCommit({ message: 'probe', paths: ['src/math.js', '.ai-review'] });
  assert.equal(commit.success, false);
  assert.notEqual(runCommand('git', ['diff', '--cached', '--name-only'], root).stdout.trim(), '');

  await vcs.revertBusinessWorkspace();

  assert.equal(runCommand('git', ['diff', '--cached', '--name-only'], root).stdout.trim(), '');
  assert.equal(runCommand('git', ['status', '--porcelain'], root).stdout.trim(), '?? .ai-review/');
  assert.match(await readFile(path.join(root, 'src', 'math.js'), 'utf8'), /a - b/);
  assert.equal(await readFile(reviewPath, 'utf8'), '# keep me\n');
});

test('svn revertBusinessWorkspace removes files scheduled by a patch', { skip: !hasSvn }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-svn-revert-'));
  const repo = path.join(base, 'repo');
  const wc = path.join(base, 'wc');
  runCommand('svnadmin', ['create', repo], base);
  const url = `file:///${repo.replaceAll('\\', '/')}`;
  runCommand('svn', ['--non-interactive', 'checkout', url, wc], base);
  await writeFile(path.join(wc, 'a.txt'), 'base\n', 'utf8');
  runCommand('svn', ['--non-interactive', 'add', 'a.txt'], wc);
  runCommand('svn', ['--non-interactive', 'commit', '-m', 'base'], wc);

  // `svn patch` of an added file schedules it exactly like `svn add` does.
  await writeFile(path.join(wc, 'new.txt'), 'new\n', 'utf8');
  runCommand('svn', ['--non-interactive', 'add', 'new.txt'], wc);
  const vcs = createVcs('svn', wc);

  await vcs.revertBusinessWorkspace();

  assert.equal(runCommand('svn', ['--non-interactive', 'status'], wc).stdout.trim(), '');
  await assert.rejects(readFile(path.join(wc, 'new.txt')), /ENOENT/);
  assert.equal(await readFile(path.join(wc, 'a.txt'), 'utf8'), 'base\n');
});
