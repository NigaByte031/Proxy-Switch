import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState, routingChain, sanitizeState } from '../src/lib/model.js';
import {
  BLOCKED_PROXY,
  REAPPLY_MESSAGE,
  SWITCH_FLASH_MS,
  activeSwitchFlash,
  applyFailureReason,
  applyProxy,
  buildProbeConfig,
  buildProxyConfig,
  describeApplyProblem,
  fallbackConfig,
  pacRouting,
  describeBadge,
  describeStatus,
  describeSwitchBadge,
  isConfigApplied,
  isOwnedByUs,
  requestReapply,
} from '../src/lib/proxy.js';
import { PROBE_TARGETS } from '../src/lib/health.js';
import { MESSAGES, t } from '../src/lib/i18n.js';

const withProfile = (over = {}) =>
  sanitizeState({
    settings: { mode: 'fixed_servers', ...over.settings },
    profiles: [
      {
        id: 'p1',
        name: 'Work',
        scheme: 'socks5',
        host: 'proxy.example.com',
        port: 1080,
        username: 'user',
        password: 'secret',
      },
    ],
  });

test('system mode maps to chrome.proxy system', () => {
  const state = createDefaultState();
  assert.deepEqual(buildProxyConfig(state), { mode: 'system' });
});

test('the master switch forces a direct connection', () => {
  const state = withProfile({ settings: { enabled: false } });
  assert.deepEqual(buildProxyConfig(state), { mode: 'direct' });
});

test('direct mode maps to chrome.proxy direct', () => {
  const state = sanitizeState({ settings: { mode: 'direct' } });
  assert.deepEqual(buildProxyConfig(state), { mode: 'direct' });
});

test('manual mode builds a singleProxy rule with the bypass list', () => {
  const state = withProfile({ settings: { bypassList: ['<local>', '*.internal.example.com'] } });
  assert.deepEqual(buildProxyConfig(state), {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'socks5', host: 'proxy.example.com', port: 1080 },
      bypassList: ['<local>', '*.internal.example.com'],
    },
  });
});

test('manual mode without a usable server fails open to direct', () => {
  const state = createDefaultState();
  state.settings.mode = 'fixed_servers';
  assert.deepEqual(buildProxyConfig(state), { mode: 'direct' });
});

test('fail-closed answers a route that cannot be built with a dead end', () => {
  const state = sanitizeState({ settings: { mode: 'fixed_servers', failClosed: true } });
  assert.deepEqual(buildProxyConfig(state), {
    mode: 'fixed_servers',
    rules: { singleProxy: { ...BLOCKED_PROXY }, bypassList: [] },
  });
  // No bypass list: a bypass would be the leak the setting exists to prevent.
  const blocked = buildProxyConfig(state);
  assert.deepEqual(blocked.rules.bypassList, []);
  assert.equal(BLOCKED_PROXY.host, '127.0.0.1', 'the dead end is not routable anywhere');

  // A PAC mode without a script is the same kind of unbuilt route.
  const pac = sanitizeState({ settings: { mode: 'pac_script', failClosed: true } });
  assert.deepEqual(buildProxyConfig(pac), blocked);

  // The default answer to both is still the friendly one.
  assert.deepEqual(fallbackConfig(createDefaultState()), { mode: 'direct' });
});

test('fail-closed leaves a direct connection the user asked for alone', () => {
  // Picking Direct is a decision, not a fallback; so is switching the extension off.
  const direct = sanitizeState({ settings: { mode: 'direct', failClosed: true } });
  assert.deepEqual(buildProxyConfig(direct), { mode: 'direct' });
  const off = sanitizeState({ settings: { enabled: false, failClosed: true } });
  assert.deepEqual(buildProxyConfig(off), { mode: 'direct' });
});

test('PAC mode builds a pacScript entry and requires a URL', () => {
  const state = sanitizeState({
    settings: { mode: 'pac_script', pacUrl: 'https://example.com/proxy.pac' },
  });
  assert.deepEqual(buildProxyConfig(state), {
    mode: 'pac_script',
    pacScript: { url: 'https://example.com/proxy.pac', mandatory: false },
  });

  const missing = sanitizeState({ settings: { mode: 'pac_script' } });
  assert.deepEqual(buildProxyConfig(missing), { mode: 'direct' });
});

test('domain routing builds a PAC script from the list instead of downloading one', () => {
  const state = withProfile({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      pacUrl: 'https://example.com/ignored.pac',
      proxyDomains: ['example.com', '*.internal.example.com'],
    },
  });

  const config = buildProxyConfig(state);
  assert.equal(config.mode, 'pac_script');
  assert.ok(!('url' in config.pacScript), 'the list wins over the URL while it is on');
  assert.equal(
    config.pacScript.mandatory,
    true,
    'a script we generated must never fall back to a direct connection',
  );
  assert.match(config.pacScript.data, /function FindProxyForURL/);
  assert.match(config.pacScript.data, /SOCKS5 proxy\.example\.com:1080/);
  assert.match(config.pacScript.data, /"example\.com","\*\.internal\.example\.com"/);
});

test('domain routing keeps the bypass list, and fails open without one of its halves', () => {
  const profiles = [
    { id: 'p1', name: 'Work', scheme: 'http', host: 'proxy.example.com', port: 8080 },
  ];

  // the bypass list is compiled into the script, since a PAC config has no rules to carry it
  const withBypass = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      proxyDomains: ['example.com'],
      bypassList: ['<local>', 'safe.example.com'],
      activeProfileId: 'p1',
    },
    profiles,
  });
  const data = buildProxyConfig(withBypass).pacScript.data;
  assert.match(data, /"<local>","safe\.example\.com"/);

  // no server to route through, or no rules to route: direct, like every other mode
  const withoutServer = sanitizeState({ settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com'] } });
  assert.deepEqual(buildProxyConfig(withoutServer), { mode: 'direct' });

  const withoutRules = sanitizeState({
    settings: { mode: 'pac_script', domainRouting: true, activeProfileId: 'p1' },
    profiles,
  });
  assert.deepEqual(buildProxyConfig(withoutRules), { mode: 'direct' });
});

test('the chain puts the active server first and the rest after it, in list order', () => {
  const state = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      proxyDomains: ['example.com'],
      activeProfileId: 'b',
    },
    profiles: [
      { id: 'a', name: 'First', scheme: 'http', host: 'a.example.com', port: 8080 },
      { id: 'b', name: 'Second', scheme: 'socks5', host: 'b.example.com', port: 1080 },
      { id: 'c', name: 'Third', scheme: 'http', host: 'c.example.com', port: 3128 },
    ],
  });

  assert.deepEqual(
    routingChain(state).map((profile) => profile.id),
    ['b', 'a', 'c'],
    'the server in charge gets the first chance on every connection',
  );
  assert.deepEqual(routingChain(sanitizeState({})), [], 'no server means no chain');

  const chain = 'SOCKS5 b.example.com:1080; PROXY a.example.com:8080; PROXY c.example.com:3128';
  assert.ok(
    buildProxyConfig(state).pacScript.data.includes(`var PROXIES = ${JSON.stringify(chain)};`),
    'the script carries every server, active first',
  );
});

test('the generated chain is ordered by the last verdicts about each server', () => {
  const state = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      proxyDomains: ['example.com'],
      activeProfileId: 'a',
    },
    profiles: [
      { id: 'a', name: 'First', scheme: 'http', host: 'a.example.com', port: 8080 },
      { id: 'b', name: 'Second', scheme: 'http', host: 'b.example.com', port: 8080 },
      { id: 'c', name: 'Third', scheme: 'http', host: 'c.example.com', port: 8080 },
    ],
  });
  const chainOf = (config) =>
    JSON.parse(config.pacScript.data.match(/var PROXIES = (.+);\n/)[1]);

  // nothing proven: the chain is the active server first, then the list
  assert.equal(
    chainOf(buildProxyConfig(state)),
    'PROXY a.example.com:8080; PROXY b.example.com:8080; PROXY c.example.com:8080',
  );
  // the slow one is fine, the one that failed goes last
  const at = Date.now();
  const health = {
    a: { ok: true, at, ms: 400 },
    b: { ok: true, at, ms: 90 },
    c: { ok: false, at, ms: null },
  };
  assert.equal(
    chainOf(buildProxyConfig(state, health)),
    'PROXY b.example.com:8080; PROXY a.example.com:8080; PROXY c.example.com:8080',
    'proven-fast first, proven-bad last',
  );

  // a health record with no bearing on this state changes nothing
  assert.equal(
    chainOf(buildProxyConfig(state, { 'someone-else': { ok: false, at, ms: null } })),
    'PROXY a.example.com:8080; PROXY b.example.com:8080; PROXY c.example.com:8080',
  );
});

test('the status card explains what the list is doing, or what it is missing', () => {
  const routing = withProfile({
    settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com', 'a.test'] },
  });
  const status = describeStatus(routing);
  assert.equal(status.tone, 'ok');
  assert.equal(status.title.key, 'status.pacDomains.title');
  assert.deepEqual(status.detail.params, { name: 'Work', count: 2 });

  const empty = describeStatus(
    withProfile({ settings: { mode: 'pac_script', domainRouting: true, proxyDomains: [] } }),
  );
  assert.equal(empty.tone, 'warn');
  assert.equal(empty.title.key, 'status.warnDomains.title');
});

test('the check keeps the user\'s policy and moves only its own probes', () => {
  const health = { p1: { ok: true, at: 1, ms: 20 } };
  const manual = withProfile({ settings: { bypassList: ['<local>'] } });
  const config = buildProbeConfig(manual, { id: 'p2', name: 'Home', scheme: 'socks5', host: 'home.example.net', port: 1080 }, health);

  assert.equal(config.mode, 'pac_script');
  assert.equal(config.pacScript.mandatory, true, 'a script Chrome cannot parse must not go direct');
  // The probe endpoints are what the script knows by name; the configured chain
  // handles everything else.
  for (const target of PROBE_TARGETS) {
    assert.ok(config.pacScript.data.includes(new URL(target).hostname), target);
  }
  assert.match(config.pacScript.data, /PROXIES = "SOCKS5 proxy\.example\.com:1080"/);
  assert.match(config.pacScript.data, /OVERRIDE = "SOCKS5 home\.example\.net:1080"/);
  assert.match(config.pacScript.data, /ALL_HOSTS = true/, 'manual mode routes everything');

  // Domain routing keeps its own shape: the allow list, everything else direct.
  const routing = withProfile({
    settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com'] },
  });
  const routed = buildProbeConfig(routing, manual.profiles[0], null);
  assert.match(routed.pacScript.data, /ALL_HOSTS = false/);
  assert.match(routed.pacScript.data, /"example\.com"/);
  // Modes that are not ours to reproduce are left alone.
  for (const mode of ['system', 'direct']) {
    assert.equal(buildProbeConfig(withProfile({ settings: { mode } }), manual.profiles[0], null), null, mode);
  }
  assert.equal(buildProbeConfig(routing, { name: 'nowhere' }, null), null, 'a server without a host');

  // The check never edits the stored state it was handed.
  assert.deepEqual(manual.settings.bypassList, ['<local>']);
});

test('a listed site goes to the server it named, and the rest share the chain', () => {
  const state = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      activeProfileId: 'p1',
      proxyDomains: ['example.com', 'intra.test', 'other.test'],
      domainServers: { 'intra.test': 'p2', 'other.test': 'p2' },
    },
    profiles: [
      { id: 'p1', name: 'Work', scheme: 'http', host: 'proxy.example.com', port: 8080 },
      { id: 'p2', name: 'Home', scheme: 'socks5', host: 'home.example.net', port: 1080 },
    ],
  });

  const routing = pacRouting(state, null);
  assert.deepEqual(routing.domains, ['example.com'], 'the rules that share the chain');
  // Two rules pointing at one server share one directive, not two entries.
  assert.deepEqual(routing.routes, [
    { directive: 'SOCKS5 home.example.net:1080; PROXY proxy.example.com:8080', hosts: ['intra.test', 'other.test'] },
  ]);

  const data = buildProxyConfig(state, null).pacScript.data;
  assert.match(data, /ROUTED = \["example\.com"\]/);
  assert.match(data, /ROUTES = \[\["SOCKS5 home\.example\.net:1080; PROXY proxy\.example\.com:8080"/);

  // A rule whose server was deleted falls back to the chain instead of vanishing.
  const orphaned = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      activeProfileId: 'p1',
      proxyDomains: ['example.com'],
      domainServers: { 'example.com': 'gone' },
    },
    profiles: [{ id: 'p1', name: 'Work', scheme: 'http', host: 'proxy.example.com', port: 8080 }],
  });
  assert.deepEqual(pacRouting(orphaned, null), {
    servers: orphaned.profiles,
    domains: ['example.com'],
    routes: [],
  });
});

test('the health of a server orders the chain a site of its own takes too', () => {
  const state = sanitizeState({
    settings: {
      mode: 'pac_script',
      domainRouting: true,
      activeProfileId: 'p1',
      proxyDomains: ['intra.test'],
      domainServers: { 'intra.test': 'p2' },
    },
    profiles: [
      { id: 'p1', name: 'Work', scheme: 'http', host: 'proxy.example.com', port: 8080 },
      { id: 'p2', name: 'Home', scheme: 'http', host: 'home.example.net', port: 8080 },
    ],
  });
  const stale = { p1: { ok: false, at: 1 }, p2: { ok: false, at: 1 } };
  const fresh = { p1: { ok: false, at: 1 }, p2: { ok: true, at: Date.now() } };

  const [route] = pacRouting(state, fresh).routes;
  assert.match(route.directive, /^PROXY home\.example\.net:8080/, 'the site its own server first');
  assert.deepEqual(pacRouting(state, stale).servers.map((p) => p.id), ['p1', 'p2']);

  // The shared chain follows the verdicts; a rule that named a server does not,
  // because naming one is an instruction rather than a preference.
  const better = {
    p1: { ok: true, at: Date.now(), ms: 30 },
    p2: { ok: true, at: Date.now(), ms: 900 },
  };
  const [promised] = pacRouting(state, better).routes;
  assert.match(
    promised.directive,
    /^PROXY home\.example\.net:8080/,
    'faster elsewhere never demotes the server the rule named',
  );
});

test('a config the browser no longer reports is not believed', () => {
  const config = {
    mode: 'pac_script',
    pacScript: { data: 'var A = 1;', mandatory: true },
  };
  const current = (value) => ({ value, levelOfControl: 'controlled_by_this_extension' });

  assert.equal(isConfigApplied(current(config), config), true);
  // Somebody applied something else while the probe was in flight: the answer is
  // about that route.
  assert.equal(isConfigApplied(current({ mode: 'system' }), config), false);
  assert.equal(isConfigApplied(current({ ...config, pacScript: { data: 'var B = 2;', mandatory: true } }), config), false);
  assert.equal(isConfigApplied(current({ ...config, pacScript: { data: 'var A = 1;' } }), config), false);
  assert.equal(isConfigApplied(current(null), config), false);
  assert.equal(isConfigApplied(null, config), false);
  // Non-PAC configurations have no data to compare — the mode is the promise.
  assert.equal(isConfigApplied(current({ mode: 'direct' }), { mode: 'direct' }), true);
});

test('buildProxyConfig never aliases the stored bypass list', () => {
  const state = withProfile({ settings: { bypassList: ['<local>'] } });
  const config = buildProxyConfig(state);
  config.rules.bypassList.push('mutated');
  assert.deepEqual(state.settings.bypassList, ['<local>']);
});

test('describeStatus reports tones, i18n keys and parameters', () => {
  const idle = describeStatus({ ...createDefaultState(), settings: { ...createDefaultState().settings, enabled: false } });
  assert.equal(idle.tone, 'idle');
  assert.equal(idle.title.key, 'status.off.title');

  const manual = describeStatus(withProfile());
  assert.equal(manual.tone, 'ok');
  assert.deepEqual(manual.detail.params, {
    name: 'Work',
    scheme: 'socks5',
    host: 'proxy.example.com',
    port: 1080,
  });

  const warn = describeStatus(sanitizeState({ settings: { mode: 'fixed_servers' } }));
  assert.equal(warn.tone, 'warn');
  assert.equal(warn.title.key, 'status.warnProfile.title');
});

test('every status a user can reach has English and Persian text', () => {
  const states = [
    createDefaultState(),
    { ...createDefaultState(), settings: { ...createDefaultState().settings, enabled: false } },
    sanitizeState({ settings: { mode: 'direct' } }),
    sanitizeState({ settings: { mode: 'fixed_servers' } }),
    withProfile(),
    sanitizeState({ settings: { mode: 'pac_script' } }),
    sanitizeState({ settings: { mode: 'pac_script', pacUrl: 'https://example.com/p.pac' } }),
    withProfile({ settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com'] } }),
    withProfile({ settings: { mode: 'pac_script', domainRouting: true, proxyDomains: [] } }),
  ];

  for (const state of states) {
    const status = describeStatus(state);
    assert.ok(['ok', 'idle', 'warn'].includes(status.tone));
    for (const part of [status.title, status.detail]) {
      assert.ok(MESSAGES.en[part.key], `missing en text for ${part.key}`);
      assert.ok(MESSAGES.fa[part.key], `missing fa text for ${part.key}`);
      for (const lang of ['en', 'fa']) {
        const text = t(part.key, lang, part.params);
        assert.notEqual(text, part.key, `${part.key} is not translated in ${lang}`);
        assert.ok(!text.includes('{'), `${part.key} has an unfilled placeholder in ${lang}`);
      }
    }
  }
});

test('describeBadge mirrors the toolbar icon for every mode', () => {
  const cases = [
    ['system', undefined, 'SYS', 'system'],
    ['direct', undefined, 'OFF', 'off'],
    ['fixed_servers', 'p1', 'ON', 'manual'],
    ['pac_script', undefined, 'PAC', 'pac'],
  ];

  for (const [mode, activeProfileId, text, tone] of cases) {
    const state = withProfile({ settings: { mode, activeProfileId } });
    assert.deepEqual(describeBadge(state), { text, tone }, mode);
  }

  // the master switch wins over the mode, and a missing state is "off" too
  assert.deepEqual(describeBadge(withProfile({ settings: { enabled: false } })), {
    text: 'OFF',
    tone: 'off',
  });
  assert.deepEqual(describeBadge(undefined), { text: 'OFF', tone: 'off' });
});

test('an apply problem outranks the mode on the badge', () => {
  const state = withProfile();
  const problem = describeApplyProblem({ failed: 'boom' });
  assert.deepEqual(describeBadge(state, problem), { text: 'ERR', tone: 'error' });
  // without a problem the badge still reports the mode, and a null problem is no problem
  assert.deepEqual(describeBadge(state, null), { text: 'ON', tone: 'manual' });
  assert.deepEqual(describeBadge(state), { text: 'ON', tone: 'manual' });
});

test('a switch badge wears the name of the server that took over', () => {
  assert.deepEqual(describeSwitchBadge({ name: 'Work' }), { text: 'WORK', tone: 'manual' });
  // spaces are dropped, so "Home proxy" still reads as a name
  assert.deepEqual(describeSwitchBadge({ name: 'Home proxy' }), { text: 'HOME', tone: 'manual' });
  assert.equal(describeSwitchBadge({ name: 'یک سرور آزمایشی' }).text.length, 4);
  // nothing to show is not a crash — and never an empty badge
  assert.equal(describeSwitchBadge({ name: '   ' }).text, '→');
  assert.equal(describeSwitchBadge(null).text, '→');

  // the tooltip says the same thing in full, in either language
  for (const lang of ['en', 'fa']) {
    const title = t('badge.switched', lang, { name: 'Work' });
    assert.notEqual(title, 'badge.switched', `${lang} is missing the string`);
    assert.ok(title.includes('Work'), lang);
  }
});

test('a badge flash is dropped once it expires or its server is gone', () => {
  const state = withProfile();
  const flash = { badge: { text: 'WORK', tone: 'manual' }, profileId: 'p1', until: 1000 };

  assert.deepEqual(activeSwitchFlash(flash, state, 999), flash.badge);
  // the expiry is what keeps a terminated worker from leaving the badge lying
  assert.equal(activeSwitchFlash(flash, state, 1000), null);
  assert.ok(SWITCH_FLASH_MS > 1000 && SWITCH_FLASH_MS < 60_000, 'a flash is seconds, not minutes');

  // the user picked another server: that is newer news than the switch
  const picked = sanitizeState({
    settings: { mode: 'fixed_servers', activeProfileId: 'p2' },
    profiles: [
      { id: 'p1', name: 'Work', host: 'a.example.com', port: 1 },
      { id: 'p2', name: 'Home', host: 'b.example.com', port: 2 },
    ],
  });
  assert.equal(activeSwitchFlash(flash, picked, 999), null);

  // nonsensical input is simply "no flash"
  assert.equal(activeSwitchFlash(null, state), null);
  assert.equal(activeSwitchFlash({ badge: flash.badge, profileId: 'p1', until: NaN }, state, 0), null);
  assert.equal(activeSwitchFlash(flash, createDefaultState(), 999), null);
  assert.equal(activeSwitchFlash(flash, undefined, 999), null);
});

/* Applying, and knowing whether it stuck. */

test('the control level Chrome reports decides whether the mode is in force', () => {
  for (const level of [null, undefined, 'controllable_by_this_extension', 'controlled_by_this_extension']) {
    assert.equal(isOwnedByUs(level), true, String(level));
    assert.equal(describeApplyProblem({ levelOfControl: level }), null, String(level));
  }

  for (const level of ['controlled_by_other_extensions', 'not_controllable']) {
    assert.equal(isOwnedByUs(level), false, level);
    const view = describeApplyProblem({ levelOfControl: level });
    assert.equal(view.tone, 'warn');
    assert.equal(view.title.key, 'status.notInControl.title');
    assert.deepEqual(view.detail.params, { level });
  }

  // no outcome at all (nothing was applied yet) is not a problem
  assert.equal(describeApplyProblem(), null);
  assert.equal(describeApplyProblem(null), null, 'a missing status must not throw');
  assert.equal(describeApplyProblem(undefined), null);
  assert.equal(describeApplyProblem('nonsense'), null);
  assert.equal(describeApplyProblem({}), null);
});

test('a failed apply is reported with its reason, and wins over the control level', () => {
  const view = describeApplyProblem({ failed: 'Proxy settings are not writable' });
  assert.equal(view.tone, 'warn');
  assert.equal(view.title.key, 'status.applyFailed.title');
  assert.deepEqual(view.detail.params, { reason: 'Proxy settings are not writable' });

  const both = describeApplyProblem({ failed: 'boom', levelOfControl: 'not_controllable' });
  assert.equal(both.title.key, 'status.applyFailed.title');
});

test('applyFailureReason always produces a storable string', () => {
  assert.equal(applyFailureReason(new Error('nope')), 'nope');
  assert.equal(applyFailureReason('plain string'), 'plain string');
  assert.equal(applyFailureReason({ message: '  spaced  ' }), 'spaced');
  assert.equal(applyFailureReason(undefined), 'unknown error');
  assert.equal(applyFailureReason(new Error('   ')), 'unknown error');
});

test('a route that stopped answering is not a change Chrome refused', () => {
  const route = describeApplyProblem({
    failed: 'net::ERR_PROXY_CONNECTION_FAILED',
    source: 'route',
  });
  assert.equal(route.tone, 'warn');
  assert.equal(route.title.key, 'status.routeFailed.title');
  assert.deepEqual(route.detail.params, { reason: 'net::ERR_PROXY_CONNECTION_FAILED' });

  // A failed apply — and a record from before the two were told apart — says so.
  assert.equal(describeApplyProblem({ failed: 'boom', source: 'apply' }).title.key, 'status.applyFailed.title');
  assert.equal(describeApplyProblem({ failed: 'boom' }).title.key, 'status.applyFailed.title');
  // The route failure is the same problem whatever the control level says.
  assert.equal(
    describeApplyProblem({ failed: 'x', source: 'route', levelOfControl: 'not_controllable' }).title.key,
    'status.routeFailed.title',
  );
});

test('the three apply problems read in both languages, placeholders filled', () => {
  const views = [
    describeApplyProblem({ failed: 'net::ERR_PROXY_CONNECTION_FAILED' }),
    describeApplyProblem({ failed: 'net::ERR_PROXY_CONNECTION_FAILED', source: 'route' }),
    describeApplyProblem({ levelOfControl: 'controlled_by_other_extensions' }),
  ];

  for (const view of views) {
    for (const lang of ['en', 'fa']) {
      for (const part of [view.title, view.detail]) {
        const text = t(part.key, lang, part.params);
        assert.notEqual(text, part.key, `${part.key} is not translated in ${lang}`);
        assert.ok(!text.includes('{'), `${part.key} has an unfilled placeholder in ${lang}`);
      }
    }
  }
});

test('applyProxy reads the control level back instead of assuming it worked', async () => {
  const previous = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    proxy: {
      settings: {
        set: async (details) => calls.push(['set', details]),
        get: async () => {
          calls.push(['get']);
          return { value: { mode: 'system' }, levelOfControl: 'controlled_by_other_extensions' };
        },
      },
    },
  };

  try {
    const state = withProfile();
    const outcome = await applyProxy(state);

    assert.equal(outcome.applied, true);
    assert.equal(outcome.levelOfControl, 'controlled_by_other_extensions');
    assert.deepEqual(outcome.config, buildProxyConfig(state));
    assert.deepEqual(calls[0][0], 'set');
    assert.equal(calls[0][1].scope, 'regular');
    assert.deepEqual(calls[0][1].value, outcome.config);
    assert.equal(calls[1][0], 'get', 'the settings must be read back after writing them');

    // a read-back that throws must not turn a successful apply into a crash
    globalThis.chrome.proxy.settings.get = async () => {
      throw new Error('gone');
    };
    const fallback = await applyProxy(state);
    assert.equal(fallback.applied, true);
    assert.equal(fallback.levelOfControl, null);
  } finally {
    globalThis.chrome = previous;
  }
});

test('requestReapply asks the service worker and hands back the fresh status', async () => {
  const previous = globalThis.chrome;
  const sent = [];
  const healthy = { ok: true, failed: null, levelOfControl: 'controlled_by_this_extension', at: 1 };
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        return { status: healthy };
      },
    },
  };

  try {
    assert.deepEqual(await requestReapply(), healthy);
    assert.deepEqual(sent, [{ type: REAPPLY_MESSAGE }]);

    // nobody listening (the worker is reloading): the caller keeps what it knew
    globalThis.chrome.runtime.sendMessage = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    assert.equal(await requestReapply(), null);

    // an answer without a status is not a status either
    globalThis.chrome.runtime.sendMessage = async () => undefined;
    assert.equal(await requestReapply(), null);
  } finally {
    globalThis.chrome = previous;
  }
});

test('requestReapply is a no-op outside the extension', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    assert.equal(await requestReapply(), null);
  } finally {
    globalThis.chrome = previous;
  }
});

test('applyProxy is a no-op outside the extension', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    const outcome = await applyProxy(sanitizeState({ settings: { mode: 'direct' } }));
    assert.equal(outcome.applied, false);
    assert.equal(outcome.levelOfControl, null);
    assert.deepEqual(outcome.config, { mode: 'direct' });
  } finally {
    globalThis.chrome = previous;
  }
});
