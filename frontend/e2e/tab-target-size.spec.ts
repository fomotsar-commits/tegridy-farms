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
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

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
for (const path of ['/community', '/nft-finance', '/trust', '/launch', '/lore', '/contracts', '/leaderboard', '/liquidity', '/farm']) {
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
for (const path of ['/', '/liquidity', '/farm', '/island', '/swap', '/trust']) {
  test(`${path} does not scroll horizontally at 390px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(IPHONE_390);
    await gotoRoute(page, path);

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
        'escaping its scroll container — check for a position:absolute child (sr-only!) inside ' +
        'a STATIC overflow-x-auto wrapper.',
    ).toBe(moved.before);
  });
}

/**
 * A TAB'S LABEL MUST STAY INSIDE ITS OWN TAB.
 *
 * ⚠️ WRITTEN BECAUSE IT SHIPPED BROKEN, and it shipped broken for weeks in the
 * most visible place in the app. The strip's button class carried
 * `flex-1 min-w-[64px]` with a `whitespace-nowrap` label. A flex item's default
 * `min-width: auto` resolves to its MIN-CONTENT size, and that is the only thing
 * stopping a flex item being laid out narrower than its own text; writing an
 * explicit `min-w-[64px]` replaced that floor with 64px. So with `flex-basis: 0`
 * the button was sized to 64px around a 74px label, the button's overflow is
 * `visible`, and the glyphs simply painted across the next tab. On a 390px phone
 * /farm read "Copy TradingCompetitions" and /launch read "LaunchpadSolana Curve".
 *
 * WHY THE EXISTING CASES ABOVE DID NOT CATCH IT: they measure `boundingBox()`,
 * which is the BUTTON. The button was a perfectly healthy 44px tall and 64px
 * wide. Nothing about the box was wrong — it was the ink outside it. A target-size
 * sweep cannot see this defect, and neither can a class-name assertion, so this
 * measures the painted text against the box that is supposed to contain it.
 *
 * 360px IS DELIBERATE alongside 390. It is the narrowest phone the venue's own
 * header budget is tuned for (see TopNav.tsx), and it is where a strip that
 * merely fits at 390 gives up.
 *
 * TO SEE IT FAIL: put `min-w-[64px]` back on the button in
 * src/components/layout/RouteTabs.tsx. /farm, /launch and /trust go red with the
 * overflow in px and the label that caused it.
 */
for (const path of ['/swap', '/liquidity', '/launch', '/farm', '/trust', '/lore', '/contracts', '/leaderboard', '/tokenomics']) {
  for (const width of [360, 390]) {
    test(`${path} tab labels stay inside their tabs at ${width}px`, async ({
      page,
      walletMock: _w,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await gotoRoute(page, path);
      await page.evaluate(() => document.fonts.ready);

      const spills = await page.evaluate(() => {
        const out: { label: string; overflowPx: number; boxWidth: number; textWidth: number }[] = [];
        for (const tab of document.querySelectorAll<HTMLElement>('[role="tab"]')) {
          const range = document.createRange();
          range.selectNodeContents(tab);
          // Per-LINE boxes, not their union: the union of a wrapped inline's
          // line boxes covers area it never paints.
          const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0.5);
          range.detach?.();
          if (!lines.length) continue;

          const box = tab.getBoundingClientRect();
          const cs = getComputedStyle(tab);
          const padL = parseFloat(cs.paddingLeft) || 0;
          const padR = parseFloat(cs.paddingRight) || 0;
          const over = lines.reduce(
            (worst, ln) => Math.max(worst, box.left + padL - ln.left, ln.right - (box.right - padR)),
            0,
          );
          if (over > 1.5) {
            out.push({
              label: (tab.textContent ?? '').trim().replace(/\s+/g, ' '),
              overflowPx: Math.round(over * 10) / 10,
              boxWidth: Math.round(box.width),
              textWidth: Math.round(lines.reduce((w, l) => Math.max(w, l.width), 0)),
            });
          }
        }
        return out;
      });

      expect(
        spills,
        `tab labels painted outside their own buttons: ${spills
          .map((s) => `"${s.label}" +${s.overflowPx}px (${s.textWidth}px of text in a ${s.boxWidth}px box)`)
          .join('; ')}. A flex item cannot be allowed to size below its own ` +
          'label — check for a min-w-* overriding `min-width: auto` on the tab.',
      ).toEqual([]);
    });
  }
}

/**
 * AND THE STRIP MUST NOT BURY THE PAGE IT SITS ON.
 *
 * The companion hazard to the wrap that fixes the overlap above. The strip is
 * `position: fixed`, so a second row of tabs costs no layout and pushes nothing
 * down, while every host clears it with a hardcoded constant that does not know
 * it grew. Measured at 390px while the wrap was in and the spacer was not:
 * /launch, /farm and /trust each covered their own <h1> by 18-26px.
 *
 * RouteTabs reserves that height itself, in flow. This asserts the result rather
 * than the mechanism: at scrollTop 0, the first painted text of the page proper
 * starts BELOW the strip.
 */
for (const path of ['/launch', '/farm', '/trust', '/swap']) {
  test(`${path} content clears the tab strip at 390px`, async ({ page, walletMock: _w }) => {
    await page.setViewportSize(IPHONE_390);
    await gotoRoute(page, path);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));

    const probe = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]');
      const main = document.querySelector('main#main-content');
      if (!list || !main) return null;
      const strip = list.getBoundingClientRect();

      let first: { top: number; text: string } | null = null;
      for (const el of main.querySelectorAll<HTMLElement>('*')) {
        if (el.closest('svg') || el.closest('[role="tablist"]')) continue;
        const own = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
        );
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom < 0) continue;
        if (!first || r.top < first.top) {
          first = { top: r.top, text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 48) };
        }
      }
      return { stripBottom: strip.bottom, stripHeight: strip.height, first };
    });

    expect(probe, 'no tablist or no main — the page changed shape').not.toBeNull();
    expect(probe!.first, 'no page text found below the strip').not.toBeNull();
    expect(
      Math.round(probe!.first!.top - probe!.stripBottom),
      `"${probe!.first!.text}" starts under the ${Math.round(probe!.stripHeight)}px tab strip. ` +
        'The strip grew a row and the clearance below it did not follow.',
    ).toBeGreaterThanOrEqual(0);
  });
}

/**
 * AND THE WRONG-NETWORK BANNER MUST NOT BURY THE STRIP EITHER.
 *
 * The banner (AppLayout.tsx) is `sticky` at the header offset with z-50, and it
 * lives inside the SAME z-10 content wrapper as this z-30 strip — so z-50 won
 * and, for anyone connected to a chain the venue does not serve, every tabbed
 * page simply lost its tabs behind a red bar. The only way to the rest of a
 * section was to switch networks first.
 *
 * AppLayout now publishes the banner's measured height as `--chrome-banner-h`
 * and the strip adds it to its own `top`. A constant would not do: the copy is
 * one line on a desktop and three at 390px.
 *
 * TO SEE IT FAIL: drop `var(--chrome-banner-h, 0px)` from the `top` calc in
 * RouteTabs.tsx.
 */
test('the wrong-network banner does not bury the tab strip at 390px', async ({
  page,
  walletMock,
}) => {
  await page.setViewportSize(IPHONE_390);
  await walletMock.connect();
  await gotoRoute(page, '/farm');

  // Polygon — a real chain this venue does not serve, so the banner is honest.
  await walletMock.switchChain(137);

  const banner = page.getByText(/which this app doesn.t serve/i).first();
  await expect(banner, 'the wrong-network banner never appeared — the mock did not reach the app').toBeVisible({
    timeout: 20_000,
  });

  const geom = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const bannerEl = Array.from(document.querySelectorAll<HTMLElement>('div')).find((d) =>
      /which this app doesn.t serve/i.test(d.textContent ?? '') && getComputedStyle(d).position === 'sticky',
    );
    if (!list || !bannerEl) return null;
    const l = list.getBoundingClientRect();
    const b = bannerEl.getBoundingClientRect();
    return { stripTop: Math.round(l.top), bannerBottom: Math.round(b.bottom), bannerHeight: Math.round(b.height) };
  });

  expect(geom, 'could not find both the tablist and the sticky banner').not.toBeNull();
  expect(
    geom!.stripTop,
    `the ${geom!.bannerHeight}px wrong-network banner ends at y=${geom!.bannerBottom} and the tab strip ` +
      `starts at y=${geom!.stripTop} — the strip is underneath it.`,
  ).toBeGreaterThanOrEqual(geom!.bannerBottom);
});
