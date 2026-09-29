import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['src', 'tests', 'tools'];
const CODE_FILE = /\.(?:js|mjs|css|html)$/;
const MAX_PROSE_LINES = 6;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const FILES = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
  .filter((path) => CODE_FILE.test(path))
  .map((path) => path.slice(ROOT.length + 1).split('\\').join('/'));

const linesOf = (file) => readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);

const isHtml = (file) => file.endsWith('.html');

/** Quoted text is not code, so a `//` inside a string, a URL or a regex escapes
 * itself (`\/\/` in `match(/:\/\//)`) and never starts a comment. */
function stripStrings(text) {
  let out = '';
  let quote = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
      out += ' ';
      continue;
    }
    if (char === '\\') {
      out += '  ';
      at += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += ' ';
      continue;
    }
    if (char === ':' && text.startsWith('//', at + 1)) {
      out += ':';
      at += 2;
      continue;
    }
    out += char;
  }
  return out;
}

/** The comment of a line, without its delimiters and stars. */
function commentBody(line, html) {
  const trimmed = line.trim();
  if (html) {
    const open = trimmed.indexOf('<!--');
    const close = trimmed.indexOf('-->');
    if (open === -1) return trimmed;
    return trimmed.slice(open + 4, close === -1 ? undefined : close).trim();
  }
  return trimmed
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\*+/, '')
    .trim();
}

function gluedComments(file, lines) {
  const found = [];
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === '') return;

    if (isHtml(file)) {
      const open = line.indexOf('<!--');
      if (open > 0 && line.slice(0, open).trim() !== '') found.push(where);
      const close = line.indexOf('-->');
      if (close !== -1 && line.slice(close + 3).trim() !== '') found.push(where);
      return;
    }

    const startsComment = /^(?:\/\/|\/\*|\*)/.test(trimmed);
    if (startsComment) {
      // a closer glued to the code it was holding apart: `*/export function …`
      if (/^\*+\/\S/.test(trimmed)) found.push(where);
      return;
    }
    const code = stripStrings(line);
    const at = code.search(/\/\/|\/\*/);
    if (at > 0) found.push(where);
  });
  return found;
}

/** Prose lines of one comment: no delimiters, no blank stars, no `@param` block. */
function proseLength(block, html) {
  const jsDoc = block[0].trim().startsWith('/**');
  let prose = 0;
  let tagged = false;
  for (const line of block) {
    const body = commentBody(line, html);
    if (!tagged && jsDoc && body.startsWith('@')) tagged = true;
    if (tagged || body === '') continue;
    prose += 1;
  }
  return prose;
}

function longComments(file, lines) {
  const found = [];
  let start = -1;
  const html = isHtml(file);

  const end = (at) => {
    if (start === -1) return;
    const prose = proseLength(lines.slice(start, at), html);
    if (prose > MAX_PROSE_LINES) found.push(`${file}:${start + 1} (${prose} lines of prose)`);
    start = -1;
  };

  let inHtmlComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (html) {
      if (!inHtmlComment && trimmed.includes('<!--')) {
        start = index;
        inHtmlComment = !trimmed.includes('-->');
        if (!inHtmlComment) end(index + 1);
        return;
      }
      if (inHtmlComment) {
        inHtmlComment = !trimmed.includes('-->');
        if (!inHtmlComment) end(index + 1);
      }
      return;
    }

    const isComment = /^(?:\/\/|\/\*|\*)/.test(trimmed);
    if (isComment && start === -1) start = index;
    else if (!isComment) end(index);
  });
  end(lines.length);
  return found;
}

test('no comment is glued onto the code it sits with', () => {
  const found = FILES.flatMap((file) => gluedComments(file, linesOf(file)));
  assert.deepEqual(
    found,
    [],
    `comments belong on their own line:\n  ${found.join('\n  ')}`,
  );
});

test('no comment block runs longer than a few lines', () => {
  const found = FILES.flatMap((file) => longComments(file, linesOf(file)));
  assert.deepEqual(
    found,
    [],
    `keep comment blocks short (what the API shape needs, like @param, is not counted):\n  ${found.join('\n  ')}`,
  );
});
