/**
 * Popup controller: status card, master switch, mode chips, quick server list.
 * The popup never applies the proxy itself — it only writes state, and the
 * service worker reacts to that (single writer, no duplicated logic).
 */

import { applyDocumentLang, applyStaticText, LANG_LABELS, otherLang, resolveLang, t } from './lib/i18n.js';
import { loadState, subscribe, updateState } from './lib/storage.js';
import { describeStatus } from './lib/proxy.js';
import { createModeUi } from './lib/mode-ui.js';
import { createServersUi } from './lib/servers-ui.js';

const el = (id) => document.getElementById(id);

const els = {
  langBtn: el('langBtn'),
  optionsBtn: el('optionsBtn'),
  statusDot: el('statusDot'),
  statusTitle: el('statusTitle'),
  statusDetail: el('statusDetail'),
  masterToggle: el('masterToggle'),
  warning: el('warning'),
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

  const status = describeStatus(state);
  els.statusTitle.textContent = t(status.title.key, lang, status.title.params);
  els.statusDetail.textContent = t(status.detail.key, lang, status.detail.params);
  els.statusDot.className = `dot is-${status.tone}`;
  els.masterToggle.checked = state.settings.enabled;

  els.warning.textContent = transientWarning ?? '';
  els.warning.classList.toggle('hidden', !transientWarning);

  const count = state.settings.bypassList.length;
  els.bypassInfo.textContent = count
    ? t('field.bypassSummary', lang, { count })
    : t('field.bypassNone', lang);

  modeUi.render(state, lang);
  serversUi.render(state, lang);
}

function wire() {
  els.masterToggle.addEventListener('change', () => {
    const enabled = els.masterToggle.checked;
    commit((draft) => {
      draft.settings.enabled = enabled;
    });
  });

  els.langBtn.addEventListener('click', () => {
    const next = otherLang(lang);
    commit((draft) => {
      draft.settings.language = next;
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
}

init();
