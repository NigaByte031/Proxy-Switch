import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILOVER_COOLDOWN_MS,
  FAILOVER_FAILED_COOLDOWN_MS,
  FAILOVER_STRIKES,
  createFailoverRecord,
  failoverEligible,
  failoverUndoTarget,
  nextFailoverTarget,
  noteHealthy,
  noteManualSwitch,
  noteProxyError,
  planFailover,
  sanitizeFailoverRecord,
} from '../src/lib/failover.js';
import { probe } from '../src/lib/health.js';
import { sanitizeState } from '../src/lib/model.js';
import { buildSwitchNotice } from '../src/lib/notice.js';
import { noteServerHealth, probeObservation, sanitizeServerHealth } from '../src/lib/server-health.js';

/**
 * An outage, observed from the outside.
 *
 * `tests/failover.test.mjs` proves the policy one function at a time and
 * `tests/health.test.mjs` proves the probe; this file tells the whole story
 * the feature exists for — "the active server stopped answering and the
 * extension moved on" — by driving the loop the way the service worker does:
 * a burst of proxy errors, the streak, the probe through the active server,
 * the switch, and the announcement that tells the user which server that was.
 *
 * The harness mirrors `considerFailover()` in `src/background.js` line for
 * line (eligibility → strike → probe → switch, the same synchronous guard,
 * the same state write) and injects the only two things the worker takes from
 * the world: the clock and the network. Servers here are up or down; a probe
 * travels through the active server, exactly like real traffic, so a dead
 * server fails the very check that is supposed to prove it dead. No `chrome.*`
 * and no sockets are involved.
 *
 * Every check answers with a verdict:
 *
 *   - `busy`      another check (and its probe) is already running
 *   - `ineligible` the feature, the switch or the mode says no
 *   - `quiet`     not enough evidence yet — nothing was probed or switched
 *   - `healthy`   the probe answered: the errors were noise, streak forgotten
 *   - `switched`  the probe failed and the next server was activated
 */

/** A fixed clock: the policy is all about elapsed time, so nothing is "now". */
const T0 = 1_700_000_000_000;

const server = (id) => ({ id, name: id, scheme: 'http', host: `${id}.example.com`, port: 8080 });
const A = server('a');
const B = server('b');
const C = server('c');
const D = server('d');
const PROFILES = [A, B, C];

/**
 * @param {{profiles?: object[], activeId?: string, down?: string[], settings?: object,
 *          health?: object}} options
 *   `down` names the servers that are outage at the start; `health` is what the
 *   extension already knows about them (an earlier check, the test button, an
 *   outage that just happened).
 */
function createHarness({
  profiles = PROFILES,
  activeId = 'a',
  down = [],
  settings = {},
  health = {},
} = {}) {
  const state = sanitizeState({
    settings: { mode: 'fixed_servers', enabled: true, activeProfileId: activeId, ...settings },
    profiles,
  });
  const record = createFailoverRecord();
  // The verdicts the worker already had — a background check, the manual test
  // button, an outage a moment ago. `considerFailover()` passes this record into
  // the policy, which is why the harness holds it too.
  const verdicts = sanitizeServerHealth(health);
  const live = new Set(profiles.map((profile) => profile.id).filter((id) => !down.includes(id)));
  const switches = [];
  /** What the user was told, in order — `lib/notice.js` builds these. */
  const notices = [];
  let probeRuns = 0;
  let confirming = false;
  let gate = null;
  let now = T0;

  // The proxy is applied to the whole browser, so probes take the same route
  // as page traffic: through the active server. Down there means an error here.
  const fetchImpl = async () => {
    if (gate) await gate;
    if (!live.has(state.settings.activeProfileId)) {
      throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
    }
    return { status: 204 };
  };

  /** The same shape `updateFailover()` has in storage: mutate, then sanitize. */
  const update = (mutator) => {
    const decision = mutator(record);
    Object.assign(record, sanitizeFailoverRecord(record));
    return decision;
  };

  /**
   * The "Back to <server>" button on the switch notification — mirrors
   * `undoSwitch()` in `src/background.js`.
   *
   * @returns {string|null} the server that was activated, or null when the
   *          offer has gone stale (the worker opens the server list instead)
   */
  function undo() {
    const target = failoverUndoTarget(record, state);
    if (!target) return null;

    state.settings.activeProfileId = target.id;
    state.settings.mode = 'fixed_servers';
    state.settings.enabled = true;
    update((draft) => noteManualSwitch(draft, { now, activeProfileId: target.id }));
    return target.id;
  }

  /** Mirrors `considerFailover()` in `src/background.js`. */
  async function considerFailover() {
    if (confirming) return 'busy';
    confirming = true;
    try {
      if (!failoverEligible(state)) return 'ineligible';

      const context = {
        now,
        activeProfileId: state.settings.activeProfileId,
        profiles: state.profiles,
        health: verdicts,
      };

      if (!update((draft) => noteProxyError(draft, context))) return 'quiet';

      probeRuns += 1;
      const outcome = await probe({ fetchImpl });

      // A probe through the active server is a verdict about that server
      // (`probeObservation`, manual mode only), and where the round moves next
      // is read back out of those verdicts — the worker does exactly this, in
      // this order.
      const observation = probeObservation(state, outcome, now);
      if (observation) noteServerHealth(verdicts, observation);

      if (outcome.ok) {
        // The server answered: whatever failed was not the route's fault.
        update((draft) => noteHealthy(draft));
        return 'healthy';
      }

      const nextId = update((draft) => planFailover(draft, context));
      if (!nextId) return 'quiet';

      const nextProfile = state.profiles.find((profile) => profile.id === nextId) ?? null;
      const failedProfile = state.profiles.find(
        (profile) => profile.id === state.settings.activeProfileId,
      ) ?? null;

      // Writing the state is all a switch is — the same write a manual pick does.
      state.settings.activeProfileId = nextId;
      state.settings.mode = 'fixed_servers';
      state.settings.enabled = true;
      switches.push(nextId);

      // ... and the switch is announced, so it does not happen behind the
      // user's back (the worker also flashes the badge from the same decision).
      const notice = buildSwitchNotice(state, nextProfile, failedProfile, 'en');
      if (notice) notices.push(notice);

      return 'switched';
    } finally {
      confirming = false;
    }
  }

  return {
    state,
    record,
    health: verdicts,
    switches,
    notices,
    get active() {
      return state.settings.activeProfileId;
    },
    get probeRuns() {
      return probeRuns;
    },
    get now() {
      return now;
    },
    considerFailover,
    undo,
    /** `count` proxy errors, one after another, as a dying server's burst does. */
    async errors(count) {
      const results = [];
      for (let index = 0; index < count; index += 1) {
        results.push(await considerFailover());
      }
      return results;
    },
    advance(ms) {
      now += ms;
    },
    /** Freezes the probe mid-flight so several checks can race it. */
    hold() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

test('stray errors on a healthy server are probed and never switch anything', async () => {
  const harness = createHarness();

  // Two errors are not evidence of anything; the third earns a probe — which
  // answers, because the server is right there.
  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'healthy']);
  assert.equal(harness.probeRuns, 1, 'the streak bought exactly one probe');
  assert.deepEqual(harness.record, createFailoverRecord(), 'the streak is forgotten');
  assert.deepEqual(harness.switches, []);
  assert.equal(harness.active, 'a');

  // ... and the next stray error starts a new streak from scratch.
  assert.deepEqual(await harness.errors(1), ['quiet']);
  assert.equal(harness.probeRuns, 1, 'one error alone is never worth a probe');
  assert.equal(harness.record.strikes, 1);
});

test('an outage is confirmed by a probe, then the extension switches to the next server', async () => {
  const harness = createHarness({ down: ['a'] });

  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'switched']);
  assert.equal(harness.active, 'b', 'the next server in the list took over');
  assert.deepEqual(harness.switches, ['b']);
  assert.equal(harness.probeRuns, 1, 'one probe confirmed the outage before switching');

  // The record tells the whole story of the round so far.
  assert.deepEqual(harness.record.tried, ['a'], 'the dead server is remembered');
  assert.equal(harness.record.strikes, 0, 'the new server starts with a clean streak');
  assert.equal(harness.record.lastSwitchTo, 'b');
  assert.equal(harness.record.lastSwitchAt, harness.now);

  // The switch is the very write a manual pick in the popup would do.
  assert.equal(harness.state.settings.activeProfileId, 'b');
  assert.equal(harness.state.settings.mode, 'fixed_servers');
  assert.equal(harness.state.settings.enabled, true);
});

test('an outage moves to the server that proved itself, not the next line of the list', async () => {
  const harness = createHarness({
    profiles: [A, B, C, D],
    down: ['a'],
    // b failed half a minute ago; d answered in 180 ms a minute ago
    health: {
      b: { ok: false, at: T0 - 30_000, ms: null },
      d: { ok: true, at: T0 - 60_000, ms: 180 },
    },
  });

  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'switched']);
  assert.equal(harness.active, 'd', 'the proven server beats list order and the paused server');
  assert.deepEqual(harness.switches, ['d']);
  assert.deepEqual(
    harness.health.a,
    { ok: false, at: T0, ms: null },
    'the probe wrote a verdict about the server it was leaving',
  );

  // The pause is about a moment, not about a server: while it runs, b is not
  // even in the running — the switch above went to d, not to the list's b.
  assert.equal(nextFailoverTarget([A, B, C], 'a', [], { health: harness.health, now: T0 }), 'c');

  // Once it is over, b is a candidate again, and it is ranked by its verdict:
  // last, behind a server nobody has faulted.
  assert.equal(
    nextFailoverTarget([A, B, C, D], 'd', ['a'], {
      health: harness.health,
      now: T0 + FAILOVER_FAILED_COOLDOWN_MS,
    }),
    'c',
    'a server that failed waits behind one that was never tested',
  );
});

test('when every other server just failed, the round still moves', async () => {
  const harness = createHarness({
    down: ['a'],
    health: {
      b: { ok: false, at: T0 - 10_000, ms: null },
      c: { ok: false, at: T0 - 20_000, ms: null },
    },
  });

  // The pause is a preference, never a veto: with nowhere else to go the next
  // line of the list is taken anyway — a dead server is the worse answer.
  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'switched']);
  assert.equal(harness.active, 'b');
  assert.deepEqual(harness.switches, ['b']);
});

test('the freshly chosen server keeps its chance: the cooldown holds the switch back', async () => {
  const harness = createHarness({ down: ['a', 'b'] });

  await harness.errors(3); // a dies -> b
  assert.equal(harness.active, 'b');

  // b is dead too and the streak completes again — but nothing may abandon a
  // server this soon after choosing it, and no second probe runs either.
  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'quiet']);
  assert.equal(harness.active, 'b');
  assert.equal(harness.probeRuns, 1, 'the cooldown holds back even the probe');
  assert.equal(harness.record.strikes, FAILOVER_STRIKES, 'the streak is kept, only the switch waits');

  // Once the cooldown is over, the same kept streak switches on the next error.
  harness.advance(FAILOVER_COOLDOWN_MS + 1);
  assert.deepEqual(await harness.errors(1), ['switched']);
  assert.equal(harness.active, 'c');
  assert.deepEqual(harness.switches, ['b', 'c']);
});

test('a network that is down everywhere stops after one round instead of flipping forever', async () => {
  const harness = createHarness({ down: ['a', 'b', 'c'] });
  const verdicts = [];

  // Errors keep arriving for minutes while every server is dead.
  for (let hop = 0; hop < 6; hop += 1) {
    verdicts.push(...(await harness.errors(3)));
    harness.advance(FAILOVER_COOLDOWN_MS + 1);
  }

  assert.deepEqual(harness.switches, ['b', 'c'], 'each other server is tried once, in order');
  assert.equal(harness.active, 'c');
  assert.deepEqual(harness.record.tried, ['a', 'b'], 'every server has had its chance');
  assert.equal(harness.probeRuns, 2, 'two probes, no thrashing between broken servers');
  assert.equal(verdicts.filter((verdict) => verdict === 'switched').length, 2);
  assert.ok(
    verdicts.every((verdict) => verdict === 'quiet' || verdict === 'switched'),
    'once the round is over the extension reports ERR instead of acting',
  );
});

test('with failover off, an outage is only an ERR badge', async () => {
  for (const settings of [{ autoFailover: false }, { enabled: false }, { mode: 'pac_script' }]) {
    const harness = createHarness({ down: ['a'], settings });
    assert.deepEqual(
      await harness.errors(5),
      Array(5).fill('ineligible'),
      `no check runs with ${JSON.stringify(settings)}`,
    );
    assert.equal(harness.probeRuns, 0, 'not even a probe');
    assert.equal(harness.active, 'a');
    assert.deepEqual(harness.switches, []);
    assert.deepEqual(harness.record, createFailoverRecord());
  }
});

test('a burst of proxy errors runs exactly one check', async () => {
  const harness = createHarness({ down: ['a'] });

  await harness.errors(2); // the streak, minus the error that asks for a probe

  // A dead server fires its errors in a burst: the first one reaches the
  // probe and freezes there, the rest must pile up behind the guard.
  const release = harness.hold();
  const pending = Array.from({ length: 4 }, () => harness.considerFailover());
  release();
  const verdicts = await Promise.all(pending);

  assert.deepEqual(verdicts, ['switched', 'busy', 'busy', 'busy']);
  assert.equal(harness.probeRuns, 1, 'a burst costs exactly one probe');
  assert.equal(harness.active, 'b');
});

test('the switch names the server that took over', async () => {
  const harness = createHarness({ down: ['a'] });

  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'switched']);

  assert.equal(harness.notices.length, 1, 'one switch, one announcement');
  const [notice] = harness.notices;
  assert.equal(notice.title, 'Server changed');
  assert.ok(notice.message.includes('b'), `the new server must be named: ${notice.message}`);
  assert.ok(!notice.message.includes('{'), 'the placeholder must be filled in');
});

test('an outage nobody could act on is not announced', async () => {
  // failover switched off: nothing happens, so there is nothing to report
  const quiet = createHarness({ down: ['a'], settings: { autoFailover: false } });
  await quiet.errors(5);
  assert.deepEqual(quiet.notices, []);

  // a network that is down everywhere still switches twice, and says so twice
  const everywhere = createHarness({ down: ['a', 'b', 'c'] });
  for (let hop = 0; hop < 4; hop += 1) {
    await everywhere.errors(3);
    everywhere.advance(FAILOVER_COOLDOWN_MS + 1);
  }
  assert.deepEqual(everywhere.switches, ['b', 'c']);
  assert.equal(everywhere.notices.length, 2, 'every switch is announced, and only the switches');
  assert.equal(new Set(everywhere.notices.map((notice) => notice.id)).size, 1, 'one live notification');
});

test('the notification takes the user back to the server that failed', async () => {
  const harness = createHarness({ down: ['a'] });

  await harness.errors(3); // a dies -> b, and the notification says so
  assert.equal(harness.active, 'b');
  assert.equal(harness.notices[0].button, 'Back to a');

  // the user clicks it: the browser goes back to the server it came from
  assert.equal(harness.undo(), 'a');
  assert.equal(harness.active, 'a');
  assert.equal(harness.state.settings.mode, 'fixed_servers');

  // a is still dead — the server the user chose on purpose keeps its grace
  // period, so the policy does not drag them straight back to b
  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'quiet']);
  assert.equal(harness.active, 'a');
  assert.equal(harness.probeRuns, 1, 'the cooldown holds back even the probe');

  // ... and once that is over, the same policy decides again
  harness.advance(FAILOVER_COOLDOWN_MS + 1);
  assert.deepEqual(await harness.errors(1), ['switched']);
  assert.equal(harness.active, 'b');
  assert.equal(harness.notices.length, 2, 'the second switch is announced too');
});

test('there is nothing to undo once the user has picked a server themselves', async () => {
  const harness = createHarness({ down: ['a'] });
  await harness.errors(3);
  assert.equal(harness.active, 'b');

  // the popup writes the same state an automatic switch writes, so the offer
  // has to be checked against where the round thinks it left the user
  harness.state.settings.activeProfileId = 'c';
  assert.equal(harness.undo(), null);
  assert.equal(harness.active, 'c', 'a stale offer must not move anything');
});

test('a user who turned the announcement off still gets the switch', async () => {
  const harness = createHarness({ down: ['a'], settings: { notifyFailover: false } });

  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'switched']);
  assert.equal(harness.active, 'b', 'the switch itself is not optional');
  assert.deepEqual(harness.notices, []);
});

test('once the new server answers, the bookkeeping starts over', async () => {
  const harness = createHarness({ down: ['a'] });

  await harness.errors(3); // a dies -> b, b is healthy
  assert.equal(harness.active, 'b');

  // The cooldown passes, errors keep coming from b — and the probe answers,
  // so nothing switches and the whole round is forgotten.
  harness.advance(FAILOVER_COOLDOWN_MS + 1);
  assert.deepEqual(await harness.errors(3), ['quiet', 'quiet', 'healthy']);
  assert.equal(harness.active, 'b');
  assert.deepEqual(harness.switches, ['b']);
  assert.equal(harness.probeRuns, 2, 'the outage probe plus the recovery probe');
  assert.deepEqual(harness.record, createFailoverRecord());
});
