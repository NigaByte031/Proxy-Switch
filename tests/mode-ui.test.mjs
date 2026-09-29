import test from 'node:test';
import assert from 'node:assert/strict';

import { createModeUi } from '../src/lib/mode-ui.js';
import { createDefaultState, sanitizeState } from '../src/lib/model.js';

/**
 * The mode chips, the PAC URL and the domain list are one control shared by the popup
 * and the settings page, so what it commits matters twice. There is no DOM in Node, so
 * this builds the smallest one that can answer what the control asks: is the element
 * checked, what does its value say, was it hidden, what did a click commit.
 */

// `mode-ui.js` reads `document.activeElement` to leave the field the user is typing
// in alone; a stub is enough here.
globalThis.document = { activeElement: null };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeElement({ dataset = {}, value = '', checked = false, children = [] } = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset,
    value,
    checked,
    textContent: '',
    attributes: {},
    children,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value2) {
      this.attributes[name] = value2;
    },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    /** Fires every handler, then lets whatever they committed settle. */
    async fire(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
      await tick();
    },
    querySelectorAll: () => children,
  };
}

const MODES = ['system', 'direct', 'fixed_servers', 'pac_script'];

function setup(state) {
  const chips = MODES.map((mode) => fakeElement({ dataset: { mode } }));
  const els = {
    chipsEl: fakeElement({ children: chips }),
    hintEl: fakeElement(),
    pacPanelEl: fakeElement(),
    pacUrlRowEl: fakeElement(),
    pacUrlEl: fakeElement({ value: state.settings.pacUrl }),
    pacDomainsToggleEl: fakeElement({ checked: state.settings.domainRouting }),
    pacDomainsPanelEl: fakeElement(),
    pacDomainsEl: fakeElement(),
    pacDomainsSaveEl: fakeElement(),
    pacSaveEl: fakeElement(),
  };

  const commits = [];
  const errors = [];
  const commit = (mutator) => {
    const draft = structuredClone(state);
    mutator(draft);
    Object.assign(state, sanitizeState(draft));
    commits.push(structuredClone(state.settings));
    return Promise.resolve(state);
  };

  const ui = createModeUi({ ...els, commit, getLang: () => 'en', onError: (text) => errors.push(text) });
  return { ui, els, chips, commits, errors, state };
}

test('the PAC source on screen is the one in charge', () => {
  const plain = setup(sanitizeState({ settings: { mode: 'pac_script', pacUrl: 'https://x/p.pac' } }));
  plain.ui.render(plain.state, 'en');

  assert.equal(plain.els.pacPanelEl.classList.contains('hidden'), false, 'PAC mode shows the panel');
  assert.equal(plain.els.pacUrlRowEl.classList.contains('hidden'), false, 'the URL is the source');
  assert.equal(plain.els.pacDomainsPanelEl.classList.contains('hidden'), true, 'the list is not');
  assert.equal(plain.els.pacDomainsToggleEl.checked, false);
  assert.equal(plain.els.pacUrlEl.value, 'https://x/p.pac');

  const routing = setup(
    sanitizeState({
      settings: {
        mode: 'pac_script',
        domainRouting: true,
        pacUrl: 'https://x/ignored.pac',
        proxyDomains: ['example.com', 'a.test'],
      },
    }),
  );
  routing.ui.render(routing.state, 'en');

  assert.equal(routing.els.pacUrlRowEl.classList.contains('hidden'), true, 'the URL steps aside');
  assert.equal(routing.els.pacDomainsPanelEl.classList.contains('hidden'), false);
  assert.equal(routing.els.pacDomainsToggleEl.checked, true);
  assert.equal(routing.els.pacDomainsEl.value, 'example.com\na.test', 'the stored rules are shown');

  // and a mode that is neither hides the whole panel
  const manual = setup(sanitizeState({ settings: { mode: 'fixed_servers' } }));
  manual.ui.render(manual.state, 'en');
  assert.equal(manual.els.pacPanelEl.classList.contains('hidden'), true);

  // the chips themselves say which mode is pressed
  const status = routing.els.chipsEl.children.find((chip) => chip.dataset.mode === 'pac_script');
  assert.equal(status.classList.contains('is-active'), true);
  assert.equal(status.attributes['aria-pressed'], 'true');
  assert.equal(
    routing.els.chipsEl.children.find((chip) => chip.dataset.mode === 'system').attributes['aria-pressed'],
    'false',
  );
});

test('the chips write the mode, and turn the switch back on doing it', async () => {
  const { els, commits, state } = setup(sanitizeState({ settings: { enabled: false } }));

  // the control listens on the container, so a click on a chip bubbles to it
  await els.chipsEl.fire('click', { target: { closest: () => ({ dataset: { mode: 'pac_script' } }) } });

  assert.equal(commits.length, 1);
  assert.equal(commits[0].mode, 'pac_script');
  assert.equal(commits[0].enabled, true);
  assert.equal(state.settings.mode, 'pac_script', 'the state really moved, not just the draft');
});

test('the toggle and the save button commit the list, cleaned up', async () => {
  const { els, commits, errors, state } = setup(createDefaultState());

  els.pacDomainsToggleEl.checked = true;
  await els.pacDomainsToggleEl.fire('change');
  assert.equal(commits.at(-1).domainRouting, true);

  els.pacDomainsEl.value = 'example.com\n# a comment\nhost:8080\n*.internal.example.com';
  await els.pacDomainsSaveEl.fire('click');
  assert.deepEqual(commits.at(-1).proxyDomains, ['example.com', '*.internal.example.com']);
  assert.deepEqual(state.settings.proxyDomains, ['example.com', '*.internal.example.com']);
  assert.deepEqual(errors.filter(Boolean), [], 'a dropped rule is not an error worth shouting about');

  els.pacDomainsToggleEl.checked = false;
  await els.pacDomainsToggleEl.fire('change');
  assert.equal(state.settings.domainRouting, false);
  assert.deepEqual(state.settings.proxyDomains, ['example.com', '*.internal.example.com'], 'the list is kept');
});

test('the PAC URL is validated before it is stored', async () => {
  const { els, commits, errors, state } = setup(createDefaultState());

  els.pacUrlEl.value = 'not a url';
  await els.pacSaveEl.fire('click');
  assert.equal(commits.length, 0, 'nothing was written');
  assert.deepEqual(errors, ['The PAC URL must start with http:// or https://.'], 'and it says why');
  assert.equal(state.settings.pacUrl, '', 'the rubbish never reached the state');

  els.pacUrlEl.value = 'https://example.com/proxy.pac';
  await els.pacSaveEl.fire('click');
  assert.equal(state.settings.pacUrl, 'https://example.com/proxy.pac');
  assert.equal(errors.at(-1), null, 'the error is cleared');
});
