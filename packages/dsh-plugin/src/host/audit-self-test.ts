/**
 * 节点审查流程自检（SPEC §9.12 / AC-SELF-TEST-01 / D11）：
 * - 在新建临时目录中验证「软引导 + Host 强还原」策略与完整 Harness 通道；
 * - 按 stageExecutors 依次尝试外部专业执行器（如 codex / claude）并如实报告每个执行器状态；
 * - 强制验证本 Harness 独立子代理（dsh-subagent）：外部执行器不可用时不作为硬阻断，只要本 Harness 子代理通过全部 5 项必验即返回 SUCCEEDED。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializeAuditMarkdown } from './audit-archive.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import {
  executeAuditCli,
  normalizeExecutorName,
  probeStageExecutors,
  type AuditExecutor,
  type ExecuteAuditStage,
  type ExecutorProbeStatus,
} from './audit-stage-runner.js';
import { serializeReviewMarkdown } from './frontmatter.js';
import { sha256Hex } from './issue-review.js';
import { validateReviewData } from './review-data-validation.js';
import { runProcess } from './shell.js';
import type { ReviewFrontmatter } from './types.js';

export const SELF_TEST_TIMEOUT_MS = 5 * 60_000;

export interface AuditSelfTestInput {
  stageExecutors: readonly string[];
  dshCommand?: string;
  executor?: ExecuteAuditStage;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface AuditSelfTestOutcome {
  status: 'SUCCEEDED' | 'ABORTED';
  step?: string;
  message: string;
  executors: Array<ExecutorProbeStatus & { tested?: boolean; passed?: boolean; detail?: string }>;
  checks: {
    largeFileTailRead: boolean;
    aiReviewWriteReadback: boolean;
    forensicRestoreCleanup: boolean;
    schemaV1PublishReadback: boolean;
    tempDirCleaned: boolean;
  };
}

const SELF_TEST_SCHEMA = {
  type: 'object',
  properties: {
    tailToken: { type: 'string' },
    writtenPath: { type: 'string' },
  },
  required: ['tailToken', 'writtenPath'],
};

async function initTempGitRepo(dir: string): Promise<string> {
  await runProcess('git', ['init', '-q'], { cwd: dir, timeoutMs: 15_000 });
  await runProcess('git', ['config', 'user.name', 'SelfTest'], { cwd: dir, timeoutMs: 15_000 });
  await runProcess('git', ['config', 'user.email', 'selftest@local'], { cwd: dir, timeoutMs: 15_000 });
  const tailToken = `SELFTEST-TAIL-${randomBytes(8).toString('hex')}`;
  // 构造未预注入提示词的大文件（约 120KB），尾部放置随机令牌以验证真实工具读文件
  const filler = `${'// padding line for un-injected large file read verification\n'.repeat(1800)}${tailToken}\n`;
  await writeFile(path.join(dir, 'large-sample.txt'), filler, 'utf8');
  await mkdir(path.join(dir, '.ai-review'), { recursive: true });
  await writeFile(path.join(dir, '.ai-review', 'reviewers.yml'), 'default_owner: selftest\nrules: []\n', 'utf8');
  await runProcess('git', ['add', '-A'], { cwd: dir, timeoutMs: 15_000 });
  await runProcess('git', ['commit', '-q', '--no-verify', '-m', 'init self-test repo'], { cwd: dir, timeoutMs: 15_000 });
  return tailToken;
}

function buildMockV1Review(baseRevision: string, nowIso: string, patchSha: string): string {
  const meta: ReviewFrontmatter = {
    schemaVersion: 1,
    findingId: 'selftest-mock-issue',
    title: 'core: 自检模拟问题',
    module: 'core',
    auditType: 'bugfix',
    issueKind: 'repair',
    dependsOn: null,
    priority: 'P3',
    baseRevision,
    createdAt: nowIso,
    updatedAt: nowIso,
    owner: 'selftest',
    tags: ['selftest'],
    ticket: null,
    status: 'pending',
    targetFiles: ['large-sample.txt'],
    recordRevision: 1,
    patches: [{
      id: 1,
      patch: '001.patch',
      optionId: 'mock-opt',
      baseRevision,
      author: 'ai',
      sha256: patchSha,
    }],
    options: [{
      id: 'mock-opt',
      title: '自检模拟方案',
      tradeoff: '仅用于验证 schema_version 1 读写往返',
      confidence: 0.9,
      currentPatch: 1,
      gateChecks: ['echo ok'],
    }],
    observations: [{
      auditId: '20261126-000000-selftest',
      baseRevision,
      at: nowIso,
      verdict: 'confirmed',
      reason: '自检模拟确认',
      evidence: [{ path: 'large-sample.txt', line: 1, excerpt: '// padding', reason: '自检证据' }],
    }],
    decisions: [],
    repairAttempts: [],
    comments: [],
    humanDecisions: [],
    approval: null,
    approvalHistory: [],
    rejection: null,
    commitMessage: 'core: 自检模拟问题\n\n自检验证提交说明',
  };
  return serializeReviewMarkdown(meta, '# 问题与影响\n自检。\n\n# 根因\n自检。\n\n# 当前修复方案\n自检。\n\n# 需人工判断项\n- 无\n\n# 验证证据\n自检。\n\n# 审核记录\n\n## 记录版本 1\n- 自检记录。');
}

export async function runAuditSelfTest(input: AuditSelfTestInput): Promise<AuditSelfTestOutcome> {
  const checks = {
    largeFileTailRead: false,
    aiReviewWriteReadback: false,
    forensicRestoreCleanup: false,
    schemaV1PublishReadback: false,
    tempDirCleaned: false,
  };
  const stageExecutors = Array.isArray(input.stageExecutors) ? input.stageExecutors : [];
  const log = typeof input.log === 'function' ? input.log : () => {};
  const timeoutSignal = AbortSignal.timeout(SELF_TEST_TIMEOUT_MS);
  const combinedSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const probe = probeStageExecutors(stageExecutors, input.dshCommand);
  const executorReports: AuditSelfTestOutcome['executors'] = probe.executors.map((e) => ({ ...e }));

  if (timeoutSignal.aborted) {
    return {
      status: 'ABORTED',
      step: 'coordinator',
      message: '自检超过 5 分钟',
      executors: executorReports,
      checks,
    };
  }
  if (combinedSignal.aborted) {
    return {
      status: 'ABORTED',
      step: 'coordinator',
      message: '自检已取消',
      executors: executorReports,
      checks,
    };
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'dcr-audit-self-test-'));
  let channel: Awaited<ReturnType<typeof openAuditStageChannel>> | null = null;

  try {
    log(`[自检] 初始化临时工作区：${tempRoot}`);
    const expectedTail = await initTempGitRepo(tempRoot);
    const headResult = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: tempRoot, timeoutMs: 10_000 });
    const baseRevision = headResult.stdout.trim() || '0'.repeat(40);
    const execute = input.executor ?? executeAuditCli;

    const testPrompt = [
      '# 节点审查流程自检任务',
      '1. 请使用文件读取工具读取仓库根目录 `large-sample.txt` 的最后一行随机令牌（该令牌未出现在提示词中）。',
      '2. 向 `.ai-review/self-test-probe.txt` 写入该令牌并读回确认。',
      '3. 可选写入临时取证文件 `.tmp/probe.log` 或项目内临时文件，Host 将核验还原与清理。',
      '4. 返回 JSON：`{"tailToken": "<读到的最后一行令牌>", "writtenPath": ".ai-review/self-test-probe.txt"}`。',
    ].join('\n');

    channel = await openAuditStageChannel(async () => ({ ok: true }));

    // 1. 尝试配置的外部专业执行器（不可用或失败仅如实记录，不作为硬阻断）
    const externalNames = stageExecutors
      .map(normalizeExecutorName)
      .filter((n): n is 'codex' | 'claude' => n === 'codex' || n === 'claude');
    for (const ext of externalNames) {
      const report = executorReports.find((r) => r.name === ext);
      if (report && report.status === 'unavailable' && !input.executor) {
        report.tested = false;
        report.passed = false;
        log(`[自检] 跳过外部执行器 ${ext}：${report.reason ?? '未安装'}`);
        continue;
      }
      log(`[自检] 探测外部执行器 ${ext}`);
      const res = await execute({
        stage: 'verify',
        runner: ext,
        cwd: tempRoot,
        prompt: testPrompt,
        schema: SELF_TEST_SCHEMA,
        timeoutMs: 60_000,
        signal: combinedSignal,
        ...(input.dshCommand ? { dshCommand: input.dshCommand } : {}),
        onLog: log,
      });
      const out = res.output as { tailToken?: string } | undefined;
      const passed = Boolean(res.ok && res.executorUsed === ext && out?.tailToken?.trim() === expectedTail);
      if (report) {
        report.tested = true;
        report.passed = passed;
        report.status = passed ? 'available' : 'degraded';
        report.detail = passed ? '外部执行器完整 Harness 验证通过' : (res.diagnostic ?? '外部执行器未通过自检，已记录降级');
      }
    }

    // 2. 必验：本 Harness 独立子代理（dsh-subagent）完整链路
    log('[自检] 执行本 Harness 独立子代理（dsh-subagent）必验检查');
    const subagentResult = await execute({
      stage: 'verify',
      runner: 'dsh-subagent',
      cwd: tempRoot,
      prompt: testPrompt,
      schema: SELF_TEST_SCHEMA,
      timeoutMs: 90_000,
      signal: combinedSignal,
      ...(input.dshCommand ? { dshCommand: input.dshCommand } : {}),
      onLog: log,
    });
    const subagentReport = executorReports.find((r) => r.name === 'dsh-subagent');
    const subOut = subagentResult.output as { tailToken?: string; writtenPath?: string } | undefined;

    if (!subagentResult.ok || subOut?.tailToken?.trim() !== expectedTail) {
      if (subagentReport) {
        subagentReport.tested = true;
        subagentReport.passed = false;
        subagentReport.status = 'unavailable';
        subagentReport.detail = subagentResult.diagnostic ?? '未能真实读取未预注入大文件尾部令牌';
      }
      return {
        status: 'ABORTED',
        step: 'largeFileTailRead',
        message: `本 Harness 子代理未能读取未预注入大文件尾部令牌：${subagentResult.diagnostic ?? '令牌不匹配'}`,
        executors: executorReports,
        checks,
      };
    }
    checks.largeFileTailRead = true;
    if (subagentReport) {
      subagentReport.tested = true;
      subagentReport.passed = true;
      subagentReport.status = 'available';
      subagentReport.detail = '本 Harness 独立子代理验证通过';
    }

    // 必验②：校验 .ai-review/ 写入并读回
    const probeFile = path.join(tempRoot, '.ai-review', 'self-test-probe.txt');
    const written = await readFile(probeFile, 'utf8').catch(() => '');
    if (!written.includes(expectedTail)) {
      return {
        status: 'ABORTED',
        step: 'aiReviewWriteReadback',
        message: '未能验证 .ai-review/ 写入与读回（self-test-probe.txt 缺失或不含令牌）',
        executors: executorReports,
        checks,
      };
    }
    checks.aiReviewWriteReadback = true;

    // 必验③：模拟临时取证文件清理与非 .ai-review/ 零残留核验
    await mkdir(path.join(tempRoot, '.tmp'), { recursive: true });
    await writeFile(path.join(tempRoot, '.tmp', 'forensic.log'), 'temp', 'utf8');
    await writeFile(path.join(tempRoot, 'temp-forensic.txt'), 'temp', 'utf8');
    await runProcess('git', ['reset', '-q', '--', '.'], { cwd: tempRoot, timeoutMs: 10_000 });
    await runProcess('git', ['checkout', '--', '.', ':(exclude).ai-review'], { cwd: tempRoot, timeoutMs: 10_000 });
    await runProcess('git', ['clean', '-fdq', '-e', '.ai-review'], { cwd: tempRoot, timeoutMs: 10_000 });
    await rm(path.join(tempRoot, '.tmp'), { recursive: true, force: true });
    const statusAfter = await runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: tempRoot, timeoutMs: 10_000 });
    const nonReviewDirty = statusAfter.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim())
      .filter((file) => file !== '.ai-review' && !file.startsWith('.ai-review/'));
    if (nonReviewDirty.length > 0 || existsSync(path.join(tempRoot, '.tmp'))) {
      return {
        status: 'ABORTED',
        step: 'forensicRestoreCleanup',
        message: `临时取证清理与还原后仍有非 .ai-review/ 残留：${nonReviewDirty.join(', ')}`,
        executors: executorReports,
        checks,
      };
    }
    checks.forensicRestoreCleanup = true;

    // 必验④：写入并读回合法的 schema_version: 1 模拟 review.md 与 audit.md
    const nowIso = '2026-11-26T00:00:00.000Z';
    const mockIssueDir = path.join(tempRoot, '.ai-review', '2026-11', 'selftest-mock-issue');
    const mockAuditDir = path.join(tempRoot, '.ai-review', 'audits', '20261126-000000-selftest');
    await mkdir(mockIssueDir, { recursive: true });
    await mkdir(mockAuditDir, { recursive: true });
    const mockPatch = 'diff --git a/large-sample.txt b/large-sample.txt\n--- a/large-sample.txt\n+++ b/large-sample.txt\n@@ -1 +1 @@\n-// padding line\n+// padded line\n';
    await writeFile(path.join(mockIssueDir, '001.patch'), mockPatch, 'utf8');
    const mockReview = buildMockV1Review(baseRevision, nowIso, sha256Hex(mockPatch));
    const mockReviewFile = path.join(mockIssueDir, 'review.md');
    await writeFile(mockReviewFile, mockReview, 'utf8');
    const mockAudit = serializeAuditMarkdown({
      schemaVersion: 1,
      auditId: '20261126-000000-selftest',
      createdAt: nowIso,
      baseRevision,
      scope: '.',
      trigger: 'manual',
      previousAudit: null,
      issues: ['2026-11/selftest-mock-issue'],
    }, '# 自检模拟审查报告\n');
    const mockAuditFile = path.join(mockAuditDir, 'audit.md');
    await writeFile(mockAuditFile, mockAudit, 'utf8');

    const reviewErrors = validateReviewData(mockReviewFile, await readFile(mockReviewFile));
    const auditErrors = validateReviewData(mockAuditFile, await readFile(mockAuditFile));
    if (reviewErrors.length > 0 || auditErrors.length > 0) {
      return {
        status: 'ABORTED',
        step: 'schemaV1PublishReadback',
        message: `schema_version: 1 模拟读写校验失败：${[...reviewErrors, ...auditErrors].join('；')}`,
        executors: executorReports,
        checks,
      };
    }
    checks.schemaV1PublishReadback = true;

    channel?.close();
    channel = null;
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    checks.tempDirCleaned = !existsSync(tempRoot);

    return {
      status: 'SUCCEEDED',
      message: '审查流程自检通过（本 Harness 独立子代理与 schema_version: 1 全链路可用）',
      executors: executorReports,
      checks,
    };
  } catch (error) {
    return {
      status: 'ABORTED',
      step: 'exception',
      message: `自检异常中止：${error instanceof Error ? error.message : String(error)}`,
      executors: executorReports,
      checks,
    };
  } finally {
    channel?.close();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    checks.tempDirCleaned = !existsSync(tempRoot);
  }
}

export type { AuditExecutor };
