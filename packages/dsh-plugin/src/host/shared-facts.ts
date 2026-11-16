import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemCandidateSource, type CandidateSource } from './store.js';
import { runProcess, type ProcessResult } from './shell.js';

/**
 * §7.1 本地视图枚举（Git/SVN 共用）：候选目录"是否只存在于工作区"本质是文件系统
 * 问题，直接枚举工作区，由调用方（store.list）扣除共享快照集合。
 *
 * 为什么不用 `git status --porcelain` / `svn status`（2026-11-12 事故修复）：
 * - 两者的未跟踪条目都会**折叠到最高的未跟踪祖先目录**——首次审查时整个
 *   `.ai-review/` 未跟踪，git 只输出一行 `?? .ai-review/`，SVN 同样只报目录本身，
 *   按月份/候选层级解析的正则匹配不到任何条目，本地候选诊断静默失效；
 * - git 还会遵守 `.gitignore`：`.ai-review/` 被忽略时 status 输出为空。
 * 文件系统枚举对两种情况都免疫，且少一次 VCS 子进程。
 */
function listWorktreeCandidateDirs(root: string): Promise<string[]> {
  return new FilesystemCandidateSource(root).listCandidateDirs();
}

const VCS_TIMEOUT_MS = 180_000;

async function git(root: string, args: string[]): Promise<ProcessResult> {
  return runProcess(
    'git',
    ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
    { cwd: root, timeoutMs: VCS_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 },
  );
}

async function svn(root: string, args: string[]): Promise<ProcessResult> {
  return runProcess('svn', ['--non-interactive', ...args], { cwd: root, timeoutMs: VCS_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 });
}

/**
 * §7.1 共享快照读取源：除候选事实之外，还提供审查档案（`audits/<id>/audit.md`）的
 * 同快照读取与快照标识。投影缓存键必须来自同一个源对象，禁止“用 A 快照读取、用 B 快照做键”。
 */
export interface AuditSnapshotSource {
  /** 共享快照中存在 audit.md 的档案目录名（`<audit_id>`）。 */
  listAuditDirs(): Promise<string[]>;
  /** 读取共享快照中的 audit.md 文本；不存在返回 null。 */
  readAuditText(dirName: string): Promise<string | null>;
}

export interface SharedCandidateSource extends CandidateSource, AuditSnapshotSource {
  /** 该源实际绑定的 VCS 快照标识；无法证明快照时可返回 null（调用方不得缓存）。 */
  snapshotId(): Promise<string | null>;
  readReviewersText(): Promise<string | null>;
}

/**
 * §7.1 共享事实读取源（Git）：候选的 review.md 与补丁全部读自创建时固定的同一 HEAD 快照，
 * 不从工作区拼凑；`hasLocalChanges` 用于把存在本地改动的候选降级为 local 诊断。
 * 一次计算（list/get）内所有读取绑定同一 snapshot，不混合不同 VCS 快照。
 */
export class GitHeadCandidateSource implements SharedCandidateSource {
  private constructor(
    private readonly root: string,
    private readonly snapshot: string,
  ) {}

  /** 无提交历史（空仓库）返回 null，调用方回退文件系统源。 */
  static async create(root: string): Promise<GitHeadCandidateSource | null> {
    const head = await git(root, ['rev-parse', 'HEAD']);
    if (head.code !== 0) return null;
    const snapshot = head.stdout.trim();
    return snapshot ? new GitHeadCandidateSource(root, snapshot) : null;
  }

  async snapshotId(): Promise<string | null> {
    return this.snapshot;
  }

  async listCandidateDirs(): Promise<string[]> {
    const result = await git(this.root, ['ls-tree', '-r', '--name-only', this.snapshot, '--', '.ai-review']);
    if (result.code !== 0) throw new Error(`无法读取 .ai-review 树：${result.stderr.trim()}`);
    const dirs = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\.ai-review\/(\d{4}-\d{2})\/([^/]+)\/review\.md$/.exec(line.trim());
      if (match && match[1] && match[2]) dirs.add(`${match[1]}/${match[2]}`);
    }
    return [...dirs];
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    // 尾斜杠让 ls-tree 列出目录内容（子项为 .ai-review/<month>/<slug>/<name> 全路径）。
    const result = await git(this.root, ['ls-tree', '--name-only', this.snapshot, '--', `.ai-review/${month}/${slug}/`]);
    if (result.code !== 0) return null;
    const prefix = `.ai-review/${month}/${slug}/`;
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix) && line.length > prefix.length)
      .map((line) => line.slice(prefix.length));
  }

  async readReviewText(month: string, slug: string): Promise<string | null> {
    return this.show(`.ai-review/${month}/${slug}/review.md`);
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    return this.show(`.ai-review/${month}/${slug}/${patchName}`);
  }

  async hasLocalChanges(month: string, slug: string): Promise<boolean> {
    const result = await git(this.root, ['status', '--porcelain', '--', `.ai-review/${month}/${slug}`]);
    if (result.code !== 0) throw new Error(`无法证明候选本地状态：${result.stderr.trim()}`);
    return result.stdout.trim().length > 0;
  }

  /**
   * §7.1 批量本地改动检测：一次 `git status --porcelain=v1 -z -uall -- .ai-review` 覆盖所有候选，
   * 语义与逐候选 hasLocalChanges 等价（同一 porcelain 数据源，只是合并子进程）。
   * `-uall` 防止已跟踪候选目录内的新文件被目录折叠吞掉；`-z` 关闭路径转义，按 NUL 切分。
   * 失败返回 null，由调用方回退逐候选检测。结果属本地视图层，不得按快照缓存。
   */
  async localChangedCandidateIds(): Promise<Set<string> | null> {
    const result = await git(this.root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.ai-review']);
    if (result.code !== 0) return null;
    const ids = new Set<string>();
    for (const record of result.stdout.split('\0')) {
      if (record.length === 0) continue;
      // porcelain v1 -z 记录形如 "XY <path>"；rename 记录后紧跟一个不带状态前缀的原路径记录。
      const pathText = record.length > 3 && record[2] === ' ' ? record.slice(3) : record;
      const match = /^\.ai-review\/(\d{4}-\d{2})\/([^/]+)(?:\/|$)/.exec(pathText);
      if (match) ids.add(`${match[1]}/${match[2]}`);
    }
    return ids;
  }

  async listLocalOnlyDirs(): Promise<string[]> {
    // 未进入 HEAD 的候选目录（未跟踪/新增）：仅作 local 诊断展示，不进入共享流程。
    // 实现见文件顶部说明：工作区枚举 + 调用方扣除共享集合（整目录未跟踪时 git status 会折叠失效）。
    // master 侧曾把 git 失败从 return [] 收紧为 throw；工作区枚举不再发起 git 子进程，
    // 读取失败由 FilesystemCandidateSource 归一为空列表（store.list 侧本就 catch 兜底）。
    return listWorktreeCandidateDirs(this.root);
  }

  async listAuditDirs(): Promise<string[]> {
    const result = await git(this.root, ['ls-tree', '--name-only', this.snapshot, '--', '.ai-review/audits/']);
    if (result.code !== 0) throw new Error(`无法读取共享审查档案：${result.stderr.trim()}`);
    const prefix = '.ai-review/audits/';
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix) && line.length > prefix.length)
      .map((line) => line.slice(prefix.length).replace(/\/$/, ''))
      .filter((name) => name.length > 0 && !name.includes('/'));
  }

  async readAuditText(dirName: string): Promise<string | null> {
    return this.show(`.ai-review/audits/${dirName}/audit.md`);
  }

  async readReviewersText(): Promise<string | null> {
    return this.show('.ai-review/reviewers.yml');
  }

  private async show(relPath: string): Promise<string | null> {
    const result = await git(this.root, ['show', `${this.snapshot}:${relPath}`]);
    if (result.code === 0) return result.stdout;
    const diagnostic = result.stderr.trim();
    if (/does not exist|exists on disk, but not in|not in .*snapshot/i.test(diagnostic)) return null;
    throw new Error(`无法读取共享文件 ${relPath}：${diagnostic}`);
  }
}

/**
 * §7.1 共享事实读取源（SVN）：读自工作副本的 BASE 修订（已提交的 pristine 状态），
 * `svn status` 检测本地改动与未版本化目录。一次计算内所有读取绑定同一工作副本。
 * 说明：`snapshotId()` 返回 null——SVN 的工作副本根 revision 不随子路径提交前进，
 * 无法仅凭根 revision 证明快照未变化，因此调用方不得据此做跨请求缓存。
 */
export class SvnBaseCandidateSource implements SharedCandidateSource {
  constructor(private readonly root: string) {}

  async snapshotId(): Promise<string | null> {
    return null;
  }

  async listCandidateDirs(): Promise<string[]> {
    // §7.1：SVN 共享事实读自 BASE——必须显式固定 -r BASE，避免工作区本地改动混入。
    const result = await svn(this.root, ['list', '-r', 'BASE', '-R', '.ai-review']);
    if (result.code !== 0) throw new Error(`无法读取 .ai-review 列表：${result.stderr.trim()}`);
    const dirs = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const file = line.trim().replaceAll('\\', '/');
      const match = /^(\d{4}-\d{2})\/([^/]+)\/review\.md$/.exec(file);
      if (match && match[1] && match[2]) dirs.add(`${match[1]}/${match[2]}`);
    }
    return [...dirs];
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    const result = await svn(this.root, ['list', '-r', 'BASE', `.ai-review/${month}/${slug}`]);
    if (result.code !== 0) return null;
    return result.stdout.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, '')).filter((line) => line.length > 0);
  }

  async readReviewText(month: string, slug: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/${month}/${slug}/review.md`);
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/${month}/${slug}/${patchName}`);
  }

  async hasLocalChanges(month: string, slug: string): Promise<boolean> {
    const result = await svn(this.root, ['status', '--xml', `.ai-review/${month}/${slug}`]);
    if (result.code !== 0) throw new Error(`无法证明候选本地状态：${result.stderr.trim()}`);
    return /<entry\b/.test(result.stdout);
  }

  /**
   * §7.1 SVN 批量本地改动检测：一次 `svn status --xml -- .ai-review` 覆盖所有候选，
   * 语义与逐候选 hasLocalChanges 等价。失败返回 null，由调用方回退逐候选检测。
   */
  async localChangedCandidateIds(): Promise<Set<string> | null> {
    const result = await svn(this.root, ['status', '--xml', '--', '.ai-review']);
    if (result.code !== 0) return null;
    const ids = new Set<string>();
    for (const entry of result.stdout.matchAll(/<entry\s+path="([^"]+)"/g)) {
      const entryPath = (entry[1] ?? '').replaceAll('\\', '/');
      const match = /(?:^|\/)\.ai-review\/(\d{4}-\d{2})\/([^/]+)(?:\/|$)/.exec(entryPath);
      if (match) ids.add(`${match[1]}/${match[2]}`);
    }
    return ids;
  }

  async listLocalOnlyDirs(): Promise<string[]> {
    // 未版本化的候选目录：仅作 local 诊断。`svn status` 对未版本化目录同样只报
    // 目录本身（不递归），整目录未跟踪时按层级解析会失效——改用工作区枚举（见文件顶部说明）。
    return listWorktreeCandidateDirs(this.root);
  }

  async listAuditDirs(): Promise<string[]> {
    const result = await svn(this.root, ['list', '-r', 'BASE', '.ai-review/audits']);
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\/$/, ''))
      .filter((name) => name.length > 0 && !name.includes('/'));
  }

  async readAuditText(dirName: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/audits/${dirName}/audit.md`);
  }

  async readReviewersText(): Promise<string | null> {
    return this.readSharedFile('.ai-review/reviewers.yml');
  }

  /**
   * §7.1 SVN 实现准则：先用 `svn info --xml -R` + `svn status --xml` 证明候选目录
   * 处于同一基准 revision 且无本地改动，然后直接读本地工作副本文件；
   * 仅当无法证明同快照时才回退 `svn cat -r BASE`（绝不逐文件无条件远端读取）。
   */
  private async readSharedFile(relPath: string): Promise<string | null> {
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
    if (await this.canReadLocalShared(dir)) {
      try {
        return await readFile(path.join(this.root, relPath), 'utf8');
      } catch {
        // 本地文件缺失：回退 BASE 读取。
      }
    }
    const result = await svn(this.root, ['cat', '-r', 'BASE', '--', relPath]);
    return result.code === 0 ? result.stdout : null;
  }

  private async canReadLocalShared(dir: string): Promise<boolean> {
    const status = await svn(this.root, ['status', '--xml', '--', dir]);
    if (status.code !== 0 || /<entry\b/.test(status.stdout)) return false;
    const info = await svn(this.root, ['info', '--xml', '-R', '--', dir]);
    if (info.code !== 0) return false;
    const revisions = [...info.stdout.matchAll(/<commit\s+revision="(\d+)"/g)].map((match) => match[1]);
    return revisions.length > 0 && revisions.every((revision) => revision === revisions[0]);
  }
}
