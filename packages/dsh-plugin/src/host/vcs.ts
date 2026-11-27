/**
 * VCS 适配层统一入口：聚合 GitAdapter、SvnAdapter、Mode C 拓扑与批准提交派生。
 */

import type { VcsType } from './types.js';
import { GitAdapter } from './vcs-git.js';
import { SvnAdapter, classifySvnApprovalPatch, svnPatchReportsConflict } from './vcs-svn.js';
import type { VcsAdapter } from './vcs-types.js';

export * from './vcs-types.js';
export { GitAdapter } from './vcs-git.js';
export { SvnAdapter, classifySvnApprovalPatch, svnPatchReportsConflict } from './vcs-svn.js';

export function createVcs(type: VcsType, root: string, baseBranch = ''): VcsAdapter {
  return type === 'git' ? new GitAdapter(root, baseBranch) : new SvnAdapter(root);
}
