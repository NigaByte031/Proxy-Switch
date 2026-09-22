/*
 * Offline preview harness (development only — excluded from release builds).
 *
 * `src/__preview_popup.html` and `src/__preview_options.html` are generated
 * copies of the real pages with one extra <script> tag that loads this file.
 * Opening them in a normal browser tab gives you the full UI with the handful
 * of `chrome.*` APIs it uses mocked on top of localStorage, so the extension
 * can be tried (and screenshotted) without installing it.
 */
(function installChromeStub() {
  if (globalThis.chrome?.storage) return; // a real extension context: do nothing

  var VERSION = '1.2.0'; // kept in sync with manifest.json by tests/manifest.test.mjs
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
      onMessage: { addListener: function () {} },
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
   * The "Test connection" button really calls fetch(), which a file:// preview
   * cannot do cross-origin — so the preview answers with a simulated result.
   * `src/lib/health.js` prefers this hook over the real fetch when it exists.
   */
  var SIMULATED_LATENCY_MS = 180;
  globalThis.__proxySwitchProbeFetch = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ status: 204, ok: true, type: 'basic' });
      }, SIMULATED_LATENCY_MS);
    });
  };

})();
