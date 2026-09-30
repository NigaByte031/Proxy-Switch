# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Removed

- **The Firefox build.** `manifest.firefox.json`, the `package:firefox` script and the workflow steps
  that attached a `-firefox.zip` to every release are gone: `tools/package.mjs` builds one archive
  from `manifest.json`, and releases carry it alone from here on. The archives published with v1.6.1
  are untouched. The dialect tolerance the second browser brought stays where it is — the
  `onError`/`onProxyError` event alias and a build that refuses notification buttons are handled
  without a manifest of their own.

### Fixed

- **A check's own probe error was read as a broken route.** Chrome's `proxy.onError` details are
  `{fatal, error, details}` — they carry no URL — so the guard that was meant to recognize the
  extension's own probe (`isProbeUrl(details.url)`) could never match. While a background check or a
  *Test all* pass looked at a server that was down, the badge flipped to `ERR` and the popup said
  the proxy settings had not been applied — about a route that was working. What tells the two apart
  is not the request but which configuration is in force: while a check runs it is the check's own,
  so errors from that window are ignored.
- **A dead route was reported as a change Chrome refused.** A server that stopped answering landed
  in the same status record as a failed apply, so the popup and the settings page said *Chrome
  refused the change: net::ERR_PROXY_CONNECTION_FAILED* — when the change had been applied and it
  was the server that had gone quiet. The record now carries which of the two failed (`source`), and
  a route failure is worded as one; a record written before this change still reads as a failed
  apply.
- **A server whose host carried its own port was thrown away.** Importing a backup — or reading a
  hand-edited storage value — with `"host": "proxy.example.com:8080"` silently dropped that
  server: a host is validated as one field and a colon is not part of a host. The host is now split
  exactly as the form splits a pasted address, so the server survives, and the port field wins when
  it says something.
- **A pasted URL's path was read as credentials.** `https://proxy.example.com/@user` filled the form
  with the username `proxy.example.com/@user` and the host `user`. The address is cut at its first
  path, query or fragment before anything looks for userinfo.
- **The live speed was not live.** Every batch of counted bytes was stamped with the moment the
  flush timer fired rather than with the moment its last byte was counted, so the span it reported
  was the length of that timer: a burst that took half a second read a fraction of the speed it ran
  at, and the line could move at most once every five seconds, leaving the tail of a finished
  transfer on screen until the next write. A batch is now published every second — the same
  second-long slice the counters are written in, so *Today* and *Total* follow a download as it
  happens too — stamped with its own last counted byte and measured from its first to its last
  (`batchSpan()` in `lib/traffic.js`). A burst therefore reads the rate it really ran at, and goes
  quiet a few seconds after it ends rather than when the writer got around to it.

## [1.6.1] — 2026-09-28

### Added

- **Screenshots in the README**, taken from the offline preview pages rather than drawn: both
  READMEs now open with the popup and the settings page, English for one and Persian for the other.
  They are retaken with `npm run shots` (`tools/screenshots.mjs`), which drives a headless Chrome
  over the DevTools protocol — Node's own WebSocket does the talking, so there is still nothing to
  install — and frames each page at the size its content needs. The preview stub grew a `?demo=1`
  seed for it: three servers with verdicts, today's counters and a speed that keeps moving, so the
  pictures show the interface with something in it. `tests/docs.test.mjs` fails the suite when a
  picture a README points at is missing or is not a PNG.
- **A Firefox build.** `npm run package:firefox` writes
  `dist/proxy-switch-v<version>-firefox.zip` — the same tree under a new `manifest.firefox.json`,
  which runs `src/background.js` as an event page (Firefox has no extension service worker at all,
  see MDN) and carries the Gecko id, the floor of 140 that the manifest's own keys need, and the
  `data_collection_permissions: none` declaration AMO requires from every new add-on. Two code paths
  learned to speak both dialects: the proxy-error event (Chrome calls it `onProxyError`, Firefox
  `onError`) and the switch notification, which now retries without its button where notifications
  have no buttons (Firefox before 152). Both READMEs gained a browsers table — minimum versions,
  what the Firefox archive is and how an unsigned one gets installed — the release workflow builds
  and attaches both archives, and Mozilla's `addons-linter` accepts the result with zero errors.

## [1.6.0] — 2026-09-28

### Added

- **Live speed.** The popup now carries a line under today's figures that says what is moving *right
  now* — `↓ 4.6 MB/s · ↑ 120 KB/s`, with a dot that goes quiet when nothing is — and the settings
  page shows the same reading as a *Right now* line. A speed is bytes over time, so every batch of
  counted bytes reports the span it covers: the clock starts with the batch's first byte rather than
  with the timer that writes it, and the reading is those bytes over those spans. That is what makes
  a transfer that is still going read its own rate instead of a fraction of it, and a transfer that
  has slowed down read the slower number as its fast batches age out of the window. The window holds
  the last ten seconds of counted bytes and the reading is recomputed on every draw — nothing is
  sampled on a timer and no second listener decides what a byte is. Five seconds without a counted
  byte and the line says *nothing moving*, rather than leaving the tail of a burst on screen as if it
  were a speed.
- The window lives in its own storage key, `proxySwitchTrafficRate`, holding four things per sample
  — the two byte counts, the moment it was taken and the span it covers — for no longer than the
  window itself. It is memory rather than configuration, so an exported settings file never carries
  it, and *Reset counters* clears it together with the counters: a reading about bytes that no
  longer exist anywhere is not a reading. `PRIVACY.md` says what is kept and for how long.

## [1.5.0] — 2026-09-27

### Added

- **Traffic meter.** The popup shows how much has gone down and up today, and the settings page the
  same for today and in total, with a reset button and a switch (*Count traffic*, on by default).
  Chrome hands an extension no byte counts — a `webRequest` observer sees that a request happened,
  not how large it was — so `src/lib/traffic.js` adds up what each request and response *declares*
  before its bytes move: the `Content-Length` of the request (`onBeforeSendHeaders`) and of the
  response (`onCompleted`). The numbers are therefore a floor and not a bill — a streamed video, an
  event stream or a chunked page declares nothing and is not counted, and a response Chrome answers
  out of its own cache is not counted at all — and the settings page says exactly that next to the
  figures instead of implying a precision the API cannot give.
- Counting runs in the service worker, which is the only context that may see a request: bytes are
  batched and written every few seconds rather than per event (one page load is hundreds of events,
  and one storage write per event would be both slower and noisier than the number is worth), the
  extension's own probes are excluded so a background check never shows up as your traffic, and only
  traffic while the proxy is on is counted — `direct` is the one mode where nothing is being
  routed, so `meterRuns()` refuses it. The counters live in their own key, `proxySwitchTraffic`,
  beside the failover record and the server verdicts: memory rather than configuration, never
  written into an exported settings file, and reset without touching anything the user configured.
- The permission the meter needs was already granted: `webRequest` is an observer here (`responseHeaders`
  and `requestHeaders` in `extraInfoSpec`), so no new warning, no new permission and no request is
  ever modified. `PRIVACY.md` says plainly what is and is not written down.

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

[1.6.1]: ../../releases/tag/v1.6.1
[1.6.0]: ../../releases/tag/v1.6.0
[1.5.0]: ../../releases/tag/v1.5.0
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
