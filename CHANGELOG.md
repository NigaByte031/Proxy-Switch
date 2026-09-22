# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [1.2.0] — 2026-09-22

You can now pick the theme instead of living with whatever the system says, and the interface was
re-painted around a single palette.

### Added

- **Theme setting** — *automatic*, *light* or *dark*. Choose it on the settings page next to the
  language, or click the new ◐ button in the popup to cycle through the three options without
  leaving the popup. *Automatic* follows your operating system and keeps following it while a page
  stays open.
- `src/lib/theme.js` — pure theme resolution (`resolveTheme`, `nextTheme`, `applyTheme`) and the
  system-preference watcher, plus `tests/theme.test.mjs`, which also pins the light and dark palettes
  in `base.css` to each other.

### Changed

- The dark palette is now selected by `data-theme` on `<html>` instead of a `prefers-color-scheme`
  media query, so an explicit choice always beats the system and both pages can never disagree
  about which theme is showing. `color-scheme` keeps the native controls in step.
- The whole interface was re-painted around one emerald → teal palette: the popup's status card
  wears the colour of the active mode and turns amber when something is missing, each server row
  carries a badge for its scheme (HTTP / SOCKS5 / …), and the header and footer freeze while a long
  server list scrolls underneath them.
- The PAC field moved directly under the mode chips in the popup, so it is never off-screen; the
  settings page grew a hero header and reports saves through a floating toast.
- Both READMEs document the theme setting, and version references now read `1.2.0`.

[1.2.0]: ../../releases/tag/v1.2.0

## [1.1.0] — 2026-09-21

You can now trust the current setting at a glance instead of guessing.

### Added

- **Test connection** in the popup and on the settings page: one click sends a tiny request through
  the mode that is currently applied and reports the host that answered and the round-trip time.
  When it fails, the raw reason (e.g. `net::ERR_PROXY_CONNECTION_FAILED` or `timeout`) is available
  as a tooltip, and both probe hosts are tried before giving up.
- Keyboard shortcuts: `Alt+Shift+P` turns the proxy on or off, `Alt+Shift+D` goes direct without
  forgetting the configured mode. Both can be rebound on `chrome://extensions/shortcuts`.
- The popup's status card repeats the toolbar badge as a `SYS` / `ON` / `PAC` / `OFF` pill, so the
  icon explains itself without a trip to the settings page.
- Paste-aware server form: dropping a whole proxy URL (`socks5://user:pass@127.0.0.1:1080`, or just
  `host:8080`) into the Host field fills the scheme, host, port and credentials in one go.
- Shortcut hint and the version in the popup footer; the header and footer now stay put while a long
  server list scrolls underneath them.
- `src/lib/health.js` (pure probe logic, tested) and `src/lib/health-ui.js` (the shared control).

### Changed

- `manifest.json` (`homepage_url`), `README.md`, `README.fa.md`, `CONTRIBUTING.md` and the issue
  template now point at the real repository instead of the template placeholder, and the copyright
  holder is filled in.
- Both READMEs document the connection test and the shortcuts; the settings page shows them in its
  About card.
- The master switch and the language button have accessible names, and the toolbar badge logic moved
  into `describeBadge()` so the icon and the popup can never disagree.
- The offline preview pages no longer draw a "PREVIEW MODE" badge.

[1.1.0]: ../../releases/tag/v1.1.0

## [1.0.0] — 2026-09-21

First public release.

### Added

- Manifest V3 extension with a toolbar popup and a full settings page.
- Four proxy modes: system, direct, manual server, and PAC script.
- Server manager (HTTP/HTTPS/SOCKS4/SOCKS5) with names, ports and optional credentials.
- Automatic answers to proxy authentication prompts for the active server (can be switched off).
- Bypass list editor (one rule per line, including `<local>` and wildcard patterns).
- Master switch that goes direct without forgetting the configured mode.
- Toolbar icon context menu for switching mode or server, plus a status badge
  (`SYS` / `ON` / `PAC` / `OFF` / `ERR`).
- Bilingual UI (English + Persian) with live switching and RTL layout.
- JSON export/import and a full reset.
- Offline preview pages (`src/__preview_*.html`) that mock the `chrome.*` APIs, so the UI can be
  reviewed in any browser without installing the extension.
- Unit tests for the state layer, proxy configuration, translation coverage, manifest integrity and
  the dependency-free ZIP packager; GitHub Actions for CI and tagged releases.

### Notes

- Requires Chrome 116 or newer (Manifest V3 blocking `onAuthRequired` listeners).
- Credentials are stored in `chrome.storage.local` only, never synced through your Google account.

[1.0.0]: ../../releases/tag/v1.0.0
