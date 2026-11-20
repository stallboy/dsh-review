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

function createPanel(status = initialStatus(), confirm = () => { throw new Error('意外的下载确认'); }) {
    let current = null;
    let dirty = false;
    let tree;
    let view;
    let disposed = false;
    let activeStatus = status;
    let pendingRequest = false;
    let holdApply = false;
    let sessionId;
    let repoRoot = '';
    let failedWrite = '';
    let testResult;
    let delayNextRead = false;
    let failNextRead = false;
    const delayedReads = [];
    const delayedApplies = [];
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
        window: { confirm, __ModuleLoader__: { load(registration) {
            const plugin = registration.factory(() => react);
            plugin.apply({
                locale: { register: () => () => {}, bind: () => key => key },
                effect: callback => callback(), get: () => undefined,
                slots: { inject: (_name, callback) => callback(), register: (options, component) => { if (options.name === 'main') view = component; } },
            });
        } } },
        document, URL, URLSearchParams, AbortController, console, setTimeout, clearTimeout,
        setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); },
        async fetch(url, init) {
            requests.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
            if (failNextRead && init.method === 'GET') {
                failNextRead = false;
                return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: '状态读取失败' } }) };
            }
            if (delayNextRead && init.method === 'GET' && String(url).includes('/connection')) {
                delayNextRead = false;
                const snapshot = JSON.stringify(activeStatus);
                return new Promise((resolve, reject) => {
                    delayedReads.push(() => resolve({ ok: true, status: 200, text: async () => snapshot }));
                    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            }
            if (pendingRequest) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            if (failedWrite && init.method === 'POST') return { ok: false, status: 409, text: async () => JSON.stringify({ error: typeof failedWrite === 'string' ? { message: failedWrite } : failedWrite }) };
            if (testResult && String(url).includes('/connection/test')) return { ok: true, status: 200, text: async () => JSON.stringify(testResult) };
            const pathname = new URL(url).pathname;
            if (holdApply && pathname.endsWith('/connection/apply')) {
                return new Promise((resolve, reject) => {
                    delayedApplies.push(() => resolve({ ok: true, status: 200, text: async () => '{}' }));
                    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            }
            if (pathname.endsWith('/settings') && init.method === 'PUT') repoRoot = JSON.parse(init.body).repoRoot;
            const value = pathname.endsWith('/api/v1/auth/session') ? activeStatus.testSession ?? null
                : pathname.endsWith('/connection/progress') ? activeStatus.runtimeProgress ?? null
                : pathname.includes('/connection') ? activeStatus
                : pathname.endsWith('/health') ? { configured: Boolean(repoRoot), repoRoot, counts: {}, diagnostics: [] }
                : pathname.endsWith('/queue') ? { items: [], counts: {}, errors: [], repoRoot }
                : { settings: { owner: '', repoRoot }, validation: { ok: true, errors: [] }, runners: [] };
            return { ok: true, status: 200, text: async () => JSON.stringify(value) };
        },
    });
    vm.runInContext(bundle, context);
    function materialize(node, key = 'root') {
        if (Array.isArray(node)) return node.map((child, index) => materialize(child, `${key}.${index}`));
        if (!node || typeof node !== 'object') return node;
        if (typeof node.type === 'function') {
            let owner = components.get(key);
            if (!owner || owner.type !== node.type || owner.key !== node.props.key) {
                for (const hook of owner?.hooks ?? []) hook?.cleanup?.();
                owner = { type: node.type, key: node.props.key, hooks: [], index: 0 };
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
            tree = materialize(react.createElement(view, sessionId === undefined ? {} : { sessionId }));
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
            const node = nodes().find(node => node.type === 'button' && (node.props['aria-label'] ?? textOf(node)) === label);
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
        setLocalRepoRoot(next) { repoRoot = next; },
        failWrites(message) { failedWrite = message; },
        setTestResult(value) { testResult = value; },
        async poll() { for (const callback of [...timers.values()]) callback(); await flush(); },
        holdRequests() { pendingRequest = true; },
        releaseRequests() { pendingRequest = false; },
        delayNextRead() { delayNextRead = true; },
        failNextRead() { failNextRead = true; },
        releaseReads() { for (const resolve of delayedReads.splice(0)) resolve(); },
        holdApply() { holdApply = true; },
        releaseApply() { holdApply = false; for (const resolve of delayedApplies.splice(0)) resolve(); },
        unmount() {
            disposed = true;
            for (const owner of components.values()) for (const hook of owner.hooks) hook?.cleanup?.();
        },
    };
}

test('中央连接默认展示，编辑草稿和状态刷新均不会启动或覆盖输入', async () => {
    const panel = createPanel();
    await panel.flush();
    for (const label of ['中央连接', '项目接入', '中央工作台']) panel.button(label);
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    panel.button('修改连接').props.onClick();
    await panel.flush();
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
    assert.ok(panel.requests.every(request => !request.url.searchParams.has('sessionId')));
    panel.unmount();
});

test('显式应用和测试携带控制令牌，空 Token 保留已有凭据且停止单独提交', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
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
    panel.button('检查连接').props.onClick();
    await panel.flush();
    writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.equal(writes[1].url.pathname, '/dsh-code-review/connection/test');
    assert.deepEqual(writes[1].body, { centerUrl: 'https://central.example', nodeId: 'node-b', token: 'node-secret' });
    panel.button('保存并连接').props.onClick();
    await panel.flush();
    writes = panel.requests.filter(request => request.init.method === 'POST');
    assert.deepEqual(writes[2].body, { mode: 'external', centerUrl: 'https://central.example', nodeId: 'node-b', token: 'node-secret', reviewIdentity: '张三' });
    assert.equal(panel.input('节点 Token').props.value, '');
    panel.setStatus(initialStatus());
    await panel.poll();
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

test('连接检查逐项展示实际结果且修改草稿后清除过时结果', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, mode: 'external', phase: 'stopped', hasCredentials: false });
    panel.setTestResult({ authenticated: false, registrationCompatibility: 'unknown' });
    await panel.flush();
    assert.equal(panel.nodes().some(node => node.props['aria-label'] === '审核身份'), false);
    panel.button('检查连接').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /服务器可访问/);
    assert.match(panel.text(), /节点凭据未验证/);
    assert.match(panel.text(), /注册兼容性将在连接时验证/);
    panel.input('中央地址').props.onChange({ target: { value: 'https://another.example' } });
    await panel.flush();
    assert.doesNotMatch(panel.text(), /服务器可访问/);
    panel.setTestResult({ authenticated: true, registrationCompatibility: 'incompatible' });
    panel.button('检查连接').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /节点凭据有效/);
    assert.equal(panel.button('保存并连接').props.disabled, true);
    panel.input('中央地址').props.onChange({ target: { value: 'https://third.example' } });
    await panel.flush();
    assert.equal(panel.button('保存并连接').props.disabled, false);
    panel.unmount();
});

test('注册失败说明原因和处理动作并保留草稿，原始错误仅出现在折叠诊断中', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, mode: 'external', phase: 'stopped' });
    await panel.flush();
    const message = '中央服务器拒绝了工作副本信息';
    const issue = { stage: 'registration', code: 'workspace_rejected', detail: 'HTTP 422 · 无效协议字段：workspace' };
    panel.input('中央地址').props.onChange({ target: { value: 'https://draft.example' } });
    panel.input('节点 Token').props.onChange({ target: { value: 'draft-token' } });
    panel.failWrites({ message, ...issue });
    panel.setStatus({ ...initialStatus(), mode: 'external', phase: 'error', nodeOnline: false, issue, error: message, logs: [`${message}（${issue.detail}）`] });
    await panel.flush();
    panel.button('保存并连接').props.onClick();
    await panel.flush();
    assert.equal(panel.input('中央地址').props.value, 'https://draft.example');
    assert.equal(panel.input('节点 Token').props.value, 'draft-token');
    assert.match(panel.text(), /节点注册失败/);
    assert.match(panel.text(), /核对中央服务与插件的构建版本/);
    assert.equal(panel.nodes().filter(node => node.props.role === 'alert' && JSON.stringify(node).includes(message)).length, 1);
    const details = panel.nodes().find(node => node.type === 'details');
    assert.ok(details);
    assert.notEqual(details.props.open, true);
    assert.equal(panel.text().split('无效协议字段：workspace').length - 1, 1);
    panel.button('项目接入').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /核对中央服务与插件的构建版本/);
    assert.ok(panel.nodes().some(node => node.type === 'details' && node.props.open !== true));
    panel.unmount();
});

test('同名不同目录的项目分别接入和打开，停用按 workspaceId', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.button('项目接入').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /C:\/work\/a/);
    assert.match(panel.text(), /C:\/work\/b/);
    assert.doesNotMatch(panel.text(), /当前项目/);
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
    const link = panel.nodes().find(node => node.type === 'a' && node.props.href === '/dsh-code-review/central/projects/project-a');
    assert.ok(link);
    link.props.onClick({ preventDefault() {} });
    await panel.flush();
    assert.equal(panel.nodes().find(node => node.type === 'iframe')?.props.src, link.props.href);
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
    panel.button('修改连接').props.onClick();
    await panel.flush();
    panel.input('中央地址').props.onChange({ target: { value: 'https://draft.example' } });
    panel.input('节点 Token').props.onChange({ target: { value: 'draft-secret' } });
    await panel.flush();
    panel.button('重试已保存连接').props.onClick();
    await panel.flush();
    assert.deepEqual(panel.requests.find(request => request.init.method === 'POST').body, {
        mode: 'external', reviewIdentity: '张三', centerUrl: 'http://127.0.0.1:42100', nodeId: 'node-a', expectedCentralId: 'central-a',
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

test('切换会话不会取消中央连接操作或重置草稿，卸载才取消请求', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.button('修改连接').props.onClick();
    await panel.flush();
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    panel.input('节点 ID').props.onChange({ target: { value: 'draft-node-id' } });
    await panel.flush();
    panel.holdRequests();
    panel.button('切换并连接').props.onClick();
    await panel.flush();
    const previousRequest = panel.requests.at(-1);
    assert.equal(panel.button('正在连接…').props.disabled, true);
    panel.setSession('session-b');
    await panel.flush();
    assert.equal(previousRequest.init.signal.aborted, false);
    assert.equal(panel.button('正在连接…').props.disabled, true);
    assert.equal(panel.input('节点 ID').props.value, 'draft-node-id');
    assert.equal(panel.requests.at(-1), previousRequest);
    assert.equal(previousRequest.url.searchParams.has('sessionId'), false);
    panel.unmount();
    assert.equal(previousRequest.init.signal.aborted, true);
});

test('轻量插件禁用本机启动但仍允许选择已有中央', async () => {
    const panel = createPanel({ ...initialStatus(), localAvailable: false, configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    assert.equal(panel.button('应用并启动').props.disabled, true);
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    assert.equal(panel.button('保存并连接').props.disabled, false);
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 0);
    panel.unmount();
});

test('可下载版沿用两个启动入口，取消保留草稿，确认只提交当前运行包摘要', async () => {
    const source = { version: '0.1.0', url: 'https://download.example.test/central.tgz', size: 1048576, sha256: 'a'.repeat(64) };
    const downloadStatus = { ...initialStatus(), localAvailable: false, enabled: false, phase: 'stopped', localRuntimeDownload: source };
    const panel = createPanel({ ...downloadStatus, configured: false });
    await panel.flush();
    panel.input('审核身份').props.onChange({ target: { value: '自选审核者' } });
    await panel.flush();
    assert.equal(panel.button('应用并启动').props.disabled, false);
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    for (const piece of ['0.1.0', source.url, '1.00 MiB']) assert.ok(panel.text().includes(piece));
    panel.button('取消').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(panel.input('审核身份').props.value, '自选审核者');
    assert.match(panel.text(), /已取消，未开始下载/);
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    panel.holdApply();
    panel.button('下载并启动').props.onClick();
    await panel.flush();
    const posts = panel.requests.filter(request => request.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { mode: 'local', reviewIdentity: '自选审核者', confirmRuntimeDownload: source.sha256 });
    assert.match(panel.text(), /正在准备启动本机中央/);
    const downloading = { ...downloadStatus, configured: false, runtimeProgress: { stage: 'downloading', received: 524288, total: 1048576 } };
    panel.setStatus(downloading);
    await panel.poll();
    assert.match(panel.text(), /已下载 0.50 MiB \/ 1.00 MiB/);
    assert.equal(panel.nodes().find(node => node.type === 'progress').props.value, 524288);
    const reopened = createPanel(downloading);
    await reopened.flush();
    assert.match(reopened.text(), /已下载 0.50 MiB \/ 1.00 MiB/);
    assert.equal(reopened.button('应用并启动').props.disabled, true);
    reopened.unmount();
    panel.setStatus({ ...initialStatus(), reviewIdentity: '自选审核者' });
    panel.releaseApply();
    await panel.flush();
    assert.match(panel.text(), /中央已连接/);
    assert.equal(panel.nodes().some(node => node.type === 'progress'), false);
    panel.unmount();

    const saved = createPanel(downloadStatus);
    await saved.flush();
    saved.button('启动已保存连接').props.onClick();
    await saved.flush();
    assert.ok(saved.text().includes(source.url));
    saved.button('下载并启动').props.onClick();
    await saved.flush();
    assert.equal(saved.requests.find(request => request.init.method === 'POST').body.confirmRuntimeDownload, source.sha256);
    saved.setStatus({ ...initialStatus(), localRuntimeUpdate: { currentVersion: '0.1.0', latestVersion: '0.2.0' } });
    await saved.poll();
    assert.match(saved.text(), /中央运行包.*0\.1\.0.*0\.2\.0|中央运行包.*0\.2\.0.*0\.1\.0/);
    saved.unmount();
});

test('选择已保存连接不启动，切换请求绑定中央身份，返回本机时恢复已初始化身份', async () => {
    const connection = { centralId: 'central-remote', label: '团队中央', centerUrl: 'https://review.example/', nodeId: 'team-node' };
    const local = { ...initialStatus(), localReviewIdentity: '张三', savedConnections: [connection] };
    const panel = createPanel(local);
    await panel.flush();
    panel.button('选择连接 团队中央').props.onClick();
    await panel.flush();
    assert.equal(panel.input('中央地址').props.value, connection.centerUrl);
    assert.equal(panel.input('节点 Token').props.value, '');
    assert.equal(panel.requests.some(request => request.init.method === 'POST'), false);
    const external = { ...local, ...connection, mode: 'external', reviewIdentity: '', generation: 2,
        testSession: { user: { reviewIdentity: '团队审核员' } } };
    panel.setStatus(external);
    panel.button('切换并连接').props.onClick();
    await panel.flush();
    const post = () => panel.requests.filter(request => request.init.method === 'POST').at(-1);
    assert.equal(post().body.expectedCentralId, connection.centralId);
    assert.equal(post().body.token, undefined);
    assert.match(panel.text(), /审核身份团队审核员/);
    panel.button('前往工作台切换账号');
    panel.button('选择本机托管').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /本机审核身份张三/);
    assert.equal(panel.nodes().some(node => node.type === 'input' && node.props['aria-label'] === '审核身份'), false);
    panel.setStatus(local);
    panel.button('切换并连接').props.onClick();
    await panel.flush();
    assert.deepEqual(post().body, { mode: 'local', reviewIdentity: '张三' });
    assert.match(panel.text(), /审核身份张三/);
    assert.doesNotMatch(panel.text(), /团队审核员/);
    panel.unmount();
});

test('存在已保存中央配置时隐藏本地评审，不加载旧可写面板', async () => {
    const panel = createPanel({ ...initialStatus(), enabled: false, phase: 'stopped' });
    await panel.flush();
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
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
    assert.equal(panel.nodes().some(node => node.type === 'button' && ['应用并启动', '应用更改', '停止连接', '修改连接'].includes(node.children.join(''))), false);
    assert.equal(panel.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    assert.equal(panel.requests.some(request => request.url.pathname.startsWith('/dsh-code-review/api')), false);
    panel.unmount();
});

test('旧托管配置保留既有中央外链并隐藏本地评审', async () => {
    const panel = createPanel({ ...initialStatus(), legacy: true, configured: false, enabled: false, phase: 'stopped', centerUrl: 'https://legacy-central.example' });
    await panel.flush();
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    for (const label of ['中央工作台']) {
        panel.button(label).props.onClick();
        await panel.flush();
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

test('连接成功后显示运行摘要和下一步，原启动按钮不再出现', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.setStatus(initialStatus());
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /中央已连接/);
    assert.match(panel.text(), /张三/);
    assert.equal(panel.nodes().some(node => node.type === 'input'), false);
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '应用并启动'), false);
    panel.button('接入项目');
    panel.button('进入中央工作台');
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 1);
    panel.unmount();
});

test('已连接的未变配置不能再次应用，取消编辑不改变运行连接', async () => {
    const panel = createPanel();
    await panel.flush();
    panel.button('修改连接').props.onClick();
    await panel.flush();
    assert.equal(panel.button('应用更改').props.disabled, true);
    panel.button('应用更改').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 0);
    panel.button('连接已有中央').props.onClick();
    await panel.flush();
    panel.input('中央地址').props.onChange({ target: { value: 'https://draft.example' } });
    await panel.flush();
    assert.equal(panel.button('切换并连接').props.disabled, false);
    panel.button('取消修改').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /本机托管/);
    assert.equal(panel.nodes().some(node => node.type === 'input'), false);
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 0);
    panel.unmount();
});

test('启动中的同步重复点击只提交一次并明确显示启动中', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.holdRequests();
    const apply = panel.button('应用并启动');
    apply.props.onClick();
    apply.props.onClick();
    await panel.flush();
    assert.equal(panel.button('正在启动…').props.disabled, true);
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 1);
    panel.unmount();
});

test('服务就绪但节点离线显示降级提示，不发出自动重启或业务请求', async () => {
    const panel = createPanel({ ...initialStatus(), nodeOnline: false });
    await panel.flush();
    assert.match(panel.text(), /节点暂时离线/);
    panel.button('进入中央工作台');
    await panel.poll();
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 0);
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    panel.unmount();
});

test('应用等待新的写后状态，迟到轮询不能恢复启动表单或解除重复提交保护', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.delayNextRead();
    await panel.poll();
    const oldRead = panel.requests.at(-1);
    panel.setStatus(initialStatus());
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /中央已连接/);
    assert.equal(oldRead.init.signal.aborted, true);
    panel.releaseReads();
    await panel.flush();
    assert.match(panel.text(), /中央已连接/);
    assert.equal(panel.nodes().some(node => node.type === 'input'), false);
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 1);
    panel.unmount();
});

test('其他页面接入中央后当前本地面板自动退出，故障和停止都不重新开放', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.button('本地评审').props.onClick();
    await panel.flush();
    panel.setStatus(initialStatus());
    await panel.poll();
    const previousReads = panel.requests.filter(request => request.url.pathname.startsWith('/dsh-code-review/api')).length;
    for (const phase of ['ready', 'error', 'stopped']) {
        panel.setStatus({ ...initialStatus(), phase });
        await panel.poll();
        assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    }
    assert.equal(panel.requests.filter(request => request.url.pathname.startsWith('/dsh-code-review/api')).length, previousReads);
    panel.unmount();
});

test('写后状态读取失败时继续禁止应用，轮询恢复后才显示已连接', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.setStatus(initialStatus());
    panel.failNextRead();
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /状态读取失败/);
    assert.equal(panel.button('应用并启动').props.disabled, true);
    assert.equal(panel.nodes().some(node => node.type === 'button' && node.children.join('') === '本地评审'), false);
    panel.button('应用并启动').props.onClick();
    await panel.flush();
    assert.equal(panel.requests.filter(request => request.init.method === 'POST').length, 1);
    await panel.poll();
    assert.match(panel.text(), /中央已连接/);
    panel.unmount();
});

test('本地评审可在无会话时保存明确的仓库，切换会话后保持队列和仓库', async () => {
    const panel = createPanel({ ...initialStatus(), configured: false, enabled: false, phase: 'stopped' });
    await panel.flush();
    panel.button('本地评审').props.onClick();
    await panel.flush();
    const repoInput = panel.nodes().find(node => node.props.id === 'dcr-repo-root');
    assert.equal(repoInput.props.value, '');
    repoInput.props.onChange({ target: { value: ' C:/review/repo ' } });
    await panel.flush();
    panel.button('保存').props.onClick();
    await panel.flush();
    const saved = panel.requests.find(request => request.init.method === 'PUT');
    assert.equal(saved.body.repoRoot, 'C:/review/repo');
    assert.match(panel.text(), /C:\/review\/repo/);
    assert.ok(panel.requests.some(request => request.url.pathname.endsWith('/queue') && request.url.searchParams.get('expectedRepoRoot') === 'C:/review/repo'));
    const reads = panel.requests.length;
    panel.setSession('session-b');
    await panel.flush();
    assert.match(panel.text(), /C:\/review\/repo/);
    assert.equal(panel.requests.length, reads);
    assert.ok(panel.requests.every(request => !request.url.searchParams.has('sessionId')));
    panel.button('设置').props.onClick();
    await panel.flush();
    panel.nodes().find(node => node.props.id === 'dcr-repo-root').props.onChange({ target: { value: 'C:/review/other' } });
    await panel.flush();
    panel.button('保存').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /C:\/review\/other/);
    assert.doesNotMatch(panel.text(), /C:\/review\/repo/);
    panel.setLocalRepoRoot('C:/review/remote-change');
    await panel.poll();
    assert.equal(panel.requests.filter(request => request.url.pathname.endsWith('/queue')).at(-1).url.searchParams.get('expectedRepoRoot'), 'C:/review/other');
    panel.button('刷新').props.onClick();
    await panel.flush();
    assert.match(panel.text(), /C:\/review\/remote-change/);
    assert.equal(panel.requests.filter(request => request.url.pathname.endsWith('/queue')).at(-1).url.searchParams.get('expectedRepoRoot'), 'C:/review/remote-change');
    panel.unmount();
});

test('停止状态通过已保存配置启动，不需要重新填写或提交表单草稿', async () => {
    const panel = createPanel({ ...initialStatus(), enabled: false, phase: 'stopped' });
    await panel.flush();
    assert.equal(panel.nodes().some(node => node.type === 'input'), false);
    panel.setStatus(initialStatus());
    panel.button('启动已保存连接').props.onClick();
    await panel.flush();
    assert.deepEqual(panel.requests.find(request => request.init.method === 'POST').body, { mode: 'local', reviewIdentity: '张三' });
    assert.match(panel.text(), /中央已连接/);
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
