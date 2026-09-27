/**
 * Popup controller: status card, master switch, mode chips, quick server list.
 * The popup never applies the proxy itself — it only writes state, and the
 * service worker reacts to that (single writer, no duplicated logic).
 */

import { applyDocumentLang, applyStaticText, LANG_LABELS, otherLang, resolveLang, t } from './lib/i18n.js';
import {
  applyAccent,
  applyTheme,
  nextTheme,
  themeIcon,
  themeKey,
  watchSystemTheme,
} from './lib/theme.js';
import {
  loadServerHealth,
  loadState,
  loadStatus,
  loadTraffic,
  subscribe,
  subscribeServerHealth,
  subscribeStatus,
  subscribeTraffic,
  updateState,
} from './lib/storage.js';
import { describeApplyProblem, describeBadge, describeStatus } from './lib/proxy.js';
import { createModeUi } from './lib/mode-ui.js';
import { createTraffic, describeTraffic } from './lib/traffic.js';
import { createServersUi } from './lib/servers-ui.js';
import { createHealthUi } from './lib/health-ui.js';
import { createTestAllUi } from './lib/test-all-ui.js';
import { TEST_ALL_PROGRESS_MESSAGE } from './lib/server-probe.js';

const el = (id) => document.getElementById(id);

const version =
  typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version ?? '' : '';

const els = {
  langBtn: el('langBtn'),
  themeBtn: el('themeBtn'),
  optionsBtn: el('optionsBtn'),
  header: document.querySelector('.app-header'),
  statusCard: el('statusCard'),
  statusDot: el('statusDot'),
  statePill: el('statePill'),
  footerMeta: el('footerMeta'),
  statusTitle: el('statusTitle'),
  statusDetail: el('statusDetail'),
  masterToggle: el('masterToggle'),
  warning: el('warning'),
  testBtn: el('testBtn'),
  testResult: el('testResult'),
  trafficRow: el('trafficRow'),
  trafficDown: el('trafficDown'),
  trafficUp: el('trafficUp'),
  trafficDownMetric: el('trafficDownMetric'),
  trafficUpMetric: el('trafficUpMetric'),
  bypassInfo: el('bypassInfo'),
  editBypass: el('editBypass'),
};

let state = null;
/** Result of the last attempt by the service worker to apply the proxy. */
let applyStatus = null;
/** What the extension has seen about each server (lib/server-health.js). */
let serverHealth = null;
/** What the meter has counted (lib/traffic.js). */
let traffic = null;
let lang = 'en';
let transientWarning = null;
let warningTimer = 0;

const commit = (mutator) => updateState(mutator);

const modeUi = createModeUi({
  chipsEl: el('modeChips'),
  hintEl: el('modeHint'),
  pacPanelEl: el('pacPanel'),
  pacUrlRowEl: el('pacUrlRow'),
  pacUrlEl: el('pacUrl'),
  pacDomainsToggleEl: el('pacDomainsToggle'),
  pacDomainsPanelEl: el('pacDomainsPanel'),
  pacDomainsEl: el('pacDomains'),
  pacDomainsSaveEl: el('pacDomainsSave'),
  pacSaveEl: el('pacSave'),
  commit,
  getLang: () => lang,
  onError: (message) => {
    if (message) flashWarning(message);
    else transientWarning = null;
  },
});

const healthUi = createHealthUi({
  buttonEl: el('testBtn'),
  resultEl: el('testResult'),
  getLang: () => lang,
  // so a verdict can be attributed to the server the test went through
  getState: () => state,
});

// The pass itself runs in the service worker (only the worker may touch
// chrome.proxy); this is the narration: progress while it runs, counts at the
// end, under the list the verdicts are appearing on.
const testAllUi = createTestAllUi({
  buttonEl: el('testAllBtn'),
  resultEl: el('testAllResult'),
  getLang: () => lang,
  getState: () => state,
});

const serversUi = createServersUi({
  listEl: el('profileList'),
  emptyEl: el('profilesEmpty'),
  noMatchEl: el('profilesNoMatch'),
  searchEl: el('profileSearch'),
  searchInput: el('profileQuery'),
  searchClear: el('profileQueryClear'),
  formEl: el('profileForm'),
  addBtn: el('addBtn'),
  getState: () => state,
  getLang: () => lang,
  commit,
  // The rows say which servers the extension believes are working, so the same
  // list the worker orders the chain by is visible here.
  getHealth: () => serverHealth,
});

function flashWarning(message) {
  transientWarning = message;
  render();
  clearTimeout(warningTimer);
  warningTimer = setTimeout(() => {
    transientWarning = null;
    render();
  }, 4000);
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

/**
 * Only touches the DOM when the text really changed. The status line is an
 * `aria-live` region, so writing the same string again would make a screen
 * reader repeat itself on every unrelated state change.
 */
function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function render() {
  lang = resolveLang(state.settings.language, navigator.language);
  applyDocumentLang(lang);
  applyStaticText(document, lang);

  els.langBtn.textContent = LANG_LABELS[otherLang(lang)];
  els.langBtn.title = t('lang.switch', lang);
  els.langBtn.setAttribute('aria-label', els.langBtn.title);

  // The button shows the theme that is showing and names it, so a click never
  // lands on a theme the user did not expect (see nextTheme).
  els.themeBtn.textContent = themeIcon(state.settings.theme);
  els.themeBtn.title = `${t('theme.switch', lang)} · ${t(themeKey(state.settings.theme), lang)}`;
  els.themeBtn.setAttribute('aria-label', els.themeBtn.title);

  // The theme and the brand hue are written onto <html>, where src/styles/base.css
  // picks the two palettes up. The popup has no picker of its own: a popup is
  // the wrong place to choose a colour, so it only wears what the settings page
  // saved.
  applyTheme(state.settings.theme);
  applyAccent(state.settings.accent);

  // A proxy that is not really in force outranks the mode: pill, card and warning
  // line all say what the toolbar badge says instead of contradicting it.
  const problem = describeApplyProblem(applyStatus);
  const problemText = problem
    ? `${t(problem.title.key, lang, problem.title.params)} — ${t(
        problem.detail.key,
        lang,
        problem.detail.params,
      )}`
    : null;
  const badge = describeBadge(state, problem);
  els.statePill.textContent = badge.text;
  els.statePill.dataset.tone = badge.tone;
  els.statePill.title = problemText ?? '';

  els.footerMeta.textContent = version
    ? `${t('popup.shortcuts', lang)} · v${version}`
    : t('popup.shortcuts', lang);

  const status = describeStatus(state);
  setText(els.statusTitle, t(status.title.key, lang, status.title.params));
  setText(els.statusDetail, t(status.detail.key, lang, status.detail.params));
  els.statusDot.className = `dot is-${status.tone}`;

  // The card wears the colour of the active mode (emerald for a server, indigo
  // for PAC, slate for the system proxy) and turns amber when something is
  // missing, so the popup can be read at a glance.
  els.statusCard.dataset.tone = problem || status.tone === 'warn' ? 'warn' : badge.tone;
  els.masterToggle.checked = state.settings.enabled;

  // A short-lived message ("that PAC URL is not valid") takes the line for a few
  // seconds; the apply problem stays until it is fixed.
  const warning = transientWarning ?? problemText;
  els.warning.textContent = warning ?? '';
  els.warning.classList.toggle('hidden', !warning);

  const count = state.settings.bypassList.length;
  els.bypassInfo.textContent = count
    ? t('field.bypassSummary', lang, { count })
    : t('field.bypassNone', lang);

  // The meter is the one thing in the popup that moves while it is open. The
  // row is hidden when counting is off, so the popup never shows a number that
  // is not being kept up to date; each figure is labelled with its direction,
  // because the arrows next to them are decoration.
  const meterOn = state.settings.trafficMeter === true;
  els.trafficRow.classList.toggle('hidden', !meterOn);
  if (meterOn) {
    const reading = describeTraffic(traffic ?? createTraffic());
    setText(els.trafficDown, reading.down);
    setText(els.trafficUp, reading.up);
    els.trafficDownMetric.setAttribute('aria-label', t('traffic.down', lang, { value: reading.down }));
    els.trafficUpMetric.setAttribute('aria-label', t('traffic.up', lang, { value: reading.up }));
    // The totals, which do not fit on one popup row, are a hover away.
    els.trafficRow.title = t('traffic.totalTitle', lang, {
      down: reading.totalDown,
      up: reading.totalUp,
    });
  }

  modeUi.render(state, lang);
  serversUi.render(state, lang);
  healthUi.render(lang);
  testAllUi.render(lang);
}

function wire() {
  els.masterToggle.addEventListener('change', () => {
    const enabled = els.masterToggle.checked;
    commit((draft) => {
      draft.settings.enabled = enabled;
    });
  });

  // The frosted header only draws its hairline once content slides under it.
  // Scroll events do not bubble, so the listener sits on `document` in the
  // capture phase: that catches the viewport as well as any inner scroller.
  const header = els.header;
  if (header) {
    const sync = () => {
      const top = window.scrollY || document.scrollingElement?.scrollTop || 0;
      header.classList.toggle('is-scrolled', top > 2);
    };
    document.addEventListener('scroll', sync, { passive: true, capture: true });
    sync();
  }

  els.langBtn.addEventListener('click', () => {
    const next = otherLang(lang);
    commit((draft) => {
      draft.settings.language = next;
    });
  });

  els.themeBtn.addEventListener('click', () => {
    const theme = nextTheme(state.settings.theme);
    commit((draft) => {
      draft.settings.theme = theme;
    });
  });

  els.optionsBtn.addEventListener('click', openOptions);
  els.editBypass.addEventListener('click', (event) => {
    event.preventDefault();
    openOptions();
  });
}

async function init() {
  state = await loadState();
  applyStatus = await loadStatus();
  serverHealth = await loadServerHealth();
  traffic = await loadTraffic();
  wire();
  render();
  subscribe((next) => {
    state = next;
    render();
  });
  // A background check or the test button can add a verdict while the popup is
  // open; the list is the place it shows up.
  subscribeServerHealth((next) => {
    serverHealth = next;
    render();
  });
  // The service worker writes this after every apply attempt, including the ones
  // that happen while the popup is already open.
  subscribeStatus((next) => {
    applyStatus = next;
    render();
  });

  // The meter writes in batches while pages load under this popup, so the
  // figures follow along on their own.
  subscribeTraffic((next) => {
    traffic = next;
    render();
  });

  // The test-all pass announces each verdict as it is recorded; this page only
  // narrates (the verdict itself reaches the rows through the health record).
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== TEST_ALL_PROGRESS_MESSAGE) return;
      testAllUi.handleProgress(message);
    });
  }

  // A popup can stay open for a while; an "auto" theme keeps following the OS.
  watchSystemTheme(() => {
    if (state) applyTheme(state.settings.theme);
  });
}

init();
