/**
 * "Why does this host go there?" — the decision the generated PAC makes, spelled
 * out as sentences, for any host at all: one you listed, or one only a rule of
 * yours covers (`www.example.com` under `example.com`).
 *
 * A second *reader* of the policy, not a second copy of it: the chain comes from
 * `ruleChain` in `lib/proxy.js`, and whether a route exists at all is answered by
 * building the very script the browser is handed, so the two cannot drift.
 */

import { DEFAULT_LANG, modeKey, t } from './i18n.js';
import { effectiveMode, findProfile, missingRequirement, sanitizeDomainRules } from './model.js';
import { buildPacScript } from './pac.js';
import { BLOCKED_PROXY, fallbackConfig, pacRouting, ruleChain } from './proxy.js';
import { canonicalSiteRule, hostMatchesRule } from './site-route.js';

/** Server names are joined with this between them, in every language. */
export const CHAIN_ARROW = ' → ';

/** The first rule in the list that covers this host, or null. */
function firstMatchingRule(rules, host) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (hostMatchesRule(host, rule)) return rule;
  }
  return null;
}

/**
 * Which requirement the current mode is missing, as the key of the sentence that
 * says so. `missingRequirement` is the same reading the status card uses, so the
 * doctor and the card never blame different things.
 */
function noRouteKey(state) {
  switch (missingRequirement(state)) {
    case 'profile':
      return 'route.step.noServer';
    case 'pac':
      return 'route.step.noPacUrl';
    case 'domains':
      return 'route.step.noRules';
    default:
      return 'route.step.noRoute';
  }
}

/**
 * What the configuration does to one host, and why.
 *
 * `effect` is what the browser will be told: `off`, `system`, `direct`, `proxy`
 * (one of the saved servers, possibly the site's own), `pac` (a downloaded script
 * decides) or `blocked` (fail-closed, and no route could be built). `chain` is the
 * servers as they will be tried, `chainSource` whether they are the rule's own, the
 * active server, the shared chain or nothing, and `steps` the reasoning as keys.
 *
 * @param {object} state
 * @param {string} host a hostname, with or without a scheme
 * @param {object|null} [health] per-server verdicts, which decide the chain order
 * @returns {{host: string, mode: string, matchedRule: string|null,
 *            bypassRule: string|null, effect: string, chain: object[],
 *            chainSource: 'rule'|'active'|'shared'|'none',
 *            steps: Array<{key: string, params: object, tone: string}>}}
 */
export function explainRoute(state, host, health = null) {
  const settings = state?.settings ?? {};
  const listed = sanitizeDomainRules(settings.proxyDomains ?? []);
  const bypassed = sanitizeDomainRules(settings.bypassList ?? []);
  const matchedRule = firstMatchingRule(listed, host);
  const bypassRule = firstMatchingRule(bypassed, host);
  const mode = effectiveMode(state);
  // Asked of proxy.js rather than re-derived: the two cannot disagree about what a
  // broken route turns into.
  const blocked = fallbackConfig(state).mode !== 'direct';

  const steps = [];
  const info = {
    host: canonicalSiteRule(host) ?? String(host ?? '').trim().toLowerCase(),
    mode,
    matchedRule,
    bypassRule,
    effect: 'direct',
    chain: [],
    chainSource: 'none',
  };

  const say = (key, params = {}, tone = 'info') => {
    steps.push({ key, params, tone });
  };
  const done = () => ({ ...info, steps });
  const sayChain = () => {
    if (info.chain.length === 0) return;
    say('route.step.chain', { chain: info.chain.map((server) => server.name).join(CHAIN_ARROW) });
  };
  const unavailable = () => {
    info.effect = blocked ? 'blocked' : 'direct';
    info.chain = [];
    info.chainSource = 'none';
    say(noRouteKey(state), {}, 'warn');
    if (blocked) {
      say(
        'route.step.blocked',
        { host: BLOCKED_PROXY.host, port: BLOCKED_PROXY.port },
        'warn',
      );
    } else {
      say('route.step.failOpen', {}, 'warn');
    }
    return done();
  };

  if (!settings.enabled) {
    info.effect = 'off';
    say('route.step.off');
    return done();
  }

  say('route.step.mode', { mode });

  // The bypass list wins over every mode — it is what "never use a proxy" means.
  if (bypassRule) {
    info.effect = 'bypass';
    say('route.step.bypass', { host: info.host, rule: bypassRule }, 'good');
    return done();
  }

  if (mode === 'system' || mode === 'direct') {
    info.effect = mode;
    say(mode === 'system' ? 'route.step.system' : 'route.step.directMode');
    if (listed.length > 0) say('route.step.modeIgnoresList', {}, 'warn');
    return done();
  }

  if (mode === 'fixed_servers') {
    const active = findProfile(state, settings.activeProfileId);
    // Manual mode sends everything through the active server — one server, not a
    // chain — so naming the rest here would describe a route that is not in force.
    if (!active) return unavailable();
    info.effect = 'proxy';
    info.chainSource = 'active';
    info.chain = [active];
    say('route.step.manual', { name: active.name }, 'good');
    // The other servers are not a fallback the browser walks: only the worker can
    // move to one (`lib/failover.js`), and only when it is allowed to.
    if ((state?.profiles ?? []).length > 1) {
      say(settings.autoFailover === true ? 'route.step.manualFailover' : 'route.step.manualAlone');
    }
    return done();
  }

  // pac_script with a URL: the script is somebody else's, so the only honest thing
  // to report is where it comes from.
  if (settings.domainRouting !== true) {
    const url = String(settings.pacUrl ?? '').trim();
    if (!url) return unavailable();
    info.effect = 'pac';
    say('route.step.pacUrl', { url });
    if (listed.length > 0) say('route.step.modeIgnoresList', {}, 'warn');
    return done();
  }

  // Domain routing: the same build `lib/proxy.js` hands the browser, so "there is
  // no script" means the same thing in both places.
  const routing = pacRouting(state, health);
  const bypass = Array.isArray(settings.bypassList) ? [...settings.bypassList] : [];
  if (buildPacScript({ ...routing, bypass }) === null) return unavailable();

  if (!matchedRule) {
    info.effect = 'direct';
    say('route.step.notListed', { host: info.host });
    // Fail-closed covers a route that *breaks*; a host nobody listed was always
    // meant to go direct, and saying so keeps the setting from reading as a promise
    // it does not make.
    if (blocked) say('route.step.notListedClosed');
    return done();
  }

  const route = ruleChain(state, matchedRule, health);
  info.effect = 'proxy';
  info.chain = route.chain;
  info.chainSource = route.own ? 'rule' : 'shared';
  say('route.step.listed', { host: info.host, rule: matchedRule }, 'good');
  if (route.own) {
    say('route.step.ruleServer', { name: findProfile(state, route.profileId)?.name ?? '' }, 'good');
  } else if (route.profileId) {
    // The rule asked for a server that is no longer saved: it keeps working, on the
    // shared chain, and saying so is the difference between a bug and a policy.
    say('route.step.ruleServerGone', {}, 'warn');
  } else {
    say('route.step.sharedChain');
  }
  sayChain();
  if (blocked) say('route.step.failClosedOn');
  return done();
}

/**
 * The steps of one explanation as translated sentences.
 *
 * A step may carry a raw mode id in its `mode` param, which is named here rather
 * than inside the sentence: the explanation holds identifiers, and the language is
 * decided when it is drawn (so the same explanation can be rendered in either
 * language, or tested in both).
 *
 * @param {{steps: Array<{key: string, params: object, tone: string}>}} explanation
 * @param {string} [lang]
 * @returns {Array<{text: string, tone: string}>}
 */
export function routeSentences(explanation, lang = DEFAULT_LANG) {
  return (explanation?.steps ?? []).map((step) => {
    const params = { ...(step.params ?? {}) };
    if (params.mode !== undefined) params.mode = t(modeKey(params.mode), lang);
    return { text: t(step.key, lang, params), tone: step.tone ?? 'info' };
  });
}

/**
 * The chain as one line of names, for a compact place that has no room for the
 * whole explanation (the popup's own line, a rule row).
 */
export function chainLabel(chain) {
  return (Array.isArray(chain) ? chain : []).map((server) => server?.name ?? '').join(CHAIN_ARROW);
}
