import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(path.join(root, 'packages/dsh-plugin/dist/client.js'), 'utf8');

function initialStatus() {
    return {
        controlToken: 'control-secret', configured: true, enabled: true, mode: 'local',
        centerUrl: 'http://127.0.0.1:42100', centralId: 'central-a', nodeId: 'node-a', reviewIdentity: '张三',
        phase: 'ready', nodeOnline: true, generation: 1, hasCredentials: true, localAvailable: true, logs: [],
        candidates: [
            { id: 'candidate-a', label: '同名项目', root: 'C:/work/a', vcsType: 'git', target: 'main', current: true },
            { id: 'candidate-b', label: '同名项目', root: 'C:/work/b', vcsType: 'git', target: 'main', current: false },
        ],
        projects: [],
    };
}

function createPanel(status = initialStatus()) {
    let current = null;
    let dirty = false;
    let tree;
    let view;
    let disposed = false;
    let activeStatus = status;
    let pendingRequest = false;
    let sessionId = 'session-a';
    let failedWrite = '';
    const components = new Map();
    const requests = [];
    const timers = new Map();
    const effects = [];
    const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const react = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState(initial) {
            const owner = current;
            const index = owner.index++;
            if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial;
            return [owner.hooks[index], next => {
                owner.hooks[index] = typeof next === 'function' ? next(owner.hooks[index]) : next;
                dirty = true;
            }];
        },
        useRef(initial) {
            const [value] = react.useState(() => ({ current: initial }));
            return value;
        },
        useMemo(factory, deps) {
            const owner = current;
            const index = owner.index++;
            if (!same(owner.hooks[index]?.deps, deps)) owner.hooks[index] = { deps, value: factory() };
            return owner.hooks[index].value;
        },
        useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
        useEffect(effect, deps) {
            const owner = current;
            const index = owner.index++;
            if (!same(owner.hooks[index]?.deps, deps)) {
                effects.push(() => {
                    owner.hooks[index]?.cleanup?.();
                    owner.hooks[index] = { deps, cleanup: effect() };
                });
            }
        },
        useReducer(reducer, initial) {
            const [value, set] = react.useState(initial);
            return [value, action => set(previous => reducer(previous, action))];
        },
    };
    const document = {
        baseURI: 'http://dsh.test/', documentElement: { lang: 'zh' },
        head: { appendChild() {} }, querySelectorAll: () => [],
        createElement: () => ({ setAttribute() {}, remove() {} }),
    };
    const context = vm.createContext({
        window: { __ModuleLoader__: { load(registration) {
            const plugin = registration.factory(() => react);
            plugin.apply({
                locale: { register: () => () => {}, bind: () => key => key },
                effect: callback => callback(), get: () => undefined,
                slots: { inject: (_name, callback) => callback(), register: (_options, component) => { view = component; } },
            });
        } } },
        document, URL, URLSearchParams, AbortController, console, setTimeout, clearTimeout,
        setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); },
        async fetch(url, init) {
            requests.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
            if (pendingRequest) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            if (failedWrite && init.method === 'POST') return { ok: false, status: 409, text: async () => JSON.stringify({ error: { message: failedWrite } }) };
            const value = String(url).includes('/connection') ? activeStatus
                : String(url).includes('/health') ? { configured: false, counts: {}, diagnostics: [] }
                : { settings: { owner: '' }, validation: { ok: true, errors: [] }, runners: [] };
            return { ok: true, status: 200, text: async () => JSON.stringify(value) };
        },
    });
    vm.runInContext(bundle, context);
    function materialize(node, key = 'root') {
        if (Array.isArray(node)) return node.map((child, index) => materialize(child, `${key}.${index}`));
        if (!node || typeof node !== 'object') return node;
        if (typeof node.type === 'function') {
            let owner = components.get(key);
            if (!owner || owner.type !== node.type) {
                owner = { type: node.type, hooks: [], index: 0 };
                components.set(key, owner);
            }
            current = owner;
            owner.index = 0;
            return materialize(node.type(node.props), `${key}.child`);
        }
        return { ...node, children: node.children.map((child, index) => materialize(child, `${key}.${index}`)) };
    }
    async function flush() {
        for (let turn = 0; turn < 12; turn++) {
            if (disposed) return;
            dirty = false;
            tree = materialize(view({ sessionId }));
            while (effects.length) effects.shift()();
            await new Promise(resolve => setImmediate(resolve));
            if (!dirty) return;
        }
        throw new Error('界面状态未稳定');
    }
    function nodes(node = tree) {
        if (Array.isArray(node)) return node.flatMap(child => nodes(child));
        if (!node || typeof node !== 'object') return [];
        return [node, ...node.children.flatMap(child => nodes(child))];
    }
    function textOf(node) {
        if (Array.isArray(node)) return node.map(textOf).join('');
        return node && typeof node === 'object' ? node.children.map(textOf).join('') : String(node ?? '');
    }
    return {
        requests, timers, flush, nodes, text: () => textOf(tree),
        button(label) {
            const node = nodes().find(node => node.type === 'button' && textOf(node) === label);
            assert.ok(node, `缺少按钮：${label}`);
            return node;
        },
        input(label) {
            const node = nodes().find(node => node.type === 'input' && node.props['aria-label'] === label);
            assert.ok(node, `缺少输入框：${label}`);
            return node;
        },
        setStatus(next) { activeStatus = next; },
        setSession(next) { sessionId = next; },
        failWrites(message) { failedWrite = message; },
        async poll() { for (const callback of [...timers.values()]) callback(); await flush(); },
        holdRequests() { pendingRequest = true; },
        releaseRequests() { pendingRequest = false; },
        unmount() {
            disposed = true;
            for (const owner of components.values()) for (const hook of owner.hooks) hook?.cleanup?.();
        },
    };
}

test('中央连接默认展示，编辑草稿和状态刷新均不会启动或覆盖输入', async () => {
    const panel = createPanel();
    await panel.flush();
    for (const label of ['中央连接', '项目接入', '中央工作台', '本地评审']) panel.button(label);
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    panel.input('中央地址').props.onChange({ target: { value: 'https://central.example' } });
    panel.input('节点 Token').props.onChange({ target: { value: 'new-token' } });
    await panel.flush();
    panel.setStatus({ ...initialStatus(), centerUrl: 'http://saved.test', nodeOnline: false });
    await panel.poll();
    assert.equal(panel.input('中央地址').props.value, 'https://central.example');
    assert.equal(panel.input('节点 Token').props.value, 'new-token');
    assert.equal(panel.input('节点 Token').props.type, 'password');
    assert.equal(panel.requests.filter(request => request.init.method !== 'GET').length, 0);
    assert.ok(panel.requests.every(request => request.url.searchParams.get('sessionId') === 'session-a'));
    panel.unmount();
});

test('显式应用和测试携带控制令牌，空 Token 保留已有凭据且停止单独提交', async () => {
    const panel = createPanel();
    await panel.flush();
    assert.equal(panel.input('审核身份').props.value, '张三');
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    let writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.equal(writes[0].url.pathname, '/dsh-code-review/connection/apply');
    assert.deepEqual(writes[0].body, { mode: 'local', reviewIdentity: '张三' });
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    assert.equal(panel.input('节点 Token').props.value, '');
    panel.input('中央地址').props.onChange({ target: { value: 'https://central.example' } });
    panel.input('节点 ID').props.onChange({ target: { value: 'node-b' } });
    panel.input('节点 Token').props.onChange({ target: { value: 'node-secret' } });
    await panel.flush();
    panel.button('测试连接').props.onClick();
    await panel.flush();
    writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.equal(writes[1].url.pathname, '/dsh-code-review/connection/test');
    assert.deepEqual(writes[1].body, { centerUrl: 'https://central.example', nodeId: 'node-b', token: 'node-secret' });
    panel.button('应用并连接').props.onClick();
    await panel.flush();
    writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.deepEqual(writes[2].body, { mode: 'external', centerUrl: 'https://central.example', nodeId: 'node-b', token: 'node-secret', reviewIdentity: '张三' });
    assert.equal(panel.input('节点 Token').props.value, '');
    panel.button('停止连接').props.onClick();
    await panel.flush();
    writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.equal(writes[3].url.pathname, '/dsh-code-review/connection/stop');
    assert.deepEqual(writes[3].body, {});
    for (const request of writes) {
        assert.equal(request.init.headers['x-dsh-review-control'], 'control-secret');
        assert.equal(request.url.searchParams.has('controlToken'), false);
    }
    panel.unmount();
});

test('同名不同目录的项目分别接入，当前项目有快捷入口且停用只按 workspaceId', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.button('项目接入').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /C:\/work\/a/);
    assert.match(panel.text(), /C:\/work\/b/);
    assert.match(panel.text(), /当前项目/);
    const join = panel.nodes().filter(node => node.type === 'button' && node.children.join('') === '接入项目');
    assert.equal(join.length, 2);
    join[0].props.onClick();
    await panel.flush();
    join[1].props.onClick();
    await panel.flush();
    const writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.deepEqual(writes.map(request => request.body), [{ candidateId: 'candidate-a', enabled: true }, { candidateId: 'candidate-b', enabled: true }]);
    panel.setStatus({ ...initialStatus(), projects: [{ workspaceId: 'workspace-a', projectId: 'project-a', root: 'C:/work/a', label: '同名项目', enabled: true, vcsType: 'git', target: 'main' }] });
    await panel.poll();
    panel.button('停用项目').props.onClick();
    await panel.flush();
    assert.deepEqual(panel.requests.filter(request => request.init.method === 'POST').at(-1).body, { workspaceId: 'workspace-a', enabled: false });
    assert.ok(panel.nodes().some(node => node.type === 'a' && node.props.href === '/dsh-code-review/central/projects/project-a'));
    panel.unmount();
});

test('中央工作台使用同源 iframe，中央代次变化重建且卸载仅停止请求', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.button('中央工作台').props.onClick();
    await panel.flush();
    let frame = panel.nodes().find(node => node.type === 'iframe');
    assert.equal(frame?.props.src, '/dsh-code-review/central/');
    const previousKey = frame.props.key;
    panel.setStatus({ ...initialStatus(), generation: 2 });
    await panel.poll();
    frame = panel.nodes().find(node => node.type === 'iframe');
    assert.notEqual(frame.props.key, previousKey);
    panel.holdRequests();
    for (const callback of panel.timers.values()) callback();
    const pending = panel.requests.at(-1);
    panel.unmount();
    assert.equal(panel.timers.size, 0);
    assert.equal(pending.init.signal.aborted, true);
    assert.equal(panel.requests.filter(request => request.url.pathname.endsWith('/stop')).length, 0);
});

test('重试使用已保存配置，待应用草稿及令牌不会随重试提交', async () => {
    const panel = createPanel({ ...initialStatus(), mode: 'external', phase: 'error', error: '节点认证失败' });
    await panel.flush();
    panel.input('中央地址').props.onChange({ target: { value: 'https://draft.example' } });
    panel.input('节点 Token').props.onChange({ target: { value: 'draft-secret' } });
    await panel.flush();
    panel.button('重试已保存连接').props.onClick();
    await panel.flush();
    assert.deepEqual(panel.requests.find(request => request.init.method === 'POST').body, {
        mode: 'external', reviewIdentity: '张三', centerUrl: 'http://127.0.0.1:42100', nodeId: 'node-a',
    });
    assert.equal(panel.input('中央地址').props.value, 'https://draft.example');
    assert.equal(panel.input('节点 Token').props.value, 'draft-secret');
    panel.unmount();
});

test('失败操作原因在正常轮询后仍保留，避免未决任务阻止提示消失', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.failWrites('仍有未确认事件，不能停止连接');
    panel.button('停止连接').props.onClick();
    await panel.flush();
    await panel.poll();
    assert.match(panel.text(), /仍有未确认事件，不能停止连接/);
    panel.unmount();
});

test('切换会话取消旧请求并解除旧操作忙碌状态，草稿继续保留', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.input('审核身份').props.onChange({ target: { value: '草稿审核者' } });
    await panel.flush();
    panel.holdRequests();
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    const previousRequest = panel.requests.at(-1);
    assert.equal(panel.button('应用并启动').props.disabled, true);
    panel.releaseRequests();
    panel.setSession('session-b');
    await panel.flush();
    assert.equal(previousRequest.init.signal.aborted, true);
    assert.equal(panel.button('应用并启动').props.disabled, false);
    assert.equal(panel.input('审核身份').props.value, '草稿审核者');
    assert.equal(panel.requests.at(-1).url.searchParams.get('sessionId'), 'session-b');
    panel.unmount();
});

test('轻量插件禁用本机启动但仍允许选择已有中央', async () => {
    const panel = createPanel({ ...initialStatus(), localAvailable: false, configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    assert.equal(panel.button('应用并启动').props.disabled, true);
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    assert.equal(panel.button('应用并连接').props.disabled, false);
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 0);
    panel.unmount();
});

test('存在已保存中央配置时本地评审明确引导中央操作，不加载旧可写面板', async () => {
    const panel = createPanel({ ...initialStatus(), enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.button('本地评审').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /请通过中央工作台/);
    assert.equal(panel.requests.some(request => request.url.pathname.startsWith('/dsh-code-review/api')), false);
    panel.unmount();
});

test('尚未保存中央配置时仍能打开原本地评审面板', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.button('本地评审').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.some(request => request.url.pathname === '/dsh-code-review/api/health'), true);
    panel.unmount();
});

test('旧托管节点诊断提示先处理任务并停用后重启，禁止覆盖连接及本地写入口', async () => {
    const panel = createPanel({ ...initialStatus(), legacy: true, configured: false });
    await panel.flush();
    assert.match(panel.text(), /旧托管配置/);
    assert.match(panel.text(), /处理.*任务.*停用.*重启/);
    assert.equal(panel.button('应用并启动').props.disabled, true);
    assert.equal(panel.button('停止连接').props.disabled, true);
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.some(request => request.init.method === 'POST'), false);
    panel.button('本地评审').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.some(request => request.url.pathname.startsWith('/dsh-code-review/api')), false);
    panel.unmount();
});

test('旧托管配置保留既有中央外链，本地评审指引可到达同一入口', async () => {
    const panel = createPanel({ ...initialStatus(), legacy: true, configured: false, enabled: false, phase: 'stopped', centerUrl: 'https://legacy-central.example' });
    await panel.flush();
    for (const label of ['中央工作台', '本地评审']) {
        panel.button(label).props.onClick();
        await panel.flush();
        if (label === '本地评审') {
            panel.button('进入中央工作台').props.onClick();
            await panel.flush();
        }
        const link = panel.nodes().find(node => node.type === 'a' && node.children.join('') === '打开已有中央工作台');
        assert.ok(link, '旧托管配置缺少既有中央入口');
        assert.equal(link.props.href, 'https://legacy-central.example');
        assert.equal(link.props.target, '_blank');
        assert.equal(link.props.rel, 'noopener noreferrer');
        assert.equal(panel.nodes().some(node => node.type === 'iframe'), false);
    }
    assert.equal(panel.requests.some(request => request.url.pathname.startsWith('/dsh-code-review/api')), false);
    assert.equal(panel.requests.some(request => request.init.method === 'POST'), false);
    panel.unmount();
});

test('旧托管中央地址无效时明确提示且不生成外链或网关 iframe', async () => {
    const panel = createPanel({ ...initialStatus(), legacy: true, configured: false, enabled: false, phase: 'stopped', centerUrl: '' });
    await panel.flush();
    panel.button('中央工作台').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /中央地址无效/);
    assert.equal(panel.nodes().some(node => node.type === 'a' || node.type === 'iframe'), false);
    panel.unmount();
});

test('中央 Web API 同时支持根路径和内嵌子路径并保留 CSRF', async () => {
    const originalDocument = globalThis.document;
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => ({}) }; };
    try {
        for (const [baseURI, expected] of [
            ['http://central.test/', '/api/v1/session'],
            ['http://dsh.test/dsh-code-review/central/', '/dsh-code-review/central/api/v1/session'],
        ]) {
            globalThis.document = { baseURI };
            const api = await import(`../apps/web/src/api.ts?base=${encodeURIComponent(baseURI)}`);
            api.setSession({ user: { userId: 'user-a', username: 'a', reviewIdentity: '张三' }, csrfToken: 'csrf-secret' });
            await api.request('/session', 'POST', {});
            assert.equal(requests.at(-1).url, expected);
            assert.equal(requests.at(-1).init.headers['x-csrf-token'], 'csrf-secret');
        }
    } finally {
        globalThis.document = originalDocument;
        globalThis.fetch = originalFetch;
    }
});

test('中央 Web 按 HTML 基础路径注册 Router，嵌套项目路由保留网关前缀', () => {
    const source = readFileSync(path.join(root, 'apps/web/src/main.tsx'), 'utf8');
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
    for (const [baseURI, expected] of [['http://central.test/', '/'], ['http://dsh.test/dsh-code-review/central/', '/dsh-code-review/central']]) {
        let tree;
        const BrowserRouter = Symbol('BrowserRouter');
        const context = vm.createContext({
            exports: {}, URL, document: { baseURI, getElementById: () => ({}) },
            require(id) {
                if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
                if (id === 'react-dom/client') return { createRoot: () => ({ render: value => { tree = value; } }) };
                if (id === 'react-router-dom') return { BrowserRouter };
                if (id === '@tanstack/react-query') return { QueryClient: class {}, QueryClientProvider: Symbol('QueryClientProvider') };
                return {};
            },
        });
        vm.runInContext(javascript, context);
        assert.equal(tree.children[0].children[0].type, BrowserRouter);
        assert.equal(tree.children[0].children[0].props.basename, expected);
    }
});

test('构建后的中央资源通过 HTML base 同时解析到独立服务和内嵌路径', () => {
    const html = readFileSync(path.join(root, 'apps/web/dist/index.html'), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="([^"<>]+\.(?:js|css))"/g)].map(match => match[1]);
    assert.equal(assets.length >= 2, true);
    for (const asset of assets) {
        assert.equal(new URL(asset, 'http://central.test/').pathname.startsWith('/assets/'), true);
        assert.equal(new URL(asset, 'http://dsh.test/dsh-code-review/central/').pathname.startsWith('/dsh-code-review/central/assets/'), true);
    }
    assert.equal(html.match(/<base\s+href="([^"]+)"/)?.[1], '/');
    assert.equal([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].some(match => match[2].trim()), false);
});
