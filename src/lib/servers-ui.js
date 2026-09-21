/**
 * Shared "servers" UI: the profile list plus the add/edit form.
 * Both the popup and the settings page use the same markup, so the behaviour
 * lives here once.
 */

import { formatProfileAddress, parseProxyUrl, uniqueProfileName, validateProfile } from './model.js';
import { t } from './i18n.js';

/**
 * @param {object} options
 * @param {() => object} options.getState  current state (for duplicate-name checks)
 * @param {() => string} options.getLang
 * @param {(mutator: (draft: object) => void) => Promise<unknown>} options.commit  persists a change
 */
export function createServersUi({
  listEl,
  emptyEl,
  formEl,
  addBtn,
  getState,
  getLang,
  commit,
  confirmFn = (message) => window.confirm(message),
}) {
  /** id of the profile currently open in the form, null = creating a new one */
  let editingId = null;
  /** i18n key of the message shown under the form */
  let errorKey = null;

  const fields = formEl?.elements ?? {};
  const titleEl = formEl?.querySelector('#formTitle');
  const errorEl = formEl?.querySelector('#formError');
  const cancelBtn = formEl?.querySelector('#formCancel');

  function renderList(state, lang) {
    if (!listEl) return;
    listEl.textContent = '';
    const { profiles } = state;
    emptyEl?.classList.toggle('hidden', profiles.length > 0);

    for (const profile of profiles) {
      const active =
        state.settings.enabled &&
        state.settings.mode === 'fixed_servers' &&
        state.settings.activeProfileId === profile.id;

      const item = document.createElement('li');
      item.className = 'profile-item';
      if (active) item.classList.add('is-active');
      item.dataset.id = profile.id;

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'profile-main';
      main.title = t('profiles.use', lang);
      main.setAttribute('aria-pressed', String(active));

      const name = document.createElement('span');
      name.className = 'profile-name';
      name.textContent = profile.name;

      const detail = document.createElement('span');
      detail.className = 'profile-detail';
      detail.textContent = formatProfileAddress(profile);

      main.append(name, detail);
      main.addEventListener('click', () => {
        commit((draft) => {
          draft.settings.activeProfileId = profile.id;
          draft.settings.mode = 'fixed_servers';
          draft.settings.enabled = true;
        });
      });

      const edit = iconButton('✎', t('profiles.editAction', lang), () => openForm(state, lang, profile));
      const remove = iconButton('✕', t('profiles.deleteAction', lang), () =>
        removeProfile(state, lang, profile),
      );
      remove.classList.add('danger');

      item.append(main, edit, remove);
      listEl.append(item);
    }
  }

  function renderForm(state, lang) {
    if (!formEl) return;
    if (titleEl) titleEl.textContent = t(editingId ? 'profiles.edit' : 'profiles.new', lang);
    if (errorEl) {
      errorEl.textContent = errorKey ? t(errorKey, lang) : '';
      errorEl.classList.toggle('hidden', !errorKey);
    }
    if (addBtn) {
      addBtn.disabled = !formEl.classList.contains('hidden') && editingId === null;
    }
  }

  function render(state, lang) {
    renderList(state, lang);
    renderForm(state, lang);
  }

  function openForm(state, lang, profile = null) {
    if (!formEl) return;
    editingId = profile?.id ?? null;
    errorKey = null;
    fields.name.value = profile?.name ?? uniqueProfileName(state.profiles, t('profiles.new', lang));
    fields.scheme.value = profile?.scheme ?? 'http';
    fields.host.value = profile?.host ?? '';
    fields.port.value = profile ? String(profile.port) : '';
    fields.username.value = profile?.username ?? '';
    fields.password.value = profile?.password ?? '';
    formEl.classList.remove('hidden');
    formEl.scrollIntoView?.({ block: 'nearest' });
    fields.name.focus?.();
    fields.name.select?.();
    renderForm(state, lang);
  }

  function closeForm(state, lang) {
    if (!formEl) return;
    editingId = null;
    errorKey = null;
    formEl.classList.add('hidden');
    formEl.reset?.();
    renderForm(state, lang);
  }

  function removeProfile(state, lang, profile) {
    if (!confirmFn(t('confirm.deleteProfile', lang))) return;
    if (editingId === profile.id) closeForm(state, lang);
    commit((draft) => {
      draft.profiles = draft.profiles.filter((item) => item.id !== profile.id);
      if (draft.settings.activeProfileId === profile.id) {
        draft.settings.activeProfileId = draft.profiles[0]?.id ?? null;
      }
    });
  }

  /**
   * Fills the form from a pasted proxy URL. Returns false when the text is not
   * recognisable, so the caller can let the normal paste happen.
   */
  function applyPastedProxy(text, state, lang) {
    const parsed = parseProxyUrl(text);
    if (!parsed) return false;

    if (parsed.scheme) fields.scheme.value = parsed.scheme;
    fields.host.value = parsed.host;
    if (parsed.port) fields.port.value = parsed.port;
    // Credentials are only replaced when the pasted URL actually carries them.
    if (parsed.username) fields.username.value = parsed.username;
    if (parsed.password) fields.password.value = parsed.password;

    errorKey = null;
    renderForm(state, lang);
    return true;
  }

  // `socks5://user:pass@127.0.0.1:1080` and `127.0.0.1:8080` are both handled;
  // a plain hostname keeps the ordinary paste behaviour.
  fields.host?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[@:/]/.test(text)) return;
    if (!applyPastedProxy(text, getState(), getLang())) return;
    event.preventDefault();
  });

  addBtn?.addEventListener('click', () => openForm(getState(), getLang()));
  cancelBtn?.addEventListener('click', () => closeForm(getState(), getLang()));

  formEl?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = getState();
    const draft = {
      name: fields.name.value,
      scheme: fields.scheme.value,
      host: fields.host.value,
      port: fields.port.value,
      username: fields.username.value,
      password: fields.password.value,
    };
    const result = validateProfile(draft, { profiles: state.profiles, editingId });
    if (!result.ok) {
      errorKey = result.errors[Object.keys(result.errors)[0]];
      renderForm(state, getLang());
      return;
    }
    errorKey = null;
    // The profile id is stable, so the active selection survives an edit.
    await commit((nextState) => {
      if (editingId) {
        nextState.profiles = nextState.profiles.map((item) =>
          item.id === editingId ? result.profile : item,
        );
      } else {
        nextState.profiles = [...nextState.profiles, result.profile];
        if (!nextState.settings.activeProfileId) nextState.settings.activeProfileId = result.profile.id;
      }
    });
    closeForm(getState(), getLang());
  });

  return {
    render,
    openForm,
    closeForm,
    get editingId() {
      return editingId;
    },
  };
}

function iconButton(glyph, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}
