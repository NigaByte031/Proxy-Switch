import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEY, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { createFailoverRecord, noteProxyError, planFailover } from '../src/lib/failover.js';
import {
  FAILOVER_KEY,
  SERVER_HEALTH_KEY,
  STATUS_KEY,
  ensureState,
  loadFailover,
  loadServerHealth,
  loadState,
  loadStatus,
  sameApplyStatus,
  sanitizeApplyStatus,
  saveState,
  saveStatus,
  subscribe,
  subscribeServerHealth,
  subscribeStatus,
  updateFailover,
  updateServerHealth,
  updateState,
} from '../src/lib/storage.js';
import { noteServerHealth } from '../src/lib/server-health.js';

/**
 * `chrome.storage.local` in memory, so the module's promise wrappers (and the
 * write queue around them) can be exercised exactly as they run in Chrome.
 */
function fakeChrome() {
  const data = new Map();
  const listeners = new Set();
  const writes = [];

  const emit = (changes) => {
    for (const listener of [...listeners]) listener(changes, 'local');
  };

  const area = {
    get: async (keys) => {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      const picked = {};
      for (const key of list) if (data.has(key)) picked[key] = structuredClone(data.get(key));
      return picked;
    },
    set: async (items) => {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: structuredClone(value) };
        data.set(key, structuredClone(value));
      }
      writes.push(Object.keys(items));
      emit(changes);
    },
  };

  globalThis.chrome = {
    storage: {
      local: area,
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };

  return { data, listeners, writes };
}

test('two quick changes both survive', async () => {
  const { writes } = fakeChrome();
  await saveState(createDefaultState());

  // Both start before either has finished, exactly like two fast clicks.
  await Promise.all([
    updateState((draft) => {
      draft.settings.enabled = false;
    }),
    updateState((draft) => {
      draft.settings.bypassList = ['*.internal.example.com'];
    }),
  ]);

  const state = await loadState();
  assert.equal(state.settings.enabled, false, 'the first change was lost');
  assert.deepEqual(state.settings.bypassList, ['*.internal.example.com'], 'the second change was lost');
  assert.equal(writes.length, 3, 'every update is written exactly once');
});

test('a rejected update does not block the ones queued behind it', async () => {
  fakeChrome();
  await saveState(createDefaultState());

  const failing = updateState(() => {
    throw new Error('boom');
  });
  const following = updateState((draft) => {
    draft.settings.mode = 'pac_script';
  });

  await assert.rejects(failing, /boom/);
  await following;
  assert.equal((await loadState()).settings.mode, 'pac_script');
});

test('a read-modify-write round trip returns the sanitized state', async () => {
  fakeChrome();
  await saveState(createDefaultState());

  const saved = await updateState((draft) => {
    draft.settings.theme = 'dark';
    draft.settings.pacUrl = '   https://example.com/proxy.pac   ';
  });

  assert.equal(saved.settings.theme, 'dark');
  assert.equal(saved.settings.pacUrl, 'https://example.com/proxy.pac');
  assert.deepEqual(await loadState(), saved, 'the write must not alias the returned object');
});

test('ensureState seeds defaults once and keeps them', async () => {
  fakeChrome();

  const seeded = await ensureState();
  assert.deepEqual(seeded, createDefaultState());

  await updateState((draft) => {
    draft.settings.language = 'fa';
  });
  assert.equal((await ensureState()).settings.language, 'fa', 'ensureState must not reset a real state');
});

test('state subscriptions fire for the state key only', async () => {
  fakeChrome();
  await saveState(createDefaultState());

  const seen = [];
  const stop = subscribe((next) => seen.push(next));

  await updateState((draft) => {
    draft.settings.language = 'fa';
  });
  await saveStatus({ ok: true, failed: null, levelOfControl: null });

  assert.equal(seen.length, 1, 'the apply status must not look like a state change');
  assert.equal(seen[0].settings.language, 'fa');
  assert.equal(seen[0].version, createDefaultState().version);

  stop();
  await updateState((draft) => {
    draft.settings.language = 'en';
  });
  assert.equal(seen.length, 1, 'unsubscribing must stop the updates');
});

test('the apply status survives a round trip, and repeats are not rewritten', async () => {
  const { writes } = fakeChrome();
  const seen = [];
  const stop = subscribeStatus((status) => seen.push(status));

  const status = { ok: false, failed: 'net::ERR_PROXY_CONNECTION_FAILED', levelOfControl: null };
  await saveStatus(status);
  assert.deepEqual(await loadStatus(), { ...status, at: 0 });

  // the same problem (a burst of onProxyError events) must not write again
  await saveStatus({ ...status, at: Date.now() });
  assert.equal(seen.length, 1);
  assert.equal(writes.length, 1);

  // a different one does
  await saveStatus({ ok: false, failed: 'timeout', levelOfControl: 'controlled_by_this_extension' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].failed, 'timeout');

  stop();
  await saveStatus({ ok: true, failed: null, levelOfControl: 'controlled_by_this_extension' });
  assert.equal(seen.length, 2, 'unsubscribing must stop the updates');
  assert.equal((await loadStatus()).ok, true);
});

test('the apply status rejects garbage instead of trusting it', async () => {
  const { data } = fakeChrome();

  assert.equal(sanitizeApplyStatus(null), null);
  assert.equal(sanitizeApplyStatus('nonsense'), null);
  assert.deepEqual(sanitizeApplyStatus({ ok: 'yes', at: 'later' }), {
    ok: false,
    failed: null,
    levelOfControl: null,
    at: 0,
  });
  assert.deepEqual(sanitizeApplyStatus({ ok: true, failed: 42, levelOfControl: 7, at: 5 }), {
    ok: true,
    failed: null,
    levelOfControl: null,
    at: 5,
  });

  assert.equal(await loadStatus(), null, 'nothing stored yet');
  data.set(STATUS_KEY, 'nonsense');
  assert.equal(await loadStatus(), null, 'a broken value is treated as no status');

  assert.equal(sameApplyStatus(null, null), true);
  assert.equal(sameApplyStatus(null, { ok: true }), false);
  assert.equal(sameApplyStatus({ ok: false, failed: 'x' }, { ok: false, failed: 'x', at: 99 }), true);
  assert.equal(sameApplyStatus({ ok: false, failed: 'x' }, { ok: false, failed: 'y' }), false);
  assert.equal(
    sameApplyStatus({ ok: true }, { ok: true, levelOfControl: 'controlled_by_other_extensions' }),
    false,
  );
});

test('outside the extension everything degrades to defaults', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    assert.deepEqual(await loadState(), createDefaultState());
    assert.equal(await loadStatus(), null);
    await saveState(createDefaultState());
    // nothing is stored, but the caller still gets back what would have been stored
    assert.deepEqual(await saveStatus({ ok: true }), {
      ok: true,
      failed: null,
      levelOfControl: null,
      at: 0,
    });
    assert.equal(typeof subscribe(() => {}), 'function');
    assert.equal(typeof subscribeStatus(() => {}), 'function');
    assert.deepEqual(await updateState((draft) => {
      draft.settings.mode = 'direct';
    }), sanitizeState({ settings: { mode: 'direct' } }));
  } finally {
    globalThis.chrome = previous;
  }
});

test('the whole state still fits in one key', async () => {
  const { data } = fakeChrome();
  await updateState((draft) => {
    draft.profiles = [{ id: 'p1', name: 'Work', scheme: 'socks5', host: 'proxy.example.com', port: 1080 }];
  });
  assert.deepEqual([...data.keys()], [STORAGE_KEY]);
});

test('the failover record lives outside the state and survives a round trip', async () => {
  const { data, writes } = fakeChrome();

  assert.deepEqual(await loadFailover(), createFailoverRecord());

  const profiles = [
    { id: 'a', name: 'A', scheme: 'http', host: 'a.example.com', port: 8080 },
    { id: 'b', name: 'B', scheme: 'http', host: 'b.example.com', port: 8080 },
  ];
  const context = { now: 1_700_000_000_000, activeProfileId: 'a', profiles };

  assert.equal(await updateFailover((draft) => noteProxyError(draft, context)), false);
  assert.equal(await updateFailover((draft) => noteProxyError(draft, { ...context, now: context.now + 1 })), false);
  assert.equal(
    await updateFailover((draft) => noteProxyError(draft, { ...context, now: context.now + 2 })),
    true,
    'the streak is long enough to confirm with a probe',
  );
  assert.equal((await loadFailover()).strikes, 3);
  assert.ok(data.has(FAILOVER_KEY), 'the record has its own key');
  assert.ok(!data.has(STORAGE_KEY), 'and must not be written into the state');

  // once the streak is complete, a burst of further errors writes nothing
  const writesBefore = writes.length;
  assert.equal(
    await updateFailover((draft) => noteProxyError(draft, { ...context, now: context.now + 50 })),
    true,
  );
  assert.equal(writes.length, writesBefore, 'an unchanged record must not be rewritten');

  // two queued read-modify-writes both survive, like two quick clicks
  await Promise.all([
    updateFailover((draft) => planFailover(draft, { ...context, now: context.now + 60 })),
    updateFailover((draft) => noteProxyError(draft, { ...context, activeProfileId: 'b' })),
  ]);
  const record = await loadFailover();
  assert.equal(record.lastSwitchTo, 'b', 'the switch was applied');
  assert.equal(record.strikes, 1, 'the queued update started from the record the first one left');
});

test('the health record has its own key, its own queue and its own subscribers', async () => {
  const { data, writes } = fakeChrome();

  assert.deepEqual(await loadServerHealth(), {}, 'nothing known yet');

  const seen = [];
  const stop = subscribeServerHealth((next) => seen.push(next));

  await updateServerHealth((draft) => noteServerHealth(draft, { id: 'a', ok: true, at: 1000, ms: 90 }));
  assert.deepEqual(await loadServerHealth(), { a: { ok: true, at: 1000, ms: 90 } });
  assert.ok(data.has(SERVER_HEALTH_KEY), 'the verdicts have their own key');
  assert.ok(!data.has(STORAGE_KEY), 'and must not be written into the state');
  assert.equal(seen.length, 1, 'a new verdict is a change worth reacting to');

  // the same verdict again is not a change, so nothing is rewritten or notified
  const writesBefore = writes.length;
  await updateServerHealth((draft) => noteServerHealth(draft, { id: 'a', ok: true, at: 1000, ms: 90 }));
  assert.equal(writes.length, writesBefore, 'an unchanged verdict must not be rewritten');
  assert.equal(seen.length, 1);

  stop();
  await updateServerHealth((draft) => noteServerHealth(draft, { id: 'b', ok: false, at: 2000 }));
  assert.equal(seen.length, 1, 'unsubscribed');
  assert.deepEqual(await loadServerHealth(), {
    a: { ok: true, at: 1000, ms: 90 },
    b: { ok: false, at: 2000, ms: null },
  });
});

test('the failover record degrades to defaults outside the extension', async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = undefined;
  try {
    assert.deepEqual(await loadFailover(), createFailoverRecord());
    const decision = await updateFailover((draft) => {
      draft.strikes = 2;
      return 'decision';
    });
    assert.equal(decision, 'decision', 'the mutator decides what the call answers');
  } finally {
    globalThis.chrome = previous;
  }
});
