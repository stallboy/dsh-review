/**
 * SVN VCS 适配器：
 * 封装干净工作区检测（含 .tmp）、提交探针、严格批准补丁应用与逐项核验提交。
 */

import { createReadStream, existsSync } from 'node:fs';
import { lstat, readFile, readlink, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildHunkFallbackDiff, isAiReviewPath, parsePatch } from './patch.js';
import { runProcess, runProcessBuffer, tailLines, type ProcessResult } from './shell.js';
import type { ApplyPatchResult, ApprovalCommitLookup, AuthorStatBucket, AuthorStats, InterRevisionDiff } from './types.js';
import { deriveSvnApprovalCommit } from './vcs-commit-derive.js';
import {
  acceptedDirtyPath,
  describeProcess,
  gitBlobHash,
  hasTmpDir,
  normalizeCommitPath,
  svn,
  svnRepoPathToRelative,
  toRepoRelative,
  VCS_TIMEOUT_MS,
  type ApprovalDeriveInput,
  type ApprovalPatchAttempt,
  type CleanResult,
  type CommitInput,
  type CommitResult,
  type DiffInput,
  type SyncResult,
  type VcsAdapter,
} from './vcs-types.js';

const SVN_APPROVAL_PATCH_LIMIT = 8 * 1024 * 1024;

export function svnPatchReportsConflict(output: string): boolean {
  return /^(?:Skipped\b|C[ \t]|.C[ \t]|Summary of conflicts:)/m.test(output);
}

const SVN_PATCH_FUZZ = /^>[ \t]+applied hunk\b[^\r\n]*\bfuzz [1-9]\d*\b/m;

export function classifySvnApprovalPatch(
  result: ProcessResult,
  maxBytes = SVN_APPROVAL_PATCH_LIMIT,
): 'complete' | 'conflict' | 'unknown' {
  if (
    result.timedOut
    || result.aborted
    || result.signal
    || result.error
    || Buffer.byteLength(result.stdout) >= maxBytes
    || Buffer.byteLength(result.stderr) >= maxBytes
  ) {
    return 'unknown';
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (svnPatchReportsConflict(output) || SVN_PATCH_FUZZ.test(output) || /^>[ \t].*\balready applied\b/m.test(output)) {
    return 'conflict';
  }
  if (/^>[ \t](?![ \t]*applied hunk\b[^\r\n]*\bwith offset -?\d+[ \t]*\r?$)/m.test(output)) return 'unknown';
  return result.code === 0 && result.stdout.trim() && !result.stderr.trim() ? 'complete' : 'unknown';
}

function parseSvnStatusEntries(output: string): { state: string; path: string }[] {
  return output
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0 && line.length > 8)
    .map((line) => ({ state: line.slice(0, 1), path: toRepoRelative(line.slice(8).trim()) }))
    .filter((entry) => entry.path.length > 0);
}

function parseSvnStatus(output: string): string[] {
  return parseSvnStatusEntries(output).map((entry) => entry.path);
}

function svnXmlText(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '',
  );
}

function svnXmlAttribute(value: string, name: string): string {
  return svnXmlText(new RegExp(`\\b${name}="([^"]*)"`).exec(value)?.[1] ?? '');
}

function svnProperties(output: string): Map<string, string> {
  return new Map(
    [...output.matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)]
      .map((match) => [svnXmlAttribute(match[1] ?? '', 'name'), svnXmlText(match[2] ?? '')]),
  );
}

function svnCommitStates(root: string, output: string): Map<string, { state: string; properties: string; copied: boolean }> {
  const states = new Map<string, { state: string; properties: string; copied: boolean }>();
  for (const match of output.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
    const attributes = /<wc-status\b([^>]*)>/.exec(match[2] ?? '')?.[1] ?? '';
    states.set(normalizeCommitPath(root, svnXmlAttribute(match[1] ?? '', 'path')), {
      state: svnXmlAttribute(attributes, 'item'),
      properties: svnXmlAttribute(attributes, 'props'),
      copied: svnXmlAttribute(attributes, 'copied') === 'true',
    });
  }
  return states;
}

async function svnApprovalSnapshot(root: string, paths: string[]) {
  const targets = paths.map((file) => (file.includes('@') ? `${file}@` : file));
  const status = await svn(root, ['status', '--xml', '--verbose', '--no-ignore', '--ignore-externals', '--depth', 'empty', '--', ...targets]);
  if (status.code !== 0 || !/<\/status>\s*$/.test(status.stdout) || Buffer.byteLength(status.stdout) >= SVN_APPROVAL_PATCH_LIMIT) {
    throw new Error(`无法核对 SVN 补丁范围：${describeProcess(status)}`);
  }
  const entries = new Map<string, Record<string, string>>();
  for (const match of status.stdout.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
    const attributes = /<wc-status\b([^>]*)>/.exec(match[2] ?? '')?.[1] ?? '';
    const fields = [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)]
      .map((field) => [field[1]!, svnXmlText(field[2]!)])
      .sort(([left], [right]) => left!.localeCompare(right!));
    entries.set(toRepoRelative(svnXmlAttribute(match[1] ?? '', 'path')), Object.fromEntries(fields));
  }
  const files = await Promise.all(paths.map(async (file) => {
    const absolute = path.join(root, file);
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    let contents: string | null = null;
    if (info?.isSymbolicLink()) contents = await readlink(absolute);
    if (info?.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      contents = hash.digest('hex');
    }
    return { file, entry: entries.get(file), mode: info?.mode, directory: info?.isDirectory(), contents };
  }));
  const versioned = files.filter((file) => file.entry && !['unversioned', 'ignored', 'external'].includes(file.entry['item'] ?? ''));
  if (versioned.length === 0) return { files, diff: '' };
  const diff = await svn(root, ['diff', '--git', '--depth', 'empty', '--', ...versioned.map((file) => file.file)]);
  if (diff.code !== 0 || Buffer.byteLength(diff.stdout) >= SVN_APPROVAL_PATCH_LIMIT) {
    throw new Error(`无法核对 SVN 补丁内容与属性：${describeProcess(diff)}`);
  }
  return { files, diff: diff.stdout };
}

async function svnContentHash(root: string, revision: string, target: string, size: number): Promise<string | null> {
  const result = await runProcessBuffer(
    'svn',
    ['--non-interactive', 'cat', '--ignore-keywords', '-r', revision, '--', `${target}@${revision}`],
    { cwd: root, timeoutMs: VCS_TIMEOUT_MS, maxBytes: Math.max(8 * 1024 * 1024, size + 65_536) },
  );
  if (result.timedOut || result.aborted || result.overflowed || result.code !== 0) return null;
  if (result.stdout.length !== size) return null;
  return gitBlobHash(result.stdout);
}

export class SvnAdapter implements VcsAdapter {
  readonly type = 'svn' as const;

  constructor(readonly root: string) {}

  async ensureCleanWorkspace(): Promise<CleanResult> {
    const result = await svn(this.root, ['status']);
    if (result.code !== 0) {
      return { clean: false, dirtyPaths: [], message: `无法读取 svn 状态：${describeProcess(result)}` };
    }
    const dirtyPaths = parseSvnStatus(result.stdout).filter(acceptedDirtyPath);
    if (await hasTmpDir(this.root)) {
      if (!dirtyPaths.includes('.tmp')) dirtyPaths.push('.tmp');
    }
    if (dirtyPaths.length === 0) return { clean: true, dirtyPaths, message: '工作区干净（忽略 .ai-review 数据）' };
    return {
      clean: false,
      dirtyPaths: dirtyPaths.slice(0, 50),
      message: `工作区存在未提交改动：\n${dirtyPaths.slice(0, 20).join('\n')}`,
    };
  }

  async getCurrentBase(): Promise<string | null> {
    const result = await svn(this.root, ['info', '--show-item', 'revision']);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  /** SVN 工作副本根 revision 不随子路径提交前进。未进入版本管理的路径用最近已版本化祖先定位。 */
  async getCommitProbe(paths: string[]): Promise<string | null> {
    let best = 0;
    const visited = new Set<string>();
    for (const raw of paths) {
      let current = toRepoRelative(raw);
      for (;;) {
        const target = current.length > 0 ? current : '.';
        if (visited.has(target)) break;
        visited.add(target);
        const revision = await this.lastChangedRevision(target);
        if (revision !== null) {
          best = Math.max(best, revision);
          break;
        }
        if (current.length === 0) break;
        const slash = current.lastIndexOf('/');
        current = slash >= 0 ? current.slice(0, slash) : '';
      }
    }
    return best > 0 ? String(best) : null;
  }

  async readFileAt(revision: string, relPath: string): Promise<string | null> {
    const rev = revision.trim();
    if (!/^\d+$/.test(rev)) return null;
    const target = toRepoRelative(relPath);
    if (target.length === 0) return null;
    const result = await svn(this.root, ['cat', '-r', rev, '--', `${target}@${rev}`]);
    return result.code === 0 ? result.stdout : null;
  }

  async getRemoteCommitProbe(file: string): Promise<string | null> {
    const relative = toRepoRelative(file);
    if (!relative) return null;
    const info = await svn(this.root, ['info', '--show-item', 'url', '--', '.']);
    if (info.code !== 0 || !info.stdout.trim()) return null;
    const url = `${info.stdout.trim().replace(/\/$/, '')}/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const result = await svn(this.root, ['info', '-r', 'HEAD', '--show-item', 'last-changed-revision', '--', `${url}@HEAD`]);
    const revision = result.stdout.trim();
    return result.code === 0 && /^\d+$/.test(revision) ? revision : null;
  }

  async authorStats(paths: string[], limit = 500): Promise<AuthorStats> {
    const scoped = [...new Set(paths.map(toRepoRelative).filter((item) => item.length > 0 && !isAiReviewPath(item)))];
    const scope: AuthorStats['scope'] = scoped.length > 0 ? 'tracked' : 'repo';
    const statusResult = await svn(this.root, ['status']);
    const pendingFiles = statusResult.code === 0 ? parseSvnStatus(statusResult.stdout).filter(acceptedDirtyPath).length : 0;
    const args = ['log', '--xml', '-l', String(Math.max(1, Math.trunc(limit)))];
    const usable = scoped.filter((item) => !item.startsWith('-'));
    if (usable.length > 0) args.push(...usable);
    const logResult = await svn(this.root, args);
    if (logResult.code !== 0) {
      return { buckets: [], historyCommits: 0, pendingFiles, diagnostic: describeProcess(logResult).slice(0, 200), scope };
    }
    const counts = new Map<string, number>();
    for (const match of logResult.stdout.matchAll(/<logentry\b[\s\S]*?<\/logentry>/g)) {
      const author = /<author>([\s\S]*?)<\/author>/.exec(match[0])?.[1]?.trim() ?? '';
      const key = author || '(未署名)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const buckets: AuthorStatBucket[] = [...counts.entries()]
      .map(([name, commits]) => ({ name, email: '', commits }))
      .sort((left, right) => right.commits - left.commits || left.name.localeCompare(right.name));
    return {
      buckets,
      historyCommits: buckets.reduce((sum, bucket) => sum + bucket.commits, 0),
      pendingFiles,
      scope,
    };
  }

  /** 日志区间排除起始版本，避免把原基线提交本身的变化计入结果。 */
  async businessChangesBetween(fromRevision: string, toRevision: string): Promise<string[] | null> {
    const from = fromRevision.trim();
    const to = toRevision.trim();
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return null;
    const fromNumber = Number(from);
    const toNumber = Number(to);
    if (!Number.isSafeInteger(fromNumber) || !Number.isSafeInteger(toNumber)) return null;
    if (fromNumber === toNumber) return [];
    if (toNumber < fromNumber) return null;
    const result = await svn(this.root, ['log', '-v', '--xml', '-r', `${String(fromNumber + 1)}:${String(toNumber)}`]);
    if (result.code !== 0) return null;
    const prefix = await svn(this.root, ['info', '--show-item', 'relative-url', '--', '.']);
    if (prefix.code !== 0) return null;
    const changes = new Set<string>();
    for (const match of result.stdout.matchAll(/<path\b[^>]*\baction="([^"]+)"[^>]*>([^<]+)<\/path>/g)) {
      const action = (match[1] ?? '').toUpperCase();
      const repoPath = (match[2] ?? '').trim();
      if (action === 'M' && repoPath.startsWith('svn:')) continue;
      const relative = svnRepoPathToRelative(prefix.stdout, repoPath);
      if (relative === null || relative === '.') continue;
      changes.add(relative);
    }
    return [...changes].filter((relative) => !relative.startsWith('.ai-review/') && relative !== '.ai-review');
  }

  private async lastChangedRevision(target: string): Promise<number | null> {
    const result = await svn(this.root, ['info', '--show-item', 'last-changed-revision', '--', target]);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    if (!/^\d+$/.test(value)) return null;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  deriveApprovalCommit(input: ApprovalDeriveInput): Promise<ApprovalCommitLookup> {
    return deriveSvnApprovalCommit(this, input);
  }

  async syncAndGetLatestBase(): Promise<SyncResult> {
    const before = await this.getCurrentBase();
    const update = await svn(this.root, ['update']);
    if (update.code !== 0) {
      return { base: before, synced: false, failed: true, message: `同步失败：svn update 失败：${describeProcess(update)}` };
    }
    const base = await this.getCurrentBase();
    if (base === null) {
      return { base: null, synced: false, uncertain: true, message: '同步后无法读取工作副本 revision，基线状态不明' };
    }
    return {
      base,
      synced: base !== before,
      message: base === before ? '已是最新基线' : `已同步到 r${String(base)}`,
    };
  }

  async applyPatch(patchPath: string, _threeWay = false): Promise<ApplyPatchResult> {
    if (!existsSync(patchPath)) return { ok: false, conflict: false, message: `补丁不存在：${patchPath}` };
    const result = await svn(this.root, ['patch', patchPath]);
    if (result.code === 0) return { ok: true, conflict: false, message: '补丁已应用（svn patch）' };
    return { ok: false, conflict: true, message: tailLines(describeProcess(result), 80) };
  }

  async applyPatchForApproval(patchPath: string, signal?: AbortSignal): Promise<ApprovalPatchAttempt> {
    const options = {
      cwd: this.root,
      timeoutMs: VCS_TIMEOUT_MS,
      maxBytes: SVN_APPROVAL_PATCH_LIMIT,
      env: { LC_ALL: '', LC_MESSAGES: 'C', LANGUAGE: 'C' },
      ...(signal ? { signal } : {}),
    };
    const check = await runProcess('svn', ['--non-interactive', 'patch', '--dry-run', '--', patchPath], options);
    const checked = classifySvnApprovalPatch(check);
    if (checked !== 'complete') {
      const diagnostics = `${check.stdout}\n${check.stderr}`;
      const canMerge = checked === 'conflict'
        && (SVN_PATCH_FUZZ.test(diagnostics) || /^>[ \t]+rejected hunk\b/m.test(diagnostics))
        && !/^(?:Skipped\b|>[ \t].*\balready applied\b)/m.test(diagnostics);
      return { ok: false, conflict: checked === 'conflict', workspace: 'untouched', canMerge, message: tailLines(describeProcess(check), 80) };
    }
    let paths: string[];
    let before: Awaited<ReturnType<typeof svnApprovalSnapshot>>;
    try {
      const targets = parsePatch(await readFile(path.resolve(this.root, patchPath), 'utf8')).paths;
      if (!targets.length || targets.some((file) => file !== toRepoRelative(file)
        || file.split('/').some((part) => part === '..' || part === '.') || /[:\r\n\0]/.test(file))) {
        throw new Error('无法确定 SVN 补丁的工作副本内路径');
      }
      paths = [...new Set(targets.flatMap((file) => file.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))))];
      before = await svnApprovalSnapshot(this.root, paths);
      if (before.diff || before.files.some((file) => (file.entry
        ? file.entry['item'] !== 'normal' || file.entry['switched'] === 'true'
        : file.mode !== undefined))) {
        throw new Error('SVN 补丁范围在应用前已发生变化');
      }
    } catch (error) {
      return { ok: false, conflict: false, workspace: 'untouched', message: String(error) };
    }
    const applied = await runProcess('svn', ['--non-interactive', 'patch', '--', patchPath], options);
    const status = classifySvnApprovalPatch(applied);
    if (status !== 'complete') {
      return { ok: false, conflict: status === 'conflict', workspace: 'unknown', message: tailLines(describeProcess(applied), 80) };
    }
    try {
      const after = await svnApprovalSnapshot(this.root, paths);
      const changed = after.files.filter((file, index) => JSON.stringify(file) !== JSON.stringify(before.files[index]));
      const restore = async (): Promise<void> => {
        if (JSON.stringify(await svnApprovalSnapshot(this.root, paths)) !== JSON.stringify(after)) {
          throw new Error('SVN 补丁路径已发生其他改动');
        }
        for (const file of [...changed].sort((left, right) => right.file.split('/').length - left.file.split('/').length)) {
          const reverted = await svn(this.root, ['revert', '--depth', 'empty', '--', file.file.includes('@') ? `${file.file}@` : file.file]);
          if (reverted.code !== 0) throw new Error(`无法撤销 ${file.file}：${describeProcess(reverted)}`);
          if (before.files.find((entry) => entry.file === file.file)?.mode !== undefined || file.mode === undefined) continue;
          const absolute = path.join(this.root, file.file);
          if (file.directory) await rmdir(absolute);
          else await rm(absolute, { force: true });
        }
        if (JSON.stringify(await svnApprovalSnapshot(this.root, paths)) !== JSON.stringify(before)) {
          throw new Error('SVN 补丁范围未恢复到应用前状态');
        }
      };
      return { ok: true, conflict: false, workspace: 'applied', message: '补丁已完整应用（svn patch）', restore };
    } catch (error) {
      return { ok: false, conflict: false, workspace: 'unknown', message: String(error) };
    }
  }

  async checkPatch(patchPath: string): Promise<ApplyPatchResult> {
    const check = await runProcess('svn', ['--non-interactive', 'patch', '--dry-run', '--', patchPath], {
      cwd: this.root,
      timeoutMs: VCS_TIMEOUT_MS,
      maxBytes: SVN_APPROVAL_PATCH_LIMIT,
      env: { LC_ALL: '', LC_MESSAGES: 'C', LANGUAGE: 'C' },
    });
    const state = classifySvnApprovalPatch(check);
    return { ok: state === 'complete', conflict: state === 'conflict', message: tailLines(describeProcess(check), 80) };
  }

  async exportWorkingTreeDiff(_base: string, paths: string[]): Promise<string> {
    const rel = [...new Set(paths.map((item) => normalizeCommitPath(this.root, item)).filter((item) => item.length > 0))];
    if (rel.length === 0) return '';
    const diff = await svn(this.root, ['diff', '--', ...rel]);
    if (diff.code !== 0) throw new Error(`导出工作区 diff 失败：${describeProcess(diff)}`);
    return diff.stdout;
  }

  private async revertEntries(includeAiReview: boolean): Promise<void> {
    const status = await svn(this.root, ['status']);
    if (status.code !== 0) {
      throw new Error(`svn status 读取失败，无法还原工作区：${describeProcess(status)}`);
    }
    for (const entry of parseSvnStatusEntries(status.stdout)) {
      if (!includeAiReview && !acceptedDirtyPath(entry.path)) continue;
      const absolute = path.isAbsolute(entry.path) ? entry.path : path.join(this.root, entry.path);
      if (entry.state === '?') {
        await rm(absolute, { force: true, recursive: true });
      } else {
        const reverted = await svn(this.root, ['revert', '-R', '--', entry.path]);
        if (reverted.code !== 0) {
          throw new Error(`svn revert ${entry.path} 失败：${describeProcess(reverted)}`);
        }
        // SVN 撤销新增只撤销调度，磁盘仍保留未跟踪文件。
        if (entry.state === 'A') {
          await rm(absolute, { force: true, recursive: true });
        }
      }
    }
    const cleanup = await svn(this.root, ['cleanup']);
    if (cleanup.code !== 0) {
      throw new Error(`svn cleanup 失败：${describeProcess(cleanup)}`);
    }
    await rm(path.join(this.root, '.tmp'), { recursive: true, force: true });
  }

  async revertBusinessWorkspace(): Promise<void> {
    await this.revertEntries(false);
  }

  async revertAllToPreHead(_preHead: string, includeAiReview: boolean): Promise<void> {
    await this.revertEntries(includeAiReview);
  }

  async computeInterRevisionDiff(input: DiffInput): Promise<InterRevisionDiff> {
    return buildHunkFallbackDiff(
      input.fromRevision,
      input.toRevision,
      input.fromBase,
      input.toBase,
      input.fromPatchText,
      input.toPatchText,
      ['SVN 无三方合并能力，跨基线增量对比按 hunk 级回退展示。'],
    );
  }

  async atomicCommit(input: CommitInput): Promise<CommitResult> {
    let commitStarted = false;
    let preparing = false;
    let beforeStates: ReturnType<typeof svnCommitStates> | undefined;
    let preparationScopes: string[] = [];
    const paths = [...new Set(input.paths.filter((item) => item.trim()).map((item) => normalizeCommitPath(this.root, item)))];
    const deletions = [...new Set((input.deletePaths ?? []).map((item) => normalizeCommitPath(this.root, item)))];
    const allowed = [...paths, ...deletions];

    const restorePreparation = async (errorOutput: string): Promise<string> => {
      if (preparing && beforeStates) {
        const current = await svn(this.root, ['status', '--xml', '--verbose', '--ignore-externals', '--', ...preparationScopes]);
        if (current.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(current.stdout)) {
          errorOutput += `\n无法核对本次 SVN 调度以执行恢复：${describeProcess(current)}`;
        } else {
          const states = svnCommitStates(this.root, current.stdout);
          const affected = [...states].filter(([target]) => allowed.some((item) => target === item || target.startsWith(`${item}/`) || item.startsWith(`${target}/`)));
          const additions = affected
            .filter(([target, entry]) => entry.state === 'added' && beforeStates?.get(target)?.state !== 'added')
            .map(([target]) => target)
            .sort((left, right) => right.split('/').length - left.split('/').length);
          const removals = affected
            .filter(([target, entry]) => entry.state === 'deleted' && beforeStates?.get(target)?.state !== 'deleted')
            .map(([target]) => target)
            .sort((left, right) => left.split('/').length - right.split('/').length);
          const missing: string[] = [];
          for (const target of [...removals, ...additions]) {
            const reverted = await svn(this.root, ['revert', '--depth', 'empty', '--', target]);
            if (reverted.code !== 0) {
              errorOutput += `\n无法撤销本次 SVN 调度 ${target}：${describeProcess(reverted)}`;
            } else if (beforeStates.get(target)?.state === 'missing') {
              missing.push(target);
            }
          }
          for (const target of missing) await rm(path.join(this.root, target), { recursive: true, force: true });
        }
      }
      return errorOutput;
    };

    const failure = async (errorOutput: string, commitRevision: string | null = null, verificationFailed = false): Promise<CommitResult> => {
      if (!commitStarted) errorOutput = await restorePreparation(errorOutput);
      return { success: false, commitRevision, outOfDate: false, errorOutput, ...(verificationFailed ? { verificationFailed: true } : {}) };
    };

    if (paths.length === 0) return failure('没有指定要提交的路径');
    if (allowed.some((item) => !item || item === '..' || item.startsWith('../'))) return failure('提交路径必须位于工作副本内');
    preparationScopes = [...new Set(allowed.map((item) => item.split('/')[0] ?? item))];
    const before = await svn(this.root, ['status', '--xml', '--verbose', '--no-ignore', '--ignore-externals', '--', ...preparationScopes]);
    if (before.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(before.stdout)) {
      return failure(`无法保存完整提交前 SVN 调度：${describeProcess(before)}`);
    }
    beforeStates = svnCommitStates(this.root, before.stdout);
    for (const deletion of deletions) {
      if (beforeStates.get(deletion)?.state === 'deleted') continue;
      const dirty = [...beforeStates].find(([target, entry]) => (target === deletion || target.startsWith(`${deletion}/`))
        && (!['normal', 'missing'].includes(entry.state) || entry.properties === 'modified' || entry.copied));
      if (dirty) return failure(`删除路径包含调用前的本地改动，已拒绝提交：${dirty[0]}`);
    }
    preparing = true;
    for (const deletion of deletions) {
      if (beforeStates.get(deletion)?.state === 'deleted') continue;
      const result = await svn(this.root, ['delete', '--force', '--', deletion]);
      if (result.code !== 0) {
        const status = await svn(this.root, ['status', '--xml', '--depth', 'empty', '--', deletion]);
        if (status.code !== 0 || !/item="deleted"/.test(status.stdout)) {
          return failure(`无法安排删除 ${deletion}：${describeProcess(result)}`);
        }
      }
    }
    for (const target of paths) {
      if (!existsSync(path.join(this.root, target))) continue;
      const added = await svn(this.root, ['add', '--force', '--parents', '--', target]);
      if (added.code !== 0) return failure(`无法准备提交路径 ${target}：${describeProcess(added)}`);
    }
    const status = await svn(this.root, ['status', '--xml', '--verbose', '--ignore-externals', '--', ...allowed]);
    if (status.code !== 0 || !/<status>[\s\S]*<\/status>\s*$/.test(status.stdout)) {
      return failure(`无法核对完整提交集合：${describeProcess(status)}`);
    }
    const states = svnCommitStates(this.root, status.stdout);
    const verified = new Map((input.verifyEntries ?? []).map((entry) => [normalizeCommitPath(this.root, entry.path), entry]));
    const verifiedDeletions = new Set((input.verifyDeletions ?? []).map((item) => normalizeCommitPath(this.root, item)));
    const strict = input.verifyEntries !== undefined || input.verifyDeletions !== undefined;
    const commitPaths = new Set<string>();
    const verifiedSizes = new Map<string, number>();
    const propertiesBefore = new Map<string, Map<string, string>>();
    const problems: string[] = [];
    for (const [target, entry] of states) {
      if (!allowed.some((item) => target === item || target.startsWith(`${item}/`))) {
        problems.push(`提交集合包含指定路径之外的条目：${target}`);
        continue;
      }
      if (!['normal', 'added', 'modified', 'replaced', 'deleted'].includes(entry.state)) {
        problems.push(`无法证明提交路径状态：${target}（${entry.state}）`);
        continue;
      }
      const changed = entry.state !== 'normal' || entry.properties === 'modified';
      if (changed) commitPaths.add(target);
      if (entry.state === 'deleted') {
        if (strict && !verifiedDeletions.has(target)) problems.push(`删除未列入核对集合：${target}`);
        continue;
      }
      const stats = await lstat(path.join(this.root, target)).catch(() => null);
      if (!stats || stats.isSymbolicLink()) {
        problems.push(`无法核对普通文件或目录：${target}`);
        continue;
      }
      if (stats.isDirectory()) {
        if (entry.copied) problems.push(`不能证明复制目录的完整提交集合：${target}`);
        if (strict && changed && ![...verified.keys(), ...verifiedDeletions].some((item) => item.startsWith(`${target}/`))) {
          problems.push(`目录未列入核对集合：${target}`);
        }
      } else if (strict && changed && !verified.has(target)) {
        problems.push(`提交条目未列入核对集合：${target}`);
      }
      if (!changed && !verified.has(target)) continue;
      const props = await svn(this.root, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', target]);
      if (props.code !== 0) {
        problems.push(`无法读取提交属性：${target}`);
        continue;
      }
      const currentProperties = svnProperties(props.stdout);
      propertiesBefore.set(target, currentProperties);
      const baseProperties = entry.state === 'added'
        ? null
        : await svn(this.root, ['proplist', '--xml', '--verbose', '-r', 'BASE', '--depth', 'empty', '--', target]);
      if (baseProperties && baseProperties.code !== 0) problems.push(`无法读取基线属性：${target}`);
      const originalProperties = baseProperties ? svnProperties(baseProperties.stdout) : new Map<string, string>();
      for (const name of new Set([...currentProperties.keys(), ...originalProperties.keys()])) {
        if (name === 'svn:executable' && verified.get(target)?.mode && process.platform !== 'win32') continue;
        if (currentProperties.get(name) !== originalProperties.get(name)) problems.push(`属性变更未核对：${target}（${name}）`);
      }
    }
    for (const [target, expected] of verified) {
      const entry = states.get(target);
      if (!entry || entry.state === 'deleted') {
        problems.push(`缺少核对条目：${target}`);
        continue;
      }
      const content = await readFile(path.join(this.root, target)).catch(() => null);
      if (content) verifiedSizes.set(target, content.length);
      const props = propertiesBefore.get(target);
      if (!content || gitBlobHash(content) !== expected.blobHash) problems.push(`提交内容与已审核内容不一致：${target}`);
      const mode = props?.has('svn:executable') ? '100755' : '100644';
      if (process.platform !== 'win32' && expected.mode && mode !== expected.mode) problems.push(`提交模式与已审核模式不一致：${target}`);
      if (props?.has('svn:special')) problems.push(`无法核对 SVN 特殊文件：${target}`);
      if (content && props?.has('svn:eol-style') && content.includes(13)) problems.push(`SVN 换行转换会改变已审核内容：${target}`);
      if (content && props?.has('svn:keywords') && /\$[^$\r\n]+:[^$\r\n]*\$/.test(content.toString('utf8'))) {
        problems.push(`SVN 关键词收缩会改变已审核内容：${target}`);
      }
    }
    for (const target of verifiedDeletions) {
      if (states.get(target)?.state !== 'deleted') problems.push(`删除未生效：${target}`);
    }
    if (problems.length > 0) return failure(`已审核内容与 SVN 提交不一致，已拒绝提交：\n${problems.slice(0, 20).join('\n')}`);
    if (commitPaths.size === 0) return failure('没有可提交的改动');
    for (const target of [...commitPaths]) {
      let ancestor = path.posix.dirname(target);
      while (ancestor !== '.') {
        const state = await svn(this.root, ['status', '--xml', '--depth', 'empty', '--', ancestor]);
        if (state.code !== 0) return failure(`无法核对提交祖先：${ancestor}`);
        if (!/item="added"/.test(state.stdout)) break;
        const props = await svn(this.root, ['proplist', '--xml', '--verbose', '--depth', 'empty', '--', ancestor]);
        if (props.code !== 0 || svnProperties(props.stdout).size > 0 || /copied="true"/.test(state.stdout)) {
          return failure(`无法核对新增祖先目录：${ancestor}`);
        }
        commitPaths.add(ancestor);
        propertiesBefore.set(ancestor, new Map());
        ancestor = path.posix.dirname(ancestor);
      }
    }
    const rootUrl = await svn(this.root, ['info', '--show-item', 'url', '--', '.']);
    const prefix = await svn(this.root, ['info', '--show-item', 'relative-url', '--', '.']);
    if (rootUrl.code !== 0 || prefix.code !== 0) return failure('无法证明 SVN 提交仓库范围');
    commitStarted = true;
    const commit = await svn(this.root, ['commit', '--depth', 'empty', '-m', input.message, '--', ...commitPaths]);
    if (commit.code !== 0) {
      const output = describeProcess(commit);
      const outOfDate = /out of date|E160028|E155011|remains in conflict/i.test(output);
      const rejected = !commit.timedOut && !commit.aborted && commit.code !== null
        && /^svn: E(?:160028|155011):|^svn: E165001:.*pre-commit hook/im.test(commit.stderr);
      return {
        success: false,
        commitRevision: null,
        outOfDate,
        errorOutput: output,
        ...(!rejected ? { verificationFailed: true } : {}),
        restorePreparation: async () => {
          const error = await restorePreparation('');
          if (error) throw new Error(error.trim());
        },
      };
    }
    const revision = /Committed revision\s+(\d+)/i.exec(commit.stdout)?.[1] ?? null;
    if (!revision) return failure('SVN 返回成功但无法取得提交版本，必须核验提交结果', null, true);
    const log = await svn(this.root, ['log', '--xml', '--verbose', '-r', revision, '--', `${rootUrl.stdout.trim()}@${revision}`]);
    const actual = new Map<string, string>();
    for (const match of log.stdout.matchAll(/<path\b([^>]*)>([^<]*)<\/path>/g)) {
      const relative = svnRepoPathToRelative(prefix.stdout, svnXmlText(match[2] ?? ''));
      if (relative) actual.set(relative, svnXmlAttribute(match[1] ?? '', 'action'));
    }
    if (log.code !== 0 || actual.size !== commitPaths.size || [...commitPaths].some((target) => !actual.has(target))) {
      return failure('SVN 实际提交路径与已核对集合不一致，必须人工恢复', revision, true);
    }
    for (const [target, entry] of verified) {
      const url = `${rootUrl.stdout.trim()}/${target.split('/').map(encodeURIComponent).join('/')}`;
      if ((await svnContentHash(this.root, revision, url, verifiedSizes.get(target) ?? 0)) !== entry.blobHash) {
        return failure(`SVN 实际提交内容与已审核内容不一致：${target}`, revision, true);
      }
    }
    for (const target of verifiedDeletions) {
      if (actual.get(target) !== 'D') return failure(`SVN 实际提交未删除核对路径：${target}`, revision, true);
    }
    for (const [target, props] of propertiesBefore) {
      if (!commitPaths.has(target)) continue;
      const url = `${rootUrl.stdout.trim()}/${target.split('/').map(encodeURIComponent).join('/')}`;
      const result = await svn(this.root, ['proplist', '--xml', '--verbose', '-r', revision, '--depth', 'empty', '--', `${url}@${revision}`]);
      const actualProps = svnProperties(result.stdout);
      if (result.code !== 0 || props.size !== actualProps.size || [...props].some(([name, value]) => actualProps.get(name) !== value)) {
        return failure(`SVN 实际提交属性与核对属性不一致：${target}`, revision, true);
      }
    }
    return { success: true, commitRevision: revision, outOfDate: false, errorOutput: '' };
  }
}
