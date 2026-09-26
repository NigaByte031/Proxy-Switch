/**
 * Background checks: which of the saved servers is worth looking at while
 * nobody is watching.
 *
 * The generated PAC chain is ordered by what the extension has *seen*
 * (`lib/server-health.js`), and that knowledge is only as good as it is recent.
 * The manual **Test connection** button and the probe that confirms a failover
 * both produce verdicts, but neither of them happens on its own — so a server
 * that recovered, or one that quietly died, could keep its stale place in the
 * chain for as long as the user never presses anything.
 *
 * This module decides *whether* and *which* server to look at, and nothing else:
 * `src/background.js` owns the timer and the proxy configuration, and
 * `buildProbeConfig` (in `lib/proxy.js`) owns what is installed during the look.
 * Everything here is pure, so the policy can be tested without a browser.
 *
 * The same question is asked on demand: the popup's **Test all servers** button
 * runs one pass over the whole list instead of waiting for the timer, and asks
 * `testAllEligible` whether that is possible at all. Who does the looking does
 * not change — the pass is the worker's, for the reason below.
 *
 * The timing is chosen so a verdict cannot expire between two looks
 * (`PROBE_REFRESH_MS` plus one interval is shorter than the lifetime in
 * `lib/server-health.js`).
 */

import { effectiveMode, missingRequirement } from './model.js';
import { freshVerdict } from './server-health.js';

/** The alarm that wakes the worker up for a check. */
export const PROBE_ALARM = 'proxy-switch:server-check';

/**
 * The message a page sends to ask for a pass over *every* saved server, one
 * after another — the popup's *Test all servers* button. `action: 'status'`
 * asks where a running pass is instead of starting a second one.
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
 * How many servers one pass may check. A check at most one server at a time is
 * the rule everywhere here, and a pass that stops after a couple of them keeps a
 * list of dead servers from turning into a long run of probes.
 */
export const PROBE_MAX_PER_PASS = 2;

/**
 * Per-target budget for a background check. Shorter than the manual test's
 * (`PROBE_TIMEOUT_MS`): a check nobody asked for has no business holding the
 * worker — and therefore the queue of configuration applies — for twelve
 * seconds. A server that needs longer than this is, for the purpose of ordering
 * a fallback chain, slow enough to be treated as not answering.
 */
export const PROBE_CHECK_TIMEOUT_MS = 3000;

/**
 * The half of "may this server be looked at" that is not about the setting: the
 * applied mode has to be one a check can reproduce exactly while it measures
 * (`buildProbeConfig` builds the very same policy with one directive changed),
 * and it has to be in force.
 *
 * Manual mode — everything through the active server — and domain routing — the
 * listed sites through the chain, everything else direct — qualify. `system`
 * mode does not: a PAC script would quietly replace the operating system's
 * proxy. Neither does `direct`, nor a switched-off extension, where there is no
 * routing for a verdict to be right about. A downloaded PAC script does not
 * either: somebody else's policy is not ours to rebuild. A mode that is missing
 * what it needs (no active server, no rules) has nothing in force either.
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
 * Whether the extension should be looking at its servers in the background at
 * all right now: the conditions above, plus the one switch that says the user
 * wants network work done on its own — it is off by default for exactly that
 * reason (see `createDefaultState`).
 *
 * @param {object} state
 * @returns {boolean}
 */
export function probeEligible(state) {
  if (state?.settings?.backgroundProbe !== true) return false;
  return checkableRouting(state);
}

/**
 * Whether a server can be checked one by one *right now, on request* — the
 * question the popup's **Test all servers** button asks before it says anything.
 *
 * Everything `probeEligible` asks for except the setting: a check the user just
 * pressed needs no permission to run on a timer the user never agreed to. What
 * is left is the safety half, which cannot be dropped for any caller — the pass
 * installs a configuration per server, so it may only do so in a mode whose
 * routing it is allowed to reproduce.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function testAllEligible(state) {
  return checkableRouting(state);
}

/**
 * The servers a pass should look at, most useful first — never looked at comes
 * before merely stale, then the oldest verdict, and list order breaks the ties.
 * A server whose verdict is still fresh is skipped, and an empty result means
 * this pass has nothing to do (the worker then applies nothing at all).
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
    // Never looked at sorts before everything (-1), so a first pass fills in the
    // unknown servers rather than re-taking a verdict it already has.
    due.push({ server, at: verdict?.at ?? -1 });
  }

  return due.sort((a, b) => a.at - b.at).slice(0, limit).map((entry) => entry.server);
}

/**
 * What a check looked at, as a verdict for `lib/server-health.js`.
 *
 * A background check is not a guess about a route: it hands its own probe to the
 * server it named, so the answer belongs to that server and to no other — which
 * is why this does not go through `probeObservation`, the rule that has to
 * refuse to attribute the *other* probes (see `lib/server-health.js`).
 *
 * @param {object} target the server that was checked
 * @param {{ok?: boolean, ms?: number}|null} outcome the probe's result
 * @param {number} [now]
 * @returns {{id: string, ok: boolean, at: number, ms: number|null}|null}
 */
export function probeVerdict(target, outcome, now = Date.now()) {
  if (!target?.id) return null;
  // No outcome is no verdict: recording "failed" for a check that never ran
  // would demote a server nobody has looked at.
  if (!outcome || typeof outcome.ok !== 'boolean') return null;

  const ms = outcome.ok && Number.isFinite(outcome.ms) ? Math.round(outcome.ms) : null;
  return { id: target.id, ok: outcome.ok, at: Number.isFinite(now) ? now : Date.now(), ms };
}
