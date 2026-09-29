/**
 * Shared "servers" UI: the search box, the profile list and the add/edit form, used
 * by both the popup and the settings page. A row also says what the extension has
 * seen about that server (`lib/server-health.js`), when it has looked at all.
 *
 * Deleting is confirmed *in the row* rather than with `window.confirm` (a native
 * dialog freezes the whole popup and is dismissed by clicking outside it), and Escape
 * unwinds in the order the user expects: pending delete, open form, search box.
 */

import {
  filterProfiles,
  formatProfileAddress,
  parseProxyUrl,
  shouldShowSearch,
  uniqueProfileName,
  validateProfile,
} from './model.js';
import { describeServerVerdict } from './server-health.js';
import { t } from './i18n.js';

/**
 * How often the age of a verdict is re-read while a list is on screen. Ages are
 * spoken in minutes, so anything faster would only repaint the same words.
 */
const HEALTH_TICK_MS = 60_000;

/**
 * @param {object} options
 * @param {() => object} options.getState  current state (for duplicate-name checks)
 * @param {() => string} options.getLang
 * @param {(mutator: (draft: object) => void) => Promise<unknown>} options.commit  persists a change
 * @param {(() => object|null)|null} [options.getHealth] what the extension has
 *        seen about each server (`lib/server-health.js`), so a row can say it
 */
export function createServersUi({
  listEl,
  emptyEl,
  noMatchEl,
  searchEl,
  searchInput,
  searchClear,
  formEl,
  addBtn,
  getState,
  getLang,
  commit,
  getHealth = null,
}) {
  /** id of the profile currently open in the form, null = creating a new one */
  let editingId = null;
  /** i18n key of the message shown under the form */
  let errorKey = null;
  /** contents of the search box; '' means "no filter" */
  let query = '';
  /** id of the row waiting for a delete confirmation, null when none is */
  let pendingDeleteId = null;

  const fields = formEl?.elements ?? {};
  const titleEl = formEl?.querySelector('#formTitle');
  const errorEl = formEl?.querySelector('#formError');
  const cancelBtn = formEl?.querySelector('#formCancel');

  /* Small DOM helpers. */

  /** Finds a rendered row by profile id — no id is ever pasted into a selector. */
  function rowFor(id) {
    if (!listEl || !id) return null;
    for (const item of listEl.querySelectorAll('.profile-item')) {
      if (item.dataset.id === id) return item;
    }
    return null;
  }

  /**
   * One server's last verdict, said as the row says it: the state, then how old
   * it is. The dot carries the tone (styles/base.css), the words the meaning, so
   * it reads the same without colour.
   */
  function healthBadge(health, lang) {
    const badge = document.createElement('span');
    badge.className = 'profile-health';
    badge.dataset.tone = health.current ? health.tone : 'stale';
    badge.textContent = verdictText(health, lang);
    badge.title = badge.textContent;
    return badge;
  }

  /** `answered in 42 ms · 3 min ago`, in whichever language is on. */
  function verdictText(health, lang) {
    return `${t(health.state.key, lang, health.state.params)} · ${t(
      health.age.key,
      lang,
      health.age.params,
    )}`;
  }

  function iconButton(glyph, label, role, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.textContent = glyph;
    button.title = label;
    button.dataset.role = role;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  function actionButton(label, className, role, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.dataset.role = role;
    button.addEventListener('click', onClick);
    return button;
  }

  /* The list. */

  function buildRow(profile, state, lang) {
    const active =
      state.settings.enabled &&
      state.settings.mode === 'fixed_servers' &&
      state.settings.activeProfileId === profile.id;

    const item = document.createElement('li');
    item.className = 'profile-item';
    if (active) item.classList.add('is-active');
    item.dataset.id = profile.id;
    // Drawn as the little scheme badge in front of the row (styles/base.css).
    item.dataset.scheme = String(profile.scheme).toUpperCase();

    if (pendingDeleteId === profile.id) {
      item.classList.add('is-confirming');
      const bar = document.createElement('div');
      bar.className = 'profile-confirm';

      const text = document.createElement('p');
      text.className = 'profile-confirm-text';
      // The name is repeated inside the question, so the row says what it removes.
      text.textContent = t('profiles.confirmDelete', lang, { name: profile.name });
      text.title = profile.name;

      bar.append(
        text,
        actionButton(t('btn.cancel', lang), 'ghost-btn', 'cancel-delete', () => cancelDelete()),
        actionButton(t('profiles.deleteAction', lang), 'btn danger', 'confirm-delete', () =>
          removeProfile(profile),
        ),
      );
      item.append(bar);
      return item;
    }

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

    // "Never looked at" is not a thing to say, it is the absence of one.
    const health = describeServerVerdict(getHealth?.() ?? null, profile.id);
    if (health) main.append(healthBadge(health, lang));

    main.addEventListener('click', () => {
      commit((draft) => {
        draft.settings.activeProfileId = profile.id;
        draft.settings.mode = 'fixed_servers';
        draft.settings.enabled = true;
      });
    });

    const edit = iconButton('✎', t('profiles.editAction', lang), 'edit', () =>
      openForm(state, lang, profile),
    );
    const remove = iconButton('✕', t('profiles.deleteAction', lang), 'delete', () =>
      askDelete(profile),
    );
    remove.classList.add('danger');

    item.append(main, edit, remove);
    return item;
  }

  function renderList(state, lang) {
    if (!listEl) return;

    const searching = shouldShowSearch(state.profiles.length, query);
    searchEl?.classList.toggle('hidden', !searching);
    if (searchInput) {
      if (document.activeElement !== searchInput && searchInput.value !== query) {
        searchInput.value = query;
      }
      searchInput.setAttribute('aria-label', t('profiles.search', lang));
      searchInput.title = t('profiles.searchHint', lang);
    }
    searchClear?.classList.toggle('hidden', query.trim() === '');

    const visible = filterProfiles(state.profiles, query);

    listEl.textContent = '';
    emptyEl?.classList.toggle('hidden', state.profiles.length > 0);

    const noMatch = state.profiles.length > 0 && visible.length === 0;
    if (noMatchEl) {
      noMatchEl.textContent = noMatch ? t('profiles.noMatch', lang, { query: query.trim() }) : '';
      noMatchEl.classList.toggle('hidden', !noMatch);
    }

    for (const profile of visible) listEl.append(buildRow(profile, state, lang));
  }

  /**
   * Re-reads the verdicts already on screen. Only the words change — the rows
   * themselves are left alone, so a row being clicked, or a delete question
   * waiting for an answer, is never pulled out from under the user.
   */
  function refreshHealth() {
    if (!listEl) return;
    const health = getHealth?.() ?? null;
    const lang = getLang();

    for (const item of listEl.querySelectorAll('.profile-item')) {
      const badge = item.querySelector?.('.profile-health');
      if (!badge) continue;
      const verdict = describeServerVerdict(health, item.dataset.id);
      if (!verdict) {
        badge.remove?.();
        continue;
      }
      const text = verdictText(verdict, lang);
      if (badge.textContent !== text) {
        badge.textContent = text;
        badge.title = text;
      }
      badge.dataset.tone = verdict.current ? verdict.tone : 'stale';
    }
  }

  // A list can stay on screen for a long time, so the ages are kept honest on a
  // timer of their own.
  const healthTimer = setInterval(refreshHealth, HEALTH_TICK_MS);
  // Node (the tests) keeps its event loop alive for a live interval.
  healthTimer?.unref?.();

  /* Searching. */

  function setQuery(next) {
    query = String(next ?? '');
    // Typing is a change of mind: drop a half-asked delete question.
    pendingDeleteId = null;
    if (searchInput && searchInput.value !== query) searchInput.value = query;
    renderList(getState(), getLang());
  }

  /** @returns {boolean} whether the search box was there to be focused */
  function focusSearch() {
    if (!searchInput || searchEl?.classList.contains('hidden')) return false;
    searchInput.focus?.();
    searchInput.select?.();
    return true;
  }

  searchInput?.addEventListener('input', () => setQuery(searchInput.value));
  searchInput?.addEventListener('search', () => setQuery(searchInput.value));

  searchClear?.addEventListener('click', () => {
    setQuery('');
    focusSearch();
  });

  /* Deleting (confirmed inside the row). */

  function askDelete(profile) {
    pendingDeleteId = profile.id;
    renderList(getState(), getLang());
    rowFor(profile.id)?.querySelector('[data-role="confirm-delete"]')?.focus?.();
  }

  function cancelDelete() {
    const id = pendingDeleteId;
    pendingDeleteId = null;
    renderList(getState(), getLang());
    rowFor(id)?.querySelector('[data-role="delete"]')?.focus?.();
  }

  function removeProfile(profile) {
    const state = getState();
    const lang = getLang();
    pendingDeleteId = null;
    if (editingId === profile.id) closeForm(state, lang);
    commit((draft) => {
      draft.profiles = draft.profiles.filter((item) => item.id !== profile.id);
      if (draft.settings.activeProfileId === profile.id) {
        draft.settings.activeProfileId = draft.profiles[0]?.id ?? null;
      }
    });
  }

  /* The add / edit form. */

  function renderForm(state, lang) {
    if (!formEl) return;
    const open = !formEl.classList.contains('hidden');
    if (titleEl) titleEl.textContent = t(editingId ? 'profiles.edit' : 'profiles.new', lang);
    if (errorEl) {
      errorEl.textContent = errorKey ? t(errorKey, lang) : '';
      errorEl.classList.toggle('hidden', !errorKey);
    }
    if (addBtn) addBtn.setAttribute('aria-expanded', String(open));
  }

  function render(state, lang) {
    renderList(state, lang);
    renderForm(state, lang);
  }

  function openForm(state, lang, profile = null) {
    if (!formEl) return;
    pendingDeleteId = null;
    editingId = profile?.id ?? null;
    errorKey = null;
    fields.name.value = profile?.name ?? uniqueProfileName(state.profiles, t('profiles.new', lang));
    fields.scheme.value = profile?.scheme ?? 'http';
    fields.host.value = profile?.host ?? '';
    fields.port.value = profile ? String(profile.port) : '';
    fields.username.value = profile?.username ?? '';
    fields.password.value = profile?.password ?? '';
    formEl.classList.remove('hidden');
    renderForm(state, lang);
    formEl.scrollIntoView?.({ block: 'nearest' });
    fields.name.focus?.();
    fields.name.select?.();
  }

  function closeForm(state, lang) {
    if (!formEl || formEl.classList.contains('hidden')) return;
    editingId = null;
    errorKey = null;
    formEl.classList.add('hidden');
    formEl.reset?.();
    renderForm(state, lang);
    // Back to the button that opened it, so the keyboard user is not dropped here.
    addBtn?.focus?.();
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

  addBtn?.addEventListener('click', () => {
    // Clicking again while a form is open starts over, which beats a dead button.
    openForm(getState(), getLang());
  });
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

  /* Keyboard shortcuts — registered once, in the order the user expects. */

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const state = getState();
    const lang = getLang();

    // Cmd/Ctrl+Enter saves the form from anywhere inside it.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && formEl?.contains(event.target)) {
      event.preventDefault();
      formEl.requestSubmit?.();
      return;
    }

    // "/" jumps to the search box; it stays plain text inside a form control.
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!focusSearch()) return;
      event.preventDefault();
      return;
    }

    if (event.key !== 'Escape') return;

    if (pendingDeleteId) {
      event.preventDefault();
      cancelDelete();
      return;
    }
    if (formEl && !formEl.classList.contains('hidden')) {
      event.preventDefault();
      closeForm(state, lang);
      return;
    }
    if (query) {
      event.preventDefault();
      setQuery('');
    }
  });

  return {
    render,
    refreshHealth,
    openForm,
    closeForm,
    focusSearch,
    setQuery,
    get editingId() {
      return editingId;
    },
    get query() {
      return query;
    },
    get pendingDeleteId() {
      return pendingDeleteId;
    },
  };
}
