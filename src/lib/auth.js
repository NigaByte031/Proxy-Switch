/**
 * Answering proxy authentication challenges.
 *
 * Pure logic, so the rule is testable in Node. It is deliberately narrow: the
 * extension only ever volunteers credentials for the servers it is using now.
 */

import { effectiveMode, findProfile, routingChain } from './model.js';

/** Strips the brackets Chrome puts around IPv6 literals, and lower-cases. */
export function normalizeChallengeHost(host) {
  return String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Decides what to answer a proxy challenge with.
 *
 * @param {object} state the stored state
 * @param {{isProxy?: boolean, challenger?: {host?: string}}} details a webRequest
 *        `onAuthRequired` details object
 * @param {string|null} [probingProfileId] the server a background check is looking
 *        at right now (see `lib/server-probe.js`), if any. Its probe travels through
 *        a server the user may not be using, and a private proxy that answers `407`
 *        to it would look dead — so that one server's credentials may answer too,
 *        for as long as the check runs.
 * @returns {{username: string, password: string}|null} credentials to send, or
 *          `null` to stay out of the way and let Chrome ask the user.
 */
export function resolveAuthCredentials(state, details = {}, probingProfileId = null) {
  // Only proxy challenges are ours; a site's own login form never is.
  if (!details?.isProxy) return null;

  if (!state?.settings?.autoAuth) return null;

  // A saved server is in charge in manual mode, and in PAC mode while the script
  // is the generated one (it names the servers to route through). A switched-off
  // extension, the system proxy or somebody else's PAC script must never get our
  // credentials.
  const mode = effectiveMode(state);
  const generatedPac = mode === 'pac_script' && state.settings.domainRouting === true;
  if (mode !== 'fixed_servers' && !generatedPac) return null;

  const active = findProfile(state, state.settings.activeProfileId);

  // Exactly one server in manual mode; the whole chain the generated script names
  // when it routes, in the order the script tries them.
  const candidates = generatedPac ? routingChain(state) : active ? [active] : [];

  // The server under a background check may answer for itself even when it is not
  // the one in charge — that is why its probe passes through it at all.
  const probing = probingProfileId ? findProfile(state, probingProfileId) : null;
  if (probing?.username && !candidates.some((candidate) => candidate.id === probing.id)) {
    candidates.push(probing);
  }

  // Some Chrome versions leave `challenger` empty: the first candidate with a
  // username answers then (the active server, first by design).
  const challenger = normalizeChallengeHost(details.challenger?.host);
  for (const candidate of candidates) {
    if (!candidate.username) continue;
    if (challenger && challenger !== normalizeChallengeHost(candidate.host)) continue;
    return { username: candidate.username, password: candidate.password || '' };
  }

  return null;
}
