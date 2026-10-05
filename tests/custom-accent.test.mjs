import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CUSTOM_ACCENT,
  contrastRatio,
  customAccentTokens,
  describeCustomAccent,
  mixHex,
  normalizeHex,
  parseHex,
  readableTextColour,
} from '../src/lib/color.js';
import { ACCENT_CHOICES, CUSTOM_ACCENT, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES, SUPPORTED_LANGS } from '../src/lib/i18n.js';
import { ACCENT_KEYS, applyAccent, resolveAccent } from '../src/lib/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');
const HEX = /^#[0-9a-f]{6}$/;

test('the sanitizer accepts any spelling and rejects what is not a colour', () => {
  assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex('4c6ef5'), { r: 76, g: 110, b: 245 });
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('  #4C6EF5  '), '#4c6ef5');
  assert.equal(normalizeHex('#0e9f6e'), DEFAULT_CUSTOM_ACCENT);

  for (const junk of ['', '#12', 'red', '#12345', '#1234567', null, undefined, 42, {}]) {
    assert.equal(parseHex(junk), null, `${String(junk)} should not parse`);
    assert.equal(normalizeHex(junk), null, `${String(junk)} should not normalize`);
  }
});

test('the contrast check knows black from white', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(readableTextColour('#111111'), '#ffffff');
  assert.equal(readableTextColour('#fafafa'), '#000000');

  // and the derived tokens always name a readable label colour
  for (const value of ['#4c6ef5', '#000000', '#ffffff', '#0e9f6e']) {
    assert.ok(['#000000', '#ffffff'].includes(readableTextColour(value)));
  }
});

test('the colour is blended, never lost, when a value cannot be parsed', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('nonsense', '#ffffff', 0.5), '#ffffff');
  assert.equal(mixHex('nonsense', 'also-nonsense', 0.5), DEFAULT_CUSTOM_ACCENT);
});

test('a custom accent derives the brand tokens from the one colour', () => {
  const tokens = customAccentTokens('#4c6ef5');
  assert.deepEqual(Object.keys(tokens).sort(), [
    '--accent',
    '--accent-2',
    '--brand-1',
    '--brand-2',
    '--brand-contrast',
  ]);
  assert.equal(tokens['--accent'], '#4c6ef5');
  for (const [token, value] of Object.entries(tokens)) {
    assert.ok(['#000000', '#ffffff'].includes(value) || HEX.test(value), `${token}: ${value}`);
  }
  // an unknown colour falls back rather than writing something invalid
  assert.equal(customAccentTokens('nope')['--accent'], DEFAULT_CUSTOM_ACCENT);
});

test('the colour report names the value and both contrasts', () => {
  const report = describeCustomAccent('#4c6ef5');
  assert.equal(report.hex, '#4c6ef5');
  assert.ok(report.onWhite > 1 && report.onWhite < 21);
  assert.ok(report.onBlack > 1 && report.onBlack < 21);
  assert.ok(['#000000', '#ffffff'].includes(report.label));
  assert.equal(describeCustomAccent('nope'), null);
});

test('the setting defaults to emerald and survives sanitizing', () => {
  const defaults = createDefaultState().settings;
  assert.equal(defaults.accent, 'emerald');
  assert.equal(defaults.customAccent, DEFAULT_CUSTOM_ACCENT);

  assert.ok(ACCENT_CHOICES.includes(CUSTOM_ACCENT));
  assert.equal(sanitizeState({ settings: { accent: CUSTOM_ACCENT } }).settings.accent, 'custom');
  assert.equal(
    sanitizeState({ settings: { customAccent: '#4C6EF5' } }).settings.customAccent,
    '#4c6ef5',
  );
  // a hand-edited file or a foreign import cannot smuggle in anything else
  assert.equal(
    sanitizeState({ settings: { customAccent: 'javascript:alert(1)' } }).settings.customAccent,
    DEFAULT_CUSTOM_ACCENT,
  );
  assert.equal(sanitizeState(null).settings.customAccent, DEFAULT_CUSTOM_ACCENT);
  // and the colour travels in a backup
  const restored = sanitizeState({ settings: { accent: 'custom', customAccent: '#b197fc' } });
  assert.equal(restored.settings.accent, 'custom');
  assert.equal(restored.settings.customAccent, '#b197fc');
});

test('every accent value has a label in both languages', () => {
  for (const accent of ACCENT_CHOICES) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][ACCENT_KEYS[accent]], `${accent} label is missing in ${lang}`);
    }
  }
  assert.equal(ACCENT_KEYS.custom, 'accent.custom');
});

/** A document element with just enough of the DOM to record inline tokens. */
function fakeDoc() {
  const props = new Map();
  return {
    props,
    documentElement: {
      dataset: {},
      style: {
        setProperty: (name, value) => props.set(name, value),
        removeProperty: (name) => props.delete(name),
      },
    },
  };
}

test('a custom accent writes its tokens inline, and a preset clears them', () => {
  const doc = fakeDoc();
  assert.equal(applyAccent('custom', doc, '#4c6ef5'), 'custom');
  assert.equal(doc.documentElement.dataset.accent, 'custom');
  assert.equal(doc.props.get('--accent'), '#4c6ef5');
  assert.equal(doc.props.size, 5);

  // choosing a preset again must not leave the custom colour in force
  assert.equal(applyAccent('ocean', doc), 'ocean');
  assert.equal(doc.documentElement.dataset.accent, 'ocean');
  assert.equal(doc.props.size, 0);

  // and a custom accent without a usable colour falls back to the shipped one
  assert.equal(applyAccent('custom', doc, 'nope'), 'custom');
  assert.equal(doc.props.get('--accent'), DEFAULT_CUSTOM_ACCENT);

  assert.equal(resolveAccent('custom'), 'custom');
  assert.equal(resolveAccent('neon'), 'emerald');
  // never throws without a document (tests, service worker contexts)
  assert.equal(applyAccent('custom', undefined, '#4c6ef5'), 'custom');
});

/* The stylesheet and the pages. */

test('base.css derives the custom palette per theme, and touches nothing else', () => {
  const css = read('src/styles/base.css');
  assert.match(css, /:root\[data-accent='custom'\]\s*\{/);
  assert.match(css, /:root\[data-theme='dark'\]\[data-accent='custom'\]\s*\{/);
  assert.match(css, /:root\[data-accent='custom'\][\s\S]{0,200}color-mix\(in srgb, var\(--accent\)/);
  // the mode and feedback colours stay put, exactly as for a preset
  for (const token of ['--pac', '--sys', '--ok', '--warn', '--danger']) {
    assert.ok(!new RegExp(`custom'\\][\\s\\S]{0,200}${token}\\s*:`).test(css), `${token} must not move`);
  }
});

test('the settings page offers a picker and a hex field, both wired', () => {
  const html = read('src/options.html');
  assert.match(html, /id="customAccentColor"[^>]*type="color"/);
  assert.match(html, /id="customAccentHex"/);
  assert.match(html, /data-i18n="accent.custom"/);
  assert.match(html, /data-i18n="accent.customHint"/);

  const source = read('src/options.js');
  assert.match(source, /draft\.settings\.customAccent = hex/);
  assert.match(source, /draft\.settings\.accent = CUSTOM_ACCENT/);
  assert.match(source, /normalizeHex\(/);
  assert.match(source, /applyAccent\(state\.settings\.accent, document, state\.settings\.customAccent\)/);
});

test('both pages wear the custom colour the settings page saved', () => {
  for (const page of ['src/options.js', 'src/popup.js']) {
    const source = read(page);
    assert.match(
      source,
      /applyAccent\(state\.settings\.accent, document, state\.settings\.customAccent\)/,
      `${page} must hand the custom colour to applyAccent`,
    );
  }
  assert.ok(
    !/settings\.accent\s*=/.test(read('src/popup.js')),
    'the popup must not write the accent',
  );
});
