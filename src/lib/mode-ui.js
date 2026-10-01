/**
 * Shared "proxy mode" controls: the mode chips, the PAC URL row and the domain
 * list that replaces it (see `lib/pac.js`).
 * Used by both the popup and the settings page.
 */

import {
  domainServerOf,
  formatDomainList,
  isValidPacUrl,
  parseDomainRules,
  sanitizeDomainRules,
} from './model.js';
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
  domainServersPanelEl,
  domainServerListEl,
  pacSaveEl,
  commit,
  getLang,
  onError = () => {},
}) {
  /**
   * One row per listed site, with the server it goes through (`lib/site-route.js`).
   * The list is the source of truth, so a rule that was deleted from the textarea
   * takes its row — and the server it was given — with it.
   */
  function renderDomainServers(state, lang) {
    if (!domainServerListEl) return;
    const rules = sanitizeDomainRules(state.settings.proxyDomains ?? []);
    domainServerListEl.textContent = '';

    for (const rule of rules) {
      const row = document.createElement('li');
      row.className = 'domain-server-row';

      const name = document.createElement('span');
      name.className = 'domain-server-rule';
      name.textContent = rule;

      const select = document.createElement('select');
      select.className = 'domain-server-select';
      select.dataset.rule = rule;
      select.setAttribute('aria-label', t('field.domainServerFor', lang, { host: rule }));

      const fallback = document.createElement('option');
      fallback.value = '';
      fallback.textContent = t('field.domainServersDefault', lang);
      select.append(fallback);

      const current = domainServerOf(state.settings, rule);
      for (const profile of state.profiles ?? []) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        option.selected = profile.id === current;
        select.append(option);
      }

      row.append(name, select);
      domainServerListEl.append(row);
    }

    domainServersPanelEl?.classList.toggle('hidden', rules.length === 0);
  }

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

    renderDomainServers(state, lang);
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

  // Where each listed site goes, when a site asked for a server of its own.
  domainServerListEl?.addEventListener('change', (event) => {
    const select = event.target.closest('.domain-server-select');
    if (!select) return;
    const { rule } = select.dataset;
    const profileId = select.value;
    commit((draft) => {
      const map = { ...(draft.settings.domainServers ?? {}) };
      if (profileId) map[rule] = profileId;
      else delete map[rule];
      draft.settings.domainServers = map;
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
