/**
 * MV3 service worker — the only place that talks to `chrome.proxy`.
 *
 * It watches the stored state and re-applies it on every change, so the pages stay
 * dumb writers. It is also the only place that knows whether applying worked: each
 * attempt's result is stored (see `lib/storage.js`).
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
  // The generated PAC chain is ordered by the last verdicts about each server.
  const health = await loadServerHealth();
  // Cached rather than read out of storage per event: the meter runs on every
  // request.
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
  // `settings.set` resolves even when it changed nothing, so the read-back decides
  // whether this really worked.
  status.ok = describeApplyProblem(status) === null;

  await saveStatus(status);
  await paintBadge(state, status);
  await rebuildMenus(state);
  await ensureProbeAlarm(state);
  return state;
}

/* Badge. */

/**
 * The automatic switch the badge is currently announcing, or null — see
 * `announceSwitch()`. It survives nothing: a worker restart paints the badge from
 * the state again.
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
  // A still-fresh switch replaces the mode name, never a problem.

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
 * A proxy that stopped answering is as much a fact as a failed apply, so it lands
 * in the same record. Repeats are dropped: `onProxyError` fires for every failed
 * request, and repainting the badge for each one helps nobody.
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

/* Apply on demand. */

// Applying is serialized: one turn can ask for it twice (a health verdict, then
// the state write behind it), and the apply that read the older state must not
// land last.
let syncChain = Promise.resolve();

function sync() {
  const run = syncChain.then(runSync, runSync);
  syncChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Only reachable from inside the extension (no `externally_connectable`, no
// content script), so a message here is one of our own pages.
chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === TEST_ALL_MESSAGE) {
    runTestAllPass(message)
      .then((answer) => sendResponse(answer))
      .catch((error) => {
        console.warn('[proxy-switch] the test-all pass failed', error);
        sendResponse({ started: false, error: applyFailureReason(error) });
      });
    // keep the channel open for the asynchronous answer
    return true;
  }

  if (message?.type !== REAPPLY_MESSAGE) return false;

  sync()
    // The answer carries the fresh status, so the caller needs no extra read.
    .then(() => loadStatus())
    .then((status) => sendResponse({ status }))
    .catch((error) => sendResponse({ status: null, error: applyFailureReason(error) }));

  // keep the channel open for the asynchronous answer
  return true;
});

/* Automatic failover. */

/**
 * Whether a check (and its probe) is running right now — see considerFailover.
 */
let confirming = false;

/**
 * Puts the server that just took over on the toolbar icon for a few seconds: the
 * switch is news, and `ON` says nothing about *which* server is on. The flash
 * carries its own expiry, so a worker terminated before its timer fired cannot
 * leave the badge lying.
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
 * Tells the user which server took over. Without this the extension would change
 * how the whole browser is routed and say nothing about it, since the switch
 * happens while nobody is looking at the popup. A missing permission or a
 * switched-off setting is not an error — it just means no notification.
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
    // "Back to <server>": the only place the user can answer a switch.
    await chrome.notifications.create(
      notice.id,
      notice.button ? { ...base, buttons: [{ title: notice.button }] } : base,
    );
  } catch {
    // Firefox before 152 refuses `NotificationOptions.buttons` and would reject
    // the whole notification, so the same notice is shown without the button:
    // announcing the switch matters more than the undo affordance.
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
 * Opens the server list: the popup is exactly that list (Chrome 127 and up), and
 * everywhere else the settings page is. Both are the extension's own UI.
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
 * The "go back" button on the switch notification: activate the server the switch
 * moved away from and start the round over (see `noteManualSwitch`). If that server
 * is gone, or the user has picked another one since, the server list opens instead.
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
 * Reacts to a proxy error by counting a strike (see `lib/failover.js`) and, once the
 * streak is long enough, checking whether the active server really is down. A probe
 * that answers ends the matter; a probe that fails switches to the healthiest other
 * server.
 *
 * `onProxyError` fires per request, so a dead server produces a whole burst: the
 * guard is taken synchronously, before the first `await`.
 */
async function considerFailover() {
  if (confirming || checking) return;
  confirming = true;

  try {
    const state = await loadState();
    if (!failoverEligible(state)) return;

    // The verdicts the extension already has decide *where* it goes. This record
    // cannot contain the failure this check is about to confirm: that verdict is
    // about the server being left, which is never a candidate anyway.
    const context = {
      now: Date.now(),
      activeProfileId: state.settings.activeProfileId,
      profiles: state.profiles,
      health: await loadServerHealth(),
    };

    const shouldProbe = await updateFailover((draft) => noteProxyError(draft, context));
    if (!shouldProbe) return;

    const outcome = await probe();

    // A probe through the active server is a verdict about it too (manual mode
    // only — see `probeObservation`).
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

    // Armed before the write below: that write repaints the badge through
    // `subscribe`, so every paint that follows agrees about the icon.
    announceSwitch(nextProfile);

    // A switch is nothing but a state write: `subscribe` below applies it.
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

/* Background checks. */

/**
 * The server a check is looking at right now, and whether one is running at all. A
 * proxy error the check provoked must not count as a strike, and a failover check
 * must not start while the route is a check's own temporary one.
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
 * Looks at one server: installs the check's own configuration (the user's policy,
 * with the extension's probes handed to `target`), sends one probe, and reports a
 * verdict about `target` and nobody else. The probe is the same plain `fetch` the
 * test button uses, so it travels through the configuration in force.
 *
 * @returns {Promise<object|null>} the verdict, or null when the look could not be
 *          taken (the browser is not letting us apply, or something else replaced
 *          the configuration while the probe was in flight)
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
 * timer, so the user's own configuration has to be back in force when it finishes.
 * A worker killed mid-pass leaves the check's script applied, and the `sync()` that
 * every worker start ends with repairs that.
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
    // Every path out of here restores the user's configuration.
    await sync();
  }
}

/* Traffic meter. */

/**
 * Counts what the browser declares about a request and its response (see
 * `lib/traffic.js`), in batches: a single page load is hundreds of events, and one
 * storage write per event would be slower and noisier than the number is worth.
 *
 * The counters live in their own key — no state, no verdict and no applied
 * configuration is touched here.
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
 * Writes the batch that has piled up. Its bytes are cleared *before* the write, so
 * a failed write loses that batch rather than counting it twice. The same batch is
 * stamped into the live rate's window, its span beginning at the batch's first byte.
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
 * Adds one observation to the batch in hand, and arms the timer if it is idle. The
 * batch's clock starts with its first byte, so the span it reports is the time
 * those bytes really took rather than the length of the timer.
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

// Uploads: the size a request declares for the body it is about to send.
chrome.webRequest?.onBeforeSendHeaders.addListener(
  (details) => {
    if (!meterOn || isProbeUrl(details?.url)) return;
    countTraffic(requestBytes(details), 0);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders'],
);

// Downloads: the size a response declared when it arrived — one served from the
// cache never did travel.
chrome.webRequest?.onCompleted.addListener(
  (details) => {
    if (!meterOn || isProbeUrl(details?.url)) return;
    countTraffic(0, responseBytes(details));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// The worker is stopped between events and a timer does not survive that, so this
// is best effort by nature — but it costs nothing and usually saves the last few
// seconds of counting.
chrome.runtime?.onSuspend?.addListener(() => {
  flushTraffic().catch(() => {});
});

/* Test all servers — the popup button's pass over the whole list. */

/**
 * A pass looks at every saved server, one after another, announcing each verdict as
 * it is recorded, so the popup's line fills in while the pass is still running. The
 * same `checkServer` runs, in the worker — only the worker may touch `chrome.proxy`
 * — and because the user asked, every saved server is looked at, stale or not.
 *
 * The message is answered the moment the pass *begins*: a popup that waited for the
 * last verdict would have to stay open for the whole run.
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

  // One pass at a time: a second press reports where the first one is.
  if (runningTestAllPass) {
    return { started: false, running: true, done: doneCount, total: totalCount };
  }

  runningTestAllPass = true;
  doneCount = 0;
  totalCount = state.profiles.length;

  // The pass is not awaited: the answer must go out now, and the pass ends on
  // its own (progress messages, then a final `sync()` below).
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
    // Every path out of here restores the user's configuration.
    await sync();
  }
}

/**
 * Whether a test-all pass is running right now, and how far it has got. A popup
 * that opens while one runs asks for it rather than guessing from storage.
 */
let runningTestAllPass = false;
let doneCount = 0;
let totalCount = 0;

/**
 * Tells the pages where the pass is. A worker cannot push a message to a popup
 * that is not open, so this is sent without a sender to reply to and arrives at
 * whichever page has subscribed.
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
 * Keeps the periodic check in step with the setting. The alarm is created once and
 * then left alone: re-creating it on every apply would reset its timer, and a
 * check that is always five minutes away never happens.
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

/* What the user can do with the switch notification. */

// Clicking the body asks "where am I routed now?": the server list is the answer.
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

/* Context menu. */

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

/* Proxy authentication. */

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
 * `onError` and keeps the old name as an alias, so whichever the browser has is the
 * one to subscribe to. Their argument shapes differ, and both are treated the same:
 * what matters is that a route broke.
 */
const proxyErrors = chrome.proxy?.onError ?? chrome.proxy?.onProxyError;
proxyErrors?.addListener((details) => {
  // A check hands its own probe to a server the user may not be using: that error
  // is the server's answer, not a broken route, and the check records it itself.
  if (checking && isProbeUrl(details?.url)) return;

  reportProxyError(details?.error ?? details?.message);
  // Not awaited: the listener must return immediately.
  considerFailover().catch((error) => {
    console.warn('[proxy-switch] the failover check failed', error);
  });
});

/* Keyboard shortcuts (chrome://extensions/shortcuts). */

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

/* Bootstrap. */

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
