import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function runAuditChannel(prompt, { empty = false } = {}) {
    const address = /http:\/\/127\.0\.0\.1:\d+\//.exec(prompt)?.[0];
    const bearer = /Authorization: Bearer ([\w-]+)[。.]/.exec(prompt)?.[1];
    assert.ok(address && bearer);
    const send = (body, authenticated = true) => fetch(address, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + bearer } : {}) },
        body: JSON.stringify(body),
    });
    async function invoke(body, expected = 200) {
        const response = await send(body);
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result));
        return result;
    }
    const stage = (stage, task) => invoke({ operation: 'runAuditStage', stage, runner: 'codex', task });
    assert.equal((await send({ operation: 'queryAuditHistory' }, false)).status, 404);
    const scan = await stage('scan', { taskScope: ['src'], scenarios: [], questions: [], constraints: [] });
    if (empty) {
        const { result } = await invoke({ operation: 'publishAuditArtifacts', publication: {
            findings: [], coverage: ['固定样本无问题'], requirements: [], history: [],
        } });
        assert.deepEqual(result.overview, []);
        return result;
    }
    for (const lead of scan.result.leads) {
        await stage('verify', { subjectId: lead.leadId, scenario: 'reachable_behavior', navigation: lead.navigation, expectationIndexes: [] });
    }
    const patch = await stage('patch', { subjectId: 'local-fix', auditType: 'bugfix', allowedPaths: scan.result.leads[0].navigation.map(item => item.path),
        acceptance: ['加法返回正确结果'], gateCommands: ['node --version'] });
    assert.equal(patch.result.status, 'ready');
    const findings = [
        { subjectId: 'local-fix', title: '加法结果错误', priority: 'P2', kind: 'A', decision: '', dependsOn: '', findingId: 'local-fix' },
        { subjectId: 'policy-fix', title: '政策仍需确认', priority: 'P0', kind: 'B', decision: '确认政策前提', dependsOn: '', findingId: 'policy-fix' },
        { subjectId: 'future-fix', title: '等待政策落地', priority: 'P1', kind: 'Deferred', decision: '', dependsOn: 'policy-fix', findingId: 'future-fix' },
    ].map(item => ({ ...item, repairPlan: '先核对计算边界，再验证加法输出。' }));
    const publication = { findings, coverage: ['固定样本'], requirements: [], history: [] };
    const invalid = await invoke({ operation: 'publishAuditArtifacts', publication: {
        ...publication, findings: [{ ...findings[0], priority: '' }, ...findings.slice(1)],
    } }, 409);
    assert.match(invalid.error, /priority/);
    const response = await invoke({ operation: 'publishAuditArtifacts', publication });
    assert.deepEqual(response.result.overview.map(item => item.priority + '/' + item.kind), ['P0/B', 'P1/Deferred', 'P2/A']);
    return response.result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let prompt = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) prompt += chunk;
    const result = await runAuditChannel(prompt, { empty: process.argv.includes('empty') });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (process.argv.includes('hold')) await new Promise(resolve => setTimeout(resolve, 800));
}
