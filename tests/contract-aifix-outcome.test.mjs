import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../dist/api.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { commitCandidate, guardFixture } from './fixtures/contract.mjs';

/**
 * §7.7：ai_fix Job 的 Outcome 必须是判别形状（status 必填；ABORTED /
 * RECOVERY_REQUIRED 必带 reason），不得退回旧的非判别形状（如 {manual,prompt}）。
 */

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(root, settingsPatch = {}) {
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'dcr-state-')), 'runtime-state.json');
  const settings = {
    ...DEFAULT_SETTINGS, repoRoot: root, owner: 'tester', vcsType: 'git', runner: 'manual',
    syncBeforeApprove: false, ...settingsPatch,
  };
  const api = new ReviewApi({ settings, saveSettings: async (next) => next, statePath });
  await api.init();
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}${API_PREFIX}`;
  servers.push(server);
  return { base };
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function waitJob(base, jobId, attempts = 120) {
  let job;
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await (await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status !== 'running') return job;
  }
  return job;
}

/** ai_fix Outcome 的判别形状校验。 */
function assertAiFixOutcomeShape(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: result 必须存在`);
  assert.equal(typeof result.status, 'string', `${label}: 必须含判别字段 status`);
  assert.doesNotMatch(
    JSON.stringify(result),
    /"manual":true/,
    `${label}: 不得再使用旧的非判别形状 {manual:true,...}`,
  );
  if (result.status === 'ABORTED' || result.status === 'RECOVERY_REQUIRED') {
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      `${label}: ${String(result.status)} 必须带非空 reason（实际 ${JSON.stringify(result)}）`,
    );
  }
  if (result.status === 'RECOVERY_REQUIRED') {
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0, `${label}: RECOVERY_REQUIRED 必须带 detail`);
  }
}

test('§7.7：/manual-revision 的结果是 AiFixOutcome 判别形状（坏补丁 → ABORTED + INVALID_CANDIDATE）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-manual-rev-shape');
  const { base } = await startApi(root);

  const res = await post(base, '/manual-revision', { ...guardFixture(candidate.id), patchText: 'not a patch\n' });
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const job = await waitJob(base, (await res.json()).jobId);
  assertAiFixOutcomeShape(job.result, 'manual-revision');
  assert.equal(job.result.status, 'ABORTED');
  assert.equal(job.result.reason, 'INVALID_CANDIDATE');
});

test('§7.7：/candidate/finalize 的结果是 AiFixOutcome 判别形状（校验失败 → VALIDATION_FAILED + errors）', async () => {
  const root = await createGitFixture();
  // 本地候选（未提交）+ 空 gate_checks → 收尾校验失败。
  const candidate = await commitCandidate(root, '20261111-finalize-shape', {
    review: { gateChecks: '[]' },
    commit: false,
  });
  const { base } = await startApi(root);

  const res = await post(base, '/candidate/finalize', { id: candidate.id });
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const job = await waitJob(base, (await res.json()).jobId);
  assertAiFixOutcomeShape(job.result, 'candidate/finalize');
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(job.result.errors) && job.result.errors.length > 0, 'VALIDATION_FAILED 必须带 errors');
});

test('§7.7：/ai-fix 在 manual Runner 下返回 MANUAL_REQUIRED + manualPrompt（判别形状）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-ai-fix-manual-shape', {
    review: {
      // YAML 列表必须在 `comments:` 后换行并缩进两格。
      comments: [
        '',
        '  - id: c1',
        '    revision: 1',
        '    file: ""',
        '    line: 0',
        '    author: tester',
        '    content: 请补充边界测试',
        '    status: unresolved',
        '    created_at: "2026-11-01T10:05:00+08:00"',
      ].join('\n'),
    },
  });
  const { base } = await startApi(root, { runner: 'manual' });

  const res = await post(base, '/ai-fix', { ...guardFixture(candidate.id) });
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const job = await waitJob(base, (await res.json()).jobId);
  assertAiFixOutcomeShape(job.result, 'ai-fix');
  assert.equal(job.result.status, 'MANUAL_REQUIRED');
  assert.match(String(job.result.manualPrompt), /请补充边界测试/);
});

test('§7.7/§7.5：实现源码中 ai_fix 端点不得再返回裸的非判别对象', async () => {
  const source = await readFile(new URL('../src/host/api.ts', import.meta.url), 'utf8');
  // 三个 ai_fix 端点必须通过工厂构造结果（aborted / recoveryRequired / committed / validationFailed）。
  for (const factory of ['this.aborted(', 'this.recoveryRequired(', 'this.committed(', 'this.validationFailed(']) {
    assert.ok(source.includes(factory), `必须存在工厂 ${factory}`);
  }
  // 旧的 {manual:true,prompt} 形状必须消失。
  assert.doesNotMatch(source, /manual: true, prompt:/, 'ai_fix 不得再返回 {manual:true,prompt} 形状');
});
