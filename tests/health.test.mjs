import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROBE_TARGETS,
  PROBE_TIMEOUT_MS,
  describeProbe,
  formatDuration,
  isReachableStatus,
  probe,
  probeHost,
  probeOnce,
} from '../src/lib/health.js';
import { MESSAGES, SUPPORTED_LANGS, t } from '../src/lib/i18n.js';

test('the probe targets are unique, https endpoints', () => {
  assert.ok(PROBE_TARGETS.length >= 2, 'a single blocked host should not fail the test');
  assert.equal(new Set(PROBE_TARGETS).size, PROBE_TARGETS.length, 'targets must be unique');
  for (const target of PROBE_TARGETS) {
    assert.match(target, /^https:\/\/[^/]+\//, target);
  }
  assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 10_000, 'a popup must not hang for long');
});

test('probeHost extracts the host and survives junk', () => {
  assert.equal(probeHost('https://www.gstatic.com/generate_204'), 'www.gstatic.com');
  assert.equal(probeHost('https://example.com:8443/x'), 'example.com:8443');
  assert.equal(probeHost('not a url'), 'not a url');
  assert.equal(probeHost(undefined), '');
});

test('only a 204 from the probe endpoint counts as success', () => {
  assert.equal(isReachableStatus(204), true);
  for (const status of [200, 301, 302, 303, 307, 308, 0, 400, 401, 404, 407, 500, 502, 503, undefined]) {
    assert.equal(isReachableStatus(status), false, String(status));
  }
});

test('a 200 block page fails instead of faking a connection', async () => {
  const result = await probeOnce('https://a.test/generate_204', {
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(result.error, 'http-200');
});

test('a captive portal that answers 200 after a redirect fails the probe', async () => {
  // fetch follows the portal's 302 (redirect: 'follow'), so what arrives is its login page
  const outcome = await probe({ fetchImpl: async () => ({ status: 200 }) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'http-200');
  assert.equal(outcome.attempts.length, PROBE_TARGETS.length, 'every target must be tried');
  assert.ok(outcome.attempts.every((attempt) => attempt.ok === false));
});

test('formatDuration reads like a human wrote it', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(124.4), '124 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1.0 s');
  assert.equal(formatDuration(1436), '1.4 s');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(formatDuration(-1), '—');
});

test('probeOnce never throws and times an answer', async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { status: 204 };
  };

  const result = await probeOnce('https://a.test/x', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(result.error, null);
  assert.ok(result.ms >= 0);
  assert.equal(seen.url, 'https://a.test/x');
  assert.equal(seen.options.cache, 'no-store');
  assert.ok(seen.options.signal, 'the request must be abortable');
});

test('an error response is a failure, not a crash', async () => {
  const result = await probeOnce('https://a.test/x', { fetchImpl: async () => ({ status: 503 }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'http-503');
});

test('a throwing fetch becomes a readable failure', async () => {
  const result = await probeOnce('https://a.test/x', {
    fetchImpl: async () => {
      throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'net::ERR_PROXY_CONNECTION_FAILED');
});

test('a hanging request is aborted after the timeout', async () => {
  const hanging = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  const result = await probeOnce('https://a.test/x', { fetchImpl: hanging, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
});

test('probe stops at the first target that answers', async () => {
  const called = [];
  const fetchImpl = async (url) => {
    called.push(url);
    if (url === PROBE_TARGETS[0]) throw new Error('blocked');
    return { status: 204 };
  };

  const outcome = await probe({ fetchImpl });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.url, PROBE_TARGETS[1]);
  assert.deepEqual(called, PROBE_TARGETS.slice(0, 2));
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.attempts[0].ok, false);
});

test('a fully unreachable network reports the last reason', async () => {
  const outcome = await probe({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'offline');
  assert.equal(outcome.attempts.length, PROBE_TARGETS.length);
  assert.equal(outcome.url, PROBE_TARGETS[PROBE_TARGETS.length - 1]);
});

test('describeProbe feeds the status card in both directions', () => {
  const failure = describeProbe(null);
  assert.equal(failure.tone, 'warn');
  assert.equal(failure.title.key, 'health.fail.title');
  assert.equal(failure.detail.key, 'health.fail.detail');

  const success = describeProbe({ ok: true, url: 'https://www.gstatic.com/generate_204', ms: 124 });
  assert.equal(success.tone, 'ok');
  assert.equal(success.title.key, 'health.ok.title');
  assert.deepEqual(success.detail.params, { host: 'www.gstatic.com', ms: '124 ms' });
});

test('every health string exists in both languages', () => {
  const keys = new Set([
    'health.action',
    'health.running',
    'options.shortcuts',
    describeProbe(null).title.key,
    describeProbe(null).detail.key,
  ]);
  const success = describeProbe({ ok: true, url: 'https://x.test/generate_204', ms: 5 });
  keys.add(success.title.key);
  keys.add(success.detail.key);

  for (const key of keys) {
    for (const lang of SUPPORTED_LANGS) {
      assert.equal(typeof MESSAGES[lang][key], 'string', `${key} is missing in ${lang}`);
      assert.notEqual(
        t(key, lang, { host: 'host.test', ms: '124 ms' }),
        key,
        `${key} is untranslated in ${lang}`,
      );
    }
  }
});
