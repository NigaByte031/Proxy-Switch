/**
 * MV3 service worker — the only place that talks to chrome.proxy.
 *
 * It watches the stored state and re-applies everything whenever the state
 * changes, which means the popup and the settings page stay dumb writers and
 * there is exactly one implementation of "apply the proxy".
 *
 * It is also the only place that knows whether applying actually worked: the
 * result of every attempt is stored (see `lib/storage.js`) so the popup can
 * explain a badge that shows `ERR` instead of guessing.
 */

import { findProfile } from './lib/model.js';
import {
  ensureState,
  loadFailover,
  loadServerHealth,
  loadState,
  loadStatus,
  sameApplyStatus,
  saveStatus,
  subscribe,
  subscribeServerHealth,
  updateFailover,
  updateServerHealth,
  updateState,
  updateRate,
  updateTraffic,
} from './lib/storage.js';
import {
  REAPPLY_MESSAGE,
  SWITCH_FLASH_MS,
  activeSwitchFlash,
  applyFailureReason,
  applyProxy,
  applyProxyConfig,
  buildProbeConfig,
  describeApplyProblem,
  describeBadge,
  describeSwitchBadge,
  isConfigApplied,
  readProxySettings,
} from './lib/proxy.js';
import {
  failoverEligible,
  failoverUndoTarget,
  noteHealthy,
  noteManualSwitch,
  noteProxyError,
  planFailover,
} from './lib/failover.js';
import { SWITCH_NOTICE_ID, buildSwitchNotice } from './lib/notice.js';
import { noteServerHealth, probeObservation } from './lib/server-health.js';
import {
  PROBE_ALARM,
  PROBE_CHECK_TIMEOUT_MS,
  PROBE_INTERVAL_MINUTES,
  TEST_ALL_MESSAGE,
  TEST_ALL_PROGRESS_MESSAGE,
  probeCandidates,
  probeEligible,
  probeVerdict,
  testAllEligible,
} from './lib/server-probe.js';
import { PROBE_TARGETS, probe, probeHost } from './lib/health.js';
import { meterRuns, noteRate, noteTraffic, requestBytes, responseBytes } from './lib/traffic.js';
import { resolveAuthCredentials } from './lib/auth.js';
import { resolveLang, t } from './lib/i18n.js';

const BADGE_COLORS = {
  off: '#6b7280',
  system: '#6b7280',
  manual: '#4f46e5',
  pac: '#0d9488',
  error: '#dc2626',
};

function currentLang(state) {
  const browser = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return resolveLang(state?.settings?.language, browser);
}

/** Applies state to the browser: proxy config, badge and context menus. */
async function runSync() {
  const state = await loadState();
  // The generated PAC chain is ordered by the last verdicts about each server,
  // so "apply everything" means reading those too.
  const health = await loadServerHealth();
  // Whether the meter may count is a fact about the state, and the meter itself
  // runs on every request — so the answer is cached here rather than read back
  // out of storage per event.
  meterOn = meterRuns(state);

  let outcome = null;
  let failed = null;
  try {
    outcome = await applyProxy(state, health);
  } catch (error) {
    failed = applyFailureReason(error);
  }

  const status = {
    ok: true,
    failed,
    levelOfControl: outcome?.levelOfControl ?? null,
    at: Date.now(),
  };
  // `settings.set` also resolves when it changed nothing, so the read-back in
  // applyProxy decides whether this really worked.
  status.ok = describeApplyProblem(status) === null;

  await saveStatus(status);
  await paintBadge(state, status);
  await rebuildMenus(state);
  await ensureProbeAlarm(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

/**
 * The automatic switch the badge is currently announcing, or null — see
 * `announceSwitch()`. It survives nothing: the worker owns it, and the moment
 * the worker restarts without it the badge is painted from the state again.
 */
let switchFlash = null;
let switchFlashTimer = 0;

/**
 * Paints the toolbar icon from the state *and* the apply status: a problem wins
 * over the mode, because "ON" on a proxy that is not in force is a lie.
 */
async function paintBadge(state, status) {
  if (!chrome.action) return;

  const problem = describeApplyProblem(status);
  // A switch that is still news is shown *instead of* the mode name, never
  // instead of a problem: `describeBadge` gets the last word on failures.
  const flash = problem ? null : activeSwitchFlash(switchFlash, state);
  const badge = flash ?? describeBadge(state, problem);
  const lang = currentLang(state);
  const profile = findProfile(state, state.settings.activeProfileId);

  let title = profile ? `Proxy Switch — ${profile.name}` : t('app.name', lang);
  if (problem) {
    const reason = t(problem.detail.key, lang, problem.detail.params);
    title = `Proxy Switch — ${t(problem.title.key, lang, problem.title.params)} — ${reason}`;
    console.error('[proxy-switch] the proxy settings were not applied', status.failed ?? status.levelOfControl);
  } else if (flash && profile) {
    title = `Proxy Switch — ${t('badge.switched', lang, { name: profile.name })}`;
  }

  try {
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[badge.tone] ?? BADGE_COLORS.system });
    await chrome.action.setTitle({ title });
  } catch {
    /* the action API is unavailable (e.g. in a test/preview context) */
  }
}

/**
 * A proxy that stopped answering is as much of a fact as a failed apply, so it
 * lands in the same record. Repeats are dropped: `onProxyError` fires for every
 * failed request, and repainting the badge for each one helps nobody.
 */
async function reportProxyError(reason) {
  const current = await loadStatus();
  const next = {
    ok: false,
    failed: String(reason ?? '') || 'proxy error',
    levelOfControl: current?.levelOfControl ?? null,
    at: Date.now(),
  };
  if (sameApplyStatus(current, next)) return;

  await saveStatus(next);
  await paintBadge(await loadState(), next);
}

/* ------------------------------------------------------------------ *
 * Apply on demand
 * ------------------------------------------------------------------ */

//
// Applying is serialized: one turn can now ask for it twice (a health verdict,
// then the state write it sits behind), and two applies of the same moment must
// not interleave — the one that read the older state must never land last.
//
let syncChain = Promise.resolve();

function sync() {
  const run = syncChain.then(runSync, runSync);
  syncChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Only reachable from inside the extension: there is no `externally_connectable`
// and no content script, so a message here is one of our own pages asking for
// the same thing a state change asks for.
chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === TEST_ALL_MESSAGE) {
    runTestAllPass(message)
      .then((answer) => sendResponse(answer))
      .catch((error) => {
        console.warn('[proxy-switch] the test-all pass failed', error);
        sendResponse({ started: false, error: applyFailureReason(error) });
      });
    return true; // keep the channel open for the asynchronous answer
  }

  if (message?.type !== REAPPLY_MESSAGE) return false;

  sync()
    // The answer carries the fresh status, so the caller can confirm the retry
    // without reading storage back itself.
    .then(() => loadStatus())
    .then((status) => sendResponse({ status }))
    .catch((error) => sendResponse({ status: null, error: applyFailureReason(error) }));

  return true; // keep the channel open for the asynchronous answer
});

/* ------------------------------------------------------------------ *
 * Automatic failover
 * ------------------------------------------------------------------ */

/**
 * Whether a check (and its probe) is running right now — see considerFailover.
 */
let confirming = false;

/**
 * Puts the server that just took over on the toolbar icon for a few seconds.
 *
 * The switch is news — the whole browser now reaches the network somewhere
 * else — and the icon is where the extension is actually looked at, but `ON`
 * says nothing about *which* server is on. The flash carries its own expiry, so
 * a worker that was terminated before its timer fired cannot leave the badge
 * lying: the next paint (a proxy error, a write from the popup, or simply the
 * `sync()` every worker boot starts with) reads an expired flash as absent.
 */
function announceSwitch(profile) {
  if (!profile) return;

  switchFlash = {
    badge: describeSwitchBadge(profile),
    profileId: profile.id,
    until: Date.now() + SWITCH_FLASH_MS,
  };
  clearTimeout(switchFlashTimer);
  switchFlashTimer = setTimeout(() => {
    switchFlashTimer = 0;
    switchFlash = null;
    loadState()
      .then((state) => loadStatus().then((status) => paintBadge(state, status)))
      .catch((error) => console.warn('[proxy-switch] repainting the badge failed', error));
  }, SWITCH_FLASH_MS);
}

/**
 * Tells the user which server took over. Without this the extension would
 * change how the whole browser is routed and say nothing about it: the switch
 * happens while nobody is looking at the popup. The wording comes from
 * `lib/notice.js`; a missing permission or a switched-off setting is not an
 * error — it just means no notification.
 */
async function notifySwitch(state, to, from) {
  const notice = buildSwitchNotice(state, to, from, currentLang(state));
  if (!notice || !chrome.notifications?.create) return;

  try {
    const base = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: notice.title,
      message: notice.message,
    };
    // "Back to <server>": the notification is the only place the user can
    // answer a switch the extension made for them.
    await chrome.notifications.create(
      notice.id,
      notice.button ? { ...base, buttons: [{ title: notice.button }] } : base,
    );
  } catch {
    // Firefox could not put a button in a notification until 152 (MDN lists
    // `NotificationOptions.buttons` as unsupported there), and a build that
    // refuses the option would cost the whole announcement. Announcing the
    // switch matters more than the undo affordance, so the same notice is
    // shown without the button rather than not at all.
    try {
      await chrome.notifications.create(notice.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: notice.title,
        message: notice.message,
      });
    } catch (error) {
      console.warn('[proxy-switch] the switch notification could not be shown', error);
    }
  }
}

/**
 * Opens the server list: the popup is exactly that list (Chrome 127 and up),
 * and everywhere else the settings page is — both are the extension's own UI,
 * neither needs a second click from the user.
 */
async function openServerList() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch {
    // No user gesture to open a popup with, or an older Chrome: fall through.
  }
  await chrome.runtime.openOptionsPage();
}

/**
 * The "go back" button on the switch notification: activate the server the
 * automatic switch moved away from and start the round over — see
 * `noteManualSwitch` for why the returned-to server still gets its grace period.
 *
 * Nothing is assumed: if the server is gone or the user has since picked
 * another one, there is nothing to undo and the server list opens instead.
 */
async function undoSwitch() {
  const state = await loadState();
  const target = failoverUndoTarget(await loadFailover(), state);
  if (!target) {
    await openServerList();
    return;
  }

  await updateState((draft) => {
    draft.settings.activeProfileId = target.id;
    draft.settings.mode = 'fixed_servers';
    draft.settings.enabled = true;
  });
  await updateFailover((draft) => noteManualSwitch(draft, { now: Date.now(), activeProfileId: target.id }));
  await clearSwitchNotice();
  console.info(`[proxy-switch] the switch was undone — back to ${target.name}`);
}

/** Takes the switch notification off the screen (it has been read or answered). */
async function clearSwitchNotice() {
  if (!chrome.notifications?.clear) return;
  try {
    await chrome.notifications.clear(SWITCH_NOTICE_ID);
  } catch (error) {
    console.warn('[proxy-switch] the switch notification could not be cleared', error);
  }
}

/**
 * Reacts to a proxy error by counting a strike (the bookkeeping that survives
 * the worker being asleep, see `lib/failover.js`) and, once the streak is long
 * enough, checking whether the active server really is down. A probe that
 * answers ends the matter; a probe that fails switches to the healthiest other
 * server — the one that was last proven to answer, fastest first, and never one
 * that just failed (`FAILOVER_FAILED_COOLDOWN_MS`).
 *
 * Errors alone never switch anything — one failed request does not prove the
 * server is gone — and a round visits every other server once, so a network
 * that is down everywhere reports `ERR` instead of flipping between servers.
 *
 * `onProxyError` fires per request, so a dead server produces a whole burst of
 * them: the guard is taken synchronously, before the first `await`, and only
 * one check (including its probe) may run at a time.
 */
async function considerFailover() {
  if (confirming || checking) return;
  confirming = true;

  try {
    const state = await loadState();
    if (!failoverEligible(state)) return;

    // The verdicts the extension already has decide *where* it goes, so they
    // are part of the decision, not a side note. The record read here cannot
    // contain the failure this check is about to confirm: that verdict is
    // written below, and it is about the server being left — which is never a
    // candidate anyway.
    const context = {
      now: Date.now(),
      activeProfileId: state.settings.activeProfileId,
      profiles: state.profiles,
      health: await loadServerHealth(),
    };

    const shouldProbe = await updateFailover((draft) => noteProxyError(draft, context));
    if (!shouldProbe) return;

    const outcome = await probe();

    // A probe through the active server is a verdict about that server too
    // (manual mode only — see `probeObservation`), and the generated PAC chain
    // is ordered by the verdicts it has seen.
    const observation = probeObservation(state, outcome);
    if (observation) {
      await updateServerHealth((draft) => noteServerHealth(draft, observation));
    }

    if (outcome.ok) {
      // The server answered: whatever failed was not the route's fault.
      await updateFailover((draft) => noteHealthy(draft));
      return;
    }

    const nextId = await updateFailover((draft) => planFailover(draft, context));
    if (!nextId) return;

    const nextProfile = findProfile(state, nextId);

    // The announcement goes up *before* the write below: that write repaints
    // the badge through `subscribe`, so arming the flash first means every
    // paint that follows agrees about what the icon should show.
    announceSwitch(nextProfile);

    // Writing the state is all a switch is: `subscribe` below applies it, the
    // same way a server picked in the popup or the context menu is applied.
    await updateState((draft) => {
      draft.settings.activeProfileId = nextId;
      draft.settings.mode = 'fixed_servers';
      draft.settings.enabled = true;
    });

    // The server it left behind is what a "go back" click would return to.
    await notifySwitch(state, nextProfile, findProfile(state, state.settings.activeProfileId));
    console.info(
      `[proxy-switch] the active server stopped answering — switched to ${nextProfile?.name ?? nextId}`,
    );
  } finally {
    confirming = false;
  }
}

/* ------------------------------------------------------------------ *
 * Background checks
 * ------------------------------------------------------------------ */

/**
 * The server a check is looking at right now, and whether one is running at all.
 *
 * Two things depend on it. A proxy error the check itself provoked must not be
 * counted as a strike — a probe into a server nobody asked about is not the
 * user's route breaking. And a failover check must not start while the applied
 * route is a check's own temporary one: its probe would be handed to the very
 * server being checked and then credited to the active one.
 */
let checking = false;
/** @type {string|null} */
let checkingProfileId = null;

/** The hosts of the probe endpoints — what a check's own requests look like. */
const PROBE_HOSTS = new Set(PROBE_TARGETS.map((url) => probeHost(url).toLowerCase()));

/** Whether a proxy error about `url` is one of the check's own probes. */
function isProbeUrl(url) {
  try {
    return PROBE_HOSTS.has(new URL(String(url)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Looks at one server: installs the check's own configuration (the user's
 * policy, with the extension's probes handed to `target`), sends one probe, and
 * reports what it found — as a verdict about `target` and nobody else.
 *
 * The probe is the same plain `fetch` the test button and the failover check
 * use, so it travels through the proxy configuration in force — which, for those
 * few seconds, is the one installed above. That is the whole mechanism: no
 * socket is opened by hand and no per-request proxy is asked for.
 *
 * @returns {Promise<object|null>} the verdict, or null when the look could not
 *          be taken (the browser is not letting us apply, or something else
 *          replaced the configuration while the probe was in flight, in which
 *          case the answer is about that route and not about this server)
 */
async function checkServer(state, target, health) {
  const config = buildProbeConfig(state, target, health);
  if (!config) return null;

  const installed = await applyProxyConfig(config);
  if (!installed.applied || installed.levelOfControl !== 'controlled_by_this_extension') {
    return null;
  }

  checkingProfileId = target.id;
  let outcome = null;
  try {
    outcome = await probe({ timeoutMs: PROBE_CHECK_TIMEOUT_MS });
  } finally {
    checkingProfileId = null;
  }

  // Believe the result only if our own script is still the one in force.
  if (!isConfigApplied(await readProxySettings(), config)) return null;
  return probeVerdict(target, outcome);
}

/**
 * One pass over the servers that are due (see `lib/server-probe.js`). Runs on a
 * timer, so the user's own configuration has to be the one in force when it
 * finishes — whatever happened in between. A worker killed in the middle of a
 * pass leaves the check's script applied, and the `sync()` that every worker
 * start ends with is what repairs that.
 */
async function checkServers() {
  if (checking || confirming) return;
  checking = true;

  try {
    const state = await loadState();
    if (!probeEligible(state)) return;

    const health = await loadServerHealth();
    for (const target of probeCandidates(state.profiles, health)) {
      const verdict = await checkServer(state, target, health);
      if (!verdict) continue;
      await updateServerHealth((draft) => noteServerHealth(draft, verdict));
      console.info(
        `[proxy-switch] the background check looked at ${target.name}: ${
          verdict.ok ? `${verdict.ms} ms` : 'no answer'
        }`,
      );
    }
  } finally {
    checking = false;
    checkingProfileId = null;
    // Every path out of here restores the user's configuration: a check that
    // threw must not leave its own script applied.
    await sync();
  }
}

/* ------------------------------------------------------------------ *
 * Traffic meter
 * ------------------------------------------------------------------ */

/**
 * Counts what the browser declares about a request and its response. Chrome
 * gives an extension no byte counts of its own (see `lib/traffic.js`), so this
 * adds up declared body sizes — and writes them in batches, because a single
 * page load is hundreds of events and one storage write per event would be both
 * slower and noisier than the number is worth.
 *
 * The listeners may not be a second writer of anything: the counters live in
 * their own key, and no state, no verdict and no applied configuration is
 * touched from here.
 */

/** How long a batch may grow before it is written (the worker may die any time). */
const TRAFFIC_FLUSH_MS = 5000;

/** Whether the meter may count at all — kept current by `runSync()`. */
let meterOn = false;
/**
 * The batch in hand: the bytes seen since the last write, when its first byte
 * arrived, and the timer that will write it.
 */
let pendingUp = 0;
let pendingDown = 0;
let pendingSince = 0;
let flushTimer = 0;

/**
 * Writes the batch that has piled up. The bytes are taken out of the counters
 * *before* the write, so a failed write loses that batch rather than counting it
 * twice on the next flush.
 *
 * The same batch is stamped into the live rate's window, so the speed the pages
 * show is the speed of the very bytes just counted — one observation, two
 * readers, and no second listener deciding on its own what a byte is. The
 * batch also reports how long it took, because a speed is bytes over time: the
 * span begins with the batch's first byte, never with the last flush.
 */
async function flushTraffic() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (pendingUp <= 0 && pendingDown <= 0) {
    pendingSince = 0;
    return;
  }

  const up = pendingUp;
  const down = pendingDown;
  const since = pendingSince;
  pendingUp = 0;
  pendingDown = 0;
  pendingSince = 0;
  const at = Date.now();
  const ms = since > 0 ? at - since : 0;

  try {
    await updateTraffic((draft) => noteTraffic(draft, { up, down, at }));
    await updateRate((draft) => noteRate(draft, { up, down, at, ms }));
  } catch (error) {
    console.warn('[proxy-switch] the traffic counters could not be written', error);
  }
}

/**
 * Adds one observation to the batch in hand, and arms the timer if it is idle.
 * The batch's clock starts with its first byte, so the span it reports is the
 * time those bytes really took rather than the length of the timer.
 */
function countTraffic(up, down) {
  if (up <= 0 && down <= 0) return;
  if (!pendingSince) pendingSince = Date.now();
  pendingUp += up;
  pendingDown += down;

  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTraffic().catch((error) => console.warn('[proxy-switch] the flush failed', error));
  }, TRAFFIC_FLUSH_MS);
}

// Uploads: the size a request declares for the body it is about to send. Most
// requests declare nothing, which is exactly what `requestBytes` returns.
chrome.webRequest?.onBeforeSendHeaders.addListener(
  (details) => {
    if (!meterOn || isProbeUrl(details?.url)) return;
    countTraffic(requestBytes(details), 0);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders'],
);

// Downloads: the size a response declared when it arrived — and only when it
// really arrived, because a response served from the cache is not traffic.
chrome.webRequest?.onCompleted.addListener(
  (details) => {
    if (!meterOn || isProbeUrl(details?.url)) return;
    countTraffic(0, responseBytes(details));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// The worker is stopped between events, and a timer does not survive that. This
// is best effort by nature — the write is asynchronous and the worker may be
// gone before it lands — but it costs nothing and usually saves the last few
// seconds of counting.
chrome.runtime?.onSuspend?.addListener(() => {
  flushTraffic().catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Test all servers — the popup button's pass over the whole list
 * ------------------------------------------------------------------ */

/**
 * A pass looks at every saved server, one after another, and says so: each
 * verdict is announced (`TEST_ALL_PROGRESS_MESSAGE`, `done`/`total`) the moment
 * it is recorded, so the popup's line and its list fill in while the pass is
 * still running.
 *
 * This is the background check's schedule replaced by an explicit request, not
 * a second mechanism for looking at servers: the same `checkServer` runs, so the
 * same rules hold — one server at a time, a verdict only for the server that was
 * actually probed, and the user's own configuration back in force afterwards.
 * The pass runs in the worker because only the worker may touch `chrome.proxy`
 * (the single-writer rule); the popup only asks and listens.
 *
 * It is a *different* policy from the timer's in one deliberate way: the user
 * asked, so every saved server is looked at, not just the two a background pass
 * is allowed (`probeCandidates` caps it) and not just the stale ones — a fresh
 * verdict from last week may already be a lie. A look that cannot be taken
 * (mode, control, a config replaced mid-probe) is announced as skipped rather
 * than guessed about.
 *
 * The message is answered the moment the pass *begins*, not when it ends: a
 * popup that waited for the last verdict would have to stay open for the whole
 * run, and a closed popup would kill the answer channel. The verdicts reach the
 * open popup through the progress messages instead.
 *
 * @returns {Promise<{started: boolean, running?: boolean, total?: number}>}
 */
async function runTestAllPass(message = {}) {
  const state = await loadState();

  if (message?.action === 'status') {
    return runningTestAllPass
      ? { started: false, running: true, done: doneCount, total: totalCount }
      : { started: false, running: false };
  }

  if (!testAllEligible(state)) return { started: false };

  // One pass at a time. A second press while the first is running reports where
  // it is instead of queueing a duplicate list behind it.
  if (runningTestAllPass) {
    return { started: false, running: true, done: doneCount, total: totalCount };
  }

  runningTestAllPass = true;
  doneCount = 0;
  totalCount = state.profiles.length;

  // The pass itself is not awaited: the answer must go out now, and the pass
  // ends on its own (progress messages, then a final `sync()` below).
  runTestAllSteps(state).catch((error) => {
    console.warn('[proxy-switch] the test-all pass failed', error);
    runningTestAllPass = false;
    checkingProfileId = null;
    return sync();
  });

  return { started: true, total: totalCount };
}

/** The body of a test-all pass: one `checkServer` per saved server, in order. */
async function runTestAllSteps(state) {
  try {
    for (const target of state.profiles) {
      const verdict = await checkServer(state, target, await loadServerHealth());
      if (!verdict) {
        // The look could not be taken (mode, control, a config replaced mid-
        // probe): nothing was proven, so nothing is recorded — and the popup
        // counts the server as skipped rather than failed.
        announceTestAllProgress({ done: ++doneCount, total: totalCount, skipped: true });
        continue;
      }
      await updateServerHealth((draft) => noteServerHealth(draft, verdict));
      console.info(
        `[proxy-switch] the test-all pass looked at ${target.name}: ${
          verdict.ok ? `${verdict.ms} ms` : 'no answer'
        }`,
      );
      announceTestAllProgress({
        done: ++doneCount,
        total: totalCount,
        ok: verdict.ok,
        ms: verdict.ms,
      });
    }
  } finally {
    runningTestAllPass = false;
    checkingProfileId = null;
    // Every path out of here restores the user's configuration: a check that
    // threw must not leave its own script applied.
    await sync();
  }
}

/**
 * Whether a test-all pass is running right now, and how far it has got. The
 * worker owns this (a pass survives nothing but the worker itself), so a popup
 * that opens while one runs asks for it rather than guessing from storage.
 */
let runningTestAllPass = false;
let doneCount = 0;
let totalCount = 0;

/**
 * Tells the pages where the pass is. A worker cannot push a message to a popup
 * that is not open, so this is sent without a sender to reply to and arrives at
 * whichever page has subscribed — the popup decides what to do with it.
 */
function announceTestAllProgress(progress) {
  try {
    chrome.runtime.sendMessage({ type: TEST_ALL_PROGRESS_MESSAGE, ...progress }).catch(() => {
      /* no listener (popup closed, or the preview) — nothing to tell, then */
    });
  } catch {
    /* the message port can be gone while the worker is shutting down */
  }
}

/**
 * Keeps the periodic check in step with the setting. The alarm is created once
 * and then left alone — re-creating it on every apply would reset its timer and
 * a check that is always five minutes away never happens.
 */
async function ensureProbeAlarm(state) {
  if (!chrome.alarms) return;

  try {
    const existing = await chrome.alarms.get(PROBE_ALARM);
    if (probeEligible(state)) {
      if (!existing) {
        chrome.alarms.create(PROBE_ALARM, {
          delayInMinutes: PROBE_INTERVAL_MINUTES,
          periodInMinutes: PROBE_INTERVAL_MINUTES,
        });
      }
      return;
    }
    if (existing) await chrome.alarms.clear(PROBE_ALARM);
  } catch (error) {
    console.warn('[proxy-switch] the background check could not be scheduled', error);
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm?.name !== PROBE_ALARM) return;
  checkServers().catch((error) => {
    console.warn('[proxy-switch] the background check failed', error);
  });
});

/* ------------------------------------------------------------------ *
 * What the user can do with the switch notification
 * ------------------------------------------------------------------ */

// Clicking the body is the user asking "where am I routed now?": the answer is
// the server list, with the active one already marked.
chrome.notifications?.onClicked.addListener((id) => {
  if (id !== SWITCH_NOTICE_ID) return;
  openServerList().catch((error) =>
    console.warn('[proxy-switch] opening the server list failed', error),
  );
});

// The only button on it is "Back to <server>".
chrome.notifications?.onButtonClicked.addListener((id, buttonIndex) => {
  if (id !== SWITCH_NOTICE_ID || buttonIndex !== 0) return;
  undoSwitch().catch((error) => console.warn('[proxy-switch] the undo failed', error));
});

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

const MENU_ROOT = 'proxy-switch';

async function rebuildMenus(state) {
  if (!chrome.contextMenus) return;
  const lang = currentLang(state);
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: t('menu.root', lang),
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: `${MENU_ROOT}:system`,
    parentId: MENU_ROOT,
    title: t('menu.system', lang),
    type: 'radio',
    checked: state.settings.enabled && state.settings.mode === 'system',
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: `${MENU_ROOT}:direct`,
    parentId: MENU_ROOT,
    title: t('menu.direct', lang),
    type: 'radio',
    checked: !state.settings.enabled || state.settings.mode === 'direct',
    contexts: ['action'],
  });

  for (const profile of state.profiles.slice(0, 10)) {
    chrome.contextMenus.create({
      id: `${MENU_ROOT}:profile:${profile.id}`,
      parentId: MENU_ROOT,
      title: profile.name,
      type: 'radio',
      checked:
        state.settings.enabled &&
        state.settings.mode === 'fixed_servers' &&
        state.settings.activeProfileId === profile.id,
      contexts: ['action'],
    });
  }

  chrome.contextMenus.create({
    id: `${MENU_ROOT}:settings`,
    parentId: MENU_ROOT,
    title: t('menu.settings', lang),
    contexts: ['action'],
  });
}

chrome.contextMenus?.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);
  if (!id.startsWith(MENU_ROOT)) return;

  if (id === `${MENU_ROOT}:settings`) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  await updateState((draft) => {
    if (id === `${MENU_ROOT}:system`) {
      draft.settings.mode = 'system';
      draft.settings.enabled = true;
    } else if (id === `${MENU_ROOT}:direct`) {
      draft.settings.mode = 'direct';
      draft.settings.enabled = true;
    } else if (id.startsWith(`${MENU_ROOT}:profile:`)) {
      const profileId = id.slice(`${MENU_ROOT}:profile:`.length);
      if (!draft.profiles.some((profile) => profile.id === profileId)) return;
      draft.settings.activeProfileId = profileId;
      draft.settings.mode = 'fixed_servers';
      draft.settings.enabled = true;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Proxy authentication
 * ------------------------------------------------------------------ */

chrome.webRequest?.onAuthRequired.addListener(
  (details, callback) => {
    const answer = async () => {
      // Which profile may answer, and when, is pure logic — see lib/auth.js.
      const credentials = resolveAuthCredentials(await loadState(), details, checkingProfileId);
      return credentials ? { authCredentials: credentials } : {};
    };

    answer()
      .then((result) => callback(result))
      .catch((error) => {
        console.warn('[proxy-switch] auth handling failed', error);
        callback({});
      });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

/**
 * A route broke. Chrome calls this event `onProxyError`; Firefox renamed it to
 * `onError` and keeps the old name only as a deprecated alias, so whichever the
 * browser still has is the one to subscribe to. The two hand over different
 * shapes — Chrome an object carrying an `error` string, Firefox an Error — and
 * the badge treats both the same way: what matters is that a route broke, not
 * how it spelled itself.
 */
const proxyErrors = chrome.proxy?.onError ?? chrome.proxy?.onProxyError;
proxyErrors?.addListener((details) => {
  // A check hands its own probe to a server the user may not even be using: the
  // error is that server's answer, not a broken route, and it is recorded as a
  // verdict by the check itself.
  if (checking && isProbeUrl(details?.url)) return;

  reportProxyError(details?.error ?? details?.message);
  // Not awaited on purpose: the listener must return immediately, and a failed
  // check must not look like an unhandled rejection in the worker.
  considerFailover().catch((error) => {
    console.warn('[proxy-switch] the failover check failed', error);
  });
});

/* ------------------------------------------------------------------ *
 * Keyboard shortcuts (chrome://extensions/shortcuts)
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-proxy' && command !== 'go-direct') return;

  await updateState((draft) => {
    if (command === 'toggle-proxy') {
      draft.settings.enabled = !draft.settings.enabled;
    } else {
      draft.settings.enabled = true;
      draft.settings.mode = 'direct';
    }
  });
});

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureState();
  await sync();
  if (reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') });
  }
});

chrome.runtime.onStartup.addListener(() => sync());

// Any write from the popup or the settings page lands here.
subscribe(() => {
  sync();
});

// A fresh verdict can reorder the chain in a generated PAC script, and the
// chain only reaches Chrome when the proxy is applied again.
subscribeServerHealth(() => {
  sync();
});

// Also runs whenever the worker is woken up, which keeps the applied settings
// in sync even if something changed while the worker was asleep.
sync();
