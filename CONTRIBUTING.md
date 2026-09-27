# Contributing

Thanks for taking a look! This is a small project, so the rules are short.

## Getting started

```bash
git clone https://github.com/NigaByte031/Proxy-Switch.git
cd proxy-switch
npm test              # unit tests (Node 20+, no install step, no dependencies)
npm run preview       # regenerate src/__preview_*.html after editing a page
```

To try your changes in Chrome, open `chrome://extensions`, enable **Developer mode**, click
**Load unpacked** and select the repository folder (or reload it after editing). The offline preview
pages are quicker for pure UI work.

## Ground rules

- **No dependencies.** The extension and its tooling stay dependency-free; the ZIP writer in
  `tools/package.mjs` exists precisely so that `npm install` is never needed.
- **Keep the Chrome APIs in one place.** Logic that can be expressed as a pure function belongs in
  `src/lib/*.js` so it can be tested in Node. The service worker is the only code that applies the
  proxy settings, and the pages only write state.
- **Everything user-visible is bilingual.** Add new strings to *both* dictionaries in
  `src/lib/i18n.js`; `npm test` fails if a key or a translation is missing.
- **Regenerate the previews.** If you touch `src/popup.html` or `src/options.html`, run
  `npm run preview` and commit the result — the tests check that the previews stay in sync.
- **Never send user data anywhere.** No analytics, no telemetry, no remote code — the only network
  requests the extension makes are the connection test's bare `generate_204` probes, which carry
  nothing, and nothing new may be added without holding that line.

## Before opening a pull request

```bash
npm run preview -- --check   # previews are up to date
npm test                     # all suites green
npm run package              # the extension still packages
```

Please describe *why* the change is needed, not only what it does. If you added a permission to the
manifest, explain the user-facing reason — `tests/manifest.test.mjs` asserts the permission list so
it stays deliberate.

## Reporting bugs

Include your Chrome version, the proxy mode you were in, and what you expected to happen. If the
popup shows a warning or the badge shows `ERR`, mention it — that narrows things down quickly.

For security or privacy questions, see [PRIVACY.md](PRIVACY.md).
