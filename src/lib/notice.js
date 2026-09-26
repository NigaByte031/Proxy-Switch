/**
 * The one message the extension ever brings up on its own: "you are on a
 * different server now".
 *
 * A failover switch happens while nobody is looking at the popup, and the
 * toolbar badge says no more than `ON` — without this, the extension would
 * quietly change how the whole browser reaches the network. The wording is
 * built here, from the state and the server that took over, so it stays pure
 * (and testable): the service worker only hands the result to
 * `chrome.notifications` (see `src/background.js`).
 */

import { t } from './i18n.js';

/**
 * Notification id. Only one switch is worth showing, so a later one replaces
 * the notification still on screen instead of stacking a second one on top.
 */
export const SWITCH_NOTICE_ID = 'proxy-switch:failover';

/**
 * Whether this state wants to hear about automatic switches. The setting only
 * exists to be turned off, so anything but an explicit `false` means yes —
 * including a state that predates the setting.
 */
export function wantsSwitchNotice(state) {
  return state?.settings?.notifyFailover !== false;
}

/**
 * Builds the notification for a switch, or null when there is nothing to show
 * (no server, or the user turned the notification off).
 *
 * The notification is also the way back: with a server to go back to it grows
 * a button (`{button: true}` in the result — `chrome.notifications` wants the
 * title, the caller decides what a click means), and clicking the body opens
 * the server list either way. A switch that cannot be undone is still worth
 * reporting, so a missing `from` only costs the button.
 *
 * @param {object} state
 * @param {{name?: string}|null} to the server that took over
 * @param {{name?: string}|null} [from] the server it left behind
 * @param {string} [lang]
 * @returns {{id: string, title: string, message: string, button: string|null}|null}
 */
export function buildSwitchNotice(state, to, from = null, lang = 'en') {
  if (!to?.name || !wantsSwitchNotice(state)) return null;
  return {
    id: SWITCH_NOTICE_ID,
    title: t('notice.switched.title', lang),
    message: t('notice.switched.message', lang, { name: to.name }),
    button: from?.name ? t('notice.switched.button', lang, { name: from.name }) : null,
  };
}
