/**
 * 桌面 DSH 审查会话与手动阶段通道协调器（归属 ReviewApi 实例，零模块级全局状态泄漏）：
 * 统一托管活跃阶段会话、手动回环通道、超时/取消/节点停机停止标记与资源回收。
 */

import type { AuditStageSession } from './audit-stages.js';

export interface BoundStageSession {
  auditId: string;
  session: AuditStageSession;
}

export class DesktopAuditSessionCoordinator {
  private readonly stageSessions = new Map<string, BoundStageSession>();
  private readonly manualChannels = new Map<string, () => void>();
  private readonly stoppingAudits = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  bindStageSession(sessionId: string, auditId: string, session: AuditStageSession): void {
    this.stageSessions.set(sessionId, { auditId, session });
  }

  getStageSession(sessionId: string): BoundStageSession | undefined {
    return this.stageSessions.get(sessionId);
  }

  unbindStageSession(sessionId: string): void {
    this.stageSessions.delete(sessionId);
  }

  registerManualChannel(auditId: string, close: () => void): void {
    this.manualChannels.get(auditId)?.();
    this.manualChannels.set(auditId, close);
  }

  closeManualChannel(auditId: string): void {
    this.manualChannels.get(auditId)?.();
    this.manualChannels.delete(auditId);
    this.clearTimer(auditId);
  }

  setTimer(auditId: string, timer: ReturnType<typeof setTimeout>): void {
    this.clearTimer(auditId);
    this.timers.set(auditId, timer);
  }

  clearTimer(auditId: string): void {
    const existing = this.timers.get(auditId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(auditId);
    }
  }

  markStopping(auditId: string): void {
    this.stoppingAudits.add(auditId);
  }

  clearStopping(auditId: string): void {
    this.stoppingAudits.delete(auditId);
  }

  isAuditStopping(auditId: string): boolean {
    return this.stoppingAudits.has(auditId);
  }

  closeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const close of this.manualChannels.values()) {
      try { close(); } catch { /* ignore */ }
    }
    this.manualChannels.clear();
    this.stageSessions.clear();
    this.stoppingAudits.clear();
  }
}
