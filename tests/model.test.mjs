import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BYPASS_LIST,
  EXPORT_FORMAT,
  PROFILE_SEARCH_THRESHOLD,
  PROXY_MODES,
  STATE_VERSION,
  bracketIfIpv6,
  createDefaultState,
  createProfile,
  effectiveMode,
  filterProfiles,
  findProfile,
  formatBypassList,
  formatDomainList,
  formatProfileAddress,
  isValidHost,
  isValidPacUrl,
  missingRequirement,
  newId,
  normalizeDomainRule,
  normalizeHost,
  parseBypassList,
  parseDomainRules,
  sanitizeDomainRules,
  parseImport,
  parseProxyUrl,
  profileSearchText,
  sanitizeState,
  serializeState,
  shouldShowSearch,
  splitHostPort,
  uniqueProfileName,
  validateProfile,
} from '../src/lib/model.js';

const draft = (over = {}) => ({
  name: 'Work',
  scheme: 'socks5',
  host: '127.0.0.1',
  port: '1080',
  username: 'user',
  password: 'secret',
  ...over,
});

test('createDefaultState is a valid, empty state', () => {
  const state = createDefaultState();
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(state.profiles, []);
  assert.equal(state.settings.mode, 'system');
  assert.equal(state.settings.enabled, true);
  assert.equal(state.settings.language, 'auto');
  assert.equal(state.settings.activeProfileId, null);
  assert.equal(state.settings.autoFailover, true);
  assert.equal(state.settings.notifyFailover, true);
  assert.equal(state.settings.backgroundProbe, false, 'nothing uses the network on its own by default');
  assert.equal(state.settings.domainRouting, false);
  assert.deepEqual(state.settings.proxyDomains, []);
  assert.deepEqual(state.settings.bypassList, DEFAULT_BYPASS_LIST);
  // defaults must survive a round trip through sanitizeState
  assert.deepEqual(sanitizeState(state), state);
});

test('effectiveMode turns the master switch into "direct"', () => {
  const state = sanitizeState({
    settings: { mode: 'fixed_servers', enabled: false },
    profiles: [draft()],
  });
  assert.equal(state.settings.mode, 'fixed_servers');
  assert.equal(effectiveMode(state), 'direct');
  state.settings.enabled = true;
  assert.equal(effectiveMode(state), 'fixed_servers');
});

test('validateProfile accepts a well formed server', () => {
  const result = validateProfile(draft());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.profile.host, '127.0.0.1');
  assert.equal(result.profile.port, 1080);
  assert.equal(result.profile.scheme, 'socks5');
  assert.ok(result.profile.id);
});

test('validateProfile reports every missing field with an i18n key', () => {
  const result = validateProfile({ name: '', host: '', port: '' });
  assert.equal(result.ok, false);
  assert.equal(result.errors.name, 'error.nameRequired');
  assert.equal(result.errors.host, 'error.hostRequired');
  assert.equal(result.errors.port, 'error.portRequired');
  assert.equal(result.profile, null);
});

test('validateProfile rejects duplicates, bad ports and bad hosts', () => {
  const existing = [createProfile(draft({ id: 'p1' }))];

  assert.equal(validateProfile(draft({ name: 'work' }), { profiles: existing }).errors.name, 'error.nameDuplicate');
  // the edited profile itself is allowed to keep its name
  assert.equal(validateProfile(draft({ name: 'Work' }), { profiles: existing, editingId: 'p1' }).ok, true);

  assert.equal(validateProfile(draft({ port: '0' })).errors.port, 'error.portRange');
  assert.equal(validateProfile(draft({ port: '70000' })).errors.port, 'error.portRange');
  assert.equal(validateProfile(draft({ port: 'abc' })).errors.port, 'error.portInvalid');
  assert.equal(validateProfile(draft({ host: 'http://' })).errors.host, 'error.hostRequired');
  assert.equal(validateProfile(draft({ host: 'bad host' })).errors.host, 'error.hostInvalid');
});

test('a pasted host:port fills both fields', () => {
  assert.deepEqual(splitHostPort('proxy.example.com:8080', ''), {
    host: 'proxy.example.com',
    port: '8080',
  });
  // an explicit port field wins
  assert.deepEqual(splitHostPort('proxy.example.com:8080', '3128'), {
    host: 'proxy.example.com',
    port: '3128',
  });
  assert.deepEqual(splitHostPort('[::1]:8080', ''), { host: '[::1]', port: '8080' });
  assert.deepEqual(splitHostPort('::1', ''), { host: '[::1]', port: '' });

  const result = validateProfile(draft({ host: 'http://proxy.example.com:8080/path', port: '' }));
  assert.equal(result.ok, true);
  assert.equal(result.profile.host, 'proxy.example.com');
  assert.equal(result.profile.port, 8080);
});

test('host helpers', () => {
  assert.equal(normalizeHost('  https://user:pass@Host.EXAMPLE.com:8080/pac?x=1#y '), 'Host.EXAMPLE.com:8080');
  assert.equal(bracketIfIpv6('::1'), '[::1]');
  assert.equal(bracketIfIpv6('[2001:db8::1]'), '[2001:db8::1]');
  assert.equal(bracketIfIpv6('host:8080'), 'host:8080');

  assert.equal(isValidHost('proxy.example.com'), true);
  assert.equal(isValidHost('localhost'), true);
  assert.equal(isValidHost('مثال.ایران'), true);
  assert.equal(isValidHost('[::1]'), true);
  assert.equal(isValidHost('::1'), false);
  assert.equal(isValidHost(''), false);
  assert.equal(isValidHost('has space'), false);
  assert.equal(isValidHost('user@host'), false);
  assert.equal(isValidHost('host/path'), false);
  assert.equal(isValidHost('a'.repeat(254)), false);

  assert.equal(isValidPacUrl('https://example.com/proxy.pac'), true);
  assert.equal(isValidPacUrl('http://example.com/proxy.pac'), true);
  assert.equal(isValidPacUrl('example.com/proxy.pac'), false);
  assert.equal(isValidPacUrl('file:///tmp/proxy.pac'), false);
});

test('bypass list parsing trims, drops blanks and de-duplicates', () => {
  const parsed = parseBypassList('  <local> \n\nlocalhost\nlocalhost\n  *.example.com  \n');
  assert.deepEqual(parsed, ['<local>', 'localhost', '*.example.com']);
  assert.equal(formatBypassList(parsed), '<local>\nlocalhost\n*.example.com');
  assert.deepEqual(parseBypassList(''), []);
  assert.equal(formatBypassList(undefined), '');
});

test('the domain list is read the way people type it', () => {
  const typed = [
    'example.com',
    '# the intranet, and every subdomain of it',
    '*.internal.example.com',
    '  Example.COM  ',
    'https://pasted.example.net/some/page?q=1#frag',
    '<local>',
    '[::1]',
    'host:8080',
    'has space',
    'user:pass@host.example',
    '-',
    '',
  ].join('\n');

  assert.deepEqual(parseDomainRules(typed), [
    'example.com',
    '*.internal.example.com',
    'pasted.example.net',
    '<local>',
    '[::1]',
  ]);
  // a rule is a host pattern, so a pattern is never read as a URL
  assert.equal(normalizeDomainRule('shop?.example.com'), 'shop?.example.com');
  assert.equal(normalizeDomainRule('https://example.com/a/b'), 'example.com');
  assert.equal(normalizeDomainRule('   '), null);
  assert.equal(normalizeDomainRule('# only a comment'), null);
  // de-duplication ignores case, and blank input is an empty list
  assert.deepEqual(sanitizeDomainRules(['A.test', 'a.TEST']), ['A.test']);
  assert.deepEqual(sanitizeDomainRules(undefined), []);
  assert.equal(formatDomainList(['example.com', 'host:80', 'example.com']), 'example.com');
});

const routingState = (settings = {}) =>
  sanitizeState({
    settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com'], ...settings },
    profiles: [draft()],
  });

test('domain routing has to have both a server and something to route', () => {
  assert.equal(missingRequirement(routingState()), null);
  assert.equal(missingRequirement(routingState({ proxyDomains: [] })), 'domains');
  assert.equal(
    missingRequirement(
      sanitizeState({ settings: { mode: 'pac_script', domainRouting: true, proxyDomains: ['x.test'] } }),
    ),
    'profile',
    'the server is asked for first — without one there is nothing to route through',
  );

  // and the same state with the list switched off is an ordinary PAC mode again
  assert.equal(missingRequirement(routingState({ domainRouting: false, pacUrl: '' })), 'pac');
  assert.equal(
    missingRequirement(routingState({ domainRouting: false, pacUrl: 'https://x/p.pac' })),
    null,
  );
});

test('the domain list survives storage, export and a broken value', () => {
  const state = routingState();
  assert.equal(sanitizeState(state).settings.domainRouting, true);
  assert.deepEqual(sanitizeState(state).settings.proxyDomains, ['example.com']);

  const exported = serializeState(state);
  const imported = parseImport(JSON.stringify(exported));
  assert.deepEqual(imported.state.settings.proxyDomains, ['example.com']);
  assert.equal(imported.state.settings.domainRouting, true);

  // hand-edited storage cannot smuggle rules that never match a host
  const repaired = sanitizeState({
    settings: { domainRouting: 'yes', proxyDomains: ['ok.test', 'no space', 'x:1', 'ok.test'] },
  });
  assert.equal(repaired.settings.domainRouting, false, 'a string is not a boolean');
  assert.deepEqual(repaired.settings.proxyDomains, ['ok.test']);
  assert.deepEqual(sanitizeState({ settings: { proxyDomains: 'example.com' } }).settings.proxyDomains, []);
});

test('a listed site keeps the server it was given, and loses it with the rule', () => {
  const state = sanitizeState({
    settings: {
      domainRouting: true,
      mode: 'pac_script',
      proxyDomains: ['example.com', 'intra.test'],
      domainServers: { 'Example.com': 'p2', 'intra.test': 'p2', 'gone.test': 'p2' },
    },
    profiles: [draft({ id: 'p1' }), draft({ id: 'p2', host: '10.0.0.1' })],
  });
  // the key is written back in the rule's own spelling, not the one it arrived in
  assert.deepEqual(state.settings.domainServers, { 'example.com': 'p2', 'intra.test': 'p2' });

  // the server is gone: the rule stays, and falls back to the shared chain
  const orphaned = sanitizeState({
    settings: { proxyDomains: ['example.com'], domainServers: { 'example.com': 'missing' } },
    profiles: [draft({ id: 'p1' })],
  });
  assert.deepEqual(orphaned.settings.proxyDomains, ['example.com']);
  assert.deepEqual(orphaned.settings.domainServers, {});

  // a rule that no longer exists cannot keep a server waiting for it
  const dropped = sanitizeState({
    settings: { proxyDomains: [], domainServers: { 'example.com': 'p1' } },
    profiles: [draft({ id: 'p1' })],
  });
  assert.deepEqual(dropped.settings.domainServers, {});

  assert.deepEqual(sanitizeState({}).settings.domainServers, {});
  assert.deepEqual(sanitizeState({ settings: { domainServers: 'nope' } }).settings.domainServers, {});
  assert.deepEqual(
    sanitizeState({ settings: { proxyDomains: ['a.test'], domainServers: ['p1'] } }).settings
      .domainServers,
    {},
  );

  const imported = parseImport(JSON.stringify(serializeState(state)));
  assert.deepEqual(imported.state.settings.domainServers, {
    'example.com': 'p2',
    'intra.test': 'p2',
  });
});

test('newId is unique and findProfile tolerates unknown ids', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId()));
  assert.equal(ids.size, 200);
  const state = sanitizeState({ profiles: [draft()] });
  assert.ok(findProfile(state, state.profiles[0].id));
  assert.equal(findProfile(state, 'missing'), null);
  assert.equal(findProfile(state, null), null);
});

test('uniqueProfileName appends a counter until the name is free', () => {
  const profiles = [{ name: 'New server' }, { name: 'New server 2' }];
  assert.equal(uniqueProfileName(profiles, 'New server'), 'New server 3');
  assert.equal(uniqueProfileName(profiles, 'Other'), 'Other');
});

test('formatProfileAddress never leaks the password', () => {
  const profile = createProfile(draft());
  assert.equal(formatProfileAddress(profile), 'socks5://127.0.0.1:1080 · user');
  assert.equal(formatProfileAddress(createProfile(draft({ username: '' }))), 'socks5://127.0.0.1:1080');
  assert.equal(formatProfileAddress(null), '');
});

/* Searching the server list. */

const searchable = () =>
  sanitizeState({
    profiles: [
      { id: 'a', name: 'Home proxy', scheme: 'socks5', host: '127.0.0.1', port: 1080 },
      {
        id: 'b',
        name: 'Work HTTP',
        scheme: 'http',
        host: 'proxy.work.example.com',
        port: 8080,
        username: 'alice',
        password: 'hunter2',
      },
      { id: 'c', name: 'Café', scheme: 'https', host: 'cafe.example.ir', port: 3128 },
    ],
  }).profiles;

const names = (list) => list.map((profile) => profile.name);

test('profileSearchText covers what the row shows and nothing else', () => {
  const text = profileSearchText(searchable()[1]);
  assert.match(text, /work http/);
  assert.match(text, /proxy\.work\.example\.com/);
  assert.match(text, /8080/);
  assert.match(text, /alice/);
  // a password is never rendered, so it must never match a search either
  assert.ok(!text.includes('hunter2'));
  assert.equal(profileSearchText(null), '');
});

test('filterProfiles matches name, host, scheme, port and username', () => {
  const profiles = searchable();
  assert.deepEqual(names(filterProfiles(profiles, 'work')), ['Work HTTP']);
  assert.deepEqual(names(filterProfiles(profiles, 'example.com')), ['Work HTTP']);
  assert.deepEqual(names(filterProfiles(profiles, 'socks5')), ['Home proxy']);
  assert.deepEqual(names(filterProfiles(profiles, '3128')), ['Café']);
  assert.deepEqual(names(filterProfiles(profiles, 'ALICE')), ['Work HTTP']);
  // unicode names are searchable too
  assert.deepEqual(names(filterProfiles(profiles, 'café')), ['Café']);
});

test('every word of a query has to match, in any order', () => {
  const profiles = searchable();
  assert.deepEqual(names(filterProfiles(profiles, 'http work')), ['Work HTTP']);
  assert.deepEqual(names(filterProfiles(profiles, 'work http')), ['Work HTTP']);
  assert.deepEqual(names(filterProfiles(profiles, 'http 8080')), ['Work HTTP']);
  // one unsatisfied term is enough to rule a row out
  assert.deepEqual(filterProfiles(profiles, 'work socks5'), []);
  assert.deepEqual(filterProfiles(profiles, 'nothing here'), []);
});

test('a blank query is not a filter and the input is never mutated', () => {
  const profiles = searchable();
  for (const blank of ['', '   ', '\t\n', null, undefined]) {
    const result = filterProfiles(profiles, blank);
    assert.equal(result.length, profiles.length, `query: ${JSON.stringify(blank)}`);
  }
  assert.equal(filterProfiles(profiles, '')[0], profiles[0], 'rows should pass through untouched');
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(filterProfiles(junk, 'x'), []);
  }
});

test('the search box only shows up when it earns its place', () => {
  assert.ok(PROFILE_SEARCH_THRESHOLD >= 3, 'a search box for two rows would be noise');
  assert.equal(shouldShowSearch(0), false);
  assert.equal(shouldShowSearch(PROFILE_SEARCH_THRESHOLD - 1), false);
  assert.equal(shouldShowSearch(PROFILE_SEARCH_THRESHOLD), true);
  assert.equal(shouldShowSearch(50), true);
  // an active query keeps it on screen, otherwise it could never be cleared
  assert.equal(shouldShowSearch(1, 'wo'), true);
  assert.equal(shouldShowSearch(1, '   '), false);
});

test('sanitizeState repairs garbage instead of throwing', () => {
  assert.deepEqual(sanitizeState(null), createDefaultState());
  assert.deepEqual(sanitizeState('nonsense'), createDefaultState());
  assert.deepEqual(sanitizeState({ profiles: 'nope' }), createDefaultState());

  const state = sanitizeState({
    settings: { mode: 'wat', enabled: 'yes', language: 'de', bypassList: [' ok ', ''], notifyFailover: false },
    profiles: [{ host: 'example.com', port: '99999' }, { host: '' }, null],
  });
  assert.equal(state.settings.notifyFailover, false, 'the opt-out is a boolean and survives');
  assert.equal(sanitizeState({ settings: { notifyFailover: 'yes' } }).settings.notifyFailover, true);
  assert.equal(sanitizeState({ settings: { backgroundProbe: true } }).settings.backgroundProbe, true);
  assert.equal(
    sanitizeState({ settings: { backgroundProbe: 'on' } }).settings.backgroundProbe,
    false,
    'only a real boolean turns the checks on',
  );
  assert.equal(state.settings.mode, 'system');
  assert.equal(state.settings.enabled, true);
  assert.equal(state.settings.language, 'auto');
  assert.deepEqual(state.settings.bypassList, ['ok']);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].port, 8080);
  assert.equal(state.profiles[0].name, 'example.com');
  assert.equal(state.settings.activeProfileId, state.profiles[0].id);
});

test('a saved server whose host carries its own port is split, not dropped', () => {
  // Another tool's export, or a hand-edited file. Losing the server silently — which
  // is what the host field used to cost — is worse than reading it as the form does.
  const state = sanitizeState({
    profiles: [
      { name: 'Pasted', host: 'proxy.example.com:8080' },
      { name: 'URL', host: 'http://other.example.com:3128/path' },
      { name: 'Both', host: 'third.example.com:999', port: 1080 },
      { name: 'Garbage', host: 'not a host:80' },
    ],
  });

  assert.deepEqual(
    state.profiles.map((profile) => [profile.name, profile.host, profile.port]),
    [
      ['Pasted', 'proxy.example.com', 8080],
      ['URL', 'other.example.com', 3128],
      ['Both', 'third.example.com', 1080],
    ],
    'the port field wins when it says something, and a host that is still nonsense is still dropped',
  );
  // The name still falls back to the host, without the port glued to it.
  assert.equal(sanitizeState({ profiles: [{ host: 'a.example.com:1' }] }).profiles[0].name, 'a.example.com');
});

test('sanitizeState keeps a stable active profile and unique ids', () => {
  const state = sanitizeState({
    settings: { activeProfileId: 'p1' },
    profiles: [
      { id: 'p1', host: 'a.example.com', port: 1, name: 'A' },
      { id: 'p1', host: 'b.example.com', port: 2, name: 'B' },
    ],
  });
  assert.equal(state.settings.activeProfileId, 'p1');
  assert.equal(new Set(state.profiles.map((profile) => profile.id)).size, 2);

  const fallback = sanitizeState({
    settings: { activeProfileId: 'gone' },
    profiles: [{ id: 'x', host: 'a.example.com', port: 1, name: 'A' }],
  });
  assert.equal(fallback.settings.activeProfileId, 'x');
});

test('export and import round trip', () => {
  const original = sanitizeState({
    settings: { mode: 'fixed_servers', pacUrl: 'https://example.com/p.pac', bypassList: ['<local>'] },
    profiles: [draft()],
  });
  const exported = serializeState(original, new Date('2026-01-02T03:04:05.000Z'));

  assert.equal(exported.format, EXPORT_FORMAT);
  assert.equal(exported.version, STATE_VERSION);
  assert.equal(exported.exportedAt, '2026-01-02T03:04:05.000Z');

  const text = JSON.stringify(exported, null, 2);
  const result = parseImport(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state, original);
  assert.equal(result.state.profiles[0].password, 'secret');
});

test('import rejects foreign or broken files', () => {
  assert.deepEqual(parseImport('{not json'), { ok: false, error: 'error.importJson' });
  assert.deepEqual(parseImport('[]'), { ok: false, error: 'error.importFormat' });
  assert.deepEqual(parseImport('"text"'), { ok: false, error: 'error.importFormat' });
  assert.deepEqual(parseImport(JSON.stringify({ format: 'something-else' })), {
    ok: false,
    error: 'error.importFormat',
  });
  // an export without the format marker is still accepted (older versions)
  assert.equal(parseImport(JSON.stringify({ profiles: [] })).ok, true);
});

test('missingRequirement points at what the current mode still needs', () => {
  const empty = createDefaultState();
  empty.settings.mode = 'fixed_servers';
  assert.equal(missingRequirement(empty), 'profile');
  assert.equal(missingRequirement(sanitizeState({ ...empty, profiles: [draft()] })), null);

  const pac = createDefaultState();
  pac.settings.mode = 'pac_script';
  assert.equal(missingRequirement(pac), 'pac');
  pac.settings.pacUrl = 'https://example.com/p.pac';
  assert.equal(missingRequirement(pac), null);

  const needsSomething = { fixed_servers: 'profile', pac_script: 'pac' };
  for (const mode of PROXY_MODES) {
    const state = createDefaultState();
    state.settings.mode = mode;
    assert.equal(missingRequirement(state), needsSomething[mode] ?? null, `mode ${mode}`);
  }
});

test('parseProxyUrl reads proxy strings the way people paste them', () => {
  assert.deepEqual(parseProxyUrl('socks5://user:pass@127.0.0.1:1080'), {
    scheme: 'socks5',
    host: '127.0.0.1',
    port: '1080',
    username: 'user',
    password: 'pass',
  });
  assert.deepEqual(parseProxyUrl('http://proxy.example.com:3128'), {
    scheme: 'http',
    host: 'proxy.example.com',
    port: '3128',
    username: '',
    password: '',
  });
  assert.deepEqual(parseProxyUrl('127.0.0.1:8080'), {
    scheme: null,
    host: '127.0.0.1',
    port: '8080',
    username: '',
    password: '',
  });
  assert.deepEqual(parseProxyUrl('proxy.example.com'), {
    scheme: null,
    host: 'proxy.example.com',
    port: '',
    username: '',
    password: '',
  });

  // an unknown scheme is dropped but the host survives
  assert.equal(parseProxyUrl('ftp://host:21').scheme, null);
  assert.equal(parseProxyUrl('ftp://host:21').host, 'host');
  // socks:// is the short spelling of socks5
  assert.equal(parseProxyUrl('socks://host:1').scheme, 'socks5');
  // paths, queries and fragments are ignored and credentials are decoded
  assert.deepEqual(parseProxyUrl('https://u%40ser:p%3Ass@h.example:443/path?x=1#frag'), {
    scheme: 'https',
    host: 'h.example',
    port: '443',
    username: 'u@ser',
    password: 'p:ss',
  });
  // an @ inside a path is part of the path, not a username
  assert.deepEqual(parseProxyUrl('https://proxy.example.com/@user'), {
    scheme: 'https',
    host: 'proxy.example.com',
    port: '',
    username: '',
    password: '',
  });
  // a bare IPv6 literal is bracketed for chrome.proxy
  assert.equal(parseProxyUrl('::1').host, '[::1]');

  for (const junk of ['', '   ', null, undefined]) {
    assert.equal(parseProxyUrl(junk), null, `junk: ${junk}`);
  }
});
