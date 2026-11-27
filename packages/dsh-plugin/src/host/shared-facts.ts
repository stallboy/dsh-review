import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemCandidateSource, type CandidateSource } from './store.js';
import { runProcess, runProcessBuffer, type ProcessResult } from './shell.js';

function listWorktreeCandidateDirs(root: string): Promise<string[]> {
  return new FilesystemCandidateSource(root).listCandidateDirs();
}

const VCS_TIMEOUT_MS = 180_000;
const MAX_BYTES = 8 * 1024 * 1024;

async function git(root: string, args: string[]): Promise<ProcessResult> {
  return runProcess(
    'git',
    ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
    { cwd: root, timeoutMs: VCS_TIMEOUT_MS, maxBytes: MAX_BYTES },
  );
}

/** 读取二进制精确字节（不做 UTF-8 解码，确保补丁 sha256 与原始字节一致）。 */
async function gitShowBytes(root: string, spec: string): Promise<Buffer | null> {
  const result = await runProcessBuffer('git', ['--no-optional-locks', 'show', spec], {
    cwd: root,
    timeoutMs: VCS_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
  });
  if (result.timedOut) throw new Error(`读取共享字节超时：${spec}`);
  if (result.overflowed) throw new Error(`共享文件超出大小上限：${spec}`);
  if (result.error) throw new Error(result.error);
  if (result.code === 0) return result.stdout;
  const diagnostic = result.stderr.trim();
  if (/does not exist|exists on disk, but not in|not in .*snapshot/i.test(diagnostic)) {
    return null;
  }
  throw new Error(`无法读取共享文件 ${spec}：${diagnostic}`);
}

async function svn(root: string, args: string[]): Promise<ProcessResult> {
  return runProcess('svn', ['--non-interactive', ...args], { cwd: root, timeoutMs: VCS_TIMEOUT_MS, maxBytes: MAX_BYTES });
}

async function svnCatBytes(root: string, revision: string, url: string): Promise<Buffer | null> {
  const result = await runProcessBuffer('svn', ['--non-interactive', 'cat', '-r', revision, '--', `${url}@${revision}`], {
    cwd: root,
    timeoutMs: VCS_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
  });
  if (result.timedOut) throw new Error(`读取 SVN 共享字节超时：${url}`);
  if (result.overflowed) throw new Error(`SVN 共享文件超出大小上限：${url}`);
  if (result.error) throw new Error(result.error);
  if (result.code === 0) return result.stdout;
  const diagnostic = result.stderr.trim();
  if (/E160013|W160013|E200009|E155010/i.test(diagnostic)) return null;
  throw new Error(`无法读取 SVN 共享文件 ${url}：${diagnostic}`);
}

export interface AuditSnapshotSource {
  listAuditDirs(): Promise<string[]>;
  readAuditText(dirName: string): Promise<string | null>;
}

export interface SharedCandidateSource extends CandidateSource, AuditSnapshotSource {
  snapshotId(): Promise<string | null>;
  readReviewersText(): Promise<string | null>;
  listTopLevelReviewEntries?(): Promise<string[]>;
}

export class GitHeadCandidateSource implements SharedCandidateSource {
  private constructor(
    private readonly root: string,
    private readonly snapshot: string,
  ) {}

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

  async listTopLevelReviewEntries(): Promise<string[]> {
    const names = new Set<string>();
    const result = await git(this.root, ['ls-tree', '--name-only', this.snapshot, '--', '.ai-review/']);
    if (result.code === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('.ai-review/')) {
          const name = trimmed.slice('.ai-review/'.length).replace(/\/$/, '');
          if (name && !name.includes('/')) names.add(name);
        }
      }
    }
    try {
      for (const entry of await readdir(path.join(this.root, '.ai-review'))) {
        names.add(entry);
      }
    } catch {
    }
    return [...names].sort();
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
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

  async readPatchBytes(month: string, slug: string, patchName: string): Promise<Buffer | null> {
    return gitShowBytes(this.root, `${this.snapshot}:.ai-review/${month}/${slug}/${patchName}`);
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    const bytes = await this.readPatchBytes(month, slug, patchName);
    return bytes === null ? null : bytes.toString('utf8');
  }

  async hasLocalChanges(month: string, slug: string): Promise<boolean> {
    const result = await git(this.root, ['status', '--porcelain', '--', `.ai-review/${month}/${slug}`]);
    if (result.code !== 0) throw new Error(`无法证明候选本地状态：${result.stderr.trim()}`);
    return result.stdout.trim().length > 0;
  }

  async localChangedCandidateIds(): Promise<Set<string> | null> {
    const result = await git(this.root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.ai-review']);
    if (result.code !== 0) return null;
    const ids = new Set<string>();
    for (const record of result.stdout.split('\0')) {
      if (record.length === 0) continue;
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

  private async show(relPath: string): Promise<string | null> {
    const bytes = await gitShowBytes(this.root, `${this.snapshot}:${relPath}`);
    return bytes === null ? null : bytes.toString('utf8');
  }
}

export class SvnBaseCandidateSource implements SharedCandidateSource {
  private snapshot: Promise<{ revision: string; url: string; files: Set<string> } | null> | undefined;

  constructor(private readonly root: string) {}

  async snapshotId(): Promise<string | null> {
    const snapshot = await this.sharedSnapshot();
    return snapshot ? `${snapshot.url}@${snapshot.revision}` : null;
  }

  async listCandidateDirs(): Promise<string[]> {
    const snapshot = await this.sharedSnapshot();
    return [...(snapshot?.files ?? [])].flatMap((file) => {
      const match = /^(\d{4}-\d{2})\/([^/]+)\/review\.md$/.exec(file);
      return match ? [`${match[1]}/${match[2]}`] : [];
    });
  }

  async listTopLevelReviewEntries(): Promise<string[]> {
    const names = new Set<string>();
    const snapshot = await this.sharedSnapshot();
    for (const file of snapshot?.files ?? []) {
      const first = file.split('/')[0];
      if (first) names.add(first);
    }
    try {
      for (const entry of await readdir(path.join(this.root, '.ai-review'))) {
        names.add(entry);
      }
    } catch {
    }
    return [...names].sort();
  }

  async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    const snapshot = await this.sharedSnapshot();
    const prefix = `${month}/${slug}/`;
    const entries = new Set(
      [...(snapshot?.files ?? [])]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/')[0] ?? ''),
    );
    return entries.size > 0 ? [...entries] : null;
  }

  async readReviewText(month: string, slug: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/${month}/${slug}/review.md`);
  }

  async readPatchBytes(month: string, slug: string, patchName: string): Promise<Buffer | null> {
    return this.readSharedBytes(`.ai-review/${month}/${slug}/${patchName}`);
  }

  async readPatchText(month: string, slug: string, patchName: string): Promise<string | null> {
    const bytes = await this.readPatchBytes(month, slug, patchName);
    return bytes === null ? null : bytes.toString('utf8');
  }

  async hasLocalChanges(month: string, slug: string): Promise<boolean> {
    const result = await svn(this.root, ['status', '--xml', `.ai-review/${month}/${slug}`]);
    if (result.code !== 0) throw new Error(`无法证明候选本地状态：${result.stderr.trim()}`);
    return /<entry\b/.test(result.stdout);
  }

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
    return [...(snapshot?.files ?? [])].flatMap((file) => /^audits\/([^/]+)\/audit\.md$/.exec(file)?.[1] ?? []);
  }

  async readAuditText(dirName: string): Promise<string | null> {
    return this.readSharedFile(`.ai-review/audits/${dirName}/audit.md`);
  }

  async readReviewersText(): Promise<string | null> {
    return this.readSharedFile('.ai-review/reviewers.yml');
  }

  private async readSharedBytes(relPath: string): Promise<Buffer | null> {
    const snapshot = await this.sharedSnapshot();
    if (!snapshot?.files.has(relPath.replace(/^\.ai-review\//, ''))) return null;
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
    if (await this.canReadLocalShared(dir, snapshot.revision)) {
      try {
        return await readFile(path.join(this.root, relPath));
      } catch {
      }
    }
    const url = `${snapshot.url}/${relPath.replace(/^\.ai-review\//, '').split('/').map(encodeURIComponent).join('/')}`;
    return svnCatBytes(this.root, snapshot.revision, url);
  }

  private async readSharedFile(relPath: string): Promise<string | null> {
    const bytes = await this.readSharedBytes(relPath);
    return bytes === null ? null : bytes.toString('utf8');
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
    return (this.snapshot ??= this.captureSnapshot());
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
      const name = /<name>([^<]+)<\/name>/.exec(match[2] ?? '')?.[1]?.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? '',
      );
      if (name) files.add(name);
    }
    return { revision, url, files };
  }
}
