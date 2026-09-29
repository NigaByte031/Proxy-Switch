/**
 * Turns extension state into a `chrome.proxy` configuration and describes it for
 * the UI. Everything except `applyProxy`/`readProxySettings` is pure.
 */

import { effectiveMode, findProfile, missingRequirement, routingChain } from './model.js';
import { PROBE_TARGETS, probeHost } from './health.js';
import { buildPacScript, proxyDirective } from './pac.js';
import { orderServersByHealth } from './server-health.js';

export const SCOPE = 'regular';

/**
 * @param {object} state
 * @param {object|null} [health] last known verdicts per server (`lib/server-health.js`),
 *        which decide the order of the generated PAC chain
 * @returns {object} a chrome.proxy ProxyConfig value
 */
export function buildProxyConfig(state, health = null) {
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
      // A generated script wins over the URL while domain routing is on.
      if (state.settings.domainRouting) {
        // Proven first, unknown next, proven-bad last — see `orderServersByHealth`.
        const servers = orderServersByHealth(routingChain(state), health);
        const data = buildPacScript({
          servers,
          domains: state.settings.proxyDomains ?? [],
          bypass: bypassList,
        });
        // No server, or nothing to route: fail open like every other mode.
        if (!data) return { mode: 'direct' };
        // `mandatory`: a script that Chrome fails to parse must not quietly turn
        // into a direct connection for the very hosts the list was written for.
        return { mode: 'pac_script', pacScript: { data, mandatory: true } };
      }

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
 * The configuration a background check installs while it looks at one server
 * (`lib/server-probe.js`).
 *
 * It is the user's own policy — the chain for the listed domains, or everything
 * through the active server in manual mode — with exactly one difference: the
 * extension's own probe requests are handed to `target`. Nothing else moves, so a
 * check can neither break a page nor send traffic somewhere it was not going.
 *
 * @param {object} state
 * @param {object} target the saved server to check
 * @param {object|null} [health] the verdicts the real chain is ordered by
 * @returns {object|null} a chrome.proxy ProxyConfig, or null when this mode has
 *          no routing worth preserving (the check then stays out of the way)
 */
export function buildProbeConfig(state, target, health = null) {
  if (!target?.host) return null;

  const bypass = Array.isArray(state?.settings?.bypassList) ? [...state.settings.bypassList] : [];
  const override = { hosts: PROBE_TARGETS.map(probeHost), directive: proxyDirective(target) };
  const mode = effectiveMode(state);

  if (mode === 'fixed_servers') {
    const active = findProfile(state, state.settings.activeProfileId);
    if (!active) return null;
    // Manual mode sends everything through the active server, i.e. base 'all'.
    const data = buildPacScript({ servers: [active], base: 'all', bypass, override });
    return data ? { mode: 'pac_script', pacScript: { data, mandatory: true } } : null;
  }

  if (mode === 'pac_script' && state.settings.domainRouting === true) {
    const data = buildPacScript({
      servers: orderServersByHealth(routingChain(state), health),
      domains: state.settings.proxyDomains ?? [],
      bypass,
      override,
    });
    return data ? { mode: 'pac_script', pacScript: { data, mandatory: true } } : null;
  }

  // System and direct mode have no policy of ours to keep.
  return null;
}

/**
 * What the toolbar icon shows: the four characters plus a tone the caller turns
 * into a colour. Shared with the popup, so the badge and the "state pill" in the
 * status card can never disagree.
 *
 * @param {object} state
 * @param {{tone: string}|null} problem an apply problem from `describeApplyProblem`
 * @returns {{text: 'SYS'|'ON'|'PAC'|'OFF'|'ERR', tone: 'system'|'manual'|'pac'|'off'|'error'}}
 */
export function describeBadge(state, problem = null) {
  // A failed apply must never hide behind a reassuring mode name.
  if (problem) return { text: 'ERR', tone: 'error' };

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

/** How long the badge keeps showing the server an automatic switch landed on. */
export const SWITCH_FLASH_MS = 8000;

/**
 * The label the badge wears while a switch is news: the first letters of the
 * server name — `ON` says a proxy is in force, never *which* server is. The hover
 * title carries the full name.
 *
 * @param {{name?: string}|null} profile the server that took over
 * @returns {{text: string, tone: 'manual'}}
 */
export function describeSwitchBadge(profile) {
  const label = String(profile?.name ?? '')
    .replace(/\s+/g, '')
    .slice(0, 4)
    .toUpperCase();
  return { text: label || '→', tone: 'manual' };
}

/**
 * Whether an armed badge flash still belongs on the icon. Two things end it: its
 * own expiry (a worker terminated before its timer fired must not leave the
 * badge lying), and the user picking a server by hand — newer news.
 *
 * @param {{badge: object, profileId: string, until: number}|null} flash
 * @param {object} state
 * @param {number} [now]
 * @returns {{text: string, tone: string}|null}
 */
export function activeSwitchFlash(flash, state, now = Date.now()) {
  if (!flash?.badge || !Number.isFinite(flash.until) || flash.until <= now) return null;
  const profile = findProfile(state, state?.settings?.activeProfileId);
  if (!profile || profile.id !== flash.profileId) return null;
  return flash.badge;
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

  if (missing === 'domains') {
    return {
      tone: 'warn',
      title: { key: 'status.warnDomains.title' },
      detail: { key: 'status.warnDomains.detail' },
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
    if (state.settings.domainRouting) {
      const profile = findProfile(state, state.settings.activeProfileId);
      return {
        tone: 'ok',
        title: { key: 'status.pacDomains.title' },
        detail: {
          key: 'status.pacDomains.detail',
          params: { name: profile.name, count: (state.settings.proxyDomains ?? []).length },
        },
      };
    }
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

/* Applying — and knowing whether it stuck. */

function proxySettings() {
  return typeof chrome !== 'undefined' ? chrome.proxy?.settings : null;
}

/**
 * `chrome.proxy.settings.set` resolves even when it did not take effect — another
 * extension, or a policy, may own the proxy settings. These `levelOfControl`
 * values mean "what we asked for is in force".
 */
const OURS = new Set(['controllable_by_this_extension', 'controlled_by_this_extension']);

/** Unknown (older Chrome, preview, tests) counts as ours rather than as a problem. */
export function isOwnedByUs(levelOfControl) {
  return levelOfControl == null || OURS.has(String(levelOfControl));
}

/** A short, storable reason for a failed apply. */
export function applyFailureReason(error) {
  const message = String(error?.message ?? error ?? '').trim();
  return message || 'unknown error';
}

/**
 * Turns an apply attempt into something the UI can show, or null when everything
 * is in order.
 *
 * @param {{failed?: string|null, levelOfControl?: string|null}|null} outcome
 * @returns {{tone: 'warn', title: {key: string, params?: object}, detail: {key: string, params?: object}}|null}
 */
export function describeApplyProblem(outcome = null) {
  // Nothing was applied yet (a fresh profile, or the status was cleared).
  if (!outcome || typeof outcome !== 'object') return null;
  const { failed = null, levelOfControl = null } = outcome;

  if (failed) {
    return {
      tone: 'warn',
      title: { key: 'status.applyFailed.title' },
      detail: { key: 'status.applyFailed.detail', params: { reason: String(failed) } },
    };
  }

  if (!isOwnedByUs(levelOfControl)) {
    return {
      tone: 'warn',
      title: { key: 'status.notInControl.title' },
      detail: { key: 'status.notInControl.detail', params: { level: String(levelOfControl) } },
    };
  }

  return null;
}

/**
 * Pushes the current state to the browser proxy settings.
 * A no-op outside the extension (offline preview, Node tests).
 *
 * @param {object} state
 * @param {object|null} [health] per-server verdicts, so the generated chain is
 *        ordered by what the extension last proved about each server
 * @returns {Promise<{applied: boolean, config: object, levelOfControl: string|null}>}
 */
export async function applyProxy(state, health = null) {
  const config = buildProxyConfig(state, health);
  const outcome = await applyProxyConfig(config);
  return { ...outcome, config };
}

/**
 * Applies an already-built config and reads back what the browser thinks
 * happened, so a silent no-op is noticed. `applyProxy` is this plus building the
 * config from the state; a background check uses it for its own window.
 */
export async function applyProxyConfig(config) {
  const settings = proxySettings();
  if (!settings?.set || !config) return { applied: false, levelOfControl: null };

  await settings.set({ value: config, scope: SCOPE });

  const current = await readProxySettings();
  return { applied: true, levelOfControl: current?.levelOfControl ?? null };
}

/**
 * Whether the configuration the browser reports is the one that was handed to
 * it. A background check believes its own result only under this condition: if
 * something else applied a configuration in the meantime, the probe measured
 * that route and says nothing about the server it was checking.
 *
 * @param {object|null} current the result of `readProxySettings()`
 * @param {object|null} config the config that was applied
 */
export function isConfigApplied(current, config) {
  const value = current?.value;
  if (!value || !config || value.mode !== config.mode) return false;
  if (config.mode !== 'pac_script') return true;
  return (
    value.pacScript?.data === config.pacScript?.data &&
    Boolean(value.pacScript?.mandatory) === Boolean(config.pacScript?.mandatory)
  );
}

/**
 * Message the settings page sends to ask for another apply attempt. Only the
 * worker may touch `chrome.proxy` (the project's single-writer rule), so a retry
 * is a message and not a call.
 */
export const REAPPLY_MESSAGE = 'proxy-switch:reapply';

/**
 * Asks the service worker to apply the stored state again.
 *
 * @returns {Promise<object|null>} the fresh apply status, or null when nobody
 *          answered (no worker, or the offline preview) — the caller then keeps
 *          whatever status it already had.
 */
export async function requestReapply() {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
  if (!runtime?.sendMessage) return null;
  try {
    const answer = await runtime.sendMessage({ type: REAPPLY_MESSAGE });
    return answer?.status ?? null;
  } catch {
    // The worker may be reloading; that is a failed retry, not a crash.
    return null;
  }
}

/** Reads back what the browser has configured: value *and* who controls it. */
export async function readProxySettings() {
  const settings = proxySettings();
  if (!settings?.get) return null;
  try {
    return (await settings.get({})) ?? null;
  } catch {
    return null;
  }
}
