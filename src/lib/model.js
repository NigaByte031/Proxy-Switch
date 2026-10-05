/**
 * Pure data layer: state shape, validation and (de)serialisation.
 *
 * Nothing in this file touches the `chrome` namespace, so the module can be
 * imported by the extension pages, the service worker *and* Node's test runner.
 */

import { DEFAULT_CUSTOM_ACCENT, normalizeHex } from './color.js';

/** Schema version of the persisted state. Bump when the shape changes. */
export const STATE_VERSION = 1;

/** Key used inside `chrome.storage.local`. */
export const STORAGE_KEY = 'proxySwitchState';

/** Marker written into exported JSON files. */
export const EXPORT_FORMAT = 'proxy-switch';

/** Proxy modes, in the order they are shown in the UI. */
export const PROXY_MODES = ['system', 'direct', 'fixed_servers', 'pac_script'];

/** Proxy schemes accepted by chrome.proxy. */
export const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'];

/** Accepted values of the language setting ("auto" follows the browser). */
export const LANGUAGES = ['auto', 'en', 'fa'];

/** Accepted values of the theme setting ("auto" follows the operating system). */
export const THEMES = ['auto', 'light', 'dark'];

/**
 * Accepted values of the accent setting. Each one has a `:root[data-accent=…]`
 * palette block in `src/styles/base.css`; "emerald" is the shipped look.
 */
export const ACCENTS = ['emerald', 'ocean', 'violet', 'amber', 'rose'];

/** Sentinel for an accent the user picked themselves, instead of a preset. */
export const CUSTOM_ACCENT = 'custom';

/** Every value `settings.accent` may hold: the shipped palettes, then custom. */
export const ACCENT_CHOICES = [...ACCENTS, CUSTOM_ACCENT];

/**
 * Accepted values of the traffic-view setting: how the meter's readings are laid
 * out (see `lib/traffic-view.js`). "classic" is the shipped arrangement.
 */
export const TRAFFIC_VIEWS = ['classic', 'compact', 'cards', 'speed'];

/**
 * Accepted values of the density setting: how tightly the pages pack their cards
 * (see `lib/theme.js`). "comfortable" is the shipped spacing.
 */
export const DENSITIES = ['comfortable', 'compact'];

/**
 * Accepted values of the text-size setting: the type scale every page reads
 * (`--type-scale` in `src/styles/base.css`). "normal" is the shipped size.
 */
export const TEXT_SIZES = ['normal', 'large'];

/** Hosts that skip the proxy out of the box. */
export const DEFAULT_BYPASS_LIST = ['<local>', 'localhost', '[::1]'];

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** @typedef {{id: string, name: string, scheme: string, host: string, port: number, username: string, password: string}} Profile */

/** @returns {object} A fresh state object with default settings. */
export function createDefaultState() {
  return {
    version: STATE_VERSION,
    settings: {
      enabled: true,
      mode: 'system',
      activeProfileId: null,
      pacUrl: '',
      bypassList: [...DEFAULT_BYPASS_LIST],
      autoAuth: true,
      autoFailover: true,
      notifyFailover: true,
      // Fail-closed: when a mode's route cannot be built — no server saved, no PAC
      // script — the extension otherwise fails open and connects directly. With
      // this on it points the browser at an address nothing listens on instead, so
      // a broken route refuses the request rather than leaking it (`lib/proxy.js`).
      failClosed: false,
      // Periodic background checks (see `lib/server-probe.js`). Off by default:
      // the one setting that makes network requests the user did not press for.
      backgroundProbe: false,
      // PAC script from a URL, or generated from the list below (see `lib/pac.js`).
      domainRouting: false,
      // Traffic meter (see `lib/traffic.js`): counts declared sizes while the
      // proxy is on. Nothing leaves the device.
      trafficMeter: true,
      // How the meter reads (lib/traffic-view.js): the same figures, arranged
      // differently. A display choice only — it never changes what is counted.
      trafficView: 'classic',
      proxyDomains: [],
      // Which server each listed site goes through, rule -> profile id (see
      // `lib/site-route.js`). A rule with no entry uses the chain every listed
      // site shares: the active server first, then the rest.
      domainServers: {},
      language: 'auto',
      theme: 'auto',
      accent: 'emerald',
      // The colour a custom accent wears (`accent === 'custom'`). Stored as a
      // `#rrggbb` so an edited or imported file can never smuggle in anything else.
      customAccent: DEFAULT_CUSTOM_ACCENT,
      // Appearance, not behaviour: how much air between the cards, and how big
      // the type is. Both are written onto <html> and read by the stylesheet.
      density: 'comfortable',
      textSize: 'normal',
    },
    profiles: [],
  };
}

/** The mode that is actually applied: a switched-off extension is always direct. */
export function effectiveMode(state) {
  if (!state?.settings?.enabled) return 'direct';
  const mode = state.settings.mode;
  return PROXY_MODES.includes(mode) ? mode : 'system';
}

/**
 * What the current mode still needs before it can do anything useful.
 * @returns {'profile'|'pac'|null}
 */
export function missingRequirement(state) {
  const mode = effectiveMode(state);
  if (mode === 'fixed_servers' && !findProfile(state, state.settings.activeProfileId)) return 'profile';
  if (mode === 'pac_script') {
    // A generated PAC needs a server to route through, not just rules.
    if (state.settings.domainRouting) {
      if (!findProfile(state, state.settings.activeProfileId)) return 'profile';
      if ((state.settings.proxyDomains ?? []).length === 0) return 'domains';
      return null;
    }
    if (!String(state.settings.pacUrl ?? '').trim()) return 'pac';
  }
  return null;
}

export function findProfile(state, id) {
  if (!id) return null;
  return (state?.profiles ?? []).find((profile) => profile.id === id) ?? null;
}

/**
 * The servers that may be routed through, in order: `profileId` first, then the
 * rest in list order. A chain always ends somewhere rather than going direct, so a
 * site that was promised a server keeps that promise.
 *
 * @param {object} state
 * @param {string|null} profileId the server that heads the chain
 * @returns {object[]} empty when that server is gone
 */
export function chainForProfile(state, profileId) {
  const head = findProfile(state, profileId);
  if (!head) return [];
  const fallbacks = (state?.profiles ?? []).filter((profile) => profile.id !== head.id);
  return [head, ...fallbacks];
}

/**
 * The chain of the active server: the one every listed site shares. Shared by
 * `lib/pac.js` and `lib/auth.js`, so the two can never disagree.
 *
 * @returns {object[]}
 */
export function routingChain(state) {
  return chainForProfile(state, state?.settings?.activeProfileId);
}

/** The profile id a listed rule was given, or null for the shared chain. */
export function domainServerOf(settings, rule) {
  const map = settings?.domainServers;
  if (!map || typeof map !== 'object') return null;
  const wanted = String(rule ?? '').toLowerCase();
  for (const [key, id] of Object.entries(map)) {
    if (key.toLowerCase() === wanted && typeof id === 'string' && id) return id;
  }
  return null;
}

let idCounter = 0;

/** Short, collision-resistant profile id. */
export function newId() {
  idCounter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `p_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `p_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/* Host / port helpers. */

/** Strips scheme, path, query and embedded credentials from pasted input. */
export function normalizeHost(raw) {
  let host = String(raw ?? '').trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.split('/')[0].split('?')[0].split('#')[0];
  return host.replace(/^[^@/]*@/, '');
}

export function isBracketedIpv6(host) {
  return /^\[[0-9a-fA-F:.]+\]$/.test(host);
}

export function isValidHost(host) {
  const value = String(host ?? '');
  if (!value || value.length > 253) return false;
  if (isBracketedIpv6(value)) return true;
  // The port lives in its own field, so a bare colon is always a mistake.
  if (/[:\s@/\\]/.test(value)) return false;
  return true;
}

/**
 * People paste `host:8080`; split that back into the two fields, leaving an
 * already filled port field alone.
 */
export function splitHostPort(rawHost, rawPort) {
  const host = normalizeHost(rawHost);
  const port = String(rawPort ?? '').trim();
  const bracketed = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { host: `[${bracketed[1]}]`, port: bracketed[2] ?? port };
  }
  const colon = host.lastIndexOf(':');
  if (colon > -1 && host.indexOf(':') === colon) {
    const maybePort = host.slice(colon + 1);
    const maybeHost = host.slice(0, colon);
    if (maybeHost && /^\d+$/.test(maybePort)) {
      return { host: maybeHost, port: port || maybePort };
    }
  }
  return { host: bracketIfIpv6(host), port };
}

/** `::1` -> `[::1]`; chrome.proxy needs IPv6 literals in brackets. */
export function bracketIfIpv6(host) {
  const value = String(host ?? '');
  if (!value || value.startsWith('[')) return value;
  if (value.split(':').length >= 3 && /^[0-9a-fA-F:.]+$/.test(value)) return `[${value}]`;
  return value;
}

export function isValidPacUrl(url) {
  return /^https?:\/\/\S+$/i.test(String(url ?? '').trim());
}

/* Pasted proxy URLs. */

function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a pasted proxy URL, so `socks5://user:pass@host:1080` fills the whole
 * form in one go. Every part is optional; `host:8080` works too.
 *
 * @returns {{scheme: string|null, host: string, port: string, username: string, password: string}|null}
 */
export function parseProxyUrl(raw) {
  let rest = String(raw ?? '').trim();
  if (!rest) return null;

  let scheme = null;
  const schemeMatch = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const candidate = schemeMatch[1].toLowerCase();
    if (PROXY_SCHEMES.includes(candidate)) scheme = candidate;
    else if (candidate === 'socks') scheme = 'socks5';
    rest = rest.slice(schemeMatch[0].length);
  }

  // The address ends at the first path, query or fragment: a URL that carries one
  // must not have it read as credentials.
  rest = rest.split('/')[0].split('?')[0].split('#')[0];

  let username = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at > -1) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = userinfo.indexOf(':');
    if (colon > -1) {
      username = decodeComponent(userinfo.slice(0, colon));
      password = decodeComponent(userinfo.slice(colon + 1));
    } else {
      username = decodeComponent(userinfo);
    }
  }

  const { host, port } = splitHostPort(rest, '');
  if (!host) return null;

  return { scheme, host, port, username, password };
}

/* Profiles. */

export function createProfile(draft = {}) {
  return {
    id: draft.id ?? newId(),
    name: String(draft.name ?? '').trim(),
    scheme: PROXY_SCHEMES.includes(draft.scheme) ? draft.scheme : 'http',
    host: String(draft.host ?? '').trim().toLowerCase(),
    port: Number(draft.port),
    username: String(draft.username ?? ''),
    password: String(draft.password ?? ''),
  };
}

/**
 * Validates a profile form draft.
 * @returns {{ok: boolean, errors: Record<string,string>, profile: Profile|null}}
 *          `errors` values are i18n keys, so the caller decides the language.
 */
export function validateProfile(draft = {}, { profiles = [], editingId = null } = {}) {
  const errors = {};

  const name = String(draft.name ?? '').trim();
  if (!name) {
    errors.name = 'error.nameRequired';
  } else if (
    profiles.some(
      (profile) => profile.id !== editingId && profile.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    errors.name = 'error.nameDuplicate';
  }

  const { host, port } = splitHostPort(draft.host, draft.port);
  if (!host) {
    errors.host = 'error.hostRequired';
  } else if (!isValidHost(host)) {
    errors.host = 'error.hostInvalid';
  }

  const portText = String(port ?? '').trim();
  if (!portText) {
    errors.port = 'error.portRequired';
  } else if (!/^\d+$/.test(portText)) {
    errors.port = 'error.portInvalid';
  } else if (Number(portText) < MIN_PORT || Number(portText) > MAX_PORT) {
    errors.port = 'error.portRange';
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    profile: ok
      ? createProfile({
          id: editingId ?? undefined,
          name,
          scheme: draft.scheme,
          host,
          port: portText,
          username: draft.username,
          password: draft.password,
        })
      : null,
  };
}

/** Human readable `socks5://host:port · user` (passwords are never shown). */
export function formatProfileAddress(profile) {
  if (!profile) return '';
  const base = `${profile.scheme}://${profile.host}:${profile.port}`;
  return profile.username ? `${base} · ${profile.username}` : base;
}

/**
 * Below this many servers the list is short enough to scan, and a search box
 * would only add noise to the popup.
 */
export const PROFILE_SEARCH_THRESHOLD = 4;

/**
 * Everything a search box may match a row against, lower-cased. Passwords are
 * absent on purpose: a hidden value must not decide which rows show up.
 */
export function profileSearchText(profile) {
  return [profile?.name, profile?.host, profile?.scheme, profile?.port, profile?.username]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join(' ')
    .toLowerCase();
}

/**
 * The server list, filtered for the search box. Every whitespace-separated term
 * has to appear somewhere in the row; a blank query leaves the list untouched.
 */
export function filterProfiles(profiles, query) {
  const list = Array.isArray(profiles) ? profiles : [];
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((profile) => {
    const haystack = profileSearchText(profile);
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Whether the list should show its search box: a long list, or a query the user
 * is already typing (which must stay visible until it is cleared).
 */
export function shouldShowSearch(profileCount, query = '') {
  return Number(profileCount) >= PROFILE_SEARCH_THRESHOLD || String(query ?? '').trim() !== '';
}

/** Appends a counter until the name is free, e.g. "New server 2". */
export function uniqueProfileName(profiles, base) {
  const taken = new Set(profiles.map((profile) => profile.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`.trim().toLowerCase())) index += 1;
  return `${base} ${index}`;
}

/* Domains routed through the proxy. */

/** `#` starts a comment, so a list can explain itself. */
export const DOMAIN_COMMENT = '#';

/**
 * One typed rule, cleaned up: `https://example.com/path` becomes `example.com`,
 * and anything that cannot be a host is dropped.
 *
 * @returns {string|null} the rule, or null when it can never match a host
 */
export function normalizeDomainRule(raw) {
  const line = String(raw ?? '')
    .split(DOMAIN_COMMENT)[0]
    .trim();
  if (!line) return null;

  // A pasted URL is reduced to its host, but a pattern is already a host:
  // reading `*.example.com` as a URL would turn it into "example.com".
  const pasted = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) || line.includes('/');
  const rule = pasted ? normalizeHost(line) : line;
  // A rule has to contain something, not just punctuation.
  if (!rule || !isValidHost(rule) || !/[\p{L}\p{N}]/u.test(rule)) return null;
  return rule;
}

/** Coerces a stored array of rules, dropping the ones that cannot match. */
export function sanitizeDomainRules(list) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const rule = normalizeDomainRule(raw);
    if (!rule || seen.has(rule.toLowerCase())) continue;
    seen.add(rule.toLowerCase());
    result.push(rule);
  }
  return result;
}

/** One rule per line, `#` for comments — the format of the settings textarea. */
export function parseDomainRules(text) {
  return sanitizeDomainRules(String(text ?? '').split(/\r?\n/));
}

export function formatDomainList(list) {
  return sanitizeDomainRules(list).join('\n');
}

/* Bypass list. */

export function parseBypassList(text) {
  const seen = new Set();
  const result = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const rule = line.trim();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    result.push(rule);
  }
  return result;
}

export function formatBypassList(list) {
  return (Array.isArray(list) ? list : []).join('\n');
}

/**
 * Coerces the rule -> server map: a rule that is no longer listed, or a server
 * that no longer exists, loses its entry instead of leaving a rule pointing at a
 * chain that cannot be built. Keys are written back in their canonical spelling,
 * so `Example.com` and `example.com` never become two entries.
 *
 * @param {object} raw the stored map
 * @param {string[]} rules the rules that survived sanitizing
 * @param {object[]} profiles the profiles that survived sanitizing
 */
export function sanitizeDomainServers(raw, rules, profiles) {
  const known = new Set((Array.isArray(profiles) ? profiles : []).map((profile) => profile.id));
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const byRule = new Map();
  for (const [key, id] of Object.entries(map)) {
    if (typeof id === 'string') byRule.set(String(key).toLowerCase(), id);
  }

  const result = {};
  for (const rule of Array.isArray(rules) ? rules : []) {
    const id = byRule.get(rule.toLowerCase());
    if (id && known.has(id)) result[rule] = id;
  }
  return result;
}

/* Persistence helpers. */

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // A host that carries its own port — another tool's export, a hand-edited file —
  // is split instead of dropped, exactly as the form reads it. The port field wins
  // when it says something.
  const { host, port } = splitHostPort(raw.host, raw.port);
  const clean = bracketIfIpv6(host).toLowerCase();
  if (!clean || !isValidHost(clean)) return null;
  const portNumber = Number(port);
  const usable = Number.isInteger(portNumber) && portNumber >= MIN_PORT && portNumber <= MAX_PORT;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: String(raw.name ?? '').trim() || clean,
    scheme: PROXY_SCHEMES.includes(raw.scheme) ? raw.scheme : 'http',
    host: clean,
    port: usable ? portNumber : 8080,
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
  };
}

/**
 * Coerces old state, hand-edited storage or an imported file into a valid state
 * object: unknown fields are dropped, broken values fall back to defaults.
 */
export function sanitizeState(raw) {
  const base = createDefaultState();
  const input = raw && typeof raw === 'object' ? raw : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};

  const profiles = [];
  const usedIds = new Set();
  for (const candidate of Array.isArray(input.profiles) ? input.profiles : []) {
    const profile = sanitizeProfile(candidate);
    if (!profile) continue;
    if (usedIds.has(profile.id)) profile.id = newId();
    usedIds.add(profile.id);
    profiles.push(profile);
  }

  const proxyDomains = sanitizeDomainRules(settings.proxyDomains);

  const bypassList = Array.isArray(settings.bypassList)
    ? settings.bypassList.map((rule) => String(rule).trim()).filter(Boolean)
    : [...base.settings.bypassList];

  const requestedActive = typeof settings.activeProfileId === 'string' ? settings.activeProfileId : null;
  const activeProfileId = profiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : (profiles[0]?.id ?? null);

  return {
    version: STATE_VERSION,
    settings: {
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : base.settings.enabled,
      mode: PROXY_MODES.includes(settings.mode) ? settings.mode : base.settings.mode,
      activeProfileId,
      pacUrl: typeof settings.pacUrl === 'string' ? settings.pacUrl.trim() : base.settings.pacUrl,
      bypassList,
      autoAuth: typeof settings.autoAuth === 'boolean' ? settings.autoAuth : base.settings.autoAuth,
      autoFailover:
        typeof settings.autoFailover === 'boolean' ? settings.autoFailover : base.settings.autoFailover,
      notifyFailover:
        typeof settings.notifyFailover === 'boolean'
          ? settings.notifyFailover
          : base.settings.notifyFailover,
      failClosed:
        typeof settings.failClosed === 'boolean' ? settings.failClosed : base.settings.failClosed,
      backgroundProbe:
        typeof settings.backgroundProbe === 'boolean'
          ? settings.backgroundProbe
          : base.settings.backgroundProbe,
      domainRouting:
        typeof settings.domainRouting === 'boolean'
          ? settings.domainRouting
          : base.settings.domainRouting,
      trafficMeter:
        typeof settings.trafficMeter === 'boolean'
          ? settings.trafficMeter
          : base.settings.trafficMeter,
      trafficView: TRAFFIC_VIEWS.includes(settings.trafficView)
        ? settings.trafficView
        : base.settings.trafficView,
      proxyDomains,
      domainServers: sanitizeDomainServers(settings.domainServers, proxyDomains, profiles),
      language: LANGUAGES.includes(settings.language) ? settings.language : base.settings.language,
      theme: THEMES.includes(settings.theme) ? settings.theme : base.settings.theme,
      accent: ACCENT_CHOICES.includes(settings.accent)
        ? settings.accent
        : base.settings.accent,
      customAccent: normalizeHex(settings.customAccent) ?? base.settings.customAccent,
      density: DENSITIES.includes(settings.density) ? settings.density : base.settings.density,
      textSize: TEXT_SIZES.includes(settings.textSize) ? settings.textSize : base.settings.textSize,
    },
    profiles,
  };
}

/** Builds the object written to an exported settings file. */
export function serializeState(state, now = new Date()) {
  const clean = sanitizeState(state);
  return {
    format: EXPORT_FORMAT,
    version: STATE_VERSION,
    exportedAt: now.toISOString(),
    settings: { ...clean.settings },
    profiles: clean.profiles.map((profile) => ({ ...profile })),
  };
}

/**
 * Reads an exported settings file.
 * @returns {{ok: true, state: object} | {ok: false, error: string}}
 */
export function parseImport(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, error: 'error.importJson' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'error.importFormat' };
  }
  if (data.format !== undefined && data.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'error.importFormat' };
  }
  return { ok: true, state: sanitizeState({ settings: data.settings, profiles: data.profiles }) };
}
