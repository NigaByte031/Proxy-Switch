import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState, sanitizeState } from '../src/lib/model.js';
import {
  SERVER_HEALTH_TTL_MS,
  createServerHealth,
  describeServerVerdict,
  describeVerdictAge,
  noteServerHealth,
  orderServersByHealth,
  probeObservation,
  sameServerHealth,
  sanitizeServerHealth,
} from '../src/lib/server-health.js';

/** A fixed clock: health is all about how long ago a verdict was taken. */
const T0 = 1_700_000_000_000;

const server = (id, name = id) => ({ id, name, scheme: 'http', host: `${id}.example.com`, port: 8080 });
const A = server('a', 'First');
const B = server('b', 'Second');
const C = server('c', 'Third');
const SERVERS = [A, B, C];

const manualState = (settings = {}) =>
  sanitizeState({
    settings: { mode: 'fixed_servers', enabled: true, activeProfileId: 'a', ...settings },
    profiles: SERVERS,
  });

/* ------------------------------------------------------------------ *
 * What a probe proves
 * ------------------------------------------------------------------ */

test('a probe in manual mode is a verdict about the active server', () => {
  assert.deepEqual(probeObservation(manualState(), { ok: true, ms: 143 }, T0), {
    id: 'a',
    ok: true,
    at: T0,
    ms: 143,
  });

  // a failure is a verdict too — that is the interesting half
  assert.deepEqual(probeObservation(manualState(), { ok: false, ms: 6000, error: 'timeout' }, T0 + 1), {
    id: 'a',
    ok: false,
    at: T0 + 1,
    ms: null,
  });
});

test('a verdict about nobody is dropped, not guessed', () => {
  // every mode but manual hides which server the answer came from: the system
  // proxy, a downloaded PAC script, or a chain where any hop may have answered
  for (const mode of ['system', 'direct', 'pac_script']) {
    for (const routing of [false, true]) {
      assert.equal(
        probeObservation(manualState({ mode, domainRouting: routing }), { ok: true, ms: 5 }, T0),
        null,
        `${mode}/${routing}`,
      );
    }
  }

  // no active server, no outcome, no state: nothing to record
  const noProfiles = sanitizeState({ settings: { mode: 'fixed_servers', enabled: true } });
  assert.equal(probeObservation(noProfiles, { ok: true }, T0), null);
  assert.equal(probeObservation(manualState(), null, T0), null, 'no outcome is no verdict');
  assert.equal(
    probeObservation(manualState(), { url: 'https://x', ms: 5 }, T0),
    null,
    'an outcome that never answered either way is not a verdict',
  );
  assert.equal(probeObservation(undefined, { ok: true }, T0), null);
  assert.equal(probeObservation({ settings: {} }, { ok: true }, T0), null);

  // the extension being off means the server is not the route
  assert.equal(probeObservation(manualState({ enabled: false }), { ok: true }, T0), null);
});

test('a broken clock or a missing latency cannot poison the record', () => {
  const outcome = { ok: true, ms: Number.NaN };
  assert.equal(probeObservation(manualState(), outcome, Number.NaN).ok, true);
  assert.equal(probeObservation(manualState(), outcome, Number.NaN).ms, null, 'no latency, no ranking');
  assert.equal(probeObservation(manualState(), { ok: false, ms: 9 }, T0).ms, null, 'a failure has no speed');
  assert.ok(Number.isFinite(probeObservation(manualState(), { ok: true }, Number.NaN).at));
});

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

test('the record keeps verdicts, drops garbage and never aliases its input', () => {
  const record = createServerHealth();
  assert.deepEqual(record, {});
  assert.deepEqual(sanitizeServerHealth(null), {});
  assert.deepEqual(sanitizeServerHealth('nope'), {});
  assert.deepEqual(sanitizeServerHealth([]), {});

  noteServerHealth(record, { id: 'a', ok: true, at: T0, ms: 143.6 });
  noteServerHealth(record, { id: 'b', ok: false, at: T0 + 1, ms: 5000 });

  assert.deepEqual(record, {
    a: { ok: true, at: T0, ms: 144 },
    b: { ok: false, at: T0 + 1, ms: null },
  });

  // hand-edited storage cannot smuggle a verdict with no timestamp or a broken flag
  assert.deepEqual(
    sanitizeServerHealth({ a: { ok: true, at: T0 }, b: { ok: 'yes', at: T0 }, c: { ok: true } }),
    { a: { ok: true, at: T0, ms: null } },
  );
  // and nothing an entry-shaped object can say makes a record unsafe
  assert.deepEqual(sanitizeServerHealth({ a: 'junk', b: null, '': { ok: true, at: T0 } }), {});

  // a repeated verdict is the same verdict (the write is skipped) …
  const draft = structuredClone(record);
  noteServerHealth(draft, { id: 'a', ok: true, at: T0, ms: 144 });
  assert.equal(sameServerHealth(draft, record), true);
  // … and a newer one, or a different answer, is not
  noteServerHealth(draft, { id: 'a', ok: true, at: T0 + 5, ms: 144 });
  assert.equal(sameServerHealth(draft, record), false);
  noteServerHealth(draft, { id: 'a', ok: false, at: T0, ms: null });
  assert.equal(sameServerHealth(draft, record), false);
  noteServerHealth(draft, { id: 'c', ok: true, at: T0 });
  assert.equal(sameServerHealth(draft, record), false, 'a new server is a new record');
  assert.equal(sameServerHealth(null, null), true);
});

test('a verdict that proves nothing is not recorded', () => {
  const record = { a: { ok: true, at: T0, ms: 100 } };

  noteServerHealth(record, { id: '', ok: true, at: T0 });
  noteServerHealth(record, { at: T0 });
  noteServerHealth(record, { id: 'a' });
  assert.deepEqual(record, { a: { ok: true, at: T0, ms: 100 } }, 'unchanged, so nothing was written');
});

/* ------------------------------------------------------------------ *
 * The order of the chain
 * ------------------------------------------------------------------ */

test('proven-bad last, proven-good first and fastest among them', () => {
  const health = {
    a: { ok: true, at: T0, ms: 400 },
    b: { ok: false, at: T0, ms: null },
    c: { ok: true, at: T0, ms: 90 },
  };

  assert.deepEqual(
    orderServersByHealth(SERVERS, health, T0).map((profile) => profile.id),
    ['c', 'a', 'b'],
    'healthy first by speed, then the one that last failed',
  );
  // the input is never reordered under the caller
  assert.deepEqual(SERVERS.map((profile) => profile.id), ['a', 'b', 'c']);
});

test('servers nobody has looked at stay in list order between the two groups', () => {
  const health = { b: { ok: false, at: T0, ms: null } };

  assert.deepEqual(
    orderServersByHealth(SERVERS, health, T0).map((profile) => profile.id),
    ['a', 'c', 'b'],
    'unknown is not worse than known-bad, and the list decides their order',
  );
  assert.deepEqual(
    orderServersByHealth(SERVERS, null, T0).map((profile) => profile.id),
    ['a', 'b', 'c'],
    'no record at all is exactly list order',
  );

  // two healthy servers with the same latency keep the list order too
  const tie = { a: { ok: true, at: T0, ms: 100 }, c: { ok: true, at: T0, ms: 100 } };
  assert.deepEqual(
    orderServersByHealth(SERVERS, tie, T0).map((profile) => profile.id),
    ['a', 'c', 'b'],
  );
});

test('the list says which server answered, and how long ago', () => {
  // Never looked at is not a thing to say: the row says nothing at all.
  assert.equal(describeServerVerdict({}, 'a', T0), null);
  assert.equal(describeServerVerdict(null, 'a', T0), null);
  assert.equal(describeServerVerdict({ a: { ok: true, at: T0, ms: 40 } }, '', T0), null);
  assert.equal(describeServerVerdict({ a: { ok: 'maybe', at: T0 } }, 'a', T0), null, 'junk is not a verdict');

  const health = {
    a: { ok: true, at: T0, ms: 42 },
    b: { ok: false, at: T0, ms: null },
  };

  const answered = describeServerVerdict(health, 'a', T0 + 3 * 60_000);
  assert.deepEqual(answered, {
    tone: 'ok',
    current: true,
    state: { key: 'health.serverOk', params: { ms: '42 ms' } },
    age: { key: 'health.serverAge.minutes', params: { count: 3 } },
  });

  const silent = describeServerVerdict(health, 'b', T0);
  assert.equal(silent.tone, 'warn');
  assert.deepEqual(silent.state, { key: 'health.serverFail' });
  assert.deepEqual(silent.age, { key: 'health.serverAge.now' });

  // The words do not change when the verdict expires — only whether it still
  // counts, which is exactly what the chain stops doing with it.
  const old = describeServerVerdict(health, 'a', T0 + SERVER_HEALTH_TTL_MS + 1);
  assert.equal(old.current, false);
  assert.deepEqual(old.state, answered.state);
  assert.equal(describeServerVerdict(health, 'a', T0 + SERVER_HEALTH_TTL_MS).current, true);
});

test('the age of a verdict is spoken in minutes at the smallest', () => {
  const at = (ms) => describeVerdictAge(ms);
  assert.deepEqual(at(0), { key: 'health.serverAge.now' });
  assert.deepEqual(at(59_999), { key: 'health.serverAge.now' });
  assert.deepEqual(at(60_000), { key: 'health.serverAge.minutes', params: { count: 1 } });
  assert.deepEqual(at(59 * 60_000), { key: 'health.serverAge.minutes', params: { count: 59 } });
  assert.deepEqual(at(60 * 60_000), { key: 'health.serverAge.hours', params: { count: 1 } });
  assert.deepEqual(at(23 * 3_600_000), { key: 'health.serverAge.hours', params: { count: 23 } });
  assert.deepEqual(at(24 * 3_600_000), { key: 'health.serverAge.days', params: { count: 1 } });
  // A clock that went backwards says "just now" rather than "-1 min ago".
  assert.deepEqual(at(-5_000), { key: 'health.serverAge.now' });
  assert.deepEqual(at(NaN), { key: 'health.serverAge.now' });
});

test('a verdict older than the TTL stops counting, in both directions', () => {
  const health = { a: { ok: false, at: T0, ms: null }, c: { ok: true, at: T0, ms: 50 } };
  const justInTime = T0 + SERVER_HEALTH_TTL_MS;
  const tooLate = T0 + SERVER_HEALTH_TTL_MS + 1;

  assert.deepEqual(
    orderServersByHealth(SERVERS, health, justInTime).map((profile) => profile.id),
    ['c', 'b', 'a'],
    'the verdict is still fresh at the edge',
  );
  assert.deepEqual(
    orderServersByHealth(SERVERS, health, tooLate).map((profile) => profile.id),
    ['a', 'b', 'c'],
    'expired: neither promoted nor demoted, just unknown again',
  );
});

test('an empty or broken chain request is list order, not a crash', () => {
  assert.deepEqual(orderServersByHealth([], { a: { ok: true, at: T0, ms: 1 } }), []);
  assert.deepEqual(orderServersByHealth(undefined, undefined).map((profile) => profile.id), []);
  assert.deepEqual(orderServersByHealth(SERVERS, 'junk', T0).map((profile) => profile.id), [
    'a',
    'b',
    'c',
  ]);
  assert.deepEqual(orderServersByHealth([{ id: null }, A], null, T0).map((profile) => profile.id ?? null), [
    null,
    'a',
  ]);
});

test('the whole loop: what a failure proves is what the chain remembers', () => {
  const state = manualState({ activeProfileId: 'b' });

  // a test in manual mode fails while b is active
  const observation = probeObservation(state, { ok: false, ms: 6000 }, T0);
  const record = createServerHealth();
  noteServerHealth(record, observation);

  assert.deepEqual(
    orderServersByHealth(routingChainFor(state), record, T0).map((profile) => profile.id),
    ['a', 'c', 'b'],
    'the server that just failed goes last',
  );

  // the same test succeeding elsewhere proves nothing here (manual mode is over)
  assert.equal(probeObservation({ ...state, settings: { ...state.settings, mode: 'pac_script' } }, { ok: true, ms: 10 }, T0), null);
});

/** The chain the config would start from: active server first, list order after. */
function routingChainFor(state) {
  const active = state.profiles.find((profile) => profile.id === state.settings.activeProfileId);
  return [active, ...state.profiles.filter((profile) => profile.id !== active.id)];
}
