/**
 * "This site" — the popup's one-click routing control, as pure functions.
 *
 * Two questions live here. Which site is the open tab on, and what does the
 * current configuration do to that site? The second one has to answer the same way
 * the generated PAC does, so `hostMatchesRule` mirrors the matcher inside the
 * script (`lib/pac.js`) — a test runs both over the same hosts to keep them
 * agreeing.
 */

import { domainServerOf, effectiveMode, findProfile, sanitizeDomainRules } from './model.js';

/** The `<local>` rule: every host without a dot (see `lib/pac.js`). */
export const PLAIN_HOST_RULE = '<local>';

/**
 * One glob match, `*` and `?` only — the PAC standard's `shExpMatch`.
 * @param {string} value
 * @param {string} pattern
 */
function globMatch(value, pattern) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(String(value));
}

/**
 * Whether one rule covers one host. The rule language, as the PAC matcher reads
 * it: a plain name covers the domain and its subdomains, `*.example.com` only the
 * subdomains, `<local>` every dot-less host, and any other `*`/`?` is a glob.
 *
 * @param {string} host a hostname, no port
 * @param {string} rule
 */
export function hostMatchesRule(host, rule) {
  const value = String(host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const pattern = String(rule ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!value || !pattern) return false;
  if (pattern === PLAIN_HOST_RULE) return !value.includes('.');
  if (pattern.slice(0, 2) === '*.') {
    const bare = pattern.slice(2);
    return value.length > bare.length && value.slice(-(bare.length + 1)) === `.${bare}`;
  }
  if (pattern.includes('*') || pattern.includes('?')) return globMatch(value, pattern);
  return value === pattern || value.slice(-(pattern.length + 1)) === `.${pattern}`;
}

/** Does any rule in the list cover this host? */
export function listMatchesHost(list, host) {
  const rules = Array.isArray(list) ? list : [];
  return rules.some((rule) => hostMatchesRule(host, rule));
}

/**
 * The site a tab URL belongs to, as a rule the site list accepts: lower case, no
 * port, no userinfo, IPv6 literals bracketed. Only `http`/`https` pages have one —
 * a `chrome://` page is not a site anybody can route.
 *
 * A leading `www.` is dropped, because `example.com` already covers
 * `www.example.com` and would otherwise be listed twice.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function siteHostFromUrl(raw) {
  const url = String(raw ?? '').trim();
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  const authority = url.slice(url.indexOf('://') + 3).split(/[/?#]/)[0];
  let host = authority.split('@').pop() ?? '';
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    host = `[${bracketed[1]}]`;
  } else {
    host = host.replace(/:\d+$/, '');
  }
  return canonicalSiteRule(host);
}

/**
 * The rule this site is listed by: the host itself, `www.` trimmed, IPv6 in
 * brackets. A bare `::1` cannot be a rule (ports live in another field), so a
 * literal is closed up.
 *
 * @param {string} host
 * @returns {string|null}
 */
export function canonicalSiteRule(host) {
  let value = String(host ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.length > 2 ? value : null;
  }
  value = value.replace(/^\[|\]$/g, '');
  if (value.includes(':')) {
    // An unbracketed IPv6 literal, e.g. from `new URL(...).hostname`.
    if (value.split(':').length >= 3 && /^[0-9a-f:.]+$/.test(value)) return `[${value}]`;
    return null;
  }
  if (value.startsWith('www.')) value = value.slice(4);
  return value || null;
}

/**
 * What the current configuration does to one site.
 *
 * `listed` and `bypassed` are what the lists say; `effect` is what actually
 * happens, which also depends on the mode. Keeping the two apart is the point: a
 * chip can be lit while the effect line honestly says the mode overrides it.
 *
 * @param {object} state
 * @param {string} host
 * @returns {{listed: boolean, bypassed: boolean, serverId: string|null,
 *            serverName: string|null, effect: 'off'|'bypass'|'direct'|'proxy'|'system'|'pac'}}
 */
export function siteRouteOf(state, host) {
  const settings = state?.settings ?? {};
  const listed = listMatchesHost(sanitizeDomainRules(settings.proxyDomains), host);
  const bypassed = listMatchesHost(settings.bypassList, host);
  // The site's own rule is the key the map is read under — looked up the same
  // way `sanitizeDomainServers` writes it, case-insensitively, so a rule stored
  // as `Example.com` still names the server it was given.
  const rule = canonicalSiteRule(host);
  const server = listed ? findProfile(state, rule ? domainServerOf(settings, rule) : null) : null;

  const base = { listed, bypassed, serverId: server?.id ?? null, serverName: server?.name ?? null };
  if (!settings.enabled) return { ...base, effect: 'off' };
  // The bypass list wins over every mode (see `lib/pac.js`).
  if (bypassed) return { ...base, effect: 'bypass' };

  const mode = effectiveMode(state);
  if (mode === 'direct') return { ...base, effect: 'direct' };
  if (mode === 'fixed_servers') return { ...base, effect: 'proxy' };
  if (mode === 'pac_script') {
    if (settings.domainRouting !== true) return { ...base, effect: 'pac' };
    return { ...base, effect: listed ? 'proxy' : 'direct' };
  }
  return { ...base, effect: 'system' };
}

/**
 * i18n key + params for one site's effect, so every page says it the same way. Only
 * a route that *does* go through this site's own server names it: the other
 * effects are about the site, and naming a server there would read as a promise.
 */
export function describeSiteRoute(state, host) {
  const route = siteRouteOf(state, host);
  const named = route.effect === 'proxy' && Boolean(route.serverName);
  return {
    key: named ? 'site.effect.proxy.named' : `site.effect.${route.effect}`,
    params: { host, name: route.serverName ?? '' },
    route,
  };
}

/**
 * Whether the mode would ignore a site the user just listed: a script from a URL
 * cannot be edited, and system/direct routing has no list at all. Manual mode is
 * not on this list — everything already goes through its server.
 */
function modeIgnoresTheList(settings) {
  const mode = settings?.mode;
  if (mode === 'pac_script') return settings.domainRouting !== true;
  return mode !== 'fixed_servers';
}

/**
 * Writes one site's choice into the draft state. Pure apart from the draft it is
 * handed, like every other mutator the pages use.
 *
 * The rule it writes is the site's own (`canonicalSiteRule`), and any rule in the
 * *other* list that covers this site is dropped — otherwise the older rule would
 * still decide, and the chip would look broken.
 *
 * @param {object} draft a state object being edited
 * @param {string} host
 * @param {'proxy'|'direct'|'auto'} choice
 * @returns {boolean} whether anything changed
 */
export function applySiteChoice(draft, host, choice) {
  const rule = canonicalSiteRule(host);
  if (!draft?.settings || !rule) return false;
  // Every rule that already covers this site has to go from the list the user did
  // not choose, or the older rule would still win.
  const target = String(host ?? '').trim().toLowerCase() || rule;
  const keep = (list) =>
    (Array.isArray(list) ? list : []).map(String).filter((entry) => !hostMatchesRule(target, entry));

  // The list the choice keeps is left as it is, so a site that is already listed
  // keeps the rule — and the server — it was already given.
  const domains =
    choice === 'proxy' ? [...(draft.settings.proxyDomains ?? [])] : keep(draft.settings.proxyDomains);
  const bypass =
    choice === 'direct' ? [...(draft.settings.bypassList ?? [])] : keep(draft.settings.bypassList);

  if (choice === 'proxy' && !listMatchesHost(domains, rule)) domains.push(rule);
  if (choice === 'direct' && !listMatchesHost(bypass, rule)) bypass.push(rule);

  const servers = { ...(draft.settings.domainServers ?? {}) };
  // A site that is no longer listed cannot keep the server it was listed with.
  if (choice !== 'proxy') {
    for (const key of Object.keys(servers)) {
      if (hostMatchesRule(target, key)) delete servers[key];
    }
  }

  draft.settings.proxyDomains = domains;
  draft.settings.bypassList = bypass;
  draft.settings.domainServers = servers;

  // Routing a site is only a promise the browser keeps in one mode. Everywhere
  // else the list does nothing, so choosing "proxy" also turns that mode on — for
  // a manual-mode user nothing moves, since their traffic is already proxied.
  if (choice === 'proxy' && modeIgnoresTheList(draft.settings)) {
    if (findProfile(draft, draft.settings.activeProfileId)) {
      draft.settings.mode = 'pac_script';
      draft.settings.domainRouting = true;
    }
  }
  return true;
}
