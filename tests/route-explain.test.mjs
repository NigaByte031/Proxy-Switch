import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGES } from '../src/lib/i18n.js';
import { createDefaultState, sanitizeState } from '../src/lib/model.js';
import { buildPacScript, proxyDirective } from '../src/lib/pac.js';
import { buildProxyConfig, pacRouting } from '../src/lib/proxy.js';
import { chainLabel, explainRoute, routeSentences } from '../src/lib/route-explain.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/**
 * The explanation claims to describe what the generated script does, so the script
 * is evaluated for real — the only proof that matters. The PAC helpers are shimmed
 * as the spec defines them, exactly as `tests/pac.test.mjs` does.
 */
const PAC_HELPERS = {
  shExpMatch: (value, pattern) => {
    const source = String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${source}$`).test(String(value));
  },
  isPlainHostName: (host) => !String(host).includes('.'),
  dnsDomainIs: (host, domain) => String(host).endsWith(String(domain)),
  isResolvable: () => false,
  isInNet: () => false,
  dnsResolve: () => null,
  localHostOrDomainIs: (host, hostdom) => host === hostdom,
  myIpAddress: () => '127.0.0.1',
  dnsDomainLevels: (host) => String(host).split('.').length - 1,
};

function ask(script, host) {
  const names = Object.keys(PAC_HELPERS);
  const findProxy = new Function(...names, `${script}\nreturn FindProxyForURL;`)(
    ...Object.values(PAC_HELPERS),
  );
  return findProxy(`https://${host}/`, host);
}

const SERVERS = [
  { id: 'p1', name: 'Frankfurt', scheme: 'https', host: 'de1.example.net', port: 8443 },
  { id: 'p2', name: 'Amsterdam', scheme: 'socks5', host: 'nl1.example.net', port: 1080 },
];

/** A state in domain-routing mode, which is where routing has the most to explain. */
const routing = (settings = {}) =>
  sanitizeState({
    settings: { mode: 'pac_script', domainRouting: true, activeProfileId: 'p1', ...settings },
    profiles: SERVERS,
  });

/** The script the browser is handed for this state (`lib/proxy.js` builds it so). */
const scriptFor = (state, health = null) =>
  buildPacScript({ ...pacRouting(state, health), bypass: state.settings.bypassList });

const keysOf = (explanation) => explanation.steps.map((step) => step.key);

/**
 * A state whose rule still points at a server that is no longer saved. Storage
 * normalises this away; the reader is defensive about one that survived anyway (a
 * hand-edited value, another page's draft).
 */
function danglingServerState() {
  const base = createDefaultState();
  return {
    ...base,
    settings: {
      ...base.settings,
      mode: 'pac_script',
      domainRouting: true,
      activeProfileId: 'p1',
      proxyDomains: ['example.com'],
      domainServers: { 'example.com': 'ghost' },
    },
    profiles: sanitizeState({ profiles: SERVERS }).profiles,
  };
}

test('a listed site with a server of its own is explained down to the chain', () => {
  const state = routing({
    proxyDomains: ['example.com'],
    domainServers: { 'example.com': 'p2' },
  });
  const explanation = explainRoute(state, 'www.example.com');

  assert.equal(explanation.effect, 'proxy');
  assert.equal(explanation.matchedRule, 'example.com');
  assert.equal(explanation.chainSource, 'rule', 'the rule heads its own chain');
  assert.deepEqual(explanation.chain.map((server) => server.name), ['Amsterdam', 'Frankfurt']);
  assert.deepEqual(keysOf(explanation), [
    'route.step.mode',
    'route.step.listed',
    'route.step.ruleServer',
    'route.step.chain',
  ]);
});

test('a rule that named a server keeps it first, whatever the verdicts say', () => {
  const state = routing({ proxyDomains: ['example.com'], domainServers: { 'example.com': 'p2' } });
  // The other server is faster and fresher, and still does not take the head: the
  // rule names the one the site goes through.
  const health = {
    p1: { ok: true, at: Date.now(), ms: 20 },
    p2: { ok: true, at: Date.now(), ms: 900 },
  };
  const explanation = explainRoute(state, 'example.com', health);

  assert.deepEqual(explanation.chain.map((server) => server.name), ['Amsterdam', 'Frankfurt']);
  assert.equal(
    ask(scriptFor(state, health), 'example.com'),
    'SOCKS5 nl1.example.net:1080; HTTPS de1.example.net:8443',
  );
});

test('a listed site without its own server wears the chain every listed site shares', () => {
  const state = routing({ proxyDomains: ['example.com'] });
  const explanation = explainRoute(state, 'example.com');

  assert.equal(explanation.effect, 'proxy');
  assert.equal(explanation.chainSource, 'shared');
  assert.deepEqual(explanation.chain.map((server) => server.name), ['Frankfurt', 'Amsterdam']);
  assert.ok(keysOf(explanation).includes('route.step.sharedChain'));
});

test('a host nobody listed goes direct, and the explanation says why', () => {
  const state = routing({ proxyDomains: ['example.com'] });
  const explanation = explainRoute(state, 'other.org');

  assert.equal(explanation.effect, 'direct');
  assert.equal(explanation.matchedRule, null);
  assert.deepEqual(explanation.chain, []);
  assert.deepEqual(keysOf(explanation), ['route.step.mode', 'route.step.notListed']);
});

test('the bypass list outranks the listed sites, as it does in the script', () => {
  const state = routing({
    proxyDomains: ['example.com'],
    bypassList: ['<local>', 'example.com'],
  });

  for (const host of ['example.com', 'www.example.com', 'intranet']) {
    const explanation = explainRoute(state, host);
    assert.equal(explanation.effect, 'bypass', `${host} is bypassed`);
    assert.ok(explanation.bypassRule, `${host} names the rule that bypassed it`);
  }
  assert.equal(explainRoute(state, 'intranet').bypassRule, '<local>');
});

test('every mode says what it is, and where the list stands in it', () => {
  const off = explainRoute(sanitizeState({ settings: { enabled: false } }), 'example.com');
  assert.equal(off.effect, 'off');
  assert.deepEqual(keysOf(off), ['route.step.off']);

  const direct = explainRoute(sanitizeState({ settings: { mode: 'direct' } }), 'example.com');
  assert.equal(direct.effect, 'direct');
  assert.deepEqual(keysOf(direct), ['route.step.mode', 'route.step.directMode']);

  const system = explainRoute(
    sanitizeState({ settings: { mode: 'system', proxyDomains: ['example.com'] } }),
    'example.com',
  );
  assert.equal(system.effect, 'system');
  // A list that does nothing in this mode is worth a warning, not silence.
  assert.deepEqual(keysOf(system), [
    'route.step.mode',
    'route.step.system',
    'route.step.modeIgnoresList',
  ]);

  const manual = explainRoute(
    sanitizeState({
      settings: { mode: 'fixed_servers', activeProfileId: 'p1' },
      profiles: SERVERS,
    }),
    'example.com',
  );
  assert.equal(manual.effect, 'proxy');
  // Manual mode uses one server, not a chain: naming the rest would describe a
  // route that is not in force.
  assert.deepEqual(manual.chain.map((server) => server.name), ['Frankfurt']);
  assert.equal(manual.chainSource, 'active');
  assert.deepEqual(keysOf(manual), [
    'route.step.mode',
    'route.step.manual',
    'route.step.manualFailover',
  ]);

  const downloaded = explainRoute(
    sanitizeState({ settings: { mode: 'pac_script', pacUrl: 'https://example.com/p.pac' } }),
    'example.com',
  );
  assert.equal(downloaded.effect, 'pac');
  assert.deepEqual(keysOf(downloaded), ['route.step.mode', 'route.step.pacUrl']);
  assert.equal(downloaded.steps[1].params.url, 'https://example.com/p.pac');
});

test('a route that cannot be built is direct by default and blocked when asked', () => {
  const open = explainRoute(sanitizeState({ settings: { mode: 'pac_script', domainRouting: true } }), 'example.com');
  assert.equal(open.effect, 'direct', 'fail-open is still the default');
  assert.deepEqual(keysOf(open), ['route.step.mode', 'route.step.noServer', 'route.step.failOpen']);

  const closed = explainRoute(
    sanitizeState({ settings: { mode: 'pac_script', domainRouting: true, failClosed: true } }),
    'example.com',
  );
  assert.equal(closed.effect, 'blocked');
  assert.deepEqual(keysOf(closed), [
    'route.step.mode',
    'route.step.noServer',
    'route.step.blocked',
  ]);
  // It names the dead end, because "blocked" is a claim worth checking.
  assert.match(routeSentences(closed, 'en')[2].text, /127\.0\.0\.1:1/);

  // Each of the three unbuilt routes is blamed for the right missing piece.
  const noRules = explainRoute(routing({ proxyDomains: [] }), 'example.com');
  assert.equal(noRules.effect, 'direct');
  assert.ok(keysOf(noRules).includes('route.step.noRules'));

  const noPac = explainRoute(sanitizeState({ settings: { mode: 'pac_script' } }), 'example.com');
  assert.ok(keysOf(noPac).includes('route.step.noPacUrl'));

  const noServer = explainRoute(
    sanitizeState({ settings: { mode: 'fixed_servers', failClosed: true } }),
    'example.com',
  );
  assert.equal(noServer.effect, 'blocked');
  assert.ok(keysOf(noServer).includes('route.step.noServer'));
});

test('fail-closed does not touch a direct connection the user asked for', () => {
  const direct = sanitizeState({ settings: { mode: 'direct', failClosed: true, proxyDomains: ['example.com'] } });
  const explanation = explainRoute(direct, 'example.com');
  assert.equal(explanation.effect, 'direct');
  assert.ok(!keysOf(explanation).includes('route.step.blocked'));
  assert.deepEqual(buildProxyConfig(direct), { mode: 'direct' });
});

test('an unlisted host under fail-closed is still direct, and the explanation says so', () => {
  const state = routing({ proxyDomains: ['example.com'], failClosed: true });
  const explanation = explainRoute(state, 'other.org');

  assert.equal(explanation.effect, 'direct');
  assert.ok(
    keysOf(explanation).includes('route.step.notListedClosed'),
    'the setting covers a route that breaks, not a host nobody listed',
  );
  // A listed host, by contrast, hears that the chain is all it has.
  assert.ok(keysOf(explainRoute(state, 'example.com')).includes('route.step.failClosedOn'));
});

test('a rule whose server is gone falls back to the shared chain, and says so', () => {
  const explanation = explainRoute(danglingServerState(), 'example.com');

  assert.equal(explanation.effect, 'proxy');
  assert.equal(explanation.chainSource, 'shared');
  assert.ok(keysOf(explanation).includes('route.step.ruleServerGone'));
});

test('the chain follows the verdicts, and the script walks the same order', () => {
  const state = routing({ proxyDomains: ['example.com'] });
  const health = {
    p1: { ok: true, at: Date.now(), ms: 400 },
    p2: { ok: true, at: Date.now(), ms: 90 },
  };
  const explanation = explainRoute(state, 'example.com', health);

  assert.deepEqual(explanation.chain.map((server) => server.name), ['Amsterdam', 'Frankfurt']);
  assert.equal(chainLabel(explanation.chain), 'Amsterdam → Frankfurt');
  assert.equal(ask(scriptFor(state, health), 'example.com'), 'SOCKS5 nl1.example.net:1080; HTTPS de1.example.net:8443');
});

test('the explanation and the generated script agree about every host', () => {
  const state = routing({
    proxyDomains: ['example.com', 'intra.test'],
    domainServers: { 'intra.test': 'p2' },
    bypassList: ['<local>', 'skip.example.com'],
  });
  const config = buildProxyConfig(state);
  assert.equal(config.mode, 'pac_script', 'this test is about the script, so it has to exist');
  const script = scriptFor(state);

  const hosts = [
    'example.com',
    'www.example.com',
    'deep.www.example.com',
    'intra.test',
    'other.org',
    'notexample.com',
    'skip.example.com',
    'intranet',
  ];
  for (const host of hosts) {
    const { effect, chain } = explainRoute(state, host);
    const answer = ask(script, host);
    assert.equal(effect === 'proxy', answer !== 'DIRECT', `${host}: ${effect} vs ${answer}`);
    // And when it does go through, the servers are named in the order tried.
    if (effect === 'proxy') {
      assert.equal(answer, chain.map(proxyDirective).join('; '), `${host} chain`);
    }
  }
});

test('every sentence has English and Persian text, and no placeholder is left', () => {
  const scenarios = [
    [routing({ proxyDomains: ['example.com'], domainServers: { 'example.com': 'p2' } }), 'www.example.com'],
    [routing({ proxyDomains: ['example.com'], failClosed: true }), 'other.org'],
    [routing({ proxyDomains: ['example.com'], failClosed: true }), 'example.com'],
    [routing({ proxyDomains: [] }), 'example.com'],
    [routing({ proxyDomains: [], failClosed: true }), 'example.com'],
    [danglingServerState(), 'example.com'],
    [routing({ bypassList: ['example.com'] }), 'example.com'],
    [sanitizeState({ settings: { enabled: false } }), 'example.com'],
    [sanitizeState({ settings: { mode: 'direct', proxyDomains: ['example.com'] } }), 'example.com'],
    [sanitizeState({ settings: { mode: 'system' } }), 'example.com'],
    [sanitizeState({ settings: { mode: 'fixed_servers' } }), 'example.com'],
    [sanitizeState({ settings: { mode: 'pac_script' } }), 'example.com'],
    [
      sanitizeState({ settings: { mode: 'pac_script', pacUrl: 'https://example.com/p.pac' } }),
      'example.com',
    ],
    [
      sanitizeState({
        settings: { mode: 'fixed_servers', activeProfileId: 'p1' },
        profiles: SERVERS,
      }),
      'example.com',
    ],
    [
      sanitizeState({
        settings: { mode: 'fixed_servers', activeProfileId: 'p1', autoFailover: false },
        profiles: SERVERS,
      }),
      'example.com',
    ],
  ];

  const seen = new Set();
  for (const [state, host] of scenarios) {
    const explanation = explainRoute(state, host);
    const sentences = { en: routeSentences(explanation, 'en'), fa: routeSentences(explanation, 'fa') };
    explanation.steps.forEach((step, index) => {
      seen.add(step.key);
      for (const lang of ['en', 'fa']) {
        const { text, tone } = sentences[lang][index];
        assert.ok(!text.startsWith('route.'), `${lang} has no text for ${step.key}`);
        assert.ok(!/\{[a-z]+\}/.test(text), `${lang} left a placeholder in: ${text}`);
        assert.ok(['info', 'good', 'warn'].includes(tone), `bad tone ${tone}`);
      }
    });
  }

  // Every step key the dictionaries carry is reachable from a real configuration;
  // `route.step.noRoute` is the switch's catch-all for a combination
  // `missingRequirement` cannot name, so it is exempt on purpose.
  const defined = Object.keys(MESSAGES.en).filter((key) => key.startsWith('route.step.'));
  assert.deepEqual(
    [...seen].sort(),
    defined.filter((key) => key !== 'route.step.noRoute').sort(),
  );
  for (const key of defined) {
    assert.ok(MESSAGES.fa[key], `${key} has no Persian text`);
  }
});

test('the pages wire the route check, the Why? disclosure and the switch', () => {
  const optionsHtml = read('src/options.html');
  assert.match(optionsHtml, /id="routeCheckHost"/);
  assert.match(optionsHtml, /id="routeCheckSteps"/);
  assert.match(optionsHtml, /id="failClosedToggle"/);
  assert.match(optionsHtml, /data-i18n="route\.check\.title"/);
  assert.match(optionsHtml, /data-i18n="options\.failClosed"/);
  // The check belongs with the list it explains, inside the domain-routing panel.
  assert.ok(
    optionsHtml.indexOf('id="routeCheckHost"') > optionsHtml.indexOf('id="pacDomainsPanel"') &&
      optionsHtml.indexOf('id="routeCheckHost"') < optionsHtml.indexOf('id="pacDomainsSave"'),
  );

  const popupHtml = read('src/popup.html');
  assert.match(popupHtml, /id="siteWhy"/);
  assert.match(popupHtml, /id="siteWhySteps"/);
  assert.ok(popupHtml.indexOf('id="siteWhySteps"') > popupHtml.indexOf('id="siteEffect"'));

  const popup = read('src/popup.js');
  assert.match(popup, /import \{ explainRoute \} from '\.\/lib\/route-explain\.js'/);
  assert.match(popup, /renderRouteSteps\(els\.siteWhySteps, explainRoute\(/);
  assert.match(popup, /siteWhyOpen = !siteWhyOpen/);

  const options = read('src/options.js');
  assert.match(options, /routeCheckInputEl: el\('routeCheckHost'\)/);
  assert.match(options, /getHealth: \(\) => serverHealth/);
  assert.match(options, /draft\.settings\.failClosed = failClosed/);
  assert.match(options, /els\.failClosedToggle\.checked = state\.settings\.failClosed === true/);

  const modeUi = read('src/lib/mode-ui.js');
  assert.match(modeUi, /renderRouteCheck\(lang\)/);
  assert.match(modeUi, /explainRoute\(lastState, host, getHealth\(\)\)/);

  // A tone the stylesheet does not know would render as the neutral one, silently.
  const css = read('src/styles/base.css');
  for (const tone of ['good', 'warn']) {
    assert.match(css, new RegExp(`\\.route-step-${tone} \\{`), `no colour for ${tone}`);
  }
  assert.match(css, /\.route-step-empty \{/);
  assert.match(read('src/styles/popup.css'), /\.why-btn \{/);
});
