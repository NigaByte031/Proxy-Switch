import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSET_PATTERN,
  STALE_MENTIONS,
  auditRelease,
  auditReleases,
  createGithubTransport,
  expectedAsset,
  removableStaleLine,
  repoFromRemote,
  runReleaseAudit,
  staleMentions,
  stripMentions,
} from '../tools/releases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const release = (tag, { id = 1, assets = [], body = 'Notes.', name = tag, draft = false } = {}) => ({
  id,
  tag_name: tag,
  name,
  body,
  draft,
  assets,
});

const zip = (name, id) => ({ id, name });
const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

test('the expected archive is one Chrome zip named after the tag', () => {
  assert.equal(expectedAsset('v1.6.1'), 'proxy-switch-v1.6.1.zip');
  assert.equal(ASSET_PATTERN.test('proxy-switch-v1.6.1.zip'), true);
  assert.equal(ASSET_PATTERN.test('proxy-switch-v1.6.1-firefox.zip'), false);
  assert.equal(ASSET_PATTERN.test('proxy-switch.zip'), false);
  assert.equal(ASSET_PATTERN.test('proxy-switch-v1.6.1.zip.sha256'), false);
});

test('stale mentions report one hit per line, with the labels deduped', () => {
  const body = [
    'Download the archive for Chrome.',
    'Or `proxy-switch-v1.6.0-firefox.zip` for Firefox.',
    'It also suits [addons.mozilla.org](https://addons.mozilla.org).',
    'An unsigned build loads from `about:debugging`.',
  ].join('\n');

  const found = staleMentions(body);
  assert.deepEqual(
    found.map((hit) => hit.line),
    [2, 3, 4],
  );
  assert.deepEqual(found[0].labels, ['firefox']);
  assert.deepEqual(found[1].labels, ['mozilla', 'amo']);
  assert.deepEqual(found[2].labels, ['debugging']);
  assert.deepEqual(staleMentions('Chrome, Edge, Brave and Opera only.'), []);
  assert.ok(STALE_MENTIONS.length >= 3);
});

test('auditing a release separates an extra zip, a missing zip and its notes', () => {
  const clean = release('v1.9.0', { assets: [zip('proxy-switch-v1.9.0.zip', 10)] });
  assert.deepEqual(auditRelease(clean), []);

  const noisy = release('v1.6.1', {
    assets: [zip('proxy-switch-v1.6.1.zip', 11), zip('proxy-switch-v1.6.1-firefox.zip', 12)],
    body: 'Grab the `proxy-switch-v1.6.1-firefox.zip` for Firefox.',
  });
  const findings = auditRelease(noisy);
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['asset', 'mention'],
  );
  assert.equal(findings[0].id, 12, 'the finding carries the asset id the prune needs');
  assert.match(findings[0].message, /wants proxy-switch-v1\.6\.1\.zip/);
});

test('a published release without its archive is a finding, a draft is not', () => {
  const published = auditRelease(release('v1.6.0'));
  assert.deepEqual(
    published.map((finding) => finding.kind),
    ['missing'],
  );

  const draft = auditRelease(release('v2.0.0', { draft: true }));
  assert.deepEqual(draft, [], 'a draft is still being assembled');
});

test('auditReleases walks every release in order', () => {
  const releases = [
    release('v1.9.0', { assets: [zip('proxy-switch-v1.9.0.zip', 1)] }),
    release('v1.6.1', { assets: [zip('proxy-switch-v1.6.1-firefox.zip', 2)] }),
  ];
  assert.deepEqual(
    auditReleases(releases).map((finding) => finding.tag),
    ['v1.6.1', 'v1.6.1'],
  );
});

test('stripping notes keeps everything that is not a stale line', () => {
  const body = [
    'A note about Chrome, Edge, Brave and Opera.',
    '',
    '![The popup](https://example.com/docs/screenshots/popup.png)',
    '',
    '[CHANGELOG.md](https://example.com/CHANGELOG.md)',
    '',
    '**Full Changelog**: https://example.com/compare/v1.5.0...v1.6.0',
  ].join('\n');

  const outcome = stripMentions(body);
  assert.equal(outcome.notes, body, 'a clean body is returned byte for byte');
  assert.equal(outcome.changed, false);
  assert.deepEqual(outcome.skipped, []);
});

/** The bug that broke the live notes once: collapsing blank lines rewrote
 *  releases that had nothing stale in them at all. */
test('a clean body with blank runs is never rewritten', () => {
  const body = 'A clean note.\n\n\n\n**Full Changelog**: https://example.com/compare/a...b\n';
  const outcome = stripMentions(body);
  assert.equal(outcome.notes, body);
  assert.equal(outcome.changed, false, 'identical means no PATCH is sent');
});

test('a stale line that ends a sentence and stands alone is removed', () => {
  const body = [
    'Chrome, Edge, Brave and Opera are supported.',
    'The Firefox build is gone.',
    '',
    '**Full Changelog**: https://example.com/compare/a...b',
  ].join('\n');

  const outcome = stripMentions(body);
  assert.equal(outcome.changed, true);
  assert.ok(!/firefox/i.test(outcome.notes));
  assert.match(outcome.notes, /Chrome, Edge, Brave and Opera are supported\./);
  assert.match(outcome.notes, /\*\*Full Changelog\*\*/);
});

/** Release prose wraps mid-sentence, so most stale lines are fragments: the tool
 *  must refuse those rather than leave a sentence in pieces. */
test('a stale line that continues the sentence is reported, not deleted', () => {
  const body = [
    '**Download `proxy-switch-v1.6.1.zip`** for Chrome, Edge, Brave and',
    'Opera, or `proxy-switch-v1.6.1-firefox.zip` for Firefox (unzip it, then',
    'open `chrome://extensions`). Requires Chrome 116 or newer.',
  ].join('\n');

  const outcome = stripMentions(body);
  assert.equal(outcome.changed, false, 'nothing is deleted');
  assert.equal(outcome.notes, body, 'the body is left exactly as it was');
  assert.deepEqual(
    outcome.skipped.map((entry) => entry.line),
    [2],
  );
  assert.match(outcome.skipped[0].text, /firefox/);
});

test('removableStaleLine tells a whole sentence from a fragment', () => {
  const lines = ['Grab the Firefox build.', '', 'Next paragraph starts here.'];
  assert.equal(removableStaleLine(lines, 0), true);
  const fragment = ['Chrome, Edge and Opera, or', 'the Firefox build. It ends here.', 'More text.'];
  assert.equal(removableStaleLine(fragment, 1), true, 'ends a sentence and the next line starts one');
  const wrapped = ['Chrome, Edge and Opera, or', 'the Firefox build, which', 'nobody builds now.'];
  assert.equal(removableStaleLine(wrapped, 1), false, 'the next line continues it');
});

test('a git remote yields the repository slug it points at', () => {
  assert.equal(repoFromRemote('https://github.com/NigaByte031/Proxy-Switch.git'), 'NigaByte031/Proxy-Switch');
  assert.equal(repoFromRemote('https://github.com/NigaByte031/Proxy-Switch'), 'NigaByte031/Proxy-Switch');
  assert.equal(repoFromRemote('git@github.com:NigaByte031/Proxy-Switch.git'), 'NigaByte031/Proxy-Switch');
  assert.equal(repoFromRemote('git@gitlab.com:someone/thing.git'), null);
  assert.equal(repoFromRemote(''), null);
});

test('pruning deletes only the extra archives and leaves the report clean', async () => {
  const deleted = [];
  const transport = {
    deleteAsset: async (id) => deleted.push(id),
    updateNotes: async () => assert.fail('notes were not asked for'),
  };
  const releases = [
    release('v1.6.1', {
      assets: [zip('proxy-switch-v1.6.1.zip', 11), zip('proxy-switch-v1.6.1-firefox.zip', 12)],
    }),
  ];

  const report = await runReleaseAudit(releases, { transport, prune: true });
  assert.deepEqual(deleted, [12]);
  assert.equal(report.pruned.length, 1);
  assert.deepEqual(report.remaining, [], 'the release is clean once the extra is gone');
  assert.equal(releases[0].assets.length, 2, 'the caller’s objects are not mutated');

  const untouched = await runReleaseAudit(releases, { transport });
  assert.equal(untouched.pruned.length, 0);
  assert.equal(untouched.remaining.length, 1, 'an audit alone changes nothing');
  assert.deepEqual(deleted, [12], 'and deletes nothing');
});

test('stripping notes patches only the releases that need it', async () => {
  const patched = [];
  const transport = {
    deleteAsset: async () => assert.fail('nothing to prune'),
    updateNotes: async (id, notes) => patched.push({ id, notes }),
  };
  const releases = [
    release('v1.6.1', { id: 398, assets: [zip('proxy-switch-v1.6.1.zip', 11)], body: 'A Firefox note.' }),
    release('v1.9.0', { id: 399, assets: [zip('proxy-switch-v1.9.0.zip', 12)], body: 'Chrome only.' }),
  ];

  const report = await runReleaseAudit(releases, { transport, stripNotes: true });
  assert.deepEqual(
    patched.map((call) => call.id),
    [398],
  );
  assert.deepEqual(patched[0].notes, '', 'the only line was the stale one');
  assert.deepEqual(report.rewritten.map((entry) => entry.tag), ['v1.6.1']);
  assert.deepEqual(report.remaining, []);
});

test('a mention in the release title is reported but not silently rewritten', async () => {
  const transport = {
    deleteAsset: async () => assert.fail('nothing to prune'),
    updateNotes: async () => assert.fail('the body was clean already'),
  };
  const releases = [
    release('v1.6.0', {
      name: 'v1.6.0 — now with a Firefox build',
      assets: [zip('proxy-switch-v1.6.0.zip', 10)],
      body: 'Notes about Chrome.',
    }),
  ];

  const report = await runReleaseAudit(releases, { transport, stripNotes: true });
  assert.deepEqual(report.rewritten, []);
  assert.deepEqual(
    report.remaining.map((finding) => finding.field),
    ['name'],
    'a title only a human can rewrite stays open, and the exit code says so',
  );
});

test('the transport retries a dropped connection and then gives up loudly', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 2) throw new Error('socket hang up');
    return jsonResponse(200, { ok: true });
  };
  const transport = createGithubTransport({
    repo: 'a/b',
    token: 't',
    fetchImpl: flaky,
    retries: 3,
    delay: 0,
  });
  assert.deepEqual(await transport.deleteAsset(1), { ok: true });
  assert.equal(calls, 2, 'the first failure was retried');

  let always = 0;
  const dead = createGithubTransport({
    repo: 'a/b',
    token: 't',
    fetchImpl: async () => {
      always += 1;
      throw new Error('offline');
    },
    retries: 2,
    delay: 0,
  });
  await assert.rejects(() => dead.deleteAsset(1), /offline/);
  assert.equal(always, 2, 'it stops after the retries it was given');
});

test('a 404 is not retried, because retrying cannot make it exist', async () => {
  let calls = 0;
  const transport = createGithubTransport({
    repo: 'a/b',
    token: 't',
    retries: 4,
    delay: 0,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(404, { message: 'Not Found' });
    },
  });
  await assert.rejects(() => transport.deleteAsset(1), /HTTP 404/);
  assert.equal(calls, 1);
});

test('the release list is followed across pages', async () => {
  const fullPage = Array.from({ length: 100 }, (unused, index) =>
    release(`v1.0.${index}`, { assets: [zip(`proxy-switch-v1.0.${index}.zip`, index)] }),
  );
  const seen = [];
  const transport = createGithubTransport({
    repo: 'a/b',
    token: 't',
    delay: 0,
    fetchImpl: async (url, init) => {
      seen.push(url);
      assert.equal(init.headers.Authorization, 'token t');
      const page = Number(new URL(url).searchParams.get('page'));
      return jsonResponse(200, page === 1 ? fullPage : []);
    },
  });

  const releases = await transport.listReleases();
  assert.equal(releases.length, 100);
  assert.equal(seen.length, 2, 'a full page means there is another to read');
  assert.match(seen[1], /page=2/);
});

test('the tool is wired into the project the way the others are', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.match(scripts.releases ?? '', /tools\/releases\.mjs/);
  for (const readme of ['README.md', 'README.fa.md']) {
    assert.match(readFileSync(join(ROOT, readme), 'utf8'), /npm run releases/);
  }
});
