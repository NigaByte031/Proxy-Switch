/**
 * Audits every GitHub release against the single-archive policy: one asset,
 * `proxy-switch-v<tag>.zip`, and notes naming no browser the project dropped.
 * `--prune` deletes extra assets, `--strip-notes` drops the stale lines.
 *
 * Usage: node tools/releases.mjs [--repo <owner/name>] [--prune] [--strip-notes]
 * [--json] [--from <file>] [--token <token>]
 *
 * Reads a token from `--token`, `GH_TOKEN` or `GITHUB_TOKEN`; audits without one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The only archive a release may carry: `proxy-switch-v1.2.3.zip`. */
export const ASSET_PATTERN = /^proxy-switch-v\d+\.\d+\.\d+\.zip$/;

/** What a release page must not say any more: browsers the project no longer builds. */
export const STALE_MENTIONS = [
  { label: 'firefox', pattern: /\bfirefox\b/i },
  { label: 'mozilla', pattern: /\bmozilla\b/i },
  { label: 'amo', pattern: /addons\.mozilla\.org/i },
  { label: 'debugging', pattern: /about:debugging/i },
];

const USAGE = `Usage: node tools/releases.mjs [options]

  --repo <owner/name>   repository to audit (default: the origin remote)
  --prune               delete assets that are not the one Chrome archive
  --strip-notes         drop note lines that name a browser we no longer build
  --json                print the whole report as JSON
  --from <file>         audit a saved releases dump instead of the live API
  --token <token>       overrides GH_TOKEN / GITHUB_TOKEN
  --help                this text`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stale mentions in one text, one entry per offending line, labels deduped. */
export function staleMentions(text) {
  const found = [];
  String(text ?? '')
    .split('\n')
    .forEach((line, index) => {
      const labels = STALE_MENTIONS.filter((mention) => mention.pattern.test(line)).map(
        (mention) => mention.label,
      );
      if (labels.length > 0) found.push({ line: index + 1, text: line.trim(), labels });
    });
  return found;
}

/** The one archive a release tagged `tag` is allowed to carry. */
export function expectedAsset(tag) {
  return `proxy-switch-${tag}.zip`;
}

/** What is wrong with one release: extra or missing archives, and stale notes. */
export function auditRelease(release) {
  const findings = [];
  const wanted = expectedAsset(release.tag_name);
  const assets = release.assets ?? [];

  for (const asset of assets) {
    if (asset.name === wanted) continue;
    findings.push({
      kind: 'asset',
      tag: release.tag_name,
      id: asset.id,
      name: asset.name,
      message: `unexpected asset ${asset.name} (wants ${wanted})`,
    });
  }

  if (!release.draft && !assets.some((asset) => asset.name === wanted)) {
    findings.push({ kind: 'missing', tag: release.tag_name, message: `no ${wanted} attached` });
  }

  const bodyLines = String(release.body ?? '').split('\n');
  for (const mention of staleMentions(release.name)) {
    findings.push({
      kind: 'mention',
      tag: release.tag_name,
      field: 'name',
      line: mention.line,
      message: `name line ${mention.line} names ${mention.labels.join(', ')}`,
    });
  }
  for (const mention of staleMentions(release.body)) {
    const removable = removableStaleLine(bodyLines, mention.line - 1);
    findings.push({
      kind: 'mention',
      tag: release.tag_name,
      field: 'body',
      line: mention.line,
      removable,
      message: removable
        ? `body line ${mention.line} names ${mention.labels.join(', ')}`
        : `body line ${mention.line} names ${mention.labels.join(', ')} mid-sentence — needs a rewrite, not a deletion`,
    });
  }
  return findings;
}

/** Every finding across every release, in the order the releases came in. */
export function auditReleases(releases) {
  return releases.flatMap(auditRelease);
}

/** Whether one stale line can be dropped without leaving a sentence in pieces.
 *  Release notes wrap mid-sentence, so a line naming a dropped browser is often
 *  a fragment; only a line that ends a sentence and is followed by the start of a
 *  new one is safe to remove on its own. Everything else needs a rewrite. */
export function removableStaleLine(lines, index) {
  if (!/[.!?:]$/.test(lines[index].trim())) return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    const candidate = lines[next].trim();
    if (candidate === '') continue;
    return /^[A-Z#*\->![`]/.test(candidate);
  }
  return true;
}

/** The notes with the stale lines it can safely drop taken out, and the ones it
 *  will not touch listed as `skipped`. A body with nothing stale comes back
 *  identical, byte for byte, so a clean release is never rewritten. */
export function stripMentions(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const stale = lines.flatMap((line, index) =>
    staleMentions(line).length > 0 ? [index] : [],
  );
  if (stale.length === 0) return { notes: source, changed: false, skipped: [] };

  const unsafe = stale.filter((index) => !removableStaleLine(lines, index));
  if (unsafe.length > 0) {
    return {
      notes: source,
      changed: false,
      skipped: unsafe.map((index) => ({ line: index + 1, text: lines[index].trim() })),
    };
  }
  return {
    notes: lines.filter((line, index) => !stale.includes(index)).join('\n'),
    changed: true,
    skipped: [],
  };
}

/** `owner/name` out of a git remote URL, or null when it is not on GitHub. */
export function repoFromRemote(url) {
  const match = String(url ?? '')
    .trim()
    .match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Talks to the REST API over `fetch`, retrying only what a retry can fix. */
export function createGithubTransport({
  repo,
  token,
  fetchImpl = fetch,
  retries = 3,
  delay = 600,
  log = () => {},
}) {
  async function request(method, path, body) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      let retryable = true;
      try {
        const response = await fetchImpl(`https://api.github.com${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `token ${token}`,
            'User-Agent': 'proxy-switch-release-audit',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.ok) return response.status === 204 ? null : response.json();
        retryable = response.status >= 500 || response.status === 429;
        throw new Error(`${method} ${path} -> HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (!retryable || attempt === retries) break;
      log(`${lastError.message}; retrying`);
      await sleep(delay * attempt);
    }
    throw lastError;
  }

  return {
    async listReleases() {
      const releases = [];
      for (let page = 1; ; page += 1) {
        const batch = await request('GET', `/repos/${repo}/releases?per_page=100&page=${page}`);
        releases.push(...batch);
        if (batch.length < 100) return releases;
      }
    },
    deleteAsset: (id) => request('DELETE', `/repos/${repo}/releases/assets/${id}`),
    updateNotes: (id, notes) => request('PATCH', `/repos/${repo}/releases/${id}`, { body: notes }),
  };
}

/** Audits the releases and, when asked, prunes or rewrites them; returns a report. */
export async function runReleaseAudit(
  releases,
  { transport, prune = false, stripNotes = false, log = () => {} } = {},
) {
  const state = releases.map((release) => ({ ...release, assets: [...(release.assets ?? [])] }));
  const findings = auditReleases(state);
  const pruned = [];
  const rewritten = [];

  if (prune) {
    for (const finding of findings.filter((item) => item.kind === 'asset')) {
      await transport.deleteAsset(finding.id);
      const release = state.find((item) => item.tag_name === finding.tag);
      release.assets = release.assets.filter((asset) => asset.id !== finding.id);
      pruned.push(finding);
      log(`pruned ${finding.name} from ${finding.tag}`);
    }
  }

  const skipped = [];
  if (stripNotes) {
    for (const release of state) {
      const outcome = stripMentions(release.body);
      if (!outcome.changed) {
        for (const entry of outcome.skipped) {
          skipped.push({ tag: release.tag_name, ...entry });
          log(`${release.tag_name} line ${entry.line} needs a rewrite, left alone`);
        }
        continue;
      }
      const before = release.body;
      await transport.updateNotes(release.id, outcome.notes);
      release.body = outcome.notes;
      rewritten.push({ tag: release.tag_name, before, after: outcome.notes });
      log(`rewrote the notes of ${release.tag_name}`);
    }
  }

  return { findings, pruned, rewritten, skipped, remaining: auditReleases(state) };
}

function parseArgs(argv) {
  const options = {
    repo: null,
    token: null,
    from: null,
    prune: false,
    stripNotes: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prune') options.prune = true;
    else if (arg === '--strip-notes') options.stripNotes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--repo') options.repo = argv[(index += 1)];
    else if (arg === '--token') options.token = argv[(index += 1)];
    else if (arg === '--from') options.from = argv[(index += 1)];
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function gitRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Prints the report and answers the exit code: 0 only when nothing is left. */
function reportFindings(report, { json, label }) {
  if (json) {
    console.log(JSON.stringify({ label, ...report }, null, 2));
    return report.remaining.length > 0 ? 1 : 0;
  }
  for (const item of report.pruned) console.log(`pruned  ${item.tag}  ${item.name}`);
  for (const item of report.rewritten) console.log(`rewrote ${item.tag} notes`);
  for (const item of report.skipped) {
    console.log(`kept    ${item.tag} line ${item.line} (mid-sentence, needs a rewrite)`);
  }
  if (report.findings.length === 0) {
    console.log(`${label}: clean — one archive per release, no dropped browser named`);
    return 0;
  }
  if (report.remaining.length === 0) {
    console.log(`${label}: ${report.findings.length} finding(s), all fixed`);
    return 0;
  }
  console.log(`${label}: ${report.remaining.length} finding(s) left`);
  for (const finding of report.remaining) console.log(`  ${finding.tag}  ${finding.message}`);
  return 1;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (options.from) {
    if (options.prune || options.stripNotes) {
      throw new Error('--from only audits a dump; it cannot change anything');
    }
    const releases = JSON.parse(readFileSync(options.from, 'utf8'));
    const report = await runReleaseAudit(releases, {});
    return reportFindings(report, { json: options.json, label: options.from });
  }

  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  if (!token) throw new Error('no token: pass --token, or set GH_TOKEN / GITHUB_TOKEN');
  const repo = options.repo ?? repoFromRemote(gitRemote());
  if (!repo) throw new Error('cannot tell which repository: pass --repo <owner/name>');

  const transport = createGithubTransport({
    repo,
    token,
    log: (message) => console.error(`  ${message}`),
  });
  const releases = await transport.listReleases();
  const report = await runReleaseAudit(releases, {
    transport,
    prune: options.prune,
    stripNotes: options.stripNotes,
    log: (message) => console.log(`  ${message}`),
  });
  return reportFindings(report, { json: options.json, label: repo });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`releases: ${error.message}`);
      process.exitCode = 2;
    });
}
