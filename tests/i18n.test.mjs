import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LANG_LABELS,
  MESSAGES,
  SUPPORTED_LANGS,
  applyStaticText,
  isRtl,
  missingKeys,
  modeKey,
  otherLang,
  resolveLang,
  t,
} from '../src/lib/i18n.js';
import { PROXY_MODES } from '../src/lib/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['src/popup.html', 'src/options.html'];

test('both dictionaries define exactly the same keys', () => {
  for (const lang of SUPPORTED_LANGS) {
    assert.deepEqual(missingKeys()[lang], [], `keys missing in ${lang}`);
  }
  assert.ok(Object.keys(MESSAGES.en).length > 60);
});

test('no translation is empty or accidentally left in English', () => {
  for (const [key, value] of Object.entries(MESSAGES.fa)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.trim().length > 0, `${key} is empty`);
  }
  // a handful of strings should genuinely differ between the two languages
  const different = Object.keys(MESSAGES.en).filter((key) => MESSAGES.fa[key] !== MESSAGES.en[key]);
  assert.ok(different.length > 40, 'the Persian dictionary looks untranslated');
});

test('t() interpolates, falls back and never throws', () => {
  assert.equal(t('app.name', 'fr'), 'Proxy Switch');
  assert.equal(t('status.manual.detail', 'en', { name: 'Work', scheme: 'http', host: 'h', port: 1 }), 'Work · http://h:1');
  assert.equal(t('status.pac.detail', 'fa', { url: 'https://x/y.pac' }), 'https://x/y.pac');
  assert.equal(t('nope.missing', 'fa'), 'nope.missing');
  assert.equal(t('status.pac.detail', 'en'), '{url}');
});

test('language resolution and direction', () => {
  assert.equal(resolveLang('auto', 'fa-IR'), 'fa');
  assert.equal(resolveLang('auto', 'en-GB'), 'en');
  assert.equal(resolveLang('auto', undefined), 'en');
  assert.equal(resolveLang('fa', 'en-US'), 'fa');
  assert.equal(resolveLang('en', 'fa-IR'), 'en');
  assert.equal(resolveLang('de', 'fa'), 'fa');

  assert.equal(otherLang('en'), 'fa');
  assert.equal(otherLang('fa'), 'en');
  assert.equal(isRtl('fa'), true);
  assert.equal(isRtl('en'), false);
  for (const lang of SUPPORTED_LANGS) assert.ok(LANG_LABELS[lang]);
});

function i18nKeysIn(html) {
  const keys = new Set();
  const pattern = /data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) keys.add(match[1]);
  return [...keys];
}

test('every key used in the pages exists in both languages', () => {
  for (const page of PAGES) {
    const keys = i18nKeysIn(readFileSync(join(ROOT, page), 'utf8'));
    assert.ok(keys.length > 20, `${page} should use data-i18n attributes`);
    for (const key of keys) {
      for (const lang of SUPPORTED_LANGS) {
        assert.ok(MESSAGES[lang][key], `${page}: ${key} is missing in ${lang}`);
      }
    }
  }
});

test('every key referenced from JavaScript exists in both languages', () => {
  const keyPattern = /\bt\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)'/g;
  const files = [
    ...readdirSync(join(ROOT, 'src'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join('src', name)),
    ...readdirSync(join(ROOT, 'src', 'lib')).map((name) => join('src', 'lib', name)),
  ];

  let checked = 0;
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const match of source.matchAll(keyPattern)) {
      checked += 1;
      for (const lang of SUPPORTED_LANGS) {
        assert.ok(MESSAGES[lang][match[1]], `${file}: ${match[1]} is missing in ${lang}`);
      }
    }
  }
  assert.ok(checked > 15, `only ${checked} literal keys found in src/`);
});

test('keys assembled at runtime exist too', () => {
  // The mode chips and the mode hint build their keys from the mode name.
  for (const mode of PROXY_MODES) {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(MESSAGES[lang][modeKey(mode, 'mode.hint')], `${mode} hint (${lang})`);
      assert.ok(MESSAGES[lang][modeKey(mode)], `${mode} label (${lang})`);
    }
  }
  assert.equal(modeKey('fixed_servers', 'mode.hint'), 'mode.hint.manual');
  assert.equal(modeKey('pac_script'), 'mode.pac');
  // and the language button label
  assert.equal(otherLang('en'), 'fa');
});

test('applyStaticText fills elements and attributes', () => {
  const element = (attributes, text = '') => {
    const node = {
      textContent: text,
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      attributes,
    };
    return node;
  };

  const text = element({ 'data-i18n': 'app.name' });
  const title = element({ 'data-i18n-title': 'action.settings' });
  const placeholder = element({ 'data-i18n-placeholder': 'field.hostPlaceholder' });
  const aria = element({ 'data-i18n-aria-label': 'action.settings' });

  const root = { querySelectorAll: (selector) => ({ '[data-i18n]': [text], '[data-i18n-title]': [title], '[data-i18n-placeholder]': [placeholder], '[data-i18n-aria-label]': [aria] })[selector] ?? [] };

  applyStaticText(root, 'fa');
  assert.equal(text.textContent, 'پروکسی سوئیچ');
  assert.equal(title.attributes.title, 'تنظیمات');
  assert.equal(placeholder.attributes.placeholder, MESSAGES.fa['field.hostPlaceholder']);
  assert.equal(aria.attributes['aria-label'], 'تنظیمات');
});
