/**
 * Theme resolution.
 *
 * `src/styles/base.css` ships two palettes: the light one on `:root` and the
 * dark one on `:root[data-theme='dark']`. This module decides which of the two
 * is showing and is the only place that reads the system preference, so the
 * setting ("auto" / "light" / "dark") and the stylesheet can never disagree.
 *
 * Dependency-free and DOM-light, so it can be unit tested in Node.
 */

import { THEMES } from './model.js';

/** Default value of `settings.theme`. */
export const DEFAULT_THEME = 'auto';

/** i18n key per theme setting. */
export const THEME_KEYS = {
  auto: 'theme.auto',
  light: 'theme.light',
  dark: 'theme.dark',
};

/** Popup button glyph, one per setting. */
export const THEME_ICONS = {
  auto: '◐',
  light: '☀',
  dark: '☾',
};

export function themeKey(theme) {
  return THEME_KEYS[theme] ?? THEME_KEYS[DEFAULT_THEME];
}

export function themeIcon(theme) {
  return THEME_ICONS[theme] ?? THEME_ICONS[DEFAULT_THEME];
}

/** Cycles `auto -> light -> dark -> auto`, so one button covers all three. */
export function nextTheme(theme) {
  const current = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}

/** Reads `prefers-color-scheme` (no window/matchMedia means "light"). */
export function prefersDark(win = globalThis) {
  return win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
}

/** Turns a setting into the theme that is actually shown. */
export function resolveTheme(setting, dark = prefersDark()) {
  if (setting === 'light' || setting === 'dark') return setting;
  return dark ? 'dark' : 'light';
}

/**
 * Writes the resolved theme onto the document element, where the CSS looks for it.
 * @returns {string} the theme that is now active
 */
export function applyTheme(setting, doc = globalThis.document, dark = prefersDark()) {
  const theme = resolveTheme(setting, dark);
  if (doc?.documentElement) doc.documentElement.dataset.theme = theme;
  return theme;
}

/**
 * Calls `callback(isDark)` whenever the operating system switches appearance,
 * so an "auto" setting can follow along while a page stays open.
 * @returns {() => void} unsubscribe
 */
export function watchSystemTheme(callback, win = globalThis) {
  const query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query?.addEventListener) return () => {};
  const listener = (event) => callback(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
