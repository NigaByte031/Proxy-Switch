# Security policy

## Supported versions

Only the newest release is supported: take `proxy-switch-vX.Y.Z.zip` from the
[releases page](../../releases/latest) and load that folder. Older zips are not patched.

## Reporting a vulnerability

Report it privately with
[**Report a vulnerability**](https://github.com/NigaByte031/Proxy-Switch/security/advisories/new) in
the Security tab — not as a public issue, so there is room to fix it before it is described. Please
include the version from `chrome://extensions`, what you did, and what you saw. This is a small
project run by one maintainer on a best-effort basis; there is no bounty programme.

## What counts as a security issue

The extension makes one narrow promise, and most of it can be checked: servers, credentials, bypass
rules and routing stay on the device, the only requests it makes are the optional `generate_204`
probes described in [PRIVACY.md](PRIVACY.md), and it never fetches remote code. Anything that breaks
that promise is a security issue:

- **Traffic sent direct that the configuration says should not be.** A domain routed *through* a
  proxy escaping in domain routing, a bypass rule that fails open, or a badge that reports a route
  other than the one in use.
- **Credentials travelling too far.** A saved server's credentials answering a challenge from
  another server, or appearing where they can be read — a badge, a notification, an exported
  backup, a console message.
- **State that outlives its welcome.** An exported backup, or `chrome.storage` contents after
  **Delete everything**.
- **Anything reachable from a page or a proxy response**, since the extension parses both.

## What is not

- A proxy operator seeing traffic that a user chose to send through their server — that is what a
  proxy is for.
- Requests the extension itself makes for the connection test and the background checks: they are
  optional, documented, and carry nothing.
- Chrome, or a server the user was told to point the extension at.
