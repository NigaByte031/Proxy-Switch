/*
 * Offline preview harness (development only — excluded from release builds).
 *
 * The `src/__preview_*.html` pages are generated copies of the real ones with one
 * extra <script> tag that loads this file: opening them in a browser tab gives the
 * full UI with the handful of `chrome.*` APIs it uses mocked over localStorage.
 */
(function installChromeStub() {
  // a real extension context: do nothing
  if (globalThis.chrome?.storage) return;

  // kept in sync with manifest.json by tests/manifest.test.mjs
  var VERSION = '1.7.0';
  var DATA_KEY = 'proxySwitch.preview.data';
  var PROXY_KEY = 'proxySwitch.preview.proxy';

  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(DATA_KEY) || '{}');
    } catch (error) {
      return {};
    }
  }

  function writeAll(data) {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  }

  var listeners = new Set();
  var messageListeners = new Set();

  function emit(changes, areaName) {
    for (var listener of Array.from(listeners)) {
      try {
        listener(changes, areaName);
      } catch (error) {
        console.error('[preview] storage listener failed', error);
      }
    }
  }

  function pick(data, keys) {
    if (keys == null) return { ...data };
    if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
    if (Array.isArray(keys)) {
      var picked = {};
      for (var key of keys) if (key in data) picked[key] = data[key];
      return picked;
    }
    // object form: use its values as defaults
    var result = { ...keys };
    for (var name of Object.keys(keys)) if (name in data) result[name] = data[name];
    return result;
  }

  globalThis.chrome = {
    runtime: {
      id: 'preview',
      lastError: null,
      getManifest: function () {
        return { manifest_version: 3, name: 'Proxy Switch', version: VERSION };
      },
      getURL: function (path) {
        return new URL(path, location.href).href;
      },
      openOptionsPage: function () {
        window.open('./__preview_options.html', '_blank', 'noopener');
      },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} },
      onMessage: {
        addListener: function (listener) {
          messageListeners.add(listener);
        },
        removeListener: function (listener) {
          messageListeners.delete(listener);
        },
      },
      sendMessage: async function (message) {
        // No service worker runs in the preview, so "Try again" plays its part:
        // it answers with a healthy status and clears the failure on screen.
        if (!message || message.type !== 'proxy-switch:reapply') {
          if (message && message.type === 'proxy-switch:test-all') return simulateTestAllPass();
          return undefined;
        }
        var status = {
          ok: true,
          failed: null,
          levelOfControl: 'controlled_by_this_extension',
          at: Date.now(),
        };
        await globalThis.chrome.storage.local.set({ proxySwitchApplyStatus: status });
        return { status: status };
      },
    },
    storage: {
      local: {
        get: async function (keys) {
          return pick(readAll(), keys);
        },
        set: async function (items) {
          var data = readAll();
          var changes = {};
          for (var key of Object.keys(items)) {
            changes[key] = { oldValue: data[key], newValue: items[key] };
            data[key] = items[key];
          }
          writeAll(data);
          emit(changes, 'local');
        },
        remove: async function (keys) {
          var data = readAll();
          var list = Array.isArray(keys) ? keys : [keys];
          var changes = {};
          for (var key of list) {
            if (!(key in data)) continue;
            changes[key] = { oldValue: data[key] };
            delete data[key];
          }
          writeAll(data);
          emit(changes, 'local');
        },
        clear: async function () {
          localStorage.removeItem(DATA_KEY);
          emit({}, 'local');
        },
      },
      onChanged: {
        addListener: function (listener) {
          listeners.add(listener);
        },
        removeListener: function (listener) {
          listeners.delete(listener);
        },
      },
    },
    proxy: {
      settings: {
        get: async function () {
          try {
            return { value: JSON.parse(localStorage.getItem(PROXY_KEY) || 'null') };
          } catch (error) {
            return { value: null };
          }
        },
        set: async function (details) {
          if (!details || details.scope === 'incognito_persistent') return;
          localStorage.setItem(PROXY_KEY, JSON.stringify(details.value));
        },
        clear: async function () {
          localStorage.removeItem(PROXY_KEY);
        },
      },
      onProxyError: { addListener: function () {} },
    },
    action: {
      // Chrome 127+ only; the preview pretends to have it so the path can be tried.
      openPopup: async function () {
        window.open('./__preview_popup.html', '_blank', 'noopener');
      },
      setBadgeText: async function () {},
      setBadgeBackgroundColor: async function () {},
      setTitle: async function () {},
      setIcon: async function () {},
    },
    contextMenus: {
      create: function () {},
      removeAll: async function () {},
      onClicked: { addListener: function () {} },
    },
    notifications: {
      create: async function (id, options) {
        console.info('[preview] notification', id, options);
      },
      clear: async function () {},
      onClicked: { addListener: function () {} },
      onButtonClicked: { addListener: function () {} },
    },
    webRequest: {
      onAuthRequired: { addListener: function () {} },
    },
    tabs: {
      create: function (options) {
        window.open(options.url, '_blank', 'noopener');
      },
    },
    i18n: { getMessage: function (key) { return key; } },
  };

  /*
   * The worker's "Test all servers" pass is simulated too: the same policy the real
   * one applies (`testAllEligible` — manual mode or domain routing, with its
   * requirements in force), one progress message per saved server (the latency of
   * the probe hook decides ok/down), into the same health key the real worker
   * writes.
   */
  var TEST_ALL_MESSAGE = 'proxy-switch:test-all';
  var TEST_ALL_PROGRESS_MESSAGE = 'proxy-switch:test-all-progress';
  var HEALTH_KEY = 'proxySwitchServerHealth';
  var MODES_WITH_ROUTING = ['fixed_servers', 'pac_script'];

  function testAllEligible(state) {
    if (!state || !state.settings) return false;
    var settings = state.settings;
    if (!settings.enabled) return false;
    var mode = settings.mode;
    if (MODES_WITH_ROUTING.indexOf(mode) === -1) return false;
    if (mode === 'pac_script' && settings.domainRouting !== true) return false;
    if (!settings.activeProfileId) return false;
    if (mode === 'pac_script' && !(settings.proxyDomains || []).length) return false;
    return true;
  }

  function simulateTestAllPass() {
    var profiles = ((readAll().proxySwitchState || {}).profiles) || [];
    if (profiles.length === 0) return { started: false };
    var state = readAll().proxySwitchState;
    if (!testAllEligible(state)) return { started: false };

    var index = 0;
    var timer = setInterval(function () {
      if (index >= profiles.length) {
        clearInterval(timer);
        return;
      }
      var profile = profiles[index];
      index += 1;
      // one in seven is down
      var ok = (SIMULATED_LATENCY_MS + profile.port) % 7 !== 0;
      var merged = readAll();
      var record = merged[HEALTH_KEY] || {};
      record[profile.id] = {
        ok: ok,
        at: Date.now(),
        ms: ok ? SIMULATED_LATENCY_MS + Math.floor(Math.random() * 60) : null,
      };
      merged[HEALTH_KEY] = record;
      writeAll(merged);
      var message = {
        type: TEST_ALL_PROGRESS_MESSAGE,
        done: index,
        total: profiles.length,
        ok: ok,
      };
      for (var listener of Array.from(messageListeners)) {
        try {
          listener(message);
        } catch (error) {
          console.error('[preview] message listener failed', error);
        }
      }
    }, SIMULATED_LATENCY_MS + 120);

    return { started: true, total: profiles.length };
  }

  /*
   * The "Test connection" button really calls fetch(), which a file:// preview
   * cannot do cross-origin, so the preview answers with a simulated result.
   */
  var SIMULATED_LATENCY_MS = 180;
  globalThis.__proxySwitchProbeFetch = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ status: 204, ok: true, type: 'basic' });
      }, SIMULATED_LATENCY_MS);
    });
  };

  /*
   * A demo seed, for pictures and for poking at the UI: `?demo=1` (or `?demo=fa`)
   * fills the stores with a plausible setup — three servers with verdicts, today's
   * counters, a speed that keeps moving — before the page's own scripts read them.
   * Nothing here runs unless it is asked for.
   */
  var demo = new URLSearchParams(location.search).get('demo');
  if (demo) seedDemo(demo === 'fa' ? 'fa' : 'en');

  function seedDemo(language) {
    var now = Date.now();
    var MB = 1024 * 1024;
    var GB = 1024 * MB;
    var minutesAgo = function (minutes) {
      return now - minutes * 60 * 1000;
    };
    var date = new Date(now);
    var day =
      date.getFullYear() +
      '-' +
      String(date.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(date.getDate()).padStart(2, '0');

    globalThis.chrome.storage.local.set({
      proxySwitchState: {
        version: 1,
        settings: {
          enabled: true,
          mode: 'fixed_servers',
          activeProfileId: 'demo-frankfurt',
          backgroundProbe: true,
          trafficMeter: true,
          language: language,
          theme: 'auto',
          accent: 'emerald',
        },
        profiles: [
          {
            id: 'demo-frankfurt',
            name: 'Frankfurt',
            scheme: 'https',
            host: 'de1.example.net',
            port: 8443,
            username: 'demo',
            password: '',
          },
          {
            id: 'demo-amsterdam',
            name: 'Amsterdam',
            scheme: 'socks5',
            host: 'nl1.example.net',
            port: 1080,
            username: '',
            password: '',
          },
          {
            id: 'demo-backup',
            name: 'Backup',
            scheme: 'http',
            host: 'backup.example.net',
            port: 3128,
            username: '',
            password: '',
          },
        ],
      },
      proxySwitchApplyStatus: {
        ok: true,
        failed: null,
        levelOfControl: 'controlled_by_this_extension',
        at: now,
      },
      proxySwitchServerHealth: {
        'demo-frankfurt': { ok: true, at: minutesAgo(2), ms: 42 },
        'demo-amsterdam': { ok: true, at: minutesAgo(6), ms: 118 },
        'demo-backup': { ok: false, at: minutesAgo(11), ms: null },
      },
      proxySwitchTraffic: {
        day: day,
        up: 48.3 * MB,
        down: 2.4 * GB,
        upTotal: 1.6 * GB,
        downTotal: 41.2 * GB,
        since: now - 30 * 24 * 60 * 60 * 1000,
        at: now,
      },
      proxySwitchTrafficRate: {
        samples: [{ at: now, ms: 1000, up: 120 * 1024, down: 4.6 * MB }],
      },
    });

    // A reading has to keep moving to look like itself, so the demo feeds the
    // window a fresh sample every second — the shape the worker writes.
    var tick = 0;
    setInterval(function () {
      tick += 1;
      var at = Date.now();
      var held = (readAll().proxySwitchTrafficRate || {}).samples || [];
      var samples = held.filter(function (entry) {
        return at - entry.at <= 8000;
      });
      var wobble = 1 + 0.15 * Math.sin(tick / 3);
      samples.push({
        at: at,
        ms: 1000,
        up: Math.round(120 * 1024 * wobble),
        down: Math.round(4.6 * MB * wobble),
      });
      globalThis.chrome.storage.local.set({ proxySwitchTrafficRate: { samples: samples } });
    }, 1000);
  }

})();
