import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import Markdown from 'react-markdown';
import ts from 'typescript';
import { parseDiff } from '../apps/web/src/diff-parser.ts';

const javascript = ts.transpileModule(readFileSync(new URL('../apps/web/src/Diff.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(javascript, { exports: module.exports, require: name => name === 'react/jsx-runtime' ? jsx : name.endsWith('diff-parser.js') ? { parseDiff } : { default: {} } });
const { Diff } = module.exports;
const patch = ['a.ts', 'b.ts'].map(name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`).join('');

function fixture(allowLeft = true) {
    let collapsedFiles = [], tree;
    const selected = [];
    const render = (text = patch) => {
        tree = Diff({ text, allowLeft, onSelect: anchor => selected.push(anchor), collapsedFiles,
            onCollapsedFilesChange: next => { collapsedFiles = next; } });
    };
    const nodes = (node = tree) => Array.isArray(node) ? node.flatMap(child => nodes(child))
        : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children ?? null)] : [];
    const text = node => Array.isArray(node) ? node.map(text).join('')
        : node && typeof node === 'object' && node.props ? text(node.props.children) : String(node ?? '');
    render();
    return { render, nodes, selected, files: () => nodes().filter(node => node.type === 'details'),
        button: label => nodes().find(node => node.type === 'button' && text(node) === label), text: () => text(tree) };
}

test('文件默认展开，单独折叠与刷新保留彼此独立的状态', () => {
    const view = fixture();
    assert.equal(view.files().length, 2);
    assert.deepEqual(view.files().map(file => file.props.open), [true, true]);
    view.files()[0].props.onToggle({ currentTarget: { open: false } });
    view.render();
    assert.deepEqual(view.files().map(file => file.props.open), [false, true]);
    view.render(patch.slice());
    assert.deepEqual(view.files().map(file => file.props.open), [false, true]);
    assert.match(view.text(), /a.ts/);
    assert.match(view.text(), /\+1/);
    assert.match(view.text(), /−1/);
});

test('全部收起与全部展开覆盖每个文件，原生 toggle 事件不反向覆盖批量状态', () => {
    const view = fixture();
    assert.equal(typeof view.button('全部收起')?.props.onClick, 'function');
    view.button('全部收起').props.onClick();
    view.render();
    for (const file of view.files()) file.props.onToggle({ currentTarget: { open: false } });
    view.render();
    assert.deepEqual(view.files().map(file => file.props.open), [false, false]);
    view.button('全部展开').props.onClick();
    view.render();
    assert.deepEqual(view.files().map(file => file.props.open), [true, true]);
});

test('折叠后重新展开仍向原文件和 LEFT/RIGHT 行号提交评论定位', () => {
    const view = fixture();
    assert.equal(view.files().length, 2);
    view.files()[1].props.onToggle({ currentTarget: { open: false } });
    view.render();
    view.files()[1].props.onToggle({ currentTarget: { open: true } });
    view.render();
    const buttons = view.nodes(view.files()[1]).filter(node => node.type === 'button' && !node.props.disabled);
    buttons[0].props.onClick();
    buttons.at(-1).props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(view.selected)), [
        { file: 'b.ts', line: 1, side: 'LEFT', anchor: { snippet: 'old' } },
        { file: 'b.ts', line: 1, side: 'RIGHT', anchor: { snippet: 'new' } },
    ]);
});

test('增量差异仍禁用 LEFT 定位，空比较响应不清除折叠记录', () => {
    const view = fixture(false);
    assert.equal(view.files().length, 2);
    const lineButtons = view.nodes(view.files()[0]).filter(node => node.type === 'button');
    assert.ok(lineButtons.some(node => node.props.disabled));
    view.files()[0].props.onToggle({ currentTarget: { open: false } });
    view.render('');
    assert.match(view.text(), /没有可显示/);
    view.render();
    assert.deepEqual(view.files().map(file => file.props.open), [false, true]);
    const enabled = view.nodes().filter(node => node.type === 'button' && node.props.disabled === false);
    for (const button of enabled) button.props.onClick();
    assert.ok(view.selected.length > 0);
    assert.ok(view.selected.every(anchor => anchor.side === 'RIGHT'));
});

function candidateFixture() {
    const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
    const script = ts.transpileModule(`${source.slice(source.indexOf('function CandidatePage()'))}\nglobalThis.Page = CandidatePage;`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    let index = 0, tree, available = true, id = 'candidate-a';
    const hooks = [], effects = [];
    const meta = { currentRevision: 2, updatedAt: 'now', owner: '张三', status: 'pending', comments: [], revisions: [{ id: 1 }, { id: 2 }], gateChecks: [] };
    const value = { candidate: { meta, sections: {}, humanJudgment: [], humanJudgmentDeclared: true }, comments: [], validation: [], patchText: patch };
    const useState = initial => {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], next => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next; }];
    };
    const context = vm.createContext({
        require: () => jsx, exports: {}, useState, URLSearchParams,
        useRef: initial => useState({ current: initial })[0],
        useEffect(effect, deps) {
            const slot = index++;
            if (!hooks[slot] || deps.some((item, i) => !Object.is(item, hooks[slot][i]))) { hooks[slot] = deps; effects.push(effect); }
        },
        useSearchParams: () => [new URLSearchParams()],
        useParams: () => ({ projectId: 'p', '*': id }), useContext: () => ({ userId: 'u', reviewIdentity: '张三' }), UserContext: {},
        useQueryClient: () => ({}), useNavigate: () => () => {}, useMutation: () => ({}),
        useQuery: options => options.queryKey[0] === 'project' ? { data: { project: { name: 'test' }, writable: true, vcsSnapshot: 'snapshot', freshness: 'synced' } }
            : options.queryKey[0] === 'candidate' ? { data: available ? value : undefined } : options.queryKey[0] === 'comparison' ? { data: { unifiedDiff: patch } } : {},
        sessionStorage: { getItem: () => null }, Diff, Markdown, Link: () => null, Heading: () => null, Panel: () => null,
        ErrorBox: () => null, Empty: () => null, Badge: () => null, label: item => item, time: item => item, s: {},
    });
    vm.runInContext(script, context);
    const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children)] : [];
    const render = () => { for (let turn = 0; turn < 2; turn++) { index = 0; tree = context.Page(); while (effects.length) effects.shift()(); } };
    render();
    nodes(tree).find(node => node.type === 'button' && node.props.children === '代码差异').props.onClick();
    render();
    return {
        fold() { nodes(tree).find(node => node.type === Diff).props.onCollapsedFilesChange(['0/a.ts']); render(); },
        collapsed: () => JSON.parse(JSON.stringify(nodes(tree).find(node => node.type === Diff).props.collapsedFiles)),
        range(next) { nodes(tree).find(node => node.type === 'select').props.onChange({ target: { value: next } }); render(); },
        refresh(next = {}) { if ('available' in next) available = next.available; if ('id' in next) id = next.id; if ('revision' in next) meta.currentRevision = next.revision; render(); },
    };
}

test('真实候选页比较范围来回切换均重置折叠，不复活旧范围记录', () => {
    const view = candidateFixture();
    view.fold();
    assert.deepEqual(view.collapsed(), ['0/a.ts']);
    view.range('1');
    assert.deepEqual(view.collapsed(), []);
    view.range('0');
    assert.deepEqual(view.collapsed(), []);
});

test('候选页刷新暂时无数据仍保留折叠，更换版本或候选后重置', () => {
    const view = candidateFixture();
    view.fold();
    view.refresh({ available: false });
    view.refresh({ available: true });
    assert.deepEqual(view.collapsed(), ['0/a.ts']);
    view.refresh({ revision: 3 });
    assert.deepEqual(view.collapsed(), []);
    view.fold();
    view.refresh({ id: 'candidate-b', available: false });
    view.refresh({ id: 'candidate-a', available: true });
    assert.deepEqual(view.collapsed(), []);
});
