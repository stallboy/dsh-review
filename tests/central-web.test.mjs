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
