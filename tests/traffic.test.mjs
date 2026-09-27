import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/model.js';
import {
  TRAFFIC_MAX_BYTES,
  createTraffic,
  dayKey,
  describeTraffic,
  formatBytes,
  meterRuns,
  noteTraffic,
  parseContentLength,
  requestBytes,
  resetTraffic,
  responseBytes,
  rollTrafficDay,
  sameTraffic,
  sanitizeTraffic,
} from '../src/lib/traffic.js';

/** A local date, so the tests do not depend on the machine's time zone. */
const at = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

test('a fresh record counts nothing and belongs to no day', () => {
  assert.deepEqual(createTraffic(), {
    day: null,
    up: 0,
    down: 0,
    upTotal: 0,
    downTotal: 0,
    since: 0,
    at: 0,
  });
});

test('sanitizing throws away anything that is not a byte count', () => {
  const clean = sanitizeTraffic({
    day: '2026-09-27',
    up: 1024,
    down: -5,
    upTotal: 'nope',
    downTotal: NaN,
    since: 'whenever',
    at: Infinity,
  });

  assert.deepEqual(clean, {
    day: '2026-09-27',
    up: 1024,
    down: 0,
    upTotal: 0,
    downTotal: 0,
    since: 0,
    at: 0,
  });

  // Junk of every shape becomes an empty record rather than throwing.
  for (const raw of [null, undefined, 42, 'x', [], true]) {
    assert.deepEqual(sanitizeTraffic(raw), createTraffic());
  }
});

test('a day key is a date and nothing else', () => {
  assert.equal(sanitizeTraffic({ day: '2026-9-7' }).day, null, 'unpadded');
  assert.equal(sanitizeTraffic({ day: 'yesterday' }).day, null);
  assert.equal(sanitizeTraffic({ day: 20260927 }).day, null);
  assert.equal(sanitizeTraffic({ day: '2026-09-27' }).day, '2026-09-27');
});

test('counters stop at the ceiling instead of silently overflowing', () => {
  const record = sanitizeTraffic({ upTotal: TRAFFIC_MAX_BYTES });
  noteTraffic(record, { up: 1024, at: at(2026, 9, 27) });
  assert.equal(record.upTotal, TRAFFIC_MAX_BYTES);
});

test('the local day a moment belongs to, and nothing for a moment that is not a date', () => {
  assert.equal(dayKey(at(2026, 9, 27, 23, 59)), '2026-09-27');
  assert.equal(dayKey(at(2026, 9, 27, 0, 1)), '2026-09-27');
  assert.equal(dayKey(at(2026, 10, 1, 0, 0)), '2026-10-01');
  assert.equal(dayKey(Number.NaN), null);
  assert.equal(dayKey('tomorrow'), null);
});

test('a new day clears today and leaves the totals alone', () => {
  const record = sanitizeTraffic({
    day: '2026-09-26',
    up: 500,
    down: 900,
    upTotal: 4000,
    downTotal: 9000,
  });

  assert.equal(rollTrafficDay(record, at(2026, 9, 27, 0, 5)), true, 'midnight must roll the day');
  assert.deepEqual(record, {
    day: '2026-09-27',
    up: 0,
    down: 0,
    upTotal: 4000,
    downTotal: 9000,
    since: 0,
    at: 0,
  });

  // Rolling twice in the same day is not a change, and a moment without a day
  // must not wipe the counters it cannot place.
  assert.equal(rollTrafficDay(record, at(2026, 9, 27, 18)), false);
  assert.equal(rollTrafficDay(record, Number.NaN), false);
  assert.equal(record.day, '2026-09-27');
});

test('an observation lands in the day it happened in', () => {
  const record = createTraffic();
  noteTraffic(record, { up: 300, down: 1200, at: at(2026, 9, 26, 23, 59) });

  assert.equal(record.day, '2026-09-26');
  assert.equal(record.up, 300);
  assert.equal(record.down, 1200);
  assert.equal(record.upTotal, 300);
  assert.equal(record.since, at(2026, 9, 26, 23, 59), 'the totals start when counting did');

  // The next day at 00:01: today starts over, the total keeps going.
  noteTraffic(record, { up: 0, down: 200, at: at(2026, 9, 27, 0, 1) });
  assert.equal(record.day, '2026-09-27');
  assert.equal(record.up, 0, 'yesterday stays out of today');
  assert.equal(record.down, 200);
  assert.equal(record.upTotal, 300);
  assert.equal(record.downTotal, 1400);
  assert.equal(record.since, at(2026, 9, 26, 23, 59), 'a reset date is not a batch');

  // And an observation without a moment is still counted, stamped with now.
  const before = Date.now();
  noteTraffic(record, { up: 10, down: 20 });
  assert.ok(record.at >= before);
  assert.equal(record.upTotal, 310);
});

test('a reset empties both windows and starts the totals again', () => {
  const record = sanitizeTraffic({ day: '2026-09-26', up: 5, down: 6, upTotal: 7, downTotal: 8 });
  resetTraffic(record, at(2026, 9, 27, 9, 30));

  assert.deepEqual(record, {
    day: '2026-09-27',
    up: 0,
    down: 0,
    upTotal: 0,
    downTotal: 0,
    since: at(2026, 9, 27, 9, 30),
    at: at(2026, 9, 27, 9, 30),
  });
});

test('two records are the same when every counter and stamp is', () => {
  const base = sanitizeTraffic({ day: '2026-09-27', up: 1, down: 2, upTotal: 3, downTotal: 4, at: 5 });
  assert.equal(sameTraffic(base, { ...base }), true);
  assert.equal(sameTraffic(base, { ...base, at: 6 }), false, 'the write stamp counts');
  assert.equal(sameTraffic(base, { ...base, down: 3 }), false);
});

test('only a plain decimal is a size', () => {
  assert.equal(parseContentLength([{ name: 'Content-Length', value: '1200' }]), 1200);
  assert.equal(parseContentLength([{ name: 'content-length', value: ' 42 ' }]), 42);
  assert.equal(
    parseContentLength([
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Content-Length', value: '7' },
    ]),
    7,
    'the size is found wherever it sits',
  );

  // Everything a server, a captive portal or a proxy can say instead of a size.
  assert.equal(parseContentLength([{ name: 'content-length', value: '*' }]), null);
  assert.equal(parseContentLength([{ name: 'content-length', value: '' }]), null);
  assert.equal(parseContentLength([{ name: 'content-length', value: '0' }]), null, 'no body, no bytes');
  assert.equal(parseContentLength([{ name: 'content-length', value: '-5' }]), null);
  assert.equal(parseContentLength([{ name: 'content-length', value: '12.5' }]), null);
  assert.equal(parseContentLength([{ name: 'content-length', value: '99999999999999999999' }]), null);
  assert.equal(
    parseContentLength([
      { name: 'content-length', value: '10' },
      { name: 'Content-Length', value: '20' },
    ]),
    null,
    'two conflicting sizes are not a size',
  );
  assert.equal(
    parseContentLength([
      { name: 'content-length', value: '10' },
      { name: 'Content-Length', value: '10' },
    ]),
    10,
    'the same size twice is still that size',
  );
  assert.equal(
    parseContentLength([
      { name: 'content-length', value: '10' },
      { name: 'Content-Length', value: 'ten' },
    ]),
    null,
    'one unreadable size spoils the list',
  );

  assert.equal(parseContentLength([]), null);
  assert.equal(parseContentLength(null), null);
  assert.equal(parseContentLength('content-length: 12'), null);
});

test('a response counts only when it really crossed the network', () => {
  const headers = [{ name: 'Content-Length', value: '2048' }];
  assert.equal(responseBytes({ responseHeaders: headers }), 2048);
  assert.equal(responseBytes({ responseHeaders: headers, fromCache: false }), 2048);
  assert.equal(responseBytes({ responseHeaders: headers, fromCache: true }), 0, 'the cache is not traffic');
  assert.equal(responseBytes({}), 0);
  assert.equal(responseBytes(null), 0);

  assert.equal(requestBytes({ requestHeaders: [{ name: 'content-length', value: '64' }] }), 64);
  assert.equal(requestBytes({ requestHeaders: [] }), 0);
  assert.equal(requestBytes({}), 0, 'a GET declares nothing');
});

test('the meter runs only where there is something to count', () => {
  const state = createDefaultState();
  assert.equal(state.settings.trafficMeter, true, 'the meter is on out of the box');
  assert.equal(meterRuns(state), true, 'system mode is routed by a policy we put in force');

  state.settings.mode = 'fixed_servers';
  assert.equal(meterRuns(state), true);
  state.settings.mode = 'pac_script';
  assert.equal(meterRuns(state), true);

  state.settings.mode = 'direct';
  assert.equal(meterRuns(state), false, 'direct is not routed, so there is nothing to count');

  state.settings.mode = 'fixed_servers';
  state.settings.enabled = false;
  assert.equal(meterRuns(state), false, 'a switched-off extension is direct');

  state.settings.enabled = true;
  state.settings.trafficMeter = false;
  assert.equal(meterRuns(state), false, 'the switch has the last word');

  assert.equal(meterRuns(null), false, 'and no state is no meter');
});

test('a size reads as a size', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes('1200'), '1.2 KB');
  assert.equal(formatBytes(37), '37 B');
  assert.equal(formatBytes(1023), '1023 B', 'the last byte before a unit');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2 * 2.5), '2.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
  assert.equal(formatBytes(1024 ** 5), '1024.0 TB', 'there is no unit above TB');
});

test('the reading shows today, and the totals whatever the day says', () => {
  const record = sanitizeTraffic({
    day: '2026-09-26',
    up: 500,
    down: 900,
    upTotal: 2 * 1024 ** 2,
    downTotal: 3 * 1024 ** 3,
  });

  const yesterday = describeTraffic(record, at(2026, 9, 26, 18));
  assert.equal(yesterday.current, true);
  assert.equal(yesterday.down, '900 B');
  assert.equal(yesterday.up, '500 B');
  assert.equal(yesterday.totalDown, '3.0 GB');
  assert.equal(yesterday.totalUp, '2.0 MB');

  // The record is only rewritten when something moves, so after a night with the
  // browser closed the stored day is not today — and "today" must say zero.
  const afterMidnight = describeTraffic(record, at(2026, 9, 27, 8));
  assert.equal(afterMidnight.current, false);
  assert.equal(afterMidnight.down, '0 B');
  assert.equal(afterMidnight.up, '0 B');
  assert.equal(afterMidnight.totalDown, '3.0 GB', 'the totals are not a day');
  assert.equal(afterMidnight.totalUp, '2.0 MB');

  const fresh = describeTraffic(createTraffic(), at(2026, 9, 27, 8));
  assert.equal(fresh.current, true, 'a record that never counted has no day to be wrong about');
  assert.equal(fresh.down, '0 B');
  assert.equal(describeTraffic(null).totalDown, '0 B');
});
