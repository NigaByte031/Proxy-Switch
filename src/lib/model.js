/**
 * Pure data layer: state shape, validation and (de)serialisation.
 *
 * Nothing in this file touches the `chrome` namespace, so the module can be
 * imported by the extension pages, the service worker *and* Node's test runner.
 */

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
      language: 'auto',
      theme: 'auto',
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
  if (mode === 'pac_script' && !String(state.settings.pacUrl ?? '').trim()) return 'pac';
  return null;
}

export function findProfile(state, id) {
  if (!id) return null;
  return (state?.profiles ?? []).find((profile) => profile.id === id) ?? null;
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

/* ------------------------------------------------------------------ *
 * Host / port helpers
 * ------------------------------------------------------------------ */

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
  // The port lives in its own field, so a bare colon here is always a mistake.
  // Spaces, paths and userinfo are rejected as well; unicode hosts stay allowed.
  if (/[:\s@/\\]/.test(value)) return false;
  return true;
}

/**
 * The form has separate host and port fields, but people paste `host:8080`.
 * Splits that back into the two fields without touching the port field when
 * it is already filled in.
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

/* ------------------------------------------------------------------ *
 * Pasted proxy URLs
 * ------------------------------------------------------------------ */

function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a proxy the way people paste them, so a whole
 * `socks5://user:pass@host:1080` line can fill the form in one go. Every part is
 * optional: `host:8080` and a bare `host` work too.
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

  rest = rest.split('/')[0].split('?')[0].split('#')[0];
  const { host, port } = splitHostPort(rest, '');
  if (!host) return null;

  return { scheme, host, port, username, password };
}

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

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

/** Appends a counter until the name is free, e.g. "New server 2". */
export function uniqueProfileName(profiles, base) {
  const taken = new Set(profiles.map((profile) => profile.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`.trim().toLowerCase())) index += 1;
  return `${base} ${index}`;
}

/* ------------------------------------------------------------------ *
 * Bypass list
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Persistence helpers
 * ------------------------------------------------------------------ */

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = bracketIfIpv6(normalizeHost(raw.host));
  if (!host || !isValidHost(host)) return null;
  const port = Number(raw.port);
  const portNumber = Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: String(raw.name ?? '').trim() || host,
    scheme: PROXY_SCHEMES.includes(raw.scheme) ? raw.scheme : 'http',
    host: host.toLowerCase(),
    port: portNumber ?? 8080,
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
  };
}

/**
 * Coerces anything (old state, hand-edited storage, imported file) into a valid
 * state object. Unknown fields are dropped, broken values fall back to defaults.
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
      language: LANGUAGES.includes(settings.language) ? settings.language : base.settings.language,
      theme: THEMES.includes(settings.theme) ? settings.theme : base.settings.theme,
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
