import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_PAGES, PREVIEW_STUB_TAG, planPreviews } from '../tools/build-previews.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

test('manifest basics', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name.length > 0 && manifest.name.length <= 45, 'Chrome caps the name at 45 chars');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 132, 'description must fit 132 chars');
  assert.ok(manifest.minimum_chrome_version);
  assert.equal(manifest.background.type, 'module', 'the service worker uses import statements');
});

test('package.json and manifest agree', () => {
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.name, 'proxy-switch');
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined, 'the extension must stay dependency-free');
});

test('the extension requests a minimal, documented permission set', () => {
  assert.deepEqual(manifest.permissions, [
    'proxy',
    'storage',
    'webRequest',
    'webRequestAuthProvider',
    'contextMenus',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test('every file the manifest points at exists', () => {
  const referenced = [
    manifest.action.default_popup,
    manifest.options_page,
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const file of referenced) {
    assert.ok(existsSync(join(ROOT, file)), `missing ${file}`);
  }
});

test('icons are real PNGs of the matching size', () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const buffer = readFileSync(join(ROOT, file));
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
    assert.equal(buffer.readUInt32BE(16), Number(size), `${file} width`);
    assert.equal(buffer.readUInt32BE(20), Number(size), `${file} height`);
    assert.ok(statSync(join(ROOT, file)).size < 64 * 1024, `${file} is too large`);
  }
});

test('the pages only reference local files that exist', () => {
  const pages = [
    manifest.action.default_popup,
    manifest.options_page,
    ...PREVIEW_PAGES.map((page) => page.target),
  ];
  for (const page of pages) {
    const html = read(page);
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(references.length > 0, `${page} references nothing?`);
    for (const reference of references) {
      if (/^(https?:|data:|#|mailto:)/.test(reference)) continue;
      const target = resolve(join(ROOT, dirname(page)), reference);
      assert.ok(existsSync(target), `${page} references missing ${reference}`);
    }
  }
});

test('the shipped pages do not load the preview stub', () => {
  assert.ok(!read(manifest.action.default_popup).includes(PREVIEW_STUB_TAG));
  assert.ok(!read(manifest.options_page).includes(PREVIEW_STUB_TAG));
});

test('the generated previews are in sync with the real pages', () => {
  for (const entry of planPreviews(ROOT)) {
    assert.notEqual(entry.actual, null, `${entry.target} is missing — run "npm run preview"`);
    assert.equal(entry.actual, entry.expected, `${entry.target} is stale — run "npm run preview"`);
    assert.ok(entry.actual.includes(PREVIEW_STUB_TAG));
  }
});

test('the preview stub tells the truth about the version', () => {
  const stub = read('src/__preview_chrome_stub.js');
  assert.match(stub, new RegExp(`VERSION = '${manifest.version.replace(/\./g, '\\.')}'`));
});

test('the service worker is an ES module with a single bootstrap', () => {
  const worker = read('src/background.js');
  assert.match(worker, /^import /m, 'the worker must import its modules');
  assert.match(worker, /onInstalled\.addListener/);
  assert.match(worker, /onAuthRequired\.addListener/);
  assert.match(worker, /applyProxy\(/, 'the worker must be the one applying the proxy');
  // the popup/options pages write state only
  for (const page of ['src/popup.js', 'src/options.js']) {
    assert.ok(!read(page).includes('applyProxy'), `${page} must not apply the proxy itself`);
  }
});
