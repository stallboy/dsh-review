import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { AuditArchive, scopeCovers } from '../packages/dsh-plugin/dist/host/audit-archive.js';
import { previewAuditPrompt } from '../packages/dsh-plugin/dist/host/auditor.js';
import { GitHeadCandidateSource } from '../packages/dsh-plugin/dist/host/shared-facts.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { createVcs } from '../packages/dsh-plugin/dist/host/vcs.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate } from './fixtures/contract.mjs';

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root) {
  const settings = { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual', syncBeforeApprove: false };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${String(address.port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

async function ensureReviewers(root) {
  await mkdir(path.join(root, '.ai-review'), { recursive: true });
  await writeFile(path.join(root, '.ai-review', 'reviewers.yml'), 'default_owner: tester\nrules: []\n', 'utf8');
}

function commitAll(root, message) {
  runCommand('git', ['add', '-A'], root);
  runCommand('git', ['commit', '-q', '-m', message], root);
}

test('§4.6：/findings 与 /audits 读 HEAD 共享快照，本地篡改不可见；新提交后立即可见', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  await writeCandidate(root, '20261110-finding-a', {
    review: { findingId: 'f-shared', status: 'pending' },
  });
  const archive = new AuditArchive(root);
  const head = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await archive.writeAudit({
    schemaVersion: 1,
    auditId: '20261110-100000-repo',
    createdAt: '2026-11-10T10:00:00.000Z',
    baseRevision: head,
    scope: '.',
    trigger: 'manual',
    previousAudit: null,
    issues: ['2026-11/20261110-finding-a'],
  }, '# 仓库审查报告\n');
  commitAll(root, 'audit fixture');
  const { base } = await startApi(root);

  const first = await (await fetch(`${base}/findings`)).json();
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].issueStatus, 'pending');

  // 工作区本地篡改不得污染共享投影
  const reviewPath = path.join(root, '.ai-review', '2026-11', '20261110-finding-a', 'review.md');
  const shared = await readFile(reviewPath, 'utf8');
  await writeFile(reviewPath, shared.replace('status: pending', 'status: human_takeover'), 'utf8');
  const second = await (await fetch(`${base}/findings`)).json();
  assert.equal(second.findings.length, 0, '工作区修改使该候选变为 local，不得直接作为共享事实投影');

  // 提交后新状态立即可见
  commitAll(root, 'human takeover');
  const third = await (await fetch(`${base}/findings`)).json();
  assert.equal(third.findings.length, 1);
  assert.equal(third.findings[0].issueStatus, 'human_takeover');

  // 未提交的新档案不进入共享 /audits
  await archive.writeAudit({
    schemaVersion: 1,
    auditId: '20261110-110000-local',
    createdAt: '2026-11-10T11:00:00.000Z',
    baseRevision: head,
    scope: '.',
    trigger: 'manual',
    previousAudit: '20261110-100000-repo',
    issues: [],
  }, '# 本地草稿\n');
  const auditsLocal = await (await fetch(`${base}/audits`)).json();
  assert.deepEqual(auditsLocal.audits.map((entry) => entry.auditId), ['20261110-100000-repo']);
});

test('§3.5：scopeCovers 精确判定非全仓 scope 覆盖', () => {
  assert.equal(scopeCovers('src', ['src/math.js']), true);
  assert.equal(scopeCovers('src', ['docs/readme.md']), false);
  assert.equal(scopeCovers('src', []), false);
  assert.equal(scopeCovers('.', []), true);
});

test('§4.6：负向记忆摘要注入只读共享快照（本地 rejected 草稿不注入）', async () => {
  const root = await createGitFixture();
  await ensureReviewers(root);
  await writeCandidate(root, '20261109-shared-rejected', {
    review: {
      findingId: 'shared-rej',
      title: 'net: 共享被拒方案',
      commitMessage: 'net: 共享被拒方案',
      status: 'rejected',
      rejection: `\n  rejected_by: tester\n  rejected_at: "${new Date(Date.now() - 86_400_000).toISOString()}"\n  reason: "已有更简单实现"\n  category: intentional_design`,
    },
  });
  commitAll(root, 'shared candidates');

  await writeCandidate(root, '20261109-local-rejected', {
    review: {
      findingId: 'local-rej',
      title: 'net: 本地被拒方案',
      commitMessage: 'net: 本地被拒方案',
      status: 'rejected',
      rejection: `\n  rejected_by: tester\n  rejected_at: "${new Date(Date.now() - 86_400_000).toISOString()}"\n  reason: "草稿"\n  category: false_positive`,
    },
  });

  const source = await GitHeadCandidateSource.create(root);
  assert.ok(source);
  const preview = await previewAuditPrompt({
    store: new ReviewStore(root),
    vcs: createVcs('git', root),
    settings: { ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester' },
    owner: 'tester',
    targetPath: '.',
    note: '',
    mode: 'headless',
    source,
  });

  assert.match(preview.prompt, /共享被拒方案/, '共享 rejected 必须注入负向记忆');
  assert.doesNotMatch(preview.prompt, /本地被拒方案/, '本地 rejected 草稿不得注入负向记忆');
});
