/**
 * Shared "Test all servers" control: one button, one result line under the list.
 *
 * The pass belongs to the worker (only it may touch `chrome.proxy`). This module
 * asks for it and narrates: the worker answers "started, N servers", then announces
 * each verdict as a message, so the line fills in server by server.
 *
 * Everything the worker cannot answer is said out loud, never left as a button that
 * does nothing.
 */

import { TEST_ALL_MESSAGE, TEST_ALL_PROGRESS_MESSAGE } from './server-probe.js';
import { t } from './i18n.js';

/** Coerces a progress message into a step, or null when it is not one. */
export function parseProgress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // The worker sends numbers; a string that looks like one is a different sender.
  if (!Number.isInteger(raw.done) || !Number.isInteger(raw.total) || raw.total < 1 || raw.done < 0) {
    return null;
  }
  if (raw.skipped === true) return { done: raw.done, total: raw.total, skipped: true };
  if (typeof raw.ok !== 'boolean') return null;
  return { done: raw.done, total: raw.total, ok: raw.ok, skipped: false };
}

/** A pass's final counts, from the per-server steps. */
export function summarize(steps) {
  const ok = steps.filter((step) => step.ok).length;
  const skipped = steps.filter((step) => step.skipped).length;
  return { ok, failed: steps.length - ok - skipped, skipped };
}

/**
 * @param {object} options
 * @param {HTMLButtonElement|null} options.buttonEl
 * @param {HTMLElement|null} options.resultEl
 * @param {() => string} options.getLang
 * @param {() => object|null} [options.getState] the current state, so an empty
 *        list can be answered without waking the worker
 */
export function createTestAllUi({ buttonEl, resultEl, getLang, getState = null }) {
  let running = false;
  /** Steps answered so far, in the order the pass announced them. */
  let steps = [];
  /** How many servers the pass said it would look at. */
  let total = 0;
  /** Why a pass could not start ('busy' | 'notEligible' | 'empty'), or null. */
  let note = null;

  function render(lang = getLang()) {
    if (buttonEl) {
      buttonEl.disabled = running;
      buttonEl.textContent = t(running ? 'health.testAll.running' : 'health.testAll.action', lang);
      buttonEl.setAttribute('aria-busy', String(running));
    }

    if (!resultEl) return;

    if (note) {
      resultEl.textContent = t(`health.testAll.${note}`, lang);
      resultEl.classList.remove('hidden');
      resultEl.classList.add('is-warn');
      resultEl.classList.remove('is-ok');
      return;
    }

    if (running) {
      if (total > 0) {
        resultEl.textContent = t('health.testAll.progress', lang, {
          done: steps.length,
          total,
        });
      } else {
        // The worker has not answered yet; the button already says a test runs.
        resultEl.textContent = '';
        resultEl.classList.add('hidden');
        return;
      }
      resultEl.classList.remove('hidden', 'is-ok', 'is-warn');
      return;
    }

    if (steps.length === 0) {
      resultEl.textContent = '';
      resultEl.classList.add('hidden');
      resultEl.classList.remove('is-ok', 'is-warn');
      return;
    }

    // "3 worked · 1 no answer · 1 skipped"; the rows say which server worked.
    const counts = summarize(steps);
    resultEl.textContent = t('health.testAll.summary', lang, counts);
    resultEl.classList.remove('hidden');
    resultEl.classList.toggle('is-ok', counts.ok > 0);
    resultEl.classList.toggle('is-warn', counts.ok === 0);
  }

  /** Ends the pass in this page and says why it never ran. */
  function refuse(reason) {
    running = false;
    steps = [];
    total = 0;
    note = reason;
    render();
  }

  /**
   * Asks the worker to start a pass and repaints as progress messages arrive.
   * Safe to call twice: a second call while one runs is ignored.
   */
  async function run() {
    if (running) return;

    const state = getState?.() ?? null;
    if (state && (state.profiles?.length ?? 0) === 0) {
      refuse('empty');
      return;
    }

    running = true;
    steps = [];
    total = 0;
    note = null;
    render();

    const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
    try {
      if (!runtime?.sendMessage) throw new Error('messaging-unavailable');
      // The worker answers as soon as the pass begins; the verdicts arrive as
      // progress messages and end this pass here.
      const answer = await runtime.sendMessage({ type: TEST_ALL_MESSAGE });

      if (!answer?.started) {
        refuse(answer?.running ? 'busy' : 'notEligible');
        return;
      }
      total = Number(answer.total) || 0;
      if (total === 0) {
        refuse('empty');
        return;
      }
      render();
    } catch (error) {
      // No worker (offline preview), or the worker died mid-handshake.
      console.warn('[proxy-switch] the test-all pass could not be started', error);
      refuse('notEligible');
    }
  }

  buttonEl?.addEventListener('click', () => {
    run();
  });

  return {
    render,
    run,
    /**
     * Feeds one progress message in. The last one (done === total) ends the pass
     * here and paints the summary; messages that arrive when no pass of this
     * page's is running are ignored (a pass started by an earlier popup keeps
     * writing verdicts, but it has no narrator anymore).
     *
     * @returns {boolean} whether the message was recognized and used
     */
    handleProgress(raw) {
      const progress = parseProgress(raw);
      if (!progress || !running) return false;

      steps.push(progress.skipped ? { skipped: true } : { ok: progress.ok });
      if (progress.done >= progress.total) {
        running = false;
        total = 0;
      }
      render();
      return true;
    },
    get running() {
      return running;
    },
    get steps() {
      return [...steps];
    },
  };
}
