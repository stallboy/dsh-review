/**
 * §7.6/§7.7 审查执行生命周期（租约 + 跟踪 Job）的唯一状态机。
 *
 * 架构动机（审查报告 A4/A6）：此前“一次审查执行”的状态分散在
 * `auditLeases` / `auditJobFinishes` / `auditJobLeases` / `jobs` 四处，
 * 迁移逻辑散落在 armAuditLeaseTimeout / startAuditTrackingJob / jobCancel /
 * auditFinalize / auditRelease 五个方法里，任何一处漏改都会破坏互斥。
 *
 * 现在所有迁移只在这个文件里发生：
 *
 *   active ──cancelled/timeout──> releasable ──confirmStopped+工作区干净──> released
 *     └──────finalize 完成──────────────────────────────────────────────> released
 *     └──────启动失败回滚───────────────────────────────────────────────> released
 *
 * 不变量：
 * - 只有 `released` 不阻塞共享写；`active` 与 `releasable` 都参与互斥。
 * - 取消与超时**永不**直接迁到 released（SPEC：必须人工确认外部执行已停止）。
 * - 租约持久化在 DSH_HOME 运行时状态中，Host 重启后继续阻塞。
 */

export type AuditLeaseState = 'active' | 'releasable' | 'released';

export interface AuditLeaseRecord {
  auditId: string;
  root: string;
  targetPath: string;
  trigger: 'manual' | 'scheduled';
  baseRevision: string;
  owner: string;
  createdAt: string;
  /** 开始执行时的候选快照：finalize 只校验此后新增的候选。 */
  candidateIdsBefore: string[];
  state: AuditLeaseState;
  /** 会话模式创建的 DSH 审查会话 id（手动/定时/headless 模式缺省）：诊断展示与后续自动化定位用。 */
  sessionId?: string;
}

/** 阻塞中的租约（active/releasable）：released 已被 blockingLeaseFor/anyBlocking 过滤。 */
export type BlockingLease = AuditLeaseRecord & { state: 'active' | 'releasable' };

/** 合法的状态迁移；表中没有的迁移一律拒绝（fail-closed）。 */
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

/**
 * 纯内存状态机 + 可注入持久化。不依赖 HTTP/Job/文件系统，便于单测。
 */
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

  /** 该仓库是否有**阻塞性**租约（active 或 releasable）；released 已在返回类型上排除。 */
  blockingLeaseFor(root: string): BlockingLease | undefined {
    return this.leases.find((lease): lease is BlockingLease => lease.root === root && lease.state !== 'released');
  }

  /** 是否存在任意未释放租约（跨仓库，用于“新审查要求无任何运行中任务”）。 */
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

  /**
   * 唯一的状态迁移入口。非法迁移抛 LeaseTransitionError，而不是静默改写。
   * `released` 为终态，重复 release 是幂等的空操作（返回 false）。
   */
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

  /** 取消/超时：只迁到 releasable，仍阻塞共享写。 */
  async markReleasable(auditId: string): Promise<boolean> {
    const lease = this.find(auditId);
    if (!lease || lease.state !== 'active') return false;
    await this.transition(auditId, 'releasable');
    return true;
  }
}
