import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/model.js';
import {
  PROBE_CHECK_TIMEOUT_MS,
  PROBE_INTERVAL_MINUTES,
  PROBE_MAX_PER_PASS,
  PROBE_REFRESH_MS,
  TEST_ALL_MESSAGE,
  TEST_ALL_PROGRESS_MESSAGE,
  probeCandidates,
  probeEligible,
  probeVerdict,
  testAllEligible,
} from '../src/lib/server-probe.js';
import { SERVER_HEALTH_TTL_MS, noteServerHealth } from '../src/lib/server-health.js';
import { PROBE_TIMEOUT_MS } from '../src/lib/health.js';
import { proxyDirective } from '../src/lib/pac.js';
import { REAPPLY_MESSAGE, buildProbeConfig, buildProxyConfig } from '../src/lib/proxy.js';

const T0 = 1_700_000_000_000;

const server = (id, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  scheme: 'http',
  host: `${id}.example.com`,
  port: 8080,
  username: '',
  password: '',
  ...extra,
});

/** A state in manual mode on `active`, with `ids` saved. */
function manualState(ids = ['a', 'b', 'c'], active = 'a', settings = {}) {
  const state = createDefaultState();
  state.settings.mode = 'fixed_servers';
  state.settings.activeProfileId = active;
  state.settings.backgroundProbe = true;
  Object.assign(state.settings, settings);
  state.profiles = ids.map((id) => server(id));
  return state;
}

function routedState(domains = ['example.com']) {
  const state = manualState();
  state.settings.mode = 'pac_script';
  state.settings.domainRouting = true;
  state.settings.proxyDomains = domains;
  return state;
}

test('the check is off until it is asked for, or has nothing to keep', () => {
  const state = manualState();
  assert.equal(probeEligible(state), true);

  state.settings.backgroundProbe = false;
  assert.equal(probeEligible(state), false, 'the setting is the one switch that turns it on');

  // No active server means no route to reproduce.
  const orphan = manualState(['a'], 'a');
  orphan.settings.activeProfileId = null;
  assert.equal(probeEligible(orphan), false);

  // System and direct mode are not ours to re-create.
  for (const mode of ['system', 'direct']) {
    const other = manualState();
    other.settings.mode = mode;
    assert.equal(probeEligible(other), false, `${mode} must not be checked behind`);
  }

  // A switched-off extension routes nothing, so there is nothing to be right about.
  const off = manualState();
  off.settings.enabled = false;
  assert.equal(probeEligible(off), false);
});

test('domain routing is checked only once it has something to route', () => {
  const state = routedState(['example.com']);
  assert.equal(probeEligible(state), true);

  state.settings.proxyDomains = [];
  assert.equal(probeEligible(state), false, 'a chain with no listed site is not in force');

  state.settings.proxyDomains = ['example.com'];
  state.settings.domainRouting = false;
  assert.equal(probeEligible(state), false, 'a downloaded PAC script is not ours to reproduce');
});

test('a pass skips servers whose verdict is still fresh, and never repeats a look', () => {
  const servers = ['a', 'b', 'c'].map((id) => server(id));
  const now = T0 + PROBE_REFRESH_MS + 1000;
  const health = {
    a: { ok: true, at: now - 1000, ms: 40 },
    b: { ok: false, at: T0, ms: null },
  };

  // `c` has never been looked at, `b`'s verdict aged out; `a` was just looked at.
  assert.deepEqual(
    probeCandidates(servers, health, now).map((entry) => entry.id),
    ['c', 'b'],
  );

  // Every verdict recent: the pass has nothing to do, hence the empty list.
  const allFresh = {
    a: { ok: true, at: now - 1, ms: 40 },
    b: { ok: true, at: now - 2, ms: 90 },
    c: { ok: false, at: now - 3, ms: null },
  };
  assert.deepEqual(probeCandidates(servers, allFresh, now), []);
});

test('the oldest verdict is taken again before a newer one', () => {
  const servers = ['a', 'b', 'c'].map((id) => server(id));
  const now = T0 + 2 * PROBE_REFRESH_MS;
  const health = {
    a: { ok: true, at: T0 + 1000, ms: 40 },
    b: { ok: true, at: T0, ms: 90 },
    c: { ok: false, at: T0 + 2000, ms: null },
  };

  // All three aged out; the two oldest go first, `c` waits for the next pass.
  assert.deepEqual(
    probeCandidates(servers, health, now).map((entry) => entry.id),
    ['b', 'a'],
  );
});

test('a pass is capped, and asking for none is allowed', () => {
  const servers = ['a', 'b', 'c', 'd'].map((id) => server(id));
  assert.equal(probeCandidates(servers, {}, T0).length, PROBE_MAX_PER_PASS);
  assert.deepEqual(probeCandidates(servers, {}, T0, 1).map((entry) => entry.id), ['a']);
  assert.deepEqual(probeCandidates(servers, {}, T0, 0), []);
});

test('a candidate has to be a real, usable server', () => {
  const servers = [server('a'), { ...server('b'), host: '' }, { id: 'c' }];
  assert.deepEqual(
    probeCandidates(servers, {}, T0).map((entry) => entry.id),
    ['a'],
  );
  assert.deepEqual(probeCandidates(null, {}, T0), []);
});

test('a verdict is about the server that was checked, and nothing else', () => {
  const target = server('b');
  const verdict = probeVerdict(target, { ok: true, ms: 12.6 }, T0);
  assert.deepEqual(verdict, { id: 'b', ok: true, at: T0, ms: 13 });

  // A failure has no speed, and no outcome is no verdict: "failed" for a check that
  // never ran would demote a server nobody has looked at.
  assert.deepEqual(probeVerdict(target, { ok: false, ms: 900 }, T0), {
    id: 'b',
    ok: false,
    at: T0,
    ms: null,
  });
  assert.equal(probeVerdict(target, null, T0), null);
  assert.equal(probeVerdict(target, {}, T0), null);
  assert.equal(probeVerdict({}, { ok: true, ms: 1 }, T0), null);
});

test('a pass is what keeps the chain in the order that works', () => {
  // End to end at the policy level: what the checks find is what the generated chain
  // is ordered by. The generated script itself is run for real in pac.test.mjs.
  const state = manualState(['a', 'b'], 'b');
  state.settings.mode = 'pac_script';
  state.settings.domainRouting = true;
  state.settings.proxyDomains = ['example.com'];
  // The chain is ordered against the real clock, so this scenario uses it too.
  const now = Date.now();

  const chainOf = (health) =>
    /var PROXIES = (.*);/.exec(buildProxyConfig(state, health).pacScript.data)[1];

  // Nothing is known, so the chain is the list: the server in charge first.
  assert.equal(chainOf({}), '"PROXY b.example.com:8080; PROXY a.example.com:8080"');

  // A scripted network: `b` is down, `a` answers quickly. Nothing was looked at yet.
  const network = { a: { ok: true, ms: 90 }, b: { ok: false, ms: null } };
  const health = {};
  const first = probeCandidates(state.profiles, health, now);
  assert.deepEqual(first.map((entry) => entry.id), ['a', 'b']);

  for (const target of first) {
    // The check hands its own probe to the server it named; nothing else changes.
    const data = buildProbeConfig(state, target, health).pacScript.data;
    assert.ok(
      data.includes(`var OVERRIDE = ${JSON.stringify(proxyDirective(target))}`),
      `${target.id} is not where the probe was sent`,
    );
    noteServerHealth(health, probeVerdict(target, network[target.id], now));
  }

  // The server that answered leads the chain; the next pass has nothing to do.
  assert.equal(chainOf(health), '"PROXY a.example.com:8080; PROXY b.example.com:8080"');
  assert.deepEqual(probeCandidates(state.profiles, health, now + 60_000), []);

  // Once the verdicts age out the pass takes them again, and a faster `b` leads.
  const later = now + PROBE_REFRESH_MS;
  assert.deepEqual(
    probeCandidates(state.profiles, health, later).map((entry) => entry.id),
    ['a', 'b'],
    'both verdicts are equally old, so the list order decides',
  );
  for (const target of state.profiles) {
    noteServerHealth(
      health,
      probeVerdict(target, target.id === 'b' ? { ok: true, ms: 30 } : { ok: true, ms: 90 }, later),
    );
  }
  assert.equal(chainOf(health), '"PROXY b.example.com:8080; PROXY a.example.com:8080"');
});

test('the message constants name the pass and its progress', () => {
  assert.equal(typeof TEST_ALL_MESSAGE, 'string');
  assert.equal(typeof TEST_ALL_PROGRESS_MESSAGE, 'string');
  assert.notEqual(TEST_ALL_MESSAGE, TEST_ALL_PROGRESS_MESSAGE);
  assert.notEqual(TEST_ALL_MESSAGE, REAPPLY_MESSAGE, 'the reapply answer must never be mistaken for one');
});

test('a test-all pass is allowed wherever a check may measure, whatever the setting', () => {
  // The button was just pressed: the setting is not the pass's business, safety is.
  const state = manualState(['a', 'b'], 'a');
  state.settings.backgroundProbe = false;
  assert.equal(probeEligible(state), false, 'no network work on its own');
  assert.equal(testAllEligible(state), true, '…but a pass on request can be taken');

  // No requirement is waived here, only the setting.
  for (const broken of [() => {
    const s = manualState();
    s.settings.mode = 'system';
    return s;
  }, () => {
    const s = manualState();
    s.settings.mode = 'direct';
    return s;
  }, () => {
    const s = manualState();
    s.settings.mode = 'pac_script';
    s.settings.domainRouting = false;
    s.settings.pacUrl = 'https://example.com/proxy.pac';
    return s;
  }, () => {
    const s = manualState();
    s.settings.enabled = false;
    return s;
  }, () => {
    const s = manualState(['a'], 'a');
    s.settings.activeProfileId = null;
    return s;
  }]) {
    assert.equal(testAllEligible(broken()), false);
  }
});

test('the timing leaves room between two checks', () => {
  // A verdict has to survive from one look to the next, or the chain flickers back.
  assert.ok(
    PROBE_REFRESH_MS + PROBE_INTERVAL_MINUTES * 60_000 < SERVER_HEALTH_TTL_MS,
    `${PROBE_REFRESH_MS} + ${PROBE_INTERVAL_MINUTES}min must fit inside ${SERVER_HEALTH_TTL_MS}`,
  );
  assert.ok(PROBE_CHECK_TIMEOUT_MS < PROBE_TIMEOUT_MS, 'a check gives up sooner than the test button');
  assert.ok(PROBE_CHECK_TIMEOUT_MS >= 1000, 'but not so soon that a live server looks dead');
});
