/**
 * A11Y-R07 — the section tab strips are actually 44px on a phone.
 *
 * /community and /nft-finance both shipped `px-3 py-2 text-xs` with no `min-h`
 * — about 32px of tap target for the primary way to move between the sections
 * of each page — while the structurally identical tablist on /swap already
 * carried the repo's 44px floor.
 *
 * Measured, not asserted from a class name: target size is a rendered box, and
 * `min-h-[44px]` only pays off if nothing else collapses the row. The
 * /community half also has a class-level pin in
 * src/pages/CommunityPage.tabTargets.test.tsx; /nft-finance is pinned only here
 * (see that file's header for why it cannot be rendered in vitest).
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';

const IPHONE_390 = { width: 390, height: 844 };
const FLOOR = 44;

/**
 * ⚠️ 799 IS THE ONE THAT WAS MISSING, AND IT IS WHERE THE BUG LIVED.
 *
 * This file swept 390px only, so it proved the floor on a phone and said nothing
 * about the widest TOUCH viewport the app serves. "Desktop" in this app means
 * >=800px — that is where BottomNav hides and the TopNav row appears — but the
 * tab class keyed its shrink to Tailwind's `md` (768). That opened a 32px window,
 * 768-799, where the app rendered its touch chrome while these tabs were 40px.
 *
 * Measured live on production 2026-09-05 across all nine hosts at 799px, before
 * the fix: every strip reported 40px. A single extra viewport in this loop is the
 * whole guard.
 */
const TOUCH_WIDTHS = [
  { name: '390px phone', size: IPHONE_390 },
  { name: '799px — the widest touch viewport, one px below the BottomNav breakpoint',
    size: { width: 799, height: 900 } },
];

// /trust and /launch are the 2026-09-04 SectionHost strips — seven tabs and four,
// the primary way to move around the two biggest collapsed sections. They are
// listed here because the markup they share (components/layout/RouteTabs.tsx) was
// extracted from three hosts that all shipped a flat 40px, i.e. under this floor;
// without a case here the new strips would have inherited that silently onto
// nineteen routes.
//
// /lore, /contracts and /leaderboard are those three hosts — LearnPage, InfoPage
// and ActivityPage. RouteTabs was extracted FROM them and then left them behind,
// so for one change-set the app shipped the 44px floor on the four new strips and
// the old flat 40px on the three originals: the same defect this file was written
// for, on the surfaces it was copied from. They now render RouteTabs too, and
// these three cases are what stops that from silently regressing. They fail on
// the pre-migration files — each host's own `min-h-[40px]` button class is about
// 4px under the floor at this viewport.
// 2026-09-05 — TWO ADDED, AND ONE DELIBERATELY NOT.
// /liquidity and /farm became RouteTabs hosts in the nav rewrite (the Pools
// section and the Earn section), so by this file's own rule — enumerate the
// tabbed hosts — they belong in the list.
//
// /island is NOT here and must not be added: it is a card lobby with no tablist
// at all (navConfig.ts explains why that section alone is not a SectionHost), so
// the `toBeGreaterThan(1)` guard below would fail on a count of 0 — reporting a
// page that is correct by design as a page that changed shape.
for (const path of ['/community', '/nft-finance', '/trust', '/launch', '/lore', '/contracts', '/leaderboard', '/liquidity', '/earn']) {
  for (const vp of TOUCH_WIDTHS) {
    test(`${path} section tabs clear the ${FLOOR}px touch floor at ${vp.name}`, async ({
      page,
      walletMock: _w,
    }) => {
      await page.setViewportSize(vp.size);
      await gotoRoute(page, path);

      const tabs = page.getByRole('tab');
      const count = await tabs.count();
      expect(count, 'no tablist found — the page changed shape').toBeGreaterThan(1);

      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        const box = (await tab.boundingBox())!;
        const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
        expect(Math.round(box.height), `"${label}" is ${box.height}px tall`).toBeGreaterThanOrEqual(
          FLOOR,
        );
      }
    });
  }
}

/**
 * THE PAGE MUST NOT SCROLL SIDEWAYS ON A PHONE.
 *
 * ⚠️ WRITTEN BECAUSE IT SHIPPED BROKEN. The 2026-09-05 nav rewrite added two
 * wide tables (/liquidity's pool table, /farm's island index), each correctly
 * wrapped in `overflow-x-auto`. The wrapper clipped the TABLE — and did not clip
 * the `sr-only` span in its last <th>, because Tailwind's `sr-only` is
 * `position:absolute` and an absolutely-positioned element is only clipped by an
 * ancestor that is its CONTAINING BLOCK, i.e. a positioned one. The static
 * wrapper was not, so the span painted at the 520px table's right edge and
 * dragged the document's scroll width to 521 on a 390px viewport.
 *
 * It looked completely fine: the table sat inside its rounded card, scrolling
 * its own overflow, while the whole page slid sideways under the user's thumb.
 *
 * The assertion is deliberately BEHAVIOURAL — it scrolls and checks the page
 * moved — rather than comparing scrollWidth to clientWidth. `body` carries
 * `overflow-x: hidden` in index.css, so the two can disagree, and the question
 * that matters to a person holding a phone is whether it moves.
 */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const moved = await page.evaluate(() => {
    const before = window.scrollX;
    window.scrollTo(500, 0);
    const after = window.scrollX;
    window.scrollTo(0, 0);
    return { before, after, scrollW: document.documentElement.scrollWidth };
  });

  expect(
    moved.after,
    `the page slid sideways to x=${moved.after} (scrollWidth ${moved.scrollW}). Something is ` +
      'escaping its scroll container: check for a position:absolute child (sr-only!) inside ' +
      'a STATIC overflow-x-auto wrapper.',
  ).toBe(moved.before);
}

for (const path of ['/', '/liquidity', '/earn', '/island', '/swap', '/trust']) {
  test(`${path} does not scroll horizontally at 390px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(IPHONE_390);
    await gotoRoute(page, path);
    await expectNoSidewaysScroll(page);
  });
}

/**
 * /solana-lp is measured in each state it settles into, never at first paint: its wide
 * content is the LP section, which mounts only after a live venue read and a lazy chunk,
 * so at first paint the page is a hero and a "Reading" line. Live is a played venue
 * (fixtures/playedVenue.ts), so the section and its fee tiers are up on every machine.
 */
const A_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

/**
 * /solana-lp on the played venue, settled: the LP section is up and both fee tiers read.
 * `gateOpen`: the venue also answers the LP gate, so the page is as production shows it,
 * with no "could not check the network" banner above the finder.
 */
async function settledSolanaLp(page: Page, path: string, { gateOpen = false } = {}): Promise<void> {
  const venue = await playLiveVenue(page, { gateOpen });
  await gotoRoute(page, path);

  await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="fee-tier"][data-state="live"]'), 'both played fee tiers read').toHaveCount(2);
  if (path.includes('?mint=')) await expect(page.getByLabel(/Token mint address/)).toHaveValue(A_MINT);
  if (gateOpen) await expect.poll(() => venue.answered, 'the LP gate asked which network this is').toContain('getGenesisHash');
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
  expect(venue.answered, 'the page asked the played venue').toContain('getMultipleAccounts');
}

for (const path of ['/solana-lp', `/solana-lp?mint=${A_MINT}`]) {
  test(`${path} with its LP section mounted does not scroll horizontally at 390px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(IPHONE_390);
    await settledSolanaLp(page, path);
    await expectNoSidewaysScroll(page);
  });
}

/**
 * /solana-lp opens on what a visitor can DO: Create a pool, Add liquidity and Remove
 * liquidity are whole inside the first screen, above the phone's bottom bar where there is
 * one, and under nothing. Pressing Create a pool brings the site's own tokens and the token
 * address field onto the screen under them, so a second press reaches a form.
 *
 * It used to pin the address field alone in the first screen (it had been 1,506px down a
 * phone). That was not enough: the owner on a phone, 2026-10-03, with the field on the
 * first screen: "there is no way to create pools on mobile". A phone has no 44-character
 * address to paste, and nothing else on the screen could be pressed.
 * Measured unscrolled, once the fonts have loaded.
 */
const FIRST_SCREENS = [
  { name: '390x844 phone', size: IPHONE_390, bottomBar: true },
  // A phone's browser gives a page less than the phone's screen. Playwright's own devices:
  // an iPhone 14 (a 390x844 screen) leaves Safari 390x664, and an iPhone 15 leaves 393x659.
  { name: '390x664, Safari on an iPhone 14', size: { width: 390, height: 664 }, bottomBar: true },
  { name: '393x659, Safari on an iPhone 15', size: { width: 393, height: 659 }, bottomBar: true },
  { name: '375x667, a narrower phone', size: { width: 375, height: 667 }, bottomBar: true },
  { name: '1280x900 desktop', size: { width: 1280, height: 900 }, bottomBar: false },
];

/** How tall the bar pinned to the foot of the screen is (the phone's BottomNav), or 0 with none. */
async function bottomBarHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    for (const nav of document.querySelectorAll('nav[aria-label="Main navigation"]')) {
      const box = nav.getBoundingClientRect();
      if (getComputedStyle(nav).position === 'fixed' && box.height > 0 && box.bottom >= window.innerHeight - 1) return box.height;
    }
    return 0;
  });
}

for (const vp of FIRST_SCREENS) {
  test(`/solana-lp shows Create a pool, Add liquidity and Remove liquidity in the first screen at ${vp.name}`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(vp.size);
    await settledSolanaLp(page, '/solana-lp', { gateOpen: true });
    await expect(page.getByTestId('lp-gate-banner'), 'the played LP gate did not open').toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));

    const barHeight = await bottomBarHeight(page);
    expect(barHeight > 0, `the bottom bar is ${barHeight}px tall at ${vp.name}`).toBe(vp.bottomBar);
    // The height the page really has, not the one asked for: a project may not give it.
    const pageHeight = await page.evaluate(() => window.innerHeight);
    expect(pageHeight, 'the page is as tall as this case says').toBe(vp.size.height);
    const screenEnds = pageHeight - barHeight;

    /** Whole inside the first screen, a finger-sized target, and the thing a press there hits. */
    const onFirstScreen = async (target: Locator, what: string) => {
      const box = (await target.boundingBox())!;
      const ends = Math.round(box.y + box.height);
      expect(box.y, `${what} starts above the top of the screen`).toBeGreaterThanOrEqual(0);
      expect(
        ends,
        `${what} ends ${ends}px down; the first screen ends at ${screenEnds}px (${pageHeight}px tall, ${barHeight}px of bottom bar)`,
      ).toBeLessThanOrEqual(screenEnds);
      expect(Math.round(box.height), `${what} is shorter than a finger`).toBeGreaterThanOrEqual(44);
      const onTop = await target.evaluate((el) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      });
      expect(onTop, `something covers ${what}`).toBe(true);
      return box;
    };

    const finder = page.getByTestId('lp-finder');
    const tasks = finder.getByTestId('lp-tasks');
    await expect(tasks.getByRole('button')).toHaveText(['Create a pool', 'Add liquidity', 'Remove liquidity']);
    let firstButtonTop = Infinity;
    for (const name of ['Create a pool', 'Add liquidity', 'Remove liquidity']) {
      const box = await onFirstScreen(tasks.getByRole('button', { name, exact: true }), name);
      firstButtonTop = Math.min(firstButtonTop, box.y);
    }
    // The risk notice is read on the way to them: it is on screen, above them.
    const risk = (await page.getByTestId('lp-risk-line').boundingBox())!;
    expect(risk.y, 'the risk line starts above the top of the screen').toBeGreaterThanOrEqual(0);
    expect(risk.y + risk.height, 'the risk line is not above the three buttons').toBeLessThanOrEqual(firstButtonTop);

    // One press, and what comes next is on the screen: a site token to press, and the
    // address field for any other token. Polled: the page scrolls them up under the buttons.
    await tasks.getByRole('button', { name: 'Create a pool', exact: true }).click();
    const token = finder.getByTestId('lp-site-tokens').getByRole('button').first();
    const field = finder.getByLabel(/Token mint address/);
    const seen = (target: Locator) =>
      target.evaluate((el, ends) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return b.top >= 0 && Math.round(b.bottom) <= ends && !!hit && (hit === el || el.contains(hit));
      }, screenEnds);
    await expect.poll(() => seen(token), 'after Create a pool, the first site token is on screen and under nothing').toBe(true);
    await expect.poll(() => seen(field), 'after Create a pool, the token address field is on screen and under nothing').toBe(true);

    await expectNoSidewaysScroll(page);
  });
}

/**
 * Refresh on the live card, and the re-read fails: the LP section above the card unmounts,
 * so the card jumps up the page. The Refresh that was pressed keeps keyboard focus, and
 * what the read found is on screen, clear of the header, the tab strip and the phone's
 * bottom bar. Chromium holds the card in place by itself; at 1280x720 WebKit does not, so
 * there the page's own scroll is what this measures.
 */
for (const size of [{ width: 390, height: 664 }, { width: 1280, height: 720 }]) {
  test(`/solana-lp: a live Refresh that fails keeps focus on Refresh and shows its answer, at ${size.width}x${size.height}`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(size);
    await settledSolanaLp(page, '/solana-lp', { gateOpen: true });
    const card = page.getByRole('region', { name: 'Venue status' });
    await expect(card.getByRole('heading', { name: 'Pools are open' })).toBeVisible();
    // Focusing the button scrolls the card into view, down under the whole LP section.
    // Polled: in WebKit that scroll can land after the focus call has returned.
    await card.getByRole('button', { name: 'Refresh' }).focus();
    await expect.poll(() => page.evaluate(() => window.scrollY), 'the live card is a scroll down the page').toBeGreaterThan(size.height);

    // The proxy stops answering, the same way the unreadable case below plays it.
    await page.unroute('**/api/solrpc');
    await page.route('**/api/solrpc', (r) => r.abort());
    await page.keyboard.press('Enter');
    const answer = card.getByRole('heading', { name: 'The chain could not be read' });
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('lp-finder')).toHaveCount(0);

    await expect.soft(card.getByRole('button', { name: 'Refresh' }), 'keyboard focus left the pressed Refresh').toBeFocused();
    // On screen and under nothing: the points at both ends of the heading are the heading.
    const seen = await answer.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const hits = (y: number) => el.contains(document.elementFromPoint(b.left + 4, y));
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), screen: window.innerHeight, shown: hits(b.top + 2) && hits(b.bottom - 2) };
    });
    expect(seen.shown, `the answer's heading is at ${seen.top} to ${seen.bottom}px of a ${seen.screen}px screen`).toBe(true);
  });
}

/**
 * The venue status card under the LP section: its Refresh and its two address copy buttons
 * are finger-sized and are what a press there hits. A sweep of the live page on phones
 * (2026-10-04) measured Refresh at 40x17 and the copy buttons at 79x18: text links with no
 * height of their own. The card is the same at every width, so one phone size holds it.
 */
test('/solana-lp: the venue status card\'s Refresh and copy buttons are 44px press targets at 390px', async ({ page, walletMock: _w }) => {
  await page.setViewportSize(IPHONE_390);
  await settledSolanaLp(page, '/solana-lp', { gateOpen: true });
  await page.evaluate(() => document.fonts.ready);
  const card = page.getByRole('region', { name: 'Venue status' });
  await expect(card.getByRole('heading', { name: 'Pools are open' })).toBeVisible();
  const targets = card.getByRole('button');
  // Refresh, and one copy button for the pool program and one for its config.
  await expect(targets).toHaveCount(3);
  for (const target of await targets.all()) {
    const what = (await target.textContent())?.trim() ?? 'a button';
    await target.scrollIntoViewIfNeeded();
    const seen = await target.evaluate((el) => {
      // Centred, as a thumb scrolls: clear of the sticky tab strip and the bottom bar.
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { height: Math.round(b.height), onTop: !!hit && (hit === el || el.contains(hit)) };
    });
    expect(seen.height, `"${what}" is shorter than a finger`).toBeGreaterThanOrEqual(FLOOR);
    expect(seen.onTop, `something covers "${what}"`).toBe(true);
  }
  await expectNoSidewaysScroll(page);
});

test('/solana-lp with the chain unreadable does not scroll horizontally at 390px', async ({ page, walletMock: _w }) => {
  await page.setViewportSize(IPHONE_390);
  await page.route('**/api/solrpc', (r) => r.abort());
  await gotoRoute(page, '/solana-lp');
  await expect(page.getByRole('heading', { name: 'The chain could not be read' })).toBeVisible({ timeout: 20_000 });
  await expectNoSidewaysScroll(page);
});
