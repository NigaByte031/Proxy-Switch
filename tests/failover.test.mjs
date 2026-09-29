import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILOVER_COOLDOWN_MS,
  FAILOVER_FAILED_COOLDOWN_MS,
  FAILOVER_IDLE_MS,
  FAILOVER_STRIKES,
  createFailoverRecord,
  failoverEligible,
  failoverUndoTarget,
  nextFailoverTarget,
  noteHealthy,
  noteManualSwitch,
  noteProxyError,
  planFailover,
  sameFailoverRecord,
  sanitizeFailoverRecord,
} from '../src/lib/failover.js';
import { createDefaultState, sanitizeState } from '../src/lib/model.js';
import { SERVER_HEALTH_TTL_MS } from '../src/lib/server-health.js';

/** A fixed clock: the policy is all about elapsed time, so nothing is "now". */
const T0 = 1_700_000_000_000;

const server = (id) => ({ id, name: id, scheme: 'http', host: `${id}.example.com`, port: 8080 });
const A = server('a');
const B = server('b');
const C = server('c');
const PROFILES = [A, B, C];

/** A state in manual mode on server `a`, with the feature at its default. */
const stateWith = (settings = {}) =>
  sanitizeState({
    settings: { mode: 'fixed_servers', enabled: true, activeProfileId: 'a', ...settings },
    profiles: PROFILES,
  });

test('the new setting defaults to on and survives a round trip', () => {
  assert.equal(createDefaultState().settings.autoFailover, true);
  assert.equal(stateWith().settings.autoFailover, true);
  assert.equal(stateWith({ autoFailover: false }).settings.autoFailover, false);
  // a hand-edited value falls back to the default instead of lying
  assert.equal(sanitizeState({ settings: { autoFailover: 'yes' } }).settings.autoFailover, true);
  assert.deepEqual(sanitizeState(stateWith({ autoFailover: false })), stateWith({ autoFailover: false }));
});

test('failover needs the switch on, manual mode and somewhere to go', () => {
  assert.equal(failoverEligible(stateWith()), true);

  assert.equal(failoverEligible(stateWith({ autoFailover: false })), false, 'the setting is off');
  assert.equal(failoverEligible(stateWith({ enabled: false })), false, 'the master switch is off');
  assert.equal(failoverEligible(stateWith({ mode: 'system' })), false, 'not a saved server');
  assert.equal(failoverEligible(stateWith({ mode: 'pac_script' })), false, 'not a saved server');
  assert.equal(
    failoverEligible({
      settings: { autoFailover: true, enabled: true, mode: 'fixed_servers', activeProfileId: null },
      profiles: PROFILES,
    }),
    false,
    'no server is active',
  );
  assert.equal(
    failoverEligible({
      settings: { autoFailover: true, enabled: true, mode: 'fixed_servers', activeProfileId: 'a' },
      profiles: [A],
    }),
    false,
    'nowhere to go',
  );

  assert.equal(failoverEligible(null), false);
  assert.equal(failoverEligible(undefined), false);
});

test('the record rejects garbage instead of trusting it', () => {
  assert.deepEqual(sanitizeFailoverRecord(null), createFailoverRecord());
  assert.deepEqual(sanitizeFailoverRecord('nonsense'), createFailoverRecord());
  assert.deepEqual(
    sanitizeFailoverRecord({ strikes: 'many', tried: 'all', lastSwitchTo: 7, lastSwitchAt: 'x' }),
    createFailoverRecord(),
  );

  // a streak that grew while nobody was watching cannot trigger an instant switch
  assert.equal(sanitizeFailoverRecord({ strikes: 99 }).strikes, FAILOVER_STRIKES);
  assert.equal(sanitizeFailoverRecord({ strikes: -4 }).strikes, 0);
  assert.equal(sanitizeFailoverRecord({ strikes: 2.9 }).strikes, 2);

  assert.deepEqual(sanitizeFailoverRecord({ tried: ['b', 'b', '', 1, null, 'a'] }).tried, ['b', 'a']);
  assert.deepEqual(sanitizeFailoverRecord({ lastSwitchTo: 'b', lastErrorAt: 5 }).lastSwitchTo, 'b');

  assert.equal(sameFailoverRecord(createFailoverRecord(), createFailoverRecord()), true);
  assert.equal(sameFailoverRecord({ strikes: 1 }, { strikes: 1, lastErrorAt: 9 }), false);
  assert.equal(sameFailoverRecord({ tried: ['a'] }, { tried: ['b'] }), false);
  assert.equal(sameFailoverRecord(null, createFailoverRecord()), true);
});

test('the next target walks the list, wraps and skips what was tried', () => {
  assert.equal(nextFailoverTarget(PROFILES, 'a', []), 'b');
  assert.equal(nextFailoverTarget(PROFILES, 'b', []), 'c');
  assert.equal(nextFailoverTarget(PROFILES, 'c', []), 'a', 'wraps around the end');

  assert.equal(nextFailoverTarget(PROFILES, 'a', ['b']), 'c');
  assert.equal(nextFailoverTarget(PROFILES, 'c', ['a', 'b']), null, 'the round is over');
  assert.equal(nextFailoverTarget([A, B], 'a', ['b']), null);

  assert.equal(nextFailoverTarget([A], 'a', []), null, 'one server is not a failover');
  assert.equal(nextFailoverTarget(PROFILES, null, []), null);
  assert.equal(nextFailoverTarget([], 'a', []), null);
  // the active server vanished from the list: start from the top
  assert.equal(nextFailoverTarget(PROFILES, 'gone', []), 'a');
});

test('the next target is the healthiest server, not the next line of the list', () => {
  // b is next in the list, but c was last seen answering — and faster.
  const health = {
    b: { ok: true, at: T0 - 60_000, ms: 300 },
    c: { ok: true, at: T0 - 60_000, ms: 90 },
  };
  assert.equal(nextFailoverTarget(PROFILES, 'a', [], { health, now: T0 }), 'c');

  // A server that proved itself also outranks one nobody has looked at.
  assert.equal(nextFailoverTarget(PROFILES, 'c', [], { health, now: T0 }), 'b');

  // But only while the verdict counts: expired is unknown again.
  const expired = { b: { ok: true, at: T0 - SERVER_HEALTH_TTL_MS - 1, ms: 10 } };
  assert.equal(
    nextFailoverTarget(PROFILES, 'c', [], { health: expired, now: T0 }),
    'a',
    'a verdict nobody counts any more is not a reason to prefer anybody',
  );

  // With nothing known at all, the walk is what it always was.
  assert.equal(nextFailoverTarget(PROFILES, 'a', [], { now: T0 }), 'b');
  assert.equal(nextFailoverTarget(PROFILES, 'a', [], { health: null, now: T0 }), 'b');
});

test('a server that just failed is passed over, and comes back when the pause is over', () => {
  const failed = { b: { ok: false, at: T0 - FAILOVER_FAILED_COOLDOWN_MS / 2, ms: null } };

  // b is next in the list and inside the pause: the round goes to c instead
  assert.equal(nextFailoverTarget(PROFILES, 'a', [], { health: failed, now: T0 }), 'c');

  // The pause breaks a tie between two failed servers: the one that failed longer
  // ago is the better guess, even though list order would reach for b first.
  const bothFailed = {
    b: { ok: false, at: T0 - 10_000, ms: null },
    c: { ok: false, at: T0 - 5 * 60_000, ms: null },
  };
  assert.equal(nextFailoverTarget(PROFILES, 'a', [], { health: bothFailed, now: T0 }), 'c');

  // Once the pause has run out, b is an ordinary candidate again — still last.
  assert.equal(
    nextFailoverTarget(PROFILES, 'a', [], { health: failed, now: T0 + FAILOVER_FAILED_COOLDOWN_MS }),
    'c',
    'a failing server stays behind a server nobody has faulted',
  );

  // The pause is a preference, never a veto: the only way off a dead server wins.
  assert.equal(
    nextFailoverTarget([A, B], 'a', [], { health: { b: { ok: false, at: T0 } }, now: T0 }),
    'b',
    'being stuck on a dead server is the worse answer',
  );

  // It cannot outlive the verdict behind it.
  const ancient = { b: { ok: false, at: T0 - SERVER_HEALTH_TTL_MS - 1, ms: null } };
  assert.equal(
    nextFailoverTarget(PROFILES, 'a', [], { health: ancient, now: T0 }),
    'b',
    'an expired failure is not a reason to skip a server',
  );
});

test('a switch is planned onto the server the verdicts point at', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };
  const health = {
    b: { ok: false, at: T0 - 1000, ms: null },
    c: { ok: true, at: T0 - 1000, ms: 80 },
  };

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  assert.equal(noteProxyError(record, { ...context, now: T0 + 2, health }), true);

  assert.equal(planFailover(record, { ...context, now: T0 + 2, health }), 'c');
  assert.deepEqual(record.tried, ['a'], 'the server it left is the one this round tried');
  assert.equal(record.lastSwitchTo, 'c');
  assert.equal(record.lastSwitchAt, T0 + 2);

  // the same decision without the verdicts still walks the list
  const blind = createFailoverRecord();
  assert.equal(planFailover(blind, { ...context, now: T0 }), 'b');
});

test('three proxy errors are needed before the route is worth a probe', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  assert.equal(noteProxyError(record, context), false);
  assert.equal(record.strikes, 1);
  assert.equal(noteProxyError(record, { ...context, now: T0 + 10 }), false);
  assert.equal(noteProxyError(record, { ...context, now: T0 + 20 }), true);
  assert.equal(record.strikes, FAILOVER_STRIKES);
  assert.equal(record.lastErrorAt, T0 + 20);

  // From here on nothing changes — and an unchanged record is not written again.
  const frozen = structuredClone(record);
  assert.equal(noteProxyError(record, { ...context, now: T0 + 30 }), true);
  assert.equal(noteProxyError(record, { ...context, now: T0 + 40 }), true);
  assert.ok(sameFailoverRecord(record, frozen), 'the streak must stop growing at the threshold');
});

test('errors that could not lead anywhere are not counted', () => {
  const record = createFailoverRecord();

  assert.equal(noteProxyError(record, { now: T0, activeProfileId: 'a', profiles: [A] }), false);
  assert.equal(noteProxyError(record, { now: T0, activeProfileId: null, profiles: PROFILES }), false);
  assert.equal(noteProxyError(record, { now: T0 }), false);
  assert.ok(sameFailoverRecord(record, createFailoverRecord()), 'nothing was recorded');

  // and a probe nobody asked for cannot be planned
  assert.equal(planFailover(createFailoverRecord(), { now: T0, activeProfileId: 'a', profiles: [A] }), null);
});

test('a probe that answers means the server is alive — forget the streak', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });
  assert.equal(record.strikes, FAILOVER_STRIKES);

  noteHealthy(record);
  assert.ok(sameFailoverRecord(record, createFailoverRecord()));
});

test('a switch picks the next server and cools down for a while', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });

  const switchedAt = T0 + 2;
  assert.equal(planFailover(record, { ...context, now: switchedAt }), 'b');
  assert.equal(record.lastSwitchTo, 'b');
  assert.deepEqual(record.tried, ['a'], 'the server that just failed must not be picked again');
  assert.equal(record.strikes, 0, 'the new server starts with a clean streak');
  assert.equal(record.lastSwitchAt, switchedAt);

  // the new server gets its chance: a full streak inside the cooldown is ignored
  const onB = { now: switchedAt + 1, activeProfileId: 'b', profiles: PROFILES };
  noteProxyError(record, onB);
  noteProxyError(record, { ...onB, now: switchedAt + 2 });
  assert.equal(
    noteProxyError(record, { ...onB, now: switchedAt + 3 }),
    false,
    'nothing switches this soon after a switch',
  );
  assert.equal(record.strikes, FAILOVER_STRIKES, 'the streak is kept, only the switch is held back');

  // once the cooldown is over the same streak may switch again
  assert.equal(
    noteProxyError(record, { ...onB, now: switchedAt + FAILOVER_COOLDOWN_MS + 1 }),
    true,
  );
});

test('picking a server by hand starts a fresh round', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });
  assert.equal(planFailover(record, { ...context, now: T0 + 2 }), 'b');

  noteProxyError(record, { now: T0 + 3, activeProfileId: 'b', profiles: PROFILES });
  assert.equal(record.strikes, 1, 'errors on the server we just chose count from scratch');

  // the user clicks another server: the round described the old one
  noteProxyError(record, { now: T0 + 4, activeProfileId: 'c', profiles: PROFILES });
  assert.equal(record.strikes, 1, 'the manual pick reset the round first');
  assert.deepEqual(record.tried, [], 'servers tried under the old server are forgotten');
  assert.equal(record.lastSwitchTo, null);
});

test('the server a switch moved away from is the way back', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  // nothing has switched yet
  assert.equal(failoverUndoTarget(record, stateWith()), null);

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });
  assert.equal(planFailover(record, { ...context, now: T0 + 2 }), 'b');

  // the state now sits on b, and the round remembers a — that is the undo
  const back = failoverUndoTarget(record, stateWith({ activeProfileId: 'b' }));
  assert.equal(back?.id, 'a');
  assert.equal(back?.name, 'a', 'the profile itself, not just the id');

  // a server the user picked since is a different story, and so is a deleted one
  assert.equal(failoverUndoTarget(record, stateWith({ activeProfileId: 'c' })), null);
  const withoutA = sanitizeState({
    settings: { mode: 'fixed_servers', enabled: true, activeProfileId: 'b' },
    profiles: [B, C],
  });
  assert.equal(failoverUndoTarget(record, withoutA), null, 'the server to go back to is gone');
  assert.equal(failoverUndoTarget(record, createDefaultState()), null);
  assert.equal(failoverUndoTarget(undefined, stateWith({ activeProfileId: 'b' })), null);
});

test('a switch the user asks for starts the round over, cooldown included', () => {
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: PROFILES };

  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });
  assert.equal(planFailover(record, { ...context, now: T0 + 2 }), 'b');

  // the user clicks "back to a" a second after the switch
  const backAt = T0 + 3;
  noteManualSwitch(record, { now: backAt, activeProfileId: 'a' });
  assert.deepEqual(record.tried, [], 'nothing is "already tried" for a server the user chose');
  assert.equal(record.strikes, 0);
  assert.equal(record.lastSwitchTo, 'a');

  const onA = { activeProfileId: 'a', profiles: PROFILES };
  noteProxyError(record, { ...onA, now: backAt });
  noteProxyError(record, { ...onA, now: backAt + 1 });
  assert.equal(
    noteProxyError(record, { ...onA, now: backAt + 2 }),
    false,
    'the server we went back to keeps its chance, even if it is still dead',
  );
  assert.equal(
    noteProxyError(record, { ...onA, now: backAt + FAILOVER_COOLDOWN_MS + 1 }),
    true,
    'after the cooldown the same policy applies again',
  );
});

test('a round visits every server once and then stops', () => {
  const record = createFailoverRecord();
  const switches = [];
  let activeId = 'a';
  let now = T0;

  for (let round = 0; round < 10; round += 1) {
    // a full streak, as a dead server would produce
    for (let strike = 0; strike < FAILOVER_STRIKES; strike += 1) {
      const asked = noteProxyError(record, { now, activeProfileId: activeId, profiles: PROFILES });
      now += 10;
      if (!asked) continue;
      // the probe failed (it would not have been asked for otherwise)
      const nextId = planFailover(record, { now, activeProfileId: activeId, profiles: PROFILES });
      if (nextId === null) return finish(switches, record, activeId);
      switches.push(nextId);
      activeId = nextId;
      now += FAILOVER_COOLDOWN_MS + 1;
      break;
    }
  }
  finish(switches, record, activeId);
});

function finish(switches, record, activeId) {
  assert.deepEqual(switches, ['b', 'c'], 'a dead list is walked once, in order');
  assert.equal(activeId, 'c');
  assert.deepEqual(record.tried, ['a', 'b'], 'every other server has had its chance');
}

test('a round that went quiet is retried instead of remembered forever', () => {
  // Two servers: once the second one has had its turn, the round is over.
  const TWO = [A, B];
  const record = createFailoverRecord();
  const context = { now: T0, activeProfileId: 'a', profiles: TWO };

  // walk the whole round until there is nowhere left to go
  noteProxyError(record, context);
  noteProxyError(record, { ...context, now: T0 + 1 });
  noteProxyError(record, { ...context, now: T0 + 2 });
  assert.equal(planFailover(record, { ...context, now: T0 + 2 }), 'b');
  const late = { now: T0 + 3 + FAILOVER_COOLDOWN_MS, activeProfileId: 'b', profiles: TWO };
  noteProxyError(record, late);
  noteProxyError(record, { ...late, now: late.now + 1 });
  noteProxyError(record, { ...late, now: late.now + 2 });
  assert.equal(planFailover(record, { ...late, now: late.now + 2 }), null, 'only a and b exist');

  // errors keep coming, but nothing changes for a long stretch
  const resumed = {
    now: late.now + 2 + FAILOVER_IDLE_MS + 1,
    activeProfileId: 'b',
    profiles: TWO,
  };
  assert.equal(noteProxyError(record, resumed), false, 'the streak starts over');
  assert.equal(record.strikes, 1);
  assert.deepEqual(record.tried, [], 'the old round is behind us');
  assert.equal(noteProxyError(record, { ...resumed, now: resumed.now + 1 }), false);
  assert.equal(noteProxyError(record, { ...resumed, now: resumed.now + 2 }), true, 'and is retried');
});
