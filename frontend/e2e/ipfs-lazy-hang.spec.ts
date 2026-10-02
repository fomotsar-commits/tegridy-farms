/**
 * The IPFS hang timer (watchIpfsImg in src/lib/ipfsGateways.ts), run in the
 * real engines, because the bug it pins lives in the gap between them.
 *
 * A lazy <img> is requested at a different distance in each engine: Chromium
 * about 1250px ahead of the viewport, WebKit (Safari, and every browser on iOS)
 * about one viewport height. The timer used to start a lazy image's clock at
 * 1250px, so in WebKit an image 1000px below the fold had its clock running on
 * a request that did not exist. With nobody looking it walked all four gateways
 * and was declared exhausted (hidden, or handed to the Alchemy fallback).
 *
 * The contract pinned here, in Chromium AND WebKit:
 *   - a lazy image 1000px below the fold does not advance while unseen;
 *   - once scrolled into view it still moves past a hung gateway, one step
 *     after it was seen, and loads from the next one;
 *   - an eager image is requested at once, so its clock runs at once, seen or not.
 *
 * The page runs the shipped function itself (its source, injected), not a copy,
 * against a local server whose first gateway never answers.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { watchIpfsImg } from '../src/lib/ipfsGateways';

/** A short step so the test runs in seconds; the logic is the same at 10s. */
const STEP_MS = 2000;
/**
 * How far below the fold the image sits: inside Chromium's lazy margin, and
 * outside WebKit's on a phone or an 800px window (on a 1080px-tall iPad it is
 * inside, so WebKit requests it too, and it must still not advance unseen).
 */
const BELOW_FOLD_PX = 1000;
// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

type Hit = { path: string; at: number };
let server: http.Server;
let base = '';
const hits: Hit[] = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/page') {
      const lazy = u.searchParams.get('lazy') === '1';
      const id = u.searchParams.get('id') ?? 'x';
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(id, lazy));
      return;
    }
    hits.push({ path: u.pathname, at: Date.now() });
    // Gateway 1 hangs: it never answers, the way filebase does on some uncached
    // tokens. Every later gateway serves the image.
    if (u.pathname.startsWith('/g1/')) return;
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'cache-control': 'no-store' });
    res.end(PNG);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/**
 * The image walks /g1/ → /g4/ the way IpfsImg and NftImage walk the gateway
 * list: on a hang, stop this watch, move `src` on, watch the new one.
 */
function page(id: string, lazy: boolean): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">
<div id="above"></div>
<script>document.getElementById('above').style.height = (innerHeight + ${BELOW_FOLD_PX}) + 'px';</script>
<img id="img" src="/g1/${id}.png" loading="${lazy ? 'lazy' : 'eager'}" width="100" height="100" style="display:block" alt="">
<div style="height:6000px"></div>
<script>
${watchIpfsImg.toString()}
window.__log = [];
const img = document.getElementById('img');
let gateway = 1;
img.addEventListener('load', () => window.__log.push({ loaded: gateway, at: Date.now() }));
const watch = () => {
  const stop = watchIpfsImg(img, {
    lazy: ${lazy},
    stepMs: ${STEP_MS},
    onHang: () => {
      stop();
      window.__log.push({ hang: gateway, at: Date.now() });
      if (gateway === 4) { window.__log.push({ exhausted: true, at: Date.now() }); return; }
      gateway += 1;
      img.src = '/g' + gateway + '/${id}.png';
      watch();
    },
  });
};
watch();
</script>
</body></html>`;
}

type LogEntry = { hang?: number; loaded?: number; exhausted?: boolean; at: number };
const readLog = (p: Page) => p.evaluate(() => (window as unknown as { __log: LogEntry[] }).__log);

test('a lazy IPFS image below the fold keeps its gateway while unseen, and moves past a hang once seen', async ({ page }, testInfo) => {
  const id = `lazy-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
  const mine = () => hits.filter((h) => h.path.endsWith(`/${id}.png`)).map((h) => h.path);
  await page.goto(`${base}/page?lazy=1&id=${id}`, { waitUntil: 'domcontentloaded' });

  // Unseen for 2.5 steps. The old 1250px margin started the clock at load, so
  // by now it had given up on gateway 1 (WebKit had not even requested it).
  await page.waitForTimeout(STEP_MS * 2.5);
  testInfo.annotations.push({ type: 'requested while unseen', description: JSON.stringify(mine()) });
  expect(await readLog(page), 'the image advanced while nobody could see it').toEqual([]);
  expect(await page.evaluate(() => (document.getElementById('img') as HTMLImageElement).src)).toContain(`/g1/${id}.png`);

  // Seen: the browser requests it (if it had not), and gateway 1 is given one
  // step from here, then left for gateway 2, which serves it.
  const seenAt = await page.evaluate(() => {
    document.getElementById('img')!.scrollIntoView({ block: 'center' });
    return Date.now();
  });
  await expect
    .poll(async () => (await readLog(page)).some((e) => e.loaded === 2), { timeout: STEP_MS + 10_000 })
    .toBe(true);
  const log = await readLog(page);
  testInfo.annotations.push({ type: 'requests', description: JSON.stringify(mine()) });
  expect(mine()[0], 'gateway 1 was never requested, so the clock ran on nothing').toBe(`/g1/${id}.png`);
  expect(log.filter((e) => e.hang !== undefined).map((e) => e.hang)).toEqual([1]);
  const hang = log.find((e) => e.hang === 1)!;
  // The step counts from when it was seen, not from page load.
  expect(hang.at - seenAt).toBeGreaterThanOrEqual(STEP_MS - 50);
  expect(await page.evaluate(() => (document.getElementById('img') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test('an eager IPFS image below the fold moves past a hung gateway without being seen', async ({ page }, testInfo) => {
  const id = `eager-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
  // A hung image holds the load event, so wait for the document only.
  await page.goto(`${base}/page?lazy=0&id=${id}`, { waitUntil: 'domcontentloaded' });
  // An eager image is requested at load, so its clock runs from load.
  await expect
    .poll(async () => (await readLog(page)).some((e) => e.loaded === 2), { timeout: STEP_MS + 10_000 })
    .toBe(true);
  const log = await readLog(page);
  expect(log.filter((e) => e.hang !== undefined).map((e) => e.hang)).toEqual([1]);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
