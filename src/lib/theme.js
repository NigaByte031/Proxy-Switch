/**
 * Theme resolution: which palette in `src/styles/base.css` is showing. The light
 * one lives on `:root` and the dark one on `:root[data-theme='dark']`; this is
 * the only place that reads the system preference, so the setting and the
 * stylesheet can never disagree.
 */

import { ACCENTS, THEMES } from './model.js';

/** Default value of `settings.theme`. */
export const DEFAULT_THEME = 'auto';

/** Default value of `settings.accent`. */
export const DEFAULT_ACCENT = 'emerald';

/** i18n key per accent setting. */
export const ACCENT_KEYS = {
  emerald: 'accent.emerald',
  ocean: 'accent.ocean',
  violet: 'accent.violet',
  amber: 'accent.amber',
  rose: 'accent.rose',
};

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

/** i18n key naming the palette, so the picker can label each swatch. */
export function accentKey(accent) {
  return ACCENT_KEYS[accent] ?? ACCENT_KEYS[DEFAULT_ACCENT];
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

/** Turns a setting into the palette that is actually shown. */
export function resolveAccent(setting) {
  return ACCENTS.includes(setting) ? setting : DEFAULT_ACCENT;
}

/**
 * Writes the palette onto the document element, next to `data-theme` — the pair
 * `src/styles/base.css` keys its palette blocks off.
 * @returns {string} the accent that is now active
 */
export function applyAccent(setting, doc = globalThis.document) {
  const accent = resolveAccent(setting);
  if (doc?.documentElement) doc.documentElement.dataset.accent = accent;
  return accent;
}

/**
 * Calls `callback(isDark)` whenever the operating system switches appearance, so
 * an "auto" setting follows along while a page stays open.
 * @returns {() => void} unsubscribe
 */
export function watchSystemTheme(callback, win = globalThis) {
  const query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query?.addEventListener) return () => {};
  const listener = (event) => callback(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
