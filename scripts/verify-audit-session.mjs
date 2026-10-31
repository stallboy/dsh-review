#!/usr/bin/env node
/**
 * 等价于点一次「审查仓库」的端到端冒烟脚本。
 *
 * 流程：可选自动提交 → 调 Host API 创建审查会话 → 校验 DSH 会话已落盘并挂到
 * 当前工作区（侧边栏可见）→ 校验审查提示词已被接受并开跑 →（可选）等待审查
 * 报告/AI 候选出现。
 *
 * 用法：
 *   node scripts/verify-audit-session.mjs --session <DSH sessionId> [options]
 *
 * 常用参数：
 *   --session <id>     评审页所在会话 id；缺省读 DSH_SESSION_ID
 *   --base <url>       DSH Web GUI 地址；缺省读 DSH_WEB_URL（再缺省 http://127.0.0.1:2810）
 *   --repo <path>      产品仓库；缺省当前目录
 *   --target <path>    审查范围（仓库内相对路径，留空为全仓库）
 *   --note <text>      补充关注点
 *   --commit           工作区有改动时先 git add -A && git commit
 *   --message <text>   自动提交信息；缺省 "chore: 审查前自动提交"
 *   --wait <seconds>   等待会话/工作区挂载/首轮启动，默认 30
 *   --wait-audit <s>   额外等待审查报告或候选出现，0 表示不等待（默认 0）
 *   --allow-dirty      跳过干净工作区检查
 *   --json             只输出最终 JSON
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { zstdDecompressSync } from 'node:zlib';

const API_PREFIX = '/dsh-code-review/api';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PROMPT_MARKER = '仓库审查任务（独立 DSH 会话）';

function parseArgs(argv) {
  const options = {
    session: '',
    base: '',
    repo: process.cwd(),
    target: '',
    note: '',
    commit: false,
    message: 'chore: 审查前自动提交',
    wait: 30,
    waitAudit: 0,
    allowDirty: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} 缺少取值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--session': options.session = readValue(); break;
      case '--base': options.base = readValue(); break;
      case '--repo': options.repo = readValue(); break;
      case '--target': options.target = readValue(); break;
      case '--note': options.note = readValue(); break;
      case '--message': options.message = readValue(); break;
      case '--commit': options.commit = true; break;
      case '--allow-dirty': options.allowDirty = true; break;
      case '--json': options.json = true; break;
      case '--wait': options.wait = Number(readValue()); break;
      case '--wait-audit': options.waitAudit = Number(readValue()); break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  if (options.help) return options;
  if (!Number.isFinite(options.wait) || options.wait < 0) throw new Error('--wait 必须是非负数');
  if (!Number.isFinite(options.waitAudit) || options.waitAudit < 0) throw new Error('--wait-audit 必须是非负数');
  options.session = options.session || process.env['DSH_SESSION_ID'] || '';
  options.base = (options.base || process.env['DSH_WEB_URL'] || 'http://127.0.0.1:2810').replace(/\/+$/, '');
  options.repo = path.resolve(options.repo);
  return options;
}

function dshHome() {
  return process.env['DSH_HOME'] || path.join(os.homedir(), '.dsh');
}

function normalizePath(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function log(message) {
  if (!globalThis.__verifyJson) process.stdout.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = undefined;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${label}`);
}

function git(args) {
  return spawnSync('git', args, { cwd: globalThis.__repo, encoding: 'utf8' });
}

function workspaceStatus() {
  const result = git(['status', '--porcelain']);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git status 失败：${result.stderr}`);
  return result.stdout.trim();
}

function commitIfNeeded(options) {
  const dirty = workspaceStatus();
  if (!dirty) {
    log('· 工作区干净，无需提交');
    return false;
  }
  if (!options.commit) {
    if (options.allowDirty) {
      log('· 工作区有改动；使用 --allow-dirty 跳过提交（审查接口可能拒绝）');
      return false;
    }
    throw new Error(`工作区有未提交改动，先处理或加 --commit：\n${dirty}`);
  }
  log(`· 自动提交 ${dirty.split('\n').length} 个改动文件`);
  const added = git(['add', '-A']);
  if (added.status !== 0) throw new Error(`git add 失败：${added.stderr}`);
  const committed = git(['commit', '-m', options.message]);
  if (committed.status !== 0) throw new Error(`git commit 失败：\n${committed.stdout}\n${committed.stderr}`);
  log(`· 已提交 ${git(['rev-parse', '--short', 'HEAD']).stdout.trim()}`);
  return true;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${response.status} 返回非 JSON：${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${body?.error?.message ?? text.slice(0, 300)}`);
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${response.status} 返回非 JSON：${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${parsed?.error?.message ?? text.slice(0, 300)}`);
  return parsed;
}

function findSessionLog(sessionId) {
  const root = path.join(dshHome(), 'sessions');
  if (!existsSync(root)) return '';
  for (const folder of readdirSync(root)) {
    const dir = path.join(root, folder, sessionId);
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((name) => name.endsWith('.jsonl.zstd'));
    if (file) return path.join(dir, file);
  }
  return '';
}

function decodeSessionEvents(file) {
  const buffer = readFileSync(file);
  const chunks = [];
  let offset = 0;
  while ((offset = buffer.indexOf(ZSTD_MAGIC, offset)) >= 0) {
    try {
      const chunk = zstdDecompressSync(buffer.subarray(offset));
      if (chunk.length > 0) chunks.push(chunk);
    } catch {
      // A magic-like sequence inside a compressed block; the real frame follows.
    }
    offset += ZSTD_MAGIC.length;
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore a torn tail line while the session is still writing.
    }
  }
  return events;
}

function promptText(event) {
  if (event?.type !== 'user/message') return '';
  const content = event.data?.content ?? [];
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

function auditSnapshot(repo) {
  const auditsDir = path.join(repo, '.ai-review', 'audits');
  const reports = existsSync(auditsDir)
    ? readdirSync(auditsDir).filter((name) => name.endsWith('.md')).sort()
    : [];
  const candidateDir = path.join(repo, '.ai-review');
  const candidates = existsSync(candidateDir)
    ? readdirSync(candidateDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
        .flatMap((entry) => {
          const monthDir = path.join(candidateDir, entry.name);
          return readdirSync(monthDir, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => `${entry.name}/${child.name}`);
        })
        .sort()
    : [];
  return { reports, candidates };
}

async function workspaceAttached(sessionId, repo) {
  const file = path.join(dshHome(), 'storages', 'workspace.json');
  if (!existsSync(file)) return false;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const workspaces = Object.values(parsed?.tables?.workspaces ?? {});
  const workspace = workspaces.find((item) => normalizePath(String(item.path ?? '')) === normalizePath(repo));
  return Boolean(workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId));
}

function summarizeSession(events) {
  const userMessages = events.filter((event) => event.type === 'user/message');
  const turnStarts = events.filter((event) => event.type === 'turn/start').length;
  const assistantMessages = events.filter((event) => event.type === 'assistant/message').length;
  const toolCalls = events.filter((event) => event.type === 'tool/call').length;
  const hasAuditPrompt = userMessages.some((event) => promptText(event).includes(PROMPT_MARKER));
  return { userMessages: userMessages.length, turnStarts, assistantMessages, toolCalls, hasAuditPrompt };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法见 node scripts/verify-audit-session.mjs --help 的头部注释\n');
    return 0;
  }
  globalThis.__verifyJson = options.json;
  globalThis.__repo = options.repo;
  if (!options.session) throw new Error('缺少 --session（或设置 DSH_SESSION_ID）');

  log(`仓库：${options.repo}`);
  log(`DSH：${options.base}`);
  log(`会话：${options.session}`);

  commitIfNeeded(options);

  const health = await getJson(`${options.base}${API_PREFIX}/health?sessionId=${encodeURIComponent(options.session)}`);
  if (!health.configured) throw new Error(`评审仓库未就绪：${(health.diagnostics ?? []).join('；') || '未知原因'}`);
  if (normalizePath(String(health.repoRoot ?? '')) !== normalizePath(options.repo)) {
    throw new Error(`评审仓库解析为 ${health.repoRoot}，与当前目录 ${options.repo} 不一致`);
  }
  if (!health.currentBase) throw new Error('仓库没有基线提交，无法启动审查会话');
  log(`· 基线 ${String(health.currentBase).slice(0, 12)} · owner=${health.owner}`);

  const before = auditSnapshot(options.repo);
  log(`· 点击「审查仓库」：POST ${API_PREFIX}/audit/session（target=${options.target || '全仓库'}）`);
  const created = await postJson(
    `${options.base}${API_PREFIX}/audit/session?sessionId=${encodeURIComponent(options.session)}`,
    { targetPath: options.target, note: options.note },
  );
  log(`· Host 已创建会话 ${created.sessionId}`);
  log(`· 报告路径 ${created.reportPath}`);

  const sessionLog = await waitFor(
    `会话 ${created.sessionId} 落盘`,
    () => findSessionLog(created.sessionId),
    options.wait * 1000,
  );
  log(`· 会话日志 ${sessionLog}`);

  const attached = await waitFor(
    '会话挂入工作区（侧边栏可见）',
    () => workspaceAttached(created.sessionId, options.repo),
    options.wait * 1000,
  );
  if (!attached) throw new Error('会话未挂到工作区，侧边栏不会出现');
  log('· 已挂入工作区');

  const accepted = await waitFor(
    '审查提示词被接受并启动首轮',
    () => {
      const summary = summarizeSession(decodeSessionEvents(findSessionLog(created.sessionId)));
      return summary.hasAuditPrompt && summary.turnStarts > 0 ? summary : undefined;
    },
    options.wait * 1000,
  );
  log(`· 提示词已受理：user=${accepted.userMessages} turns=${accepted.turnStarts} assistant=${accepted.assistantMessages} tools=${accepted.toolCalls}`);

  const result = {
    ok: true,
    sessionId: created.sessionId,
    reportPath: created.reportPath,
    baseRevision: created.baseRevision,
    workspaceAttached: true,
    promptAccepted: true,
    ...accepted,
  };

  if (options.waitAudit > 0) {
    log(`· 等待审查产出（最多 ${options.waitAudit}s）…`);
    const started = Date.now();
    const produced = await waitFor(
      '审查报告或候选出现',
      () => {
        const after = auditSnapshot(options.repo);
        const newReports = after.reports.filter((name) => !before.reports.includes(name));
        const newCandidates = after.candidates.filter((name) => !before.candidates.includes(name));
        return newReports.length > 0 || newCandidates.length > 0 ? { newReports, newCandidates } : undefined;
      },
      options.waitAudit * 1000,
      2000,
    );
    result.audit = { ...produced, waitedMs: Date.now() - started };
    log(`· 新增报告 ${produced.newReports.length} 个，新增候选 ${produced.newCandidates.length} 个`);
    if (produced.newReports.length > 0) log(`  report: ${produced.newReports.join(', ')}`);
    if (produced.newCandidates.length > 0) log(`  candidate: ${produced.newCandidates.join(', ')}`);
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else log('\n✅ 审查会话链路正常');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    if (globalThis.__verifyJson) process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    else process.stderr.write(`\n❌ ${error.message}\n`);
    process.exitCode = 1;
  });
