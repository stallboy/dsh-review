import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, ReviewApi } from '../packages/dsh-plugin/dist/host/api.js';
import { DEFAULT_SETTINGS } from '../packages/dsh-plugin/dist/host/settings.js';
import { createGitFixture } from './helpers.mjs';
import { commitCandidate, guardFixture } from './fixtures/contract.mjs';

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

test('§6.3：旧人工补丁接口返回 404，不创建修复任务', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-manual-rev-shape');
  const { base } = await startApi(root);

  const res = await post(base, '/manual-revision', { ...guardFixture(candidate.id), patchText: 'not a patch\n' });
  const body = await res.json();
  assert.equal(res.status, 404, JSON.stringify(body));
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.jobId, undefined);
});

test('§5.6：/candidate/finalize 的结果是 AiFixOutcome 判别形状（未生成新补丁 → VALIDATION_FAILED + errors）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-finalize-shape');
  // 留下一处无效补丁写入但未更新 review.md 账本，验证收尾返回 VALIDATION_FAILED
  await writeFile(path.join(candidate.dir, '002.patch'), 'not a valid patch\n', 'utf8');
  const { base } = await startApi(root);

  const res = await post(base, '/candidate/finalize', {
    ...guardFixture(candidate.id),
    optionId: 'opt-a',
    patchId: 1,
  });
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const job = await waitJob(base, (await res.json()).jobId);
  assertAiFixOutcomeShape(job.result, 'candidate/finalize');
  assert.equal(job.result.status, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(job.result.errors) && job.result.errors.length > 0, 'VALIDATION_FAILED 必须带 errors');
});

test('§5.6：/ai-fix 在 manual Runner 下返回 MANUAL_REQUIRED + manualPrompt（判别形状）', async () => {
  const root = await createGitFixture();
  const candidate = await commitCandidate(root, '20261111-ai-fix-manual-shape', {
    review: {
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

  const res = await post(base, '/ai-fix', {
    ...guardFixture(candidate.id),
    optionId: 'opt-a',
    patchId: 1,
  });
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const job = await waitJob(base, (await res.json()).jobId);
  assertAiFixOutcomeShape(job.result, 'ai-fix');
  assert.equal(job.result.status, 'MANUAL_REQUIRED');
  assert.match(String(job.result.prompt), /请补充边界测试/);
});

test('§5.6：实现源码中 ai_fix 端点严格使用 AiFixOutcome 判别联合，不得返回旧非判别对象', async () => {
  const hostFiles = ['api.ts', 'api-writers.ts', 'api-readmodels.ts'];
  const sources = await Promise.all(
    hostFiles.map(async (name) => [name, await readFile(new URL(`../packages/dsh-plugin/src/host/${name}`, import.meta.url), 'utf8')]),
  );
  const source = sources.map(([, text]) => text).join('\n');
  assert.match(source, /AiFixOutcome/);
  assert.match(source, /status:\s*'MANUAL_REQUIRED'/);
  assert.match(source, /status:\s*'VALIDATION_FAILED'/);
  assert.match(source, /status:\s*'COMMITTED'/);
  assert.doesNotMatch(source, /manual:\s*true,\s*prompt:/, 'ai_fix 不得再返回 {manual:true,prompt} 形状');
});
