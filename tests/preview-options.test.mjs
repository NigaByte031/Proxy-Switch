import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the settings page has the same test-all control the popup has', () => {
  const popup = read('src/popup.html');
  const options = read('src/options.html');

  for (const page of [popup, options]) {
    // the button, wired to the shared label…
    assert.match(page, /id="testAllBtn"/);
    assert.match(page, /data-i18n="health\.testAll\.action"/);
    // …and the narration line under the list
    assert.match(page, /id="testAllResult"[^>]*role="status"/);
    assert.match(page, /id="testAllResult"[^>]*aria-live="polite"/);
  }
});

test('both pages wire the control through the same shared module', () => {
  for (const page of ['src/popup.js', 'src/options.js']) {
    const source = read(page);
    assert.match(source, /createTestAllUi\(/, `${page} must build the shared control`);
    assert.match(source, /buttonEl: el\('testAllBtn'\)/);
    assert.match(source, /resultEl: el\('testAllResult'\)/);
    assert.match(source, /testAllUi\.render\(lang\)/, `${page} must repaint it`);
    assert.match(source, /TEST_ALL_PROGRESS_MESSAGE/, `${page} must listen for progress`);
    assert.match(source, /testAllUi\.handleProgress\(message\)/);
    // pages ask the worker; they never check a server themselves
    assert.ok(!source.includes('checkServer'), `${page} must not run a pass itself`);
    assert.ok(!source.includes('buildProbeConfig'), `${page} must not build a probe config`);
  }
});

/** The connection verdict is only attributed to a server when the control is
 *  handed the state, so a page that forgets `getState` silently records nothing
 *  and the chain never learns what the test proved. */
test('both pages hand the health control the state it needs to record a verdict', () => {
  for (const page of ['src/popup.js', 'src/options.js']) {
    const source = read(page);
    const call = source.slice(source.indexOf('createHealthUi('), source.indexOf('});', source.indexOf('createHealthUi(')));
    assert.match(call, /getState:\s*\(\)\s*=>\s*state/, `${page} must pass getState`);
  }
});

test('the shared control exists once and both pages import it', () => {
  const shared = read('src/lib/test-all-ui.js');
  assert.match(shared, /export function createTestAllUi/);
  for (const page of ['src/popup.js', 'src/options.js']) {
    assert.match(read(page), /from '\.\/lib\/test-all-ui\.js'/);
  }
});

test('the preview stub simulates the pass with the protocol and policy of the worker', () => {
  const stub = read('src/__preview_chrome_stub.js');
  // the same message names the real pass uses (lib/server-probe.js)
  assert.match(stub, /proxy-switch:test-all'/);
  assert.match(stub, /proxy-switch:test-all-progress'/);
  // answers "started" before the pass finishes (the early-reply protocol)
  assert.match(stub, /return \{ started: true, total: profiles\.length \}/);
  // mirrors the worker's eligibility instead of always agreeing to run
  assert.match(stub, /testAllEligible/);
  assert.match(stub, /return \{ started: false \}/);
  // records into the same health key the worker writes, so the rows update
  assert.match(stub, /HEALTH_KEY = 'proxySwitchServerHealth'/);
});

test('the manifest test keeps covering both pages', () => {
  // guards this file against drifting away from the pages it inspects
  for (const page of ['src/popup.html', 'src/options.html', 'src/popup.js', 'src/options.js']) {
    assert.ok(read(page).length > 0, `${page} missing`);
  }
});
