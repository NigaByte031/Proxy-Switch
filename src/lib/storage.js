/**
 * Thin promise wrapper around `chrome.storage.local`.
 *
 * Everything lives in `local` (never `sync`) on purpose: server entries can
 * hold credentials and those must not travel to other devices.
 */

import { STORAGE_KEY, createDefaultState, sanitizeState } from './model.js';

function store() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return chrome.storage.local;
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
 * Read-modify-write helper.
 * @param {(draft: object) => void} mutator mutates a copy of the current state
 */
export async function updateState(mutator) {
  const current = await loadState();
  const draft = structuredClone(current);
  mutator(draft);
  return saveState(draft);
}

/**
 * Subscribes to state changes (including the ones this page made itself).
 * @returns {() => void} unsubscribe
 */
export function subscribe(callback) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    callback(sanitizeState(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
