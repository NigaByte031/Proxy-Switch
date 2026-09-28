import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage, manifestFor } from '../tools/package.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const firefox = JSON.parse(read('manifest.firefox.json'));
const pkg = JSON.parse(read('package.json'));

/**
 * One extension, two manifests. The Firefox one exists because Firefox has no
 * extension service worker at all (MDN, `manifest.json/background`: "not
 * supported, see Firefox bug 1573659"), so the same `src/background.js` runs
 * there as an event page — everything else is required to stay identical, or
 * the two stores would be shipping two different programs under one name.
 */
test('the Firefox manifest is the Chrome one, except where the browsers differ', () => {
  assert.equal(firefox.manifest_version, 3);
  assert.equal(firefox.version, manifest.version, 'a release is one version');
  assert.equal(firefox.version, pkg.version);
  assert.equal(firefox.name, manifest.name);
  assert.equal(firefox.homepage_url, manifest.homepage_url);
  assert.deepEqual(firefox.icons, manifest.icons);
  assert.deepEqual(firefox.action, manifest.action);
  assert.deepEqual(firefox.commands, manifest.commands);
  assert.equal(firefox.options_page, manifest.options_page);
  assert.deepEqual(firefox.permissions, manifest.permissions, 'the permission set is the product');
  assert.deepEqual(firefox.host_permissions, manifest.host_permissions);

  // The store listing is the one wording that may differ: it names its own
  // browser, and nothing else about the sentence moves.
  assert.equal(firefox.description.replace('Firefox', 'Chrome'), manifest.description);
  assert.ok(firefox.description.includes('Firefox'), 'the Firefox listing must name Firefox');
});

test('the background script is an event page, not a service worker', () => {
  assert.deepEqual(firefox.background.scripts, ['src/background.js']);
  assert.equal(firefox.background.type, 'module', 'the entry point uses import statements');
  assert.equal(firefox.background.service_worker, undefined, 'Firefox refuses service workers in MV3');
  assert.notEqual(firefox.background.persistent, true, 'MV3 event pages may not be persistent');

  // …and the Chrome manifest is left alone: Chrome runs a service worker and
  // has no use for the event-page fallback, so its manifest keeps saying so.
  assert.equal(manifest.background.scripts, undefined);
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(firefox.minimum_chrome_version, undefined, 'a Chrome floor means nothing to Firefox');
  assert.ok(manifest.minimum_chrome_version, 'the Chrome floor still applies to Chrome');
});

test('the Gecko id, the Firefox floor and the data-consent declaration are in place', () => {
  const gecko = firefox.browser_specific_settings?.gecko;
  assert.ok(gecko, 'AMO needs browser_specific_settings.gecko');
  // An email-shaped id (anything@your-domain) rather than a bare string: it is
  // what ties future versions to this listing, and it cannot be changed later.
  assert.match(gecko.id, /^[a-z0-9-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i);

  // 140 is not a preference, it is the oldest version that honours every key
  // this manifest uses: `options_page` and `webRequestAuthProvider` arrived in
  // 126, and `data_collection_permissions` — which AMO requires from every new
  // extension — in 140 (addons-linter says both). Firefox 140 is the ESR line.
  assert.equal(gecko.strict_min_version, '140.0');

  // Since November 2025 AMO refuses a new extension that has not said what it
  // collects. The answer here is the whole point of the extension: nothing —
  // settings, servers and counters stay in local storage and never leave.
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
});

test('the proxy-error listener speaks both browsers\' dialect', () => {
  const worker = read('src/background.js');
  // Firefox renamed `proxy.onProxyError` (deprecated) to `proxy.onError`;
  // Chrome only has the old name.
  assert.match(worker, /chrome\.proxy\?\.onError \?\? chrome\.proxy\?\.onProxyError/);
});

test('every file the Firefox manifest points at exists', () => {
  const referenced = [
    firefox.options_page,
    firefox.background.scripts[0],
    ...Object.values(firefox.icons),
    ...Object.values(firefox.action.default_icon),
    firefox.action.default_popup,
  ];
  for (const file of referenced) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing from the Firefox build`);
  }
});

test('the Firefox package is the same tree under a different manifest', () => {
  assert.equal(manifestFor(true), 'manifest.firefox.json');
  assert.equal(manifestFor(), 'manifest.json');

  const directory = mkdtempSync(join(tmpdir(), 'proxy-switch-firefox-'));
  try {
    const { target, entries } = buildPackage({ root: ROOT, firefox: true, out: join(directory, 'x.zip') });
    assert.equal(basename(target), 'x.zip', 'an explicit destination is honoured');

    // The default name is the contract with the release workflow and with
    // whoever downloads it: the two archives must not collide.
    const natural = buildPackage({ root: ROOT, firefox: true });
    assert.equal(
      basename(natural.target),
      `proxy-switch-v${firefox.version}-firefox.zip`,
      'the Firefox archive has its own name',
    );
    rmSync(natural.target, { force: true });

    assert.equal(entries[0].name, 'manifest.json', 'the store reads manifest.json');
    assert.equal(entries[0].data.toString('utf8'), read('manifest.firefox.json'));

    const names = entries.map((entry) => entry.name);
    assert.equal(names.filter((name) => name === 'manifest.json').length, 1, 'exactly one manifest');
    assert.equal(names.some((name) => name.includes('manifest.firefox.json')), false, 'the variant stays home');
    assert.equal(names.some((name) => name.includes('__preview_')), false, 'preview pages are development-only');
    assert.equal(names.includes('src/background.js'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the worker announces a switch even where notifications have no buttons', () => {
  const worker = read('src/background.js');
  const creates = worker.match(/chrome\.notifications\.create\(/g) ?? [];
  assert.equal(creates.length, 2, 'once with the undo button, once without it');
});
