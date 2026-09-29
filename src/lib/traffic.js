/**
 * Traffic counters (today and total) and the live rate. Pure — no `chrome.*`
 * here; the listeners and the storage writes live in `src/background.js`.
 *
 * Only sizes a request or its response declares (`Content-Length`) are counted,
 * so the totals are a floor, never the real byte count.
 */

import { effectiveMode } from './model.js';

/** Clamp so a corrupt counter cannot overflow `Number.MAX_SAFE_INTEGER`. */
export const TRAFFIC_MAX_BYTES = 1e15;

/** A stored day key has to match this shape. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function createTraffic() {
  return { day: null, up: 0, down: 0, upTotal: 0, downTotal: 0, since: 0, at: 0 };
}

/** A byte count that is safe to add: whole, non-negative, and under the ceiling. */
function bytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.round(number), TRAFFIC_MAX_BYTES);
}

/** Coerces anything (old storage, a hand-edited value) into a valid record. */
export function sanitizeTraffic(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const since = Number(source.since);
  const at = Number(source.at);

  return {
    day: typeof source.day === 'string' && DAY_PATTERN.test(source.day) ? source.day : null,
    up: bytes(source.up),
    down: bytes(source.down),
    upTotal: bytes(source.upTotal),
    downTotal: bytes(source.downTotal),
    since: Number.isFinite(since) && since > 0 ? since : 0,
    at: Number.isFinite(at) && at > 0 ? at : 0,
  };
}

/** A write that changes nothing is skipped. */
export function sameTraffic(left, right) {
  const a = sanitizeTraffic(left);
  const b = sanitizeTraffic(right);
  return Object.keys(b).every((key) => a[key] === b[key]);
}

/**
 * The local calendar day of `now` as `YYYY-MM-DD`, or `null` if `now` is not a
 * date. Local, not UTC: "today" is the day the user is living in.
 *
 * @param {number} [now]
 * @returns {string|null}
 */
export function dayKey(now = Date.now()) {
  const date = new Date(Number(now));
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Today's counters back to zero; the totals do not move.
 *
 * @param {object} record mutated in place
 * @param {number} [now]
 * @returns {boolean} whether the day really changed
 */
export function rollTrafficDay(record, now = Date.now()) {
  const day = dayKey(now);
  if (!record || !day || record.day === day) return false;

  record.day = day;
  record.up = 0;
  record.down = 0;
  return true;
}

/**
 * Adds one batch of declared bytes, rolling the day first so bytes that arrive
 * just after midnight land in the new day.
 *
 * @param {object} record mutated in place
 * @param {{up?: number, down?: number, at?: number}} [observation]
 */
export function noteTraffic(record, observation = {}) {
  if (!record) return record;

  const at = Number(observation.at);
  const stamp = Number.isFinite(at) && at > 0 ? at : Date.now();
  rollTrafficDay(record, stamp);

  const up = bytes(observation.up);
  const down = bytes(observation.down);
  record.up = bytes(record.up + up);
  record.down = bytes(record.down + down);
  record.upTotal = bytes(record.upTotal + up);
  record.downTotal = bytes(record.downTotal + down);
  record.at = stamp;
  if (!record.since) record.since = stamp;
  return record;
}

/**
 * Empties today and the totals, and starts them again now.
 *
 * @param {object} record mutated in place
 * @param {number} [now]
 */
export function resetTraffic(record, now = Date.now()) {
  if (!record) return record;

  const at = Number(now);
  const stamp = Number.isFinite(at) && at > 0 ? at : Date.now();
  record.day = dayKey(stamp);
  record.up = 0;
  record.down = 0;
  record.upTotal = 0;
  record.downTotal = 0;
  record.since = stamp;
  record.at = stamp;
  return record;
}

/**
 * Empties the rate's window; the reset button clears both records together.
 *
 * @param {object} record mutated in place
 */
export function resetRate(record) {
  if (!record) return record;
  record.samples = [];
  return record;
}

/**
 * The declared body size in a header list, or `null` when there is none.
 *
 * Only plain decimal digits count: `*`, an empty or negative value, and two headers
 * that disagree are all things a proxy or a broken server can send, and a size that
 * cannot be trusted would corrupt the record. Zero is reported as `null`.
 *
 * @param {Array<{name?: string, value?: string}>} headers
 * @returns {number|null}
 */
export function parseContentLength(headers) {
  if (!Array.isArray(headers)) return null;

  let size = null;
  for (const header of headers) {
    if (String(header?.name ?? '').toLowerCase() !== 'content-length') continue;

    const value = String(header?.value ?? '').trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    if (size !== null && size !== parsed) return null;
    size = parsed;
  }
  return size;
}

/**
 * The bytes a response declared, or 0. A response from the cache never crossed
 * the network, so its size is not traffic.
 *
 * @param {{fromCache?: boolean, responseHeaders?: object[]}|null} details
 * @returns {number}
 */
export function responseBytes(details) {
  if (!details || details.fromCache === true) return 0;
  return parseContentLength(details.responseHeaders) ?? 0;
}

/**
 * The bytes a request declared, or 0 — which is every request without a body.
 *
 * @param {{requestHeaders?: object[]}|null} details
 * @returns {number}
 */
export function requestBytes(details) {
  return parseContentLength(details?.requestHeaders) ?? 0;
}

/**
 * The meter runs while the extension is routing: `direct` is the one mode
 * excluded, `system` counts.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function meterRuns(state) {
  const settings = state?.settings;
  if (settings?.trafficMeter !== true || settings.enabled !== true) return false;
  return effectiveMode(state) !== 'direct';
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * `0 B`, `37 B`, `1.0 KB`, `2.4 MB`: binary steps (1024), one decimal from KB up.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatBytes(value) {
  let size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '0 B';

  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? Math.round(size) : size.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * What the UI shows, as ready-to-print parts. Today reads as zero when the
 * stored day is not today — the record is only rewritten when something moves.
 *
 * @param {object|null} record
 * @param {number} [now]
 * @returns {{current: boolean, down: string, up: string, totalDown: string, totalUp: string, since: number}}
 */
export function describeTraffic(record, now = Date.now()) {
  const clean = sanitizeTraffic(record);
  // A record with no day at all has never counted anything, so there is nothing
  // to roll: only a stored day that differs from today makes today's part zero.
  const current = clean.day === null || clean.day === dayKey(now);

  return {
    current,
    down: formatBytes(current ? clean.down : 0),
    up: formatBytes(current ? clean.up : 0),
    totalDown: formatBytes(clean.downTotal),
    totalUp: formatBytes(clean.upTotal),
    since: clean.since,
  };
}

/* The live rate: what is moving right now. */

/**
 * How much recent traffic the window keeps. A speed is bytes over time, so every
 * batch the worker writes carries the span it covered (`ms`): the window's bytes
 * divided by the sum of those spans is the last few seconds' speed. Nothing is
 * sampled on a timer — the reading is recomputed on every draw.
 */
export const RATE_WINDOW_MS = 10_000;

/** No sample newer than this means nothing is moving. */
export const RATE_IDLE_MS = 5_000;

/** The shortest span a sample may claim, so a batch cannot divide by ~zero. */
export const RATE_MIN_SPAN_MS = 200;

/** A batch claiming more than the window is untrustworthy: clamp it. */
export const RATE_MAX_SPAN_MS = RATE_WINDOW_MS;

/** Past this a reading is a corrupt value, not traffic. */
export const RATE_MAX_BPS = 1e12;

/** Bounds a record that a bug could otherwise grow forever. */
export const RATE_MAX_SAMPLES = 32;

export function createRate() {
  return { samples: [] };
}

/**
 * One valid sample, or `null`: a span is required, and a sample that counted
 * nothing carries no speed.
 *
 * @param {object} raw
 * @returns {{at: number, ms: number, up: number, down: number}|null}
 */
function sampleOf(raw) {
  const at = Number(raw?.at);
  const ms = Number(raw?.ms);
  const up = bytes(raw?.up);
  const down = bytes(raw?.down);

  if (!Number.isFinite(at) || at <= 0) return null;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (up <= 0 && down <= 0) return null;

  return {
    at: Math.round(at),
    ms: Math.min(Math.max(Math.round(ms), RATE_MIN_SPAN_MS), RATE_MAX_SPAN_MS),
    up,
    down,
  };
}

/**
 * Coerces old storage or a hand-edited value into a valid record. The window is
 * applied on the read, not here, so the record means the same thing whenever it
 * is touched.
 */
export function sanitizeRate(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const samples = Array.isArray(source.samples) ? source.samples : [];

  return { samples: samples.map(sampleOf).filter(Boolean).slice(-RATE_MAX_SAMPLES) };
}

/** A write that changes nothing is skipped. */
export function sameRate(left, right) {
  const a = sanitizeRate(left).samples;
  const b = sanitizeRate(right).samples;

  return (
    a.length === b.length &&
    a.every(
      (sample, index) =>
        sample.at === b[index].at &&
        sample.ms === b[index].ms &&
        sample.up === b[index].up &&
        sample.down === b[index].down,
    )
  );
}

/**
 * Records one batch and the span it covered. The window is swept first, so a
 * record that sat idle does not drag old bytes into a reading.
 *
 * @param {object} record mutated in place
 * @param {{up?: number, down?: number, at?: number, ms?: number}} [observation]
 */
export function noteRate(record, observation = {}) {
  if (!record) return record;

  const at = Number(observation.at);
  const stamp = Number.isFinite(at) && at > 0 ? at : Date.now();
  sweep(record, stamp);

  const sample = sampleOf({ ...observation, at: stamp });
  if (sample) record.samples.push(sample);
  if (record.samples.length > RATE_MAX_SAMPLES) {
    record.samples = record.samples.slice(-RATE_MAX_SAMPLES);
  }
  return record;
}

/**
 * Drops the samples outside the window, in place. Age is read from the end of a
 * sample's span, the moment its bytes were last counted.
 */
function sweep(record, now) {
  const horizon = Number(now) - RATE_WINDOW_MS;
  record.samples = (Array.isArray(record.samples) ? record.samples : []).filter(
    (sample) => Number(sample?.at) >= horizon,
  );
}

/**
 * The speed right now, in bytes per second. A sustained transfer reads its own
 * rate, and one that has slowed down reads the slower number as the fast
 * batches leave the window.
 *
 * @param {object|null} record a rate record
 * @param {number} [now]
 * @returns {{up: number, down: number, live: boolean, last: number}} bytes per
 *   second per direction, whether anything is moving, and the age of the newest
 *   sample in milliseconds (0 when there is none)
 */
export function trafficRate(record, now = Date.now()) {
  // The window is applied against the clock the reader asks about, so a record
  // straight out of storage after the worker slept for an hour holds nothing.
  const stamp = Number.isFinite(now) ? Number(now) : Date.now();
  const samples = sanitizeRate(record).samples.filter(
    (sample) => stamp - sample.at <= RATE_WINDOW_MS && sample.at - stamp <= RATE_WINDOW_MS,
  );
  if (samples.length === 0) return { up: 0, down: 0, live: false, last: 0 };

  let ms = 0;
  let up = 0;
  let down = 0;
  for (const sample of samples) {
    ms += sample.ms;
    up += sample.up;
    down += sample.down;
  }

  const speed = (total) => Math.min((total / ms) * 1000, RATE_MAX_BPS);
  const newest = Math.max(...samples.map((sample) => sample.at));
  const last = Math.max(0, Math.round(stamp - newest));

  return {
    up: speed(up),
    down: speed(down),
    // Seconds-old bytes are not a slow transfer: nothing was counted lately.
    live: last <= RATE_IDLE_MS,
    last,
  };
}

/**
 * What the UI shows for the rate, as ready-to-print parts. `idle` answers "is
 * anything moving?": a burst nine seconds ago is idle, not a live speed.
 *
 * @param {object|null} rate a rate record
 * @param {number} [now]
 * @returns {{idle: boolean, down: string, up: string}}
 */
export function describeRate(rate, now = Date.now()) {
  const { up, down, live } = trafficRate(rate, now);
  const idle = !live;

  return {
    idle,
    // Idle reads as zero: the window may still hold the tail of a burst.
    down: idle ? '0 B/s' : `${formatBytes(down)}/s`,
    up: idle ? '0 B/s' : `${formatBytes(up)}/s`,
  };
}
