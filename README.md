# Proxy Switch

![CI](../../actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/manifest-v3-informational)

A small, dependency-free Chrome extension (Manifest V3) that switches the browser proxy in one
click: **system**, **direct**, **manual HTTP/HTTPS/SOCKS** or **PAC script**. The whole UI is
bilingual — English and Persian (فارسی) with full RTL support — and everything runs locally.

[فارسی](README.fa.md)

## Features

- **Four modes in one click** — system proxy, direct (no proxy), a saved server, or a PAC script.
- **Saved servers** — name, scheme (HTTP/HTTPS/SOCKS4/SOCKS5), host, port, optional credentials.
  Paste a whole proxy URL (`socks5://user:pass@127.0.0.1:1080`, or just `host:8080`) into the Host
  field and scheme, host, port and credentials fill themselves.
- **Proxy authentication** — optional automatic answers to proxy login prompts, only for the
  server you are actually using.
- **Bypass list** — one rule per line (`<local>`, `localhost`, `*.internal.example.com`, …).
- **Master switch** — instantly go direct without losing the mode you configured.
- **Context menu** — right-click the toolbar icon to switch mode or server.
- **Live badge** — the toolbar icon shows `SYS`, `ON`, `PAC`, `OFF` or `ERR`, and the popup repeats
  it as a pill next to the status text.
- **Connection test** — one click tells you whether traffic really flows, through which host and
  how many milliseconds it took.
- **Keyboard shortcuts** — `Alt+Shift+P` turns the proxy on or off, `Alt+Shift+D` goes direct.
- **Bilingual UI** — switch language from the popup; Persian is rendered RTL.
- **Backup & restore** — export/import the whole configuration as JSON.
- **No analytics, no network calls, no remote code.** See [PRIVACY.md](PRIVACY.md).

## Install

### From a release (recommended)

1. Download `proxy-switch-vX.Y.Z.zip` from the [releases page](../../releases).
2. Unzip it somewhere permanent.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the
   unzipped folder.

### From source

```bash
git clone https://github.com/mohammadyazdani031/ProxyControler.git
cd ProxyControler
npm run package     # writes dist/proxy-switch-v1.1.0.zip (optional)
```

Then load the repository folder itself with **Load unpacked** — the manifest points at `src/`, so
no build step is required.

### Try the UI without installing

`src/__preview_popup.html` and `src/__preview_options.html` are generated copies of the real pages
with a mocked `chrome.*` API (backed by `localStorage`). Open either file in any browser tab to
click through the interface — no extension install, no Chrome needed.

```bash
npm run preview          # regenerate them after editing popup.html/options.html
npm run preview -- --check   # verify they are in sync
```

## Usage

| Mode | What Chrome does |
| --- | --- |
| **System** | Follows the proxy configured in your operating system. |
| **Direct** | No proxy at all — everything connects directly. |
| **Manual** | Routes every request through the server you select. |
| **PAC** | Downloads a proxy auto-config script and obeys it. |

1. Open the popup from the toolbar.
2. Pick a mode, or add a server and click it — clicking a server switches to it immediately.
3. Flip the master switch off to go direct temporarily; your mode is remembered.
4. Press **Test connection** when you want proof: it sends one tiny request through the mode that is
   currently applied and reports the host that answered and the round-trip time. Hover the result to
   see the raw reason when it fails.
5. The ⚙ button (or `chrome://extensions` → Details → Extension options) opens the settings page,
   where you manage servers, the bypass list, the language and JSON backups.

If a mode has nothing to work with (no server selected, empty PAC URL) the extension **fails open**:
traffic goes direct and the popup shows a warning instead of leaving you without a connection.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+P` | Turn the proxy on or off (the master switch). |
| `Alt+Shift+D` | Go direct without forgetting the configured mode. |

Chrome may report a shortcut as unassigned if another extension already owns it; you can always
rebind both on `chrome://extensions/shortcuts`.

## Permissions

| Permission | Why |
| --- | --- |
| `proxy` | Change the browser's proxy configuration — the entire point of the extension. |
| `storage` | Keep your servers, credentials and settings in `chrome.storage.local`. |
| `webRequest` + `webRequestAuthProvider` | Answer proxy `407` challenges with the saved credentials of the active server (Manifest V3 supports blocking listeners for `onAuthRequired` only). |
| `contextMenus` | The right-click menu on the toolbar icon. |
| `<all_urls>` | Required to route traffic and to see proxy authentication challenges. |

The extension has **no content scripts** and injects nothing into pages.

## Development

Requirements: Node.js 20+ (only for the tests, the preview generator and packaging — the extension
itself has zero dependencies and no build step).

```bash
npm test                 # unit tests (state, proxy config, i18n coverage, manifest, zip writer)
npm run preview          # regenerate the offline preview pages
npm run package          # build dist/proxy-switch-v<version>.zip for the Web Store
```

Project layout:

```
manifest.json               MV3 manifest
icons/                      16/32/48/128 px icons
src/
  background.js             service worker: applies the proxy, badge, menus, auth
  popup.html|js             toolbar popup
  options.html|js           settings page
  lib/
    model.js                state shape, validation, import/export (pure, tested)
    proxy.js                builds the chrome.proxy config + status text (pure, tested)
    health.js               connection probe: timing and verdict (pure, tested)
    health-ui.js            the shared "Test connection" control
    storage.js              chrome.storage.local wrapper
    i18n.js                 English/Persian dictionaries, RTL helpers (pure, tested)
    mode-ui.js              shared mode chips + PAC row
    servers-ui.js           shared server list + form
  styles/                   base design tokens, popup, options
  __preview_*.html          generated offline previews (not shipped)
tests/                      node --test suites
tools/                      preview generator + dependency-free zip packager
```

Design decisions worth knowing:

- **One writer.** The popup and settings page only write state; the service worker is the only code
  that calls `chrome.proxy.settings.set`, so there is a single place where the proxy is applied.
- **Credentials never sync.** Everything lives in `chrome.storage.local`, never `chrome.storage.sync`.
- **Pure logic is separated** from the Chrome APIs (`lib/model.js`, `lib/proxy.js`, `lib/i18n.js`)
  so it can be unit tested in plain Node.

## Publishing

- [ ] `npm run package`, then upload `dist/proxy-switch-v1.1.0.zip` from the Chrome Web Store
      developer dashboard (a 128×128 icon is already included; screenshots can be taken from the
      preview pages).
- [ ] Tag the release — `git tag v1.1.0 && git push origin v1.1.0`. The
      [release workflow](.github/workflows/release.yml) refuses a tag that does not match
      `manifest.json`, runs the tests and attaches the ZIP to the GitHub release.
- [ ] Add real screenshots to `docs/` if you want them in this README.

## Roadmap ideas

- Rules per domain, so one site uses one server and everything else another.
- Automatic failover: try the next saved server when the active one stops answering.
- Import from common formats (`SwitchyOmega` backups).
- Firefox build (WebExtensions `browser.proxy` has the same shape).

## License

[MIT](LICENSE)
