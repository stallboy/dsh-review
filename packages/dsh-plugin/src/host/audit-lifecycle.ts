/** 审查租约状态机。取消或超时后的租约仍会阻塞写入，直到宿主完成收尾或确认释放。 */

export type AuditLeaseState = 'active' | 'releasable' | 'released';

export interface AuditLeaseRecord {
  auditId: string;
  root: string;
  targetPath: string;
  trigger: 'manual' | 'scheduled';
  baseRevision: string;
  owner: string;
  createdAt: string;
  /** 开审时已存在的候选不属于本轮新增产物，收尾须排除。 */
  candidateIdsBefore: string[];
  state: AuditLeaseState;
  sessionId?: string;
}

export type BlockingLease = AuditLeaseRecord & { state: 'active' | 'releasable' };

const TRANSITIONS: Record<AuditLeaseState, AuditLeaseState[]> = {
  active: ['releasable', 'released'],
  releasable: ['released'],
  released: [],
};

export class LeaseTransitionError extends Error {}

export interface LeaseStore {
  load(): Promise<AuditLeaseRecord[]>;
  save(leases: AuditLeaseRecord[]): Promise<void>;
}

export class AuditLifecycle {
  private leases: AuditLeaseRecord[] = [];

  constructor(private readonly store: LeaseStore) {}

  async load(): Promise<void> {
    this.leases = await this.store.load();
  }

  all(): readonly AuditLeaseRecord[] {
    return this.leases;
  }

  find(auditId: string): AuditLeaseRecord | undefined {
    return this.leases.find((lease) => lease.auditId === auditId);
  }

  blockingLeaseFor(root: string): BlockingLease | undefined {
    return this.leases.find((lease): lease is BlockingLease => lease.root === root && lease.state !== 'released');
  }

  anyBlocking(): BlockingLease | undefined {
    return this.leases.find((lease): lease is BlockingLease => lease.state !== 'released');
  }

  async create(record: AuditLeaseRecord): Promise<AuditLeaseRecord> {
    const index = this.leases.findIndex((lease) => lease.auditId === record.auditId);
    if (index >= 0) this.leases[index] = record;
    else this.leases.push(record);
    await this.store.save(this.leases);
    return record;
  }

  /** 已释放是终态，重复释放允许幂等重试。若状态无法持久化，则恢复内存中的原状态。 */
  async transition(auditId: string, next: AuditLeaseState): Promise<{ changed: boolean; lease: AuditLeaseRecord }> {
    const lease = this.find(auditId);
    if (!lease) throw new LeaseTransitionError(`审查租约不存在：${auditId}`);
    if (lease.state === next) return { changed: false, lease };
    if (!TRANSITIONS[lease.state].includes(next)) {
      throw new LeaseTransitionError(`非法租约迁移：${lease.state} → ${next}（${auditId}）`);
    }
    const previous = lease.state;
    lease.state = next;
    try {
      await this.store.save(this.leases);
    } catch (error) {
      lease.state = previous;
      throw error;
    }
    return { changed: true, lease };
  }

  async markReleasable(auditId: string): Promise<boolean> {
    const lease = this.find(auditId);
    if (!lease || lease.state !== 'active') return false;
    await this.transition(auditId, 'releasable');
    return true;
  }
}
