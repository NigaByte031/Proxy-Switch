/**
 * Settings page controller: language, theme, auto-auth, proxy mode, servers,
 * bypass list, and JSON backup/restore. Like the popup it only writes state; the
 * service worker applies it.
 */

import { applyDocumentLang, applyStaticText, resolveLang, t } from './lib/i18n.js';
import { accentKey, applyAccent, applyTheme, resolveAccent, watchSystemTheme } from './lib/theme.js';
import {
  loadRate,
  loadServerHealth,
  loadState,
  loadStatus,
  loadTraffic,
  saveState,
  subscribe,
  subscribeRate,
  subscribeServerHealth,
  subscribeStatus,
  subscribeTraffic,
  updateRate,
  updateState,
  updateTraffic,
} from './lib/storage.js';
import {
  ACCENTS,
  TRAFFIC_VIEWS,
  createDefaultState,
  parseBypassList,
  formatBypassList,
  parseImport,
  serializeState,
} from './lib/model.js';
import { describeApplyProblem, requestReapply } from './lib/proxy.js';
import {
  createRate,
  createTraffic,
  describeRate,
  describeTraffic,
  resetRate,
  resetTraffic,
} from './lib/traffic.js';
import { resolveTrafficView, trafficViewHintKey } from './lib/traffic-view.js';
import { createModeUi } from './lib/mode-ui.js';
import { createServersUi } from './lib/servers-ui.js';
import { createHealthUi } from './lib/health-ui.js';
import { createTestAllUi } from './lib/test-all-ui.js';
import { TEST_ALL_PROGRESS_MESSAGE } from './lib/server-probe.js';

const el = (id) => document.getElementById(id);

const els = {
  versionBadge: el('versionBadge'),
  version: el('version'),
  langSelect: el('langSelect'),
  themeSelect: el('themeSelect'),
  accentSwatches: el('accentSwatches'),
  enabledToggle: el('enabledToggle'),
  authToggle: el('authToggle'),
  failoverToggle: el('failoverToggle'),
  notifyToggle: el('notifyToggle'),
  probeToggle: el('probeToggle'),
  trafficReadout: el('trafficReadout'),
  trafficToday: el('trafficToday'),
  trafficTotal: el('trafficTotal'),
  trafficRate: el('trafficRate'),
  trafficViewPicker: el('trafficViewPicker'),
  trafficViewHint: el('trafficViewHint'),
  trafficToggle: el('trafficToggle'),
  trafficReset: el('trafficReset'),
  trafficMessage: el('trafficMessage'),
  bypassInput: el('bypassInput'),
  bypassSave: el('bypassSave'),
  testBtn: el('testBtn'),
  testResult: el('testResult'),
  exportBtn: el('exportBtn'),
  importBtn: el('importBtn'),
  importInput: el('importInput'),
  resetBtn: el('resetBtn'),
  dataMessage: el('dataMessage'),
  applyPanel: el('applyPanel'),
  applyTitle: el('applyTitle'),
  applyDetail: el('applyDetail'),
  applyRetry: el('applyRetry'),
};

let state = null;

/** The buttons of the accent picker, in the order of ACCENTS. */
const swatches = [];

/**
 * Draws the accent picker from ACCENTS, so the list on the page and the palette
 * blocks in `src/styles/base.css` are the same list. Every button carries its own
 * `data-accent`, which is what lets the swatch paint itself with the real tokens
 * of the palette it offers instead of a hand-copied colour.
 */
function buildAccentSwatches() {
  if (!els.accentSwatches || swatches.length) return;

  for (const accent of ACCENTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.accent = accent;
    // A radio group: exactly one palette is in force at a time, and the arrow keys
    // walk it the way a native radio group does.
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');

    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'swatch-name';
    button.append(dot, name);

    button.addEventListener('click', () => pickAccent(accent));
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index = (ACCENTS.indexOf(accent) + step + ACCENTS.length) % ACCENTS.length;
      const next = ACCENTS[index];
      swatches[index]?.button.focus();
      pickAccent(next);
    });

    swatches.push({ accent, button });
    els.accentSwatches.append(button);
  }
}

function pickAccent(accent) {
  if (!state || resolveAccent(state.settings.accent) === accent) return;
  commit((draft) => {
    draft.settings.accent = accent;
  });
}

/** Names each swatch in the current language and marks the one in force. */
function renderAccents() {
  const active = resolveAccent(state.settings.accent);
  for (const { accent, button } of swatches) {
    const isActive = accent === active;
    const name = t(accentKey(accent), lang);
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-checked', String(isActive));
    button.title = name;
    const label = button.querySelector('.swatch-name');
    if (label && label.textContent !== name) label.textContent = name;
  }
}

/** The buttons of the traffic-template picker, in the order of TRAFFIC_VIEWS. */
const viewOptions = [];

/**
 * Collects the template buttons and wires them, following TRAFFIC_VIEWS so the
 * arrow keys walk the picker in the order it is drawn. The buttons and their little
 * diagrams live in the page; the behaviour is here.
 */
function buildTrafficViewPicker() {
  if (!els.trafficViewPicker || viewOptions.length) return;

  for (const button of els.trafficViewPicker.querySelectorAll('[data-view]')) {
    const view = button.dataset.view;
    if (!TRAFFIC_VIEWS.includes(view)) continue;

    button.addEventListener('click', () => pickTrafficView(view));
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index =
        (TRAFFIC_VIEWS.indexOf(view) + step + TRAFFIC_VIEWS.length) % TRAFFIC_VIEWS.length;
      const next = TRAFFIC_VIEWS[index];
      viewOptions.find((option) => option.view === next)?.button.focus();
      pickTrafficView(next);
    });

    viewOptions.push({ view, button });
  }
}

function pickTrafficView(view) {
  if (!state || resolveTrafficView(state.settings.trafficView) === view) return;
  commit((draft) => {
    draft.settings.trafficView = view;
  });
}

/** Marks the template in force, and says in words what it arranges. */
function renderTrafficViews() {
  const active = resolveTrafficView(state.settings.trafficView);

  for (const { view, button } of viewOptions) {
    const isActive = view === active;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-checked', String(isActive));
  }

  setText(els.trafficViewHint, t(trafficViewHintKey(active), lang));
}

/** Result of the last attempt by the service worker to apply the proxy. */
let applyStatus = null;
/** What the extension has seen about each server (lib/server-health.js). */
let serverHealth = null;
/** What the meter has counted (lib/traffic.js). */
let traffic = null;
/** The recent bytes the live rate reads its speed from (lib/traffic.js). */
let rate = null;
/** Ticks the Right-now line once a second while the page is open. */
let rateTimer = 0;
/** The line under the counters ("counters reset"), and its timer. */
let trafficMessage = null;
let trafficMessageTimer = 0;
/** True while a retry is in flight, so the button cannot be pressed twice. */
let reapplying = false;
let lang = 'en';
let message = null;
let messageTimer = 0;

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
  onError: (text) => {
    if (text) flash(text);
  },
});

const healthUi = createHealthUi({
  buttonEl: el('testBtn'),
  resultEl: el('testResult'),
  getLang: () => lang,
});

// The pass runs in the service worker; this is the narration under the list, the
// same control the popup uses.
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
  // The same list the worker orders the chain by, readable here too.
  getHealth: () => serverHealth,
});

function flash(text) {
  message = text;
  render();
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message = null;
    render();
  }, 4000);
}

/**
 * Only touches the DOM when the text really changed: the panel is an `alert`
 * region, so writing the same sentence again would make a screen reader repeat it
 * on every unrelated state change.
 */
function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

/** One line of the traffic readout: what came down and what went up. */
function describeReading(down, up) {
  return `${t('traffic.down', lang, { value: down })} · ${t('traffic.up', lang, { value: up })}`;
}

/**
 * The Right-now line, read fresh from the window each time — the same decay the
 * popup's tick keeps honest, on the page that has room to name it.
 */
function renderRate() {
  const { idle, down, up } = describeRate(rate ?? createRate());
  els.trafficRate.classList.toggle('rate-idle', idle);
  setText(els.trafficRate, t(idle ? 'traffic.rateIdle' : 'traffic.rate', lang, { down, up }));
  els.trafficRate.title = idle ? t('traffic.rateIdleHint', lang) : '';
}

/** Says what just happened under the counters, for a few seconds. */
function flashTraffic(text) {
  trafficMessage = text;
  render();
  clearTimeout(trafficMessageTimer);
  trafficMessageTimer = setTimeout(() => {
    trafficMessage = null;
    render();
  }, 4000);
}

function render() {
  lang = resolveLang(state.settings.language, navigator.language);
  applyDocumentLang(lang);
  applyStaticText(document, lang);

  // Written onto <html>, where src/styles/base.css picks the palettes up.
  applyTheme(state.settings.theme);
  applyAccent(state.settings.accent);
  renderAccents();

  if (document.activeElement !== els.langSelect) els.langSelect.value = state.settings.language;
  if (document.activeElement !== els.themeSelect) els.themeSelect.value = state.settings.theme;
  els.enabledToggle.checked = state.settings.enabled;
  els.authToggle.checked = state.settings.autoAuth;
  els.failoverToggle.checked = state.settings.autoFailover;
  els.notifyToggle.checked = state.settings.notifyFailover;
  els.probeToggle.checked = state.settings.backgroundProbe;
  els.trafficToggle.checked = state.settings.trafficMeter === true;

  // Both windows of time the meter keeps. The labels are the same keys the popup's
  // arrows use, so "today's download" is one sentence everywhere.
  const reading = describeTraffic(traffic ?? createTraffic());
  setText(els.trafficToday, describeReading(reading.down, reading.up));
  setText(els.trafficTotal, describeReading(reading.totalDown, reading.totalUp));
  // Which template draws those figures (lib/traffic-view.js); the layout itself
  // lives in styles/base.css, keyed off the attribute set here.
  els.trafficReadout.dataset.view = resolveTrafficView(state.settings.trafficView);
  renderTrafficViews();
  renderRate();

  els.trafficMessage.textContent = trafficMessage ?? '';
  els.trafficMessage.classList.toggle('hidden', !trafficMessage);

  if (document.activeElement !== els.bypassInput) {
    els.bypassInput.value = formatBypassList(state.settings.bypassList);
  }

  els.dataMessage.textContent = message ?? '';
  els.dataMessage.classList.toggle('hidden', !message);

  // Where a mode that is not in force gets repaired: it explains what the badge says.
  const problem = describeApplyProblem(applyStatus);
  els.applyPanel?.classList.toggle('hidden', !problem);
  if (problem) {
    setText(els.applyTitle, t(problem.title.key, lang, problem.title.params));
    setText(els.applyDetail, t(problem.detail.key, lang, problem.detail.params));
  }
  if (els.applyRetry) {
    els.applyRetry.disabled = reapplying;
    els.applyRetry.textContent = t(reapplying ? 'apply.retrying' : 'apply.retry', lang);
    els.applyRetry.setAttribute('aria-busy', String(reapplying));
  }

  modeUi.render(state, lang);
  serversUi.render(state, lang);
  healthUi.render(lang);
  testAllUi.render(lang);
}

function downloadExport() {
  const payload = serializeState(state);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `proxy-switch-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(t('msg.exported', lang));
}

/**
 * Asks the service worker for another apply attempt. The worker stays the only
 * code that touches `chrome.proxy`, so this is a message, and the answer comes
 * back with the status the worker just stored.
 */
async function retryApply() {
  if (reapplying) return;
  reapplying = true;
  render();

  let status = null;
  try {
    status = await requestReapply();
  } finally {
    reapplying = false;
  }

  // `subscribeStatus` has usually shown the new status; this says whether it worked.
  flash(
    status && !describeApplyProblem(status) ? t('msg.applied', lang) : t('msg.applyFailed', lang),
  );
}

function wire() {
  buildAccentSwatches();
  buildTrafficViewPicker();

  els.langSelect.addEventListener('change', () => {
    const value = els.langSelect.value;
    commit((draft) => {
      draft.settings.language = value;
    });
  });

  els.themeSelect.addEventListener('change', () => {
    const theme = els.themeSelect.value;
    commit((draft) => {
      draft.settings.theme = theme;
    });
  });

  els.enabledToggle.addEventListener('change', () => {
    const enabled = els.enabledToggle.checked;
    commit((draft) => {
      draft.settings.enabled = enabled;
    });
  });

  els.authToggle.addEventListener('change', () => {
    const autoAuth = els.authToggle.checked;
    commit((draft) => {
      draft.settings.autoAuth = autoAuth;
    });
  });

  // The worker does the switching; this only says whether it may.
  els.failoverToggle.addEventListener('change', () => {
    const autoFailover = els.failoverToggle.checked;
    commit((draft) => {
      draft.settings.autoFailover = autoFailover;
    });
  });

  // Same division of labour: the worker announces, this says whether it may.
  els.notifyToggle.addEventListener('change', () => {
    const notifyFailover = els.notifyToggle.checked;
    commit((draft) => {
      draft.settings.notifyFailover = notifyFailover;
    });
  });

  // The check runs in the worker on its own timer; this says whether it may.
  els.probeToggle.addEventListener('change', () => {
    const backgroundProbe = els.probeToggle.checked;
    commit((draft) => {
      draft.settings.backgroundProbe = backgroundProbe;
    });
  });

  // Same division of labour again: the worker counts, this says whether it may.
  els.trafficToggle.addEventListener('change', () => {
    const trafficMeter = els.trafficToggle.checked;
    commit((draft) => {
      draft.settings.trafficMeter = trafficMeter;
    });
  });

  // The counters are not configuration, so this writes their own key rather than
  // the settings: the worker reads that record fresh for every batch it flushes, so
  // a reset cannot be overwritten by an earlier batch. The rate's window goes with
  // them — a live speed about bytes that no longer exist would be a lie.
  els.trafficReset.addEventListener('click', async () => {
    if (!window.confirm(t('traffic.confirmReset', lang))) return;
    await updateTraffic((draft) => resetTraffic(draft));
    await updateRate((draft) => resetRate(draft));
    flashTraffic(t('traffic.resetDone', lang));
  });

  els.bypassSave.addEventListener('click', async () => {
    const rules = parseBypassList(els.bypassInput.value);
    await commit((draft) => {
      draft.settings.bypassList = rules;
    });
    flash(t('msg.saved', lang));
  });

  els.applyRetry?.addEventListener('click', retryApply);

  els.exportBtn.addEventListener('click', downloadExport);

  els.importBtn.addEventListener('click', () => els.importInput.click());

  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    els.importInput.value = '';
    if (!file) return;
    try {
      const result = parseImport(await file.text());
      if (!result.ok) {
        flash(t(result.error, lang));
        return;
      }
      await saveState(result.state);
      flash(t('msg.imported', lang));
    } catch {
      flash(t('msg.importError', lang));
    }
  });

  els.resetBtn.addEventListener('click', async () => {
    if (!window.confirm(t('confirm.reset', lang))) return;
    await saveState(createDefaultState());
    flash(t('msg.resetDone', lang));
  });
}

async function init() {
  // The rate decays in real time; a tick keeps the line honest between writes.
  rateTimer = setInterval(() => {
    if (state?.settings?.trafficMeter === true) renderRate();
  }, 1000);

  const version = chrome.runtime.getManifest().version;
  els.version.textContent = version;
  els.versionBadge.textContent = `v${version}`;

  state = await loadState();
  applyStatus = await loadStatus();
  serverHealth = await loadServerHealth();
  traffic = await loadTraffic();
  rate = await loadRate();
  wire();
  render();

  // An "auto" theme follows the operating system while the page stays open.
  watchSystemTheme(() => {
    if (state) applyTheme(state.settings.theme);
  });

  subscribe((next) => {
    state = next;
    render();
  });

  // Written by the worker after every apply attempt, including its own.
  subscribeStatus((next) => {
    applyStatus = next;
    render();
  });

  // Verdicts arrive from the background checks and the test button on either page.
  subscribeServerHealth((next) => {
    serverHealth = next;
    render();
  });

  // The worker writes the counters in batches as requests are made.
  subscribeTraffic((next) => {
    traffic = next;
    render();
  });
  subscribeRate((next) => {
    rate = next;
    renderRate();
  });

  // The pass announces each verdict; the rows update through the health record.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== TEST_ALL_PROGRESS_MESSAGE) return;
    testAllUi.handleProgress(message);
  });
}

// A settings page can outlive its state; the tick must not.
window.addEventListener('unload', () => clearInterval(rateTimer));

init();
