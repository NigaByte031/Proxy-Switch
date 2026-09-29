/**
 * Shared "proxy mode" controls: the mode chips, the PAC URL row and the domain
 * list that replaces it (see `lib/pac.js`).
 * Used by both the popup and the settings page.
 */

import { formatDomainList, isValidPacUrl, parseDomainRules } from './model.js';
import { modeKey, t } from './i18n.js';

export function createModeUi({
  chipsEl,
  hintEl,
  pacPanelEl,
  pacUrlRowEl,
  pacUrlEl,
  pacDomainsToggleEl,
  pacDomainsPanelEl,
  pacDomainsEl,
  pacDomainsSaveEl,
  pacSaveEl,
  commit,
  getLang,
  onError = () => {},
}) {
  function render(state, lang) {
    const mode = state.settings.mode;
    const routing = state.settings.domainRouting === true;

    if (chipsEl) {
      for (const chip of chipsEl.querySelectorAll('.chip')) {
        const active = chip.dataset.mode === mode;
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-pressed', String(active));
      }
    }
    if (hintEl) hintEl.textContent = t(modeKey(mode, 'mode.hint'), lang);

    const isPac = mode === 'pac_script';
    if (pacPanelEl) pacPanelEl.classList.toggle('hidden', !isPac);
    // Exactly one source is on screen: the script the list builds, or the URL.
    if (pacUrlRowEl) pacUrlRowEl.classList.toggle('hidden', routing);
    if (pacDomainsPanelEl) pacDomainsPanelEl.classList.toggle('hidden', !routing);
    if (pacDomainsToggleEl) pacDomainsToggleEl.checked = routing;

    if (pacUrlEl && !routing && document.activeElement !== pacUrlEl) {
      pacUrlEl.value = state.settings.pacUrl;
    }
    if (pacDomainsEl && !routing && document.activeElement !== pacDomainsEl) {
      pacDomainsEl.value = '';
    }
    if (pacDomainsEl && routing && document.activeElement !== pacDomainsEl) {
      pacDomainsEl.value = formatDomainList(state.settings.proxyDomains);
    }
  }

  async function savePac() {
    const url = String(pacUrlEl?.value ?? '').trim();
    if (url && !isValidPacUrl(url)) {
      onError(t('error.pacInvalid', getLang()));
      return;
    }
    onError(null);
    await commit((draft) => {
      draft.settings.pacUrl = url;
    });
  }

  async function saveDomains() {
    // A line that cannot be a host is dropped; the list is read on every render,
    // so what the user sees back is what will be used.
    const domains = parseDomainRules(pacDomainsEl?.value ?? '');
    onError(null);
    await commit((draft) => {
      draft.settings.proxyDomains = domains;
    });
  }

  chipsEl?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    const mode = chip?.dataset.mode;
    if (!mode) return;
    commit((draft) => {
      draft.settings.mode = mode;
      // Picking a mode is an explicit "I want this": turn the switch back on.
      draft.settings.enabled = true;
    });
  });

  pacDomainsToggleEl?.addEventListener('change', () => {
    const domainRouting = pacDomainsToggleEl.checked;
    onError(null);
    commit((draft) => {
      draft.settings.domainRouting = domainRouting;
    });
  });

  pacSaveEl?.addEventListener('click', savePac);
  pacDomainsSaveEl?.addEventListener('click', saveDomains);
  pacUrlEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      savePac();
    }
  });

  return { render, savePac, saveDomains };
}
