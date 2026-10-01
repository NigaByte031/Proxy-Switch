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
  loadRate,
  loadServerHealth,
  loadState,
  loadStatus,
  loadTraffic,
  subscribe,
  subscribeRate,
  subscribeServerHealth,
  subscribeStatus,
  subscribeTraffic,
  updateState,
} from './lib/storage.js';
import { describeApplyProblem, describeBadge, describeStatus } from './lib/proxy.js';
import { findProfile } from './lib/model.js';
import { createModeUi } from './lib/mode-ui.js';
import { applySiteChoice, describeSiteRoute, siteHostFromUrl, siteRouteOf } from './lib/site-route.js';
import { createRate, createTraffic, describeRate, describeTraffic } from './lib/traffic.js';
import { resolveTrafficView, trafficViewParts } from './lib/traffic-view.js';
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
  siteCard: el('siteCard'),
  siteHost: el('siteHost'),
  siteChoices: el('siteChoices'),
  siteEffect: el('siteEffect'),
  trafficPanel: el('trafficPanel'),
  trafficRow: el('trafficRow'),
  trafficDown: el('trafficDown'),
  trafficUp: el('trafficUp'),
  trafficTotalDown: el('trafficTotalDown'),
  trafficTotalUp: el('trafficTotalUp'),
  trafficDownMetric: el('trafficDownMetric'),
  trafficUpMetric: el('trafficUpMetric'),
  rateDot: el('rateDot'),
  rateText: el('rateText'),
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
/** The recent bytes the live rate reads its speed from (lib/traffic.js). */
let rate = null;
/** Ticks the speed line once a second while the popup is open. */
let rateTimer = 0;
let lang = 'en';
let transientWarning = null;
let warningTimer = 0;
/**
 * The site the popup was opened over (`lib/site-route.js`), read once. It changes
 * only when the popup is opened again, since the popup closes with its tab.
 */
let siteHost = null;

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
  domainServersPanelEl: el('domainServersPanel'),
  domainServerListEl: el('domainServerList'),
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

// The pass runs in the service worker; this is the narration: progress while it
// runs, counts at the end, under the list the verdicts appear on.
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
  // The same list the worker orders the chain by.
  getHealth: () => serverHealth,
});

function pickSiteChoice(choice) {
  if (!siteHost) return;
  commit((draft) => applySiteChoice(draft, siteHost, choice));
}

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
 * `aria-live` region, so writing the same string again would make a screen reader
 * repeat itself on every unrelated state change.
 */
function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

/**
 * The address of the active tab, reduced to the site a rule can name. Reading it
 * needs no permission of its own: the extension already holds host permissions for
 * every URL, which is what makes `tab.url` visible here.
 */
async function loadSiteHost() {
  const query = typeof chrome !== 'undefined' ? chrome.tabs?.query : null;
  if (!query) return null;
  try {
    const [tab] = await query({ active: true, currentWindow: true });
    return siteHostFromUrl(tab?.url);
  } catch {
    // No window, or a page the browser will not name: the control stays empty.
    return null;
  }
}

/**
 * The "this site" control: which lists the site is in (the chips) and what the
 * current configuration actually does with it (the line below). The two are kept
 * apart on purpose — a lit chip must not promise routing the mode will not do.
 */
function renderSite(currentLang) {
  if (!els.siteCard) return;
  const host = siteHost;
  els.siteHost.textContent = host ?? '';
  els.siteHost.classList.toggle('hidden', !host);

  if (!host) {
    els.siteChoices.classList.add('hidden');
    setText(els.siteEffect, t('site.none', currentLang));
    return;
  }

  const route = siteRouteOf(state, host);
  const chosen = route.listed ? 'proxy' : route.bypassed ? 'direct' : 'auto';
  const hasServer = Boolean(findProfile(state, state.settings.activeProfileId));

  els.siteChoices.classList.remove('hidden');
  for (const chip of els.siteChoices.querySelectorAll('.chip')) {
    const { choice } = chip.dataset;
    const active = choice === chosen;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-checked', String(active));
    // Nothing to route through: better to refuse the click than to promise it.
    if (choice === 'proxy') chip.disabled = !hasServer;
  }

  const described = describeSiteRoute(state, host);
  setText(els.siteEffect, t(described.key, currentLang, described.params));
}

/**
 * The speed line, read fresh from the window each time. Called by every render
 * *and* by the one-second tick below: storage only changes when the worker flushes
 * a batch, but the decay keeps moving between flushes, and a speed that froze
 * between them would lie the other way.
 */
function renderRate() {
  const { idle, down, up } = describeRate(rate ?? createRate());
  els.rateDot.dataset.idle = String(idle);
  setText(els.rateText, t(idle ? 'traffic.rateIdle' : 'traffic.rate', lang, { down, up }));
}

function render() {
  lang = resolveLang(state.settings.language, navigator.language);
  applyDocumentLang(lang);
  applyStaticText(document, lang);

  els.langBtn.textContent = LANG_LABELS[otherLang(lang)];
  els.langBtn.title = t('lang.switch', lang);
  els.langBtn.setAttribute('aria-label', els.langBtn.title);

  // The button shows and names the theme in force, so a click never surprises.
  els.themeBtn.textContent = themeIcon(state.settings.theme);
  els.themeBtn.title = `${t('theme.switch', lang)} · ${t(themeKey(state.settings.theme), lang)}`;
  els.themeBtn.setAttribute('aria-label', els.themeBtn.title);

  // Written onto <html>, where src/styles/base.css picks the palettes up. The popup
  // has no picker of its own: it wears what the settings page saved.
  applyTheme(state.settings.theme);
  applyAccent(state.settings.accent);

  // A proxy not really in force outranks the mode: every indicator says so.
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

  // The card wears the colour of the active mode, and amber when something is
  // missing, so the popup reads at a glance.
  els.statusCard.dataset.tone = problem || status.tone === 'warn' ? 'warn' : badge.tone;
  els.masterToggle.checked = state.settings.enabled;

  // A short-lived message takes the line for a few seconds; an apply problem stays
  // until it is fixed.
  const warning = transientWarning ?? problemText;
  els.warning.textContent = warning ?? '';
  els.warning.classList.toggle('hidden', !warning);

  renderSite(lang);

  const count = state.settings.bypassList.length;
  els.bypassInfo.textContent = count
    ? t('field.bypassSummary', lang, { count })
    : t('field.bypassNone', lang);

  // The panel is hidden when counting is off, so the popup never shows a number
  // that is not being kept up to date; the arrows are decoration, hence the labels.
  const meterOn = state.settings.trafficMeter === true;
  els.trafficPanel.classList.toggle('hidden', !meterOn);
  if (meterOn) {
    // The template the settings page picked, worn by the popup too (lib/traffic-view.js).
    const view = resolveTrafficView(state.settings.trafficView);
    els.trafficPanel.dataset.view = view;

    const reading = describeTraffic(traffic ?? createTraffic());
    setText(els.trafficDown, reading.down);
    setText(els.trafficUp, reading.up);
    setText(els.trafficTotalDown, reading.totalDown);
    setText(els.trafficTotalUp, reading.totalUp);
    els.trafficDownMetric.setAttribute('aria-label', t('traffic.down', lang, { value: reading.down }));
    els.trafficUpMetric.setAttribute('aria-label', t('traffic.up', lang, { value: reading.up }));
    // A template that shows the total itself needs no hover text for it; the
    // classic row, which has no room, keeps it there instead.
    els.trafficRow.title = trafficViewParts(view).total
      ? ''
      : t('traffic.totalTitle', lang, {
          down: reading.totalDown,
          up: reading.totalUp,
        });

    renderRate();
  }

  modeUi.render(state, lang);
  serversUi.render(state, lang);
  healthUi.render(lang);
  testAllUi.render(lang);
}

function wire() {
  // The rate decays in real time; the tick keeps the line honest between writes.
  rateTimer = setInterval(() => {
    if (state?.settings?.trafficMeter === true) renderRate();
  }, 1000);

  els.masterToggle.addEventListener('change', () => {
    const enabled = els.masterToggle.checked;
    commit((draft) => {
      draft.settings.enabled = enabled;
    });
  });

  // One click routes the site the popup sits over. The chips are a radiogroup, so
  // the arrow keys walk them the way the mode chips and the template picker do.
  els.siteChoices?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip?.dataset.choice) pickSiteChoice(chip.dataset.choice);
  });

  els.siteChoices?.addEventListener('keydown', (event) => {
    const chip = event.target.closest('.chip');
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!chip || !step) return;
    event.preventDefault();
    const chips = [...els.siteChoices.querySelectorAll('.chip')];
    const index = (chips.indexOf(chip) + step + chips.length) % chips.length;
    const next = chips[index];
    next.focus();
    if (!next.disabled) pickSiteChoice(next.dataset.choice);
  });

  // The frosted header only draws its hairline once content slides under it. Scroll
  // events do not bubble, so the listener sits on `document` in the capture phase.
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
  siteHost = await loadSiteHost();
  applyStatus = await loadStatus();
  serverHealth = await loadServerHealth();
  traffic = await loadTraffic();
  rate = await loadRate();
  wire();
  render();
  subscribe((next) => {
    state = next;
    render();
  });
  // A background check or the test button can add a verdict while the popup is open.
  subscribeServerHealth((next) => {
    serverHealth = next;
    render();
  });
  // Written by the worker after every apply attempt, including while this page is open.
  subscribeStatus((next) => {
    applyStatus = next;
    render();
  });

  // The meter writes in batches while pages load under this popup.
  subscribeTraffic((next) => {
    traffic = next;
    render();
  });
  subscribeRate((next) => {
    rate = next;
    renderRate();
  });

  // The pass announces each verdict; the rows get it through the health record.
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

// The popup dies with its DOM: the tick has nothing left to render.
window.addEventListener('unload', () => clearInterval(rateTimer));

init();
