/**
 * gotoRoute's readiness probe (fixtures/routes.ts) waits for a page's code, and never for
 * what the page reads. Both halves are pinned, because each has failed:
 *
 * - It waited for reads. It read `aria-busy`, which a section reading the chain carries as
 *   well, so /earn/toweli could not mount while the live Ethereum RPC did not answer, and
 *   gauge-voting.spec.ts and page-width.spec.ts timed out three attempts in a row on CI
 *   (2026-10-22). Here every outside host is held, so a probe that waits for a read never
 *   returns.
 * - Waiting for the code is the reason the probe exists: every page is a lazy chunk, and a
 *   spec that starts on the frame before it types into a field React throws away. Here the
 *   home page's chunk is held, and the first frame it waits behind has its whole hero, so
 *   only the frame's `data-route-loading` can keep the probe out.
 */
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

test('a read nobody answers does not hold the probe: /earn/toweli mounts while its LP farm is still reading', async ({ page, walletMock: _w }) => {
  const own = new URL(String(test.info().project.use.baseURL)).host;
  let held = 0;
  await page.route((url) => url.host !== own, () => { held += 1; /* never answered */ });

  await gotoRoute(page, '/earn/toweli');
  const stillReading = await page.evaluate(() => document.querySelector('main#main-content [aria-busy="true"]') !== null);
  expect(held, 'nothing outside was asked for, so this proves nothing').toBeGreaterThan(0);
  expect(stillReading, 'the LP farm was not still reading when the probe returned, so this proves nothing').toBe(true);
});

test("a page whose code has not arrived holds the probe: / waits behind its first frame for the home page's chunk", async ({ page, walletMock: _w }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let asked = 0;
  await page.route('**/assets/HomePage-*.js', async (route) => {
    asked += 1;
    await gate;
    await route.continue().catch(() => { /* the page moved on while it was held */ });
  });

  let mounted = false;
  const going = gotoRoute(page, '/').then(() => { mounted = true; });
  await page.waitForLoadState('load');
  await expect.poll(() => asked, 'the home page chunk was never asked for: the hold matches nothing').toBeGreaterThan(0);
  // Found by what a screen reader hears, not by the marker this test is about.
  const frame = page.locator('main#main-content [aria-busy="true"]');
  await expect(frame, 'the first frame is not what the page shows while its code loads').toHaveCount(1, { timeout: 15_000 });
  expect(await frame.evaluate((el) => (el.textContent ?? '').trim().length), 'the frame has its hero').toBeGreaterThan(30);
  // Thirty frames: the probe looks once a frame, so it had thirty chances to let a spec in.
  await page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => (++n >= 30 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  expect(mounted, "the probe returned while the page's code was still loading").toBe(false);

  release();
  await going;
  await expect(page.locator('main#main-content [data-route-loading]')).toHaveCount(0);
});
