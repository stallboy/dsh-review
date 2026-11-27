import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import Markdown from 'react-markdown';
import ts from 'typescript';
import { parseDiff } from '../apps/web/src/diff-parser.ts';

function loadComponent(source, globals = {}) {
    const javascript = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const module = { exports: {} };
    const context = vm.createContext({ exports: module.exports, require: name => name === 'react/jsx-runtime' ? jsx : name.endsWith('diff-parser.js') ? { parseDiff } : { default: {} }, ...globals });
    vm.runInContext(javascript, context);
    return context;
}

const { exports: { Diff } } = loadComponent(readFileSync(new URL('../apps/web/src/Diff.tsx', import.meta.url), 'utf8'));
const appSource = readFileSync(new URL('../apps/web/src/views/CandidatePage.tsx', import.meta.url), 'utf8');
const candidateSource = `${appSource.slice(appSource.indexOf('function CandidatePage()'))}\nglobalThis.Page = CandidatePage;`;
const patch = String.raw`diff --git "a/src/\344\270\255\346\226\207.ts" "b/src/\344\270\255\346\226\207.ts"
--- "a/src/\344\270\255\346\226\207.ts"
+++ "b/src/\344\270\255\346\226\207.ts"
@@ -1 +1 @@
-old
+new
`;
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && node.props ? text(node.props.children) : String(node ?? '');

function candidateFixture(extra = {}) {
    let index = 0, tree;
    const hooks = [], effects = [], commands = [], saved = new Map();
    const meta = {
        recordRevision: 2, updatedAt: 'now', owner: '张三', status: 'pending',
        issueKind: 'repair', priority: 'P2', title: '测试问题',
        comments: [{ id: 'old-comment', status: 'unresolved' }],
        options: [{
            id: 'opt-a', currentPatch: 2, summary: '修复方案', reason: '原因', tradeoff: '权衡', confidence: 0.9,
            gateChecks: ['npm run verify'],
        }],
        patches: [
            { id: 1, optionId: 'opt-a', patch: '001.patch', baseRevision: 'b1', sha256: 'a'.repeat(64), author: 'ai', createdAt: 'now' },
            { id: 2, optionId: 'opt-a', patch: '002.patch', baseRevision: 'b1', sha256: 'b'.repeat(64), author: 'ai', createdAt: 'now' },
        ],
        repairAttempts: [], humanDecisions: [], approvalHistory: [],
        ...extra.meta,
    };
    const value = {
        selection: { optionId: 'opt-a', patchId: 2 },
        selectedOption: meta.options[0],
        selectedPatch: meta.patches[1],
        selectedPatchBanned: false,
        candidate: { meta, sections: {}, humanJudgment: [], humanJudgmentDeclared: true },
        finding: null,
        comments: [], validation: [], patchText: patch, ...extra.value,
    };
    const useState = initial => {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], next => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next; }];
    };
    const context = loadComponent(candidateSource, {
        useState, useRef: initial => useState({ current: initial })[0],
        useEffect(effect, deps) {
            const slot = index++;
            if (!hooks[slot] || deps.some((item, i) => !Object.is(item, hooks[slot][i]))) { hooks[slot] = deps; effects.push(effect); }
        },
        useSearchParams: () => [new URLSearchParams()],
        URLSearchParams,
        useParams: () => ({ projectId: 'p', '*': 'candidate-a' }),
        useContext: () => ({ userId: 'u', reviewIdentity: '张三' }), UserContext: {},
        useQueryClient: () => ({ invalidateQueries: () => {} }), useNavigate: () => () => {},
        useMutation: options => ({ mutate: variables => options.mutationFn(variables) }),
        useQuery: options => options.queryKey[0] === 'project'
            ? { data: { project: { name: 'test' }, writable: true, vcsSnapshot: 'snapshot', freshness: 'synced' } }
            : options.queryKey[0] === 'candidate' ? { data: value } : {},
        command: (...args) => { commands.push(args); return Promise.resolve({}); },
        sessionStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, item) => saved.set(key, item), removeItem: key => saved.delete(key) },
        Diff, Markdown, Link: () => null, Heading: () => null, Panel: () => null, ErrorBox: () => null,
        Empty: () => null, Badge: () => null, label: item => item, time: item => item, s: {},
    });
    const render = () => { for (let turn = 0; turn < 2; turn++) { index = 0; tree = context.Page(); while (effects.length) effects.shift()(); } };
    const find = predicate => nodes(tree).find(predicate);
    const button = name => find(node => node.type === 'button' && text(node) === name);
    const tab = name => { button(name).props.onClick(); render(); };
    render();
    return {
        button, tab, commands, text: () => text(tree),
        writeComment(content) {
            tab('审核意见 · 1');
            find(node => node.type === 'textarea' && node.props.placeholder === '说明问题、期望行为与验证方式…').props.onChange({ target: { value: content } });
            render();
        },
        selectAnchor() {
            tab('代码差异');
            find(node => node.type === Diff).props.onSelect({ file: 'src/中文.ts', line: 1, side: 'RIGHT', anchor: { snippet: 'new' } });
            render();
        },
        removeAnchor() { button('移除定位').props.onClick(); render(); },
        comment: () => find(node => node.type === 'textarea' && node.props.placeholder === '说明问题、期望行为与验证方式…').props.value,
        errors: () => nodes(tree).filter(node => node.props.error).map(node => node.props.error),
    };
}

test('AC-UI-01 Git C 风格八进制 UTF-8 路径还原为真实中文文件名', () => {
    assert.equal(parseDiff(patch)[0].name, 'src/中文.ts');
    const binary = String.raw`diff --git "a/\344\270\255\346\226\207.bin" "b/\344\270\255\346\226\207.bin"
Binary files differ`;
    assert.equal(parseDiff(binary)[0].name, '中文.bin');
});

test('AC-UI-01 Git 引号与反斜杠转义不破坏相邻八进制及普通路径', () => {
    const escaped = String.raw`--- "a/src/\344\270\255\040\"name\\344.ts"
+++ "b/src/\344\270\255\040\"name\\344.ts"
@@ -1 +1 @@
-old
+new`;
    assert.equal(parseDiff(escaped)[0].name, 'src/中 "name\\344.ts');
    const svn = 'Index: 目录/文件.ts\n--- 目录/文件.ts\t(revision 1)\n+++ 目录/文件.ts\t(working copy)\n@@ -1 +1 @@\n-old\n+new';
    assert.equal(parseDiff(svn)[0].name, '目录/文件.ts');
    assert.equal(parseDiff('--- a/src/普通 文件.ts\n+++ b/src/普通 文件.ts\n@@ -1 +1 @@\n-old\n+new')[0].name, 'src/普通 文件.ts');
});

test('AC-UI-01 真实差异组件的中文文件评论定位携带已解码路径与正确 side', () => {
    const selected = [];
    const tree = Diff({ text: patch, collapsedFiles: [], onCollapsedFilesChange: () => {}, onSelect: anchor => selected.push(anchor) });
    for (const button of nodes(tree).filter(node => node.type === 'button' && node.props.disabled === false)) button.props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(selected)), [
        { file: 'src/中文.ts', line: 1, side: 'LEFT', anchor: { snippet: 'old' } },
        { file: 'src/中文.ts', line: 1, side: 'RIGHT', anchor: { snippet: 'new' } },
    ]);
});

test('AC-UI-01 SVN Index 路径的 a 与 b 目录保留为真实文件名的一部分', () => {
    for (const name of ['a/中文 文件.ts', 'b/中文.ts']) {
        const svn = `Index: ${name}\n--- ${name}\t(revision 1)\n+++ ${name}\t(working copy)\n@@ -1 +1 @@\n-old\n+new`;
        assert.equal(parseDiff(svn)[0].name, name);
    }
});

test('AC-UI-01 候选页有未提交意见时禁用直接 AI 修复并保留草稿', () => {
    const view = candidateFixture();
    view.writeComment('请检查中文文件');
    assert.equal(view.button('让 AI 按意见修订提案').props.disabled, true);
    assert.match(view.text(), /先提交.*草稿/);
    assert.equal(view.comment(), '请检查中文文件');
    assert.equal(view.commands.length, 0);
    view.writeComment('');
    assert.equal(view.button('让 AI 按意见修订提案').props.disabled, false);
    view.button('让 AI 按意见修订提案').props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(view.commands)), [['p', 'ai-fix', { id: 'candidate-a', optionId: 'opt-a', patchId: 2 }, { expectedRevision: 2, expectedOwner: '张三', expectedUpdatedAt: 'now' }]]);
});

test('中央候选详情提供按意见修复入口，移除人工补丁表单', () => {
    const view = candidateFixture();
    assert.ok(view.button('让 AI 按意见修订提案'));
    assert.doesNotMatch(view.text(), /人工提交新补丁|校验并保存人工版本|Unified Diff/);
});

test('AC-UI-01 候选页只有未提交行定位时也不能忽略草稿直接 AI 修复', () => {
    const view = candidateFixture();
    view.selectAnchor();
    assert.equal(view.button('让 AI 按意见修订提案').props.disabled, true);
    assert.match(view.text(), /先提交.*草稿/);
    assert.match(view.text(), /src\/中文.ts:1 · RIGHT/);
    view.removeAnchor();
    assert.equal(view.button('让 AI 按意见修订提案').props.disabled, false);
});

test('AC-UI-01 已批准候选展示派生业务提交及三态诊断并保留历史门禁', () => {
    for (const [lookup, revision, diagnostic] of [
        ['found', 'business-commit-abc', /已找到/],
        ['ambiguous', undefined, /多个.*提交/],
        ['unknown', undefined, /未.*确认|无法.*确认/],
    ]) {
        const view = candidateFixture({
            meta: { status: 'approved', approval: { optionId: 'opt-a', patchId: 2, approvedBy: '李四', approvedAt: 'approved-at', gateResults: [{ command: 'npm run verify', exitCode: 0 }] } },
            value: { approvalCommitLookup: lookup, approvalCommitRevision: revision },
        });
        assert.match(view.text(), /业务提交/);
        assert.match(view.text(), diagnostic);
        if (revision) assert.ok(view.text().includes(revision));
        assert.equal(view.errors().length, 0);
        view.tab('补丁账本与门禁');
        assert.match(view.text(), /npm run verify/);
        assert.match(view.text(), /当前批准记录.*李四/);
        assert.match(view.text(), /exitCode/);
    }
});
