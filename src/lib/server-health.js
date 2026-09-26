/**
 * What the extension knows about each server: whether it last answered, and
 * how fast.
 *
 * The knowledge is deliberately small — one verdict per server — because it is
 * only ever written from places that *prove* something: the probe that confirms
 * a failover (`src/background.js`), the manual **Test connection** button, and
 * the periodic background check (`lib/server-probe.js`), which routes its own
 * probe through the server it is checking and therefore knows exactly whom the
 * answer belongs to.
 *
 * The first of those travels through the active server, and the rule for
 * attributing a verdict (`probeObservation`) therefore only fires in manual
 * mode, where the active server is the one and only hop traffic can be going
 * through. In PAC mode a chain hides which hop answered, and guessing would be
 * worse than not knowing.
 *
 * One thing is decided with it: the order of the chain in the generated PAC
 * script — `orderServersByHealth` puts the server that last proved it works
 * first (fastest of the healthy ones first), leaves servers nobody has looked
 * at in the order of the list, and pushes a server that last failed to the end.
 * Records expire (see `SERVER_HEALTH_TTL_MS`), so a verdict can neither promote
 * nor demote a server forever.
 *
 * Like the failover bookkeeping this lives in its own storage key, outside the
 * state: it is memory, not configuration, so it is never exported and never
 * written into a backup file.
 */

import { formatDuration } from './health.js';
import { effectiveMode, findProfile } from './model.js';

/**
 * How long a verdict counts. After that the server is simply unknown again.
 *
 * Long enough to outlive a background check (see `lib/server-probe.js`, which
 * re-takes a verdict after `PROBE_REFRESH_MS`), so a verdict cannot expire in
 * the gap between two checks and make the chain flicker back to list order.
 */
export const SERVER_HEALTH_TTL_MS = 20 * 60_000;

/** @returns {object} an empty record: nobody has been looked at yet. */
export function createServerHealth() {
  return {};
}

/** Coerces anything (old storage, a hand-edited value) into a valid record. */
export function sanitizeServerHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!id || !entry || typeof entry !== 'object') continue;
    const at = Number(entry.at);
    if (typeof entry.ok !== 'boolean' || !Number.isFinite(at) || at <= 0) continue;
    // A failure has no speed to speak of, and `Number(null)` is 0 — a number
    // that would outrank every real latency — so only a real, non-negative
    // number survives, and only for a server that actually answered.
    const ms = typeof entry.ms === 'number' ? entry.ms : NaN;
    result[id] = {
      ok: entry.ok,
      at,
      ms: entry.ok && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null,
    };
  }
  return result;
}

/** Whether two records say the same thing (the timestamps do count — they are the TTL). */
export function sameServerHealth(left, right) {
  const a = sanitizeServerHealth(left);
  const b = sanitizeServerHealth(right);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => b[key] && a[key].ok === b[key].ok && a[key].at === b[key].at && a[key].ms === b[key].ms,
  );
}

/**
 * Records one verdict. The record is replaced wholesale (mutated in place, like
 * the failover record), so a server that is gone from the caller's world leaves
 * nothing behind.
 *
 * @param {object} record mutated in place
 * @param {{id?: string, ok?: boolean, at?: number, ms?: number|null}} observation
 */
export function noteServerHealth(record, observation = {}) {
  const id = typeof observation.id === 'string' && observation.id ? observation.id : null;
  const ok = observation.ok === true;
  if (!id || typeof observation.ok !== 'boolean') return;

  const next = sanitizeServerHealth({
    ...sanitizeServerHealth(record),
    [id]: { ok, at: observation.at, ms: observation.ms ?? null },
  });

  for (const key of Object.keys(record ?? {})) delete record[key];
  Object.assign(record, next);
}

/**
 * What a probe result proves, and about which server — or null when it proves
 * nothing about anybody.
 *
 * @param {object} state
 * @param {{ok?: boolean, ms?: number}|null} outcome the probe's verdict
 * @param {number} [now]
 * @returns {{id: string, ok: boolean, at: number, ms: number|null}|null}
 */
export function probeObservation(state, outcome, now = Date.now()) {
  // Manual mode is the only one where "the active server" is the whole route:
  // in every other mode the answer came from something else (the system proxy,
  // a PAC script, a chain), so nothing about a saved server follows from it.
  if (effectiveMode(state) !== 'fixed_servers') return null;

  // No outcome, or an outcome that never answered either way, is no verdict at
  // all — recording "failed" for a check that did not run would demote a server
  // nobody has looked at.
  if (!outcome || typeof outcome.ok !== 'boolean') return null;

  const profile = findProfile(state, state?.settings?.activeProfileId);
  if (!profile?.id) return null;

  const ms = outcome.ok && Number.isFinite(outcome.ms) ? Math.round(outcome.ms) : null;
  return {
    id: profile.id,
    ok: outcome.ok,
    at: Number.isFinite(now) ? now : Date.now(),
    ms,
  };
}

/**
 * The verdict that still counts for a server, or null when there is none (never
 * looked at, or older than `SERVER_HEALTH_TTL_MS`).
 *
 * @param {object|null} health a health record
 * @param {string} id
 * @param {number} [now]
 * @returns {{ok: boolean, at: number, ms: number|null}|null}
 */
export function freshVerdict(health, id, now = Date.now()) {
  return verdictIn(sanitizeServerHealth(health), id, now);
}

/** The same question asked of an already-cleaned record (the inner loop). */
function verdictIn(known, id, now) {
  if (!id) return null;
  const entry = known[id];
  if (!entry || now - entry.at > SERVER_HEALTH_TTL_MS) return null;
  return entry;
}

/**
 * How old a verdict is, said in words: "just now", "12 min ago", "3 h ago".
 * Minutes are the smallest unit worth showing — a check runs every few minutes,
 * so seconds would be noise.
 *
 * @param {number} ageMs
 * @returns {{key: string, params?: object}}
 */
export function describeVerdictAge(ageMs) {
  const seconds = Math.floor(Math.max(0, Number(ageMs) || 0) / 1000);
  if (seconds < 60) return { key: 'health.serverAge.now' };

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: 'health.serverAge.minutes', params: { count: minutes } };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'health.serverAge.hours', params: { count: hours } };

  return { key: 'health.serverAge.days', params: { count: Math.floor(hours / 24) } };
}

/**
 * What the server list says about one server: the last verdict and its age, or
 * null when nobody has ever looked at it — a server the extension has no
 * opinion about says nothing rather than "unknown".
 *
 * The verdict is shown even once it is too old to order the chain, but its
 * `current` flag is false, so the list can dim it exactly when the chain stops
 * counting it. What you see and what the chain does stay the same thing.
 *
 * @param {object|null} health the recorded verdicts
 * @param {string} id
 * @param {number} [now]
 * @returns {{tone: 'ok'|'warn', current: boolean, state: {key: string, params?: object}, age: {key: string, params?: object}}|null}
 */
export function describeServerVerdict(health, id, now = Date.now()) {
  if (!id) return null;
  const entry = sanitizeServerHealth(health)[id];
  if (!entry) return null;

  return {
    tone: entry.ok ? 'ok' : 'warn',
    current: freshVerdict(health, id, now) !== null,
    state: entry.ok
      ? { key: 'health.serverOk', params: { ms: formatDuration(entry.ms) } }
      : { key: 'health.serverFail' },
    age: describeVerdictAge(now - entry.at),
  };
}

/**
 * The order servers should be tried in: what was just proven, first.
 *
 * Three groups, and nothing else moves: servers that recently answered (fastest
 * first), servers nobody has looked at (list order), and servers that recently
 * failed (list order, at the end). A verdict older than `SERVER_HEALTH_TTL_MS`
 * counts as no verdict at all, so the ranking is about *recent* health.
 *
 * @param {object[]} servers in list order
 * @param {object|null} health a health record
 * @param {number} [now]
 * @returns {object[]} a new array; the input is untouched
 */
export function orderServersByHealth(servers, health, now = Date.now()) {
  const list = Array.isArray(servers) ? [...servers] : [];
  const known = sanitizeServerHealth(health);

  const group = (entry) => (entry ? (entry.ok ? 0 : 2) : 1);
  // Only a verdict that counts can speak: an expired one is unknown again, and
  // an unknown server is compared by list position, not by a speed it no longer
  // has. A failure has no speed either, which is why it never outranks a
  // healthy one by being "fast".
  const latency = (entry) => (entry?.ok ? entry.ms ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
  const knownNow = (server) => verdictIn(known, server?.id, now);

  return list
    .map((server, index) => ({ server, index }))
    .sort((a, b) => {
      const left = knownNow(a.server);
      const right = knownNow(b.server);
      return (
        group(left) - group(right) || latency(left) - latency(right) || a.index - b.index
      );
    })
    .map((entry) => entry.server);
}
