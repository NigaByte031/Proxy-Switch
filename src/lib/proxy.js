/**
 * Turns extension state into a `chrome.proxy` configuration and describes it for
 * the UI. Everything except `applyProxy`/`readProxySettings` is pure.
 */

import {
  chainForProfile,
  domainServerOf,
  effectiveMode,
  findProfile,
  missingRequirement,
  routingChain,
  sanitizeDomainRules,
} from './model.js';
import { PROBE_TARGETS, probeHost } from './health.js';
import { buildPacScript, proxyChain, proxyDirective } from './pac.js';
import { orderServersByHealth } from './server-health.js';

export const SCOPE = 'regular';

/**
 * The address a fail-closed configuration points at. Nothing listens on port 1 of
 * the loopback interface, so every request is refused instead of quietly leaving
 * the machine without a proxy.
 */
export const BLOCKED_PROXY = { scheme: 'http', host: '127.0.0.1', port: 1 };

/**
 * What the browser is told when the route the current mode promises cannot be
 * built: no server saved, no PAC script. Failing open (direct) is what shipped;
 * `failClosed` asks for the other answer — a refused request instead of
 * unwatched traffic. A route the user *chose* is never touched by this.
 */
export function fallbackConfig(state) {
  if (state?.settings?.failClosed !== true) return { mode: 'direct' };
  return {
    mode: 'fixed_servers',
    // No bypass list: every host, the bypassed ones included, meets the same dead
    // end. A bypass here would be the leak the setting exists to prevent.
    rules: { singleProxy: { ...BLOCKED_PROXY }, bypassList: [] },
  };
}

/**
 * The chain one listed rule uses: the rule's own server heads a chain of that
 * server plus the rest, ordered by what the extension last proved about each one,
 * and a rule with no server — or one whose server is gone — falls back to the
 * shared chain. `chain` is what the site is really tried against; `directive` is
 * empty for a rule that falls back, which is how the script spells "use the shared
 * chain" (`lib/route-explain.js` explains both cases).
 *
 * @returns {{chain: object[], own: boolean, profileId: string|null, directive: string}}
 */
export function ruleChain(state, rule, health = null) {
  const profileId = domainServerOf(state?.settings, rule);
  const named = chainForProfile(state, profileId);
  // The named server is the whole point of the rule, so a verdict about somebody
  // else never demotes it: only the servers *behind* it are ordered by health,
  // exactly as the shared chain is. A named server that is down is still tried
  // first and the chain falls through, which is what "tried first" has to mean.
  const own =
    named.length > 0 ? [named[0], ...orderServersByHealth(named.slice(1), health)] : [];
  const chain = own.length > 0 ? own : orderServersByHealth(routingChain(state), health);
  return {
    chain,
    own: own.length > 0,
    profileId,
    directive: own.length > 0 ? proxyChain(own) : '',
  };
}

/**
 * The three inputs the generated script is built from: the shared chain, the rules
 * that use it, and the rules that named a server of their own. A rule with its own
 * server heads a chain of that server plus the rest, ordered by what the extension
 * last proved about each one — the same never-goes-direct promise the shared chain
 * makes, just starting somewhere else. Rules pointing at the same server share one
 * directive, so the script carries one entry each rather than one per rule.
 *
 * @param {object} state
 * @param {object|null} [health] per-server verdicts (`lib/server-health.js`)
 * @returns {{servers: object[], domains: string[], routes: Array<{directive: string, hosts: string[]}>}}
 */
export function pacRouting(state, health = null) {
  const servers = orderServersByHealth(routingChain(state), health);
  const domains = [];
  const byDirective = new Map();

  for (const rule of sanitizeDomainRules(state?.settings?.proxyDomains ?? [])) {
    const { directive } = ruleChain(state, rule, health);

    // No usable server named, or a chain that builds nothing: the rule falls back
    // to the shared chain instead of disappearing.
    if (!directive) {
      domains.push(rule);
      continue;
    }
    const hosts = byDirective.get(directive);
    if (hosts) hosts.push(rule);
    else byDirective.set(directive, [rule]);
  }

  return {
    servers,
    domains,
    routes: [...byDirective].map(([directive, hosts]) => ({ directive, hosts })),
  };
}

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
      // No server yet: fail open (direct) by default, or closed when asked.
      if (!profile) return fallbackConfig(state);
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
        const data = buildPacScript({ ...pacRouting(state, health), bypass: bypassList });
        // No server, or nothing to route: the same fallback as every other mode.
        if (!data) return fallbackConfig(state);
        // `mandatory`: a script that Chrome fails to parse must not quietly turn
        // into a direct connection for the very hosts the list was written for.
        return { mode: 'pac_script', pacScript: { data, mandatory: true } };
      }

      const url = String(state.settings.pacUrl ?? '').trim();
      // A PAC mode with no script is a route that cannot be built, exactly like a
      // manual mode with no server.
      if (!url) return fallbackConfig(state);
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
    const data = buildPacScript({ ...pacRouting(state, health), bypass, override });
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
  const { source = null, failed = null, levelOfControl = null } = outcome;

  if (failed) {
    // A route that stopped answering is not a change Chrome refused: saying so
    // would send the user looking for a permissions problem that is not there.
    const route = source === 'route';
    return {
      tone: 'warn',
      title: { key: route ? 'status.routeFailed.title' : 'status.applyFailed.title' },
      detail: {
        key: route ? 'status.routeFailed.detail' : 'status.applyFailed.detail',
        params: { reason: String(failed) },
      },
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
