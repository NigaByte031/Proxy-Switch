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

  var VERSION = '1.0.0'; // kept in sync with manifest.json by tests/manifest.test.mjs
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

  function mountRibbon() {
    if (!document.body) return;
    var ribbon = document.createElement('div');
    ribbon.textContent = 'PREVIEW MODE';
    ribbon.title =
      'Offline preview: the chrome.* APIs are mocked and data is kept in localStorage.';
    ribbon.setAttribute('aria-hidden', 'true');
    ribbon.style.cssText = [
      'position:fixed',
      'inset-block-end:8px',
      'inset-inline-end:8px',
      'z-index:99',
      'padding:4px 9px',
      'border-radius:999px',
      'font:600 10px/1.4 system-ui,sans-serif',
      'letter-spacing:.06em',
      'color:#4f46e5',
      'background:rgba(79,70,229,.12)',
      'border:1px solid rgba(79,70,229,.35)',
      'pointer-events:none',
    ].join(';');
    document.body.append(ribbon);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountRibbon);
  } else {
    mountRibbon();
  }
})();
