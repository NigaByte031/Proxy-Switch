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

/**
 * @param {object} options
 * @param {HTMLButtonElement|null} options.buttonEl
 * @param {HTMLElement|null} options.resultEl
 * @param {() => string} options.getLang
 */
export function createHealthUi({ buttonEl, resultEl, getLang }) {
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
