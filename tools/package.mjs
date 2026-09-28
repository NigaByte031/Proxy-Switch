/**
 * Builds the uploadable extension package: `dist/proxy-switch-v<version>.zip`,
 * or `dist/proxy-switch-v<version>-firefox.zip` with `--firefox`.
 *
 * Dependency-free on purpose (the repo installs nothing), so the ZIP writer is
 * implemented here. It writes stored/deflated entries, UTF-8 names and a normal
 * central directory — which is exactly what Chrome Web Store, AMO and `unzip`
 * expect.
 *
 * The two builds are the same tree with a different manifest at their root:
 * `manifest.firefox.json` runs the same `src/background.js` as an event page
 * (Firefox has no extension service worker, see MDN on `background`) and adds
 * the Gecko id AMO asks for. Everything else — files, permissions, code — is
 * identical, so there is one extension to maintain and two stores to feed.
 *
 * Usage: node tools/package.mjs [--firefox] [--out <file>]
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Packaged directories, in the order they are added to the archive. */
export const PACKAGE_DIRS = ['icons', 'src'];

/** Development-only files that must never end up in the store upload. */
export const EXCLUDE_PATTERNS = [/^__preview_/, /\.test\.mjs$/, /\.map$/];

/**
 * Which manifest each build puts at the root of its archive: the archive is
 * named `manifest.json` in both cases, because that is what a store reads.
 *
 * @param {boolean} firefox
 * @returns {string}
 */
export function manifestFor(firefox = false) {
  return firefox ? 'manifest.firefox.json' : 'manifest.json';
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/** CRC-32 as required by the ZIP format. */
export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function toDosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function toDosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

/**
 * @param {Array<{name: string, data: Buffer|Uint8Array|string}>} entries
 * @returns {Buffer} a complete ZIP archive
 */
export function createZip(entries, { now = new Date() } = {}) {
  const time = toDosTime(now);
  const date = toDosDate(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function isExcluded(name) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(name));
}

function walk(absoluteDirectory, prefix, files) {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || isExcluded(entry.name)) continue;
    const absolute = join(absoluteDirectory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(absolute, name, files);
    else files.push({ name, data: readFileSync(absolute) });
  }
}

/** Everything that belongs in the uploaded package, `manifest.json` first. */
export function collectFiles(root = ROOT, { firefox = false } = {}) {
  const files = [
    { name: 'manifest.json', data: readFileSync(join(root, manifestFor(firefox))) },
  ];
  for (const directory of PACKAGE_DIRS) {
    walk(join(root, directory), directory, files);
  }
  const [manifest, ...rest] = files;
  rest.sort((left, right) => left.name.localeCompare(right.name));
  return [manifest, ...rest];
}

/** Builds the archive and returns `{ target, entries, zip }`. */
export function buildPackage({ root = ROOT, out, firefox = false } = {}) {
  const { version } = JSON.parse(readFileSync(join(root, manifestFor(firefox)), 'utf8'));
  const entries = collectFiles(root, { firefox });
  const zip = createZip(entries);
  const suffix = firefox ? '-firefox' : '';
  const target = out ?? join(root, 'dist', `proxy-switch-v${version}${suffix}.zip`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, zip);
  return { target, entries, zip };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outIndex = process.argv.indexOf('--out');
  const { target, entries } = buildPackage({
    firefox: process.argv.includes('--firefox'),
    ...(outIndex > -1 ? { out: resolve(process.argv[outIndex + 1]) } : {}),
  });
  const size = statSync(target).size;
  console.log(
    `packaged ${entries.length} files -> ${relative(ROOT, target)} ` +
      `(${(size / 1024).toFixed(1)} KiB, ${basename(target)})`,
  );
  for (const entry of entries) console.log(`  ${entry.name}`);
}
