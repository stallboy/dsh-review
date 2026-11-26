import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { nextUpdatedAt } from '../packages/dsh-plugin/dist/host/issue-review.js';
import { writeCandidate } from './fixtures/contract.mjs';

async function fixture(updatedAt) {
  const root = await mkdtemp(path.join(tmpdir(), 'dcr-lock-'));
  await writeCandidate(root, 'lock-case', { review: { updatedAt } });
  return { root, store: new ReviewStore(root) };
}

const guardOf = (revision, updatedAt) => ({
  expectedRevision: revision,
  expectedOwner: 'tester',
  expectedUpdatedAt: updatedAt,
});

test('AC-LOCK-01: 冻结时钟下连续写入严格单调（+1ms 推进，UTC 规范化）', async () => {
  const frozen = new Date().toISOString();
  const { store } = await fixture(frozen);
  const first = await store.addComment('2026-11/lock-case', guardOf(1, frozen), { author: 'tester', content: '第一条' });
  const firstAt = new Date(first.candidate.meta.updatedAt).getTime();
  assert.ok(firstAt > new Date(frozen).getTime(), `应严格大于上一值：${first.candidate.meta.updatedAt}`);
  assert.match(first.candidate.meta.updatedAt, /Z$/);
  assert.equal(first.candidate.meta.recordRevision, 2);

  const second = await store.addComment(
    '2026-11/lock-case',
    guardOf(first.candidate.meta.recordRevision, first.candidate.meta.updatedAt),
    { author: 'tester', content: '第二条' },
  );
  assert.ok(new Date(second.candidate.meta.updatedAt).getTime() > firstAt, '连续写入单调递增');
  assert.equal(second.candidate.meta.recordRevision, 3);
});

test('AC-LOCK-01: 时钟回拨仍严格推进（未来时间戳 +1ms）', async () => {
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const { store } = await fixture(future);
  const updated = await store.addComment('2026-11/lock-case', guardOf(1, future), { author: 'tester', content: '回拨后写入' });
  assert.equal(new Date(updated.candidate.meta.updatedAt).getTime(), new Date(future).getTime() + 1);
});

test('AC-LOCK-01: 评论推进 record_revision 与 updated_at，旧 guard（旧版本或旧时间戳）均返回 409 stale', async () => {
  const start = new Date(Date.now() - 60_000).toISOString();
  const { store } = await fixture(start);
  const first = await store.addComment('2026-11/lock-case', guardOf(1, start), { author: 'tester', content: '第一条' });
  assert.equal(first.candidate.meta.recordRevision, 2);
  await assert.rejects(
    store.addComment('2026-11/lock-case', guardOf(1, start), { author: 'tester', content: '旧版本写入' }),
    (error) => error.status === 409 && error.code === 'stale'
      && error.details?.currentRevision === 2
      && error.details?.currentUpdatedAt === first.candidate.meta.updatedAt,
  );
  await assert.rejects(
    store.addComment('2026-11/lock-case', guardOf(2, start), { author: 'tester', content: '旧时间戳写入' }),
    (error) => error.status === 409 && error.code === 'stale'
      && error.details?.currentUpdatedAt === first.candidate.meta.updatedAt,
  );
});

test('AC-LOCK-01: nextUpdatedAt 单元行为——空值/非法上一值取当前时间', () => {
  const produced = nextUpdatedAt('');
  assert.ok(Number.isFinite(new Date(produced).getTime()));
  assert.match(produced, /Z$/);
});
