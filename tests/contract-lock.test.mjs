import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewStore, nextUpdatedAt } from '../dist/store.js';

/**
 * AC-LOCK-01（§4.3 / §8.1 / §12.1）：ConcurrencyGuard 必须含 expectedUpdatedAt，
 * updated_at 严格单调（冻结时钟、时钟回拨均 +1ms 推进），
 * 不推进补丁版本的写入（评论）也能被旧 guard 检出为 stale。
 */

async function fixture(updatedAt) {
  const root = await mkdtemp(path.join(tmpdir(), 'dcr-lock-'));
  const dir = path.join(root, '.ai-review', '2026-11', 'lock-case');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), [
    '---',
    'schema_version: 1',
    'title: "net: lock"',
    'module: net',
    'audit_type: bugfix',
    'created_at: "2026-11-01T10:00:00+08:00"',
    `updated_at: "${updatedAt}"`,
    'owner: tester',
    'tags: []',
    'status: pending',
    'ticket: null',
    'target_files: [src/math.js]',
    'current_revision: 1',
    'revisions:',
    '  - id: 1',
    '    base_revision: "1"',
    '    patch: 001.patch',
    '    author: ai',
    'gate_checks: ["node --version"]',
    'comments: []',
    'human_decisions: []',
    'approval: null',
    'rejection: null',
    'commit_message: "net: lock"',
    '---',
    '',
    '# 问题与影响',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(dir, '001.patch'), 'diff --git a/src/math.js b/src/math.js\n', 'utf8');
  return { root, store: new ReviewStore(root) };
}

const guardOf = (updatedAt) => ({ expectedRevision: 1, expectedOwner: 'tester', expectedUpdatedAt: updatedAt });

test('AC-LOCK-01: 冻结时钟下连续写入严格单调（+1ms 推进，UTC 规范化）', async () => {
  const frozen = new Date().toISOString(); // 与写入时刻同刻度或更早 → 必须严格推进
  const { store } = await fixture(frozen);
  const first = await store.addComment('2026-11/lock-case', 'tester', { content: '第一条' }, guardOf(frozen));
  const firstAt = new Date(first.meta.updatedAt).getTime();
  assert.ok(firstAt > new Date(frozen).getTime(), `应严格大于上一值：${first.meta.updatedAt}`);
  assert.match(first.meta.updatedAt, /Z$/);

  // 连续第二次写入同样必须严格推进。
  const second = await store.addComment('2026-11/lock-case', 'tester', { content: '第二条' }, guardOf(first.meta.updatedAt));
  assert.ok(new Date(second.meta.updatedAt).getTime() > firstAt, '连续写入单调递增');
});

test('AC-LOCK-01: 时钟回拨仍严格推进（未来时间戳 +1ms）', async () => {
  const future = new Date(Date.now() + 10 * 60_000).toISOString(); // 时钟回拨场景
  const { store } = await fixture(future);
  const updated = await store.addComment('2026-11/lock-case', 'tester', { content: '回拨后写入' }, guardOf(future));
  assert.equal(new Date(updated.meta.updatedAt).getTime(), new Date(future).getTime() + 1);
});

test('AC-LOCK-01: 评论不推进版本，旧 guard（缺最新 updated_at）必须 409 stale', async () => {
  const start = new Date(Date.now() - 60_000).toISOString();
  const { store } = await fixture(start);
  await store.addComment('2026-11/lock-case', 'tester', { content: '第一条' }, guardOf(start));
  // revision 与 owner 均未变化：仅靠 expectedUpdatedAt 检出并发写入。
  await assert.rejects(
    store.addComment('2026-11/lock-case', 'tester', { content: '旧页面写入' }, guardOf(start)),
    (error) => error.status === 409 && error.code === 'stale' && error.details?.currentUpdatedAt !== undefined,
  );
});

test('AC-LOCK-01: nextUpdatedAt 单元行为——空值/非法上一值取当前时间', () => {
  const produced = nextUpdatedAt('');
  assert.ok(Number.isFinite(new Date(produced).getTime()));
  assert.match(produced, /Z$/);
});
