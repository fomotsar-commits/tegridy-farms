import { test, expect } from './fixtures/wallet';

/**
 * The dialog X must be the thing you hit when you aim at it. This asserts the
 * HIT TARGET, not the geometry: padding is part of an element's hit area, so a
 * visible X whose box overlaps nothing you can see may still be dead. Modal.tsx
 * keeps it clickable by stacking order, one z-index above the content wrapper.
 */
test.describe('dialog close button', () => {
  test('the X is the topmost element at its own centre, and it closes the dialog', async ({
    page,
    walletMock: _w,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // `/` clears a stored skin by reloading the document, and the wallet fixture
    // stores `toweli`. Seeding the `venue` sentinel leaves nothing to clear, so no
    // reload destroys the context under page.evaluate. Registered in the test
    // body: init scripts run in registration order, and the fixture's own would
    // overwrite one added before it.
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

    // AT REST, THEN BOX AND HIT TEST IN ONE TASK. The dialog mounts in its
    // entrance pose and holds it still for several frames before snapping to
    // rest, so a still box is not a settled one, and a box read in one call is
    // stale by the next. Rest is: out of the entrance transform, and the same
    // box on two frames running. elementFromPoint answers the question a real
    // click asks; toBeVisible does not.
    const topmost = await close.evaluate(async (btn) => {
      const dialogEl = btn.closest('[role="dialog"]')!;
      const nextFrame = () => new Promise<number>(requestAnimationFrame);
      const deadline = performance.now() + 5000;
      let lastBoxAtRest = '';
      for (;;) {
        await nextFrame();
        const transform = getComputedStyle(dialogEl).transform;
        const r = btn.getBoundingClientRect();
        const box = `${r.left},${r.top},${r.width},${r.height}`;
        if (transform === 'none' && box === lastBoxAtRest) {
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return el ? `${el.tagName}:${el.getAttribute('aria-label') ?? el.className}` : 'nothing';
        }
        if (performance.now() > deadline) return `never came to rest in 5s (dialog transform ${transform})`;
        lastBoxAtRest = transform === 'none' ? box : '';
      }
    });
    expect(
      topmost,
      'something is painted over the dialog X — a click aimed at it lands elsewhere',
    ).toBe('BUTTON:Close dialog');

    // And the behaviour that matters: it actually dismisses.
    await close.click({ timeout: 5000 });
    await expect(dialog).toHaveCount(0);
  });
});
