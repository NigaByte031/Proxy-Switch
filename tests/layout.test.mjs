import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DENSITIES, TEXT_SIZES, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES, SUPPORTED_LANGS } from '../src/lib/i18n.js';
import {
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  DENSITY_KEYS,
  TEXT_SIZE_KEYS,
  applyLayout,
  densityKey,
  resolveDensity,
  resolveTextSize,
  textSizeKey,
} from '../src/lib/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const SHEETS = ['src/styles/base.css', 'src/styles/popup.css', 'src/styles/options.css'];
const CSS = SHEETS.map(read).join('\n');

test('spacing and text size default to what the extension shipped with', () => {
  const defaults = createDefaultState().settings;
  assert.equal(defaults.density, DEFAULT_DENSITY);
  assert.equal(defaults.textSize, DEFAULT_TEXT_SIZE);
  assert.deepEqual(DENSITIES, ['comfortable', 'compact']);
  assert.deepEqual(TEXT_SIZES, ['normal', 'large']);

  for (const density of DENSITIES) {
    assert.equal(sanitizeState({ settings: { density } }).settings.density, density);
  }
  for (const textSize of TEXT_SIZES) {
    assert.equal(sanitizeState({ settings: { textSize } }).settings.textSize, textSize);
  }

  // A hand-edited file cannot put a value in the stylesheet that CSS has no block
  // for: unknown settings fall back instead of leaving the page unstyled.
  assert.equal(sanitizeState({ settings: { density: 'tiny' } }).settings.density, DEFAULT_DENSITY);
  assert.equal(sanitizeState({ settings: { textSize: 'huge' } }).settings.textSize, DEFAULT_TEXT_SIZE);
  assert.equal(sanitizeState({ settings: { density: 7, textSize: null } }).settings.density, DEFAULT_DENSITY);
  assert.equal(sanitizeState(null).settings.textSize, DEFAULT_TEXT_SIZE);
});

test('every setting has a name in both languages, and junk resolves to the default', () => {
  for (const density of DENSITIES) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][densityKey(density)], `${density} is missing in ${lang}`);
    }
  }
  for (const textSize of TEXT_SIZES) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][textSizeKey(textSize)], `${textSize} is missing in ${lang}`);
    }
  }

  for (const junk of ['nope', '', null, undefined, 42]) {
    assert.equal(densityKey(junk), DENSITY_KEYS[DEFAULT_DENSITY]);
    assert.equal(textSizeKey(junk), TEXT_SIZE_KEYS[DEFAULT_TEXT_SIZE]);
    assert.equal(resolveDensity(junk), DEFAULT_DENSITY);
    assert.equal(resolveTextSize(junk), DEFAULT_TEXT_SIZE);
  }

  // two options that read alike would leave the picker saying nothing
  assert.equal(new Set(DENSITIES.map((d) => MESSAGES.en[densityKey(d)])).size, DENSITIES.length);
  assert.equal(new Set(TEXT_SIZES.map((t) => MESSAGES.en[textSizeKey(t)])).size, TEXT_SIZES.length);
});

test('the layout settings are written onto <html>, where the stylesheet reads them', () => {
  const element = { dataset: {} };
  const doc = { documentElement: element };

  assert.deepEqual(applyLayout('compact', 'large', doc), { density: 'compact', textSize: 'large' });
  assert.equal(element.dataset.density, 'compact');
  assert.equal(element.dataset.text, 'large');

  // and an unknown value never reaches the attribute
  assert.deepEqual(applyLayout('tight', 'huge', doc), {
    density: DEFAULT_DENSITY,
    textSize: DEFAULT_TEXT_SIZE,
  });
  assert.equal(element.dataset.density, 'comfortable');
  assert.equal(element.dataset.text, 'normal');

  // no document (Node, a worker) is not a crash
  assert.deepEqual(applyLayout('compact', 'large', null), { density: 'compact', textSize: 'large' });
});

test('every text size in the stylesheet goes through the scale, so one knob moves them all', () => {
  assert.equal(
    /font-size:\s*[0-9]/.test(CSS),
    false,
    'a raw size would stay put while everything else grew',
  );
  assert.match(CSS, /--type-scale:\s*1;/);
  assert.match(CSS, /:root\[data-text='large'\]\s*\{[\s\S]{0,60}--type-scale:\s*1\.15;/);

  const defined = new Set([...CSS.matchAll(/--fs-[a-z0-9]+:/g)].map((match) => match[0].slice(0, -1)));
  const used = new Set([...CSS.matchAll(/var\((--fs-[a-z0-9]+)\)/g)].map((match) => match[1]));
  assert.ok(used.size >= 10, `the whole sheet should read from the tokens, saw ${used.size}`);
  for (const token of used) {
    assert.ok(defined.has(token), `${token} is used but never defined`);
  }

  // `normal` has to be pixel-for-pixel what shipped: each token is its own base
  // multiplied by the scale, not a new hand-picked number.
  for (const token of defined) {
    assert.match(CSS, new RegExp(`${token}: calc\\([0-9.]+px \\* var\\(--type-scale\\)\\)`), token);
  }
});

test('compact spacing moves padding and gaps, and hides nothing', () => {
  const base = read('src/styles/base.css');
  const start = base.indexOf(":root[data-density='compact']");
  // the leading newline skips the mention of this selector in the file's header
  const end = base.indexOf("\n:root[data-theme='dark'] {");
  assert.ok(start > -1 && end > start, 'the compact block sits before the dark palette');
  const compact = base.slice(start, end);

  assert.ok(compact.length > 200, 'the block has rules in it');
  assert.ok(!/display:\s*none/.test(compact), 'compaction must not take a figure or a button away');
  assert.ok(!/visibility:\s*hidden/.test(compact));
  assert.ok(!/font-size/.test(compact), 'that is the text-size setting\'s job');
  // the two pages that exist
  assert.match(compact, /:root\[data-density='compact'\] body\.popup/);
  assert.match(compact, /:root\[data-density='compact'\] body\.options/);
});

test('both pages read the two settings, and the settings page writes them', () => {
  const options = read('src/options.html');
  assert.match(options, /id="densitySelect"/);
  assert.match(options, /id="textSizeSelect"/);
  assert.match(options, /data-i18n="options.density"/);
  assert.match(options, /data-i18n="options.textSize"/);

  // the pickers offer exactly what the setting accepts, in list order
  const density = options.slice(options.indexOf('id="densitySelect"'));
  const drawnDensity = [...density.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]).slice(0, 2);
  assert.deepEqual(drawnDensity, DENSITIES);
  const textSize = options.slice(options.indexOf('id="textSizeSelect"'));
  const drawnText = [...textSize.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]).slice(0, 2);
  assert.deepEqual(drawnText, TEXT_SIZES);

  const source = read('src/options.js');
  assert.match(source, /densitySelect: el\('densitySelect'\)/);
  assert.match(source, /textSizeSelect: el\('textSizeSelect'\)/);
  assert.match(source, /draft\.settings\.density = density/);
  assert.match(source, /draft\.settings\.textSize = textSize/);
  assert.match(source, /applyLayout\(state\.settings\.density, state\.settings\.textSize\)/);

  // and the popup wears whatever the settings page picked
  const popup = read('src/popup.js');
  assert.match(popup, /from '\.\/lib\/theme\.js'/);
  assert.match(popup, /applyLayout\(state\.settings\.density, state\.settings\.textSize\)/);

  assert.ok(
    MESSAGES.en['options.density'] && MESSAGES.fa['options.density'],
    'the settings field needs its label in both languages',
  );
  assert.ok(MESSAGES.en['options.textSize'] && MESSAGES.fa['options.textSize']);
});
