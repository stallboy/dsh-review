import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAuditSession, createDshFixSession } from '../packages/dsh-plugin/dist/index.js';

const CWD = process.cwd();

function createHost(options = {}) {
  const calls = { create: [], rename: [], prompt: [] };
  const order = [];
  const controller = {
    async create(request) {
      calls.create.push(request);
      if (options.createError) throw options.createError;
      return { sessionId: options.sessionId ?? 'session-audit' };
    },
    async rename(request) {
      calls.rename.push(request);
      if (options.renameError) throw options.renameError;
    },
    async prompt(request, signal) {
      order.push('prompt');
      calls.prompt.push({ request, signal });
      if (options.promptError) throw options.promptError;
      return options.promptResult ?? { accepted: true };
    },
  };
  const sessionId = options.sessionId ?? 'session-audit';
  const audit = { id: sessionId, header: { cwd: CWD } };
  const toolService = { guard: () => () => {} };
  const services = {
    sessions: { get: id => id === sessionId ? audit : undefined },
    agents: { get: id => id === sessionId ? { id, session: audit, ctx: { get: () => toolService } } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: CWD }) },
    fs: { sandboxMode: 'workspace-write' }, shell: { sandboxMode: 'workspace-write' },
    tools: toolService, approval: { setPolicy() {} },
    sessionController: Object.hasOwn(options, 'controller') ? options.controller : controller,
    workspaceRegistry: options.registry,
    ...options.services,
  };
  const createdSession = services.sessions?.get?.(sessionId);
  if (createdSession) {
    createdSession.id = sessionId;
    createdSession.header = { ...createdSession.header, cwd: CWD };
  }
  if (services.agents?.get) {
    const originalGet = services.agents.get.bind(services.agents);
    services.agents = { get(id) {
      const agent = originalGet(id);
      if (agent && id === sessionId) {
        agent.session ??= createdSession;
        agent.ctx ??= { get: () => toolService };
      }
      return agent;
    } };
  }
  const warnings = [];
  const host = {
    on() { return () => {}; },
    get(name) {
      return services[name];
    },
    logger: {
      info() {},
      error() {},
      warn(message) {
        warnings.push(message);
      },
    },
  };
  return { host, calls, warnings, order };
}

const registryWith = (workspace) => ({
  async resolveByPath() {
    return workspace;
  },
  list() {
    return workspace ? [workspace] : [];
  },
});

test('audit session attaches to the workspace and queues the prompt', async () => {
  const workspace = { id: 'workspace-1', path: CWD };
  const { host, calls } = createHost({ registry: registryWith(workspace) });

  const result = await createDshAuditSession(host, { cwd: CWD, title: '仓库审查 · src', prompt: '审查提示词' });

  assert.deepEqual(result, { sessionId: 'session-audit' });
  assert.deepEqual(calls.create, [{ workspaceId: 'workspace-1' }]);
  assert.deepEqual(calls.rename, [{ sessionId: 'session-audit', title: '仓库审查 · src' }]);
  assert.equal(calls.prompt.length, 1);
  const { request, signal } = calls.prompt[0];
  assert.equal(request.sessionId, 'session-audit');
  assert.equal(request.mode, 'queue');
  assert.match(request.requestId, /^dsh-code-review-[0-9a-f-]{36}$/);
  assert.deepEqual(request.content, [{ type: 'text', text: '审查提示词' }]);
  assert.ok(signal instanceof AbortSignal);
});

test('audit session falls back to cwd when no workspace owns the directory', async () => {
  const { host, calls } = createHost({ registry: registryWith(undefined) });

  await createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' });

  assert.deepEqual(calls.create, [{ cwd: CWD }]);
});

test('audit session matches a workspace by path when resolveByPath is unavailable', async () => {
  const workspacePath = process.platform === 'win32' ? CWD.replaceAll('\\', '/') : `${CWD}/.`;
  const workspace = { id: 'workspace-2', path: workspacePath };
  const registry = { list: () => [workspace] };
  const { host, calls } = createHost({ registry });

  await createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' });

  assert.deepEqual(calls.create, [{ workspaceId: 'workspace-2' }]);
});

test('audit session reports a missing sessionController instead of creating nothing', async () => {
  const { host, calls } = createHost({ controller: null, registry: registryWith(undefined) });

  await assert.rejects(
    () => createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' }),
    /未挂载 sessionController/,
  );
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
});

test('audit session surfaces the DSH failure code when creation is rejected', async () => {
  const failure = Object.assign(new Error('workspace not found'), { code: 'workspace/not-found' });
  const { host } = createHost({ createError: failure, registry: registryWith(undefined) });

  await assert.rejects(
    () => createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' }),
    /创建 DSH 审查会话失败：workspace not found（workspace\/not-found）/,
  );
});

test('audit session fails when DSH does not accept the prompt', async () => {
  const { host } = createHost({ promptResult: { accepted: false }, registry: registryWith(undefined) });

  await assert.rejects(
    () => createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' }),
    /发送审查任务失败：DSH 未接受审查提示词/,
  );
});

test('audit session keeps the created session when renaming fails', async () => {
  const { host, calls, warnings } = createHost({
    renameError: new Error('title service down'),
    registry: registryWith(undefined),
  });

  const result = await createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' });

  assert.equal(result.sessionId, 'session-audit');
  assert.equal(calls.prompt.length, 1);
  assert.match(warnings.join('\n'), /审查会话改名失败：title service down/);
});

test('审查不继承所有者完整权限预设，按 SPEC 软引导 + Host 强还原直接投递', async () => {
  const ownerSession = { header: {} };
  const auditSession = { header: {} };
  const inherited = [];
  const { host, calls, order } = createHost({
    registry: registryWith(undefined),
    services: {
      sessions: {
        get(id) {
          if (id === 'owner-session') return ownerSession;
          if (id === 'session-audit') return auditSession;
          return undefined;
        },
      },
      permissionPresets: {
        current(session) {
          inherited.push('current');
          return session === ownerSession ? 'danger-full-access' : 'workspace-write';
        },
        set(session, name) {
          inherited.push(`set:${name}`);
        },
      },
      approval: {
        overrideOf() {
          return 'never';
        },
        setPolicy(_agent, policy) {
          inherited.push(`audit:${policy}`);
        },
      },
      agents: { get: () => ({ id: 'session-audit' }) },
    },
  });

  await createDshAuditSession(host, {
    cwd: CWD,
    title: '仓库审查',
    prompt: '任务',
    ownerSessionId: 'owner-session',
  });

  assert.deepEqual(inherited, []);
  assert.deepEqual(order, ['prompt']);
  assert.equal(calls.prompt.length, 1);
});

test('修复会话在所有者使用自定义权限时仍继承审批覆盖策略', async () => {
  const ownerSession = { header: {} };
  const fixSession = { header: {} };
  const { host, order } = createHost({
    registry: registryWith(undefined),
    services: {
      sessions: {
        get(id) {
          if (id === 'owner-session') return ownerSession;
          if (id === 'session-audit') return fixSession;
          return undefined;
        },
      },
      permissionPresets: {
        current() {
          order.push('current');
          return 'custom';
        },
        set() {
          order.push('preset-set');
        },
      },
      approval: {
        overrideOf() {
          return 'never';
        },
        setPolicy(agent, policy) {
          order.push(`policy:${agent.id}:${policy}`);
        },
      },
      agents: { get: () => ({ id: 'session-audit' }) },
    },
  });

  await createDshFixSession(host, {
    cwd: CWD,
    title: '提案修订',
    prompt: '任务',
    ownerSessionId: 'owner-session',
  });

  assert.deepEqual(order, ['current', 'policy:session-audit:never', 'prompt']);
});

test('审查工作区路径与 cwd 不一致时不绑定错位工作区，回退按 cwd 创建', async () => {
  const parentWorkspace = { id: 'workspace-parent', path: '..' };
  const { host, calls } = createHost({ registry: registryWith(parentWorkspace) });
  await createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务' });
  assert.deepEqual(calls.create, [{ cwd: CWD }]);
  assert.equal(calls.prompt.length, 1);
});

test('桌面审查选择精确匹配的工作区，避免在上层项目创建会话', async () => {
    const owner = { id: 'workspace-owner', path: '..' };
    const exact = { id: 'workspace-exact', path: CWD };
    const { host, calls } = createHost({
        registry: { resolveByPath: async () => owner, list: () => [owner, exact] },
    });
    await createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务', requireWorkspace: true });
    assert.deepEqual(calls.create, [{ workspaceId: 'workspace-exact' }]);
});

test('桌面审查缺少绑定工作区时报错并保持会话列表不变', async () => {
    const { host, calls } = createHost({ registry: registryWith(undefined) });
    await assert.rejects(
        createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务', requireWorkspace: true }),
        /找不到审查工作副本所属的项目/,
    );
    assert.equal(calls.create.length, 0);
});

test('桌面审查不能使用子目录项目改变本轮 cwd，须先登记工作副本根目录', async () => {
    const workspace = { id: 'workspace-nested', path: `${CWD}/packages/dsh-plugin` };
    const { host, calls } = createHost({ registry: registryWith(workspace) });
    await assert.rejects(createDshAuditSession(host, { cwd: CWD, title: '仓库审查', prompt: '任务', requireWorkspace: true }), /请登记工作副本根目录/);
    assert.deepEqual(calls.create, []);
    assert.deepEqual(calls.prompt, []);
});
