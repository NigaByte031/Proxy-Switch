# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **`SECURITY.md`** — how to report a vulnerability privately, what counts as one here (a route that
  leaks direct, credentials that answer for the wrong server, state that outlives *Delete
  everything*) and what does not. Private vulnerability reporting, secret scanning and push
  protection are switched on for the repository, so a token pushed by mistake is blocked before it
  lands.

### Fixed

- **CI failed on every push.** `node --test "tests/**/*.test.mjs"` leans on Node's own glob
  expansion for `--test`, which arrived in Node 21: Node 20 received the pattern as a literal path,
  stopped with `Could not find .../tests/**/*.test.mjs` before running a single test, and took the
  release job down with it — so the *Run the unit tests* step was red on every commit while the
  same suite passed locally and on the Node 22 half of the matrix. Node 20 is past end of life, so
  the baseline is Node 22: the CI matrix now tests 22 and 24, the release job runs on 22, and
  `engines.node` asks for `>=22`. The glob stays explicit on purpose — `node --test` with no
  arguments discovers files by name and would pick up `src/lib/test-all-ui.js`, which is extension
  source, not a test.

## [1.4.0] — 2026-09-26

### Added

- **Domain routing — only the sites you list go through a proxy.** PAC mode can now build its script
  from your own list instead of downloading one: `example.com` routes that domain *and* its
  subdomains, `*.example.com` only the subdomains, `*` and `?` are globs, `<local>` covers dot-less
  intranet names, pasted URLs are reduced to their host, and `#` starts a comment. Everything not
  listed stays direct. The list is compiled into a PAC script that Chrome is handed as text
  (`pacScript.data`, `mandatory: true`), so nothing has to be hosted or downloaded, and a listed site
  is *never* sent direct — a server that is down fails loudly instead of leaking exactly the traffic
  the list exists for. The script names **every saved server** as a chain (`PROXY a:8080; PROXY
  b:8080`, the active one first), so domain routing survives a dead server the way manual mode does:
  Chrome retries the next hop on the same connection, and auto-authentication answers a challenge
  from any server that chain names. Bypass rules still win, and failover stays a manual-mode feature.
  `src/lib/pac.js` is the (pure) generator, `lib/model.js` owns the rule format, and the popup and
  settings page share one toggle and one textarea. `tests/pac.test.mjs` runs the generated script for
  real — `FindProxyForURL()` under the standard PAC helpers — instead of matching it as a string.

- **Automatic failover.** When the active server stops answering, the extension now moves to the next
  one in the list. A streak of proxy errors only makes the route *worth checking*: a probe through
  the current server has to fail before anything is switched, so a request that failed for its own
  reasons can never change the active server. One round visits every other server once and then
  stops — a network that is down everywhere keeps `ERR` on the badge instead of making the extension
  flip between broken servers — a 30-second cooldown gives each newly chosen server its chance, and
  a round that has gone quiet for five minutes is retried from scratch. The new *Switch to the next
  server when the active one stops answering* toggle on the settings page (General) turns it on or
  off; it defaults to on.
- `src/lib/failover.js` — the whole policy as pure functions over a record: `failoverEligible()`,
  `noteProxyError()` (counts the streak and decides whether to probe), `planFailover()` (the switch)
  and `noteHealthy()` (forget the streak). The record lives in its own storage key,
  `proxySwitchFailover`, next to the state but outside it — so the bookkeeping survives the MV3
  worker being asleep, is queued like every other write, is never rewritten when nothing changed
  (a burst of errors costs one write), and is never exported or reset with the settings. Covered by
  `tests/failover.test.mjs` plus the storage round trip in `tests/storage.test.mjs`.
- **The automatic switch now says so.** A failover switch happens while nobody is looking at the
  popup, and the badge said no more than `ON` — so the extension could quietly reroute the whole
  browser without a word. It now sends a system notification naming the server that took over, and
  the toolbar icon wears that server's name for eight seconds before going back to the mode. Only
  switches the extension makes on its own are announced; a server you pick yourself is an answer,
  not news. The new *Tell me when the extension switches servers on its own* toggle on the settings
  page (General) turns the notification off, and the manifest asks for the `notifications` permission
  solely for it — both the settings page and PRIVACY.md say so.
- **The notification is also an answer.** Clicking it opens the server list (the popup itself on
  Chrome 127+, the settings page everywhere else), and its *Back to <server>* button returns to the
  server the switch moved away from — the round starts over, but a server the user chose on purpose
  keeps the same 30-second grace period an automatic switch gets, so one that is still dead is not
  dragged away from instantly. The way back is derived from the round the policy already keeps
  (`failoverUndoTarget()` and `noteManualSwitch()` in `lib/failover.js`), so a stale offer — the user
  has picked a server since, or the one to return to is gone — moves nothing and opens the server
  list instead.
- `src/lib/notice.js` — the wording of that notification, built from the state and the server that
  took over, so it is pure and covered by `tests/notice.test.mjs` (translation, filled-in name,
  cancel button, opt-out, one live notification id). `describeSwitchBadge()`/`activeSwitchFlash()` in `lib/proxy.js`
  decide what the icon wears, including why a flash expires: it carries its own deadline, so a worker
  terminated before its timer fired cannot leave the badge lying. `tests/failover-scenario.test.mjs`
  now also asserts what the user is told at each switch, and that a switched-off announcement does
  not stop the switch itself.
- `tests/failover-scenario.test.mjs` — the same feature end to end instead of function by function: a
  scripted three-server network whose active server goes down, driven through the check exactly as
  the service worker runs it (same order, same guard, same state write, same announcement). Covers
  the confirming probe, a healthy server that is never switched away from, the cooldown, a round that
  stops after every server has been tried, one check per burst of errors, failover switched off, and
  the reset once the new server answers.
- **The chain follows what the extension has seen.** Each verdict about a server — the probe that
  confirms a failover, or the manual *Test connection* button, both through the active server — is
  remembered per server in its own storage key (`proxySwitchServerHealth`, memory like the failover
  record, never exported), and the generated chain is ordered by it: a server that recently answered
  goes first (fastest of them first), a server nobody has looked at keeps its place in the list, and a
  server that recently failed goes last. Verdicts expire after twenty minutes, so a verdict can
  neither promote nor demote a server forever — and a periodic check can refresh one before that
  happens (see below). Attribution is deliberately strict — only manual mode, where the active
  server *is* the whole route, lets a *route* produce a verdict (`probeObservation()`), because in
  any other mode the answer came from a system proxy, a downloaded script or a chain, and guessing
  which hop answered would be worse than not knowing. (The background check below is the one caller
  that knows exactly whom it asked, so it does not need that rule.) `src/lib/server-health.js` holds the record and the
  ordering, both pure; applying is serialized in the worker so a verdict and the state write it sits
  behind can never interleave an older config over a newer one.
- **The extension can keep those verdicts fresh by itself.** A new *Check my servers in the
  background* toggle on the settings page (General, **off by default**) makes the worker look at one
  server every five minutes, so a server that came back — or one that quietly died — stops holding a
  stale place in the chain for as long as nobody presses anything. A check is not a guess about a
  route: it installs the user's *own* configuration with exactly one difference, and that difference
  is where the check's own probe requests go. The script is built by the same generator as the real
  one (`buildPacScript` gained an `override` for the probe endpoints and a `base: 'all'` for manual
  mode, where nothing is left direct), so a server that is down fails the check instead of a page
  being loaded, and no byte of browsing traffic goes anywhere new. Three consequences are handled
  explicitly: a proxy error the check provoked is not counted as a failover strike (and no failover
  check may start while the check's temporary route is in force — its probe would be handed to the
  wrong server), a challenge from the server under test is answered with that server's own saved
  credentials for as long as the check runs (`resolveAuthCredentials` gained a third argument), and a
  verdict is only believed if the script is still the one in force when the probe returns, so a
  configuration applied mid-check invalidates the answer instead of mislabelling it. The check only
  runs in the two modes it can reproduce byte for byte — manual and domain routing — and never in
  `system` mode, where a PAC script would replace the operating system's proxy. It is scheduled with
  a single repeating `chrome.alarms` timer (new `alarms` permission, justified on the settings page
  and in PRIVACY.md: the alarm is set only while the option is on), and the check restores the
  user's configuration on every path out of it, including a timeout — and a worker killed mid-check
  is repaired by the apply every worker start already ends with.
- `src/lib/server-probe.js` — the check's policy as pure functions: `probeEligible()` (the setting,
  and the modes whose routing can be reproduced exactly), `probeCandidates()` (never looked at first,
  then the oldest verdict, capped per pass) and `probeVerdict()`. `buildProbeConfig()` in
  `lib/proxy.js` builds the temporary configuration, `isConfigApplied()` decides whether a result may
  be believed, and `tests/server-probe.test.mjs` covers the schedule, the eligibility rules and the
  verdict, with the generated script itself run in `tests/pac.test.mjs` (a probe host reaches the
  server being checked while a listed host, a bypassed host and an unrelated one all keep what the
  user configured).
- **The server list says what the worker knows.** Each row of the list — in the popup and on the
  settings page, both drawn by `lib/servers-ui.js` — now wears the server's last verdict under its
  address: `answered in 42 ms · 3 min ago`, or `no answer · 12 min ago`, with a coloured dot for the
  tone. A server nobody has looked at says nothing at all, because “unknown” is not a state the
  extension has an opinion about. A verdict that is older than the lifetime the chain uses keeps its
  words but loses its colour, so the list is dimmed exactly when the ordering stops counting it —
  what is on screen and what the chain does stay the same thing. The line is re-read on a minute
  timer of its own, so a list left open does not go on saying “just now”, and the ages are pure
  (`describeServerVerdict()`/`describeVerdictAge()` in `lib/server-health.js`, covered by
  `tests/server-health.test.mjs`, with the row itself rendered in `tests/servers-ui.test.mjs` against
  a minimal DOM).
- **Every saved server can be tested in one go.** A *Test all* button — next to *Add server* in the
  popup and on the settings page — walks the whole list instead of the one server the mode is using.
  The worker looks at each saved server in order with the same `checkServer` the background timer
  uses (one at a time, a verdict only for the server that was actually probed, the user's own
  configuration back in force afterwards), but on the user's order rather than the timer's policy:
  every server is looked at, not just the two a periodic pass may visit, and a verdict from last week
  is refreshed rather than trusted. The pass answers as soon as it *starts* — an open popup should
  not have to stay open for the whole run — and announces each verdict the moment it is recorded, so
  the line under the list counts up (`3 of 8 tested…`) while the rows' own verdict lines fill in,
  and ends with `5 worked · 2 no answer · 1 skipped`. A look that could not be taken is announced as
  *skipped*, never guessed about; a second press while a pass is running says so instead of queueing
  a duplicate, an empty list says there is nothing to test, and a mode whose routing a probe cannot
  reproduce — `system`, or a PAC script the extension did not build — says why rather than probing
  something else. `src/lib/test-all-ui.js` is the
  shared control (pure `parseProgress()`/`summarize()` plus a small controller), covered by
  `tests/test-all-ui.test.mjs`; the pass itself is worker code in `src/background.js`, and
  `tests/server-probe.test.mjs` covers where a pass is allowed to run (`testAllEligible`).
- **The brand colour is yours now.** `settings.accent` picks between five palettes — emerald (the
  shipped one), ocean, violet, amber and rose — offered as a swatch radiogroup on the settings page
  (arrow keys move through it, and a swatch paints itself with the real tokens it offers) and worn by
  both pages. The choice is validated like every other setting, so a hand-edited storage or an
  imported backup cannot invent a palette, and it travels in a backup like the theme. Applying it
  writes `data-accent` on `<html>` next to `data-theme`; `src/styles/base.css` ships a palette block
  per accent for each theme, and those blocks may only repaint tokens the base palette already
  defines — the mode hues and the `ok`/`warn`/`danger` colours stay put in every palette, so a green
  “reachable” chip cannot turn decorative. `tests/accent.test.mjs` checks the model, the labels in
  both languages, the attribute, the stylesheet (including that the emerald block is the base palette
  token for token, because the emerald swatch has to be emerald even while another colour is worn)
  and the contrast of every palette in both themes.

## [1.3.0] — 2026-09-23

Five things the extension claimed but did not do are now true. Nothing about the state shape changed,
so an existing configuration is untouched.

### Fixed

- **The `ERR` badge was overwritten the instant it was set.** `sync()` reported a failed apply and then
  repainted the badge with the mode name, so the one state the README tells users to report could not
  be seen. The badge is now painted from the outcome of the apply: a problem always wins over the mode
  and stays on the icon until an apply succeeds.
- **A proxy controlled by somebody else was reported as applied.** `chrome.proxy.settings.set`
  resolves even when another extension or a policy owns the proxy settings, so a mode could silently
  not be in force. `applyProxy()` now reads `levelOfControl` back, and `describeApplyProblem()` turns
  both that and a thrown error into a message the popup shows and the badge tooltip repeats.
- **Two quick changes could lose one of them.** Every writer now goes through a queued
  `updateState()`, so each change starts from the state the one before it left behind instead of from
  the same stale snapshot.
- **Saved credentials could answer a proxy that was not ours.** Auto-authentication is now limited to
  a running extension in manual mode and to the active server.
- **The connection test could pass while traffic was intercepted.** The probe counted any `2xx`/`3xx`
  answer as success, so a firewall's `200` block page or a captive portal's redirect to its login page
  reported “Connection works” with no connection at all. The probe endpoints answer `204` and nothing
  else, so only a `204` now counts — every other status fails the test with its raw code in the
  tooltip (`http-200`, `http-302`, …).

### Added

- `src/lib/auth.js` — pure `resolveAuthCredentials()`/`normalizeChallengeHost()`, covered by
  `tests/auth.test.mjs`; the service worker's `onAuthRequired` listener is a three-line adapter now.
- `proxySwitchApplyStatus` in `chrome.storage.local` — the outcome of the last apply, so the popup can
  explain a badge instead of contradicting it. Repeats are not rewritten, so a burst of
  `onProxyError` events still updates the UI once. `tests/storage.test.mjs` covers the key and the
  write queue.
- The `ERR` pill has its own colour, and `#warning` is a `role="alert"` region, so the explanation is
  announced instead of only being visible.
- **The settings page explains a failing badge and offers a retry.** `#applyPanel` repeats the reason
  next to the mode chips with a *Try again* button. `requestReapply()` sends `proxy-switch:reapply` to
  the service worker, which applies again and answers with the fresh status; the pages still never
  touch `chrome.proxy` themselves. The offline preview answers a retry with a healthy status, so the
  whole path can be clicked through without installing anything.

[1.4.0]: ../../releases/tag/v1.4.0
[1.3.0]: ../../releases/tag/v1.3.0

## [1.2.1] — 2026-09-22

The server list is now something you *work with* rather than scroll through: it can be searched, it
explains itself to keyboard and screen-reader users, and deleting no longer interrupts you.

### Added

- **Server search** — once a list passes four servers a search box appears above it, and `/` jumps to
  it from anywhere in the popup or the settings page. Every word of the query has to match the name,
  host, scheme, port or username, so `socks5 1080` narrows a mixed list down to one row; a query that
  finds nothing says so instead of leaving an empty list. The logic is pure and lives in `model.js`
  (`filterProfiles`, `profileSearchText`, `shouldShowSearch`), covered by `tests/model.test.mjs`.
- **Inline delete confirmation** — clicking ✕ turns that row into a `Delete “<name>”?` question with
  Delete / Cancel buttons and moves focus straight onto Delete. `Escape` puts the row back and
  returns focus to the ✕ that opened it, so a mis-click costs one key instead of a dialog.
- **Keyboard shortcuts** — `Escape` cancels a pending delete, then closes the add/edit form, then
  clears the search, in that order; `Cmd/Ctrl+Enter` saves the form from any field; `/` focuses the
  search box (and stays plain text while you are typing in it).
- The popup status line is a `role="status"` region, so a screen reader hears the new mode after a
  switch instead of having to go looking for it, and it only reports when the text really changed.

### Changed

- Long server names are ellipsised on one line instead of wrapping, so every row keeps the same
  height and the list reads as a list.
- “Add server” no longer disables itself while the form is open — clicking it again simply starts a
  fresh form — and it now reports `aria-expanded` alongside `aria-controls`.
- The search field draws its magnifier with an inline SVG instead of the `⌕` character, which most UI
  fonts do not carry.

### Removed

- `confirm.deleteProfile` and the `confirmFn` option of `createServersUi`: the blocking
  `window.confirm` for deleting a server is gone. The full reset on the settings page still uses one,
  deliberately — that action really is irreversible.

[1.2.1]: ../../releases/tag/v1.2.1

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
