/**
 * Domain routing: a PAC script generated from a list of domains, so that only
 * the sites you name go through your servers and everything else stays direct.
 *
 * `fixed_servers` cannot express that — its bypass list can only *exclude*, and
 * a proxy for one protocol is a proxy for all of them. A PAC script can, and
 * Chrome accepts one as a string (`pacScript.data`), so no file has to be
 * written, downloaded or hosted: the script below is built from the settings,
 * lives in the extension's own proxy configuration and is pure text, which is
 * why it can be tested here by running it.
 *
 * Three decisions are deliberate and load-bearing:
 *
 *   - **A listed domain never falls back to `DIRECT`.** Handing a site the user
 *     asked to route through a server straight to the network would leak
 *     exactly the traffic the list exists for. When every server is down, the
 *     page fails loudly instead.
 *   - **The chain is every saved server.** A PAC script retries a chain per
 *     connection (`PROXY a:8080; PROXY b:8080`), which is the tolerance the
 *     fixed_servers mode gets from its own failover machinery — without it,
 *     domain routing would go dark whenever the one server it named died.
 *   - **Everything else is direct, silently.** That is the point of the list:
 *     it is an allow list, not a global switch.
 *
 * `bypassList` keeps its meaning too: those hosts never use a proxy, even if a
 * rule below matches them.
 *
 * The same generator produces the script a background check installs for a few
 * seconds (see `buildPacScript`'s `override` and `base` options and
 * `lib/server-probe.js`): identical policy, except that the extension's own
 * probe requests are handed to the one server being checked. Reusing this
 * generator is the point — the configuration in force during a check differs
 * from the user's only in where the checks themselves go.
 */

import { sanitizeDomainRules } from './model.js';

/**
 * PAC proxies are named by protocol: "PROXY" is an HTTP proxy, "HTTPS" one that
 * speaks TLS, "SOCKS4"/"SOCKS5" the SOCKS variants.
 */
export const PAC_DIRECTIVE = {
  http: 'PROXY',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
};

/** The `<local>` token in a bypass list: every host without a dot. */
export const PLAIN_HOST_RULE = '<local>';

/** The rule a proxy directive is built from, e.g. `PROXY proxy.example.com:8080`. */
export function proxyDirective(profile) {
  const directive = PAC_DIRECTIVE[profile?.scheme] ?? PAC_DIRECTIVE.http;
  return `${directive} ${profile.host}:${Number(profile.port)}`;
}

/**
 * The servers the script is allowed to try, in order — the active one first,
 * then the rest of the list. `; ` is how a PAC script expresses "and then", and
 * Chrome walks the chain per connection.
 *
 * @param {object[]} servers
 * @returns {string} `PROXY a:8080; SOCKS5 b:1080`, or '' when there is no server
 */
export function proxyChain(servers) {
  const directives = [];
  const seen = new Set();

  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server?.host) continue;
    const directive = proxyDirective(server);
    if (seen.has(directive)) continue;
    seen.add(directive);
    directives.push(directive);
  }

  return directives.join('; ');
}

/**
 * Builds the PAC script for a chain of servers and a domain list.
 *
 * @param {object} options
 * @param {object[]} options.servers the chain, in the order it is tried
 * @param {string[]} [options.domains] the hosts the chain is for (the base
 *        policy is an allow list unless `base` says otherwise)
 * @param {string[]} [options.bypass] hosts that never use a proxy
 * @param {'listed'|'all'} [options.base] what the chain is for when no other
 *        rule matches: the listed hosts (domain routing), or every host —
 *        which is how manual mode behaves, where nothing is left direct
 * @param {{hosts?: string[], directive?: string}|null} [options.override] a
 *        directive handed to a few named hosts. This is how a background check
 *        (see `lib/server-probe.js`) sends *its own* probe to the server it is
 *        testing while the user's routing stays exactly as configured: the
 *        probes are the only thing that changes, so a server that is down
 *        cannot break a page the user is loading.
 * @returns {string|null} the script, or null when there is nothing to route
 *          (no server, or no usable rule) — the caller then fails open
 */
export function buildPacScript({ servers, domains, bypass = [], base = 'listed', override = null }) {
  const chain = proxyChain(servers);
  const rules = sanitizeDomainRules(domains);
  const routeEverything = base === 'all';
  if (!chain) return null;
  if (rules.length === 0 && !routeEverything) return null;

  // A rule the script must never guess about: an override without both halves
  // is no override at all, rather than a script that diverts nothing while
  // looking like it does.
  const overrideHosts = (Array.isArray(override?.hosts) ? override.hosts : [])
    .map((host) => String(host ?? '').trim().toLowerCase())
    .filter(Boolean);
  const overrideDirective = String(override?.directive ?? '').trim();
  const overrides = overrideHosts.length > 0 && overrideDirective !== '';

  const names = (Array.isArray(servers) ? servers : [])
    .filter((server) => server?.host)
    .map((server) => server.name);
  const bypassRules = sanitizeDomainRules(bypass);

  const policy = routeEverything
    ? '// Every host uses the proxy chain; the bypass list still wins, and a host\n// that is bypassed is never sent through a server.'
    : '// The rules below are an allow list: only those hosts use the proxy chain,\n// everything else is direct, and a matched host is never sent direct even when\n// every server in the chain is unreachable (a leak would defeat the point of\n// listing it).';

  return `// Generated by Proxy Switch — ${rules.length} domain rule(s) through ${JSON.stringify(names)}.
${policy}${overrides ? '\n// PLUS a handful of hosts below sent to one named server: the extension\n// checking that server with its own probe.' : ''}
var PROXIES = ${JSON.stringify(chain)};
var ROUTED = ${JSON.stringify(rules)};
var BYPASSED = ${JSON.stringify(bypassRules)};
var ALL_HOSTS = ${routeEverything ? 'true' : 'false'};
var OVERRIDE = ${JSON.stringify(overrides ? overrideDirective : '')};
var OVERRIDE_HOSTS = ${JSON.stringify(overrides ? overrideHosts : [])};

// One rule against one host. A plain name covers the domain and its subdomains,
// "*.example.com" only the subdomains, "<local>" every dot-less host, and any
// other "*"/"?" is a glob (the PAC-standard shExpMatch).
function hostMatches(host, rule) {
  var value = String(host).toLowerCase().replace(/^\\[|\\]$/g, '');
  var pattern = String(rule).toLowerCase().replace(/^\\[|\\]$/g, '');
  if (pattern === ${JSON.stringify(PLAIN_HOST_RULE)}) return isPlainHostName(value);
  if (pattern.slice(0, 2) === '*.') {
    var bare = pattern.slice(2);
    return value.length > bare.length && value.slice(-(bare.length + 1)) === '.' + bare;
  }
  if (pattern.indexOf('*') !== -1 || pattern.indexOf('?') !== -1) return shExpMatch(value, pattern);
  return value === pattern || value.slice(-(pattern.length + 1)) === '.' + pattern;
}

function anyMatch(host, rules) {
  for (var index = 0; index < rules.length; index += 1) {
    if (hostMatches(host, rules[index])) return true;
  }
  return false;
}

// Exact host, no subdomains: these are the extension's own probe endpoints, not
// part of any listing the user wrote.
function isOverrideHost(host) {
  var value = String(host).toLowerCase().replace(/^\\[|\\]$/g, '').split(':')[0];
  for (var index = 0; index < OVERRIDE_HOSTS.length; index += 1) {
    if (OVERRIDE_HOSTS[index] === value) return true;
  }
  return false;
}

function FindProxyForURL(url, host) {
  // Checked first: a probe is the extension measuring one server, so it goes
  // where the check asked for even if the bypass list mentions the host.
  if (OVERRIDE !== '' && isOverrideHost(host)) return OVERRIDE;
  // The bypass list is a promise: these hosts never see a proxy.
  if (anyMatch(host, BYPASSED)) return 'DIRECT';
  // The chain, not a single server: the next one is tried when the first fails.
  if (ALL_HOSTS || anyMatch(host, ROUTED)) return PROXIES;
  return 'DIRECT';
}
`;
}
