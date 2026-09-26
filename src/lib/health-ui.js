/**
 * Shared "Test connection" control: one button, one result line.
 * Both the popup and the settings page use it, so the button state, the
 * "testing…" label and the result text only exist once.
 *
 * The request is made by the page itself, which means it goes through the proxy
 * mode that is currently applied — that is the whole point of the test.
 */

import { describeProbe, probe } from './health.js';
import { t } from './i18n.js';
import { noteServerHealth, probeObservation } from './server-health.js';
import { updateServerHealth } from './storage.js';

/**
 * Remembers what the test proved — and about which server (`probeObservation`
 * decides, and says "nobody" in every mode but manual). Nothing happens when
 * the state is unknown or there is nothing to attribute; recording a verdict
 * must never be the reason a test fails.
 */
async function rememberVerdict(state, outcome) {
  const observation = probeObservation(state, outcome);
  if (!observation) return;
  try {
    await updateServerHealth((draft) => noteServerHealth(draft, observation));
  } catch (error) {
    console.warn('[proxy-switch] the connection verdict could not be recorded', error);
  }
}

/**
 * @param {object} options
 * @param {HTMLButtonElement|null} options.buttonEl
 * @param {HTMLElement|null} options.resultEl
 * @param {() => string} options.getLang
 * @param {(() => object|null)|null} [options.getState] the current state, so a
 *        verdict can be attributed to the server it was taken through
 */
export function createHealthUi({ buttonEl, resultEl, getLang, getState = null }) {
  let running = false;
  /** @type {object|null} last probe result */
  let outcome = null;

  function render(lang) {
    if (buttonEl) {
      buttonEl.disabled = running;
      buttonEl.textContent = t(running ? 'health.running' : 'health.action', lang);
      buttonEl.setAttribute('aria-busy', String(running));
    }

    if (!resultEl) return;

    if (running || !outcome) {
      resultEl.textContent = '';
      resultEl.classList.add('hidden');
      resultEl.classList.remove('is-ok', 'is-warn');
      resultEl.removeAttribute('title');
      return;
    }

    const view = describeProbe(outcome);
    resultEl.textContent = `${t(view.title.key, lang, view.title.params)} — ${t(
      view.detail.key,
      lang,
      view.detail.params,
    )}`;
    resultEl.classList.remove('hidden');
    resultEl.classList.toggle('is-ok', view.tone === 'ok');
    resultEl.classList.toggle('is-warn', view.tone !== 'ok');
    // The raw reason (a browser message such as "net::ERR_PROXY_CONNECTION_FAILED"
    // or "timeout") stays untranslated and lives in the tooltip.
    if (outcome.error) resultEl.title = String(outcome.error);
    else resultEl.removeAttribute('title');
  }

  /** Runs a probe and repaints. Safe to call twice: the second call is ignored. */
  async function run() {
    if (running) return outcome;
    running = true;
    outcome = null;
    render(getLang());

    try {
      outcome = await probe();
      // The button is also a look at the active server, which is what the chain
      // of a generated PAC script is ordered by.
      await rememberVerdict(getState?.() ?? null, outcome);
    } finally {
      running = false;
      render(getLang());
    }

    return outcome;
  }

  buttonEl?.addEventListener('click', () => {
    run();
  });

  return {
    render,
    run,
    get outcome() {
      return outcome;
    },
  };
}
