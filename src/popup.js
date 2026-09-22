/**
 * Popup controller: status card, master switch, mode chips, quick server list.
 * The popup never applies the proxy itself — it only writes state, and the
 * service worker reacts to that (single writer, no duplicated logic).
 */

import { applyDocumentLang, applyStaticText, LANG_LABELS, otherLang, resolveLang, t } from './lib/i18n.js';
import { applyTheme, nextTheme, themeIcon, themeKey, watchSystemTheme } from './lib/theme.js';
import { loadState, subscribe, updateState } from './lib/storage.js';
import { describeBadge, describeStatus } from './lib/proxy.js';
import { createModeUi } from './lib/mode-ui.js';
import { createServersUi } from './lib/servers-ui.js';
import { createHealthUi } from './lib/health-ui.js';

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
  bypassInfo: el('bypassInfo'),
  editBypass: el('editBypass'),
};

let state = null;
let lang = 'en';
let transientWarning = null;
let warningTimer = 0;

const commit = (mutator) => updateState(mutator);

const modeUi = createModeUi({
  chipsEl: el('modeChips'),
  hintEl: el('modeHint'),
  pacPanelEl: el('pacPanel'),
  pacUrlEl: el('pacUrl'),
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
});

const serversUi = createServersUi({
  listEl: el('profileList'),
  emptyEl: el('profilesEmpty'),
  formEl: el('profileForm'),
  addBtn: el('addBtn'),
  getState: () => state,
  getLang: () => lang,
  commit,
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

function render() {
  lang = resolveLang(state.settings.language, navigator.language);
  applyDocumentLang(lang);
  applyStaticText(document, lang);

  els.langBtn.textContent = LANG_LABELS[otherLang(lang)];
  els.langBtn.title = t('lang.switch', lang);

  // The button shows the theme that is showing and names it, so a click never
  // lands on a theme the user did not expect (see nextTheme).
  els.themeBtn.textContent = themeIcon(state.settings.theme);
  els.themeBtn.title = `${t('theme.switch', lang)} · ${t(themeKey(state.settings.theme), lang)}`;
  els.themeBtn.setAttribute('aria-label', els.themeBtn.title);

  // The theme is written onto <html>, where src/styles/base.css picks it up.
  applyTheme(state.settings.theme);

  // The pill repeats what the toolbar badge shows, so the popup explains the icon.
  const badge = describeBadge(state);
  els.statePill.textContent = badge.text;
  els.statePill.dataset.tone = badge.tone;

  els.footerMeta.textContent = version
    ? `${t('popup.shortcuts', lang)} · v${version}`
    : t('popup.shortcuts', lang);

  const status = describeStatus(state);
  els.statusTitle.textContent = t(status.title.key, lang, status.title.params);
  els.statusDetail.textContent = t(status.detail.key, lang, status.detail.params);
  els.statusDot.className = `dot is-${status.tone}`;

  // The card wears the colour of the active mode (emerald for a server, indigo
  // for PAC, slate for the system proxy) and turns amber when something is
  // missing, so the popup can be read at a glance.
  els.statusCard.dataset.tone = status.tone === 'warn' ? 'warn' : badge.tone;
  els.masterToggle.checked = state.settings.enabled;

  els.warning.textContent = transientWarning ?? '';
  els.warning.classList.toggle('hidden', !transientWarning);

  const count = state.settings.bypassList.length;
  els.bypassInfo.textContent = count
    ? t('field.bypassSummary', lang, { count })
    : t('field.bypassNone', lang);

  modeUi.render(state, lang);
  serversUi.render(state, lang);
  healthUi.render(lang);
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
  wire();
  render();
  subscribe((next) => {
    state = next;
    render();
  });

  // A popup can stay open for a while; an "auto" theme keeps following the OS.
  watchSystemTheme(() => {
    if (state) applyTheme(state.settings.theme);
  });
}

init();
