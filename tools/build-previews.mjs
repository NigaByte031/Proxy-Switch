/**
 * Generates `src/__preview_*.html` from the real extension pages.
 *
 * The preview pages are byte-identical to the shipped markup plus one <script>
 * tag that installs the mocked `chrome.*` API, which means the UI can be tried
 * in any browser tab without installing the extension. Generating them (instead
 * of hand-maintaining copies) keeps the two in sync; tests/manifest.test.mjs
 * fails if somebody edits a preview by hand.
 *
 * Usage: node tools/build-previews.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PREVIEW_STUB_TAG = '<script src="./__preview_chrome_stub.js"></script>';

export const PREVIEW_PAGES = [
  { source: 'src/popup.html', target: 'src/__preview_popup.html' },
  { source: 'src/options.html', target: 'src/__preview_options.html' },
];

const HEAD_ANCHOR = '<head>\n';

/** @param {string} html contents of the real page */
export function buildPreview(html) {
  if (html.includes(PREVIEW_STUB_TAG)) return html;
  if (!html.includes(HEAD_ANCHOR)) {
    throw new Error('Could not find "<head>" in the page — preview cannot be generated');
  }
  return html.replace(HEAD_ANCHOR, `${HEAD_ANCHOR}    ${PREVIEW_STUB_TAG}\n`);
}

/** @returns {Array<{source: string, target: string, expected: string, actual: string|null}>} */
export function planPreviews(root = ROOT) {
  return PREVIEW_PAGES.map(({ source, target }) => {
    const html = readFileSync(join(root, source), 'utf8');
    let actual = null;
    try {
      actual = readFileSync(join(root, target), 'utf8');
    } catch {
      actual = null;
    }
    return { source, target, expected: buildPreview(html), actual };
  });
}

export function run({ check = false, root = ROOT, log = console.log } = {}) {
  const plan = planPreviews(root);
  const stale = plan.filter((entry) => entry.actual !== entry.expected);

  if (check) {
    for (const entry of stale) log(`out of date: ${relative(root, entry.target)}`);
    if (stale.length === 0) log(`previews are up to date (${plan.length} files)`);
    return stale.length === 0;
  }

  for (const entry of plan) {
    if (entry.actual === entry.expected) continue;
    writeFileSync(join(root, entry.target), entry.expected);
    log(`wrote ${relative(root, entry.target)}`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ok = run({ check: process.argv.includes('--check') });
  if (!ok) process.exitCode = 1;
}
