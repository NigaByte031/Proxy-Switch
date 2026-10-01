import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProfile, sanitizeState } from '../src/lib/model.js';
import {
  applySiteChoice,
  canonicalSiteRule,
  describeSiteRoute,
  hostMatchesRule,
  listMatchesHost,
  siteHostFromUrl,
  siteRouteOf,
} from '../src/lib/site-route.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const FRANKFURT = createProfile({
  id: 'p1',
  name: 'Frankfurt',
  scheme: 'https',
  host: 'de.example.net',
  port: 8443,
});
const AMSTERDAM = createProfile({
  id: 'p2',
  name: 'Amsterdam',
  scheme: 'socks5',
  host: 'nl.example.net',
  port: 1080,
});

/** A sanitized state — what the pages really hold — from a partial settings object. */
const stateWith = (settings = {}, profiles = [FRANKFURT, AMSTERDAM]) =>
  sanitizeState({ settings: { ...settings }, profiles });

test('a site is the host of the page, with www trimmed and the port dropped', () => {
  assert.equal(siteHostFromUrl('https://www.example.com/a/b?c=1#d'), 'example.com');
  assert.equal(siteHostFromUrl('http://example.com:8080/'), 'example.com');
  assert.equal(siteHostFromUrl('https://user:pw@sub.example.com/x'), 'sub.example.com');
  assert.equal(siteHostFromUrl('https://example.com'), 'example.com');
  assert.equal(siteHostFromUrl('https://[::1]:8443/x'), '[::1]');

  // A page that is not a site: nothing here can be routed by a host rule.
  for (const page of [
    'chrome://extensions',
    'about:blank',
    'file:///C:/tmp/page.html',
    'view-source:https://a.test/',
    '',
    null,
    undefined,
  ]) {
    assert.equal(siteHostFromUrl(page), null, String(page));
  }
});

test('a rule is written the way the site list accepts it', () => {
  assert.equal(canonicalSiteRule('WWW.Example.com'), 'example.com');
  assert.equal(canonicalSiteRule('example.com'), 'example.com');
  assert.equal(canonicalSiteRule('www.'), null);
  assert.equal(canonicalSiteRule('::1'), '[::1]');
  assert.equal(canonicalSiteRule('[::1]'), '[::1]');
  assert.equal(canonicalSiteRule('  '), null);
  // A host that carries a port belongs to no rule: the form's own host field is the
  // only place a bare colon means anything.
  assert.equal(canonicalSiteRule('example.com:8080'), null);
});

test('one rule covers a host the way it says it does', () => {
  assert.ok(hostMatchesRule('example.com', 'example.com'));
  assert.ok(hostMatchesRule('www.example.com', 'example.com'));
  assert.ok(!hostMatchesRule('notexample.com', 'example.com'));
  assert.ok(!hostMatchesRule('example.com.evil.test', 'example.com'));

  assert.ok(!hostMatchesRule('example.com', '*.example.com'));
  assert.ok(hostMatchesRule('a.example.com', '*.example.com'));
  assert.ok(hostMatchesRule('a.b.example.com', '*.example.com'));

  assert.ok(hostMatchesRule('intranet', '<local>'));
  assert.ok(!hostMatchesRule('intranet.corp', '<local>'));

  assert.ok(hostMatchesRule('a1.test', 'a?.test'));
  assert.ok(hostMatchesRule('anything.test', '*.test'));
  assert.ok(!hostMatchesRule('', 'example.com'));
  assert.ok(!hostMatchesRule('example.com', ''));

  assert.ok(listMatchesHost(['other.test', 'example.com'], 'www.example.com'));
  assert.ok(!listMatchesHost([], 'example.com'));
  assert.ok(!listMatchesHost(null, 'example.com'));
});

test('the effect follows the mode, not only the lists', () => {
  const listed = stateWith({
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: ['example.com'],
  });
  assert.equal(siteRouteOf(listed, 'www.example.com').effect, 'proxy');
  assert.equal(siteRouteOf(listed, 'other.test').effect, 'direct');

  // Manual mode sends everything through the active server already.
  const manual = stateWith({ mode: 'fixed_servers' });
  assert.equal(siteRouteOf(manual, 'other.test').effect, 'proxy');

  // The bypass list outranks every mode, exactly as it does in the script.
  const bypassed = stateWith({
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: ['example.com'],
    bypassList: ['example.com'],
  });
  assert.equal(siteRouteOf(bypassed, 'www.example.com').effect, 'bypass');

  assert.equal(siteRouteOf(stateWith({ mode: 'system' }), 'other.test').effect, 'system');
  assert.equal(siteRouteOf(stateWith({ mode: 'direct' }), 'other.test').effect, 'direct');
  assert.equal(
    siteRouteOf(stateWith({ mode: 'pac_script', pacUrl: 'https://x.test/p.pac' }), 'other.test').effect,
    'pac',
  );
  assert.equal(siteRouteOf(stateWith({ enabled: false }), 'other.test').effect, 'off');
});

test('a listed site names its server, and no other effect does', () => {
  const listed = stateWith({
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: ['example.com'],
    domainServers: { 'example.com': 'p2' },
  });

  const route = siteRouteOf(listed, 'www.example.com');
  assert.equal(route.listed, true);
  assert.equal(route.serverId, 'p2');
  assert.equal(route.serverName, 'Amsterdam');

  const described = describeSiteRoute(listed, 'www.example.com');
  assert.equal(described.key, 'site.effect.proxy.named');
  assert.deepEqual(described.params, { host: 'www.example.com', name: 'Amsterdam' });

  // A site with no server of its own says the general thing instead.
  const plain = stateWith({ mode: 'pac_script', domainRouting: true, proxyDomains: ['example.com'] });
  assert.equal(describeSiteRoute(plain, 'www.example.com').key, 'site.effect.proxy');
  assert.equal(siteRouteOf(plain, 'www.example.com').serverName, null);

  // Not going through the server is not a moment to name it.
  const off = stateWith({
    enabled: false,
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: ['example.com'],
    domainServers: { 'example.com': 'p2' },
  });
  assert.equal(describeSiteRoute(off, 'example.com').key, 'site.effect.off');
  assert.equal(siteRouteOf(off, 'example.com').serverName, 'Amsterdam');
});

test('the three chips write the two lists, and route the site for real', () => {
  const start = stateWith({ mode: 'direct', bypassList: ['old.test'] });

  const routed = structuredClone(start);
  assert.equal(applySiteChoice(routed, 'www.example.com', 'proxy'), true);
  assert.deepEqual(routed.settings.proxyDomains, ['example.com']);
  // Direct mode has no list to honour, so the promise is turned on with it.
  assert.equal(routed.settings.mode, 'pac_script');
  assert.equal(routed.settings.domainRouting, true);

  const sent = structuredClone(start);
  applySiteChoice(sent, 'www.example.com', 'direct');
  assert.deepEqual(sent.settings.bypassList, ['old.test', 'example.com']);
  assert.equal(sent.settings.mode, 'direct', 'bypassing needs no mode of its own');

  const followed = structuredClone(routed);
  applySiteChoice(followed, 'example.com', 'auto');
  assert.deepEqual(followed.settings.proxyDomains, [], 'the rule that covered it is gone');
});

test('routing a site that is already listed keeps the server it was given', () => {
  const listed = stateWith({
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: ['example.com'],
    domainServers: { 'example.com': 'p2' },
  });
  const draft = structuredClone(listed);

  applySiteChoice(draft, 'www.example.com', 'proxy');
  assert.deepEqual(draft.settings.proxyDomains, ['example.com']);
  assert.equal(draft.settings.domainServers['example.com'], 'p2');

  // The other list is cleaned instead: an older bypass rule would still win.
  const both = stateWith({
    mode: 'pac_script',
    domainRouting: true,
    proxyDomains: [],
    bypassList: ['*.example.com', 'keep.test'],
  });
  const cleared = structuredClone(both);
  applySiteChoice(cleared, 'www.example.com', 'proxy');
  assert.deepEqual(cleared.settings.bypassList, ['keep.test']);
  assert.deepEqual(cleared.settings.proxyDomains, ['example.com']);
});

test('a site with no server to route through is not promised one', () => {
  const noServers = stateWith({ mode: 'direct' }, []);
  const draft = structuredClone(noServers);
  applySiteChoice(draft, 'www.example.com', 'proxy');
  assert.deepEqual(draft.settings.proxyDomains, ['example.com']);
  assert.equal(draft.settings.mode, 'direct', 'nothing was promised, so nothing changed');
  assert.equal(applySiteChoice(draft, '', 'proxy'), false);
});

test('the popup shows the control and wires it to the lists', () => {
  const popup = read('src/popup.html');
  assert.match(popup, /id="siteCard"/);
  assert.match(popup, /id="siteHost"/);
  assert.match(popup, /id="siteEffect"/);
  assert.match(popup, /id="siteChoices"[\s\S]{0,120}role="radiogroup"/);

  const choices = popup.slice(popup.indexOf('id="siteChoices"'));
  const drawn = [...choices.matchAll(/data-choice="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(drawn, ['proxy', 'direct', 'auto']);

  const source = read('src/popup.js');
  assert.match(source, /from '\.\/lib\/site-route\.js'/);
  assert.match(source, /chrome\.tabs\?\.query/);
  assert.match(source, /siteHostFromUrl\(tab\?\.url\)/);
  assert.match(source, /applySiteChoice\(draft, siteHost, choice\)/);
  assert.match(source, /renderSite\(lang\)/);

  // The settings page gets the same keys, so both say it the same way.
  const options = read('src/options.html');
  assert.match(options, /id="domainServersPanel"/);
  assert.match(options, /id="domainServerList"/);
  assert.match(read('src/options.js'), /domainServerListEl: el\('domainServerList'\)/);
});
