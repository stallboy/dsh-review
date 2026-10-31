import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(path.join(here, '..', 'dist', 'client.js'), 'utf8');
const PACKAGE_ID = 'dsh-code-review';

/**
 * A minimal page for the browser half: the real module system loads each bundle
 * as a classic <script> in the page's global scope (see
 * @deepseek-ai/dsh-client-modules `defaultLoadBundle`), so re-execution must be
 * safe and may not leak identifiers.
 */
function createPage() {
  const styles = [];
  const requests = [];
  const registrations = new Map();
  const document = {
    baseURI: 'http://127.0.0.1:13889/',
    documentElement: { lang: 'zh' },
    head: {
      appendChild(element) {
        styles.push(element);
      },
    },
    createElement(tagName) {
      return {
        tagName,
        textContent: '',
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        remove() {
          const index = styles.indexOf(this);
          if (index >= 0) styles.splice(index, 1);
        },
      };
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    __ModuleLoader__: {
      // The module system invalidates the old factory before an HMR swap; a
      // reload therefore replaces the row instead of colliding with it.
      load(registration) {
        registrations.set(registration.id, registration);
      },
    },
  };
  const fetch = (url, init) => {
    requests.push({ url: String(url), init });
    return Promise.reject(new Error('the bundle must not fetch while it is only registering'));
  };
  const context = vm.createContext({
    window,
    document,
    fetch,
    URL,
    URLSearchParams,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  return {
    styles,
    requests,
    registrations,
    document,
    execute() {
      vm.runInContext(bundleSource, context, { filename: 'dsh-code-review/client.js' });
    },
    evaluate(expression) {
      return vm.runInContext(expression, context);
    },
  };
}

function fakeReact() {
  const element = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement: element,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
  };
}

function materialize(page) {
  const registration = page.registrations.get(PACKAGE_ID);
  assert.ok(registration, 'the bundle must register its package factory');
  assert.equal(typeof registration.factory, 'function');
  return registration.factory((id) => {
    assert.equal(id, 'react', 'only react is available from the shared module table');
    return fakeReact();
  });
}

function createClientContext() {
  const slots = [];
  const locales = [];
  const effects = [];
  const own = (dispose) => {
    if (typeof dispose === 'function') effects.push(dispose);
    return dispose;
  };
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        const entry = { namespace, dictionaries };
        locales.push(entry);
        return own(() => {
          const index = locales.indexOf(entry);
          if (index >= 0) locales.splice(index, 1);
        });
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`;
      },
    },
    effect(callback) {
      return own(callback());
    },
    get() {
      return undefined;
    },
    slots: {
      inject(key, callback) {
        assert.equal(key, 'conversation.view');
        return own(callback());
      },
      register(options) {
        const entry = { options };
        slots.push(entry);
        return own(() => {
          const index = slots.indexOf(entry);
          if (index >= 0) slots.splice(index, 1);
        });
      },
    },
  };
  return { ctx, slots, locales, effects };
}

test('bundle execution only registers the factory: no DOM write and no request', () => {
  const page = createPage();
  page.execute();

  assert.equal(page.registrations.size, 1);
  assert.equal(page.registrations.get(PACKAGE_ID)?.id, PACKAGE_ID);
  assert.equal(typeof page.registrations.get(PACKAGE_ID)?.factory, 'function');
  assert.equal(page.styles.length, 0, 'styles belong to the factory/materialization, not to script execution');
  assert.equal(page.requests.length, 0, 'script execution must not talk to the Host');
});

test('bundle execution leaks no identifier into the page global scope', () => {
  const page = createPage();
  page.execute();

  for (const name of ['PACKAGE_ID', 'NS', 'API_ROOT', 'loader', 'api', 'createPlugin', 'activeSessionId']) {
    assert.equal(page.evaluate(`typeof ${name}`), 'undefined', `${name} must stay inside the bundle closure`);
  }
});

test('the same bundle can execute twice in one page (HMR swap)', () => {
  const page = createPage();
  page.execute();
  assert.doesNotThrow(() => page.execute(), 'HMR re-executes the bundle script in the same page');

  assert.equal(page.registrations.size, 1);
  assert.equal(page.registrations.get(PACKAGE_ID)?.id, PACKAGE_ID);
});

test('materialized plugin registers the review view, its styles and its dictionaries', () => {
  const page = createPage();
  page.execute();
  const plugin = materialize(page);

  assert.equal(plugin.inject.join(','), 'slots,locale');
  const client = createClientContext();
  plugin.apply(client.ctx);

  assert.equal(client.slots.length, 1);
  assert.equal(client.slots[0].options.name, 'conversation.view');
  assert.equal(client.slots[0].options.id, 'code-review');
  assert.equal(client.slots[0].options.order, 40);
  assert.equal(client.locales.length, 1);
  assert.equal(client.locales[0].namespace, PACKAGE_ID);
  assert.equal(page.styles.length, 1);
  assert.equal(page.styles[0].tagName, 'style');
});

test('plugin unload disposes the view, its styles and its dictionaries', () => {
  const page = createPage();
  page.execute();
  const plugin = materialize(page);
  const client = createClientContext();
  plugin.apply(client.ctx);

  for (const dispose of client.effects.reverse()) dispose();

  assert.equal(client.slots.length, 0, 'the view registration must be released');
  assert.equal(client.locales.length, 0, 'the locale dictionary must be released');
  assert.equal(page.styles.length, 0, 'the injected stylesheet must be removed');
});
