/**
 * Background checks: which saved server is worth looking at while nobody is
 * watching. The PAC chain is ordered by what the extension has *seen*
 * (`lib/server-health.js`), and a server that recovered — or quietly died — keeps
 * its stale place for as long as the user never presses anything.
 *
 * This module decides *whether* and *which* server to look at; the timer and the
 * configuration belong to `src/background.js`, and everything here is pure.
 */

import { effectiveMode, missingRequirement } from './model.js';
import { freshVerdict } from './server-health.js';

/** The alarm that wakes the worker up for a check. */
export const PROBE_ALARM = 'proxy-switch:server-check';

/**
 * The message a page sends to ask for a pass over *every* saved server, one after
 * another — the popup's *Test all servers* button. `action: 'status'` asks where a
 * running pass is instead of starting a second one.
 */
export const TEST_ALL_MESSAGE = 'proxy-switch:test-all';

/**
 * The message the worker sends back while such a pass runs: one per server with
 * `done`/`total`, and a last one carrying `finished` plus the counts the summary
 * under the list is built from (`ok`, `failed`, `skipped`).
 */
export const TEST_ALL_PROGRESS_MESSAGE = 'proxy-switch:test-all-progress';

/** How often the worker may look. */
export const PROBE_INTERVAL_MINUTES = 5;

/** A verdict worth taking again once it has aged this much. */
export const PROBE_REFRESH_MS = 10 * 60_000;

/**
 * How many servers one pass may check — a check at most one server at a time is
 * the rule everywhere here. A pass stops after a couple of them, so a list of
 * dead servers does not turn into a long run of probes.
 */
export const PROBE_MAX_PER_PASS = 2;

/**
 * Per-target budget for a background check — shorter than the manual test's
 * (`PROBE_TIMEOUT_MS`): a check nobody asked for has no business holding the
 * worker (and the queue of configuration applies) for twelve seconds. A server
 * slower than this counts as not answering.
 */
export const PROBE_CHECK_TIMEOUT_MS = 3000;

/**
 * The half of "may this server be looked at" that is not about the setting: the
 * applied mode must be one a check can reproduce exactly while it measures, and it
 * must be in force.
 *
 * Manual mode and domain routing qualify. `system` does not — a PAC script would
 * quietly replace the operating system's proxy — nor do `direct`, a switched-off
 * extension (no routing to be right about), or a downloaded PAC script.
 *
 * @param {object} state
 * @returns {boolean}
 */
function checkableRouting(state) {
  const mode = effectiveMode(state);
  const routing =
    mode === 'fixed_servers' || (mode === 'pac_script' && state.settings.domainRouting === true);
  if (!routing) return false;

  return missingRequirement(state) === null;
}

/**
 * Whether the extension should be looking at its servers in the background at all
 * right now: the conditions above, plus the one switch that says the user wants
 * network work done on its own — off by default for exactly that reason.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function probeEligible(state) {
  if (state?.settings?.backgroundProbe !== true) return false;
  return checkableRouting(state);
}

/**
 * Whether a server can be checked *right now, on request* — the question the
 * popup's **Test all servers** button asks before it says anything.
 *
 * Everything `probeEligible` asks for except the setting: a check the user just
 * pressed needs no permission to run on a timer. The safety half stays, because
 * the pass installs a configuration per server.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function testAllEligible(state) {
  return checkableRouting(state);
}

/**
 * The servers a pass should look at, most useful first — never looked at before
 * merely stale, then the oldest verdict, with list order breaking the ties. A
 * server whose verdict is still fresh is skipped; an empty result means this pass
 * has nothing to do.
 *
 * @param {object[]} servers the saved servers, in list order
 * @param {object|null} health the recorded verdicts
 * @param {number} [now]
 * @param {number} [max] how many to return at most
 * @returns {object[]}
 */
export function probeCandidates(servers, health, now = Date.now(), max = PROBE_MAX_PER_PASS) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (limit === 0) return [];

  const due = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server?.id || !server?.host) continue;
    const verdict = freshVerdict(health, server.id, now);
    if (verdict && now - verdict.at < PROBE_REFRESH_MS) continue;
  // Never looked at sorts first (-1): a pass fills in the unknown ones first.
    due.push({ server, at: verdict?.at ?? -1 });
  }

  return due.sort((a, b) => a.at - b.at).slice(0, limit).map((entry) => entry.server);
}

/**
 * What a check looked at, as a verdict for `lib/server-health.js`.
 *
 * A background check is not a guess about a route: it hands its own probe to the
 * server it named, so the answer belongs to that server and no other — which is why
 * this does not go through `probeObservation`, the rule that refuses to attribute
 * the *other* probes.
 *
 * @param {object} target the server that was checked
 * @param {{ok?: boolean, ms?: number}|null} outcome the probe's result
 * @param {number} [now]
 * @returns {{id: string, ok: boolean, at: number, ms: number|null}|null}
 */
export function probeVerdict(target, outcome, now = Date.now()) {
  if (!target?.id) return null;
  // A check that never ran is no verdict: "failed" would demote the server.
  if (!outcome || typeof outcome.ok !== 'boolean') return null;

  const ms = outcome.ok && Number.isFinite(outcome.ms) ? Math.round(outcome.ms) : null;
  return { id: target.id, ok: outcome.ok, at: Number.isFinite(now) ? now : Date.now(), ms };
}
