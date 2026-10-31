import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAuditSession } from '../dist/index.js';

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
  const services = {
    sessionController: Object.hasOwn(options, 'controller') ? options.controller : controller,
    workspaceRegistry: options.registry,
    ...options.services,
  };
  const warnings = [];
  const host = {
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
  const workspace = { id: 'workspace-2', path: CWD.replaceAll('/', '\\') };
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

test('audit session inherits the owner permission preset before the prompt starts', async () => {
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
        setPolicy() {
          throw new Error('the preset already carries the approval policy');
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

  assert.deepEqual(inherited, ['current', 'set:danger-full-access']);
  assert.deepEqual(order, ['prompt']);
  assert.equal(calls.prompt.length, 1);
});

test('audit session falls back to the owner approval policy for a custom preset', async () => {
  const ownerSession = { header: {} };
  const auditSession = { header: {} };
  const { host, order } = createHost({
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

  await createDshAuditSession(host, {
    cwd: CWD,
    title: '仓库审查',
    prompt: '任务',
    ownerSessionId: 'owner-session',
  });

  assert.deepEqual(order, ['current', 'policy:session-audit:never', 'prompt']);
});

test('audit session still starts when permission inheritance is unavailable', async () => {
  const { host, calls } = createHost({ registry: registryWith(undefined), services: { sessions: {} } });

  const result = await createDshAuditSession(host, {
    cwd: CWD,
    title: '仓库审查',
    prompt: '任务',
    ownerSessionId: 'owner-session',
  });

  assert.equal(result.sessionId, 'session-audit');
  assert.equal(calls.prompt.length, 1);
});
