import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiff } from '../apps/web/src/diff-parser.ts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

test('差异区内加减号开头的代码仍完整显示，不被当作文件头', () => {
    const files = parseDiff('diff --git a/src/count.cpp b/src/count.cpp\n--- a/src/count.cpp\n+++ b/src/count.cpp\n@@ -1 +1 @@\n--- count;\n+++ count;\n');
    assert.equal(files[0].name, 'src/count.cpp');
    assert.deepEqual(files[0].lines.slice(1), [
        { text: '-- count;', kind: 'removed', left: 1 },
        { text: '++ count;', kind: 'added', right: 1 },
    ]);
});

test('删除文件头不会显示成新增代码，连续 Unified/SVN 文件保留各自定位', () => {
    const files = parseDiff('Index: old.cpp\n--- old.cpp\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\nIndex: new.cpp\n--- /dev/null\n+++ new.cpp\n@@ -0,0 +1 @@\n+new\n');
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'old.cpp');
    assert.deepEqual(files[0].lines.slice(1), [{ text: 'old', kind: 'removed', left: 1 }]);
    assert.deepEqual(files[1].lines.slice(1), [{ text: 'new', kind: 'added', right: 1 }]);
});

test('注销立即清空当前会话观察值及业务缓存，界面无需等轮询才退出', async () => {
    const { clearSession } = await import('../apps/web/src/api.ts');
    const client = new QueryClient();
    const observer = new QueryObserver(client, { queryKey: ['session'], enabled: false, initialData: { user: { userId: 'a' }, csrfToken: 'test' } });
    const unsubscribe = observer.subscribe(() => {});
    client.setQueryData(['projects'], { secret: 'cached-project-data' });
    assert.equal(typeof clearSession, 'function');
    clearSession(client);
    assert.equal(observer.getCurrentResult().data, null);
    assert.equal(client.getQueryData(['projects']), undefined);
    unsubscribe();
    client.clear();
});

test('注销取消旧会话刷新，迟到的旧账号响应不能覆盖重新登录的账号', async () => {
    const { clearSession } = await import('../apps/web/src/api.ts');
    const client = new QueryClient();
    let finish;
    const observer = new QueryObserver(client, { queryKey: ['session'], enabled: false, initialData: { user: 'account-a', csrfToken: 'old-csrf' },
        queryFn: () => new Promise(resolve => { finish = resolve; }) });
    const unsubscribe = observer.subscribe(() => {});
    const pending = observer.refetch();
    clearSession(client);
    client.setQueryData(['session'], { user: 'account-b', csrfToken: 'new-csrf' });
    finish({ user: 'account-a', csrfToken: 'old-csrf' });
    await pending;
    assert.equal(observer.getCurrentResult().data.user, 'account-b');
    assert.equal(observer.getCurrentResult().data.csrfToken, 'new-csrf');
    unsubscribe();
    client.clear();
});

test('定时审查设置通过项目接口提交本地时刻、时区和 CSRF 令牌', async t => {
    const { saveAuditSchedule, setSession } = await import('../apps/web/src/api.ts');
    const settings = { enabled: true, startTime: '08:45', timeZone: 'Asia/Shanghai' };
    const auditSchedule = { ...settings, nextRunAt: '2026-11-19T00:45:00.000Z', lastRun: null };
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ auditSchedule }));
    setSession({ csrfToken: 'audit-csrf', user: { userId: 'u', username: 'name', reviewIdentity: '张三' } });
    t.after(() => setSession(null));

    assert.deepEqual(await saveAuditSchedule('project-1', settings), { auditSchedule });
    assert.equal(fetch.mock.callCount(), 1);
    const [url, options] = fetch.mock.calls[0].arguments;
    assert.equal(url, '/api/v1/projects/project-1/audit-schedule');
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers['x-csrf-token'], 'audit-csrf');
    assert.deepEqual(JSON.parse(options.body), settings);
});

test('定时计划保存重试复用键，编辑提交版本，启停只发送状态', async t => {
    const { saveAuditPlan, setAuditPlanEnabled } = await import('../apps/web/src/api.ts');
    const settings = { name: '定时复查', enabled: true, startTime: '08:45', timeZone: 'Asia/Shanghai', recurrence: { kind: 'daily' }, note: '' };
    const auditPlan = { ...settings, planId: 'plan-a', version: 4 };
    let fail = true;
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
        if (fail) {
            fail = false;
            throw new TypeError('response lost');
        }
        return Response.json({ auditPlan });
    });

    await assert.rejects(saveAuditPlan('project-a', settings), /response lost/);
    await saveAuditPlan('project-a', settings);
    await saveAuditPlan('project-a', settings);
    await saveAuditPlan('project-a', settings, auditPlan);
    await setAuditPlanEnabled('project-a', auditPlan.planId, false);
    const options = fetch.mock.calls.map(call => call.arguments[1]);
    assert.match(options[0].headers['idempotency-key'], /^[a-f0-9]{32}$/);
    assert.equal(options[1].headers['idempotency-key'], options[0].headers['idempotency-key']);
    assert.notEqual(options[2].headers['idempotency-key'], options[0].headers['idempotency-key']);
    assert.equal(options[3].method, 'PUT');
    assert.deepEqual(JSON.parse(options[3].body), { ...settings, expectedVersion: auditPlan.version });
    assert.equal(options[4].method, 'PATCH');
    assert.deepEqual(JSON.parse(options[4].body), { enabled: false });
});
