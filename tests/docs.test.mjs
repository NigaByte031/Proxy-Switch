import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A picture that 404s is worse than no picture: a screenshot a README points at
 *  must exist and be a real PNG. Both `<img src=` and markdown links count. */
test('every picture a README points at is there, and is a PNG', () => {
  for (const readme of ['README.md', 'README.fa.md']) {
    const text = read(readme);
    const shots = [...text.matchAll(/(?:src="|]\()([^"()]*docs\/screenshots\/[^"()]+\.png)/g)].map(
      (match) => match[1],
    );

    assert.ok(shots.length > 0, `${readme} shows no screenshots`);
    for (const shot of shots) {
      const file = join(ROOT, shot);
      const bytes = readFileSync(file);
      assert.ok(statSync(file).size > 10_000, `${shot} looks too empty to be a screenshot`);
      assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), `${shot} is not a PNG`);
    }
  }
});

/** …and that they can be taken again: the tool that produces them still exists. */
test('the screenshots are reproducible from the repo alone', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts.shots ?? '', /tools\/screenshots\.mjs/);

  const tool = read('tools/screenshots.mjs');
  assert.match(tool, /--headless=new/, 'the tool drives a headless browser');
  assert.match(tool, /__preview_popup\.html/);
  assert.match(tool, /__preview_options\.html/);

  const stub = read('src/__preview_chrome_stub.js');
  assert.match(stub, /seedDemo\(/, 'the preview pages have to be able to show a real setup');
  assert.match(stub, /proxySwitchTrafficRate/, '…including the live speed the pictures show');
});
