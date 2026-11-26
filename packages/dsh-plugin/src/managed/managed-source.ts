import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { GitHeadCandidateSource, SvnBaseCandidateSource, type SharedCandidateSource } from '../host/shared-facts.js';
import { runProcess } from '../host/shell.js';

export class SvnRevisionSource extends SvnBaseCandidateSource {
  constructor(private readonly cwd: string, private readonly url: string, private readonly revision: string) {
    super(cwd);
  }

  override async snapshotId(): Promise<string> {
    return `${this.url}@${this.revision}`;
  }

  private async remote(operation: 'list' | 'cat', relative: string, recursive = false): Promise<string | null> {
    const url = `${this.url}/${relative.split('/').map(encodeURIComponent).join('/')}@${this.revision}`;
    const result = await runProcess(
      'svn',
      ['--non-interactive', operation, '-r', this.revision, ...(recursive ? ['-R'] : []), '--', url],
      { cwd: this.cwd, timeoutMs: 180000, maxBytes: 16 * 1024 * 1024 },
    );
    if (result.code === 0) return result.stdout;
    if (/E160013|W160013|E200009/.test(result.stderr)) return null;
    throw new Error(`读取 SVN 固定版本失败：${result.stderr.trim()}`);
  }

  private async remoteBytes(relative: string): Promise<Buffer | null> {
    const url = `${this.url}/${relative.split('/').map(encodeURIComponent).join('/')}@${this.revision}`;
    return new Promise((resolve, reject) => {
      const child = spawn('svn', ['--non-interactive', 'cat', '-r', this.revision, '--', url], {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let total = 0;
      const limit = 16 * 1024 * 1024;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`读取 SVN 固定版本字节超时：${relative}`));
      }, 180000);
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total <= limit) out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          if (total > limit) reject(new Error(`SVN 文件超过大小限制：${relative}`));
          else resolve(Buffer.concat(out));
          return;
        }
        const stderr = Buffer.concat(err).toString('utf8');
        if (/E160013|W160013|E200009/.test(stderr)) resolve(null);
        else reject(new Error(`读取 SVN 固定版本失败：${stderr.trim()}`));
      });
    });
  }

  override async listCandidateDirs(): Promise<string[]> {
    const listing = await this.remote('list', '.ai-review', true);
    return [...new Set((listing ?? '').split(/\r?\n/).flatMap((line) => {
      const match = /^(\d{4}-\d{2}\/[^/]+)\/review\.md$/.exec(line.trim());
      return match ? [match[1]!] : [];
    }))];
  }

  override async listTopLevelReviewEntries(): Promise<string[]> {
    const listing = await this.remote('list', '.ai-review', false);
    return (listing ?? '').split(/\r?\n/).map((line) => line.trim().replace(/\/$/, '')).filter(Boolean).sort();
  }

  override async listDirEntries(month: string, slug: string): Promise<string[] | null> {
    const result = await this.remote('list', `.ai-review/${month}/${slug}`);
    return result === null ? null : result.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, '')).filter(Boolean);
  }

  override readReviewText(month: string, slug: string) {
    return this.remote('cat', `.ai-review/${month}/${slug}/review.md`);
  }

  override readPatchBytes(month: string, slug: string, name: string) {
    return this.remoteBytes(`.ai-review/${month}/${slug}/${name}`);
  }

  override async readPatchText(month: string, slug: string, name: string) {
    const bytes = await this.readPatchBytes(month, slug, name);
    return bytes === null ? null : bytes.toString('utf8');
  }

  override readReviewersText() {
    return this.remote('cat', '.ai-review/reviewers.yml');
  }

  override readAuditText(name: string) {
    return this.remote('cat', `.ai-review/audits/${name}/audit.md`);
  }

  override async listAuditDirs(): Promise<string[]> {
    return (await this.remote('list', '.ai-review/audits') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\/$/, ''))
      .filter(Boolean);
  }
}

export async function managedSource(root: string, type: 'git' | 'svn'): Promise<{ source: SharedCandidateSource; identity: string }> {
  let source: SharedCandidateSource;
  if (type === 'git') {
    const pinned = await GitHeadCandidateSource.create(root);
    if (!pinned) throw new Error('Git 仓库尚无共享提交');
    source = pinned;
  } else {
    const run = (args: string[]) => runProcess('svn', ['--non-interactive', ...args], { cwd: root, timeoutMs: 180000, maxBytes: 16 * 1024 * 1024 });
    const location = await run(['info', '--show-item', 'url', '.']);
    if (location.code !== 0) throw new Error('无法读取 SVN 工作副本地址');
    const url = location.stdout.trim();
    const revision = await run(['info', '--show-item', 'revision', `${url}@HEAD`]);
    if (revision.code !== 0 || !/^\d+$/.test(revision.stdout.trim())) throw new Error('无法固定 SVN 远端版本');
    source = new SvnRevisionSource(root, url, revision.stdout.trim());
  }
  const status = await runProcess(
    type,
    type === 'git' ? ['status', '--porcelain', '--untracked-files=all', '--', '.ai-review'] : ['status', '--xml', '.ai-review'],
    { cwd: root, timeoutMs: 180000, maxBytes: 16 * 1024 * 1024 },
  );
  if (status.code !== 0) throw new Error('无法核验评审工作副本状态');
  const identity = `${await source.snapshotId()}:${createHash('sha256').update(status.stdout).digest('hex')}`;
  return { source, identity };
}
