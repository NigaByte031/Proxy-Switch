import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import {
  EXCLUDE_PATTERNS,
  collectFiles,
  createZip,
  crc32,
  isExcluded,
  buildPackage,
} from '../tools/package.mjs';

const EOCD_SIGNATURE = 0x06054b50;

function readEntries(zip) {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1, 'the archive has no end-of-central-directory record');
  assert.equal(zip.readUInt32LE(eocdOffset), EOCD_SIGNATURE);

  const count = zip.readUInt16LE(eocdOffset + 10);
  const size = zip.readUInt32LE(eocdOffset + 12);
  const offset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(offset + size, eocdOffset, 'central directory size/offset mismatch');

  const entries = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50, 'bad central directory header');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = zip.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      data: method === 8 ? inflateRawSync(payload) : payload,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('crc32 matches the reference vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('createZip produces an archive every reader can walk', () => {
  const script = 'export const a = 1;\n';
  const zip = createZip([
    { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') },
    { name: 'src/popup.js', data: Buffer.from(script.repeat(50)) },
    { name: 'icons/icon16.png', data: Buffer.from([1, 2, 3]) },
  ]);

  assert.equal(zip.readUInt32LE(0), 0x04034b50);

  const entries = readEntries(zip);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['manifest.json', 'src/popup.js', 'icons/icon16.png'],
  );

  assert.equal(entries[0].data.toString('utf8'), '{"manifest_version":3}');
  assert.equal(entries[1].method, 8, 'compressible data should be deflated');
  assert.equal(entries[1].uncompressedSize, Buffer.byteLength(script) * 50);
  assert.deepEqual([...entries[2].data], [1, 2, 3]);
});

test('collectFiles ships the extension and nothing else', () => {
  const files = collectFiles();
  const names = files.map((entry) => entry.name);

  assert.equal(names[0], 'manifest.json');
  assert.ok(names.includes('src/background.js'));
  assert.ok(names.includes('src/popup.html'));
  assert.ok(names.includes('src/options.html'));
  assert.ok(names.includes('src/lib/proxy.js'));
  assert.ok(names.includes('icons/icon128.png'));
  assert.equal(new Set(names).size, names.length, 'duplicate archive entries');

  for (const name of names) {
    assert.ok(!name.startsWith('/') && !name.includes('\\'), `${name} is not a portable path`);
    assert.ok(!isExcluded(name.split('/').pop()), `${name} should not be packaged`);
  }
  assert.ok(!names.some((name) => name.includes('__preview_')), 'previews must not ship');
  assert.ok(!names.includes('src/__preview_chrome_stub.js'));
});

test('exclusions cover the development-only files', () => {
  assert.deepEqual(EXCLUDE_PATTERNS.length, 3);
  assert.equal(isExcluded('__preview_popup.html'), true);
  assert.equal(isExcluded('__preview_chrome_stub.js'), true);
  assert.equal(isExcluded('model.test.mjs'), true);
  assert.equal(isExcluded('popup.js'), false);
  assert.equal(isExcluded('icon128.png'), false);
});

test('buildPackage writes a valid archive next to the project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-switch-'));
  const target = join(directory, 'out.zip');
  try {
    const { entries, zip } = buildPackage({ out: target });
    assert.equal(readFileSync(target).length, zip.length);
    assert.ok(statSync(target).size > 1024);
    assert.equal(readEntries(readFileSync(target))[0].name, 'manifest.json');

    const packaged = readEntries(zip).find((entry) => entry.name === 'manifest.json');
    const manifest = JSON.parse(packaged.data.toString('utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(entries.length, readEntries(zip).length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
