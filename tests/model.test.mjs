import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BYPASS_LIST,
  EXPORT_FORMAT,
  PROXY_MODES,
  STATE_VERSION,
  bracketIfIpv6,
  createDefaultState,
  createProfile,
  effectiveMode,
  findProfile,
  formatBypassList,
  formatProfileAddress,
  isValidHost,
  isValidPacUrl,
  missingRequirement,
  newId,
  normalizeHost,
  parseBypassList,
  parseImport,
  sanitizeState,
  serializeState,
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

test('sanitizeState repairs garbage instead of throwing', () => {
  assert.deepEqual(sanitizeState(null), createDefaultState());
  assert.deepEqual(sanitizeState('nonsense'), createDefaultState());
  assert.deepEqual(sanitizeState({ profiles: 'nope' }), createDefaultState());

  const state = sanitizeState({
    settings: { mode: 'wat', enabled: 'yes', language: 'de', bypassList: [' ok ', ''] },
    profiles: [{ host: 'example.com', port: '99999' }, { host: '' }, null],
  });
  assert.equal(state.settings.mode, 'system');
  assert.equal(state.settings.enabled, true);
  assert.equal(state.settings.language, 'auto');
  assert.deepEqual(state.settings.bypassList, ['ok']);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].port, 8080);
  assert.equal(state.profiles[0].name, 'example.com');
  assert.equal(state.settings.activeProfileId, state.profiles[0].id);
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
