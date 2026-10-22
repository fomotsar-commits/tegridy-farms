import { test, expect, type Page } from '@playwright/test';

// The Tradermigos splash moves its art from a requestAnimationFrame loop that
// neither index.css's reduced-motion rule nor framer's MotionConfig reaches.
// Every spec runs with reduced motion (playwright.config.ts): here the ten
// pieces (five on a phone) hold still, with no spark and no impact flash, and
// every piece keeps a fifth of its picture in sight (owner rule: art stays
// visible). Without reduced motion the art still moves.

const SPLASH = 'div[role="button"][aria-label="Enter Tradermigos"]';
const PIECE = `${SPLASH} div[style*="translate3d"]:has(> img[src^="/splash/"])`;
// Spread 17 lands two pieces on one spot at desktop size: draw order alone
// left one a tenth in sight, so the pieces must also be eased apart.
const SEEDS = [1, 2, 17];

// The spread is random: a seeded Math.random makes each layout repeatable.
function seedRandom(seed: number) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Opens the splash and stops the page clock once the art is up, so the splash
// cannot leave on its own and each step of time is exact. The clock runs until
// paused, so a pause aimed at a moment already gone is aimed again.
async function openSplashPaused(page: Page) {
  await page.clock.install();
  await page.goto('/nakamigos');
  await page.locator(PIECE).first().waitFor({ timeout: 30_000 });
  for (let attempt = 0; ; attempt++) {
    try {
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 200);
      return;
    } catch (e) {
      if (attempt > 4 || !/past/.test(String(e))) throw e;
    }
  }
}

async function readSplash(page: Page) {
  return page.evaluate(
    ({ splash, piece }) => {
      const root = document.querySelector(splash);
      const pieces = [...document.querySelectorAll<HTMLElement>(piece)];
      return {
        transforms: pieces.map((p) => p.style.transform),
        loaded: pieces.every((p) => {
          const img = p.querySelector<HTMLImageElement>(':scope > img');
          return !!img && img.complete && img.naturalWidth > 0;
        }),
        sparks: root?.querySelector(':scope > div[style*="z-index: 5"]')?.childElementCount ?? -1,
        flash: !!root?.querySelector(':scope > div[style*="z-index: 12"]'),
      };
    },
    { splash: SPLASH, piece: PIECE },
  );
}

// Share of each picture the visitor can see: the browser's own hit test, on a
// 10 px grid, says whose picture is on top at each point (pieces turned off for
// pointers are turned on for the count, then back off).
async function shownShares(page: Page) {
  return page.evaluate((piece) => {
    const imgs = [...document.querySelectorAll<HTMLElement>(piece)].map(
      (p) => p.querySelector<HTMLImageElement>(':scope > img')!,
    );
    for (const img of imgs) img.style.pointerEvents = 'auto';
    const shares = imgs.map((img) => {
      const r = img.getBoundingClientRect();
      let hits = 0;
      for (let x = Math.max(0, r.left) + 5; x < Math.min(innerWidth, r.right); x += 10) {
        for (let y = Math.max(0, r.top) + 5; y < Math.min(innerHeight, r.bottom); y += 10) {
          if (document.elementFromPoint(x, y) === img) hits++;
        }
      }
      return { src: img.getAttribute('src'), share: (hits * 100) / (img.offsetWidth * img.offsetHeight) };
    });
    for (const img of imgs) img.style.pointerEvents = '';
    return shares;
  }, PIECE);
}

for (const seed of SEEDS) {
  test(`reduced motion, spread ${seed}: the splash art holds still and every piece shows`, async ({ page }) => {
    const expected = (page.viewportSize()?.width ?? 1280) < 768 ? 5 : 10;
    await page.addInitScript(seedRandom, seed);
    await openSplashPaused(page);

    const first = await readSplash(page);
    expect(first.transforms).toHaveLength(expected);
    let sparks = first.sparks;
    let flash = first.flash;
    for (let step = 1; step <= 6; step++) {
      await page.clock.runFor(100);
      const now = await readSplash(page);
      expect(now.transforms, `piece transforms ${step * 100} ms later`).toEqual(first.transforms);
      sparks = Math.max(sparks, now.sparks);
      flash ||= now.flash;
    }
    expect(sparks, 'sparks drawn').toBe(0);
    expect(flash, 'impact flash drawn').toBe(false);

    await expect.poll(async () => (await readSplash(page)).loaded, { timeout: 20_000 }).toBe(true);
    for (const { src, share } of await shownShares(page)) {
      expect(share, `share of ${src} in sight`).toBeGreaterThanOrEqual(0.2);
    }
  });
}

test.describe('without reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('the splash art still moves', async ({ page }) => {
    await page.addInitScript(seedRandom, SEEDS[0]);
    await openSplashPaused(page);
    const before = await readSplash(page);
    await page.clock.runFor(300);
    const after = await readSplash(page);
    expect(after.transforms.filter((t, i) => t !== before.transforms[i]).length).toBe(before.transforms.length);
  });
});
