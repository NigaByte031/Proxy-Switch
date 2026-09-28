# Privacy policy

**Proxy Switch collects nothing: no analytics, no telemetry, no account, no identifiers.**

## What the extension stores

Everything lives in `chrome.storage.local` on your own device, and never in `chrome.storage.sync`:

- the modes, PAC URL and bypass list you configure,
- the servers you add (name, scheme, host, port),
- the proxy username and password you optionally type in,
- the traffic counters: two byte counts per direction (today and since the last reset) and the day
  they belong to. Nothing else about your traffic is written down — not a URL, not a host, not a
  page, not a time.

## What leaves your device

No settings, servers or credentials — ever. The extension ships no analytics, no telemetry, no
remote configuration and loads no remote scripts. It only:

- writes your configuration to the browser's own storage,
- tells Chrome which proxy to use (`chrome.proxy`),
- reads the proxy login prompt so it can answer it with the credentials you saved
  (`chrome.webRequest.onAuthRequired`),
- reads how large the browser says a request and its response are, so the popup can show how much
  has gone down and up today (`chrome.webRequest` observers, see the **Traffic meter** below),
- shows a local system notification naming the server an automatic switch moved to, if you keep that
  option on (`chrome.notifications`) — it carries your server name and nothing else, and is handed to
  your operating system, not to any server,
- and, only while the **Test connection** button or the **Test all** pass is running, sends two
  plain requests to public online-check endpoints (`https://www.gstatic.com/generate_204` and
  `https://cp.cloudflare.com/generate_204`) to see whether traffic really flows. They carry no
  configuration, no identifiers and no credentials — the same kind of check a browser makes on
  startup. A **Test all** pass asks the same pair once per saved server, one server at a time.

The **background check** option (off by default) makes the same two requests on its own, one server
at a time, so what the extension knows about each of your servers stays recent. Each check installs
a temporary proxy configuration first — your own routing, with only those two check requests handed
to the server being tested — so your browsing keeps the route you configured while it runs. Nothing
about it is sent anywhere: the requests are the same plain `204` endpoints, they carry no
configuration and no credentials, and the answer is only ever written to your own storage as
“answered, in 42 ms”.

## The traffic meter

The **traffic meter** keeps two numbers per direction — what has gone down and up today, and in
total since you last reset them. The extension never knows what those bytes *were*: it reads the
size a request and its response declare, discards everything else about them (the URL the moment it
has been checked against the extension's own probe endpoints), and adds that size to a counter in
`chrome.storage.local`. No host, no page, no history and no per-site breakdown is stored, and no
part of it is ever sent anywhere. The counters are deliberately kept out of an exported settings
file, and uninstalling the extension removes them with everything else. *Count traffic* on the
settings page switches the whole thing off.

The live speed the popup and the settings page show comes from the same observation, and adds one
more piece of memory: a sample per batch of counted bytes — the two byte counts, the moment it was
taken and the span it covers — kept for ten seconds and swept as it is read, so what sits on the
device is the last few seconds of counting and nothing older. It is not sent anywhere either, and
*Reset counters* clears it together with the counters.

Two other pieces of traffic are yours, not the extension's: Chrome downloads the PAC script URL
you entered, and your browsing travels through the proxy server you configured. (A PAC script built
from your own domain list is not downloaded at all — it is handed to Chrome as text, and no copy of
it leaves the browser.)

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
