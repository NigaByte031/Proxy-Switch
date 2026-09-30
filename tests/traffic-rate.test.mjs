import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_IDLE_MS,
  RATE_MAX_BPS,
  RATE_MAX_SAMPLES,
  RATE_MAX_SPAN_MS,
  RATE_MIN_SPAN_MS,
  RATE_WINDOW_MS,
  batchSpan,
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
  // 2 MB counted across five seconds is 400 KB/s, whatever the window is.
  noteRate(record, { down: 2 * 1024 * 1024, at: now, ms: 5000 });

  const rate = trafficRate(record, now);
  assert.equal(Math.round(rate.down), Math.round((2 * 1024 * 1024) / 5));
  assert.equal(rate.up, 0);
  assert.equal(rate.live, true);
  assert.equal(rate.last, 0);
});

test('a batch is stamped with its own bytes, not with the timer that wrote it', () => {
  // A burst that lasted half a second, written by a flush that fired two seconds
  // after its first byte: the span is the burst's, not the wait's.
  assert.deepEqual(batchSpan(now - 2500, now - 2000), { at: now - 2000, ms: 500 });

  const record = createRate();
  const { at, ms } = batchSpan(now - 2500, now - 2000);
  noteRate(record, { down: 2 * 1024 * 1024, at, ms });
  // Two megabytes in half a second is four, not the fraction a longer span reads.
  assert.equal(Math.round(trafficRate(record, now).down), 4 * 1024 * 1024);
  // …and it is stamped when it really happened, so the reading ages from there.
  assert.equal(describeRate(record, now).idle, false, 'two seconds on it is still live');
  assert.equal(describeRate(record, now + RATE_IDLE_MS).idle, true, 'and quiet a few seconds later');
});

test('a batch without two moments to measure between claims no span', () => {
  // One moment: the bytes arrived, but nothing says how fast.
  assert.deepEqual(batchSpan(now, now), { at: now, ms: 0 });
  // A clock that stepped backwards is not a span either, and neither is none at all.
  assert.deepEqual(batchSpan(now, now - 1000), { at: now - 1000, ms: 0 });
  assert.deepEqual(batchSpan(now - 1000, now), { at: now, ms: 1000 });
  assert.deepEqual(batchSpan(0, 0), { at: 0, ms: 0 });
  assert.deepEqual(batchSpan(Number.NaN, now), { at: now, ms: 0 });
  assert.deepEqual(batchSpan(now, 'later'), { at: now, ms: 0 });
  assert.deepEqual(batchSpan('then', 'later'), { at: 0, ms: 0 });

  // A batch of one moment is still no sample, so it cannot divide by nothing.
  const record = createRate();
  noteRate(record, { down: 4096, ...batchSpan(now, now) });
  assert.deepEqual(record.samples, []);
});

test('a sustained transfer reads its own rate at every moment', () => {
  // One batch per second for the whole window: the reading must not drift with how
  // many batches the window holds (the bug dividing by the window span would bring).
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
  // Both halves are in the window: the reading is what was counted across both spans.
  const mixed = trafficRate(record, now);
  assert.ok(mixed.down > 1024 * 1024, `the fast batch still counts, got ${mixed.down}`);
  assert.ok(mixed.down < 10 * 1024 * 1024);
  // Five seconds on, the fast batch has left the window: the reading is what remains.
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
  // Past the idle threshold the window is not empty, but a burst's tail is not a speed.
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
  // The first four claim no speed: no moment, no span, nothing counted, a
  // negative count. Then the one that can, and two entries that are no record.
  const clean = sanitizeRate({
    samples: [
      { at: 0, ms: 1000, down: 10 },
      { at: 1, ms: 0, down: 10 },
      { at: 2, ms: 1000, up: 0, down: 0 },
      { at: 3, ms: 1000, down: -5 },
      { at: 4, ms: 1000, down: 1024 },
      'junk',
      null,
    ],
  });
  // Ageing out is the read's job (`trafficRate`), not the record's: a well formed
  // sample survives here.
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
  // 300 MB in one second — the burst the user meant by "300 megabytes a second".
  // Both directions are one batch: one observation of one span.
  noteRate(record, { down: 300 * 1024 * 1024, up: 512 * 1024, at: now, ms: 1000 });

  const shown = describeRate(record, now);
  assert.equal(shown.idle, false);
  // The arrows live in the string templates, not in describeRate.
  assert.equal(shown.down, '300.0 MB/s');
  assert.equal(shown.up, '512.0 KB/s');
});
