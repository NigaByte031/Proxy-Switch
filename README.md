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
  Pasting `https://user:pass@host:8080/path` fills the fields for you.
- **Proxy authentication** — optional automatic answers to proxy login prompts, only for the
  server you are actually using.
- **Bypass list** — one rule per line (`<local>`, `localhost`, `*.internal.example.com`, …).
- **Master switch** — instantly go direct without losing the mode you configured.
- **Context menu** — right-click the toolbar icon to switch mode or server.
- **Live badge** — the toolbar icon shows `SYS`, `ON`, `PAC`, `OFF` or `ERR`.
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
git clone https://github.com/your-username/proxy-switch.git
cd proxy-switch
npm run package     # writes dist/proxy-switch-v1.0.0.zip (optional)
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
4. The ⚙ button (or `chrome://extensions` → Details → Extension options) opens the settings page,
   where you manage servers, the bypass list, the language and JSON backups.

If a mode has nothing to work with (no server selected, empty PAC URL) the extension **fails open**:
traffic goes direct and the popup shows a warning instead of leaving you without a connection.

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

## Before you publish

This template ships with placeholders that you should replace:

- [ ] `your-username` in `manifest.json` (`homepage_url`) and in this README's clone URL.
- [ ] The copyright holder in [LICENSE](LICENSE).
- [ ] `npm run package`, then upload `dist/proxy-switch-v1.0.0.zip` in the Chrome Web Store
      developer dashboard (a 128×128 icon is already included; screenshots can be taken from the
      preview pages).
- [ ] Add real screenshots to `docs/` if you want them in this README.

## Roadmap ideas

- Proxy health check ("test this server") straight from the popup.
- Rules per domain, so one site uses one server and everything else another.
- Import from common formats (`SwitchyOmega` backups).
- Firefox build (WebExtensions `browser.proxy` has the same shape).

## License

[MIT](LICENSE)
