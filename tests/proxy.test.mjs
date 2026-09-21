import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState, sanitizeState } from '../src/lib/model.js';
import { buildProxyConfig, describeBadge, describeStatus } from '../src/lib/proxy.js';
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
