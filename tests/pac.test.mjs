import test from 'node:test';
import assert from 'node:assert/strict';

import { PAC_DIRECTIVE, buildPacScript, proxyChain, proxyDirective } from '../src/lib/pac.js';
import { createProfile, sanitizeDomainRules } from '../src/lib/model.js';
import { hostMatchesRule, listMatchesHost } from '../src/lib/site-route.js';

/**
 * The generated PAC script is a contract with Chrome, so it is evaluated and
 * `FindProxyForURL()` is called for real. The helpers it may use are shimmed as the
 * spec defines them (`shExpMatch` is a glob, `isPlainHostName` is "no dot").
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

/** Runs the generated script and asks it about one request. */
function ask(script, { url = 'https://example.com/', host } = {}) {
  const names = Object.keys(PAC_HELPERS);
  const findProxy = new Function(...names, `${script}\nreturn FindProxyForURL;`)(
    ...Object.values(PAC_HELPERS),
  );
  return findProxy(url, host ?? new URL(url).hostname);
}

const WORK = createProfile({
  id: 'p1',
  name: 'Work',
  scheme: 'http',
  host: 'proxy.example.com',
  port: 8080,
});

const scriptFor = (domains, { servers = [WORK], bypass = [] } = {}) =>
  buildPacScript({ servers, domains, bypass });

test('the script is a real, runnable PAC script', () => {
  const script = scriptFor(['example.com']);
  assert.ok(script.includes('function FindProxyForURL(url, host)'));
  // evaluating it is the only proof that matters
  assert.equal(ask(script, { host: 'www.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'elsewhere.test' }), 'DIRECT');
});

test('a listed domain covers itself and its subdomains, and nothing that merely ends the same', () => {
  const script = scriptFor(['example.com']);

  assert.equal(ask(script, { url: 'https://example.com/', host: 'example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'api.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'a.b.example.com' }), 'PROXY proxy.example.com:8080');
  // the important half of "ends with": a lookalike is a different site
  assert.equal(ask(script, { host: 'notexample.com' }), 'DIRECT');
  assert.equal(ask(script, { host: 'example.com.evil.test' }), 'DIRECT');
  assert.equal(ask(script, { host: 'exaexample.com' }), 'DIRECT');
});

test('*.domain is the subdomains only, and other patterns are globs', () => {
  const subdomains = scriptFor(['*.example.com']);
  assert.equal(ask(subdomains, { host: 'www.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(subdomains, { host: 'example.com' }), 'DIRECT', 'the apex was not asked for');

  const glob = scriptFor(['api.*.example.com', 'shop?.example.com']);
  assert.equal(ask(glob, { host: 'api.eu.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(glob, { host: 'api.example.com' }), 'DIRECT');
  assert.equal(ask(glob, { host: 'shop1.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(glob, { host: 'shop12.example.com' }), 'DIRECT');
});

test('the bypass list still wins, and <local> means dot-less names', () => {
  const script = scriptFor(['example.com', 'corp.example'], {
    bypass: ['<local>', 'safe.example.com'],
  });

  assert.equal(ask(script, { host: 'wiki' }), 'DIRECT', '<local> covers dot-less hosts');
  assert.equal(ask(script, { host: 'safe.example.com' }), 'DIRECT', 'bypass beats the list');
  assert.equal(ask(script, { host: 'other.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'corp.example' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'wiki.corp.example' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'corp.elsewhere' }), 'DIRECT', 'a rule only covers itself and deeper names');
});

test('a routed site never falls back to a direct connection', () => {
  // The most dangerous mistake this feature could make: sending the listed sites
  // straight to the network when the server is down.
  for (const host of ['example.com', 'api.example.com']) {
    const answer = ask(scriptFor(['example.com']), { host });
    assert.equal(answer, 'PROXY proxy.example.com:8080', host);
    assert.ok(!answer.includes('DIRECT'), `${host} must not offer a direct fallback`);
    assert.equal(answer.split(';').length, 1, `${host} must name exactly one proxy`);
  }
});

test('every saved server is a hop in the chain, so one dying server is not the end', () => {
  const active = createProfile({ id: 'a', name: 'Work', scheme: 'http', host: 'a.example.com', port: 8080 });
  const backup = createProfile({ id: 'b', name: 'Home', scheme: 'socks5', host: 'b.example.com', port: 1080 });
  const third = createProfile({ id: 'c', name: 'Phone', scheme: 'http', host: 'c.example.com', port: 3128 });

  // the order the caller passes is the order Chrome tries
  assert.equal(
    proxyChain([active, backup, third]),
    'PROXY a.example.com:8080; SOCKS5 b.example.com:1080; PROXY c.example.com:3128',
  );
  // the same server twice is one hop, and nothing to name is nothing at all
  assert.equal(proxyChain([active, backup, active]), proxyChain([active, backup]));
  assert.equal(proxyChain([]), '');
  assert.equal(proxyChain(undefined), '');
  assert.equal(proxyChain([null, { host: '' }]), '');

  const script = buildPacScript({ servers: [active, backup, third], domains: ['example.com'] });
  const answer = ask(script, { host: 'www.example.com' });
  assert.equal(answer, proxyChain([active, backup, third]), 'a listed site gets the whole chain');
  assert.ok(!answer.includes('DIRECT'), 'still no direct fallback, even with three servers');
  assert.equal(answer.split(';').length, 3, 'three hops');
  // and an unlisted site is unaffected by the chain
  assert.equal(ask(script, { host: 'elsewhere.test' }), 'DIRECT');

  // one server only is still a valid chain, and one dead server leaves the rest
  assert.equal(
    ask(buildPacScript({ servers: [active], domains: ['example.com'] }), { host: 'example.com' }),
    'PROXY a.example.com:8080',
  );
});

test('the proxy directive follows the scheme of the server', () => {
  const cases = [
    ['http', 'PROXY proxy.example.com:8080'],
    ['https', 'HTTPS proxy.example.com:8080'],
    ['socks4', 'SOCKS4 proxy.example.com:1080'],
    ['socks5', 'SOCKS5 proxy.example.com:1080'],
  ];

  for (const [scheme, expected] of cases) {
    const profile = createProfile({ name: scheme, scheme, host: 'proxy.example.com', port: scheme.startsWith('socks') ? 1080 : 8080 });
    assert.equal(proxyDirective(profile), expected, scheme);
    assert.equal(ask(scriptFor(['example.com'], { servers: [profile] }), { host: 'example.com' }), expected);
  }

  // an unknown scheme is an HTTP proxy, like everywhere else in the extension
  assert.equal(proxyDirective({ scheme: 'quic', host: 'h', port: 1 }), PAC_DIRECTIVE.http + ' h:1');
  assert.equal(proxyDirective({ scheme: 'http', host: 'h', port: 1 }), 'PROXY h:1');
});

test('nothing to route means no script at all (the caller fails open)', () => {
  assert.equal(scriptFor([]), null, 'no rule');
  assert.equal(scriptFor(['   ', '# just a comment']), null, 'no usable rule');
  assert.equal(scriptFor(['not a host', 'host:port']), null, 'typos are not rules');
  assert.equal(buildPacScript({ servers: [], domains: ['example.com'] }), null, 'no server');
  assert.equal(buildPacScript({ domains: ['example.com'] }), null, 'no servers at all');
  assert.ok(scriptFor(['example.com']), 'a rule and a server is all it takes');
});

test('typed rules are cleaned up before they reach the script', () => {
  const script = scriptFor([
    'https://Example.COM/private?x=1#frag',
    ' example.com ',
    '# a comment about the line below',
    '',
    'wiki.example.net',
  ]);
  // the pasted URL became a host, the duplicate lost, the comment and blank line gone
  assert.deepEqual(
    sanitizeDomainRules(['https://Example.COM/private?x=1#frag', ' example.com ', '# x', 'wiki.example.net']),
    ['Example.COM', 'wiki.example.net'],
  );
  assert.match(script, /2 domain rule\(s\)/, 'the header repeats how many rules survived');
  assert.equal(ask(script, { host: 'example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'www.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'wiki.example.net' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'example.net' }), 'DIRECT');
});

test('a rule is a host, so a whole proxy URL is not one', () => {
  assert.deepEqual(sanitizeDomainRules(['user:pass@host.example', 'host:8080', 'has space', '-']), []);
  assert.deepEqual(sanitizeDomainRules(['*.example.com', '<local>', '[::1]']), [
    '*.example.com',
    '<local>',
    '[::1]',
  ]);
});

test('the override sends the probes to one server and moves nothing else', () => {
  const HOME = createProfile({
    id: 'p2',
    name: 'Home',
    scheme: 'socks5',
    host: 'home.example.net',
    port: 1080,
  });
  const script = buildPacScript({
    servers: [WORK, HOME],
    domains: ['example.com'],
    bypass: ['safe.example.com'],
    override: { hosts: ['www.gstatic.com'], directive: 'SOCKS5 home.example.net:1080' },
  });

  // What the check is for: the probe itself goes to the server being tested …
  assert.equal(ask(script, { host: 'www.gstatic.com' }), 'SOCKS5 home.example.net:1080');
  // … and everything the user configured is exactly where it was.
  assert.equal(ask(script, { host: 'www.example.com' }), 'PROXY proxy.example.com:8080; SOCKS5 home.example.net:1080');
  assert.equal(ask(script, { host: 'safe.example.com' }), 'DIRECT');
  assert.equal(ask(script, { host: 'elsewhere.test' }), 'DIRECT');

  // Exact host only: a subdomain of a probe endpoint is not a probe.
  assert.equal(ask(script, { host: 'notgstatic.com' }), 'DIRECT');
  assert.equal(ask(script, { host: 'www.gstatic.com.evil.test' }), 'DIRECT');
  // Half an override is no override: it would look like it diverts a check while
  // diverting nothing.
  const incomplete = buildPacScript({
    servers: [WORK],
    domains: ['example.com'],
    override: { hosts: ['www.gstatic.com'] },
  });
  assert.equal(ask(incomplete, { host: 'www.gstatic.com' }), 'DIRECT');
  assert.ok(!incomplete.includes('PROXY  '), 'no directive was invented');
});

test('base "all" is manual mode: the chain for everything, the bypass list still winning', () => {
  const script = buildPacScript({
    servers: [WORK],
    domains: [],
    base: 'all',
    bypass: ['<local>'],
    override: { hosts: ['cp.cloudflare.com'], directive: 'PROXY home.example.net:3128' },
  });
  assert.ok(script, 'no rule is needed when every host is routed');

  assert.equal(ask(script, { host: 'example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'somewhere-else.test' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'intranet' }), 'DIRECT', 'the bypass list is a promise');
  assert.equal(ask(script, { host: 'cp.cloudflare.com' }), 'PROXY home.example.net:3128');

  // …and without `base`, an empty list is still nothing to route.
  assert.equal(buildPacScript({ servers: [WORK], domains: [], base: 'listed' }), null);
});

test('an IPv6 server and bracketed rules survive the trip', () => {
  const script = scriptFor(['[2001:db8::1]', 'example.com']);
  assert.equal(ask(script, { host: '[2001:db8::1]' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: '2001:db8::1' }), 'PROXY proxy.example.com:8080');
});

const NL = 'SOCKS5 nl.example.net:1080';

const routedScript = (over = {}) =>
  buildPacScript({
    servers: [WORK],
    domains: ['example.com'],
    routes: [{ directive: NL, hosts: ['intra.test'] }],
    ...over,
  });

test('a site that named a server of its own is matched ahead of the shared chain', () => {
  const script = routedScript();
  assert.equal(ask(script, { host: 'www.example.com' }), 'PROXY proxy.example.com:8080');
  assert.equal(ask(script, { host: 'a.intra.test' }), NL);
  assert.equal(ask(script, { host: 'intra.test' }), NL);
  assert.equal(ask(script, { host: 'elsewhere.test' }), 'DIRECT');
  assert.match(script, /2 domain rule\(s\)/, 'the header counts both halves of the list');
  assert.match(script, /Some rules name a server of their own/);
});

test('routes alone are enough, and a half route is no route at all', () => {
  const onlyRoute = buildPacScript({
    servers: [WORK],
    domains: [],
    routes: [{ directive: 'PROXY home.example.net:3128', hosts: ['x.test'] }],
  });
  assert.ok(onlyRoute, 'a rule with its own server needs no rule on the shared chain');
  assert.equal(ask(onlyRoute, { host: 'x.test' }), 'PROXY home.example.net:3128');
  assert.equal(ask(onlyRoute, { host: 'other.test' }), 'DIRECT');

  // Half a route would look like routing while diverting nothing.
  assert.equal(
    buildPacScript({ servers: [WORK], domains: [], routes: [{ directive: '', hosts: ['x.test'] }] }),
    null,
  );
  assert.equal(
    buildPacScript({ servers: [WORK], domains: [], routes: [{ directive: NL, hosts: [] }] }),
    null,
  );
  assert.equal(
    buildPacScript({ servers: [WORK], domains: [], routes: [{ directive: NL, hosts: ['no space'] }] }),
    null,
    'a host that cannot match is not a reason to build a script',
  );
});

test('the bypass list still outranks a site that named its own server', () => {
  const script = routedScript({ bypass: ['intra.test'] });
  assert.equal(ask(script, { host: 'a.intra.test' }), 'DIRECT');
});

test("the popup's matcher agrees with the script it stands in for", () => {
  const rules = ['example.com', '*.internal.test', 'a?.test', '<local>', 'host.test'];
  const script = buildPacScript({ servers: [WORK], domains: rules });
  const hosts = [
    'example.com',
    'www.example.com',
    'notexample.com',
    'example.com.evil.test',
    'internal.test',
    'a.internal.test',
    'a.b.internal.test',
    'a1.test',
    'ab.test',
    'anything.test',
    'intranet',
    'intranet.corp',
    'host.test',
    'sub.host.test',
  ];

  for (const host of hosts) {
    const fromScript = ask(script, { host }) !== 'DIRECT';
    assert.equal(listMatchesHost(rules, host), fromScript, `${host} must be read the same way`);
  }

  // and each rule on its own, not just the list as a whole
  for (const rule of rules) {
    const one = buildPacScript({ servers: [WORK], domains: [rule] });
    for (const host of hosts) {
      assert.equal(
        hostMatchesRule(host, rule),
        ask(one, { host }) !== 'DIRECT',
        `${host} against ${rule}`,
      );
    }
  }
});
