/**
 * Auto-failover: when the active server stops answering, move to the next one.
 * Plain functions over a record — no `chrome.*`, no timers, no network — mutated in
 * place and stored as `proxySwitchFailover`: an MV3 worker dies between events.
 *
 * Two rules keep a switch trustworthy: an error alone is not evidence (a probe
 * through the current server has to fail first), and a round visits every other
 * server once instead of flipping forever.
 */

import { findProfile } from './model.js';
import { orderServersByHealth, sanitizeServerHealth } from './server-health.js';

/** Consecutive proxy errors that make the route worth checking with a probe. */
export const FAILOVER_STRIKES = 3;

/**
 * Nothing switches this soon after a switch: the new server gets its chance.
 * This is about *switching*; for the pause a server earns by failing, see
 * `FAILOVER_FAILED_COOLDOWN_MS`.
 */
export const FAILOVER_COOLDOWN_MS = 30_000;

/**
 * How long a server that just failed is passed over while anything else is
 * available. A preference, never a veto: when every candidate is inside the
 * window they all come back, because staying on a server already confirmed dead
 * is the worse answer.
 *
 * Shorter than `FAILOVER_IDLE_MS`, so a fresh round never starts out of options.
 */
export const FAILOVER_FAILED_COOLDOWN_MS = 2 * 60_000;

/**
 * A record older than this starts a fresh round, so a round that ended (every
 * server tried) is retried later instead of being remembered forever.
 */
export const FAILOVER_IDLE_MS = 5 * 60_000;

/**
 * @typedef {object} FailoverRecord
 * @property {number} strikes       consecutive proxy errors worth acting on
 * @property {string[]} tried       servers that failed in the current round
 * @property {string|null} lastSwitchTo  server the last automatic switch picked
 * @property {number} lastSwitchAt  when that switch happened (cooldown clock)
 * @property {number} lastErrorAt   when the strike streak last grew (round clock)
 */

/** @returns {FailoverRecord} an empty record: nothing seen yet, nothing tried. */
export function createFailoverRecord() {
  return { strikes: 0, tried: [], lastSwitchTo: null, lastSwitchAt: 0, lastErrorAt: 0 };
}

/**
 * Coerces old storage or a hand-edited value into a valid record. Strikes are
 * capped at the threshold, so a counter that grew while nobody was watching
 * cannot become an instant switch when the worker wakes up.
 */
export function sanitizeFailoverRecord(raw) {
  const base = createFailoverRecord();
  if (!raw || typeof raw !== 'object') return base;

  const strikes = Number(raw.strikes);
  const lastSwitchAt = Number(raw.lastSwitchAt);
  const lastErrorAt = Number(raw.lastErrorAt);
  const tried = Array.isArray(raw.tried) ? raw.tried : [];

  return {
    strikes:
      Number.isFinite(strikes) && strikes > 0
        ? Math.min(Math.floor(strikes), FAILOVER_STRIKES)
        : base.strikes,
    tried: [...new Set(tried.filter((id) => typeof id === 'string' && id))],
    lastSwitchTo:
      typeof raw.lastSwitchTo === 'string' && raw.lastSwitchTo ? raw.lastSwitchTo : null,
    lastSwitchAt: Number.isFinite(lastSwitchAt) && lastSwitchAt > 0 ? lastSwitchAt : 0,
    lastErrorAt: Number.isFinite(lastErrorAt) && lastErrorAt > 0 ? lastErrorAt : 0,
  };
}

/** Timestamps count here: they are policy. */
export function sameFailoverRecord(left, right) {
  const a = sanitizeFailoverRecord(left);
  const b = sanitizeFailoverRecord(right);
  return (
    a.strikes === b.strikes &&
    a.lastSwitchTo === b.lastSwitchTo &&
    a.lastSwitchAt === b.lastSwitchAt &&
    a.lastErrorAt === b.lastErrorAt &&
    a.tried.length === b.tried.length &&
    a.tried.every((id, index) => id === b.tried[index])
  );
}

/** Brings a record in place, so every entry point sees a valid one. */
function normalize(record) {
  Object.assign(record, sanitizeFailoverRecord(record));
  return record;
}

/** Starts a round over. */
function resetRecord(record) {
  Object.assign(record, createFailoverRecord());
}

/**
 * Whether failover applies to this state at all: the feature is on, the master
 * switch is on, a manual server is active, and there is somewhere to go.
 */
export function failoverEligible(state) {
  const settings = state?.settings;
  if (!settings?.autoFailover) return false;
  if (!settings.enabled) return false;
  if (settings.mode !== 'fixed_servers') return false;
  if (!settings.activeProfileId) return false;
  return (state?.profiles ?? []).length >= 2;
}

/**
 * Where a round moves to: the healthiest server, not the next line of the list.
 *
 * The candidates are the list walked on from the active server and wrapped around —
 * the order this function answers with when nothing is known about anybody. Servers
 * already tried this round are out, and so is one whose last verdict was a recent
 * failure; what is left is ranked by `orderServersByHealth`, so the same ranking
 * decides this and the PAC chain.
 *
 * @param {object[]} profiles in list order
 * @param {string|null} currentId the active server
 * @param {string[]} [tried] the servers that already failed in this round
 * @param {{now?: number, health?: object|null}} [context] what is known about them
 * @returns {string|null} null when there is nowhere left to go
 */
export function nextFailoverTarget(profiles, currentId, tried = [], context = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length < 2 || !currentId) return null;

  const skip = new Set(Array.isArray(tried) ? tried : []);
  // -1 (the active server is not in the list any more) starts from the top.
  const start = list.findIndex((profile) => profile?.id === currentId);
  const ring = start < 0 ? list : [...list.slice(start + 1), ...list.slice(0, start + 1)];
  const candidates = ring.filter(
    (profile) => profile?.id && profile.id !== currentId && !skip.has(profile.id),
  );
  if (!candidates.length) return null;

  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const known = sanitizeServerHealth(context.health);

  // The pause is a preference, not a veto: when every candidate is inside it
  // they all come back, because being stuck on a dead server is worse.
  const ready = candidates.filter((profile) => !justFailed(known, profile.id, now));
  const pool = ready.length ? ready : candidates;

  return orderServersByHealth(pool, known, now)[0]?.id ?? null;
}

/**
 * Whether this server's last verdict was a failure recent enough to pause it.
 * Shorter than `SERVER_HEALTH_TTL_MS`, so a paused server's verdict still counts.
 */
function justFailed(known, id, now) {
  const entry = known?.[id];
  return Boolean(entry && !entry.ok && now - entry.at < FAILOVER_FAILED_COOLDOWN_MS);
}

/** A round that went quiet long enough is over: the world may have changed. */
function isStale(record, now) {
  if (record.lastErrorAt === 0) return record.strikes > 0 || record.tried.length > 0;
  return now - record.lastErrorAt > FAILOVER_IDLE_MS;
}

/**
 * Records one proxy error and answers whether the route is now worth probing. A
 * round that has gone quiet, or a server the user picked by hand, throws the
 * bookkeeping away first.
 *
 * @param {FailoverRecord} record mutated in place, like an `updateState` mutator
 * @param {{now?: number, activeProfileId?: string|null, profiles?: object[], health?: object|null}} context
 * @returns {boolean} true when the caller should probe before doing anything else
 */
export function noteProxyError(record, context = {}) {
  normalize(record);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const activeProfileId = context.activeProfileId ?? null;
  const profiles = Array.isArray(context.profiles) ? context.profiles : [];

  if (isStale(record, now) || (record.lastSwitchTo && record.lastSwitchTo !== activeProfileId)) {
    resetRecord(record);
  }

  const eligible = profiles.length >= 2 && Boolean(activeProfileId);
  // Capped: once the streak is long enough, further errors change nothing.
  if (eligible && record.strikes < FAILOVER_STRIKES) {
    record.strikes += 1;
    record.lastErrorAt = now;
  }

  return (
    eligible &&
    record.strikes >= FAILOVER_STRIKES &&
    now - record.lastSwitchAt >= FAILOVER_COOLDOWN_MS &&
    nextFailoverTarget(profiles, activeProfileId, record.tried, {
      now,
      health: context.health,
    }) !== null
  );
}

/**
 * The switch itself, only ever called after a probe confirmed the active server is
 * down: marks it tried, moves on to the next one and starts the cooldown.
 *
 * @param {FailoverRecord} record mutated in place
 * @param {{now?: number, activeProfileId?: string|null, profiles?: object[], health?: object|null}} context
 * @returns {string|null} the id to activate, or null when the round is over
 */
export function planFailover(record, context = {}) {
  normalize(record);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const activeProfileId = context.activeProfileId ?? null;
  const profiles = Array.isArray(context.profiles) ? context.profiles : [];

  // A probe got here, so the health verdicts decide who is picked.
  const nextId = nextFailoverTarget(profiles, activeProfileId, record.tried, {
    now,
    health: context.health,
  });
  if (!nextId) return null;

  if (activeProfileId && !record.tried.includes(activeProfileId)) {
    record.tried = [...record.tried, activeProfileId];
  }
  record.strikes = 0;
  record.lastSwitchTo = nextId;
  record.lastSwitchAt = now;
  record.lastErrorAt = now;
  return nextId;
}

/**
 * A probe that answered means the server is alive: the errors were noise, so
 * the streak (and the round) start over.
 */
export function noteHealthy(record) {
  resetRecord(normalize(record));
}

/**
 * The server the last automatic switch moved *away* from, while that is still the
 * news — the target of "go back" on the switch notification. The round remembers
 * it (`tried` ends with the server that failed), and it stops counting as soon as
 * that round is over.
 *
 * @param {FailoverRecord} record
 * @param {object} state
 * @returns {object|null} the profile to go back to, or null when there is none
 */
export function failoverUndoTarget(record, state) {
  const clean = sanitizeFailoverRecord(record);
  const active = state?.settings?.activeProfileId ?? null;
  // Only a server an automatic switch installed can undo one.
  if (!clean.lastSwitchTo || clean.lastSwitchTo !== active) return null;
  const previousId = clean.tried[clean.tried.length - 1] ?? null;
  if (!previousId || previousId === active) return null;
  const previous = findProfile(state, previousId);
  return previous ?? null;
}

/**
 * A switch the user asked for — the "go back" button on the notification. The round
 * starts over (nothing is "already tried" for a server the user chose on purpose),
 * but the server they went back to keeps the grace period an automatic switch gives
 * one.
 *
 * @param {FailoverRecord} record mutated in place
 * @param {{now?: number, activeProfileId?: string|null}} context
 */
export function noteManualSwitch(record, context = {}) {
  normalize(record);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const activeProfileId = context.activeProfileId ?? null;

  resetRecord(record);
  record.lastSwitchTo = activeProfileId;
  record.lastSwitchAt = now;
}
