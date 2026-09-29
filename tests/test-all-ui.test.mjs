import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_ALL_MESSAGE,
  TEST_ALL_PROGRESS_MESSAGE,
} from '../src/lib/server-probe.js';
import {
  parseProgress,
  summarize,
  createTestAllUi,
} from '../src/lib/test-all-ui.js';
import { createDefaultState } from '../src/lib/model.js';

/**
 * The pass itself runs in the worker; what is tested here is what the page does with
 * the answers: the button state, the progress line, the final summary, and what it says
 * when the pass cannot run at all.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeElement(tag = 'button') {
  const classes = new Set();
  const listeners = new Map();
  let text = '';
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    disabled: false,
    children: [],
    attributes: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute: (name) => node.attributes[name] ?? null,
    removeAttribute(name) {
      delete node.attributes[name];
    },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    async fire(type) {
      for (const handler of listeners.get(type) ?? []) handler();
      await tick();
    },
  };
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (value) => {
      text = String(value ?? '');
    },
  });
  return node;
}

function setup(state = createDefaultState()) {
  const buttonEl = fakeElement();
  const resultEl = fakeElement('p');
  const ui = createTestAllUi({
    buttonEl,
    resultEl,
    getLang: () => 'en',
    getState: () => state,
  });
  ui.render();
  return { ui, buttonEl, resultEl, state };
}

test('a progress message is one step; anything else is not one', () => {
  assert.deepEqual(parseProgress({ done: 1, total: 3, ok: true }), {
    done: 1,
    total: 3,
    ok: true,
    skipped: false,
  });
  const skipped = parseProgress({ done: 2, total: 3, skipped: true });
  assert.equal(skipped.done, 2);
  assert.equal(skipped.total, 3);
  assert.equal(skipped.skipped, true);
  assert.equal('ok' in skipped, false, 'a skipped step says nothing about the probe');

  // A step must say *something* about the server.
  assert.equal(parseProgress({ done: 3, total: 3 }), null);
  // Counts have to be counts.
  assert.equal(parseProgress({ done: '2', total: 3, ok: true }), null);
  assert.equal(parseProgress({ total: 3, ok: true }), null);
  assert.equal(parseProgress({ done: 4, total: 3, ok: true }).done, 4, 'over-count is kept; the pass is the truth');
  assert.equal(parseProgress(null), null);
});

test('the summary counts the three outcomes, and only those', () => {
  assert.deepEqual(
    summarize([
      { ok: true },
      { ok: true },
      { ok: false },
      { skipped: true },
    ]),
    { ok: 2, failed: 1, skipped: 1 },
  );
  assert.deepEqual(summarize([{ skipped: true }, { skipped: true }]), { ok: 0, failed: 0, skipped: 2 });
  assert.deepEqual(summarize([]), { ok: 0, failed: 0, skipped: 0 });
});

test('a running pass disables the button and counts down the list', async () => {
  const state = createDefaultState();
  state.profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { ui, buttonEl, resultEl } = setup(state);

  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        assert.equal(message.type, TEST_ALL_MESSAGE);
        return pending;
      },
    },
  };

  const run = ui.run();
  await tick();
  assert.equal(buttonEl.disabled, true);
  assert.equal(buttonEl.textContent, 'Testing all…');
  assert.equal(resultEl.classList.contains('hidden'), true, 'no count until the worker answers');

  // The worker answered: the line says where the pass is.
  answer({ started: true, total: 3 });
  await run;
  ui.handleProgress({ type: TEST_ALL_PROGRESS_MESSAGE, done: 1, total: 3, ok: true });
  assert.match(resultEl.textContent, /1 of 3 tested/);
  assert.equal(ui.running, true, 'the pass is still going');

  ui.handleProgress({ type: TEST_ALL_PROGRESS_MESSAGE, done: 3, total: 3, ok: false });
  assert.equal(ui.running, false, 'the last step ends the pass here');
  assert.equal(buttonEl.disabled, false);
  assert.equal(buttonEl.textContent, 'Test all');
  assert.equal(resultEl.textContent, '1 worked · 1 no answer · 0 skipped');
  assert.equal(resultEl.classList.contains('is-warn'), false, 'something worked, so the tone is ok');
  assert.equal(resultEl.classList.contains('is-ok'), true);
  // A message from a pass this page did not start is ignored, not appended.
  assert.equal(ui.handleProgress({ done: 2, total: 3, ok: true }), false);
  assert.equal(resultEl.textContent, '1 worked · 1 no answer · 0 skipped');
});

test('the summary tone is warn when nothing worked, and counts skipped as neither', async () => {
  const state = createDefaultState();
  state.profiles = [{ id: 'a' }, { id: 'b' }];
  const { ui, resultEl } = setup(state);

  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => pending,
    },
  };

  const run = ui.run();
  await tick();
  answer({ started: true, total: 2 });
  await run;

  ui.handleProgress({ done: 1, total: 2, skipped: true });
  ui.handleProgress({ done: 2, total: 2, ok: false });
  assert.equal(resultEl.textContent, '0 worked · 1 no answer · 1 skipped');
  assert.equal(resultEl.classList.contains('is-warn'), true);
});

test('a second press while one runs does nothing', async () => {
  const state = createDefaultState();
  state.profiles = [{ id: 'a' }];
  const { ui, buttonEl } = setup(state);

  let calls = 0;
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        calls += 1;
        // never answers
        return new Promise(() => {});
      },
    },
  };

  ui.run();
  await tick();
  await ui.run();
  assert.equal(calls, 1, 'the second call was ignored');
  assert.equal(buttonEl.disabled, true);
});

test('a refusal is said, not left as a dead button', async () => {
  const state = createDefaultState();
  state.profiles = [{ id: 'a' }, { id: 'b' }];
  const { ui, buttonEl, resultEl } = setup(state);

  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ started: false, running: true, done: 1, total: 2 }),
    },
  };

  await ui.run();
  assert.equal(buttonEl.disabled, false, 'nothing is running in this page');
  assert.equal(resultEl.textContent, 'A test is already running.');
  assert.equal(resultEl.classList.contains('is-warn'), true);
  assert.deepEqual(ui.steps, []);

  const { ui: ui2, resultEl: resultEl2 } = setup(state);
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ started: false }),
    },
  };
  await ui2.run();
  assert.match(resultEl2.textContent, /cannot be tested/);

  const { ui: ui3, resultEl: resultEl3 } = setup(state);
  globalThis.chrome = {
    runtime: {
      // no sendMessage at all (offline preview without a worker)
      runtime: undefined,
    },
  };
  await ui3.run();
  assert.match(resultEl3.textContent, /cannot be tested/);
});

test('an empty list is answered here, without waking the worker', async () => {
  const { ui, resultEl } = setup(createDefaultState());
  let calls = 0;
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        calls += 1;
        return { started: true, total: 0 };
      },
    },
  };

  await ui.run();
  assert.equal(calls, 0);
  assert.equal(resultEl.textContent, 'There is no server to test.');
});
