/**
 * Small layout faults found on phones (2026-10-13), each measured from rendered boxes on a
 * production build. Every test sets its own width, so a test fails on the fault it names
 * in any project; the TOWELI room's corner and Safari's focus each say why they differ.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { expectNoSidewaysScroll } from './fixtures/pageWidth';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

async function settle(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await gotoRoute(page, path);
  await page.evaluate(() => document.fonts.ready);
  await waitForQuiescence(page, { quietMs: 500, timeout: 8_000 });
}

test('/changelog at 360px: every line wraps inside its card, none runs past it', async ({ page, walletMock: _w }) => {
  await settle(page, '/changelog', { width: 360, height: 800 });
  const read = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-record="changelog"] li'));
    const past = items.flatMap((li) => {
      const text = li.lastElementChild!;
      const panel = li.closest('ul')!.parentElement!;
      const inner = panel.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).paddingRight);
      const right = Math.max(text.getBoundingClientRect().left + text.scrollWidth, ...Array.from(text.getClientRects()).map((b) => b.right));
      return right > inner + 0.5 ? [`"${(text.textContent ?? '').slice(0, 50)}" runs ${Math.round(right - inner)}px past its panel`] : [];
    });
    return { lines: items.length, past };
  });
  expect(read.lines, 'the changelog lines').toBeGreaterThan(100);
  expect(read.past, 'lines cut off at the right edge of their card').toEqual([]);
});

test('/nft-finance?section=pooled at 360px: the "Not deployed" badges stay on screen and the page does not slide', async ({ page, walletMock: _w }) => {
  await settle(page, '/nft-finance?section=pooled', { width: 360, height: 800 });
  await expect(page.getByText('Not deployed', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expectNoSidewaysScroll(page);
});

test('in the TOWELI room at 390px, the corner steps aside from a section tab instead of covering it', async ({ page, walletMock: _w }) => {
  // Token Lending's own tabs ("My Loans") pass under the corner as the page scrolls. The
  // section row no longer does: it sits under the heading (2026-10-14). Nor do the NFT
  // AMM's: the fewer-words pass lifted them above the corner's line on a first screen.
  await settle(page, '/nft-finance?section=lending&bungalow=toweli', { width: 390, height: 844 });
  // By CSS: a corner that has stepped aside is hidden, so no role query finds it.
  await expect(page.locator('button[aria-label="Towelie says hi"]')).toHaveCount(1, { timeout: 15_000 });
  const scan = await page.evaluate(async () => {
    const frames = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null))); };
    const corner = document.querySelector('button[aria-label="Towelie says hi"]')!;
    const covered: string[] = [];
    let under = 0;
    let shown = 0;
    const max = document.documentElement.scrollHeight - innerHeight;
    for (let y = 0; y <= max; y += 40) {
      window.scrollTo(0, y);
      await frames(4);
      const m = corner.getBoundingClientRect();
      if (corner.checkVisibility({ visibilityProperty: true, opacityProperty: true })) shown += 1;
      for (const tab of document.querySelectorAll('[role="tab"]')) {
        const b = tab.getBoundingClientRect();
        const x0 = Math.max(b.left, m.left), x1 = Math.min(b.right, m.right);
        const y0 = Math.max(b.top, m.top), y1 = Math.min(b.bottom, m.bottom);
        if (b.width === 0 || x1 <= x0 || y1 <= y0) continue;
        under += 1;
        const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
        const visible = corner.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        if (!hit || !tab.contains(hit) || visible) {
          const owner = hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? 'no label';
          covered.push(`at ${y}px scrolled, "${(tab.textContent ?? '').trim().slice(0, 20)}" is under the corner (${visible ? 'shown' : 'hidden'}, a press there lands on ${hit ? hit.tagName.toLowerCase() : 'nothing'} in "${owner}")`);
        }
      }
    }
    return { covered, under, shown };
  });
  expect(scan.under, 'no tab ever passed under the corner: the page changed shape').toBeGreaterThan(0);
  expect(scan.shown, 'the corner never showed: it must step aside, not leave').toBeGreaterThan(0);
  expect(scan.covered, 'tabs the corner covered').toEqual([]);
});

test('in the TOWELI room at 390px with motion on, a press on a tab sliding under the corner lands on the tab while the corner fades', async ({ page, walletMock: _w }) => {
  // The corner takes 200ms to fade aside, and a fading element still takes presses: the
  // first step that brought a tab ("My Pools", then) under it pressed Towelie (2026-10-14).
  // Token Lending's "My Loans" is the tab that passes under it now. The other tests run
  // with motion reduced, where only WebKit's fade lasts long enough to see.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle(page, '/nft-finance?section=lending&bungalow=toweli', { width: 390, height: 844 });
  await expect(page.locator('button[aria-label="Towelie says hi"]')).toHaveCount(1, { timeout: 15_000 });
  const scan = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const corner = document.querySelector('button[aria-label="Towelie says hi"]')!;
    const opacity = () => {
      let o = 1;
      for (let e: Element | null = corner; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const under = () => {
      const m = corner.getBoundingClientRect();
      return Array.from(document.querySelectorAll('[role="tab"]')).flatMap((tab) => {
        const b = tab.getBoundingClientRect();
        const x0 = Math.max(b.left, m.left), x1 = Math.min(b.right, m.right);
        const y0 = Math.max(b.top, m.top), y1 = Math.min(b.bottom, m.bottom);
        return b.width === 0 || x1 <= x0 || y1 <= y0 ? [] : [{ tab, x: (x0 + x1) / 2, y: (y0 + y1) / 2 }];
      });
    };
    const missed: string[] = [];
    let fading = 0;
    const max = document.documentElement.scrollHeight - innerHeight;
    for (let y = 0; y <= max; y += 40) {
      window.scrollTo(0, y);
      // Press at the first frame the corner has begun to step aside, mid-fade.
      for (let i = 0; i < 30 && under().length && opacity() >= 1; i++) await frame();
      const o = opacity();
      for (const { tab, x, y: py } of under()) {
        if (o > 0 && o < 1) fading += 1;
        const hit = document.elementFromPoint(x, py);
        if (!hit || !tab.contains(hit)) {
          const owner = hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? 'no label';
          missed.push(`at ${y}px scrolled, a press on "${(tab.textContent ?? '').trim().slice(0, 20)}" lands on ${hit ? hit.tagName.toLowerCase() : 'nothing'} in "${owner}" (corner opacity ${o.toFixed(2)})`);
        }
      }
    }
    return { missed, fading };
  });
  expect(scan.fading, 'no press was made while the corner faded: the page or its timing changed').toBeGreaterThan(0);
  expect(scan.missed, 'presses on a tab the fading corner took').toEqual([]);
});

for (const path of ['/', '/toweli']) {
  test(`${path} at 390px: each chain pill presses 44px tall while it paints small`, async ({ page, walletMock: _w }) => {
    await settle(page, path, { width: 390, height: 844 });
    const pills = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('main#main-content a[aria-label^="Live on"]')).map((a) => {
        const b = a.getBoundingClientRect();
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const lands = (px: number, py: number) => a.contains(document.elementFromPoint(px, py));
        // A press 22px either side of the middle still lands on the pill: 44px across.
        return {
          text: (a.textContent ?? '').trim(),
          painted: Math.round(b.height * 10) / 10,
          tall: [lands(x, y - 22), lands(x, y + 22)],
          wide: [lands(x - 22, y), lands(x + 22, y)],
        };
      }),
    );
    expect(pills.map((p) => p.text)).toEqual(['SOLANA', 'ETHEREUM', 'BASE', 'ROBINHOOD']);
    for (const p of pills) {
      expect(p.painted, `${p.text}: the pill grew`).toBeLessThan(30);
      expect(p.tall, `${p.text}: a press 22px above or below its middle misses it`).toEqual([true, true]);
      expect(p.wide, `${p.text}: a press 22px left or right of its middle misses it`).toEqual([true, true]);
    }
  });
}

test('/launch at 390px: all four steps are on screen, none cut off', async ({ page, walletMock: _w }) => {
  await settle(page, '/launch', { width: 390, height: 844 });
  const third = page.getByText('Fees & disclosure', { exact: true }).first();
  await expect(third).toBeVisible({ timeout: 15_000 });
  const read = await third.evaluate((label) => {
    const row = label.parentElement!.parentElement!;
    const box = row.getBoundingClientRect();
    return {
      steps: Array.from(row.children).map((step) => {
        const b = step.getBoundingClientRect();
        return { text: (step.textContent ?? '').replace(/—/g, '').trim(), inside: b.left >= box.left - 0.5 && b.right <= box.right + 0.5 };
      }),
      scrolls: row.scrollWidth > row.clientWidth,
      window: document.documentElement.clientWidth,
      right: box.right,
    };
  });
  expect(read.steps.map((s) => s.text)).toEqual(['1Details', '2Tier & curve', '3Fees & disclosure', '4Review']);
  expect(read.steps.filter((s) => !s.inside).map((s) => s.text), 'steps cut off by the row').toEqual([]);
  expect(read.scrolls, 'the row hides steps behind a sideways scroll').toBe(false);
  expect(read.right).toBeLessThanOrEqual(read.window);
});

test('the heat card at 390px: "Post my number" and "How heat is earned" do not touch', async ({ page, walletMock: _w }) => {
  const address = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
  await page.route('**/api/aggregator**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('resource') !== 'heat') return route.fallback();
    const now = Math.floor(Date.now() / 1000);
    // A warm read: the share button shows only under one.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address, degrees: 394.66, tier: 'Builder', is_cold: false,
        held_since_unix: now - 400 * 86_400, as_of_unix: now - 3_600, token_count: 1,
        breakdown: [{ token_address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', chain: 'ethereum', name: 'Towelie', symbol: 'TOWELI', heat_degrees: 394.66, first_seen_at_unix: now - 400 * 86_400, last_transfer_at_unix: now - 30 * 86_400 }],
      }),
    });
  });
  await settle(page, `/?heat=${address}`, { width: 390, height: 844 });
  const post = page.getByRole('link', { name: 'Post my number' });
  await expect(post).toBeVisible({ timeout: 30_000 });
  const a = (await post.boundingBox())!;
  const b = (await page.getByRole('button', { name: 'How heat is earned' }).boundingBox())!;
  const sideways = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const upDown = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  expect(Math.max(sideways, upDown), `the two are ${Math.round(sideways)}px apart sideways and ${Math.round(upDown)}px up and down`).toBeGreaterThanOrEqual(8);
});

test.describe('/airdrop, a page with no tab strip, at 390x664', () => {
  /** The distributor field put 20px down the screen, under the 56px top bar. */
  async function underTheBar(page: Page) {
    await settle(page, '/airdrop', { width: 390, height: 664 });
    const field = page.locator('main#main-content input[placeholder^="0x"]').first();
    await expect(field).toBeVisible();
    const bar = await page.locator('header').first().evaluate((h) => h.getBoundingClientRect().bottom);
    await field.evaluate((f) => window.scrollBy(0, f.getBoundingClientRect().top - 20));
    await expect.poll(() => field.evaluate((f) => f.getBoundingClientRect().top), { message: 'the field could not be put under the bar' }).toBeLessThan(30);
    return { field, bar };
  }

  // Safari lands a focused field up to 15px above the page's scroll padding, so the room
  // under the bar must hold that. A scroll lands exactly on it, in every engine.
  test('the room kept under the top bar holds Safari\'s 15px', async ({ page, walletMock: _w }) => {
    const { field, bar } = await underTheBar(page);
    await field.evaluate((f) => f.scrollIntoView({ block: 'start' }));
    await expect.poll(() => field.evaluate((f) => Math.round(f.getBoundingClientRect().top - (document.querySelector('header')!.getBoundingClientRect().bottom)))).toBeGreaterThanOrEqual(15);
    expect(bar).toBe(56);
  });

  test('a focused text field lands below the top bar', async ({ page, browserName, walletMock: _w }) => {
    test.skip(browserName !== 'webkit', 'Chromium centres a focused field; only WebKit lands it at the scroll padding');
    const { field, bar } = await underTheBar(page);
    await field.focus();
    await expect.poll(() => field.evaluate((f) => f.getBoundingClientRect().top), { message: `the field sits under the top bar (it ends at ${bar}px)` }).toBeGreaterThanOrEqual(bar);
  });

  // "Campaign address" sat under the bar while its field was clear of it (2026-10-13).
  const labelTop = (page: Page) => page.locator('label[for="claim-distributor"]').evaluate((l) => l.getBoundingClientRect().top);

  test("a focused text field's label lands below the top bar too", async ({ page, browserName, walletMock: _w }) => {
    test.skip(browserName !== 'webkit', 'Chromium centres a focused field; the next test reads the same room in every engine');
    const { field, bar } = await underTheBar(page);
    await field.focus();
    await expect.poll(() => labelTop(page), { message: `the label sits under the top bar (it ends at ${bar}px)` }).toBeGreaterThanOrEqual(bar);
  });

  test('while a field has focus, a scroll to it leaves its label below the top bar', async ({ page, walletMock: _w }) => {
    const { field, bar } = await underTheBar(page);
    await field.focus();
    await field.evaluate((f) => f.scrollIntoView({ block: 'start' }));
    await expect.poll(() => labelTop(page), { message: `the label sits under the top bar (it ends at ${bar}px)` }).toBeGreaterThanOrEqual(bar);
  });
});

test('/nft-finance at 390x844: the section tab row is whole on screen, clear of the bottom bar', async ({ page, walletMock: _w }) => {
  await settle(page, '/nft-finance', { width: 390, height: 844 });
  const row = page.getByRole('tablist', { name: 'NFT Finance sections' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The overview cards above the row once pushed it down to 745 to 799px, and the bar starts at 779px.
  await expect(page.getByRole('button', { name: 'Dismiss overview' }), 'the overview is not open: the page changed shape').toBeVisible();
  const read = await row.evaluate((list) => {
    const b = list.getBoundingClientRect();
    const bar = Array.from(document.querySelectorAll('nav[aria-label="Main navigation"]')).find((n) => n.getBoundingClientRect().height > 0);
    return { top: b.top, bottom: b.bottom, header: document.querySelector('header')!.getBoundingClientRect().bottom, bar: bar ? bar.getBoundingClientRect().top : null, scrolled: window.scrollY };
  });
  expect(read.scrolled).toBe(0);
  expect(read.bar, 'no bottom bar on a phone: the page changed shape').not.toBeNull();
  expect(read.top, 'the row starts under the top bar').toBeGreaterThanOrEqual(read.header);
  expect(read.bottom, `the row (${Math.round(read.top)} to ${Math.round(read.bottom)}px) runs under the bottom bar at ${read.bar}px`).toBeLessThanOrEqual(read.bar!);
});
