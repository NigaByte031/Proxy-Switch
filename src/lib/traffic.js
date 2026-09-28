/**
 * The traffic meter: how much has gone down and up, counted on this device.
 *
 * Chrome hands an extension no byte counts — a `webRequest` observer sees that
 * a request happened, not how large it was — so the meter adds up what the
 * browser *declares* before it moves the bytes: the `Content-Length` of a
 * request and of its response. That makes the numbers a floor rather than a
 * total: a streamed video, an event stream or a chunked page arrives without a
 * declared size and is not counted. The UI therefore says what it measured
 * instead of pretending to know, and the note beside it lists what is missing.
 *
 * Everything here is pure — record, arithmetic, header parsing and formatting —
 * so the bookkeeping can be tested in Node. The listeners, the batching and the
 * storage writes live in `src/background.js`, which is the only context that
 * may see a request at all.
 *
 * Like the failover record and the server verdicts, the counters are memory
 * rather than configuration: they live in their own storage key, they are never
 * written into an exported settings file, and a reset does not touch anything
 * the user configured.
 */

import { effectiveMode } from './model.js';

/**
 * The ceiling a counter is clamped to. Bytes are whole numbers and a counter
 * only grows, so a corrupt or hand-written value would otherwise be able to
 * reach `Number.MAX_SAFE_INTEGER` — and every byte added after that would be
 * silently lost. A petabyte is far past any real month of browsing.
 */
export const TRAFFIC_MAX_BYTES = 1e15;

/** `YYYY-MM-DD`, the shape a stored day key has to have to mean anything. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** @returns {object} an empty record: nothing has been counted yet. */
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

/** Whether two records say the same thing (a write that changes nothing is skipped). */
export function sameTraffic(left, right) {
  const a = sanitizeTraffic(left);
  const b = sanitizeTraffic(right);
  return Object.keys(b).every((key) => a[key] === b[key]);
}

/**
 * The local calendar day a moment belongs to, as `YYYY-MM-DD`.
 *
 * Local, not UTC: "today" is the day the user is living in, and a counter that
 * rolled over in the middle of the evening would be wrong in a way nobody could
 * explain. A moment that is not a date at all has no day, and the callers treat
 * that as "do not touch the day".
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
 * Starts a new day: today's counters go back to zero, the totals do not move.
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
 * Records one observation: the bytes a batch of requests said they would send
 * and receive. The day is rolled first, so bytes that arrive just after
 * midnight land in the new day rather than in yesterday's total.
 *
 * Mutated in place, like the failover and health records, so a caller that
 * holds the record can hand it straight to a queued write.
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
 * Empties every counter — today and total — and starts the totals again now.
 * The reset is the user's, so nothing about it is inferred from the record.
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
 * Empties the rate's window. A reset that left a live speed standing would be
 * a reading about bytes that no longer exist anywhere — the reset button clears
 * the two records together.
 *
 * @param {object} record mutated in place
 */
export function resetRate(record) {
  if (!record) return record;
  record.samples = [];
  return record;
}

/**
 * The declared body size in a header list, or null when there is none.
 *
 * Only plain decimal digits count. `*` (unknown), an empty value, a negative
 * number and two `Content-Length` headers that disagree are all things a proxy,
 * a captive portal or a broken server can send; a number we cannot trust is
 * worth less than no number at all, because adding it would corrupt everything
 * the record says. A repeated header that agrees with itself is fine, and a
 * size of zero is reported as null: there is no body, and therefore nothing to
 * count.
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
 * The bytes a response declared it would send (`onCompleted`), or 0 when it
 * declared nothing.
 *
 * A response served from the cache never crossed the network, so its declared
 * size is not traffic: counting it would make a page you open twice look like a
 * download twice.
 *
 * @param {{fromCache?: boolean, responseHeaders?: object[]}|null} details
 * @returns {number}
 */
export function responseBytes(details) {
  if (!details || details.fromCache === true) return 0;
  return parseContentLength(details.responseHeaders) ?? 0;
}

/**
 * The bytes a request declared it would send (`onBeforeSendHeaders`), or 0 when
 * it said nothing — which is every request without a body, the overwhelming
 * majority of them.
 *
 * @param {{requestHeaders?: object[]}|null} details
 * @returns {number}
 */
export function requestBytes(details) {
  return parseContentLength(details?.requestHeaders) ?? 0;
}

/**
 * Whether the meter is running: the user left it on, the proxy is in force, and
 * the traffic is going somewhere.
 *
 * `direct` is the one mode excluded, because it is the one mode where we know
 * for certain that nothing the browser sends is being proxied — counting it
 * would answer a question nobody asked. `system` counts: the traffic is still
 * being routed by a policy the extension put in force, it just belongs to the
 * operating system rather than to a saved server. Whether a request really
 * survived the whole hop cannot be known from here, so the meter counts while
 * the route is *the extension's* — see the note in `README.md`.
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
 * `0 B`, `37 B`, `1.0 KB`, `2.4 MB`, `1.3 GB`. Binary steps (1024) because that
 * is what a byte count means to everything that shows one; one decimal from KB
 * up, the same way `formatDuration` keeps a single decimal for seconds.
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
 * What the UI shows, as ready-to-print parts.
 *
 * Today's counters are reported as zero when the stored day is not today: the
 * record is only rewritten when something actually moves, so a night with the
 * browser closed would otherwise leave yesterday's numbers under a "Today"
 * label until the next request arrived.
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

/* ------------------------------------------------------------------ *
 * The live rate — what is moving right now
 * ------------------------------------------------------------------ */

/**
 * How much recent traffic the window keeps, and when it stops believing a
 * reading.
 *
 * A speed is bytes divided by time, and the only honest way to get it is to
 * divide the bytes that were counted by the time they were counted across —
 * which is why every batch the worker writes carries the span it covers
 * (`ms`, see `src/background.js`). Adding those spans up and dividing once
 * gives the average speed of the last few seconds: a transfer that is still
 * going reads its own rate rather than a fraction of it, and a transfer that
 * has slowed down reads the slower number as the fast batches age out of the
 * window.
 *
 * Nothing here is sampled on a timer. The worker stamps a batch when it writes
 * one and the reading is recomputed on every draw, so the number stays honest
 * between writes without a second source of truth.
 */
export const RATE_WINDOW_MS = 10_000;

/** No sample newer than this means nothing is moving: the UI says so, not 0 B/s. */
export const RATE_IDLE_MS = 5_000;

/** The shortest span a sample may claim, so a short batch cannot divide by ~zero. */
export const RATE_MIN_SPAN_MS = 200;

/**
 * The longest span a sample may claim. A batch that says it covered more than
 * the window is a batch from a worker that slept: its bytes are recent, but a
 * span we cannot trust must not be allowed to dilute a reading.
 */
export const RATE_MAX_SPAN_MS = RATE_WINDOW_MS;

/** The ceiling a reading can claim. Past this it is a corrupt value, not traffic. */
export const RATE_MAX_BPS = 1e12;

/** How many samples the window may hold. Far more than a five-second batch
 * needs, and a bound on a record that a bug could otherwise grow forever. */
export const RATE_MAX_SAMPLES = 32;

/**
 * @returns {object} an empty rate record: nothing has been seen lately.
 */
export function createRate() {
  return { samples: [] };
}

/**
 * One observation, made valid: the bytes a batch counted (`up`, `down`), the
 * moment it finished counting them (`at`) and how long it was counting (`ms`).
 *
 * A sample that cannot say how long it took, or that counted nothing at all, is
 * not a sample — it carries no speed, and adding it would only dilute the ones
 * that do. `null` says so, and both the writer and the reader drop it.
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
 * Coerces anything (old storage, a hand-edited value) into a valid record.
 *
 * Nothing is swept here against the wall clock — the stored record is *data*,
 * and the window is applied on the *read* (`trafficRate` drops the samples by
 * the age it is asked about). Sweeping inside sanitize would clamp every test
 * that reads with an explicit `now` to the real clock, and more importantly
 * would make the record mean different things depending on when it happened to
 * be touched.
 */
export function sanitizeRate(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const samples = Array.isArray(source.samples) ? source.samples : [];

  return { samples: samples.map(sampleOf).filter(Boolean).slice(-RATE_MAX_SAMPLES) };
}

/** Whether two records hold the same samples (a write that changes nothing is skipped). */
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
 * Records one batch: the bytes counted, and the span they were counted across.
 * Mutated in place, like every record here. The window is swept first, so a
 * record that sat idle while the worker slept does not drag old bytes into a
 * reading, and a batch that counted nothing leaves no sample at all.
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
 * Drops the samples the window no longer holds (in place, so callers share the
 * sweep). "Holds" is read from the end of a sample's span, because that is the
 * moment its bytes were last counted: a batch that finished just after the
 * horizon was, as far as a reading is concerned, counted just now.
 */
function sweep(record, now) {
  const horizon = Number(now) - RATE_WINDOW_MS;
  record.samples = (Array.isArray(record.samples) ? record.samples : []).filter(
    (sample) => Number(sample?.at) >= horizon,
  );
}

/**
 * The speed right now: bytes per second in each direction, or 0 for a
 * direction the window holds nothing about.
 *
 * The arithmetic is one division — the bytes of every sample still in the
 * window over the spans those bytes were counted across. That is what makes a
 * sustained transfer read its own rate (its bytes and its spans grow together,
 * so the ratio holds however many batches the window happens to hold) and a
 * transfer that has slowed down read the slower number, because the fast
 * batches drop out of the window on their own.
 *
 * @param {object|null} record a rate record
 * @param {number} [now]
 * @returns {{up: number, down: number, live: boolean, last: number}}
 *   bytes per second per direction, whether anything is moving at all, and the
 *   age in milliseconds of the newest sample (0 when there is none)
 */
export function trafficRate(record, now = Date.now()) {
  // The window is applied on the read, against the clock the reader asks
  // about: a record straight out of storage after the worker slept for an hour
  // holds nothing, and a test reading with an explicit `now` gets exactly that
  // moment's answer.
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
    // A window whose newest bytes are seconds old is not "moving slowly" —
    // nothing has been counted lately, which is what idle means to a reader.
    live: last <= RATE_IDLE_MS,
    last,
  };
}

/**
 * What the UI shows for the rate, as ready-to-print parts.
 *
 * `idle` is the answer to "is anything moving?" the way a user asks it: not
 * *were there bytes this second* but *has the meter seen anything lately*. A
 * meter that saw a burst nine seconds ago is not streaming at 40 MB/s into the
 * void; it is idle, and saying so beats a number that lies by precision.
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
    // An idle meter reads as zero: the window may still hold the tail of a
    // burst, and printing it would claim a speed nothing is sustaining.
    down: idle ? '0 B/s' : `${formatBytes(down)}/s`,
    up: idle ? '0 B/s' : `${formatBytes(up)}/s`,
  };
}
