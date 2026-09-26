/**
 * Thin promise wrapper around `chrome.storage.local`.
 *
 * Everything lives in `local` (never `sync`) on purpose: server entries can
 * hold credentials and those must not travel to other devices.
 *
 * Two keys live here: the state itself and the result of the last attempt to
 * apply it, which is what lets the popup explain a badge that shows `ERR`.
 * A third one — the failover record — is documented next to its own section.
 */

import { STORAGE_KEY, createDefaultState, sanitizeState } from './model.js';
import { createFailoverRecord, sameFailoverRecord, sanitizeFailoverRecord } from './failover.js';
import {
  createServerHealth,
  sameServerHealth,
  sanitizeServerHealth,
} from './server-health.js';

/** Key holding the outcome of the last `chrome.proxy.settings.set`. */
export const STATUS_KEY = 'proxySwitchApplyStatus';

/**
 * Key holding the auto-failover bookkeeping (strikes, servers already tried in
 * this round, cooldown clock). It sits outside the state on purpose: it is
 * internal memory, not configuration, so it must not be exported or reset
 * with the settings.
 */
export const FAILOVER_KEY = 'proxySwitchFailover';

/**
 * Key holding what was last proven about each server (answered? how fast?),
 * which decides the order of the chain in the generated PAC script. Memory,
 * not configuration, for the same reason as the failover record above.
 */
export const SERVER_HEALTH_KEY = 'proxySwitchServerHealth';

function store() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

function changeListener(onChange) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    onChange(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** @returns {Promise<object>} the persisted state, or defaults when nothing is stored. */
export async function loadState() {
  const area = store();
  if (!area) return createDefaultState();
  const result = await area.get(STORAGE_KEY);
  const raw = result?.[STORAGE_KEY];
  if (!raw) return createDefaultState();
  return sanitizeState(raw);
}

/** Writes a sanitized copy back to storage and returns it. */
export async function saveState(state) {
  const clean = sanitizeState(state);
  const area = store();
  if (area) await area.set({ [STORAGE_KEY]: clean });
  return clean;
}

/** Seeds defaults on first run (and after a storage wipe). */
export async function ensureState() {
  const area = store();
  if (!area) return createDefaultState();
  const result = await area.get(STORAGE_KEY);
  if (result?.[STORAGE_KEY]) return sanitizeState(result[STORAGE_KEY]);
  return saveState(createDefaultState());
}

/**
 * Reads the current state, and writes the result of mutating a copy of it.
 *
 * Every writer in the extension goes through this, and writes are queued, so
 * two quick actions in one page ("flip the switch" then "pick a server") can no
 * longer both start from the same snapshot and lose the first one. Different
 * pages still run in different JavaScript contexts; there the queue is per page.
 *
 * @param {(draft: object) => void} mutator mutates a copy of the current state
 */
export function updateState(mutator) {
  return enqueue(async () => {
    const current = await loadState();
    const draft = structuredClone(current);
    mutator(draft);
    return saveState(draft);
  });
}

/** Serialises a chain of async writes: each one starts where the last ended. */
let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task, task);
  // A failed write must not poison the queue for the ones behind it.
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/* ------------------------------------------------------------------ *
 * Applying status
 * ------------------------------------------------------------------ */

/** Coerces anything stored into an apply-status record, or null. */
export function sanitizeApplyStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  return {
    ok: raw.ok === true,
    failed: typeof raw.failed === 'string' && raw.failed ? raw.failed : null,
    levelOfControl:
      typeof raw.levelOfControl === 'string' && raw.levelOfControl ? raw.levelOfControl : null,
    at: Number.isFinite(at) ? at : 0,
  };
}

/** Whether two records describe the same problem (the timestamp does not count). */
export function sameApplyStatus(left, right) {
  const a = sanitizeApplyStatus(left);
  const b = sanitizeApplyStatus(right);
  if (!a || !b) return a === b;
  return a.ok === b.ok && a.failed === b.failed && a.levelOfControl === b.levelOfControl;
}

export async function loadStatus() {
  const area = store();
  if (!area) return null;
  const result = await area.get(STATUS_KEY);
  return sanitizeApplyStatus(result?.[STATUS_KEY]);
}

/** Stores the apply status, skipping the write when nothing really changed. */
export async function saveStatus(status) {
  const clean = sanitizeApplyStatus(status);
  const area = store();
  if (!area || !clean) return clean;
  if (sameApplyStatus(await loadStatus(), clean)) return clean;
  await area.set({ [STATUS_KEY]: clean });
  return clean;
}

/* ------------------------------------------------------------------ *
 * Failover bookkeeping
 * ------------------------------------------------------------------ */

/** @returns {Promise<object>} the persisted failover record, or a fresh one. */
export async function loadFailover() {
  const area = store();
  if (!area) return createFailoverRecord();
  const result = await area.get(FAILOVER_KEY);
  return sanitizeFailoverRecord(result?.[FAILOVER_KEY]);
}

/**
 * Queued read–modify–write of the failover record — `updateState` for the
 * other key. `mutator` gets a copy, may mutate it and may return anything;
 * that return value is what the promise resolves with (the decision to probe,
 * the server to switch to).
 *
 * A record that did not change is not written again, so the long tail of a
 * burst of `onProxyError` events — the streak already reached the threshold —
 * costs no storage traffic at all.
 *
 * @param {(draft: object) => any} mutator
 */
export function updateFailover(mutator) {
  return enqueue(async () => {
    const stored = await loadFailover();
    const draft = structuredClone(stored);
    const decision = mutator(draft);
    const clean = sanitizeFailoverRecord(draft);
    const area = store();
    if (area && !sameFailoverRecord(stored, clean)) await area.set({ [FAILOVER_KEY]: clean });
    return decision;
  });
}

/* ------------------------------------------------------------------ *
 * Server health
 * ------------------------------------------------------------------ */

/** @returns {Promise<object>} the stored health record, or an empty one. */
export async function loadServerHealth() {
  const area = store();
  if (!area) return createServerHealth();
  const result = await area.get(SERVER_HEALTH_KEY);
  return sanitizeServerHealth(result?.[SERVER_HEALTH_KEY]);
}

/**
 * Queued read–modify–write of the health record — `updateState` for the state,
 * `updateFailover` for the other record. Nothing is rewritten when the verdicts
 * did not change, so a repeated failure costs no storage traffic.
 *
 * @param {(draft: object) => any} mutator
 */
export function updateServerHealth(mutator) {
  return enqueue(async () => {
    const stored = await loadServerHealth();
    const draft = structuredClone(stored);
    mutator(draft);
    const clean = sanitizeServerHealth(draft);
    const area = store();
    if (area && !sameServerHealth(stored, clean)) await area.set({ [SERVER_HEALTH_KEY]: clean });
    return clean;
  });
}

/**
 * Subscribes to health changes: a new verdict can reorder the PAC chain, and
 * the chain only reaches Chrome when the worker applies the proxy again.
 */
export function subscribeServerHealth(callback) {
  return changeListener((changes) => {
    if (!changes[SERVER_HEALTH_KEY]) return;
    callback(sanitizeServerHealth(changes[SERVER_HEALTH_KEY].newValue));
  });
}

/** Subscribes to apply-status changes (the popup uses it to explain a badge). */
export function subscribeStatus(callback) {
  return changeListener((changes) => {
    if (!changes[STATUS_KEY]) return;
    callback(sanitizeApplyStatus(changes[STATUS_KEY].newValue));
  });
}

/**
 * Subscribes to state changes (including the ones this page made itself).
 * @returns {() => void} unsubscribe
 */
export function subscribe(callback) {
  return changeListener((changes) => {
    if (!changes[STORAGE_KEY]) return;
    callback(sanitizeState(changes[STORAGE_KEY].newValue));
  });
}
