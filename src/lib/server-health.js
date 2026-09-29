/**
 * What the extension knows about each server: whether it last answered, and how
 * fast. One verdict per server, written only where something is *proved*: the probe
 * confirming a failover, the manual **Test connection** button, the periodic check.
 * The first travels through the active server, so it counts in manual mode only.
 *
 * Records expire (see `SERVER_HEALTH_TTL_MS`), so a verdict can neither promote nor
 * demote a server forever; like the failover bookkeeping they live in memory.
 */

import { formatDuration } from './health.js';
import { effectiveMode, findProfile } from './model.js';

/**
 * How long a verdict counts; after that the server is simply unknown again. Long
 * enough to outlive a background check (`PROBE_REFRESH_MS`), so the chain cannot
 * flicker back to list order between two checks.
 */
export const SERVER_HEALTH_TTL_MS = 20 * 60_000;

/** An empty record: nobody has been looked at yet. */
export function createServerHealth() {
  return {};
}

/** Coerces old storage or a hand-edited value into a valid record. */
export function sanitizeServerHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!id || !entry || typeof entry !== 'object') continue;
    const at = Number(entry.at);
    if (typeof entry.ok !== 'boolean' || !Number.isFinite(at) || at <= 0) continue;
    // `Number(null)` is 0, which would outrank every real latency, so only a real
    // non-negative number survives, and only from a server that answered.
    const ms = typeof entry.ms === 'number' ? entry.ms : NaN;
    result[id] = {
      ok: entry.ok,
      at,
      ms: entry.ok && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null,
    };
  }
  return result;
}

/** Timestamps count here: they are the TTL. */
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
 * the failover record), so a server gone from the caller's world leaves nothing
 * behind.
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
  // Only in manual mode is the active server the whole route; elsewhere the
  // answer came from a chain or a system proxy, so it proves nothing here.
  if (effectiveMode(state) !== 'fixed_servers') return null;

  // A check that did not run is no verdict: recording "failed" would demote a
  // server nobody has looked at.
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
 * Minutes are the smallest unit worth showing.
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
 * null when nobody has ever looked at it — a server the extension has no opinion
 * about says nothing rather than "unknown".
 *
 * The verdict is shown even once it is too old to order the chain, but `current` is
 * false, so the list dims it exactly when the chain stops counting it.
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
 * failed (list order, at the end). An older verdict counts as no verdict at all, so
 * the ranking is about *recent* health.
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
  // Only a verdict that counts can speak: an expired one is unknown again and is
  // compared by list position. A failure has no speed either.
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
