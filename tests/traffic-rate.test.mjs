import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_IDLE_MS,
  RATE_MAX_BPS,
  RATE_MAX_SAMPLES,
  RATE_MAX_SPAN_MS,
  RATE_MIN_SPAN_MS,
  RATE_WINDOW_MS,
  createRate,
  describeRate,
  formatBytes,
  noteRate,
  resetRate,
  sameRate,
  sanitizeRate,
  trafficRate,
} from '../src/lib/traffic.js';

const now = 1_800_000_000_000;
/** A moment `seconds` before `now`. */
const ago = (seconds) => now - seconds * 1000;

test('an empty window says nothing is moving', () => {
  const rate = trafficRate(createRate(), now);
  assert.equal(rate.up, 0);
  assert.equal(rate.down, 0);
  assert.equal(rate.live, false);
  assert.equal(rate.last, 0);

  const shown = describeRate(createRate(), now);
  assert.equal(shown.idle, true);
  assert.equal(shown.down, '0 B/s');
  assert.equal(shown.up, '0 B/s');
});

test('a batch reads its own speed: its bytes over the span they were counted across', () => {
  const record = createRate();
  // 2 MB counted across five seconds of traffic: 400 KB/s, whatever the window
  // happens to be. The span comes from the worker (see `noteRate`).
  noteRate(record, { down: 2 * 1024 * 1024, at: now, ms: 5000 });

  const rate = trafficRate(record, now);
  assert.equal(Math.round(rate.down), Math.round((2 * 1024 * 1024) / 5));
  assert.equal(rate.up, 0);
  assert.equal(rate.live, true);
  assert.equal(rate.last, 0);
});

test('a sustained transfer reads its own rate at every moment', () => {
  // One batch per second for the whole window, all at the same speed. The
  // reading must not drift with how many batches the window happens to hold:
  // this is the bug that dividing by the window span would introduce.
  const record = createRate();
  for (let i = 10; i >= 0; i -= 1) {
    noteRate(record, { down: 100_000, at: ago(i), ms: 1000 });
  }

  for (const at of [now, now + 1000, now + 5000]) {
    const rate = trafficRate(record, at);
    assert.equal(Math.round(rate.down), 100_000, `${(at - now) / 1000}s later the same stream reads the same speed`);
    assert.equal(rate.live, true);
  }
});

test('a stream that slows down reads the slower number once the fast batches age out', () => {
  const record = createRate();
  noteRate(record, { down: 10 * 1024 * 1024, at: ago(6), ms: 1000 });
  noteRate(record, { down: 1024 * 1024, at: now, ms: 1000 });

  // Both halves are in the window: the reading is neither of them, it is what
  // was counted across both spans.
  const mixed = trafficRate(record, now);
  assert.ok(mixed.down > 1024 * 1024, `the fast batch still counts, got ${mixed.down}`);
  assert.ok(mixed.down < 10 * 1024 * 1024);

  // Five seconds on, the fast batch has fallen out of the window and only the
  // slow one is left: the reading is the speed that is still happening.
  const settled = trafficRate(record, now + 5000);
  assert.equal(Math.round(settled.down), 1024 * 1024);
});

test('a transfer that has stopped reads as idle rather than as its last speed', () => {
  const record = createRate();
  noteRate(record, { down: 600_000, up: 60_000, at: now, ms: 1000 });

  const fresh = describeRate(record, now);
  assert.equal(fresh.idle, false);
  assert.equal(fresh.down, `${formatBytes(600_000)}/s`);
  assert.equal(fresh.up, `${formatBytes(60_000)}/s`);

  // Past the idle threshold the window is not empty, but the meter has stopped
  // calling the tail of a burst a speed.
  const stale = describeRate(record, now + RATE_IDLE_MS + 1200);
  assert.equal(stale.idle, true);
  assert.equal(stale.down, '0 B/s');
  assert.equal(stale.up, '0 B/s');
});

test('samples outside the window are not read', () => {
  const stored = sanitizeRate({
    samples: [
      { at: ago(RATE_WINDOW_MS / 1000 + 5), ms: 1000, down: 5_000_000 },
      { at: now, ms: 1000, down: 1000 },
    ],
  });

  const rate = trafficRate(stored, now);
  assert.equal(Math.round(rate.down), 1000, 'only the sample inside the window counts');
  assert.equal(rate.live, true);
});

test('a window that sat idle while the worker slept wakes up empty', () => {
  const stored = sanitizeRate({ samples: [{ at: now - 3_600_000, ms: 5000, up: 999_999 }] });
  const rate = trafficRate(stored, now);
  assert.equal(rate.up, 0);
  assert.equal(rate.live, false);
});

test('a batch that counted nothing, or cannot say how long it took, is no sample', () => {
  const record = createRate();

  noteRate(record, { up: 0, down: 0, at: now, ms: 2000 });
  assert.deepEqual(record.samples, [], 'nothing counted is nothing to measure');

  noteRate(record, { down: 4096, at: now, ms: 0 });
  assert.deepEqual(record.samples, [], 'bytes over no time is not a speed');

  noteRate(record, { down: 4096, at: now, ms: 2000 });
  assert.equal(record.samples.length, 1, 'a batch that can say both is a sample');
});

test('writing sweeps what the window no longer holds', () => {
  const record = createRate();
  noteRate(record, { down: 1000, at: ago(RATE_WINDOW_MS / 1000 + 2), ms: 1000 });
  assert.equal(record.samples.length, 1, 'the record is data, and keeps what it is given');
  assert.equal(trafficRate(record, now).down, 0, 'the window is applied when it is read');

  noteRate(record, { down: 2000, at: now, ms: 2000 });
  assert.equal(record.samples.length, 1, 'a write with a newer stamp drops the sample that aged out');
  assert.equal(Math.round(trafficRate(record, now).down), 1000);
});

test('the window holds a bounded number of samples', () => {
  const record = createRate();
  for (let i = 40; i >= 0; i -= 1) {
    noteRate(record, { down: 1024, at: now - i, ms: 1000 });
  }

  assert.equal(record.samples.length, RATE_MAX_SAMPLES);
  assert.equal(record.samples.at(-1).at, now, 'the newest sample is the one that survives');
});

test('a reading is capped at what a byte count can claim', () => {
  const record = createRate();
  // A petabyte over the shortest span a sample may claim is not a speed.
  noteRate(record, { down: 1e15, at: now, ms: RATE_MIN_SPAN_MS });
  assert.equal(trafficRate(record, now).down, RATE_MAX_BPS);
});

test('sanitizing keeps only the samples that can be read as a speed', () => {
  const clean = sanitizeRate({
    samples: [
      { at: 0, ms: 1000, down: 10 }, // no moment
      { at: 1, ms: 0, down: 10 }, // no span
      { at: 2, ms: 1000, up: 0, down: 0 }, // nothing counted
      { at: 3, ms: 1000, down: -5 }, // nothing counted
      { at: 4, ms: 1000, down: 1024 }, // kept
      'junk',
      null,
    ],
  });

  // Ageing out is the read's job (see `trafficRate`), not the record's: a well
  // formed sample survives here, so a record means the same thing whenever it
  // is touched.
  assert.deepEqual(clean.samples, [{ at: 4, ms: 1000, up: 0, down: 1024 }]);

  for (const raw of [null, undefined, 42, 'x', [], true, { samples: 'nope' }]) {
    assert.deepEqual(sanitizeRate(raw), createRate());
  }
});

test('a claimed span is clamped to what a sample may honestly cover', () => {
  const quick = sanitizeRate({ samples: [{ at: now, ms: 1, down: 1024 }] });
  assert.equal(quick.samples[0].ms, RATE_MIN_SPAN_MS, 'a burst cannot divide by ~zero');

  const slept = sanitizeRate({ samples: [{ at: now, ms: RATE_WINDOW_MS * 60, down: 1024 }] });
  assert.equal(slept.samples[0].ms, RATE_MAX_SPAN_MS, 'a nap must not dilute a reading');
});

test('sameRate compares sample by sample', () => {
  const base = sanitizeRate({ samples: [{ at: 1, ms: 1000, up: 2, down: 4 }] });

  assert.equal(sameRate(base, { samples: [{ at: 1, ms: 1000, up: 2, down: 4 }] }), true);
  assert.equal(sameRate(base, { samples: [{ at: 1, ms: 1000, up: 2, down: 5 }] }), false);
  assert.equal(sameRate(base, { samples: [{ at: 1, ms: 2000, up: 2, down: 4 }] }), false);
  assert.equal(sameRate(base, createRate()), false);
});

test('a reset empties the window', () => {
  const record = createRate();
  noteRate(record, { down: 1000, up: 100, at: now, ms: 1000 });
  resetRate(record);

  assert.deepEqual(record, createRate());
  assert.equal(describeRate(record, now).idle, true);
});

test('a speed reads as a speed', () => {
  const record = createRate();
  // 300 MB counted across one second — the kind of burst the user meant by
  // "300 megabytes a second". Both directions belong to the same second, so
  // they are the same sample: a batch is one observation of one span.
  noteRate(record, { down: 300 * 1024 * 1024, up: 512 * 1024, at: now, ms: 1000 });

  const shown = describeRate(record, now);
  assert.equal(shown.idle, false);
  // The arrows live in the string templates, not in describeRate — it returns
  // the bare readings, and the UI composes them.
  assert.equal(shown.down, '300.0 MB/s');
  assert.equal(shown.up, '512.0 KB/s');
});
