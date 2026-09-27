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
    'notifications',
    'alarms',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test('every element a page script looks up exists in its own page', () => {
  // `el('id')` returns null rather than throwing, so a renamed input would only
  // show up as a control that silently does nothing. The shared mode control
  // reaches the popup and the settings page the same way.
  for (const [script, page] of [
    ['src/popup.js', 'src/popup.html'],
    ['src/options.js', 'src/options.html'],
  ]) {
    const source = read(script);
    const html = read(page);
    const ids = [...new Set([...source.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]))];

    assert.ok(ids.length > 10, `${script} only looks up ${ids.length} elements`);
    assert.ok(ids.includes('pacDomains') && ids.includes('pacDomainsToggle'), `${script}: domain list`);
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `${page} has no #${id}, which ${script} uses`);
    }
  }
});

test('the settings page explains the notification it asks for', () => {
  // `notifications` exists only for the automatic-switch message, so the page
  // that lists the permissions has to justify it like all the others.
  const html = read('src/options.html');
  assert.match(html, /data-i18n="options\.perm\.notifications"/);
  assert.match(html, /id="notifyToggle"/);
});

test('the settings page explains the timer it asks for', () => {
  // `alarms` exists only for the periodic background check, so the page that
  // lists the permissions justifies it like the others — and the switch that
  // turns it on lives there too.
  const html = read('src/options.html');
  assert.match(html, /data-i18n="options\.perm\.alarms"/);
  assert.match(html, /id="probeToggle"/);
  assert.ok(
    read('src/options.js').includes("draft.settings.backgroundProbe"),
    'the switch has to write the setting the worker reads',
  );
});

test('the background check is a timer in the worker, and only while it is on', () => {
  const worker = read('src/background.js');
  // the alarm is created when the check is allowed and cleared when it is not
  assert.match(worker, /alarms\?\.onAlarm\.addListener/);
  assert.match(worker, /alarms\.create\(PROBE_ALARM/);
  assert.match(worker, /alarms\.clear\(PROBE_ALARM\)/);
  assert.match(worker, /ensureProbeAlarm\(state\)/);
  // a pass only looks at servers the policy says are due …
  assert.match(worker, /probeCandidates\(state\.profiles, health\)/);
  assert.match(worker, /probeEligible\(state\)/);
  // … and a check never leaves its own configuration applied
  assert.match(worker, /isConfigApplied\(await readProxySettings\(\), config\)/);
  // a failover must not run against the check's temporary route, and the check
  // itself is the only writer of the config it installs
  assert.match(worker, /if \(confirming \|\| checking\) return;/);
  assert.match(worker, /checkingProfileId/);
  // and the pages never schedule or apply anything themselves
  for (const page of ['src/popup.js', 'src/options.js']) {
    assert.ok(!read(page).includes('alarms'), `${page} must not run the timer itself`);
  }
});

test('the server list shows what the extension has seen, in both pages', () => {
  // The verdicts are read from storage and handed to the shared list, which is
  // the only place a row is built — so the popup and the settings page cannot
  // disagree about which server answered.
  for (const page of ['src/popup.js', 'src/options.js']) {
    const source = read(page);
    assert.match(source, /loadServerHealth\(/, `${page} must load the verdicts`);
    assert.match(source, /subscribeServerHealth\(/, `${page} must react to a new one`);
    assert.match(source, /getHealth: \(\) => serverHealth/, `${page} must pass them to the list`);
  }

  const list = read('src/lib/servers-ui.js');
  assert.match(list, /describeServerVerdict\(/);
  assert.match(list, /profile-health/);
  // the row wears a tone, and the stylesheet knows the tones
  const css = read('src/styles/base.css');
  assert.match(css, /\.profile-health\[data-tone="ok"\]::before/);
  assert.match(css, /\.profile-health\[data-tone="warn"\]::before/);
});

test('a health verdict reaches the chain, through the worker only', () => {
  const worker = read('src/background.js');
  // a probe the worker runs is attributed to a server …
  assert.match(worker, /probeObservation\(/);
  assert.match(worker, /updateServerHealth\(/);
  // … a new verdict asks for another apply (a chain only changes on an apply)
  assert.match(worker, /subscribeServerHealth\(\(\) => \{\s*sync\(\)/);
  // and the pages may record one, but never push a config themselves
  for (const page of ['src/popup.js', 'src/options.js']) {
    assert.ok(!read(page).includes('applyProxy'), `${page} must not apply the proxy itself`);
  }
});

test('the switch notification is answered in the worker, not in a page', () => {
  const worker = read('src/background.js');
  assert.match(worker, /notifications\?\.create/, 'the worker shows the notification');
  assert.match(worker, /onClicked\.addListener/, 'clicking it must open the server list');
  assert.match(worker, /onButtonClicked\.addListener/, 'the "go back" button must do something');
  assert.match(worker, /failoverUndoTarget\(/, 'the way back is decided by the failover policy');
  assert.match(worker, /clear\(SWITCH_NOTICE_ID\)/, 'an answered notification is taken off the screen');
  assert.match(worker, /openOptionsPage\(/, 'Chrome without action.openPopup still has a fallback');
});

test('the traffic meter counts in the worker, and asks for nothing new', () => {
  const worker = read('src/background.js');
  // the sizes come from observers — this extension never modifies a request
  assert.match(worker, /onBeforeSendHeaders\.addListener/);
  assert.match(worker, /onCompleted\.addListener/);
  assert.match(worker, /\['requestHeaders'\]/, 'without extraInfoSpec there are no headers to read');
  assert.match(worker, /\['responseHeaders'\]/);
  // the bytes are batched, and the extension's own probes are not your traffic
  assert.match(worker, /TRAFFIC_FLUSH_MS/);
  assert.match(worker, /updateTraffic\(\(draft\) => noteTraffic/);
  assert.match(worker, /if \(!meterOn \|\| isProbeUrl\(details\?\.url\)\) return;/);
  // …and the setting is honoured, which only the worker knows about
  assert.match(worker, /meterOn = meterRuns\(state\)/);

  // a page may show the counters and reset them, but never read a request
  for (const page of ['src/popup.js', 'src/options.js']) {
    assert.ok(!read(page).includes('webRequest'), `${page} must not observe requests`);
  }

  // the permission was already there: the meter adds no new warning
  assert.ok(manifest.permissions.includes('webRequest'));
  assert.equal(manifest.permissions.includes('webRequestBlocking'), false);
});

test('the settings page owns the meter switch and the counters', () => {
  const html = read('src/options.html');
  assert.match(html, /id="trafficToggle"/);
  assert.match(html, /data-i18n="traffic.enable"/);
  assert.match(html, /id="trafficToday"/);
  assert.match(html, /id="trafficTotal"/);
  assert.match(html, /id="trafficReset"/);
  assert.ok(
    read('src/options.js').includes('draft.settings.trafficMeter'),
    'the switch has to write the setting the worker reads',
  );

  // the popup shows today's figures, and says what it is really showing
  const popup = read('src/popup.html');
  assert.match(popup, /id="trafficRow"/);
  assert.match(popup, /id="trafficDown"/);
  assert.match(popup, /id="trafficUp"/);
});

test('the keyboard shortcuts are declared in a Chrome-valid shape', () => {
  const commands = manifest.commands;
  assert.ok(commands, 'the commands block is missing');
  assert.ok(commands['toggle-proxy'], 'the toggle shortcut is missing');
  assert.ok(commands['go-direct'], 'the direct shortcut is missing');

  for (const [name, command] of Object.entries(commands)) {
    assert.ok(command.description, `${name} has no description`);
    const key = command.suggested_key?.default;
    assert.match(key ?? '', /^(Ctrl|Alt|Command|MacCtrl)(\+(Shift|Alt|Ctrl))?\+[A-Z0-9]$/, `${name}: ${key}`);
  }
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

test('a retry is a message to the worker, never a second writer', () => {
  const worker = read('src/background.js');
  assert.match(worker, /onMessage\.addListener/);
  assert.match(worker, /REAPPLY_MESSAGE/);

  const options = read('src/options.js');
  assert.match(options, /requestReapply\(/, 'the settings page must ask the worker to retry');
  assert.match(options, /subscribeStatus\(/, 'the settings page must react to the worker\'s status');
  assert.ok(
    !/chrome\.proxy\??\.settings/.test(options),
    'the settings page must not talk to chrome.proxy.settings',
  );

  // the panel that explains a failing badge exists, and can be reached
  const html = read('src/options.html');
  assert.match(html, /id="applyPanel"[^>]*role="alert"/);
  assert.match(html, /id="applyRetry"/);
  assert.match(html, /data-i18n="apply.retry"/);
});
