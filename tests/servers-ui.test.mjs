import test from 'node:test';
import assert from 'node:assert/strict';

import { createServersUi } from '../src/lib/servers-ui.js';
import { SERVER_HEALTH_TTL_MS } from '../src/lib/server-health.js';

/**
 * The list rows are shared by the popup and the settings page, and what they
 * now say about a server — its last verdict and how old it is — is the visible
 * half of the health record the worker orders the chain by. There is no DOM in
 * Node, so this file builds the smallest one that can answer the questions the
 * list asks: what a row's text is, what tone it wears, and what a click commits.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function matches(node, selector) {
  if (!selector.startsWith('.')) return false; // only class selectors are used
  const name = selector.slice(1);
  const classes = String(node.className ?? '').split(/\s+/);
  return classes.includes(name) || node.classList.contains(name);
}

function descendants(node) {
  const found = [];
  for (const child of node.children ?? []) {
    found.push(child, ...descendants(child));
  }
  return found;
}

function fakeElement(tag = 'div') {
  const classes = new Set();
  const listeners = new Map();
  let text = '';

  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    attributes: {},
    children: [],
    parents: [],
    title: '',
    value: '',
    checked: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    append(...nodes) {
      for (const child of nodes) {
        child.parents?.push(node);
        node.children.push(child);
      }
    },
    setAttribute(name, value2) {
      node.attributes[name] = value2;
    },
    getAttribute: (name) => node.attributes[name] ?? null,
    focus() {},
    select() {},
    reset() {},
    remove() {
      for (const parent of node.parents) {
        const index = parent.children.indexOf(node);
        if (index !== -1) parent.children.splice(index, 1);
      }
    },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    /** Fires every handler, then lets whatever they committed settle. */
    async fire(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
      await tick();
    },
    querySelector: (selector) => descendants(node).find((child) => matches(child, selector)) ?? null,
    querySelectorAll: (selector) => descendants(node).filter((child) => matches(child, selector)),
  };

  Object.defineProperty(node, 'textContent', {
    get: () => text,
    // Like the real thing: writing text replaces whatever was inside.
    set: (value) => {
      text = String(value ?? '');
      node.children.length = 0;
    },
  });

  return node;
}

globalThis.document = {
  activeElement: null,
  createElement: (tag) => fakeElement(tag),
  addEventListener() {},
};

const SERVER = (id, name = id) => ({
  id,
  name,
  scheme: 'http',
  host: `${id}.example.com`,
  port: 8080,
  username: '',
  password: '',
});

function setup({ profiles, health }) {
  const state = {
    settings: {
      enabled: true,
      mode: 'fixed_servers',
      activeProfileId: profiles[0]?.id ?? null,
      bypassList: [],
    },
    profiles,
  };

  const listEl = fakeElement();
  const commits = [];
  const ui = createServersUi({
    listEl,
    emptyEl: fakeElement(),
    noMatchEl: fakeElement(),
    searchEl: fakeElement(),
    searchInput: fakeElement(),
    searchClear: fakeElement(),
    formEl: fakeElement(),
    addBtn: fakeElement(),
    getState: () => state,
    getLang: () => 'en',
    commit: async (mutator) => commits.push(mutator),
    getHealth: () => health,
  });

  ui.render(state, 'en');
  return { ui, listEl, commits };
}

const rowFor = (listEl, id) =>
  listEl.querySelectorAll('.profile-item').find((item) => item.dataset.id === id);
const badgeOf = (listEl, id) => rowFor(listEl, id).querySelector('.profile-health');

test('a row says which server answered, and how long ago', () => {
  const now = Date.now();
  const servers = [SERVER('a', 'Active'), SERVER('b', 'Backup'), SERVER('c', 'Never looked at')];
  const health = {
    a: { ok: true, at: now - 3 * 60_000, ms: 42 },
    b: { ok: false, at: now - 2 * 60_000, ms: null },
  };

  const { listEl } = setup({ profiles: servers, health });

  const answered = badgeOf(listEl, 'a');
  assert.equal(answered.textContent, 'answered in 42 ms · 3 min ago');
  assert.equal(answered.dataset.tone, 'ok');
  assert.equal(answered.title, answered.textContent, 'the same words are there on hover');

  const silent = badgeOf(listEl, 'b');
  assert.equal(silent.textContent, 'no answer · 2 min ago');
  assert.equal(silent.dataset.tone, 'warn');

  // A server nobody has looked at says nothing: "unknown" is not a state the
  // extension has an opinion about.
  assert.equal(badgeOf(listEl, 'c'), null);
});

test('with nothing known at all, the list is the list it always was', () => {
  const servers = [SERVER('a'), SERVER('b')];
  const { listEl } = setup({ profiles: servers, health: null });

  for (const id of ['a', 'b']) {
    assert.equal(badgeOf(listEl, id), null, id);
    // …and the row is still a working button: the health line is added to the
    // row, it does not replace anything (activate, edit, delete).
    const row = rowFor(listEl, id);
    assert.deepEqual(
      row.children.map((child) => child.tagName),
      ['BUTTON', 'BUTTON', 'BUTTON'],
      id,
    );
  }
});

test('a verdict too old to order the chain is dimmed, not rewritten', () => {
  const now = Date.now();
  const servers = [SERVER('a')];
  const health = { a: { ok: true, at: now, ms: 42 } };

  const { listEl, ui } = setup({ profiles: servers, health });
  assert.equal(badgeOf(listEl, 'a').dataset.tone, 'ok');
  assert.equal(badgeOf(listEl, 'a').textContent, 'answered in 42 ms · just now');

  // The list re-reads the ages on its own timer; here that pass is simply asked
  // for. The verdict is now older than the lifetime the chain uses, so it loses
  // its colour — the words stay, the opinion of them does not.
  health.a.at = now - SERVER_HEALTH_TTL_MS - 60_000;
  ui.refreshHealth();
  assert.equal(badgeOf(listEl, 'a').dataset.tone, 'stale');
  assert.equal(badgeOf(listEl, 'a').textContent, 'answered in 42 ms · 21 min ago');

  // …and a verdict that is gone entirely takes the line with it.
  delete health.a;
  ui.refreshHealth();
  assert.equal(badgeOf(listEl, 'a'), null);
});

test('clicking a row still activates that server', async () => {
  const servers = [SERVER('a', 'Active'), SERVER('b', 'Backup')];
  const { listEl, commits } = setup({
    profiles: servers,
    health: { b: { ok: true, at: Date.now(), ms: 10 } },
  });

  await rowFor(listEl, 'b').querySelector('.profile-main').fire('click');

  assert.equal(commits.length, 1);
  const draft = { settings: { activeProfileId: 'a', mode: 'direct', enabled: false }, profiles: servers };
  commits[0](draft);
  assert.equal(draft.settings.activeProfileId, 'b');
  assert.equal(draft.settings.mode, 'fixed_servers');
  assert.equal(draft.settings.enabled, true);
});
