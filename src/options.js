/**
 * Settings page controller: language, theme, auto-auth, proxy mode, servers,
 * bypass list, and JSON backup/restore.
 * Like the popup it only writes state; the service worker applies it.
 */

import { applyDocumentLang, applyStaticText, resolveLang, t } from './lib/i18n.js';
import { applyTheme, watchSystemTheme } from './lib/theme.js';
import { loadState, saveState, subscribe, updateState } from './lib/storage.js';
import {
  createDefaultState,
  parseBypassList,
  formatBypassList,
  parseImport,
  serializeState,
} from './lib/model.js';
import { createModeUi } from './lib/mode-ui.js';
import { createServersUi } from './lib/servers-ui.js';
import { createHealthUi } from './lib/health-ui.js';

const el = (id) => document.getElementById(id);

const els = {
  versionBadge: el('versionBadge'),
  version: el('version'),
  langSelect: el('langSelect'),
  themeSelect: el('themeSelect'),
  enabledToggle: el('enabledToggle'),
  authToggle: el('authToggle'),
  bypassInput: el('bypassInput'),
  bypassSave: el('bypassSave'),
  testBtn: el('testBtn'),
  testResult: el('testResult'),
  exportBtn: el('exportBtn'),
  importBtn: el('importBtn'),
  importInput: el('importInput'),
  resetBtn: el('resetBtn'),
  dataMessage: el('dataMessage'),
};

let state = null;
let lang = 'en';
let message = null;
let messageTimer = 0;

const commit = (mutator) => updateState(mutator);

const modeUi = createModeUi({
  chipsEl: el('modeChips'),
  hintEl: el('modeHint'),
  pacPanelEl: el('pacPanel'),
  pacUrlEl: el('pacUrl'),
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

const serversUi = createServersUi({
  listEl: el('profileList'),
  emptyEl: el('profilesEmpty'),
  formEl: el('profileForm'),
  addBtn: el('addBtn'),
  getState: () => state,
  getLang: () => lang,
  commit,
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

function render() {
  lang = resolveLang(state.settings.language, navigator.language);
  applyDocumentLang(lang);
  applyStaticText(document, lang);

  // The theme is written onto <html>, where src/styles/base.css picks it up.
  applyTheme(state.settings.theme);

  if (document.activeElement !== els.langSelect) els.langSelect.value = state.settings.language;
  if (document.activeElement !== els.themeSelect) els.themeSelect.value = state.settings.theme;
  els.enabledToggle.checked = state.settings.enabled;
  els.authToggle.checked = state.settings.autoAuth;

  if (document.activeElement !== els.bypassInput) {
    els.bypassInput.value = formatBypassList(state.settings.bypassList);
  }

  els.dataMessage.textContent = message ?? '';
  els.dataMessage.classList.toggle('hidden', !message);

  modeUi.render(state, lang);
  serversUi.render(state, lang);
  healthUi.render(lang);
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

function wire() {
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

  els.bypassSave.addEventListener('click', async () => {
    const rules = parseBypassList(els.bypassInput.value);
    await commit((draft) => {
      draft.settings.bypassList = rules;
    });
    flash(t('msg.saved', lang));
  });

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
  const version = chrome.runtime.getManifest().version;
  els.version.textContent = version;
  els.versionBadge.textContent = `v${version}`;

  state = await loadState();
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
}

init();
