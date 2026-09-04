/**
 * A11Y-R08 — the wrong-network banner must not cover the page it warns about.
 *
 * The banner was `position: fixed` at `top: 56px` while the content wrapper's
 * paddingTop was the header height alone, so nothing in the layout reserved
 * room for it: it painted straight over the first ~40px of every page — three
 * wrapped lines at 390px, which is the whole `h1` and the top of the hero. The
 * user is told their wallet is on the wrong chain and simultaneously loses the
 * page they navigated to.
 *
 * This is a geometry assertion on purpose. The bug is not in the markup — it is
 * in whether the banner's box is in flow — and no jsdom render can see that.
 * It fails on the pre-change AppLayout, where the h1's top sits ABOVE the
 * banner's bottom because the two overlap.
 */
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

// Polygon: a real chain the app does not serve, so the banner's own copy names
// it rather than printing a bare id.
const UNSERVED_CHAIN_ID = 137;

test('the wrong-network banner reserves its own height instead of covering the page', async ({
  page,
  walletMock,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The fixture requires connect() before the first navigation — wagmi's
  // reconnect() only authorizes an account that eth_accounts already reports.
  await walletMock.connect();
  await gotoRoute(page, '/developers');
  await walletMock.switchChain(UNSERVED_CHAIN_ID);

  const banner = page.getByText(/which this app doesn't serve/i);
  await expect(banner).toBeVisible();

  // The user-visible property first, so a failure reports the OVERLAP rather
  // than stopping at the mechanism that causes it.
  const bannerBox = (await banner.boundingBox())!;
  const headingBox = (await page.locator('main#main-content h1').first().boundingBox())!;
  expect(
    headingBox.y,
    'the page h1 starts underneath the wrong-network banner, not behind it',
  ).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height);

  // …then the mechanism: in flow, not floating over the content.
  await expect
    .poll(async () => banner.evaluate((el) => getComputedStyle(el).position))
    .toBe('sticky');
});
