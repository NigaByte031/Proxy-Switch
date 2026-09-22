import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEMES, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES, SUPPORTED_LANGS } from '../src/lib/i18n.js';
import {
  DEFAULT_THEME,
  THEME_ICONS,
  THEME_KEYS,
  applyTheme,
  nextTheme,
  prefersDark,
  resolveTheme,
  themeIcon,
  themeKey,
  watchSystemTheme,
} from '../src/lib/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

test('the theme setting defaults to auto and survives sanitizing', () => {
  assert.equal(createDefaultState().settings.theme, DEFAULT_THEME);
  assert.deepEqual(THEMES, ['auto', 'light', 'dark']);
  assert.equal(sanitizeState({ settings: { theme: 'dark' } }).settings.theme, 'dark');
  assert.equal(sanitizeState({ settings: { theme: 'neon' } }).settings.theme, 'auto');
  assert.equal(sanitizeState(null).settings.theme, 'auto');
  // the setting is part of a backup
  assert.equal(sanitizeState({ settings: { theme: 'light' } }).settings.theme, 'light');
});

test('every theme setting has a label in both languages', () => {
  for (const theme of THEMES) {
    assert.ok(themeIcon(theme), `${theme} has no icon`);
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][themeKey(theme)], `${theme} label is missing in ${lang}`);
    }
  }
  // unknown values fall back to the default instead of showing "undefined"
  assert.equal(themeKey('nope'), THEME_KEYS[DEFAULT_THEME]);
  assert.equal(themeIcon('nope'), THEME_ICONS[DEFAULT_THEME]);
});

test('resolveTheme only lets "auto" fall back to the system preference', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme(undefined, true), 'dark');
  assert.equal(resolveTheme('nonsense', false), 'light');
});

test('nextTheme cycles through all three settings', () => {
  assert.equal(nextTheme('auto'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'auto');
  // an unknown value behaves like "auto" so the button always moves on
  assert.equal(nextTheme('nonsense'), 'light');
  const seen = new Set();
  let theme = DEFAULT_THEME;
  for (let step = 0; step < THEMES.length; step += 1) {
    seen.add(theme);
    theme = nextTheme(theme);
  }
  assert.deepEqual([...seen].sort(), [...THEMES].sort());
  assert.equal(theme, DEFAULT_THEME, 'the cycle must come back around');
});

test('applyTheme writes the resolved theme onto <html>', () => {
  const doc = { documentElement: { dataset: {} } };
  assert.equal(applyTheme('dark', doc, false), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');

  assert.equal(applyTheme('auto', doc, true), 'dark');
  assert.equal(applyTheme('light', doc, true), 'light');
  assert.equal(doc.documentElement.dataset.theme, 'light');

  // never throws without a document (tests, service worker contexts)
  assert.equal(applyTheme('auto', undefined, true), 'dark');
  assert.equal(applyTheme('auto', {}, true), 'dark');
});

test('prefersDark reads matchMedia, and watchSystemTheme follows it', () => {
  assert.equal(prefersDark(undefined), false);
  assert.equal(prefersDark({}), false);
  assert.equal(prefersDark({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersDark({ matchMedia: () => ({ matches: false }) }), false);

  const listeners = new Set();
  const query = {
    matches: false,
    addEventListener: (type, listener) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (type, listener) => listeners.delete(listener),
  };
  const win = {
    matchMedia: (feature) => {
      assert.equal(feature, '(prefers-color-scheme: dark)');
      return query;
    },
  };

  const seen = [];
  const stop = watchSystemTheme((dark) => seen.push(dark), win);
  assert.equal(listeners.size, 1, 'the change listener must be registered');
  for (const listener of listeners) listener({ matches: true });
  assert.deepEqual(seen, [true]);
  stop();
  assert.equal(listeners.size, 0, 'unsubscribing must remove the listener');

  // browsers (and Node) without matchMedia must not crash the caller
  assert.equal(typeof watchSystemTheme(() => {}, {}), 'function');
  assert.equal(typeof watchSystemTheme(() => {}, undefined), 'function');
});

/* ------------------------------------------------------------------ *
 * The stylesheet and the pages
 * ------------------------------------------------------------------ */

/** Declarations of one CSS block, without its nested braces being an issue. */
function block(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `${selector} is missing`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index);
    }
  }
  return '';
}

const tokens = (css) => [...new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]))];

test('base.css keeps the light and dark palettes in one place', () => {
  const css = read('src/styles/base.css');
  const lightBlock = block(css, ':root {');
  const darkBlock = block(css, ":root[data-theme='dark'] {");
  const light = tokens(lightBlock);
  const dark = tokens(darkBlock);

  assert.ok(light.length > 30, `only ${light.length} light tokens`);
  assert.ok(dark.length > 25, `only ${dark.length} dark tokens`);

  // the dark palette may only override tokens the light one defines
  for (const token of dark) {
    assert.ok(light.includes(token), `${token} exists only in the dark palette`);
  }

  // shape, easing and the derived gradient stay shared
  for (const shared of ['--radius', '--radius-sm', '--ease', '--gradient-brand', '--ring']) {
    assert.ok(light.includes(shared), `${shared} should be defined once`);
    assert.ok(!dark.includes(shared), `${shared} must not be re-declared for dark`);
  }

  // and the colours must genuinely differ
  const valueOf = (cssBlock, token) => new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(cssBlock)[1].trim();
  for (const token of ['--bg', '--text', '--muted', '--surface', '--accent']) {
    assert.notEqual(valueOf(lightBlock, token), valueOf(darkBlock, token), `${token} is the same in both palettes`);
  }
});

test('the theme is chosen by the data-theme attribute, not by a media query', () => {
  const css = read('src/styles/base.css');
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light;/);
  assert.match(css, /:root\[data-theme='dark'\]\s*\{[^}]*color-scheme:\s*dark;/);
  // the palette must not switch behind the user's back once they picked a theme
  assert.ok(!/prefers-color-scheme/.test(css), 'the palette still follows the OS in CSS');
  // accessibility queries are unrelated and must stay
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-contrast/);
});

test('both pages expose the theme control and write the setting', () => {
  const options = read('src/options.html');
  for (const theme of THEMES) {
    assert.match(options, new RegExp(`<option value="${theme}"`), `options.html: ${theme}`);
  }
  assert.match(options, /id="themeSelect"/);

  const popup = read('src/popup.html');
  assert.match(popup, /id="themeBtn"/);
  assert.match(popup, /data-i18n-title="theme.switch"/);

  for (const page of ['src/options.js', 'src/popup.js']) {
    const source = read(page);
    assert.match(source, /settings\.theme/, `${page} must read the theme setting`);
    assert.match(source, /applyTheme\(/, `${page} must apply the theme`);
  }
  assert.match(read('src/options.js'), /settings\.theme = theme/);
  assert.match(read('src/popup.js'), /nextTheme\(/);
});
