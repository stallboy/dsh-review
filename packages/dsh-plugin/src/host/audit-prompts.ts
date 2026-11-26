import { readFile } from 'node:fs/promises';

export type AuditStage = 'scan' | 'verify' | 'patch';
export type AuditTemplate = AuditStage | 'orchestrator';

const COMMON = ['auditId', 'baseRevision', 'scope', 'vcsType'] as const;
const STAGE_COMMON = [...COMMON, 'taskId'];
export const AUDIT_PROMPT_FIELDS: Readonly<Record<AuditTemplate, readonly string[]>> = {
    orchestrator: [...COMMON, 'deadlineAt', 'reportPath', 'executionMode', 'availableRunners',
        'ownerRouting', 'history', 'focus', 'extraRequirements'],
    scan: [...STAGE_COMMON, 'taskScope', 'scenarios', 'questions', 'constraints'],
    verify: [...STAGE_COMMON, 'subjectId', 'question', 'navigation', 'expectedBehavior'],
    patch: [...STAGE_COMMON, 'subjectId', 'confirmedFact', 'evidence', 'auditType', 'allowedPaths', 'acceptance', 'gateCommands',
        'ownerRouting', 'candidate'],
};

const AUDIT_TYPE_GUIDE = '审查类型：bugfix 修复可复现缺陷；delete 删除无引用代码；shrink 收缩实现并保留职责；reuse 复用已有实现；merge 合并必须同步演进的实现；split 按真实职责拆分；stdlib 改用标准库；native 改用平台原生能力；yagni 删除无当前需求的抽象或能力。';

const CONTRACT: Record<AuditTemplate, string> = {
    orchestrator: '按正确性、安全性、负载下的稳定性、测试、性能和精简的顺序安排覆盖。P0 为严重数据损坏、关键权限边界失效或核心服务大范围不可用，P1 为典型条件下有实质影响的核心路径错误，P2 为局部或受限缺陷，P3 为有证据的低收益改进。A 类须消除根因、收敛影响、保持公开 API、协议和持久化格式兼容，并有经格式、路径、基线及只读应用预检的完整补丁提案。涉及业务取舍或无法交付可验证候选的已确认问题进入 B。Deferred 须有先闭合的稳定 finding ID。' + AUDIT_TYPE_GUIDE,
    scan: '只读初审。从构建和业务入口追到真实分支、状态变化及现有测试。缺陷需有可观察后果，精简需检查静态、配置、测试和动态引用。审查关注点用于安排覆盖。未取得证据的内容记入 limits。',
    verify: '固定基线，独立验证一条中性问题。对可达性、实际后果和阻止触发的保护都须核对。成立、排除或证据不足都要给具体理由；确定结论须附可回读的路径、行、原文和理由。',
    patch: '在项目原工作目录中自主读取文件，消除根因并保持公开 API、协议和持久化格式。直接在 candidate.artifactDir 写 UTF-8 完整统一 diff，返回仓库相对 patchPath、summary、tradeoff、0 到 100 的整数 confidence、humanDecisions 和 reason；无法安全生成时 status=blocked、patchPath 为空。禁止编辑业务源码或应用提案，包括临时副本；修复效果门禁留给人工批准后的程序。Host 只进行格式、路径、基线和只读应用预检，不把预检称为修复验证。评审数据不得出现在业务补丁中。' + AUDIT_TYPE_GUIDE,
};

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

export function renderPromptText(
    body: string,
    fields: readonly string[],
    values: Readonly<Record<string, string>>,
): string {
    if (Object.keys(values).length !== fields.length || fields.some(key => !Object.hasOwn(values, key) || typeof values[key] !== 'string')) {
        throw new Error('审查模板收到缺失或越界的变量');
    }
    const tokens = new Set([...body.matchAll(PLACEHOLDER)].map(match => match[1]));
    if (tokens.size !== fields.length || fields.some(key => !tokens.has(key))) {
        throw new Error('审查模板的占位符与契约不符');
    }
    return body.replaceAll('\r\n', '\n').replace(PLACEHOLDER, (_, name: string) => values[name]!);
}

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
    if ([...body.matchAll(PLACEHOLDER)].length !== 2) {
        throw new Error('审查模板的占位符与契约不符');
    }
    return renderPromptText(body, ['contractText', 'taskJson'], {
        contractText: CONTRACT[phase], taskJson: JSON.stringify(input, null, 2),
    }).trim();
}

const DIRECT_FIELDS = [
    'repoRoot', 'vcsType', 'owner', 'ownerFallback', 'scope', 'reportScope', 'baseRevision',
    'month', 'reportPath', 'now', 'reviewersText', 'existing', 'negativeMemory', 'outline', 'note',
] as const;

type DirectAuditPromptInput = Record<typeof DIRECT_FIELDS[number], string> & {
    findingWorkflow: boolean;
    mode: 'session' | 'headless';
    priorFindingsJson?: string;
};

async function directAsset(name: string): Promise<string> {
    const text = await readFile(new URL('../../assets/audit/direct/' + name + '.md', import.meta.url), 'utf8');
    return text.replaceAll('\r\n', '\n').replace(/\n$/, '');
}

export async function renderDirectAuditPrompt(input: DirectAuditPromptInput): Promise<string> {
    const { findingWorkflow, mode, priorFindingsJson, ...facts } = input;
    const schemaVersion = findingWorkflow ? '2' : '1';
    const hasHistory = findingWorkflow && priorFindingsJson !== undefined;
    const [body, delivery, history, session, completion] = await Promise.all([
        directAsset('task'),
        directAsset('delivery-v' + schemaVersion),
        hasHistory ? directAsset('history') : '',
        mode === 'session' ? directAsset('session') : '',
        directAsset(mode === 'session' ? 'complete-session' : 'complete-headless'),
    ]);
    const fragments = {
        delivery,
        history: history ? '\n' + history : '',
        session: session ? session + '\n\n' : '',
        completion,
    };
    const template = body.replace(/<!-- (delivery|history|session|completion) -->/g,
        (_, fragment: keyof typeof fragments) => fragments[fragment]);
    return renderPromptText(template, [
        ...DIRECT_FIELDS, 'schemaVersion', 'findingIdField', ...(hasHistory ? ['priorFindingsJson'] : []),
    ], {
        ...facts,
        schemaVersion,
        findingIdField: findingWorkflow ? '\nfinding_id: "<对应的稳定发现编号>"' : '',
        ...(hasHistory ? { priorFindingsJson } : {}),
    });
}
