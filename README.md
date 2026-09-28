# Proxy Switch

![CI](../../actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/manifest-v3-informational)

A small, dependency-free Chrome extension (Manifest V3) that switches the browser proxy in one
click: **system**, **direct**, **manual HTTP/HTTPS/SOCKS** or **PAC script**. The whole UI is
bilingual — English and Persian (فارسی) with full RTL support — and everything runs locally.

[فارسی](README.fa.md)

## Screenshots

<img src="docs/screenshots/popup.png" width="380" alt="The popup: the master switch, the server in use, today's traffic and the live speed">

<img src="docs/screenshots/settings.png" width="780" alt="The settings page: proxy mode, the traffic meter with the live speed, and the servers with their last verdicts">

Both pages open without installing anything — see
[Try the UI without installing](#try-the-ui-without-installing) — and these pictures are taken from
them by `npm run shots`, so they are the interface itself rather than a drawing of it.

## Features

- **Four modes in one click** — system proxy, direct (no proxy), a saved server, or a PAC script.
- **Saved servers** — name, scheme (HTTP/HTTPS/SOCKS4/SOCKS5), host, port, optional credentials.
  Paste a whole proxy URL (`socks5://user:pass@127.0.0.1:1080`, or just `host:8080`) into the Host
  field and scheme, host, port and credentials fill themselves.
- **Server search** — a search box appears above the list once it grows past four servers, and `/`
  jumps to it from anywhere in the popup. Deleting a server is confirmed inside the row rather
  than by a blocking dialog, so the popup never loses its place.
- **Proxy authentication** — optional automatic answers to proxy login prompts, only for the
  server you are actually using.
- **Automatic failover** — when the active server stops answering, the extension checks the
  connection once more and, if the server really is down, switches to the next server in your list.
  One round visits every server once and then stops, so a network outage cannot make it flip back
  and forth. Toggle it on the settings page (it defaults to on).
- **Switch notification** — an automatic switch is never silent: a system notification names the
  server that took over, and the toolbar icon wears its name for a few seconds. Clicking it opens
  your server list, and its **Back to …** button undoes the switch. Only switches the extension makes
  on its own are announced, and the notification can be switched off on the settings page.
- **Domain routing** — in PAC mode, tick *Route only the sites I list* and give it one domain per
  line: those sites and their subdomains go through your servers — the active one first, the others as
  fallback — while everything else stays direct. The list is compiled into a PAC script inside the
  extension — nothing to host, nothing to download — and a listed site is never sent direct, so a
  server that is down fails loudly instead of leaking it. The fallback chain follows what the
  extension has *seen*: a server that recently answered is tried before one nobody has looked at,
  and one that recently failed goes last.
- **Bypass list** — one rule per line (`<local>`, `localhost`, `*.internal.example.com`, …).
- **Master switch** — instantly go direct without losing the mode you configured.
- **Context menu** — right-click the toolbar icon to switch mode or server.
- **Live badge** — the toolbar icon shows `SYS`, `ON`, `PAC`, `OFF` or `ERR`, and the popup repeats
  it as a pill next to the status text.
- **Connection test** — one click tells you whether traffic really flows, through which host and
  how many milliseconds it took. Only a `204` from the probe endpoint counts as success, so a captive
  portal or a block page that answers `200` is reported as a failure instead of a false “works”.
- **Test all servers** — one button next to *Add server* looks at every saved server in turn, not
  just the one the mode is using, so the row verdicts and the generated chain's order refresh from a
  single click. The pass says where it is (`3 of 8 tested…`), ends with `5 worked · 2 no answer ·
  1 skipped`, and a server it could not check is counted as *skipped* rather than guessed about. It
  works in the modes whose routing a probe can reproduce (manual and domain routing) and says why
  when it cannot, and it runs in the service worker, so closing the popup does not stop it.
- **Background checks** — optional, off by default: while the extension is routing, it looks at one
  server every few minutes so what it knows about each of them stays recent — which is what orders
  the generated chain. A check installs *your* routing with a single difference: only the
  extension's own probe travels through the server being tested, so your browsing keeps the route
  you configured, and a server that is down fails the check rather than a page you were loading.
  Turn it on with *Check my servers in the background* on the settings page.
- **Server list that says what the extension knows** — under each address the row reports the last
  verdict and how long ago it was taken (`answered in 42 ms · 3 min ago`, `no answer · 12 min ago`),
  with a coloured dot for the tone. A server nobody has looked at says nothing, and a verdict too
  old to order the chain is dimmed rather than dropped, so the list and the chain agree.
- **Traffic meter** — the popup shows how much has gone down and up today, and the settings page the
  same for today and in total, with a reset button. Chrome tells an extension nothing about the size
  of a request, so the meter adds up what each one *declares* before its bytes move: the
  `Content-Length` of the request and of its response. That makes the figures a floor rather than a
  bill — a streamed video, an event stream or a chunked page declares nothing and is not counted,
  and a response Chrome answers out of its own cache is not counted at all — and the settings page
  says so next to the numbers. Counting happens on your device, only while the proxy is on, and the
  counters live in their own storage key, so an exported settings file never carries them. *Count
  traffic* on the settings page turns it off.
- **Live speed** — under today's figures the popup shows what is moving right now (`↓ 4.6 MB/s ·
  ↑ 120 KB/s`) beside a dot that goes quiet when nothing is, and the settings page has the same
  reading as *Right now*. Every batch of counted bytes reports the span it covers, so a transfer
  that is still going reads its own rate rather than a fraction of it, and one that has stopped
  reads *nothing moving* instead of leaving the tail of a burst on screen as if it were a speed.
- **Keyboard shortcuts** — `Alt+Shift+P` turns the proxy on or off, `Alt+Shift+D` goes direct.
- **Bilingual UI** — switch language from the popup; Persian is rendered RTL.
- **Theme** — automatic (follows your operating system), light or dark. Set it on the settings
  page, or click the ◐ button in the popup to cycle through the three options without leaving it.
- **Accent colour** — five palettes (emerald, ocean, violet, amber and rose) recolour the interface.
  Pick one on the settings page; both pages wear it, and a backup carries it. Mode and status colours
  never change, so a green “reachable” hint stays green in every palette.
- **Backup & restore** — export/import the whole configuration as JSON.
- **No analytics, no telemetry, no remote code.** The only requests the extension itself ever makes
  are the optional **Connection test**/**Test all** buttons and the background checks it can run on a
  timer — the same bare `generate_204` probes, carrying nothing. See [PRIVACY.md](PRIVACY.md).

## Install

### From a release (recommended)

1. Download `proxy-switch-vX.Y.Z.zip` from the [releases page](../../releases).
2. Unzip it somewhere permanent.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the
   unzipped folder.

### From source

```bash
git clone https://github.com/NigaByte031/Proxy-Switch.git
cd Proxy-Switch
npm run package     # writes dist/proxy-switch-v<version>.zip (optional)
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
   see the raw reason when it fails. The **Test all** button next to the server list asks the same
   question of every saved server, one after another.
5. The ◐ button switches between the automatic, light and dark themes; the ⚙ button (or
   `chrome://extensions` → Details → Extension options) opens the settings page, where you manage
   servers, the bypass list, the language, the theme and accent colour, automatic failover and JSON
   backups.

If a mode has nothing to work with (no server selected, empty PAC URL) the extension **fails open**:
traffic goes direct and the popup shows a warning instead of leaving you without a connection.

The toolbar badge is honest about what is really in force: it shows `ERR` when Chrome refused the
change (another extension or a policy owns the proxy settings) or when the proxy stopped answering,
and the popup spells out which of the two happened. The settings page repeats that reason next to
the mode chips, with a **Try again** button that asks the service worker to apply the mode once more.

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
| `webRequest` + `webRequestAuthProvider` | Answer proxy `407` challenges with the saved credentials of the active server (Manifest V3 supports blocking listeners for `onAuthRequired` only), and read the size each request and response declares for the traffic meter. Observation only — no request is ever modified. |
| `contextMenus` | The right-click menu on the toolbar icon. |
| `notifications` | The system notification that names the server an automatic switch moved to. |
| `alarms` | The timer behind the periodic background check — set only while that option is on. |
| `<all_urls>` | Required to route traffic and to see proxy authentication challenges. |

The extension has **no content scripts** and injects nothing into pages.

## Development

Requirements: Node.js 22+ (only for the tests, the preview generator, the screenshots and
packaging — the extension itself has zero dependencies and no build step).

```bash
npm test                 # unit tests (state, proxy config, i18n coverage, manifest, zip writer)
npm run preview          # regenerate the offline preview pages
npm run shots           # retake docs/screenshots/*.png (needs the preview server running)
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
    theme.js                theme + accent resolution, applied onto <html> (pure, tested)
    failover.js             auto-failover policy: strikes, rounds, cooldown (pure, tested)
    notice.js               the wording of the automatic-switch notification (pure, tested)
    pac.js                  builds a PAC script from the domain list (pure, tested)
    server-health.js        recent per-server verdicts, and the chain order they imply (pure, tested)
    server-probe.js         the policy of the periodic background check (pure, tested)
    proxy.js                builds the chrome.proxy config + status text (pure, tested)
    auth.js                 auto-auth policy: who may answer a proxy challenge (pure, tested)
    health.js               connection probe: timing and verdict (pure, tested)
    health-ui.js            the shared "Test connection" control
    test-all-ui.js          the shared "Test all servers" control (pure core, tested)
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
- **A verdict is only recorded where it means something.** The chain order comes from the
  extension's own probes, and a probe is attributed to a server only in manual mode, where that
  server is the whole route. In PAC mode a chain hides which hop answered, so nothing is guessed —
  a server nobody has looked at simply keeps its place in the list.
- **Theming is one file.** Every colour, radius and shadow is a custom property in
  `src/styles/base.css` — the light palette on `:root`, the dark one on `:root[data-theme='dark']`,
  one block per accent palette for each theme, all chosen by `lib/theme.js` and applied as
  `data-theme`/`data-accent` on `<html>` — so the themes, the accent palettes and the per-mode accents
  (emerald for a saved server, indigo for PAC, slate for the system proxy, amber when something is
  missing) can be re-tuned without touching any other stylesheet.

## Publishing

- [ ] `npm run package`, then upload `dist/proxy-switch-v1.4.0.zip` from the Chrome Web Store
      developer dashboard (a 128×128 icon is already included; screenshots can be taken from the
      preview pages).
- [ ] Tag the release — `git tag v1.4.0 && git push origin v1.4.0`. The
      [release workflow](.github/workflows/release.yml) refuses a tag that does not match
      `manifest.json`, runs the tests and attaches the ZIP to the GitHub release.
- [ ] Add real screenshots to `docs/` if you want them in this README.

## Roadmap ideas

- One server per domain: domain routing sends every listed site through the same chain, so a
  per-domain server is the next step.
- Import from common formats (`SwitchyOmega` backups).
- Firefox build (WebExtensions `browser.proxy` has the same shape).

## Security

Vulnerabilities go through the Security tab rather than the issue tracker — [SECURITY.md](SECURITY.md)
says what counts as one here (a route that leaks direct, credentials that answer for the wrong
server, state that outlives *Delete everything*) and what does not.

## License

[MIT](LICENSE)
