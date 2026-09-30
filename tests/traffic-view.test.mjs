import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRAFFIC_VIEWS, createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES, SUPPORTED_LANGS } from '../src/lib/i18n.js';
import {
  DEFAULT_TRAFFIC_VIEW,
  TRAFFIC_VIEW_HINTS,
  TRAFFIC_VIEW_KEYS,
  TRAFFIC_VIEW_PARTS,
  resolveTrafficView,
  trafficViewHintKey,
  trafficViewKey,
  trafficViewParts,
} from '../src/lib/traffic-view.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

test('the template setting defaults to the shipped arrangement and survives sanitizing', () => {
  assert.equal(createDefaultState().settings.trafficView, DEFAULT_TRAFFIC_VIEW);
  assert.ok(TRAFFIC_VIEWS.includes(DEFAULT_TRAFFIC_VIEW));

  for (const view of TRAFFIC_VIEWS) {
    assert.equal(sanitizeState({ settings: { trafficView: view } }).settings.trafficView, view);
  }
  assert.equal(sanitizeState({ settings: { trafficView: 'sparkline' } }).settings.trafficView, DEFAULT_TRAFFIC_VIEW);
  assert.equal(sanitizeState({ settings: { trafficView: 7 } }).settings.trafficView, DEFAULT_TRAFFIC_VIEW);
  assert.equal(sanitizeState({ settings: { trafficView: null } }).settings.trafficView, DEFAULT_TRAFFIC_VIEW);
  assert.equal(sanitizeState(null).settings.trafficView, DEFAULT_TRAFFIC_VIEW);

  // the choice is configuration, so it stays when the rest of it is cleaned up
  const clean = sanitizeState({ settings: { trafficView: 'cards', theme: 'dark' } });
  assert.equal(clean.settings.trafficView, 'cards');
});

test('every template has a name and a description in both languages', () => {
  for (const view of TRAFFIC_VIEWS) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][trafficViewKey(view)], `${view} label is missing in ${lang}`);
      assert.ok(MESSAGES[lang][trafficViewHintKey(view)], `${view} hint is missing in ${lang}`);
    }
  }

  // two templates that read the same would leave the picker saying nothing
  const hints = TRAFFIC_VIEWS.map((view) => MESSAGES.en[trafficViewHintKey(view)]);
  assert.equal(new Set(hints).size, TRAFFIC_VIEWS.length, 'two templates describe themselves alike');
});

test('an unknown template falls back instead of showing "undefined"', () => {
  for (const view of TRAFFIC_VIEWS) assert.equal(resolveTrafficView(view), view);

  for (const junk of ['nope', '', null, undefined, 42, {}]) {
    assert.equal(resolveTrafficView(junk), DEFAULT_TRAFFIC_VIEW);
  }
  assert.equal(trafficViewKey('nope'), TRAFFIC_VIEW_KEYS[DEFAULT_TRAFFIC_VIEW]);
  assert.equal(trafficViewHintKey('nope'), TRAFFIC_VIEW_HINTS[DEFAULT_TRAFFIC_VIEW]);
  assert.equal(trafficViewParts('nope'), TRAFFIC_VIEW_PARTS[DEFAULT_TRAFFIC_VIEW]);
});

test('only the classic template keeps the total out of the readout', () => {
  for (const view of TRAFFIC_VIEWS) {
    assert.equal(trafficViewParts(view).total, view !== 'classic', `${view} and the total`);
  }
});

test('the stylesheet arranges every template, on both readouts', () => {
  const css = read('src/styles/base.css');

  for (const view of TRAFFIC_VIEWS) {
    assert.match(css, new RegExp(`\\.traffic-panel\\[data-view='${view}'\\]`), `${view} panel`);
  }
  for (const view of TRAFFIC_VIEWS.filter((name) => name !== DEFAULT_TRAFFIC_VIEW)) {
    assert.match(css, new RegExp(`\\.traffic-readout\\[data-view='${view}'\\]`), `${view} readout`);
  }

  // the classic template is the look the stylesheet already had, so it only has to
  // hide what the others show: the total row and the "right now" label
  assert.match(css, /\.traffic-panel\[data-view='classic'\] \.traffic-total-row,/);
  assert.match(
    css,
    /\.traffic-panel\[data-view='classic'\] \.traffic-when-rate \{[\s\S]{0,40}display: none;/,
  );
});

test('both pages wear the template the setting names', () => {
  const popup = read('src/popup.html');
  assert.match(popup, /id="trafficPanel"[^>]*data-view="classic"/);
  assert.match(popup, /id="trafficTotalDown"/);
  assert.match(popup, /id="trafficTotalUp"/);
  assert.match(popup, /id="rateRow"[\s\S]{0,180}data-i18n="traffic.rightNow"/);

  const options = read('src/options.html');
  assert.match(options, /id="trafficReadout"[^>]*data-view="classic"/);
  assert.match(options, /id="trafficViewPicker"[\s\S]{0,260}role="radiogroup"/);
  assert.match(options, /id="trafficViewHint"/);

  // the picker offers exactly the templates the setting accepts, in list order —
  // which is the order the arrow keys walk them in
  const picker = options.slice(options.indexOf('id="trafficViewPicker"'));
  const drawn = [...picker.matchAll(/class="view-option"[^>]*data-view="([a-z]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(drawn, TRAFFIC_VIEWS);

  for (const page of ['src/popup.js', 'src/options.js']) {
    const source = read(page);
    assert.match(source, /from '\.\/lib\/traffic-view\.js'/, `${page} must import the templates`);
    assert.match(source, /resolveTrafficView\(/, `${page} must read the setting`);
    assert.match(source, /\.dataset\.view = /, `${page} must draw it`);
  }
  // the popup reads the setting into a local and writes that, so the attribute it
  // ends up with is the resolved template either way
  assert.match(
    read('src/popup.js'),
    /const view = resolveTrafficView\([\s\S]{0,160}\.dataset\.view = view;/,
  );
  assert.match(read('src/options.js'), /draft\.settings\.trafficView = view/);
  assert.match(read('src/options.js'), /trafficViewHintKey\(/);
  assert.match(read('src/popup.js'), /trafficViewParts\(/);
});

test('switching the meter off takes the whole readout with it', () => {
  const source = read('src/popup.js');
  assert.match(source, /els\.trafficPanel\.classList\.toggle\('hidden', !meterOn\)/);
  assert.ok(
    !source.includes('els.trafficRow.classList.toggle'),
    'the panel hides, not one row of it',
  );
});
