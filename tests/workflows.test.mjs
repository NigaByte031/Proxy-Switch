import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join('.github', 'workflows');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const workflows = readdirSync(join(ROOT, WORKFLOW_DIR)).filter((name) => name.endsWith('.yml'));

/** GitHub refuses to run a workflow file that does not parse, and does so on every
 *  push: these check the shape mistakes that hurt, without a YAML parser. */
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
        // the block ended; this is the next key
        if (indent <= keyIndent) break;
        assert.ok(
          indent >= blockIndent,
          `${path}:${next + 1} is indented ${indent} inside a block that starts at ${blockIndent}`,
        );
      }
    }
  }
});

test('the release workflow builds the archive and refuses a mismatched tag', () => {
  const release = read(join(WORKFLOW_DIR, 'release.yml'));
  assert.match(release, /npm run package\b/, 'the Chrome/Chromium archive');
  assert.match(release, /files: dist\/\*\.zip/, 'the archive is attached to the release');
  assert.match(release, /does not match the packaged version/, 'the tag has to match what is packaged');
  assert.ok(!release.includes('firefox'), 'there is one build, and one archive to carry it');
});

/** The tag check compares the tag against a version pinned in the workflow, not against
 *  the manifest at release time, so a version bump that forgets this one line would make
 *  the next release fail. Keep the two in step. */
test('the version the release workflow packages matches the manifest', () => {
  const release = read(join(WORKFLOW_DIR, 'release.yml'));
  const pinned = release.match(/^\s*EXTENSION_VERSION:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  assert.ok(pinned, 'release.yml pins the packaged version in EXTENSION_VERSION');
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(
    pinned[1],
    manifest.version,
    'EXTENSION_VERSION in release.yml and manifest.json have to name the same version',
  );
});

test('CI runs the suite on the Node versions the project supports', () => {
  const ci = read(join(WORKFLOW_DIR, 'ci.yml'));
  assert.match(ci, /npm test/);
  assert.match(ci, /node: \[22, 24\]/, 'the floor and the newest line, not just one of them');
  assert.match(ci, /npm run package\b/, 'a manifest that cannot be packaged fails here');
  assert.ok(!ci.includes('firefox'), 'nothing to build for a browser the project does not target');
});
