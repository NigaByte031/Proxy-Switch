/**
 * "Does traffic actually flow?" check.
 *
 * The probe is a plain `fetch` from an extension page, so it travels through
 * whatever proxy mode is currently applied: a working server answers in
 * milliseconds, a broken one fails or hangs. Everything in this file is pure —
 * `fetch` is injected — so Node can test the decision logic without a browser.
 */

/**
 * Small, cache-free endpoints that answer with an empty `204`. Google's is the
 * one Chrome itself uses for captive-portal detection; Cloudflare's is the same
 * idea on a different network, so one of them usually gets through.
 */
export const PROBE_TARGETS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
];

/** Per-target budget. Two targets means a fully dead link reports in ~12s. */
export const PROBE_TIMEOUT_MS = 6000;

/**
 * Only a `204` proves the route: the probe endpoints answer `204` and nothing
 * else. Any other status means the response was fabricated on the way — a
 * captive portal's `302` to its login page (followed by `redirect: 'follow'`
 * into a `200`), a firewall's `200` block page — so it fails the probe.
 */
const REACHABLE_STATUSES = new Set([204]);

/**
 * Preview/test seam: the offline preview pages run from `file://`, where a
 * cross-origin fetch is impossible, so the stub installs a simulated fetch here.
 */
function probeFetch() {
  return globalThis.__proxySwitchProbeFetch ?? globalThis.fetch;
}

/** `https://host/generate_204` -> `host`; never throws. */
export function probeHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url ?? '').trim();
  }
}

export function isReachableStatus(status) {
  return REACHABLE_STATUSES.has(Number(status));
}

/** `124 ms`, `1.4 s`, or an em dash when there is nothing to show. */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/**
 * One timed request. Never throws — an unreachable target is a result, not an
 * error, because "it did not answer" is exactly what we are trying to find out.
 *
 * @returns {Promise<{url: string, ok: boolean, ms: number, status: number|null, error: string|null}>}
 */
export async function probeOnce(url, { fetchImpl = probeFetch(), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { url, ok: false, ms: 0, status: null, error: 'fetch-unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const status = Number(response?.status ?? 0);
    return isReachableStatus(status)
      ? { url, ok: true, ms, status, error: null }
      : { url, ok: false, ms, status, error: `http-${status}` };
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    return {
      url,
      ok: false,
      ms: Date.now() - started,
      status: null,
      error: aborted ? 'timeout' : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries every target until one answers. Always resolves.
 *
 * @returns {Promise<{ok: boolean, url: string|null, ms: number, status: number|null, error: string|null, attempts: object[]}>}
 */
export async function probe({ targets = PROBE_TARGETS, ...options } = {}) {
  const attempts = [];

  for (const url of targets) {
    const attempt = await probeOnce(url, options);
    attempts.push(attempt);
    if (attempt.ok) return { ...attempt, attempts };
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    url: last?.url ?? null,
    ms: 0,
    status: null,
    error: last?.error ?? 'unreachable',
    attempts,
  };
}

/**
 * Status content for a probe result. Returns i18n keys + params (like
 * `describeStatus`) so the caller decides the language.
 *
 * @returns {{tone: 'ok'|'warn', title: {key: string, params?: object}, detail: {key: string, params?: object}}}
 */
export function describeProbe(outcome) {
  if (!outcome?.ok) {
    return {
      tone: 'warn',
      title: { key: 'health.fail.title' },
      detail: { key: 'health.fail.detail' },
    };
  }

  return {
    tone: 'ok',
    title: { key: 'health.ok.title' },
    detail: {
      key: 'health.ok.detail',
      params: { host: probeHost(outcome.url), ms: formatDuration(outcome.ms) },
    },
  };
}
