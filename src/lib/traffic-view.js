/**
 * Display templates for the traffic readout: the same three readings — right now,
 * today, the total — arranged four ways.
 *
 * The choice is a setting, so it travels in a backup and both pages wear the same
 * template. Where each figure sits is the stylesheet's business: a page writes
 * `data-view` on its readout and the template's rules take over, which is why no
 * template needs a second copy of the numbers.
 */

import { TRAFFIC_VIEWS } from './model.js';

/** Default value of `settings.trafficView`. */
export const DEFAULT_TRAFFIC_VIEW = 'classic';

/** i18n key per template, for the picker's label. */
export const TRAFFIC_VIEW_KEYS = {
  classic: 'traffic.view.classic',
  compact: 'traffic.view.compact',
  cards: 'traffic.view.cards',
  speed: 'traffic.view.speed',
};

/** i18n key per template, for the one line under the picker. */
export const TRAFFIC_VIEW_HINTS = {
  classic: 'traffic.view.classicHint',
  compact: 'traffic.view.compactHint',
  cards: 'traffic.view.cardsHint',
  speed: 'traffic.view.speedHint',
};

/**
 * What a template does with the total. The classic popup row has no room for it,
 * so it keeps the total in the row's hover text instead; every other template
 * shows it as a figure of its own.
 */
export const TRAFFIC_VIEW_PARTS = {
  classic: { total: false },
  compact: { total: true },
  cards: { total: true },
  speed: { total: true },
};

/** i18n key naming a template, with the default as the fallback. */
export function trafficViewKey(view) {
  return TRAFFIC_VIEW_KEYS[view] ?? TRAFFIC_VIEW_KEYS[DEFAULT_TRAFFIC_VIEW];
}

/** i18n key of a template's one-line description, with the default as the fallback. */
export function trafficViewHintKey(view) {
  return TRAFFIC_VIEW_HINTS[view] ?? TRAFFIC_VIEW_HINTS[DEFAULT_TRAFFIC_VIEW];
}

/** Turns a setting into the template that is actually drawn. */
export function resolveTrafficView(setting) {
  return TRAFFIC_VIEWS.includes(setting) ? setting : DEFAULT_TRAFFIC_VIEW;
}

/** What the resolved template does with each reading. */
export function trafficViewParts(view) {
  return TRAFFIC_VIEW_PARTS[resolveTrafficView(view)];
}
