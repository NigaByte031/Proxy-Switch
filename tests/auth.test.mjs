import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChallengeHost, resolveAuthCredentials } from '../src/lib/auth.js';
import { sanitizeState } from '../src/lib/model.js';

/** A state with one active, credentialled server. */
const stateWith = (settings = {}, profiles) =>
  sanitizeState({
    settings: { mode: 'fixed_servers', autoAuth: true, ...settings },
    profiles: profiles ?? [
      {
        id: 'p1',
        name: 'Work',
        scheme: 'http',
        host: 'Proxy.Example.com',
        port: 8080,
        username: 'user',
        password: 'pa:ss',
      },
    ],
  });

const CHALLENGE = { isProxy: true, challenger: { host: 'proxy.example.com', port: 8080 } };

test('normalizeChallengeHost strips IPv6 brackets and case', () => {
  assert.equal(normalizeChallengeHost('[::1]'), '::1');
  assert.equal(normalizeChallengeHost('Proxy.Example.COM'), 'proxy.example.com');
  assert.equal(normalizeChallengeHost(undefined), '');
  assert.equal(normalizeChallengeHost(null), '');
});

test('the saved credentials answer the active server', () => {
  assert.deepEqual(resolveAuthCredentials(stateWith(), CHALLENGE), {
    username: 'user',
    password: 'pa:ss',
  });

  // the same host in another case is the same host
  assert.ok(
    resolveAuthCredentials(stateWith(), { isProxy: true, challenger: { host: 'PROXY.EXAMPLE.COM' } }),
  );

  // some Chrome versions do not fill `challenger` in at all
  assert.ok(resolveAuthCredentials(stateWith(), { isProxy: true }));
});

test('an IPv6 server still matches a bracket-less challenge', () => {
  const state = stateWith({}, [
    {
      id: 'p1',
      name: 'Local',
      scheme: 'socks5',
      host: '::1',
      port: 1080,
      username: 'user',
      password: 'x',
    },
  ]);

  assert.equal(state.profiles[0].host, '[::1]', 'the stored host keeps its brackets');
  assert.ok(resolveAuthCredentials(state, { isProxy: true, challenger: { host: '::1' } }));
  assert.equal(resolveAuthCredentials(state, { isProxy: true, challenger: { host: '[2001:db8::1]' } }), null);
});

test('credentials are never volunteered to another proxy', () => {
  assert.equal(
    resolveAuthCredentials(stateWith(), { isProxy: true, challenger: { host: 'evil.example.net' } }),
    null,
  );

  // the second server is not the active one, so its credentials stay put
  const two = stateWith({ activeProfileId: 'p2' }, [
    {
      id: 'p1',
      name: 'Work',
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'work-user',
      password: 'work-pass',
    },
    {
      id: 'p2',
      name: 'Home',
      scheme: 'http',
      host: 'home.example.com',
      port: 8080,
      username: 'home-user',
      password: 'home-pass',
    },
  ]);
  assert.equal(two.settings.activeProfileId, 'p2');
  assert.deepEqual(resolveAuthCredentials(two, CHALLENGE), null);
  assert.deepEqual(
    resolveAuthCredentials(two, { isProxy: true, challenger: { host: 'home.example.com' } }),
    { username: 'home-user', password: 'home-pass' },
  );
});

test('a site login is never answered, only a proxy one', () => {
  assert.equal(resolveAuthCredentials(stateWith(), { ...CHALLENGE, isProxy: false }), null);
  assert.equal(resolveAuthCredentials(stateWith(), {}), null);
});

test('only a running, manual-mode extension may auto-authenticate', () => {
  assert.equal(resolveAuthCredentials(stateWith({ autoAuth: false }), CHALLENGE), null);

  // system and PAC modes do not use the saved server, so its credentials are not ours to send
  assert.equal(resolveAuthCredentials(stateWith({ mode: 'system' }), CHALLENGE), null);
  assert.equal(resolveAuthCredentials(stateWith({ mode: 'pac_script' }), CHALLENGE), null);
  assert.equal(resolveAuthCredentials(stateWith({ mode: 'direct' }), CHALLENGE), null);

  // the master switch is off: whatever proxy is answering is not ours
  assert.equal(resolveAuthCredentials(stateWith({ enabled: false }), CHALLENGE), null);

  // a credentialless server has nothing to offer, so Chrome must ask the user
  const anonymous = stateWith({}, [
    { id: 'p1', name: 'Open', scheme: 'http', host: 'proxy.example.com', port: 8080 },
  ]);
  assert.equal(resolveAuthCredentials(anonymous, CHALLENGE), null);

  // a username without a password is still a valid answer
  const half = stateWith({}, [
    { id: 'p1', name: 'Half', scheme: 'http', host: 'proxy.example.com', port: 8080, username: 'user' },
  ]);
  assert.deepEqual(resolveAuthCredentials(half, CHALLENGE), { username: 'user', password: '' });
});

test('the generated PAC routes through the active server, so its credentials are ours', () => {
  // PAC mode normally borrows somebody else's script, but the one built from
  // the domain list names this server — see lib/pac.js.
  const state = stateWith({ mode: 'pac_script', domainRouting: true });
  assert.deepEqual(resolveAuthCredentials(state, CHALLENGE), { username: 'user', password: 'pa:ss' });
  // and the rule stays narrow: another host still gets nothing
  assert.equal(
    resolveAuthCredentials(state, { isProxy: true, challenger: { host: 'evil.example.net' } }),
    null,
  );
  // a downloaded PAC script is somebody else's business, as before
  assert.equal(resolveAuthCredentials(stateWith({ mode: 'pac_script' }), CHALLENGE), null);
});

test('a challenge from a fallback server in the chain is answered too', () => {
  const servers = [
    {
      id: 'p1',
      name: 'Work',
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'active',
      password: 'a-pass',
    },
    {
      id: 'p2',
      name: 'Backup',
      scheme: 'http',
      host: 'backup.example.com',
      port: 8080,
      username: 'backup',
      password: 'b-pass',
    },
  ];
  const routed = stateWith({ mode: 'pac_script', domainRouting: true, activeProfileId: 'p1' }, servers);

  assert.deepEqual(resolveAuthCredentials(routed, CHALLENGE), { username: 'active', password: 'a-pass' });
  assert.deepEqual(
    resolveAuthCredentials(routed, { isProxy: true, challenger: { host: 'backup.example.com' } }),
    { username: 'backup', password: 'b-pass' },
    'the generated script names the fallback too, so its credentials are ours',
  );
  assert.equal(
    resolveAuthCredentials(routed, { isProxy: true, challenger: { host: 'other.example.net' } }),
    null,
    'and only servers the user saved may answer',
  );

  // manual mode has no chain: the second server stays silent there
  const manual = stateWith({ activeProfileId: 'p1' }, servers);
  assert.equal(
    resolveAuthCredentials(manual, { isProxy: true, challenger: { host: 'backup.example.com' } }),
    null,
  );
});

test('the server a background check is looking at may answer for itself', () => {
  const servers = [
    {
      id: 'p1',
      name: 'Active',
      scheme: 'http',
      host: 'active.example.com',
      port: 8080,
      username: 'active',
      password: 'a-pass',
    },
    {
      id: 'p2',
      name: 'Backup',
      scheme: 'http',
      host: 'backup.example.com',
      port: 8080,
      username: 'backup',
      password: 'b-pass',
    },
  ];
  const manual = stateWith({ activeProfileId: 'p1' }, servers);
  const challenge = { isProxy: true, challenger: { host: 'backup.example.com' } };

  // Manual mode volunteers nothing for a fallback server …
  assert.equal(resolveAuthCredentials(manual, challenge), null);
  // … but a check is sending its own probe through exactly that server, so a
  // private proxy does not look dead merely because its login was never offered.
  assert.deepEqual(resolveAuthCredentials(manual, challenge, 'p2'), {
    username: 'backup',
    password: 'b-pass',
  });

  // The permission is about the check, not about dropping the rules: the active
  // server still answers as itself, and an unnamed proxy still gets nothing.
  assert.deepEqual(
    resolveAuthCredentials(manual, { isProxy: true, challenger: { host: 'active.example.com' } }, 'p2'),
    { username: 'active', password: 'a-pass' },
  );
  assert.equal(
    resolveAuthCredentials(manual, { isProxy: true, challenger: { host: 'other.example.net' } }, 'p2'),
    null,
  );
  // A switched-off extension answers nobody, check or no check.
  assert.equal(resolveAuthCredentials(stateWith({ enabled: false }, servers), challenge, 'p2'), null);
});

test('a broken state never throws', () => {
  for (const broken of [null, undefined, {}, { settings: {} }, { settings: { mode: 'fixed_servers' } }]) {
    assert.equal(resolveAuthCredentials(broken, CHALLENGE), null);
  }
  assert.equal(resolveAuthCredentials(stateWith(), undefined), null);
});
