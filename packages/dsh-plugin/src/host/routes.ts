/** 声明式 HTTP 路由表（SPEC §6.2–§6.3）。单一归属控制互斥、锁类别与路由分派，废弃旧端点不再注册。 */

export type RouteCategory = 'read' | 'config_write' | 'repo_write' | 'audit_control';

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  /** 路径前缀匹配，用于带参数段（如 /jobs/:id）。 */
  pattern?: RegExp;
  category: RouteCategory;
  /** 是否在存在活动审查租约或提案会话占用时阻塞。 */
  blockedByActiveAudit: boolean;
  /** 是否需要在进程内 repo 锁中执行。 */
  requiresRepoLock: boolean;
}

export const ROUTES: readonly RouteDefinition[] = [
  // 读取接口（SPEC §6.2）
  { method: 'GET', path: '/health', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/settings', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/queue', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/candidate', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/patch', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/diff', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/fix-prompt', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/audit/prompt', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/jobs', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/jobs/:id', pattern: /^\/jobs\/([^/]+)$/, category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/reviewers', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/audits', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/findings', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'GET', path: '/client-entry', category: 'read', blockedByActiveAudit: false, requiresRepoLock: false },

  // 配置与工作区初始化
  { method: 'PUT', path: '/settings', category: 'config_write', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'POST', path: '/reviewers/init', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },

  // 审查编排与租约控制
  { method: 'POST', path: '/audit/session', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'POST', path: '/audit', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'POST', path: '/audit/manual', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: false },
  { method: 'POST', path: '/audit/finalize', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: true },
  { method: 'POST', path: '/audit/release', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: true },
  { method: 'POST', path: '/recovery/clear', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: true },
  { method: 'POST', path: '/jobs/:id/cancel', pattern: /^\/jobs\/([^/]+)\/cancel$/, category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: false },

  // 11 个问题共享写端点 + sync（统一 {id, ...guard}）
  { method: 'POST', path: '/comments', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/comments/batch', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/comment-status', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/takeover', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/resume', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/finding/decision', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/approve', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/ai-fix', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/rebase', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
  { method: 'POST', path: '/fix-session', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: false },
  { method: 'POST', path: '/fix-session/release', category: 'audit_control', blockedByActiveAudit: false, requiresRepoLock: true },
  { method: 'POST', path: '/candidate/finalize', category: 'repo_write', blockedByActiveAudit: false, requiresRepoLock: true },
  { method: 'POST', path: '/sync', category: 'repo_write', blockedByActiveAudit: true, requiresRepoLock: true },
];

export function matchRoute(method: string, pathname: string): { route: RouteDefinition; params: string[] } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.pattern) {
      const match = route.pattern.exec(pathname);
      if (match) return { route, params: match.slice(1) };
    } else if (route.path === pathname) {
      return { route, params: [] };
    }
  }
  return null;
}
