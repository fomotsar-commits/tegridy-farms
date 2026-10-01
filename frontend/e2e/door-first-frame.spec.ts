import { test, expect, type Page } from '@playwright/test';
import { DOOR_ROUTES, doorHeading, phoneThrottle } from './fixtures/doorFrame';

// A DOOR OPENS ON ITS OWN NAME (answer fourteen point two, ruling 5). The build writes
// each door's first frame into dist/<door>/index.html, served at /<door> as Vercel does
// (vite.config.ts, door-pages-preview); React's fallback repeats it and the hero replaces
// it with the same words in the same place. Chromium classes only: the throttle and
// Element Timing are CDP and Chromium. No reduced motion, as on the island's phone.

test.use({ contextOptions: { reducedMotion: 'no-preference' }, serviceWorkers: 'block' });

test.beforeEach(() => {
  const project = test.info().project.name;
  test.skip(project !== 'chromium' && project !== 'mobile-chrome', 'measured on the Chromium desktop and phone classes');
});

interface Watch {
  first: number | null;
  paint: number | null;
  hero: number | null;
  done: boolean;
  at: Record<string, { visible: boolean; busy: boolean }>;
  gaps: number[];
  frames: number;
  loading: string[];
}

/** From before any page script: when the door's heading is on screen, and every moment it is not. */
function watchHeading(heading: string) {
  const w: Watch = { first: null, paint: null, hero: null, done: false, at: {}, gaps: [], frames: 0, loading: [] };
  (window as unknown as { __door: Watch }).__door = w;
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
      if (w.hero === null && h.closest('main#main-content') && !h.closest('[aria-busy="true"]')) w.hero = now();
    } else if (w.first !== null) {
      w.gaps.push(now());
    }
    if (w.hero !== null && now() > w.hero + 1_000) w.done = true;
  };
  const frame = () => {
    w.frames += 1;
    check();
    if (!w.done) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        // The route skeleton (PageSkeleton, "Loading..."), however briefly. A card's own
        // placeholder further down the page ("Loading chart...") is the page, not a gap.
        const skeleton = n instanceof Element && (n.matches('[aria-label="Loading page"]') || !!n.querySelector('[aria-label="Loading page"]'));
        if (skeleton || (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === 'Loading...')) w.loading.push(`${now()} ms`);
      }
    }
    check();
  }).observe(document, { childList: true, subtree: true });
  for (const ms of [1_000, 3_000, 7_000]) {
    setTimeout(() => {
      const h = find();
      w.at[ms] = { visible: visible(), busy: !!h?.closest('[aria-busy="true"]') };
    }, Math.max(0, ms - performance.now()));
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { identifier: string; renderTime: number; loadTime: number }[]) {
        if (e.identifier === 'first-frame-h1' && w.paint === null) w.paint = Math.round(e.renderTime || e.loadTime);
      }
    }).observe({ type: 'element', buffered: true });
  } catch { /* no Element Timing: paint stays null and the assertion names it */ }
}

const readWatch = (page: Page) => page.evaluate(() => (window as unknown as { __door: Watch }).__door);

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

/** What a crawler reads: the served HTML parsed with scripting off. */
async function crawl(page: Page, html: string) {
  return page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const frame = doc.getElementById('first-frame');
    const img = frame?.querySelector('img');
    return {
      title: doc.title,
      headings: Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(
        (h) => `${h.tagName} ${(h.textContent ?? '').replace(/\s+/g, ' ').trim()}`,
      ),
      gate: doc.documentElement.getAttribute('data-first-frame'),
      inRoot: frame?.parentElement?.id === 'root',
      frameText: (frame?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      frameValues: frame ? Array.from(frame.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.value)) : [],
      extras: frame ? frame.querySelectorAll('form, input, p').length : -1,
      img: img
        ? {
          src: img.getAttribute('src') ?? '',
          alt: img.getAttribute('alt'),
          loading: img.getAttribute('loading'),
          candidates: (img.getAttribute('srcset') ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean),
        }
        : null,
    };
  }, html);
}

test('a crawler reads each door by its own heading, /toweli and its alias included', async ({ page, request }) => {
  // Answer fifteen, item 5: "The done-means was every door." The TOWELI room is the
  // door that was left on the stock shell; its alias opens the same room.
  expect(DOOR_ROUTES).toEqual(expect.arrayContaining(['/toweli', '/towelie']));
  await page.goto('about:blank');
  const stock = await (await request.get('/index.html')).text();
  for (const route of DOOR_ROUTES) {
    const res = await request.get(route);
    expect(res.ok(), `${route}: not served`).toBe(true);
    const html = await res.text();
    expect(html === stock, `${route}: served the stock shell`).toBe(false);
    const door = await crawl(page, html);
    expect(door.title, `${route}: served the stock shell, not the door's own HTML`).not.toMatch(/^MEMETICS\.FINANCE/);
    expect(door.headings, `${route}: the headings a crawler reads`).toEqual([`H1 ${doorHeading(route)}`]);
    expect(door.gate, `${route}: the frame ships hidden`).toBe('venue');
    expect(door.inRoot).toBe(true);
    expect(door.frameText).toBe(doorHeading(route));
    expect(door.extras, `${route}: the venue's lines or form rode into the door`).toBe(0);
    expect(door.img?.alt).toBe('');
    expect(door.img?.loading, `${route}: the hero art is above the fold`).toBeNull();
    const dashed = [door.frameText, ...door.frameValues].filter((v) => v.includes('\u2014'));
    expect(dashed, `${route}: an em dash in the frame`).toEqual([]);
    // A missing file answers 200 text/html through the SPA fallback, so the type is the check.
    for (const url of [door.img!.src, ...door.img!.candidates]) {
      const art = await request.get(url);
      expect(art.headers()['content-type'] ?? '', `${route}: ${url} is not an image the build produced`).toMatch(/^image\//);
    }
  }
  // A route that is no door still gets the stock shell, whose frame opens only on `/`.
  expect(await (await request.get('/farm')).text(), '/farm must serve the stock shell').toBe(stock);
  const farm = await crawl(page, stock);
  expect(farm.gate, 'the stock shell opens no frame from the HTML').toBeNull();
  expect(farm.headings[0], "the stock shell still carries the venue's own frame").toBe('H1 MEMETICS.FINANCE Held time counts here.');
});

test('the preview serves a door the way Vercel does, with or without a query or a slash', async ({ request }) => {
  const cases: [string, string][] = [
    ['/bayla', 'BAYLA | The muse of Jungle Bay Island'],
    ['/bayla?heat=0x0000000000000000000000000000000000000000', 'BAYLA | The muse of Jungle Bay Island'],
    ['/bayla/', 'BAYLA | The muse of Jungle Bay Island'],
    ['/toweli', 'TOWELI | Jungle Bay Island'],
    ['/toweli/', 'TOWELI | Jungle Bay Island'],
    ['/toweli?ref=0x0000000000000000000000000000000000000000', 'TOWELI | Jungle Bay Island'],
    ['/towelie', 'TOWELI | Jungle Bay Island'],
  ];
  for (const [path, title] of cases) {
    const html = await (await request.get(path)).text();
    expect(html, path).toContain(`<title>${title}</title>`);
  }
  // The alias is the same room, so it names the room's own address as canonical.
  expect(await (await request.get('/towelie')).text()).toContain('<link rel="canonical" href="https://memetics.finance/toweli" />');
});

test('with the app script blocked, every door shows its own heading, and a page that is no door none', async ({ page }) => {
  await page.route('**/assets/index-*.js', (r) => r.abort());
  for (const route of DOOR_ROUTES) {
    await page.goto(route);
    const h1 = page.locator('#first-frame h1');
    await expect(h1, route).toHaveText(doorHeading(route), { timeout: 15_000 });
    await expect(h1, route).toBeInViewport();
    await expect(page.locator('h1'), `${route}: a second heading`).toHaveCount(1);
  }
  await page.goto('/farm');
  await expect(page.locator('#first-frame')).toHaveCount(0);
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });
  for (const [route, room] of [['/bayla', 'BAYLA'], ['/toweli', 'TOWELI']] as const) {
    test(`${route} reads as ${room}: its heading on screen, the notice a paragraph`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('#first-frame h1')).toBeVisible();
      await expect(page.getByRole('heading')).toHaveText([doorHeading(route)]);
      await expect(page.locator('noscript p').first()).toHaveText('MEMETICS.FINANCE requires JavaScript');
    });
  }
});

for (const route of ['/bayla', '/pepe', '/toweli']) {
  test(`on the phone throttle, ${route} paints its heading under 1 s and never loses it`, async ({ page }) => {
    test.slow();
    await page.addInitScript(watchHeading, doorHeading(route));
    await phoneThrottle(page);
    await page.goto(route, { waitUntil: 'commit' });
    await expect.poll(async () => (await readWatch(page).catch(() => null))?.done ?? false, { timeout: 150_000 }).toBe(true);
    const w = await readWatch(page);
    console.log(`[door-first-frame] ${test.info().project.name} ${route}: painted ${w.paint} ms, in view ${w.first} ms, hero ${w.hero} ms, ${w.frames} frames, gaps ${w.gaps.length}`);
    // Soft first, so a red run reports every one of these, not only the first.
    for (const ms of [1_000, 3_000, 7_000]) {
      expect.soft(w.at[ms]?.visible, `${route}: heading in the viewport at ${ms} ms`).toBe(true);
    }
    expect.soft(w.gaps, `${route}: moments with no heading on screen after it first appeared`).toEqual([]);
    expect.soft(w.loading, `${route}: "Loading" entered the page`).toEqual([]);
    expect(w.paint, `${route}: no Element Timing entry for the heading`).not.toBeNull();
    expect(w.paint!, `${route}: the heading painted too late`).toBeLessThan(1_000);
  });
}

// /toweli too: its hero is HomePage's classic cluster, not BungalowHero, so it is the
// one door whose hero is a different component from the one the frame was placed for.
for (const route of ['/bayla', '/toweli']) {
  test(`the handoff keeps ${route}'s heading where it was, from HTML to fallback to hero`, async ({ page }) => {
    test.slow();
    const heading = doorHeading(route);
    await page.addInitScript(watchHeading, heading);
    const releaseEntry = await hold(page, '**/assets/index-*.js');
    const releaseHome = await hold(page, '**/assets/HomePage-*.js');
    await page.goto(route, { waitUntil: 'commit' });
    // The box, and the words' own run: a change of letter-spacing moves the second only.
    const rect = (sel: string) => page.locator(sel).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height, textWidth: t.width };
    });
    const near = (a: Record<string, number>, b: Record<string, number>, what: string) => {
      for (const k of ['top', 'left', 'width', 'height', 'textWidth']) {
        expect(Math.abs(a[k]! - b[k]!), `${what} moved the heading (${k}: ${b[k]} then ${a[k]})`).toBeLessThanOrEqual(1);
      }
    };

    const staticH1 = page.locator('#first-frame h1');
    await expect(staticH1).toHaveText(heading, { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    const before = await rect('#first-frame h1');

    releaseEntry();
    const fallback = page.locator('main#main-content [aria-busy="true"] h1');
    await expect(fallback).toHaveText(heading, { timeout: 60_000 });
    near(await rect('main#main-content [aria-busy="true"] h1'), before, 'the fallback');

    releaseHome();
    await expect(page.locator('main#main-content [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
    const hero = page.locator('main#main-content h1').first();
    await expect(hero).toHaveText(heading);
    await expect(hero).toBeInViewport();
    near(await rect('main#main-content h1'), before, 'the hero');
    await expect.poll(async () => (await readWatch(page)).done, { timeout: 15_000 }).toBe(true);
    const w = await readWatch(page);
    expect(w.gaps, 'moments with no heading on screen across the two swaps').toEqual([]);
    expect(w.loading, '"Loading" entered the page').toEqual([]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
}
