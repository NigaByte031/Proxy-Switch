/**
 * Turns extension state into a `chrome.proxy` configuration and describes it
 * for the UI. `buildProxyConfig`/`describeStatus` are pure (and tested);
 * `applyProxy` is the only function that talks to Chrome.
 */

import { effectiveMode, findProfile, missingRequirement } from './model.js';

export const SCOPE = 'regular';

/**
 * @param {object} state
 * @returns {object} a chrome.proxy ProxyConfig value
 */
export function buildProxyConfig(state) {
  const mode = effectiveMode(state);
  const bypassList = Array.isArray(state?.settings?.bypassList)
    ? [...state.settings.bypassList]
    : [];

  switch (mode) {
    case 'direct':
      return { mode: 'direct' };

    case 'fixed_servers': {
      const profile = findProfile(state, state.settings.activeProfileId);
      // No server yet: fail open (direct) instead of breaking the browser.
      if (!profile) return { mode: 'direct' };
      return {
        mode: 'fixed_servers',
        rules: {
          singleProxy: {
            scheme: profile.scheme,
            host: profile.host,
            port: Number(profile.port),
          },
          bypassList,
        },
      };
    }

    case 'pac_script': {
      const url = String(state.settings.pacUrl ?? '').trim();
      if (!url) return { mode: 'direct' };
      return { mode: 'pac_script', pacScript: { url, mandatory: false } };
    }

    case 'system':
    default:
      return { mode: 'system' };
  }
}

/**
 * What the toolbar icon shows: the four characters plus a tone the caller turns
 * into a colour. Shared with the popup so the badge and the "state pill" in the
 * status card can never disagree.
 * @returns {{text: 'SYS'|'ON'|'PAC'|'OFF', tone: 'system'|'manual'|'pac'|'off'}}
 */
export function describeBadge(state) {
  if (!state?.settings?.enabled) return { text: 'OFF', tone: 'off' };

  switch (state.settings.mode) {
    case 'fixed_servers':
      return { text: 'ON', tone: 'manual' };
    case 'pac_script':
      return { text: 'PAC', tone: 'pac' };
    case 'direct':
      return { text: 'OFF', tone: 'off' };
    case 'system':
    default:
      return { text: 'SYS', tone: 'system' };
  }
}

/**
 * Status card content. Returns i18n keys + params instead of translated text so
 * that the caller (and the tests) can translate for any language.
 * @returns {{tone: 'ok'|'idle'|'warn', title: {key: string, params?: object}, detail: {key: string, params?: object}}}
 */
export function describeStatus(state) {
  const missing = missingRequirement(state);

  if (!state.settings.enabled) {
    return {
      tone: 'idle',
      title: { key: 'status.off.title' },
      detail: { key: 'status.off.detail' },
    };
  }

  if (missing === 'profile') {
    return {
      tone: 'warn',
      title: { key: 'status.warnProfile.title' },
      detail: { key: 'status.warnProfile.detail' },
    };
  }

  if (missing === 'pac') {
    return {
      tone: 'warn',
      title: { key: 'status.warnPac.title' },
      detail: { key: 'status.warnPac.detail' },
    };
  }

  const mode = effectiveMode(state);

  if (mode === 'fixed_servers') {
    const profile = findProfile(state, state.settings.activeProfileId);
    return {
      tone: 'ok',
      title: { key: 'status.manual.title' },
      detail: {
        key: 'status.manual.detail',
        params: {
          name: profile.name,
          scheme: profile.scheme,
          host: profile.host,
          port: profile.port,
        },
      },
    };
  }

  if (mode === 'pac_script') {
    return {
      tone: 'ok',
      title: { key: 'status.pac.title' },
      detail: { key: 'status.pac.detail', params: { url: String(state.settings.pacUrl).trim() } },
    };
  }

  if (mode === 'direct') {
    return {
      tone: 'ok',
      title: { key: 'status.direct.title' },
      detail: { key: 'status.direct.detail' },
    };
  }

  return {
    tone: 'ok',
    title: { key: 'status.system.title' },
    detail: { key: 'status.system.detail' },
  };
}

/**
 * Pushes the current state to the browser proxy settings.
 * A no-op outside the extension (offline preview, Node tests).
 */
export async function applyProxy(state) {
  const settings = typeof chrome !== 'undefined' ? chrome.proxy?.settings : null;
  if (!settings?.set) return { applied: false, config: buildProxyConfig(state) };
  const config = buildProxyConfig(state);
  await settings.set({ value: config, scope: SCOPE });
  return { applied: true, config };
}

/** Reads back what the browser actually has configured (debugging / UI hint). */
export async function readAppliedConfig() {
  const settings = typeof chrome !== 'undefined' ? chrome.proxy?.settings : null;
  if (!settings?.get) return null;
  const result = await settings.get({});
  return result?.value ?? null;
}
