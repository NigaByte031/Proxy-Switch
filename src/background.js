/**
 * MV3 service worker — the only place that talks to chrome.proxy.
 *
 * It watches the stored state and re-applies everything whenever the state
 * changes, which means the popup and the settings page stay dumb writers and
 * there is exactly one implementation of "apply the proxy".
 */

import { findProfile } from './lib/model.js';
import { ensureState, loadState, saveState, subscribe } from './lib/storage.js';
import { applyProxy, describeBadge } from './lib/proxy.js';
import { resolveLang, t } from './lib/i18n.js';

const BADGE_COLORS = {
  off: '#6b7280',
  system: '#6b7280',
  manual: '#4f46e5',
  pac: '#0d9488',
  error: '#dc2626',
};

/** Applies state to the browser: proxy config, badge and context menus. */
async function sync() {
  const state = await loadState();
  try {
    await applyProxy(state);
  } catch (error) {
    await showError(error);
  }
  await updateBadge(state);
  await rebuildMenus(state);
  return state;
}

async function showError(error) {
  console.error('[proxy-switch] could not apply the proxy settings', error);
  try {
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.error });
    await chrome.action.setTitle({ title: `Proxy Switch — ${String(error?.message ?? error)}` });
  } catch {
    /* the action API is unavailable (e.g. in a test/preview context) */
  }
}

async function updateBadge(state) {
  if (!chrome.action) return;
  const badge = describeBadge(state);
  const lang = resolveLang(state.settings.language, typeof navigator !== 'undefined' ? navigator.language : 'en');
  const profile = findProfile(state, state.settings.activeProfileId);
  const title = profile ? `Proxy Switch — ${profile.name}` : t('app.name', lang);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[badge.tone] ?? BADGE_COLORS.system });
  await chrome.action.setTitle({ title });
}

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

const MENU_ROOT = 'proxy-switch';

async function rebuildMenus(state) {
  if (!chrome.contextMenus) return;
  const lang = resolveLang(state.settings.language, typeof navigator !== 'undefined' ? navigator.language : 'en');
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: t('menu.root', lang),
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: `${MENU_ROOT}:system`,
    parentId: MENU_ROOT,
    title: t('menu.system', lang),
    type: 'radio',
    checked: state.settings.enabled && state.settings.mode === 'system',
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: `${MENU_ROOT}:direct`,
    parentId: MENU_ROOT,
    title: t('menu.direct', lang),
    type: 'radio',
    checked: !state.settings.enabled || state.settings.mode === 'direct',
    contexts: ['action'],
  });

  for (const profile of state.profiles.slice(0, 10)) {
    chrome.contextMenus.create({
      id: `${MENU_ROOT}:profile:${profile.id}`,
      parentId: MENU_ROOT,
      title: profile.name,
      type: 'radio',
      checked:
        state.settings.enabled &&
        state.settings.mode === 'fixed_servers' &&
        state.settings.activeProfileId === profile.id,
      contexts: ['action'],
    });
  }

  chrome.contextMenus.create({
    id: `${MENU_ROOT}:settings`,
    parentId: MENU_ROOT,
    title: t('menu.settings', lang),
    contexts: ['action'],
  });
}

chrome.contextMenus?.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_ROOT)) return;

  if (id === `${MENU_ROOT}:settings`) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  const state = await loadState();
  const draft = structuredClone(state);

  if (id === `${MENU_ROOT}:system`) {
    draft.settings.mode = 'system';
    draft.settings.enabled = true;
  } else if (id === `${MENU_ROOT}:direct`) {
    draft.settings.mode = 'direct';
    draft.settings.enabled = true;
  } else if (id.startsWith(`${MENU_ROOT}:profile:`)) {
    const profileId = id.slice(`${MENU_ROOT}:profile:`.length);
    if (!draft.profiles.some((profile) => profile.id === profileId)) return;
    draft.settings.activeProfileId = profileId;
    draft.settings.mode = 'fixed_servers';
    draft.settings.enabled = true;
  } else {
    return;
  }

  await saveState(draft);
});

/* ------------------------------------------------------------------ *
 * Proxy authentication
 * ------------------------------------------------------------------ */

function normalizeHost(host) {
  return String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
}

async function answerAuthChallenge(details) {
  if (!details.isProxy) return {};
  const state = await loadState();
  if (!state.settings.autoAuth) return {};

  const profile = findProfile(state, state.settings.activeProfileId);
  if (!profile?.username) return {};

  // Only answer for the server we are actually configured to use.
  const challenger = normalizeHost(details.challenger?.host);
  if (challenger && challenger !== normalizeHost(profile.host)) return {};

  return { authCredentials: { username: profile.username, password: profile.password || '' } };
}

chrome.webRequest?.onAuthRequired.addListener(
  (details, callback) => {
    answerAuthChallenge(details)
      .then((result) => callback(result))
      .catch((error) => {
        console.warn('[proxy-switch] auth handling failed', error);
        callback({});
      });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

chrome.proxy?.onProxyError?.addListener((details) => {
  showError(details?.error ? new Error(details.error) : new Error('proxy error'));
});

/* ------------------------------------------------------------------ *
 * Keyboard shortcuts (chrome://extensions/shortcuts)
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-proxy' && command !== 'go-direct') return;
  const state = await loadState();
  const draft = structuredClone(state);

  if (command === 'toggle-proxy') {
    draft.settings.enabled = !draft.settings.enabled;
  } else {
    draft.settings.enabled = true;
    draft.settings.mode = 'direct';
  }

  await saveState(draft);
});

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureState();
  await sync();
  if (reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') });
  }
});

chrome.runtime.onStartup.addListener(() => sync());

// Any write from the popup or the settings page lands here.
subscribe(() => {
  sync();
});

// Also runs whenever the worker is woken up, which keeps the applied settings
// in sync even if something changed while the worker was asleep.
sync();
