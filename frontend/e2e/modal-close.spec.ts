import { test, expect } from './fixtures/wallet';

/**
 * The dialog X must be the thing you hit when you aim at it.
 *
 * 🔴 2026-09-04: it was not. Modal.tsx gave the close button `z-10` and the
 * content wrapper beside it the same `z-10`; at equal z-index the LATER sibling
 * paints on top, so the wrapper's <h2> — a block element spanning the full
 * width — covered the button completely. Every titled dialog in the app had an
 * unclickable X, and the click landed on the heading instead.
 *
 * The heading carried `pr-8` as clearance, which cannot work: padding is part of
 * an element's hit area, so reserving space visually is not getting out of the
 * way. That is why this asserts the HIT TARGET and not the geometry — a spec
 * that only checked the button was visible, or that the boxes did not visually
 * collide, passed the whole time the button was dead.
 */
test.describe('dialog close button', () => {
  test('the X is the topmost element at its own centre, and it closes the dialog', async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // PIN THE VENUE'S SETTLED STATE BEFORE ARRIVING. `/` is wrapped in
    // <BungalowDoor id={VENUE_ID}>, which clears a stored skin by reloading the
    // document; the shared wallet fixture pins `tegridy-bungalow` to `toweli`,
    // so this spec would arrive with a skin to clear and race that reload —
    // `page.evaluate` then dies with "Execution context was destroyed". It
    // passed locally and failed in CI, which is the tell for a race rather than
    // a broken assertion. Seeding the `venue` sentinel means there is nothing
    // to clear and no reload happens.
    //
    // Registered HERE, in the test body, on purpose: init scripts run in
    // REGISTRATION order and the wallet fixture registers its own during setup,
    // so a pin added before the fixture resolves is overwritten by its `toweli`.
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
    });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);

    await page.getByRole('button', { name: /pick a bungalow|bungalow/i }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const close = page.getByRole('button', { name: /close dialog/i });
    await expect(close).toBeVisible();

    // WHAT IS ACTUALLY UNDER THE CURSOR. elementFromPoint answers the question a
    // real click asks; toBeVisible does not.
    const box = (await close.boundingBox())!;
    const topmost = await page.evaluate(
      ({ x, y, w, h }) => {
        const el = document.elementFromPoint(x + w / 2, y + h / 2) as HTMLElement | null;
        if (!el) return 'nothing';
        return `${el.tagName}:${el.getAttribute('aria-label') ?? el.className}`;
      },
      { x: box.x, y: box.y, w: box.width, h: box.height },
    );
    expect(
      topmost,
      'something is painted over the dialog X — a click aimed at it lands elsewhere',
    ).toBe('BUTTON:Close dialog');

    // And the behaviour that matters: it actually dismisses.
    await close.click({ timeout: 5000 });
    await expect(dialog).toHaveCount(0);
  });
});
