# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

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
