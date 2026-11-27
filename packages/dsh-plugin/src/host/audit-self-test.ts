/**
 * 节点审查流程自检（SPEC §9.12 / AC-SELF-TEST-01）：
 * - 在新建临时目录中验证「软引导 + Host 强还原」策略、真实回环阶段通道与完整 Harness 能力；
 * - 按 stageExecutors 依次尝试外部专业执行器（如 codex / claude）并如实报告每个执行器状态；
 * - 强制验证本 Harness 独立子代理（dsh-subagent）：外部执行器不可用时不作为硬阻断，只要本 Harness 子代理与真实发布读写通过全部 5 项必验即返回 SUCCEEDED。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishStageArtifacts } from './audit-stage-artifacts.js';
import { openAuditStageChannel } from './audit-stage-channel.js';
import {
  executeAuditCli,
  normalizeExecutorName,
  probeStageExecutors,
  type AuditExecutor,
  type ExecuteAuditStage,
  type ExecutorProbeStatus,
} from './audit-stage-runner.js';
import { buildIssuePublication } from './issue-publication.js';
import { validateReviewData } from './review-data-validation.js';
import { runProcess } from './shell.js';

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
  const probeFile = path.join(tempRoot, '.ai-review', 'self-test-probe.txt');

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

    // 验证本机一次性回环阶段通道可真实鉴权通信
    channel = await openAuditStageChannel(async (reqBody) => ({ ok: true, echo: reqBody['operation'] ?? null }));
    const channelRes = await fetch(channel.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${channel.token}`,
      },
      body: JSON.stringify({ operation: 'ping' }),
      signal: combinedSignal,
    });
    const channelPayload = channelRes.ok ? (await channelRes.json().catch(() => null)) as { result?: { ok?: boolean } } | null : null;
    if (!channelRes.ok || channelPayload?.result?.ok !== true) {
      return {
        status: 'ABORTED',
        step: 'stageChannel',
        message: '本机阶段回环通道鉴权连通自检失败',
        executors: executorReports,
        checks,
      };
    }

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
      await rm(probeFile, { force: true }).catch(() => undefined);
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

    // 2. 必验：本 Harness 独立子代理（dsh-subagent）完整链路（先清理外部探测残留防假通过）
    await rm(probeFile, { force: true }).catch(() => undefined);
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

    // 必验④：经真实 buildIssuePublication + publishStageArtifacts 通道落盘并读回校验 schema_version: 1
    const mockPatch = 'diff --git a/large-sample.txt b/large-sample.txt\n--- a/large-sample.txt\n+++ b/large-sample.txt\n@@ -1 +1 @@\n-// padding line for un-injected large file read verification\n+// padded line for un-injected large file read verification\n';
    const built = await buildIssuePublication(tempRoot, {
      auditId: '20261126-000000-selftest',
      baseRevision,
      scope: '.',
      trigger: 'manual',
      previousAudit: null,
      reviewers: {
        defaultOwner: 'selftest',
        staleDays: 14,
        rejectionMemoryDays: 90,
        maxAntiPatterns: 50,
        rules: [],
        exists: true,
        valid: true,
        errors: [],
      },
      existingByFindingId: new Map(),
      existingDirIds: new Set(),
      findings: [{
        findingId: 'selftest-mock-issue',
        title: 'core: 自检模拟问题',
        module: 'core',
        auditType: 'bugfix',
        issueKind: 'repair',
        dependsOn: null,
        priority: 'P3',
        reason: '自检模拟确认',
        problemSummary: '自检验证完整发布链路',
        rootCause: '自检验证根因',
        repairPlan: '自检修复方案',
        tags: ['selftest'],
        evidence: [{ path: 'large-sample.txt', line: 1, excerpt: '// padding', reason: '自检证据' }],
        proposals: [{
          optionId: 'mock-opt',
          title: '自检模拟方案',
          tradeoff: '仅用于验证 schema_version 1 发布与读写往返',
          confidence: 0.9,
          auditType: 'bugfix',
          gateChecks: ['echo ok'],
          humanDecisions: [],
          patchText: mockPatch,
          patchBytes: Buffer.from(mockPatch, 'utf8'),
          summary: '自检模拟补丁',
        }],
      }],
      reviewedExternal: [],
      coverageLines: ['自检临时仓库全覆盖'],
      requirementLines: [],
      historyLines: [],
      now: new Date('2026-11-26T00:00:00.000Z'),
    });
    await publishStageArtifacts(tempRoot, built.reportPath, built.reportText, built.candidates, async () => undefined);

    const mockReviewFile = path.join(tempRoot, '.ai-review', built.candidates[0]!.id, 'review.md');
    const mockAuditFile = path.join(tempRoot, built.reportPath);
    const reviewErrors = validateReviewData(mockReviewFile, await readFile(mockReviewFile));
    const auditErrors = validateReviewData(mockAuditFile, await readFile(mockAuditFile));
    if (reviewErrors.length > 0 || auditErrors.length > 0) {
      return {
        status: 'ABORTED',
        step: 'schemaV1PublishReadback',
        message: `schema_version: 1 模拟发布校验失败：${[...reviewErrors, ...auditErrors].join('；')}`,
        executors: executorReports,
        checks,
      };
    }
    checks.schemaV1PublishReadback = true;

    channel?.close();
    channel = null;
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    checks.tempDirCleaned = !existsSync(tempRoot);
    if (!checks.tempDirCleaned) {
      return {
        status: 'ABORTED',
        step: 'tempDirCleaned',
        message: `自检临时目录未能彻底清理：${tempRoot}`,
        executors: executorReports,
        checks,
      };
    }

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
