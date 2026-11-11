import { test, expect, type Page } from '@playwright/test';
import { doorHeading, phoneThrottle } from './fixtures/doorFrame';

// THE POOLS PAGE OPENS ON ITS OWN HEADING (law 2; island answer thirty-three, section 4). The
// build writes the page's first frame into dist/pools/index.html, served at /pools as Vercel
// serves it (vite.config.ts, door-pages-preview). React's two fallbacks repeat it, and the page
// replaces it with the same words in the same place. Chromium classes only: the throttle and
// Element Timing are CDP. No reduced motion, as on the island's phone.

test.use({ contextOptions: { reducedMotion: 'no-preference' }, serviceWorkers: 'block' });

test.beforeEach(() => {
  const project = test.info().project.name;
  test.skip(project !== 'chromium' && project !== 'mobile-chrome', 'measured on the Chromium desktop and phone classes');
});

const HEADING = 'Liquidity pools.';
const WAITING = 'Reading this pool from the chain…';
// A mint no room holds, so /pools draws its own door for it and no sheet takes it.
const COIN = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const PLAIN = '/pools';
const WITH_COIN = `/pools?mint=${COIN}`;
const LP_DOOR = `/pools?mint=${COIN}&task=add`;
// Bayla's line (components/BaylaLine.tsx BAYLA_LINE_HEIGHT): it stands down when a coin is in the address.
const BAYLA_LINE = 65;
// A room's coin and its SOL pool (lib/bungalows.ts): the island's add link for it. The app sends
// it to the sheet over its room (lib/sheet.ts) once its script has run.
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const BAYLA_POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const ROOM_LINK = `/pools?mint=${BAYLA}&task=add&pool=${BAYLA_POOL}`;

interface Watch {
  first: number | null;
  paint: number | null;
  page: number | null;
  done: boolean;
  at: Record<string, boolean>;
  gaps: number[];
  frames: number;
  loading: string[];
}

/** From before any page script: when the heading is on screen, and every moment it is not. */
function watchHeading(heading: string) {
  const w: Watch = { first: null, paint: null, page: null, done: false, at: {}, gaps: [], frames: 0, loading: [] };
  (window as unknown as { __pools: Watch }).__pools = w;
  const now = () => Math.round(performance.now());
  const find = () =>
    Array.from(document.querySelectorAll('h1')).find((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim() === heading) ?? null;
  const opacity = (el: Element) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const visible = () => {
    const h = find();
    if (!h) return false;
    const r = h.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && opacity(h) > 0.99;
  };
  const check = () => {
    if (w.done) return;
    if (visible()) {
      if (w.first === null) w.first = now();
      const h = find()!;
      if (w.page === null && h.closest('main#main-content') && !h.closest('[aria-busy="true"]')) w.page = now();
    } else if (w.first !== null) {
      w.gaps.push(now());
    }
    if (w.page !== null && now() > w.page + 1_000) w.done = true;
  };
  // The test's poll runs this too: frames and DOM changes can both stop once the page is still.
  (window as unknown as { __poolsCheck: () => void }).__poolsCheck = check;
  const frame = () => {
    w.frames += 1;
    check();
    if (!w.done) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        // Either skeleton the route had, however briefly: the page's, or the swap's.
        const skeleton = n instanceof Element && (n.matches('[aria-label^="Loading"]') || !!n.querySelector('[aria-label^="Loading"]'));
        if (skeleton || (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === 'Loading...')) w.loading.push(`${now()} ms`);
      }
    }
    check();
  }).observe(document, { childList: true, subtree: true });
  for (const ms of [1_000, 3_000, 7_000]) {
    setTimeout(() => { w.at[ms] = visible(); }, Math.max(0, ms - performance.now()));
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { identifier: string; renderTime: number; loadTime: number }[]) {
        if (e.identifier === 'first-frame-h1' && w.paint === null) w.paint = Math.round(e.renderTime || e.loadTime);
      }
    }).observe({ type: 'element', buffered: true });
  } catch { /* no Element Timing: paint stays null and the assertion names it */ }
}

const readWatch = (page: Page) => page.evaluate(() => {
  const g = window as unknown as { __pools: Watch; __poolsCheck?: () => void };
  g.__poolsCheck?.();
  return g.__pools;
});

/** Hold every request matching `glob` until released: slow, not absent. */
async function hold(page: Page, glob: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(glob, async (route) => {
    await gate;
    await route.continue().catch(() => { /* the page moved on while it was held */ });
  });
  return release;
}

/** The venue's read never answers, so the page stays as it first draws: the door waiting, no status. */
const holdTheChain = (page: Page) => page.route('**/api/**', () => { /* held for the whole test */ });

/** A box, and the words' own run: a change of letter-spacing moves the second only. */
const rect = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const t = range.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height, textWidth: t.width, font: parseFloat(getComputedStyle(el).fontSize) };
});
type Box = Awaited<ReturnType<typeof rect>>;
const near = (now: Box, before: Box, what: string) => {
  for (const k of ['top', 'left', 'width', 'height', 'textWidth', 'font'] as const) {
    expect(Math.abs(now[k] - before[k]), `${what} (${k}: ${before[k]} then ${now[k]})`).toBeLessThanOrEqual(k === 'font' ? 0.1 : 1);
  }
};

test('a crawler reads /pools by its own heading, and a page with no frame of its own still gets the stock shell', async ({ page, request }) => {
  await page.goto('about:blank');
  const stock = await (await request.get('/index.html')).text();
  const res = await request.get(PLAIN);
  expect(res.ok()).toBe(true);
  const html = await res.text();
  expect(html === stock, '/pools served the stock shell').toBe(false);
  const read = await page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const frame = doc.getElementById('first-frame');
    return {
      headings: Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => `${h.tagName} ${(h.textContent ?? '').replace(/\s+/g, ' ').trim()}`),
      gate: doc.documentElement.getAttribute('data-first-frame'),
      inRoot: frame?.parentElement?.id === 'root',
      venue: frame ? frame.querySelectorAll('form, input, img').length : -1,
      text: (frame?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      inline: Array.from(doc.querySelectorAll('script:not([src])')).map((s) => s.getAttribute('type')),
    };
  }, html);
  expect(read.headings).toEqual([`H1 ${HEADING}`]);
  expect(read.gate).toBe('venue');
  expect(read.inRoot).toBe(true);
  expect(read.venue, "the venue's field or picture rode into the page").toBe(0);
  expect(read.text).not.toMatch(/loading|\u2014/i);
  expect(read.inline, 'an inline script the CSP does not pin').toEqual(['application/ld+json']);
  // The tabs beside it have no frame of their own and are served as they were.
  for (const tab of ['/liquidity', '/zap', '/swap']) expect(await (await request.get(tab)).text(), tab).toBe(stock);
});

test('the preview serves /pools the way Vercel does, with or without a query or a slash', async ({ request }) => {
  for (const address of [PLAIN, '/pools/', WITH_COIN, LP_DOOR, '/pools?ref=0x0000000000000000000000000000000000000000']) {
    expect(await (await request.get(address)).text(), address).toContain(`elementtiming="first-frame-h1">${HEADING}</h1>`);
  }
});

test('with the app script blocked, the heading stands where the address puts it, and the door only on an add', async ({ page }) => {
  await page.route('**/assets/index-*.js', (r) => r.abort());
  const heading = page.locator('#first-frame h1');
  const door = page.locator('#first-frame [role="status"]');

  await page.goto(PLAIN);
  await expect(heading).toHaveText(HEADING, { timeout: 15_000 });
  await expect(heading).toBeInViewport();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(door).toBeHidden();
  const plain = await rect(page, '#first-frame h1');

  // A coin in the address: Bayla's line stands down, so the page and its heading sit that much higher.
  await page.goto(WITH_COIN);
  await expect(heading).toBeInViewport();
  await expect(door).toBeHidden();
  const coin = await rect(page, '#first-frame h1');
  expect(plain.top - coin.top).toBe(BAYLA_LINE);

  // An add: the LP door waits above the heading.
  await page.goto(LP_DOOR);
  await expect(door).toHaveText(WAITING);
  await expect(door).toBeInViewport();
  await expect(heading).toBeInViewport();
  const add = await rect(page, '#first-frame h1');
  const line = await rect(page, '#first-frame [role="status"]');
  expect(line.top).toBeLessThan(add.top);
  expect(add.top).toBeGreaterThan(coin.top);

  await page.goto('/zap');
  await expect(page.locator('#first-frame')).toHaveCount(0);
});

test("the frame's words are set the same before the app's stylesheets arrive as after", async ({ page }) => {
  await page.route('**/assets/index-*.js', (r) => r.abort());
  const releaseSheets = await hold(page, '**/assets/*.css');
  const sheetsIn = () => page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/"]'));
    return links.length > 0 && links.every((l) => !!l.sheet && l.sheet.cssRules.length > 0);
  });
  await page.goto(LP_DOOR, { waitUntil: 'commit' });
  await expect(page.locator('#first-frame h1')).toHaveText(HEADING, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  expect(await sheetsIn(), "the app's stylesheets were in before the frame was read").toBe(false);
  const heading = await rect(page, '#first-frame h1');
  const line = await rect(page, '#first-frame [role="status"]');
  // index.css sets the body's text rules; the frame carries its own copy of each that moves a glyph.
  releaseSheets();
  await expect.poll(sheetsIn, { timeout: 30_000 }).toBe(true);
  near(await rect(page, '#first-frame h1'), heading, "the app's stylesheets moved the heading");
  near(await rect(page, '#first-frame [role="status"]'), line, "the app's stylesheets moved the door's line");
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });
  test('/pools reads as the pools page: its heading on screen, the notice a paragraph', async ({ page }) => {
    await page.goto(PLAIN);
    await expect(page.locator('#first-frame h1')).toBeVisible();
    await expect(page.getByRole('heading')).toHaveText([HEADING]);
    await expect(page.locator('noscript p').first()).toHaveText('MEMETICS.FINANCE requires JavaScript');
  });
});

for (const address of [PLAIN, LP_DOOR]) {
  test(`on the phone throttle, ${address === PLAIN ? '/pools' : 'the LP door'} paints its heading under 1 s and never loses it`, async ({ page }) => {
    test.slow();
    await holdTheChain(page);
    await page.addInitScript(watchHeading, HEADING);
    await phoneThrottle(page);
    await page.goto(address, { waitUntil: 'commit' });
    await expect.poll(async () => (await readWatch(page).catch(() => null))?.done ?? false, { timeout: 150_000 }).toBe(true);
    const w = await readWatch(page);
    console.log(`[pools-first-frame] ${test.info().project.name} ${address}: painted ${w.paint} ms, in view ${w.first} ms, page ${w.page} ms, ${w.frames} frames, gaps ${w.gaps.length}`);
    // Soft first, so a red run reports every one of these, not only the first.
    for (const ms of [1_000, 3_000, 7_000]) {
      expect.soft(w.at[ms], `${address}: heading in the viewport at ${ms} ms`).toBe(true);
    }
    expect.soft(w.gaps, `${address}: moments with no heading on screen after it first appeared`).toEqual([]);
    expect.soft(w.loading, `${address}: a skeleton or "Loading" entered the page`).toEqual([]);
    expect(w.paint, `${address}: no Element Timing entry for the heading`).not.toBeNull();
    expect(w.paint!, `${address}: the heading painted too late`).toBeLessThan(1_000);
  });
}

/** HTML frame, the route's fallback, the host's fallback, then the page: nothing moves at any swap. */
async function expectHandoffHolds(page: Page, address: string) {
  const door = address === LP_DOOR;
  await holdTheChain(page);
  await page.addInitScript(watchHeading, HEADING);
  const releaseEntry = await hold(page, '**/assets/index-*.js');
  const releaseHost = await hold(page, '**/assets/PoolsHostPage-*.js');
  const releasePage = await hold(page, '**/assets/PoolsPage-*.js');
  await page.goto(address, { waitUntil: 'commit' });

  await expect(page.locator('#first-frame h1')).toHaveText(HEADING, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const heading = await rect(page, '#first-frame h1');
  const line = door ? await rect(page, '#first-frame [role="status"]') : null;

  // React takes the page: the route's fallback, before the host and its strip exist.
  releaseEntry();
  const busy = 'main#main-content [aria-busy="true"]';
  await expect(page.locator(`${busy} h1`)).toHaveText(HEADING, { timeout: 60_000 });
  await expect(page.locator('main#main-content [role="tabpanel"]')).toHaveCount(0);
  near(await rect(page, `${busy} h1`), heading, "the route's fallback moved the heading");
  if (line) near(await rect(page, `${busy} [role="status"]`), line, "the route's fallback moved the door's line");

  // The host arrives with its strip; the page's own chunk has not.
  releaseHost();
  const panel = 'main#main-content [role="tabpanel"] [aria-busy="true"]';
  await expect(page.locator(`${panel} h1`)).toHaveText(HEADING, { timeout: 60_000 });
  await expect(page.getByRole('tab', { name: 'Add / Remove', exact: true })).toBeVisible();
  near(await rect(page, `${panel} h1`), heading, "the host's fallback moved the heading");
  if (line) near(await rect(page, `${panel} [role="status"]`), line, "the host's fallback moved the door's line");

  // The page.
  releasePage();
  await expect(page.locator(busy)).toHaveCount(0, { timeout: 60_000 });
  const own = page.locator('main#main-content h1').first();
  await expect(own).toHaveText(HEADING);
  await expect(own).toBeInViewport();
  near(await rect(page, 'main#main-content h1'), heading, 'the page moved the heading');
  if (line) near(await rect(page, 'main#main-content [data-testid="lp-door"] [role="status"]'), line, "the page moved the door's line");

  await expect.poll(async () => (await readWatch(page)).done, { timeout: 15_000 }).toBe(true);
  const w = await readWatch(page);
  expect(w.gaps, 'moments with no heading on screen across the three swaps').toEqual([]);
  expect(w.loading, 'a skeleton or "Loading" entered the page').toEqual([]);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

for (const [name, address] of [['/pools', PLAIN], ['/pools with a coin in the address', WITH_COIN], ['the LP door', LP_DOOR]] as const) {
  test(`the handoff keeps ${name} where it was, from HTML to fallback to host to page`, async ({ page }) => {
    test.slow();
    await expectHandoffHolds(page, address);
  });
}

// Either side of 768px, where the heading and the column change size (Tailwind's md), and a small phone.
for (const width of [360, 767, 768]) {
  test(`the handoff keeps /pools and its door where they were at ${width}px`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width, height: 800 });
    await expectHandoffHolds(page, LP_DOOR);
  });
}

test("with the app script blocked, a room's add link stays on /pools: the door's line above the heading", async ({ page }) => {
  await page.route('**/assets/index-*.js', (r) => r.abort());
  await page.goto(ROOM_LINK);
  await expect(page.locator('#first-frame [role="status"]')).toHaveText(WAITING);
  await expect(page.locator('#first-frame h1')).toHaveText(HEADING);
  await expect(page.locator('#first-frame h1')).toBeInViewport();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(ROOM_LINK);
});

interface RoomWatch {
  paint: number | null;
  seen: string[];
  gaps: number[];
  tops: number[];
}

/** From before any page script: each heading with a box, in order, and every frame with none before the room's. */
function watchRoomLink(heading: string) {
  const w: RoomWatch = { paint: null, seen: [], gaps: [], tops: [] };
  (window as unknown as { __room: RoomWatch }).__room = w;
  const frame = () => {
    const boxed = Array.from(document.querySelectorAll('h1')).filter((h) => h.getBoundingClientRect().height > 0);
    for (const h of boxed) {
      const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!w.seen.includes(text)) w.seen.push(text);
      if (text === heading) w.tops.push(h.getBoundingClientRect().top);
    }
    // Only this page's part of the way: once the room's heading is up, the room is the one drawing.
    if (boxed.length === 0 && w.seen.length === 1) w.gaps.push(Math.round(performance.now()));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { identifier: string; renderTime: number; loadTime: number }[]) {
        if (e.identifier === 'first-frame-h1' && w.paint === null) w.paint = Math.round(e.renderTime || e.loadTime);
      }
    }).observe({ type: 'element', buffered: true });
  } catch { /* no Element Timing: paint stays null and the assertion names it */ }
}

test("on the phone throttle, a room's add link paints its heading under 1 s and keeps one on screen until the room's sheet is up", async ({ page }) => {
  test.slow();
  await holdTheChain(page);
  await page.addInitScript(watchRoomLink, HEADING);
  await phoneThrottle(page);
  await page.goto(ROOM_LINK, { waitUntil: 'commit' });
  // The app's own redirect, untouched: the room, with the sheet over it.
  await page.waitForURL('**/bayla?sheet=add', { timeout: 120_000 });
  await expect(page.getByTestId('action-sheet')).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __room: RoomWatch }).__room.seen.length)), { timeout: 60_000 }).toBe(2);
  const w = await page.evaluate(() => (window as unknown as { __room: RoomWatch }).__room);
  console.log(`[pools-first-frame] ${test.info().project.name} ${ROOM_LINK}: painted ${w.paint} ms, headings ${JSON.stringify(w.seen)}, gaps ${w.gaps.length}`);
  expect.soft(w.seen, 'the headings on screen on the way, in order').toEqual([HEADING, doorHeading('/bayla')]);
  expect.soft(w.gaps, 'frames with no heading on screen between the first frame and the room').toEqual([]);
  expect.soft(Math.max(...w.tops) - Math.min(...w.tops), 'the heading moved when the app took the frame').toBeLessThanOrEqual(1);
  expect(w.paint, 'no Element Timing entry for the heading').not.toBeNull();
  expect(w.paint!, 'the heading painted too late').toBeLessThan(1_000);
});

test('a later visit to /pools is a navigation: the skeleton it always had, never the frame', async ({ page }) => {
  await holdTheChain(page);
  const releaseHost = await hold(page, '**/assets/PoolsHostPage-*.js');
  await page.goto('/swap');
  await expect(page.locator('main#main-content')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    window.history.pushState({}, '', '/pools');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('main#main-content [aria-label="Loading swap"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('main#main-content [aria-busy="true"] h1')).toHaveCount(0);
  releaseHost();
  await expect(page.locator('main#main-content h1').first()).toHaveText(HEADING, { timeout: 60_000 });
});
