import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCENTS, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES, SUPPORTED_LANGS } from '../src/lib/i18n.js';
import {
  ACCENT_KEYS,
  DEFAULT_ACCENT,
  accentKey,
  applyAccent,
  resolveAccent,
} from '../src/lib/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

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
const valueOf = (cssBlock, token) =>
  new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(cssBlock)?.[1].trim() ?? null;

/** Relative luminance of a `#rrggbb` value, for the light/dark sanity checks. */
function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('the accent setting defaults to the shipped palette and survives sanitizing', () => {
  assert.equal(createDefaultState().settings.accent, DEFAULT_ACCENT);
  assert.equal(DEFAULT_ACCENT, 'emerald');
  assert.ok(ACCENTS.includes(DEFAULT_ACCENT), 'the default must be one of the palettes');

  for (const accent of ACCENTS) {
    assert.equal(sanitizeState({ settings: { accent } }).settings.accent, accent);
  }
  // a hand-edited storage or an imported file cannot invent a palette
  assert.equal(sanitizeState({ settings: { accent: 'neon' } }).settings.accent, DEFAULT_ACCENT);
  assert.equal(sanitizeState({ settings: { accent: 42 } }).settings.accent, DEFAULT_ACCENT);
  assert.equal(sanitizeState(null).settings.accent, DEFAULT_ACCENT);
  // and the choice travels in a backup, like the theme does
  assert.equal(sanitizeState({ settings: { theme: 'dark', accent: 'ocean' } }).settings.accent, 'ocean');
});

test('every palette has a label in both languages', () => {
  for (const accent of ACCENTS) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][accentKey(accent)], `${accent} label is missing in ${lang}`);
    }
  }
  // a value nobody defined falls back to the default label, never to "undefined"
  assert.equal(accentKey('neon'), ACCENT_KEYS[DEFAULT_ACCENT]);
  assert.equal(resolveAccent('neon'), DEFAULT_ACCENT);
  assert.equal(resolveAccent(undefined), DEFAULT_ACCENT);
  assert.equal(resolveAccent('rose'), 'rose');
});

test('applyAccent writes the palette onto <html>, next to data-theme', () => {
  const doc = { documentElement: { dataset: { theme: 'dark' } } };
  assert.equal(applyAccent('violet', doc), 'violet');
  assert.equal(doc.documentElement.dataset.accent, 'violet');
  assert.equal(doc.documentElement.dataset.theme, 'dark', 'the theme must be left alone');

  assert.equal(applyAccent('neon', doc), DEFAULT_ACCENT);
  assert.equal(doc.documentElement.dataset.accent, DEFAULT_ACCENT);

  // never throws without a document (tests, service worker contexts)
  assert.equal(applyAccent('rose', undefined), 'rose');
  assert.equal(applyAccent('rose', {}), 'rose');
});

/* The palettes in the stylesheet. */

const CSS = read('src/styles/base.css');
const LIGHT = block(CSS, ':root {');
const DARK = block(CSS, ":root[data-theme='dark'] {");

/** The brand tokens of one palette, in both themes. */
const paletteOf = (accent) => ({
  light: block(CSS, `:root[data-accent='${accent}']`),
  dark: block(CSS, `:root[data-theme='dark'][data-accent='${accent}']`),
});

test('base.css ships one palette block per accent, in both themes', () => {
  for (const accent of ACCENTS) {
    for (const [theme, source] of Object.entries(paletteOf(accent))) {
      const declared = tokens(source);
      assert.ok(declared.length >= 8, `${accent}/${theme} only repaints ${declared.length} tokens`);
      // a palette may only repaint tokens the base palettes already define
      const known = tokens(theme === 'light' ? LIGHT : DARK);
      for (const token of declared) {
        assert.ok(known.includes(token), `${accent}/${theme}: ${token} is unknown to the ${theme} palette`);
      }
    }
  }

  // The shipped palette is written out twice on purpose, so the copy is held to the
  // base palette, token for token.
  for (const [theme, base] of Object.entries({ light: LIGHT, dark: DARK })) {
    const shipped = paletteOf(DEFAULT_ACCENT)[theme];
    for (const token of tokens(shipped)) {
      assert.equal(
        valueOf(shipped, token),
        valueOf(base, token),
        `emerald/${theme}: ${token} drifted from the palette on :root`,
      );
    }
  }

  // and no two palettes may be the same colour
  for (const theme of ['light', 'dark']) {
    const seen = ACCENTS.map((accent) => valueOf(paletteOf(accent)[theme], '--accent'));
    assert.deepEqual([...new Set(seen)], seen, `${theme}: two palettes share a colour`);
  }
});

test('the mode hues and the feedback colours stay put in every palette', () => {
  // a green "reachable" chip must stay green whatever colour the brand wears
  for (const accent of ACCENTS) {
    for (const [theme, source] of Object.entries(paletteOf(accent))) {
      for (const token of ['--pac', '--sys', '--ok', '--warn', '--danger', '--radius', '--ease']) {
        assert.equal(valueOf(source, token), null, `${accent}/${theme} must not repaint ${token}`);
      }
    }
  }
});

test('every palette is readable: light softs are light, dark ones are dark', () => {
  for (const accent of ACCENTS) {
    const { light, dark } = paletteOf(accent);

    const lightAccent = luminance(valueOf(light, '--accent'));
    const lightSoft = luminance(valueOf(light, '--accent-soft'));
    assert.ok(lightAccent < 0.6, `${accent}: ${valueOf(light, '--accent')} is too pale for white`);
    assert.ok(lightSoft > 0.6, `${accent}: ${valueOf(light, '--accent-soft')} is not a light tint`);

    // the dark halves undo the same two, and the accent must not sink into #0b1113
    const darkAccent = luminance(valueOf(dark, '--accent'));
    const darkSoft = luminance(valueOf(dark, '--accent-soft'));
    assert.ok(darkAccent > 0.2, `${accent}: ${valueOf(dark, '--accent')} is too dark for the dark theme`);
    assert.ok(darkSoft < 0.15, `${accent}: ${valueOf(dark, '--accent-soft')} is not a dark tint`);
  }
});

test('a swatch paints itself with the palette it offers', () => {
  // the blocks are keyed off the attribute, so the picker reuses them
  for (const accent of ACCENTS) {
    assert.match(
      CSS,
      new RegExp(`:root\\[data-accent='${accent}'\\],\\s*\\[data-accent='${accent}'\\]\\s*\\{`),
      `${accent} must apply to the document element and to a swatch`,
    );
  }
  const options = read('src/styles/options.css');
  assert.match(options, /\.swatch-dot\s*\{[^}]*var\(--brand-1\)/s);
  assert.match(options, /\.swatch-dot\s*\{[^}]*var\(--brand-2\)/s);
});

/* The pages. */

test('the settings page offers a swatch per palette and saves the choice', () => {
  const html = read('src/options.html');
  assert.match(html, /id="accentSwatches"/);
  assert.match(html, /id="accentSwatches"[\s\S]{0,220}role="radiogroup"/);
  assert.match(html, /data-i18n="accent.title"/);

  const source = read('src/options.js');
  // the row is drawn from ACCENTS, so it cannot fall behind the settings model
  assert.match(source, /for \(const accent of ACCENTS\)/);
  assert.match(source, /settings\.accent = accent/);
  assert.match(source, /applyAccent\(/);
  assert.match(source, /role', 'radio'/);
});

test('both pages wear the saved palette', () => {
  for (const page of ['src/options.js', 'src/popup.js']) {
    const source = read(page);
    assert.match(source, /settings\.accent/, `${page} must read the accent setting`);
    assert.match(source, /applyAccent\(/, `${page} must apply the accent`);
  }
  // only the settings page may change it: the popup is not a colour picker
  assert.ok(!/settings\.accent\s*=/.test(read('src/popup.js')), 'the popup must not write the accent');
});
