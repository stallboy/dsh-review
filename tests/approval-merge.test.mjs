import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeApprovedText } from '../packages/dsh-plugin/dist/host/approval-merge.js';

const base = Array.from({ length: 20 }, (_, index) => 'line ' + String(index + 1));
const asBytes = (lines) => Buffer.from(lines.join('\n') + '\n');
const changed = (index, value, original = base) => original.map((line, position) => position === index ? value : line);

function patch(index, value, original = base, format = 'git') {
    const header = format === 'svn'
        ? ['Index: sample.txt', '===================================================================',
            '--- sample.txt\t(revision 1)', '+++ sample.txt\t(working copy)']
        : ['diff --git a/sample.txt b/sample.txt', '--- a/sample.txt', '+++ b/sample.txt'];
    return [...header, '@@ -' + (index - 2) + ',7 +' + (index - 2) + ',7 @@',
        ...original.slice(index - 3, index).map(line => ' ' + line), '-' + original[index], '+' + value,
        ...original.slice(index + 1, index + 4).map(line => ' ' + line), '',
    ].join('\n');
}

const merge = (text, target, source = base) => mergeApprovedText(text, [{
    path: 'sample.txt', source: asBytes(source), target: asBytes(target), targetIdentity: 'fixture',
}]);

for (const format of ['git', 'svn']) {
    test(format + ' 相邻改动交换合并顺序时保持待交付差异', async () => {
        for (const [prior, next] of [[4, 6], [6, 4]]) {
            const outcome = await merge(patch(next, 'edit ' + next, base, format), changed(prior, 'edit ' + prior));
            assert.equal(outcome.status, 'merged', JSON.stringify(outcome));
            assert.deepEqual(outcome.files.get('sample.txt'), asBytes(changed(next, 'edit ' + next, changed(prior, 'edit ' + prior))));
        }
    });
}

test('三方合并保留明确的位置偏移', async () => {
    const result = await merge(patch(6, 'reviewed'), ['prefix', ...base]);
    assert.equal(result.status, 'merged', JSON.stringify(result));
    assert.deepEqual(result.files.get('sample.txt'), asBytes(['prefix', ...changed(6, 'reviewed')]));
});

test('三方合并报告同一行冲突和已全部生效', async () => {
    assert.equal((await merge(patch(6, 'reviewed'), changed(6, 'upstream'))).status, 'conflict');
    assert.equal((await merge(patch(6, 'reviewed'), changed(6, 'reviewed'))).status, 'conflict');
});

test('重复文本使修改位置不能唯一核对', async () => {
    const repeat = [...base, ...base];
    const result = await merge(patch(6, 'reviewed', repeat), [...repeat, 'new tail'], repeat);
    assert.equal(result.status, 'conflict', JSON.stringify(result));
});

test('取消或超出首期范围时不返回可交付内容', async () => {
    const file = { path: 'sample.txt', source: asBytes(base), target: asBytes(base), targetIdentity: 'fixture' };
    assert.equal((await mergeApprovedText(patch(6, 'reviewed'), [file], AbortSignal.abort())).status, 'unavailable');
    assert.equal((await mergeApprovedText('diff --git a/sample.txt b/sample.txt\nold mode 100644\nnew mode 100755\n', [file])).status, 'unsupported');
});
