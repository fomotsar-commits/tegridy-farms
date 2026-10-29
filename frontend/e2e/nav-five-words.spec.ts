// The island's venue review, item 1, as the owner took it on 2026-10-03: the bar reads
// Island · Lock · Launch · Swap at every width (Heat and Rooms became Island on 2026-10-18),
// one menu opens at every width and is the site's index, every section's word with its pages
// under it (owner, 2026-10-19), the footer is eight links on one screen, and no bar or tab
// strip says Soon. Walked on the production build at a phone, an iPad held upright and a laptop.
import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const WORDS = ['Island', 'Lock', 'Launch', 'Swap'];

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'iPad', width: 820, height: 1180 },
  { name: 'laptop', width: 1280, height: 900 },
] as const;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'a viewport sweep: the chromium project sets each size itself');
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
    } catch {
      /* private mode */
    }
  });
});

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator('nav[aria-label="Main navigation"]:visible a').first().waitFor({ timeout: 30_000 });
}

/** The words of the one bar this width shows, and which of them is lit. */
async function bar(page: Page) {
  return page.locator('nav[aria-label="Main navigation"]:visible a').evaluateAll((as) => ({
    words: as.map((a) => (a as HTMLElement).innerText.trim()),
    lit: as.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => (a as HTMLElement).innerText.trim()),
  }));
}

for (const size of SIZES) {
  test.describe(`at ${size.width}x${size.height} (${size.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
    });

    test('the bar reads Island · Lock · Launch · Swap on every route, one word lit where it owns the page', async ({ page }) => {
      test.slow();
      const expectLit: Record<string, string[]> = {
        '/': ['Island'],
        // Entering BAYLA's room makes Island her room's own page (owner, 2026-10-17).
        '/bayla': ['Island'],
        '/island': ['Island'],
        '/earn': ['Lock'],
        '/launch': ['Launch'],
        '/swap': ['Swap'],
        '/pools': [],
        '/trust': [],
      };
      for (const [path, lit] of Object.entries(expectLit)) {
        await open(page, path);
        const read = await bar(page);
        expect(read.words, `the bar on ${path}`).toEqual(WORDS);
        expect(read.lit, `the lit word on ${path}`).toEqual(lit);
      }
    });

    test("the menu is the site's index: every section's word with its pages under it, two columns at most; Pools opens the Venue AMM tab", async ({ page }) => {
      await open(page, '/');
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
      await expect(drawer).toBeVisible();
      const index = drawer.getByRole('navigation', { name: 'Site index' });
      await expect(index.getByRole('heading', { level: 2 })).toHaveText(['Island', 'Swap', 'Pools', 'Lock', 'Launch', 'Check', 'Records']);
      for (const word of ['Island', 'Swap', 'Pools', 'Lock', 'Launch', 'Check']) {
        await expect(index.getByRole('link', { name: word, exact: true }), word).toBeVisible();
      }
      // Owner, 2026-10-18: the shadowed features, each one tap; 2026-10-19: organised, under their words.
      for (const [word, name] of [['Lock', 'NFT Loans'], ['Check', 'Charting'], ['Island', 'Lore']] as const) {
        await expect(index.getByRole('region', { name: word }).getByRole('link', { name, exact: true }), `${name} under ${word}`).toBeVisible();
      }
      // Owner, 2026-10-24: the Nakamigos marketplace is no longer in the index.
      await expect(index.getByRole('link', { name: 'Marketplace', exact: true })).toHaveCount(0);
      // The groups run in one, two or three columns, never more; no word is cut short, and the
      // index runs off the screen neither sideways nor under the picture.
      const lefts = await index.getByRole('heading', { level: 2 }).evaluateAll((hs) => hs.map((h) => Math.round(h.getBoundingClientRect().left)));
      expect(new Set(lefts).size, 'the index runs in more than three columns').toBeLessThanOrEqual(3);
      const cut = await index.getByRole('link').evaluateAll((as) => as.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.textContent));
      expect(cut, 'a word in the index is cut short').toEqual([]);
      expect(await index.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), 'the index scrolls sideways').toBe(true);
      await index.getByRole('link', { name: 'Pools', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/pools');
      await expect(page.getByRole('tab', { name: 'Venue AMM', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    });

    test('nothing lies over the open drawer: every row takes its own tap', async ({ page }) => {
      // The menu covers the screen, where the phone's bottom bar (z-50) and Towelie (z-[60])
      // also live; at the bar's z the bar was drawn over the menu's last rows.
      await open(page, '/');
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
      await expect(drawer.getByRole('link').last()).toBeVisible();
      // Each row is the topmost thing at its own centre.
      const covered = await drawer.getByRole('link').evaluateAll((as) => as.flatMap((a) => {
        a.scrollIntoView({ block: 'nearest' });
        const b = a.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return top && a.contains(top) ? [] : [`${a.textContent} (under ${top?.tagName ?? 'nothing'} ${top?.closest('nav')?.getAttribute('aria-label') ?? ''})`];
      }));
      expect(covered, 'a drawer row is covered by something drawn over it').toEqual([]);
      // And the screen's edges, where the bars sit, whether or not a row reaches them today.
      const edges = await drawer.evaluate((d) => {
        const w = innerWidth, h = innerHeight;
        return [[w / 2, h - 8], [8, h - 8], [w - 8, h - 8], [w / 2, 8], [w - 8, h / 2]].flatMap(([x, y]) => {
          const top = document.elementFromPoint(x!, y!);
          return top && d.contains(top) ? [] : [`${Math.round(x!)},${Math.round(y!)} is ${top?.tagName ?? 'nothing'} ${top?.closest('nav')?.getAttribute('aria-label') ?? ''}`];
        });
      });
      expect(edges, 'something is drawn over the open menu').toEqual([]);
    });

    test('the footer is eight links, on one screen above the bar', async ({ page }) => {
      test.slow();
      for (const path of ['/', '/swap', '/bayla', '/toweli']) {
        await open(page, path);
        const footer = page.locator('footer[role="contentinfo"]');
        await footer.scrollIntoViewIfNeeded();
        await expect(footer.getByRole('navigation', { name: 'Footer' }).getByRole('link'), path).toHaveCount(8);
        const fit = await page.evaluate(() => {
          const f = document.querySelector('footer[role="contentinfo"]')!.getBoundingClientRect();
          const bottomBar = [...document.querySelectorAll('nav[aria-label="Main navigation"]')]
            .map((n) => n.getBoundingClientRect())
            .find((r) => r.height > 0 && r.bottom >= window.innerHeight - 1 && r.top > window.innerHeight / 2);
          return { footer: Math.round(f.height), room: window.innerHeight - (bottomBar ? Math.round(bottomBar.height) : 0) };
        });
        expect(fit.footer, `the footer on ${path} is ${fit.footer}px, past one screen (${fit.room}px)`).toBeLessThanOrEqual(fit.room);
      }
    });
  });
}

test('Island, pressed on another page, opens the home, whose hall opens the island page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/swap');
  await page.locator('nav[aria-label="Main navigation"]:visible').getByRole('link', { name: 'Island' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  // The lobby (the whole board, the arrival film) has no word of its own: the hall links it.
  await page.getByRole('link', { name: 'The whole island' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/island');
  await expect(page.getByRole('heading', { name: 'The island', level: 1 })).toBeVisible({ timeout: 30_000 });
});

test('the footer fits the height a real iPhone browser gives a page', async ({ page }) => {
  // 390x664: Safari on an iPhone 14 with its own bars showing.
  await page.setViewportSize({ width: 390, height: 664 });
  for (const path of ['/', '/bayla']) {
    await open(page, path);
    const footer = page.locator('footer[role="contentinfo"]');
    await footer.scrollIntoViewIfNeeded();
    const h = await footer.evaluate((f) => f.getBoundingClientRect().height);
    expect(h, `the footer on ${path} at 390x664`).toBeLessThanOrEqual(664 - 64);
  }
});

test('no tab strip says Soon, and an off tab is listed only on its own page', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ['/launch', '/eth-curve', '/curve-launch', '/earn', '/trust', '/nft-finance', '/pools']) {
    await open(page, path);
    const strips = page.getByRole('tablist');
    await expect(strips.first(), `no tab strip on ${path}`).toBeVisible({ timeout: 30_000 });
    for (const text of await strips.allInnerTexts()) {
      expect(text, `a tab strip on ${path} says Soon`).not.toMatch(/\bsoon\b/i);
    }
  }
  // Launching on Solana is off in a production build (curveWriteFlag.ts), so its tab is not
  // listed off its own page, and on its own page it is the lit tab.
  await open(page, '/launch');
  await expect(page.getByRole('tab', { name: 'Solana Curve' })).toHaveCount(0);
  await open(page, '/curve-launch');
  await expect(page.getByRole('tab', { name: 'Solana Curve' })).toHaveAttribute('aria-selected', 'true');
});
