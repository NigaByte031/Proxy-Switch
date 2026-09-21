/**
 * Shared "proxy mode" controls: the mode chips and the PAC URL row.
 * Used by both the popup and the settings page, which is why it lives here
 * instead of being duplicated in the two page scripts.
 */

import { isValidPacUrl } from './model.js';
import { modeKey, t } from './i18n.js';

export function createModeUi({
  chipsEl,
  hintEl,
  pacPanelEl,
  pacUrlEl,
  pacSaveEl,
  commit,
  getLang,
  onError = () => {},
}) {
  function render(state, lang) {
    const mode = state.settings.mode;
    if (chipsEl) {
      for (const chip of chipsEl.querySelectorAll('.chip')) {
        const active = chip.dataset.mode === mode;
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-pressed', String(active));
      }
    }
    if (hintEl) hintEl.textContent = t(modeKey(mode, 'mode.hint'), lang);
    if (pacPanelEl) pacPanelEl.classList.toggle('hidden', mode !== 'pac_script');
    if (pacUrlEl && document.activeElement !== pacUrlEl) pacUrlEl.value = state.settings.pacUrl;
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

  chipsEl?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    const mode = chip?.dataset.mode;
    if (!mode) return;
    commit((draft) => {
      draft.settings.mode = mode;
      // Choosing a mode is an explicit "I want this" — turn the switch back on.
      draft.settings.enabled = true;
    });
  });

  pacSaveEl?.addEventListener('click', savePac);
  pacUrlEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      savePac();
    }
  });

  return { render, savePac };
}
