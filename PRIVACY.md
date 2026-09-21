# Privacy policy

**Proxy Switch collects nothing and sends nothing anywhere.**

## What the extension stores

Everything lives in `chrome.storage.local` on your own device, and never in `chrome.storage.sync`:

- the modes, PAC URL and bypass list you configure,
- the servers you add (name, scheme, host, port),
- the proxy username and password you optionally type in.

## What leaves your device

Nothing. The extension has no network code, no analytics, no telemetry, no remote configuration and
loads no remote scripts. It only:

- writes your configuration to the browser's own storage,
- tells Chrome which proxy to use (`chrome.proxy`),
- reads the proxy login prompt so it can answer it with the credentials you saved
  (`chrome.webRequest.onAuthRequired`).

## Exports

The **Export** button writes a JSON file with your settings and servers — including usernames and
passwords **in plain text**. That file is created locally and downloaded by the browser; where it
goes afterwards is entirely up to you. Treat it like a password file.

## Removing your data

- Deleting a server removes it from storage immediately.
- **Reset** in the settings page erases every stored value and restores the defaults.
- Uninstalling the extension removes all of its stored data from the browser.

## Contact

Open an issue in this repository if you have a question about how the extension handles your data.
