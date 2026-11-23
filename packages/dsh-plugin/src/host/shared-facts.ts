import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findingRecordPath } from './finding-decisions.js';
import { FilesystemCandidateSource, type CandidateSource } from './store.js';
import { runProcess, type ProcessResult } from './shell.js';

/** VCS 状态输出可能把首次审查的未跟踪候选折叠成父目录，Git 还会隐藏被忽略的目录，因此从文件系统枚举。 */
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

/** 档案与候选须来自同一固定版本，投影用来缓存的版本也必须来自这一读取源。 */
export interface AuditSnapshotSource {
  listAuditDirs(): Promise<string[]>;
  readAuditText(dirName: string): Promise<string | null>;
}

export interface SharedCandidateSource extends CandidateSource, AuditSnapshotSource {
  /** 无法证明版本时返回 null，调用方须跳过跨请求缓存。 */
  snapshotId(): Promise<string | null>;
  readReviewersText(): Promise<string | null>;
  readFindingText(findingId: string): Promise<string | null>;
}

/** 创建时固定 HEAD，后续共享读取不受工作区改动或 HEAD 前进影响。 */
export class GitHeadCandidateSource implements SharedCandidateSource {
  private constructor(
    private readonly root: string,
    private readonly snapshot: string,
  ) {}

  /** 没有提交历史时无共享视图，调用方可回退到文件系统视图。 */
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
    // ls-tree 需要尾斜杠才能输出目录内条目。
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

  /** 批量检测减少逐候选子进程，失败时由调用方逐项重试。工作区状态独立于共享版本，不能按快照缓存。 */
  async localChangedCandidateIds(): Promise<Set<string> | null> {
    const result = await git(this.root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.ai-review']);
    if (result.code !== 0) return null;
    const ids = new Set<string>();
    for (const record of result.stdout.split('\0')) {
      if (record.length === 0) continue;
      // porcelain 的重命名记录后还跟着一个无状态前缀的原路径。-z 使这些路径无须反转义。
      const pathText = record.length > 3 && record[2] === ' ' ? record.slice(3) : record;
      const match = /^\.ai-review\/(\d{4}-\d{2})\/([^/]+)(?:\/|$)/.exec(pathText);
      if (match) ids.add(`${match[1]}/${match[2]}`);
    }
    return ids;
  }

  async listLocalOnlyDirs(): Promise<string[]> {
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

  async readFindingText(findingId: string): Promise<string | null> {
    return this.show(findingRecordPath(findingId));
  }

  private async show(relPath: string): Promise<string | null> {
    const result = await git(this.root, ['show', `${this.snapshot}:${relPath}`]);
    if (result.code === 0) return result.stdout;
    const diagnostic = result.stderr.trim();
    if (/does not exist|exists on disk, but not in|not in .*snapshot/i.test(diagnostic)) return null;
    throw new Error(`无法读取共享文件 ${relPath}：${diagnostic}`);
  }
}

/** SVN 的父目录修订不会随子路径提交前进，因此须按相关版本化路径选择读取版本，根修订也不能用作缓存键。 */
export class SvnBaseCandidateSource implements SharedCandidateSource {
    private snapshot: Promise<{ revision: string; url: string; files: Set<string> } | null> | undefined;

  constructor(private readonly root: string) {}

  async snapshotId(): Promise<string | null> {
    return null;
  }

  async listCandidateDirs(): Promise<string[]> {
    const snapshot = await this.sharedSnapshot();
    return [...snapshot?.files ?? []].flatMap((file) => {
        const match = /^(\d{4}-\d{2})\/([^/]+)\/review\.md$/.exec(file);
        return match ? [`${match[1]}/${match[2]}`] : [];
    });
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    const snapshot = await this.sharedSnapshot();
    const prefix = `${month}/${slug}/`;
    const entries = new Set([...snapshot?.files ?? []].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0] ?? ''));
    return entries.size > 0 ? [...entries] : null;
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

  /** 批量状态读取失败时由调用方回退逐候选检测。 */
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
    return listWorktreeCandidateDirs(this.root);
  }

  async listAuditDirs(): Promise<string[]> {
    const snapshot = await this.sharedSnapshot();
    return [...snapshot?.files ?? []].flatMap((file) => /^audits\/([^/]+)\/audit\.md$/.exec(file)?.[1] ?? []);
  }

  async readAuditText(dirName: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/audits/${dirName}/audit.md`);
  }

  async readReviewersText(): Promise<string | null> {
    return this.readSharedFile('.ai-review/reviewers.yml');
  }

  async readFindingText(findingId: string): Promise<string | null> {
    return this.readSharedFile(findingRecordPath(findingId), true);
  }

  /** 只有版本一致且无本地改动的路径可直接读工作副本，从而避免为每个文件访问远端。 */
  private async readSharedFile(relPath: string, strict = false): Promise<string | null> {
    const snapshot = await this.sharedSnapshot();
    if (!snapshot?.files.has(relPath.replace(/^\.ai-review\//, ''))) return null;
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
    if (await this.canReadLocalShared(dir, snapshot.revision)) {
      try {
        return await readFile(path.join(this.root, relPath), 'utf8');
      } catch {
      }
    }
    const url = `${snapshot.url}/${relPath.replace(/^\.ai-review\//, '').split('/').map(encodeURIComponent).join('/')}`;
    const result = await svn(this.root, ['cat', '-r', snapshot.revision, '--', `${url}@${snapshot.revision}`]);
    if (strict && result.code !== 0) throw new Error(`无法读取共享文件 ${relPath}：${result.stderr.trim()}`);
    return result.code === 0 ? result.stdout : null;
  }

  private async canReadLocalShared(dir: string, revision: string): Promise<boolean> {
    const status = await svn(this.root, ['status', '--xml', '--', dir]);
    if (status.code !== 0 || /<entry\b/.test(status.stdout)) return false;
    const info = await svn(this.root, ['info', '--xml', '-R', '--', dir]);
    if (info.code !== 0) return false;
    const revisions = [...info.stdout.matchAll(/<entry\b([^>]*)>/g)].map((match) => /\brevision="(\d+)"/.exec(match[1] ?? '')?.[1]);
    return revisions.length > 0 && revisions.every((value) => value === revision);
  }

    private sharedSnapshot(): Promise<{ revision: string; url: string; files: Set<string> } | null> {
        return this.snapshot ??= this.captureSnapshot();
    }

    private async captureSnapshot(): Promise<{ revision: string; url: string; files: Set<string> } | null> {
        const info = await svn(this.root, ['info', '--xml', '-R', '--', '.ai-review']);
        if (info.code !== 0) {
            const parent = await svn(this.root, ['info', '--xml', '--depth', 'immediates', '--', '.']);
            const versioned = [...parent.stdout.matchAll(/<entry\b([^>]*)>/g)].some((match) => {
                const entryPath = /\bpath="([^"]+)"/.exec(match[1] ?? '')?.[1] ?? '';
                return path.resolve(this.root, entryPath) === path.join(this.root, '.ai-review');
            });
            if (parent.code === 0 && !versioned) return null;
            throw new Error(`无法读取 .ai-review 版本信息：${info.stderr.trim()}`);
        }
        let latest = 0;
        let url = '';
        for (const match of info.stdout.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
            const revision = Number(/\brevision="(\d+)"/.exec(match[1] ?? '')?.[1] ?? 0);
            if (!Number.isSafeInteger(revision) || revision <= 0 || /<schedule>add<\/schedule>/.test(match[2] ?? '')) continue;
            latest = Math.max(latest, revision);
            const entryPath = /\bpath="([^"]+)"/.exec(match[1] ?? '')?.[1]?.replaceAll('\\', '/');
            if (entryPath === '.ai-review') url = /<url>([^<]+)<\/url>/.exec(match[2] ?? '')?.[1]?.replaceAll('&amp;', '&') ?? '';
        }
        if (!latest || !url) return null;
        const revision = String(latest);
        const list = await svn(this.root, ['list', '--xml', '-R', '-r', revision, '--', `${url}@${revision}`]);
        if (list.code !== 0) throw new Error(`无法读取 .ai-review 共享快照：${list.stderr.trim()}`);
        const files = new Set<string>();
        for (const match of list.stdout.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
            if (!/\bkind="file"/.test(match[1] ?? '')) continue;
            const name = /<name>([^<]+)<\/name>/.exec(match[2] ?? '')?.[1]?.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? '');
            if (name) files.add(name);
        }
        return { revision, url, files };
    }
}
