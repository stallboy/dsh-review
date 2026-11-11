import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLifecycle, LeaseTransitionError } from '../dist/audit-lifecycle.js';

/**
 * §7.6/§7.7 审查租约状态机的单元测试（架构改进 A4/A6）。
 * 状态迁移只允许 active → releasable → released（以及 active → released 的
 * “执行已证明结束”路径）；取消/超时永不直接释放。
 */

function memoryStore() {
  let saved = [];
  return {
    load: async () => saved.map((lease) => ({ ...lease })),
    save: async (leases) => { saved = leases.map((lease) => ({ ...lease })); },
    saved: () => saved,
  };
}

function lease(overrides = {}) {
  return {
    auditId: '20261110-000000-repo',
    root: '/repo',
    targetPath: '',
    trigger: 'manual',
    baseRevision: 'abc',
    owner: 'tester',
    createdAt: '2026-11-10T00:00:00.000Z',
    candidateIdsBefore: [],
    state: 'active',
    ...overrides,
  };
}

test('§7.6：active → releasable → released 合法；取消/超时只到 releasable', async () => {
  const store = memoryStore();
  const lifecycle = new AuditLifecycle(store);
  await lifecycle.load();
  await lifecycle.create(lease());

  assert.equal(lifecycle.blockingLeaseFor('/repo')?.state, 'active');
  assert.equal(await lifecycle.markReleasable('20261110-000000-repo'), true);
  // releasable 仍然阻塞共享写。
  assert.ok(lifecycle.blockingLeaseFor('/repo'), 'releasable 租约必须继续阻塞');
  await lifecycle.transition('20261110-000000-repo', 'released');
  assert.equal(lifecycle.blockingLeaseFor('/repo'), undefined);
  // 持久化反映终态。
  assert.equal(store.saved()[0]?.state, 'released');
});

test('§7.6：released 为终态，非法迁移抛错而不是静默改写', async () => {
  const store = memoryStore();
  const lifecycle = new AuditLifecycle(store);
  await lifecycle.load();
  await lifecycle.create(lease());
  await lifecycle.transition('20261110-000000-repo', 'released');

  await assert.rejects(
    () => lifecycle.transition('20261110-000000-repo', 'active'),
    (error) => error instanceof LeaseTransitionError,
  );
  await assert.rejects(
    () => lifecycle.transition('missing-id', 'released'),
    (error) => error instanceof LeaseTransitionError,
  );
});

test('§7.6：finalize 路径允许 active 直接迁到 released；重复 release 幂等', async () => {
  const store = memoryStore();
  const lifecycle = new AuditLifecycle(store);
  await lifecycle.load();
  await lifecycle.create(lease());
  const first = await lifecycle.transition('20261110-000000-repo', 'released');
  assert.equal(first.changed, true);
  const second = await lifecycle.transition('20261110-000000-repo', 'released');
  assert.equal(second.changed, false);
});

test('§7.6：Host 重启后 active/releasable 租约继续阻塞', async () => {
  const store = memoryStore();
  const first = new AuditLifecycle(store);
  await first.load();
  await first.create(lease({ auditId: 'a', state: 'active' }));
  await first.create(lease({ auditId: 'b', state: 'releasable' }));

  const restarted = new AuditLifecycle(store);
  await restarted.load();
  assert.equal(restarted.all().length, 2);
  assert.equal(restarted.blockingLeaseFor('/repo')?.auditId, 'a');
  assert.equal(restarted.anyBlocking()?.auditId, 'a');
});
