import { readFile } from 'node:fs/promises';

export type AuditStage = 'scan' | 'verify' | 'patch';
export type AuditTemplate = AuditStage | 'orchestrator';

const COMMON = ['auditId', 'baseRevision', 'scope', 'vcsType'] as const;
const STAGE_COMMON = [...COMMON, 'taskId'];

export const AUDIT_PROMPT_FIELDS: Readonly<Record<AuditTemplate, readonly string[]>> = {
  orchestrator: [
    ...COMMON,
    'deadlineAt',
    'reportPath',
    'executionMode',
    'availableRunners',
    'ownerRouting',
    'history',
    'focus',
    'extraRequirements',
  ],
  scan: [...STAGE_COMMON, 'taskScope', 'scenarios', 'questions', 'constraints'],
  verify: [...STAGE_COMMON, 'subjectId', 'question', 'navigation', 'expectedBehavior'],
  patch: [
    ...STAGE_COMMON,
    'subjectId',
    'confirmedFact',
    'evidence',
    'auditType',
    'allowedPaths',
    'acceptance',
    'gateCommands',
    'ownerRouting',
    'candidate',
    'existingIssue',
  ],
};

const AUDIT_TYPE_GUIDE = '审查类型（audit_type）：bugfix 修复可复现缺陷；delete 删除无引用代码；shrink 收缩实现并保留职责；reuse 复用已有实现；merge 合并必须同步演进的实现；split 按真实职责拆分；stdlib 改用标准库；native 改用平台原生能力；yagni 删除无当前需求的抽象或过度设计。';

const CONTRACT: Record<AuditTemplate, string> = {
  orchestrator: [
    '按正确性、安全性、负载下的稳定性、测试、性能和精简的顺序安排覆盖。',
    'P0 为严重数据损坏、关键权限边界失效或核心服务大范围不可用；P1 为典型条件下有实质影响的核心路径错误；P2 为局部或受限缺陷；P3 为有证据的低收益改进。',
    'A 类（repair）须消除根因、收敛影响、保持公开 API/协议/持久化格式兼容，并推荐置信度最高的 1–2 个互斥完整补丁，审查阶段仅做只读预检、不应用补丁验证修复效果。',
    'B 类（confirm）交付可直接交给外部执行人的完整文字方案；Deferred（deferred）须提供稳定前置 finding_id（depends_on）。',
    '遵循「软引导 + Host 强还原」策略：优先在 .ai-review/ 与 .tmp/ 工作，Agent 退出前将有效证据归档到 evidence/，Host 在子阶段交接及收尾前强制还原所有非 .ai-review/ 改动并清空 .tmp/。',
    AUDIT_TYPE_GUIDE,
  ].join(''),
  scan: '只读初审。在项目原工作目录的完整 Harness Loop 中自主搜索与读取源码（不受 scope 限制跨目录追踪调用方与测试），从入口追到真实分支、状态变化与保护逻辑。缺陷须有可观察后果，精简须有全仓引用搜索证据。未覆盖项记入 limits。',
  verify: '固定基线，独立验证一条中性问题，不继承初审推理、等级或修法。对可达性、实际后果与阻止触发的保护都须核对。成立、排除或证据不足都要给具体理由；确定结论须附可回读的路径、行号、原文和理由。必要取证优先在 .ai-review/ 与 .tmp/ 工作，有效材料须在退出前归档到 evidence/。',
  patch: [
    '在项目原工作目录的完整 Harness Loop 中自主读取文件，消除根因并保持公开 API、协议和持久化格式。',
    '直接在 candidate.artifactDir 写 UTF-8 完整统一 diff，返回稳定合法的 optionId（^[a-z0-9][a-z0-9-]{0,63}$）、仓库相对 patchPath、title、summary、tradeoff、0 到 100 的整数 confidence、humanDecisions 和 reason；无法安全生成时 status=blocked、patchPath 为空。',
    '若 existingIssue 非空，跨轮更新已有方案须显式沿用已有 optionId，新增备选须使用未退役的新 optionId（每问题最多 2 个有效方案）。',
    '严禁应用待审补丁验证修复效果或宣称门禁通过，严禁执行 git/svn commit/push/切分支，严禁把 .ai-review/ 写入补丁；修复门禁留待人工批准后由 Host 在仓库根目录执行。',
    AUDIT_TYPE_GUIDE,
  ].join(''),
};

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

export function renderPromptText(
  body: string,
  fields: readonly string[],
  values: Readonly<Record<string, string>>,
): string {
  if (Object.keys(values).length !== fields.length || fields.some((key) => !Object.hasOwn(values, key) || typeof values[key] !== 'string')) {
    throw new Error('审查模板收到缺失或越界的变量');
  }
  const tokens = new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1]));
  if (tokens.size !== fields.length || fields.some((key) => !tokens.has(key))) {
    throw new Error('审查模板的占位符与契约不符');
  }
  // 单次替换，避免用户输入或前序文本中的 {{...}} 触发二次模板替换（SPEC §7）。
  return body.replaceAll('\r\n', '\n').replace(PLACEHOLDER, (_, name: string) => values[name]!);
}

export async function renderAuditTemplate(
  phase: AuditTemplate,
  input: Readonly<Record<string, unknown>>,
): Promise<string> {
  const fields = AUDIT_PROMPT_FIELDS[phase];
  if (Object.keys(input).length !== fields.length || fields.some((key) => !Object.hasOwn(input, key) || input[key] === undefined)) {
    throw new Error(`审查模板 ${phase} 收到缺失或越界的变量`);
  }
  const asset = phase === 'orchestrator' ? 'orchestrator.md' : `${phase}/SKILL.md`;
  const raw = await readFile(new URL(`../../assets/audit/${asset}`, import.meta.url), 'utf8');
  const body = phase === 'orchestrator' ? raw : raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  if ([...body.matchAll(PLACEHOLDER)].length !== 2) {
    throw new Error(`审查模板 ${phase} 的占位符与契约不符`);
  }
  return renderPromptText(body, ['contractText', 'taskJson'], {
    contractText: CONTRACT[phase],
    taskJson: JSON.stringify(input, null, 2),
  }).trim();
}
