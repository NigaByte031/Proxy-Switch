import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join('.github', 'workflows');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const workflows = readdirSync(join(ROOT, WORKFLOW_DIR)).filter((name) => name.endsWith('.yml'));

/**
 * A workflow file that does not parse fails in the least helpful way there is:
 * GitHub refuses to run it, names the run after the *path* instead of the
 * workflow, and does it on every push — which is how a mis-indented release
 * notes block hid in plain sight. These are the mistakes that hurt, checked
 * without adding a YAML parser to a dependency-free repository.
 */
test('every workflow parses as far as shape goes: no tabs, block scalars indented', () => {
  for (const file of workflows) {
    const path = join(WORKFLOW_DIR, file);
    const lines = read(path).split('\n');

    for (const [index, line] of lines.entries()) {
      assert.equal(line.includes('\t'), false, `${path}:${index + 1} uses a tab; YAML forbids them`);
    }

    for (const [index, line] of lines.entries()) {
      const key = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*[|>][-+]?\s*$/);
      if (!key) continue;

      const keyIndent = key[1].length;
      const content = lines.findIndex((candidate, at) => at > index && candidate.trim() !== '');
      assert.ok(content > -1, `${path}:${index + 1} opens a block scalar and never fills it`);
      const blockIndent = lines[content].search(/\S/);
      assert.ok(
        blockIndent > keyIndent,
        `${path}:${index + 1} (${key[2]}) has its content at the same indent as the key`,
      );

      for (let next = content; next < lines.length; next += 1) {
        if (lines[next].trim() === '') continue;
        const indent = lines[next].search(/\S/);
        if (indent <= keyIndent) break; // the block ended; this is the next key
        assert.ok(
          indent >= blockIndent,
          `${path}:${next + 1} is indented ${indent} inside a block that starts at ${blockIndent}`,
        );
      }
    }
  }
});

test('the release workflow builds both archives and refuses a mismatched tag', () => {
  const release = read(join(WORKFLOW_DIR, 'release.yml'));
  assert.match(release, /npm run package\b/, 'the Chrome/Chromium archive');
  assert.match(release, /npm run package:firefox/, 'the Firefox archive');
  assert.match(release, /files: dist\/\*\.zip/, 'both archives are attached to the release');
  assert.match(release, /does not match manifest version/, 'the tag has to match what is packaged');
});

test('CI runs the suite on the Node versions the project supports', () => {
  const ci = read(join(WORKFLOW_DIR, 'ci.yml'));
  assert.match(ci, /npm test/);
  assert.match(ci, /node: \[22, 24\]/, 'the floor and the newest line, not just one of them');
  assert.match(ci, /npm run package:firefox/, 'a Firefox manifest that cannot be packaged fails here');
});
