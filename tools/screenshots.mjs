/**
 * Regenerates the pictures in `docs/screenshots/`.
 *
 * The README's screenshots are of the *real* interface: this drives a headless
 * Chrome over the DevTools protocol against the offline preview pages (see
 * `tools/preview-server.mjs` and `src/__preview_chrome_stub.js`), so they can be
 * taken again after any UI change instead of going stale. The pages are seeded
 * with `?demo=1`, which is what puts a plausible server list, today's counters
 * and a moving speed on screen.
 *
 * Node's own WebSocket does the talking, so there is nothing to install:
 *
 *   PORT=4331 node tools/preview-server.mjs &   # serve the preview pages
 *   node tools/screenshots.mjs                  # write docs/screenshots/*.png
 *   node tools/screenshots.mjs --only popup     # just one page
 *
 * `CHROME_PATH` overrides the browser it looks for. Nothing here runs in CI —
 * it is a development tool, and there is no Chrome on a CI runner.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
/** An empty or zero port in the environment means "unset", not "port zero". */
const portOf = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

const PORT = portOf(process.env.PORT, 4331);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUGGING_PORT = portOf(process.env.CHROME_DEBUG_PORT, 9333);

/** Every picture this writes, and the page it comes from. */
const SHOTS = [
  {
    name: 'popup',
    page: 'src/__preview_popup.html',
    width: 380,
    scale: 2,
    lang: 'en',
    /** The popup is as tall as its content — not as tall as the tab it opened in. */
    frame: `(() => {
      const body = document.body;
      return { y: 0, height: Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight)) };
    })()`,
  },
  {
    name: 'settings',
    page: 'src/__preview_options.html',
    width: 780,
    scale: 1.25,
    lang: 'en',
    /**
     * The settings page is long: frame it from the top down to the end of the
     * Traffic card, so the picture stops where the thing it shows stops.
     */
    frame: `(() => {
      const card = document.getElementById('trafficMessage').closest('section');
      return { y: 0, height: Math.ceil(card.getBoundingClientRect().bottom + window.scrollY + 28) };
    })()`,
  },
];

/** Where Chrome lives, one candidate per platform. */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome found — set CHROME_PATH to the browser you want to use.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the debugging endpoint to answer, then hands back its port. */
async function waitForChrome() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch (error) {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('Chrome never opened its debugging port.');
}

/**
 * A DevTools protocol session on one tab: `send()` per command, `once()` per
 * event, both answered by the message loop that runs while the browser works.
 */
async function openSession(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const waiting = new Map();
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    const listeners = waiting.get(message.method);
    if (listeners && listeners.length > 0) listeners.shift()(message.params);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the DevTools socket failed')), { once: true });
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`));
        }, 20000);
      });
    },
    once(method) {
      return new Promise((resolve) => {
        const listeners = waiting.get(method) ?? [];
        listeners.push(resolve);
        waiting.set(method, listeners);
      });
    },
    close() {
      socket.close();
    },
  };
}

/** One picture: lay the page out at `width`, frame it, then capture that frame. */
async function capture(session, shot) {
  const url = `${BASE}/${shot.page}?demo=${shot.lang}`;

  // Lay out the page at the width it really has (a sticky header and the media
  // queries both depend on it), then let the clip below do the scaling.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const loaded = session.once('Page.loadEventFired');
  await session.send('Page.navigate', { url });
  await loaded;
  // The pages read their store asynchronously, and the demo moves the speed
  // every second: give both a moment before believing the screen.
  await sleep(1600);

  const measured = await session.send('Runtime.evaluate', {
    expression: shot.frame,
    returnByValue: true,
  });
  const box = measured.result.value ?? {};
  const clip = {
    x: 0,
    y: Math.max(0, Math.round(Number(box.y) || 0)),
    width: shot.width,
    height: Math.max(200, Math.ceil(Number(box.height) || 0)),
    scale: shot.scale,
  };

  const { data } = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip,
  });

  const bytes = Buffer.from(data, 'base64');
  const file = join(OUT_DIR, `${shot.name}${shot.lang === 'en' ? '' : `.${shot.lang}`}.png`);
  writeFileSync(file, bytes);
  return { file, width: clip.width, height: clip.height, bytes: bytes.length };
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const wanted = SHOTS.filter((shot) => !only || shot.name === only);

  // The two languages are the same page twice; asking for one is asking for both.
  const shots = wanted.flatMap((shot) => [shot, { ...shot, lang: 'fa' }]);

  const health = await fetch(`${BASE}/src/__preview_popup.html`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`The preview server is not answering on ${BASE} — run: PORT=${PORT} node tools/preview-server.mjs`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'proxy-switch-shots-'));
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUGGING_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let session = null;
  try {
    await waitForChrome();

    // A new tab answers PUT (Chrome 111+); an older browser only lists one.
    const created = await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json/new?about:blank`, { method: 'PUT' }).catch(
      () => null,
    );
    const target = created?.ok
      ? await created.json()
      : (await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json/list`).then((response) => response.json()))[0];

    session = await openSession(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    // A picture for a white page: the app follows the operating system by
    // default, and a headless browser would otherwise pick whichever theme it
    // feels like that day.
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });

    for (const shot of shots) {
      const result = await capture(session, shot);
      console.log(
        `${result.file.slice(ROOT.length + 1)}  ${result.width}x${result.height} @${shot.scale}x  ${(result.bytes / 1024).toFixed(0)} KB`,
      );
    }
  } finally {
    session?.close();
    browser.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[screenshots] ${error.message}`);
  process.exitCode = 1;
});
