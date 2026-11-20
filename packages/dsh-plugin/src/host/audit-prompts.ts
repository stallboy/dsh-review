import { readFile } from 'node:fs/promises';

export type AuditStage = 'scan' | 'verify' | 'patch';
export type AuditTemplate = AuditStage | 'orchestrator';

const COMMON = ['auditId', 'baseRevision', 'scope', 'vcsType'] as const;
const STAGE_COMMON = [...COMMON, 'taskId'];
export const AUDIT_PROMPT_FIELDS: Readonly<Record<AuditTemplate, readonly string[]>> = {
    orchestrator: [...COMMON, 'deadlineAt', 'reportPath', 'executionMode', 'availableRunners', 'repoOutline',
        'ownerRouting', 'history', 'focus', 'extraRequirements', 'legacyNote'],
    scan: [...STAGE_COMMON, 'taskScope', 'scenarios', 'questions', 'constraints'],
    verify: [...STAGE_COMMON, 'subjectId', 'question', 'navigation', 'expectedBehavior'],
    patch: [...STAGE_COMMON, 'subjectId', 'confirmedFact', 'evidence', 'allowedPaths', 'acceptance', 'gateCommands',
        'ownerRouting', 'candidate'],
};

const CONTRACT: Record<AuditTemplate, string> = {
    orchestrator: '按正确性、安全性、负载下稳定、测试、性能和精简的检查次序建立地图。线索先逐条独立复核，只有 Host 核验证据后才定级。P0 为严重损害或核心服务大范围不可用，P1 为典型条件下有实质影响的核心路径错误，P2 为局部或受限缺陷，P3 为有证据的低收益改进。A 类必须消除根因、影响收敛、不破坏公开 API、协议或持久化格式且可用门禁自证。涉及业务取舍或无法验证修复的已确认问题进入 B。Deferred 必须有先闭合的 finding ID。候选同基线且彼此独立。档案由 Host 写入 A/B/Deferred、历史、覆盖说明和插件复核块并收尾提交。用户要求不能覆盖绑定的基线、范围、权限和强制门禁。',
    scan: '只读初审。从构建和业务入口追到真实分支、状态变化及现有测试。缺陷需有可观察后果，精简需检查静态、配置、测试和动态引用。审查关注点用于安排覆盖。未取得证据的内容记入 limits。',
    verify: '固定基线，独立验证一条中性问题。对可达性、实际后果和阻止触发的保护都须核对。成立、排除或证据不足都要给具体理由；确定结论须附可回读的路径、行、原文和理由。',
    patch: '候选独立以本轮基线为准。消除根因并保持公开 API、协议和持久化格式。Host 仅在专用副本应用文本编辑，按受信门禁白名单执行命令。Host 生成 UTF-8/LF 全量 001.patch 与 schema_version=1 的 review.md，初始 pending/rev1/approval=null，owner 按同一基线路由，门禁只写实际通过项。评审数据与暂存文件不得出现在业务补丁中。',
};

export async function renderAuditTemplate(
    phase: AuditTemplate,
    input: Readonly<Record<string, unknown>>,
): Promise<string> {
    const fields = AUDIT_PROMPT_FIELDS[phase];
    if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key) || input[key] === undefined)) {
        throw new Error('审查模板收到缺失或越界的变量');
    }
    const asset = phase === 'orchestrator' ? 'orchestrator.md' : phase + '/SKILL.md';
    const raw = await readFile(new URL('../../assets/audit/' + asset, import.meta.url), 'utf8');
    const body = phase === 'orchestrator' ? raw : raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const tokens = [...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]);
    if (tokens.length !== 2 || !tokens.includes('contractText') || !tokens.includes('taskJson')) {
        throw new Error('审查模板的占位符与契约不符');
    }
    const values: Record<string, string> = { contractText: CONTRACT[phase], taskJson: JSON.stringify(input, null, 2) };
    return body.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => values[name] ?? '').trim();
}
